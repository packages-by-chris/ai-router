"use client";

import { STRATEGIES } from "./constants";

export function Header({
  strategy,
  routeCount,
  healthOpen,
  onToggleHealth,
  onStrategyChange,
}: {
  strategy: string;
  routeCount: number;
  healthOpen: boolean;
  onToggleHealth: () => void;
  onStrategyChange: (next: string) => void;
}) {
  return (
    <header className="hdr">
      <div className="hdr-brand">
        <span className="hdr-mark" aria-hidden>
          ⇄
        </span>
        <div>
          <div className="hdr-name">
            ai-router&nbsp;<em>traffic console</em>
          </div>
          <div className="hdr-sub">embeddable TypeScript routing engine</div>
        </div>
      </div>

      <label className="hdr-strategy">
        <span className="eyebrow">strategy</span>
        <select
          value={strategy}
          onChange={(e) => onStrategyChange(e.target.value)}
        >
          {STRATEGIES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
      </label>

      <div className="hdr-right">
        <button
          type="button"
          className={`chip-btn ${healthOpen ? "active" : ""}`}
          onClick={onToggleHealth}
        >
          telemetry
        </button>
        <span
          className={`status-dot ${routeCount > 0 ? "live" : ""}`}
          title={
            routeCount > 0
              ? `${routeCount} stop${routeCount === 1 ? "" : "s"} configured`
              : "chain empty — add a stop"
          }
        />
        <a
          className="docs-link"
          href={
            process.env.NEXT_PUBLIC_DOCS_URL ??
            (process.env.NODE_ENV === "production"
              ? "https://airouter.techyatraa.com"
              : "http://localhost:3001")
          }
        >
          docs ↗
        </a>
      </div>
    </header>
  );
}
