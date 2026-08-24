import Link from "next/link";

const FEATURES = [
  {
    title: "Fallback chains",
    body: "Ordered routes per logical model. A request tries the chain in order until one serves — provider outages become invisible.",
    href: "/docs/routing",
  },
  {
    title: "Key pools",
    body: "Multiple API keys per route with round-robin rotation and rotation on rate_limit / auth / permission failures.",
    href: "/docs/configuration",
  },
  {
    title: "Rate limiting",
    body: "Pre-flight rpm gating and post-hoc tpm accounting. In-process by default; Redis store for multi-replica deployments.",
    href: "/docs/rate-limiting",
  },
  {
    title: "Unified streaming",
    body: "One async chunk shape across OpenAI, Anthropic, and Gemini. Committed streams — the serving route is final before the first delta.",
    href: "/docs/streaming",
  },
  {
    title: "Raw escape hatch",
    body: "router.raw() sends your body verbatim to any provider endpoint. Thinking blocks and server tools need no translation layer.",
    href: "/docs/raw-requests",
  },
  {
    title: "Zero runtime deps",
    body: "@ai-router/core is pure TypeScript over fetch + WebStreams. Runs on Node 18+, Bun, Deno, and edge runtimes.",
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

export default function HomePage() {
  return (
    <main className="landing">
      <section className="hero">
        <p className="eyebrow">Provider-agnostic AI routing</p>
        <h1 className="hero-title">
          ai-router<span>.</span>
        </h1>
        <p className="hero-sub">
          Fallback chains, key pools, rate limiting, and unified streaming for
          OpenAI, Anthropic, Gemini, and anything OpenAI-compatible — behind one
          typed client. Zero runtime dependencies.
        </p>
        <div className="hero-actions">
          <Link href="/docs/introduction" className="button">
            Get started
          </Link>
          <Link href="/docs/api-reference" className="ghost">
            API reference
          </Link>
        </div>
        <div className="install-pill">
          <code>npm install @ai-router/core</code>
        </div>
      </section>

      <section className="hero-code">
        <p className="eyebrow">Quickstart</p>
        <div className="codepane">
          <div className="codepane-bar">
            <i />
            <i />
            <i />
            <span className="codepane-lang">typescript</span>
          </div>
          <pre>
            <code>{QUICKSTART}</code>
          </pre>
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
