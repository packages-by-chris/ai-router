import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { Sora, IBM_Plex_Sans, IBM_Plex_Mono } from "next/font/google";
import {
  SITE_DESCRIPTION,
  SITE_KEYWORDS,
  SITE_NAME,
  SITE_TAGLINE,
  SITE_URL,
} from "@/lib/site";
import "./globals.css";

/** Example app ("traffic console") — override with NEXT_PUBLIC_EXAMPLE_URL. */
const EXAMPLE_URL =
  process.env.NEXT_PUBLIC_EXAMPLE_URL ?? "http://localhost:3000";

const display = Sora({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-display",
});

const body = IBM_Plex_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-body",
});

const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-mono",
});

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: `${SITE_NAME} · ${SITE_TAGLINE}`,
    template: `%s · ${SITE_NAME} docs`,
  },
  description: SITE_DESCRIPTION,
  keywords: SITE_KEYWORDS,
  applicationName: SITE_NAME,
  creator: SITE_NAME,
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    siteName: SITE_NAME,
    locale: "en_US",
    url: SITE_URL,
    title: `${SITE_NAME} — ${SITE_TAGLINE}`,
    description: SITE_DESCRIPTION,
  },
  twitter: {
    card: "summary_large_image",
    title: `${SITE_NAME} — ${SITE_TAGLINE}`,
    description: SITE_DESCRIPTION,
  },
  robots: {
    index: true,
    follow: true,
    googleBot: { index: true, follow: true, "max-image-preview": "large" },
  },
};

export const viewport: Viewport = {
  themeColor: "#ffffff",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className={`${display.variable} ${body.variable} ${mono.variable}`}>
        <header className="site-header">
          <Link href="/" className="brand">
            ai-router<span className="brand-dot" aria-hidden="true" />
            <span className="brand-sub">docs</span>
          </Link>
          <nav>
            <Link href="/docs/introduction">Docs</Link>
            <Link href="/docs/api-reference">API</Link>
            <Link href="/docs/examples">Examples</Link>
            <a
              href={EXAMPLE_URL}
              className="nav-demo"
              title="Open the traffic console (npm run dev -w @ai-router/example)"
            >
              Live demo ↗
            </a>
          </nav>
        </header>
        {children}
      </body>
    </html>
  );
}
