import Link from "next/link";

export const metadata = {
  title: "Page not found",
  robots: { index: false },
};

export default function NotFound() {
  return (
    <main className="landing">
      <section className="hero" style={{ textAlign: "center" }}>
        <p className="eyebrow">404</p>
        <h1 className="hero-title">
          Lost in the chain<span>.</span>
        </h1>
        <p className="hero-sub">
          This route has no fallback. Head back to the docs and pick a path
          that exists.
        </p>
        <div className="hero-actions" style={{ justifyContent: "center" }}>
          <Link href="/docs/introduction" className="button">
            Back to the docs
          </Link>
        </div>
      </section>
    </main>
  );
}
