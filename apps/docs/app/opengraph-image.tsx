import { ImageResponse } from "next/og";
import { SITE_TAGLINE } from "@/lib/site";

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt = "ai-router — provider-agnostic AI routing for TypeScript";

export default async function OpengraphImage() {
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
          DOCS
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
          <div
            style={{
              display: "flex",
              fontSize: 120,
              fontWeight: 700,
              color: "#171717",
              letterSpacing: -4,
            }}
          >
            ai-router
            <div style={{ color: "#3ecf8e" }}>.</div>
          </div>
          <div style={{ display: "flex", fontSize: 40, color: "#707070" }}>
            {SITE_TAGLINE}
          </div>
        </div>
        <div style={{ display: "flex", gap: 20 }}>
          {["Fallback chains", "Key pools", "Rate limiting", "Streaming"].map(
            (pill) => (
              <div
                key={pill}
                style={{
                  display: "flex",
                  padding: "12px 28px",
                  borderRadius: 999,
                  border: "2px solid #dfdfdf",
                  fontSize: 26,
                  color: "#171717",
                  backgroundColor: "#fafafa",
                }}
              >
                {pill}
              </div>
            ),
          )}
        </div>
      </div>
    ),
    size,
  );
}
