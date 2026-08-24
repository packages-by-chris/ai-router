import type { ReactNode } from "react";
import Link from "next/link";
import { Sora, IBM_Plex_Sans, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";

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

export const metadata = {
  title: {
    default: "ai-router · docs",
    template: "%s · ai-router docs",
  },
  description:
    "Provider-agnostic AI routing: fallback chains, key pools, rate limiting, unified streaming.",
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
          </nav>
        </header>
        {children}
      </body>
    </html>
  );
}
