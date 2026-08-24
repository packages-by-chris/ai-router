"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { pageLabel, type NavSection } from "@/lib/nav";

export default function SidebarNav({ sections }: { sections: NavSection[] }) {
  const pathname = usePathname();
  const [query, setQuery] = useState("");

  const q = query.trim().toLowerCase();
  const filtered = sections
    .map((section) => ({
      ...section,
      items: section.items.filter((item) => !q || item.slug.includes(q)),
    }))
    .filter((section) => section.items.length > 0);

  return (
    <div className="sidebar-nav">
      <input
        className="cell sidebar-filter"
        type="search"
        placeholder="Filter pages…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        aria-label="Filter documentation pages"
      />
      {filtered.map((section) => (
        <section key={section.title}>
          <p className="eyebrow">{section.title}</p>
          <ul>
            {section.items.map((item) => (
              <li key={item.slug}>
                <Link
                  href={`/docs/${item.slug}`}
                  className={
                    pathname === `/docs/${item.slug}` ? "active" : undefined
                  }
                >
                  {pageLabel(item.slug)}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}
      {filtered.length === 0 && <p className="empty-note">No matches.</p>}
    </div>
  );
}
