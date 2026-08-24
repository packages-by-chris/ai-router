/**
 * Content pipeline: frontmatter-parsed markdown from content/*.md, rendered
 * through marked + a small vendored tokenizer for code highlighting (zero
 * deps, build-time only). Heading ids are slugified for the right-rail TOC.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { marked } from "marked";
import { FLAT_NAV } from "./nav";

export interface TocEntry {
  id: string;
  text: string;
  level: 2 | 3;
}

export interface RenderedDoc {
  title: string;
  description: string;
  html: string;
  toc: TocEntry[];
}

const CONTENT_DIR = join(process.cwd(), "content");

/* ── highlighting ─────────────────────────────────────────────────────
 * Tiny sticky-regex tokenizer. Not a parser — enough for docs snippets.
 * Token classes are styled in globals.css (.tok-*).
 */

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

interface TokenRule {
  re: RegExp; // must be sticky (/y)
  cls: string;
}

const TS_KEYWORDS =
  "import|from|export|default|const|let|var|function|return|await|async|new|class|interface|type|extends|implements|if|else|for|of|in|while|do|switch|case|break|continue|try|catch|finally|throw|typeof|instanceof|null|undefined|true|false|this|as|readonly|enum|void|never|satisfies|keyof";

const TS_RULES: TokenRule[] = [
  { re: /\/\/[^\n]*|\/\*[\s\S]*?\*\//y, cls: "tok-c" },
  {
    re: /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/y,
    cls: "tok-s",
  },
  { re: new RegExp(`\\b(?:${TS_KEYWORDS})\\b`, "y"), cls: "tok-k" },
  { re: /\b\d[\d_]*(?:\.\d+)?\b/y, cls: "tok-n" },
  { re: /\b[A-Z][A-Za-z0-9_]*\b/y, cls: "tok-t" },
  { re: /\b[a-z_$][\w$]*(?=\s*\()/y, cls: "tok-f" },
];

const JSON_RULES: TokenRule[] = [
  { re: /"(?:[^"\\]|\\.)*"(?=\s*:)/y, cls: "tok-t" },
  { re: /"(?:[^"\\]|\\.)*"/y, cls: "tok-s" },
  { re: /\b(?:true|false|null)\b/y, cls: "tok-k" },
  { re: /-?\b\d[\d_]*(?:\.\d+)?\b/y, cls: "tok-n" },
];

const BASH_RULES: TokenRule[] = [
  { re: /#[^\n]*/y, cls: "tok-c" },
  { re: /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/y, cls: "tok-s" },
  { re: /\b(?:npm|npx|node|cd|cp|mkdir|git|echo|export|open|curl)\b/y, cls: "tok-k" },
  { re: /(?<!\S)--?[\w-]+/y, cls: "tok-f" },
  { re: /\b[A-Z_][A-Z0-9_]*\b(?==)/y, cls: "tok-t" },
];

function rulesFor(lang: string): TokenRule[] | null {
  if (["ts", "tsx", "typescript", "js", "jsx", "javascript"].includes(lang))
    return TS_RULES;
  if (["json", "jsonc"].includes(lang)) return JSON_RULES;
  if (["bash", "sh", "shell", "zsh"].includes(lang)) return BASH_RULES;
  return null;
}

function tokenize(code: string, rules: TokenRule[]): string {
  let out = "";
  let pos = 0;
  while (pos < code.length) {
    let matched = false;
    for (const { re, cls } of rules) {
      re.lastIndex = pos;
      const m = re.exec(code);
      if (m && m.index === pos && m[0].length > 0) {
        out += `<span class="${cls}">${escapeHtml(m[0])}</span>`;
        pos += m[0].length;
        matched = true;
        break;
      }
    }
    if (!matched) {
      out += escapeHtml(code[pos]);
      pos += 1;
    }
  }
  return out;
}

function highlightCode(code: string, lang: string): string {
  const rules = rulesFor(lang);
  if (!rules) return escapeHtml(code);
  return tokenize(code, rules);
}

/* ── markdown ───────────────────────────────────────────────────────── */

function parseFrontmatter(markdown: string): {
  title: string;
  description: string;
  body: string;
} {
  const match = markdown.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) throw new Error("missing frontmatter block");
  const [, header, body] = match;
  const data: Record<string, string> = {};
  for (const line of header.split("\n")) {
    const kv = line.match(/^(\w+):\s*(.+)$/);
    if (kv) data[kv[1]] = kv[2].trim();
  }
  return { title: data.title ?? "", description: data.description ?? "", body };
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

export function getDocSlugs(): string[] {
  return FLAT_NAV.map((item) => item.slug);
}

export async function getDoc(slug: string): Promise<RenderedDoc> {
  const markdown = readFileSync(join(CONTENT_DIR, `${slug}.md`), "utf8")
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n");
  const parsed = parseFrontmatter(markdown);
  // The page shell renders frontmatter title/description as <h1>/<lede>;
  // drop the markdown's own top-level heading so it isn't duplicated.
  const { title, description, body } = {
    ...parsed,
    body: parsed.body.replace(/^\s*#\s+[^\n]*\n+/, ""),
  };

  let html = marked.parse(body, { async: false });

  // Slugify h2/h3 and collect them for the TOC in the same pass.
  const toc: TocEntry[] = [];
  html = html.replace(
    /<h([23])>([\s\S]*?)<\/h\1>/g,
    (_full, levelStr: string, inner: string) => {
      const level = Number(levelStr) as 2 | 3;
      const text = inner.replace(/<[^>]+>/g, "").trim();
      const id = slugify(text);
      toc.push({ id, text, level });
      return `<h${level} id="${id}">${inner}</h${level}>`;
    },
  );

  // Highlight fenced code blocks → console panes with signal dots.
  html = html.replace(
    /<pre><code class="language-([\w-]+)">([\s\S]*?)<\/code><\/pre>/g,
    (_full, lang: string, escapedBody: string) => {
      const code = escapedBody
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\n$/, "");
      return `<div class="codepane"><div class="codepane-bar"><span class="codepane-lang">${lang}</span></div><pre><code>${highlightCode(
        code,
        lang,
      )}</code></pre></div>`;
    },
  );

  return { title, description, html, toc };
}
