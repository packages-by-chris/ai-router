import type { Metadata } from "next";
import Link from "next/link";
import {
  SITE_DESCRIPTION,
  SITE_NAME,
  SITE_TAGLINE,
  absoluteUrl,
} from "@/lib/site";

export const metadata: Metadata = {
  title: `${SITE_NAME} — ${SITE_TAGLINE}`,
  description: SITE_DESCRIPTION,
  alternates: { canonical: "/" },
};

const FEATURES = [
  {
    title: "Fallback chains that just work",
    body: "Order routes per logical model. When a provider 500s, throttles, or times out, the next one picks up mid-flight — your users never see the outage.",
    href: "/docs/routing",
  },
  {
    title: "Key pools, zero babysitting",
    body: "Drop a dozen API keys behind one route. Round-robin rotation, instant rotation on rate-limit hits, and no more 429 firefights at 2am.",
    href: "/docs/configuration",
  },
  {
    title: "Rate limits you can actually see",
    body: "Pre-flight rpm gating plus post-hoc tpm accounting. Runs in-process by default; swap in the Redis store when you scale past one replica.",
    href: "/docs/rate-limiting",
  },
  {
    title: "One stream shape, every provider",
    body: "OpenAI, Anthropic, Gemini — same async chunk type from all of them. Streams are committed before the first delta, so the route never changes mid-answer.",
    href: "/docs/streaming",
  },
  {
    title: "raw() when you need the metal",
    body: "Thinking blocks, server tools, bleeding-edge endpoints: send your body verbatim to any provider URL. No translation layer in your way.",
    href: "/docs/raw-requests",
  },
  {
    title: "Zero runtime deps, anywhere",
    body: "Pure TypeScript over fetch + WebStreams. Node 18+, Bun, Deno, edge runtimes — if it speaks fetch, it runs @ai-router/core.",
    href: "/docs/introduction",
  },
];

const QUICKSTART = `import { AIRouter } from "@ai-router/core";

const router = new AIRouter({
  routes: [
    { id: "fast", provider: "openai", model: "gpt-4o-mini",
      apiKey: process.env.OPENAI_API_KEY },
    { id: "backup", provider: "anthropic", model: "claude-haiku-4-5",
      apiKey: process.env.ANTHROPIC_API_KEY },
  ],
});

// "fast" falls back to "backup" if OpenAI fails
const res = await router.complete({
  model: "fast",
  messages: [{ role: "user", content: "hi" }],
});`;

function JsonLd() {
  const graph = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "SoftwareApplication",
        name: SITE_NAME,
        applicationCategory: "DeveloperApplication",
        operatingSystem: "Node.js, Bun, Deno, Edge runtimes",
        description: SITE_DESCRIPTION,
        url: absoluteUrl("/"),
        offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
      },
      {
        "@type": "WebSite",
        name: `${SITE_NAME} docs`,
        url: absoluteUrl("/"),
      },
    ],
  };
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(graph) }}
    />
  );
}

export default function HomePage() {
  return (
    <main className="landing">
      <JsonLd />
      <section className="hero-grid">
        <div className="hero">
          <p className="eyebrow">Provider-agnostic AI routing</p>
          <h1 className="hero-title">
            ai-router<span>.</span>
          </h1>
          <p className="hero-sub">
            Your app deserves better than one API key and a prayer.{" "}
            <strong>ai-router</strong> fans every request across fallback
            chains, key pools, and rate limits — OpenAI, Anthropic, Gemini, or
            anything OpenAI-compatible — behind one typed client with{" "}
            <em>zero</em> runtime dependencies.
          </p>
          <div className="hero-actions">
            <Link href="/docs/introduction" className="button">
              Route your first request
            </Link>
            <Link href="/docs/api-reference" className="ghost">
              API reference
            </Link>
          </div>
          <div className="install-pill">
            <code>npm install @ai-router/core</code>
          </div>
        </div>

        <div className="hero-code">
          <p className="eyebrow">Two routes. Sixty seconds. Done.</p>
          <div className="codepane">
            <div className="codepane-bar">
              <span className="codepane-lang">typescript</span>
            </div>
            <pre>
              <code>{QUICKSTART}</code>
            </pre>
          </div>
        </div>
      </section>

      <section className="cards">
        {FEATURES.map((feature) => (
          <Link key={feature.title} href={feature.href} className="card">
            <h3>{feature.title}</h3>
            <p>{feature.body}</p>
            <span className="card-more">Read more →</span>
          </Link>
        ))}
      </section>

      <footer className="landing-footer">
        <p>
          Part of a monorepo:{" "}
          <Link href="/docs/conformance">conformance-tested wire format</Link> ·{" "}
          <code>apps/example</code> runs a live traffic console.
        </p>
      </footer>
    </main>
  );
}
