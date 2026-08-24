import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getDoc, getDocSlugs, type TocEntry } from "@/lib/docs";
import { neighbors, pageLabel, sectionOf } from "@/lib/nav";
import { SITE_NAME, absoluteUrl } from "@/lib/site";

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
  const url = `/docs/${slug}`;
  return {
    title: doc.title,
    description: doc.description,
    alternates: { canonical: url },
    openGraph: {
      type: "article",
      url: absoluteUrl(url),
      title: `${doc.title} · ${SITE_NAME} docs`,
      description: doc.description,
      siteName: SITE_NAME,
    },
    twitter: {
      card: "summary_large_image",
      title: doc.title,
      description: doc.description,
    },
  };
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

  const section = sectionOf(slug);
  const articleLd = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "TechArticle",
        headline: doc.title,
        description: doc.description,
        url: absoluteUrl(`/docs/${slug}`),
        articleSection: section,
        inLanguage: "en",
        isPartOf: { "@type": "WebSite", name: `${SITE_NAME} docs` },
      },
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: SITE_NAME, item: absoluteUrl("/") },
          {
            "@type": "ListItem",
            position: 2,
            name: section ?? "Docs",
            item: absoluteUrl("/docs/introduction"),
          },
          {
            "@type": "ListItem",
            position: 3,
            name: doc.title,
            item: absoluteUrl(`/docs/${slug}`),
          },
        ],
      },
    ],
  };

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(articleLd) }}
      />
      <article className="prose doc-article">
        <header className="doc-header">
          {sectionOf(slug) ? <p className="eyebrow">{sectionOf(slug)}</p> : null}
          <h1 className="doc-title">{doc.title}</h1>
          {doc.description ? <p className="doc-lede">{doc.description}</p> : null}
        </header>
        <div dangerouslySetInnerHTML={{ __html: doc.html }} />
        <Pager slug={slug} />
      </article>
      <TocList entries={doc.toc} />
    </>
  );
}
