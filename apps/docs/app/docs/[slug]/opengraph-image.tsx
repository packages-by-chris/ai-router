import { ImageResponse } from "next/og";
import { getDoc, getDocSlugs } from "@/lib/docs";
import { sectionOf } from "@/lib/nav";

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt = "ai-router docs";

export function generateStaticParams() {
  return getDocSlugs().map((slug) => ({ slug }));
}

export default async function DocOpengraphImage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const doc = await getDoc(slug);
  const section = sectionOf(slug);

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: 80,
          backgroundColor: "#ffffff",
          backgroundImage:
            "linear-gradient(to bottom right, #ffffff 55%, rgba(62,207,142,0.10))",
          fontFamily: "sans-serif",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 16,
            color: "#9a9a9a",
            fontSize: 30,
            letterSpacing: 2,
          }}
        >
          <div
            style={{
              width: 44,
              height: 44,
              borderRadius: 12,
              backgroundColor: "#3ecf8e",
              display: "flex",
            }}
          />
          {(section ?? "docs").toUpperCase()} · AI-ROUTER
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          <div
            style={{
              display: "flex",
              fontSize: doc.title.length > 24 ? 84 : 104,
              fontWeight: 700,
              color: "#171717",
              letterSpacing: -3,
            }}
          >
            {doc.title}
          </div>
          <div
            style={{
              display: "flex",
              fontSize: 34,
              lineHeight: 1.4,
              color: "#707070",
            }}
          >
            {doc.description}
          </div>
        </div>
        <div style={{ display: "flex", fontSize: 26, color: "#9a9a9a" }}>
          ai-router.dev/docs/{slug}
        </div>
      </div>
    ),
    size,
  );
}
