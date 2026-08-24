import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getDoc, getDocSlugs, type TocEntry } from "@/lib/docs";
import { neighbors, pageLabel } from "@/lib/nav";

export function generateStaticParams() {
  return getDocSlugs().map((slug) => ({ slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const doc = await getDoc(slug);
  return { title: doc.title, description: doc.description };
}

function TocList({ entries }: { entries: TocEntry[] }) {
  if (entries.length === 0) return null;
  return (
    <nav className="toc" aria-label="On this page">
      <p className="eyebrow">On this page</p>
      <ul>
        {entries.map((entry) => (
          <li key={entry.id} className={entry.level === 3 ? "lvl3" : undefined}>
            <a href={`#${entry.id}`}>{entry.text}</a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function Pager({
  slug,
}: {
  slug: string;
}) {
  const { prev, next } = neighbors(slug);
  if (!prev && !next) return null;
  return (
    <nav className="pager" aria-label="Pagination">
      {prev ? (
        <Link href={`/docs/${prev.slug}`} className="pager-cell prev">
          <span className="eyebrow">Previous</span>
          <span>{pageLabel(prev.slug)}</span>
        </Link>
      ) : (
        <span />
      )}
      {next ? (
        <Link href={`/docs/${next.slug}`} className="pager-cell next">
          <span className="eyebrow">Next</span>
          <span>{pageLabel(next.slug)}</span>
        </Link>
      ) : (
        <span />
      )}
    </nav>
  );
}

export default async function DocPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  let doc;
  try {
    doc = await getDoc(slug);
  } catch {
    notFound();
  }

  return (
    <>
      <article className="prose doc-article">
        <p className="doc-source">{doc.title}</p>
        <div dangerouslySetInnerHTML={{ __html: doc.html }} />
        <Pager slug={slug} />
      </article>
      <TocList entries={doc.toc} />
    </>
  );
}
