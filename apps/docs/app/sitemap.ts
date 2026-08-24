import type { MetadataRoute } from "next";
import { FLAT_NAV } from "@/lib/nav";
import { absoluteUrl } from "@/lib/site";

export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date();
  return [
    {
      url: absoluteUrl("/"),
      lastModified,
      changeFrequency: "weekly",
      priority: 1,
    },
    ...FLAT_NAV.map((item) => ({
      url: absoluteUrl(`/docs/${item.slug}`),
      lastModified,
      changeFrequency: "monthly" as const,
      priority: 0.7,
    })),
  ];
}
