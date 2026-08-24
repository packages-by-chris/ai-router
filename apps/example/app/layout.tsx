import type { ReactNode } from "react";
import { Inter } from "next/font/google";
import "./globals.css";

// TODO: Cache Components adoption. Refactor this route so this opt-out can be removed.
// See: https://nextjs.org/docs/app/guides/migrating-to-cache-components
export const instant = false;

// Inter stands in for Circular (per DESIGN.md); mono is the system stack.
const display = Inter({
  subsets: ["latin"],
  weight: ["500", "600"],
  variable: "--font-display",
});

const body = Inter({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-body",
});

export const metadata = {
  title: "ai-router · traffic console",
  description: "Fallback chains, key pools, rate limiting — client-side.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta name="color-scheme" content="light dark" />
      </head>
      <body className={`${display.variable} ${body.variable}`}>
        {children}
      </body>
    </html>
  );
}
