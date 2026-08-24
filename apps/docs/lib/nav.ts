/**
 * Docs information architecture. Single source of truth for the sidebar,
 * static params, and prev/next pagination order.
 */

export interface NavItem {
  slug: string;
}

export interface NavSection {
  title: string;
  items: NavItem[];
}

export const NAV: NavSection[] = [
  {
    title: "Getting started",
    items: [{ slug: "introduction" }, { slug: "examples" }],
  },
  {
    title: "Core concepts",
    items: [
      { slug: "configuration" },
      { slug: "routing" },
      { slug: "streaming" },
      { slug: "providers" },
      { slug: "multimodal" },
      { slug: "raw-requests" },
      { slug: "rate-limiting" },
      { slug: "errors" },
    ],
  },
  {
    title: "Reference",
    items: [{ slug: "api-reference" }, { slug: "conformance" }],
  },
];

/** Flat ordered list — drives prev/next and static params. */
export const FLAT_NAV = NAV.flatMap((s) => s.items);

/** Human page titles, shared by sidebar and pagination. */
export const PAGE_LABELS: Record<string, string> = {
  introduction: "Introduction",
  examples: "Examples",
  configuration: "Configuration",
  routing: "Routing & fallback",
  streaming: "Streaming",
  providers: "Providers",
  multimodal: "Multimodal",
  "raw-requests": "Raw requests",
  "rate-limiting": "Rate limiting",
  errors: "Errors",
  "api-reference": "API reference",
  conformance: "Conformance",
};

export function pageLabel(slug: string): string {
  return PAGE_LABELS[slug] ?? slug;
}

export function neighbors(slug: string): { prev?: NavItem; next?: NavItem } {
  const i = FLAT_NAV.findIndex((item) => item.slug === slug);
  if (i === -1) return {};
  return { prev: FLAT_NAV[i - 1], next: FLAT_NAV[i + 1] };
}
