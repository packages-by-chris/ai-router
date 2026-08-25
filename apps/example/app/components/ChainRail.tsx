"use client";

import type { ServerRoute } from "./types";

/** Capability chips rendered on a chain node. */
export function CapChips({ route }: { route: ServerRoute }) {
  const caps = Object.entries(route.capabilities ?? {})
    .filter(([, v]) => v === true)
    .map(([k]) => k);
  if (caps.length === 0) return null;
  return (
    <span className="node-chips">
      {caps.map((c) => (
        <span key={c} className="chip chip-cap">
          {c}
        </span>
      ))}
    </span>
  );
}

export function ChainRail({
  routes,
  probes,
  onAdd,
  onEdit,
  onDuplicate,
  onRemove,
  onMove,
  onProbe,
  probing,
}: {
  routes: ServerRoute[];
  probes: Map<string, { ok: boolean; ms: number; error?: string }>;
  onAdd: () => void;
  onEdit: (route: ServerRoute) => void;
  onDuplicate: (route: ServerRoute) => void;
  onRemove: (id: string) => void;
  onMove: (from: number, to: number) => void;
  onProbe: () => void;
  probing: boolean;
}) {
  return (
    <aside className="rail rail-chain">
      <div className="rail-head">
        <span className="eyebrow">fallback chain</span>
        <button
          type="button"
          className="chip-btn"
          disabled={probing || routes.length === 0}
          onClick={onProbe}
        >
          {probing ? "probing…" : "probe"}
        </button>
      </div>

      {routes.length === 0 ? (
        <div className="empty">
          <p className="empty-title">No stops yet.</p>
          <p className="empty-sub">
            A stop is one provider/model pair. The router walks the chain in
            order until one serves.
          </p>
        </div>
      ) : (
        <ol className="chain">
          {routes.map((r, i) => {
            const probe = probes.get(r.id);
            return (
              <li key={r.id} className={`node ${probe ? (probe.ok ? "ok" : "fail") : ""}`}>
                <span className="node-idx">{i + 1}</span>
                <div className="node-body">
                  <div className="node-top">
                    <b className="node-id">{r.id}</b>
                    <span className="node-actions">
                      <button
                        className="icon"
                        title={`move up`}
                        disabled={i === 0}
                        onClick={() => onMove(i, i - 1)}
                      >
                        ↑
                      </button>
                      <button
                        className="icon"
                        title={`move down`}
                        disabled={i === routes.length - 1}
                        onClick={() => onMove(i, i + 1)}
                      >
                        ↓
                      </button>
                      <button className="icon" title="edit" onClick={() => onEdit(r)}>
                        ✎
                      </button>
                      <button className="icon" title="duplicate" onClick={() => onDuplicate(r)}>
                        ⧉
                      </button>
                      <button className="icon danger" title="remove" onClick={() => onRemove(r.id)}>
                        ✕
                      </button>
                    </span>
                  </div>
                  <div className="node-model">
                    {r.provider}
                    <span className="dim">/</span>
                    {r.model}
                  </div>
                  <div className="node-meta">
                    {r.keys.length > 1 && <span>{r.keys.length} keys</span>}
                    {r.limit?.rpm ? <span>rpm {r.limit.rpm}</span> : null}
                    {r.limit?.tpm ? <span>tpm {r.limit.tpm}</span> : null}
                    {r.weight !== undefined ? <span>w {r.weight}</span> : null}
                    {r.maxRetries !== undefined && r.maxRetries !== 2 ? (
                      <span>retry {r.maxRetries}</span>
                    ) : null}
                    {r.timeoutMs !== undefined && r.timeoutMs !== 30000 ? (
                      <span>{r.timeoutMs}ms</span>
                    ) : null}
                  </div>
                  <CapChips route={r} />
                  {probe && (
                    <div className={`node-probe ${probe.ok ? "ok" : "fail"}`}>
                      {probe.ok
                        ? `✓ ${probe.ms}ms`
                        : `✗ ${probe.ms}ms — ${probe.error ?? "failed"}`}
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}

      <button type="button" className="add-stop" onClick={onAdd}>
        + add stop
      </button>

      <p className="rail-note">
        Stops live in server memory for this session. Keys are masked and never
        leave the server.
      </p>
    </aside>
  );
}
