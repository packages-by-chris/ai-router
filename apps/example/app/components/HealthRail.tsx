"use client";

import type { OutcomeStats, RouteHealthSnapshot } from "@ai-router/core";

function bar(pct: number): string {
  const filled = Math.max(0, Math.min(20, Math.round(pct * 20)));
  return "▮".repeat(filled) + "▯".repeat(20 - filled);
}

export function HealthRail({
  open,
  stats,
  onClose,
}: {
  open: boolean;
  stats: {
    health?: RouteHealthSnapshot[];
    outcomes?: OutcomeStats[];
    circuitBreakers?: Array<{
      routeId: string;
      open: boolean;
      failures: number;
    }>;
    keyCursors?: Record<string, number>;
    rateLimits?: Record<string, number> | null;
  } | null;
  onClose: () => void;
}) {
  if (!open) return null;

  const health = stats?.health ?? [];
  const outcomes = stats?.outcomes ?? [];
  const breakers = (stats?.circuitBreakers ?? []).filter((b) => b.open || b.failures > 0);

  return (
    <aside className="rail rail-health">
      <div className="rail-head">
        <span className="eyebrow">telemetry · in-process</span>
        <button type="button" className="icon" onClick={onClose}>
          ✕
        </button>
      </div>

      {health.length === 0 && outcomes.length === 0 && (
        <div className="empty">
          <p className="empty-title">No observations yet.</p>
          <p className="empty-sub">
            Send traffic — the engine records latency percentiles, error tallies,
            and outcome quality here.
          </p>
        </div>
      )}

      {health.map((h) => {
        const total = h.successes + h.failures;
        const rate = total > 0 ? h.successes / total : null;
        return (
          <section key={h.routeId} className="health-card">
            <div className="health-top">
              <b>{h.routeId}</b>
              {rate !== null && (
                <span className={`chip ${rate >= 0.9 ? "good" : rate >= 0.5 ? "" : "bad"}`}>
                  {Math.round(rate * 100)}%
                </span>
              )}
            </div>
            {rate !== null && (
              <div className="health-bar mono" aria-hidden>
                {bar(rate)}
              </div>
            )}
            <dl className="kv">
              <dt>attempts</dt>
              <dd className="mono">
                ✓{h.successes} ✗{h.failures}
              </dd>
              {h.p50LatencyMs !== undefined && (
                <>
                  <dt>p50</dt>
                  <dd className="mono">{h.p50LatencyMs}ms</dd>
                </>
              )}
              {h.p95LatencyMs !== undefined && (
                <>
                  <dt>p95</dt>
                  <dd className="mono">{h.p95LatencyMs}ms</dd>
                </>
              )}
              {h.p99LatencyMs !== undefined && (
                <>
                  <dt>p99</dt>
                  <dd className="mono">{h.p99LatencyMs}ms</dd>
                </>
              )}
              {h.p50TtfbMs !== undefined && (
                <>
                  <dt>ttft p50</dt>
                  <dd className="mono">{h.p50TtfbMs}ms</dd>
                </>
              )}
            </dl>
            {Object.keys(h.byKind).length > 0 && (
              <div className="kind-row">
                {Object.entries(h.byKind).map(([kind, n]) => (
                  <span key={kind} className="chip chip-kind">
                    {kind} ×{String(n)}
                  </span>
                ))}
              </div>
            )}
            {h.keys.some((k) => k.cooldownRemainingMs > 0) && (
              <div className="kind-row">
                {h.keys
                  .filter((k) => k.cooldownRemainingMs > 0)
                  .map((k) => (
                    <span key={k.keyIndex} className="chip chip-warn">
                      key#{k.keyIndex} cooling {Math.ceil(k.cooldownRemainingMs / 1000)}s
                    </span>
                  ))}
              </div>
            )}
          </section>
        );
      })}

      {breakers.length > 0 && (
        <section className="health-card">
          <div className="eyebrow">circuit breakers</div>
          {breakers.map((b) => (
            <div key={b.routeId} className="plan-row rejected">
              <b>{b.open ? "open" : "watch"}</b>
              <span>{b.routeId}</span>
              <span className="dim">{b.failures} consecutive</span>
            </div>
          ))}
        </section>
      )}

      {outcomes.length > 0 && (
        <section className="health-card">
          <div className="eyebrow">recorded outcomes</div>
          {outcomes.map((o) => (
            <div key={`${o.task}|${o.routeId}`} className="outcome-row">
              <b>{o.routeId}</b>
              <span className="dim">{o.task || "untasked"}</span>
              <span className="mono dim">n{o.samples}</span>
              {o.avgQuality !== undefined && (
                <span className={`chip ${o.avgQuality >= 0.7 ? "good" : "bad"}`}>
                  q {o.avgQuality.toFixed(2)}
                </span>
              )}
            </div>
          ))}
          <p className="field-hint">Recorded via recordOutcome() — drives quality-first routing.</p>
        </section>
      )}
    </aside>
  );
}
