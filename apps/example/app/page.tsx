"use client";

import { useEffect, useRef, useState } from "react";
import type {
  AttemptEvent,
  ChatFrame,
  RoutingExplanation,
  RouterStats,
  Stats,
  TestResult,
} from "@/lib/protocol";
import type { ServerRouteDTO } from "@/lib/router";
import { Header } from "./components/Header";
import { ChainRail } from "./components/ChainRail";
import {
  RouteEditorModal,
  emptyDraft,
  type RouteDraft,
} from "./components/RouteEditorModal";
import { EventTimeline, Formatted, PlanCard } from "./components/Traffic";
import { HealthRail } from "./components/HealthRail";

type ServerRoute = ServerRouteDTO;

interface Msg {
  role: "user" | "assistant" | "error";
  content: string;
  events?: AttemptEvent[];
  finish?: string | null;
  stats?: Stats;
  plan?: RoutingExplanation;
}

/** Per-call routing controls (toolbar above the composer). */
interface CallControls {
  task: string;
  deadlineMs: string;
  maxCostUsd: string;
  maxLatencyMs: string;
  requireTools: boolean;
}

const EMPTY_CONTROLS: CallControls = {
  task: "",
  deadlineMs: "",
  maxCostUsd: "",
  maxLatencyMs: "",
  requireTools: false,
};

export default function Page() {
  // ── chain state (server-backed) ─────────────────────────────────────────
  const [routes, setRoutes] = useState<ServerRoute[]>([]);
  const [strategy, setStrategy] = useState("");
  const [configError, setConfigError] = useState<string | null>(null);

  // ── editor modal ────────────────────────────────────────────────────────
  const [draft, setDraft] = useState<RouteDraft | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

  // ── chain probe ─────────────────────────────────────────────────────────
  const [probing, setProbing] = useState(false);
  const [probes, setProbes] = useState<Map<string, TestResult>>(new Map());

  // ── telemetry rail ──────────────────────────────────────────────────────
  const [healthOpen, setHealthOpen] = useState(false);
  const [engineStats, setEngineStats] = useState<RouterStats | null>(null);

  // ── traffic ─────────────────────────────────────────────────────────────
  const [controls, setControls] = useState<CallControls>(EMPTY_CONTROLS);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const scrollDown = () =>
    requestAnimationFrame(() =>
      logRef.current?.scrollTo({ top: logRef.current.scrollHeight }),
    );

  function refreshChain() {
    fetch("/api/config")
      .then((r) => r.json())
      .then((data: { routes?: ServerRoute[]; strategy?: string }) => {
        setRoutes(data.routes ?? []);
        setStrategy(data.strategy ?? "");
      })
      .catch(() => {});
  }

  useEffect(() => {
    refreshChain();
  }, []);

  async function refreshHealth() {
    try {
      const res = await fetch("/api/stats");
      setEngineStats(await res.json());
    } catch {
      /* telemetry is best-effort */
    }
  }

  useEffect(() => {
    if (!healthOpen) return;
    refreshHealth();
    const t = setInterval(refreshHealth, 5_000);
    return () => clearInterval(t);
  }, [healthOpen]);

  // ── chain mutations ─────────────────────────────────────────────────────

  async function saveConfig(body: Record<string, unknown>): Promise<string | null> {
    const res = await fetch("/api/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...body, ...(strategy ? { strategy } : {}) }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: res.statusText }));
      return data.error ?? `HTTP ${res.status}`;
    }
    refreshChain();
    return null;
  }

  /** Turn a draft into a config route object. */
  function draftToRoute(d: RouteDraft, editingId2: string | null): Record<string, unknown> {
    const limit: { rpm?: number; tpm?: number } = {};
    if (d.rpm.trim()) limit.rpm = Number(d.rpm);
    if (d.tpm.trim()) limit.tpm = Number(d.tpm);

    const anyCap =
      Object.values(d.caps).some(Boolean) || d.contextWindow.trim() !== "";
    const capabilities = anyCap
      ? {
          ...(d.caps.tools ? { tools: true } : {}),
          ...(d.caps.vision ? { vision: true } : {}),
          ...(d.caps.structuredOutput ? { structuredOutput: true } : {}),
          ...(d.caps.streaming ? { streaming: true } : {}),
          ...(d.caps.reasoning ? { reasoning: true } : {}),
          ...(d.caps.embeddings ? { embeddings: true } : {}),
          ...(d.contextWindow.trim()
            ? { contextWindow: Number(d.contextWindow) }
            : {}),
        }
      : undefined;

    return {
      id: d.id.trim(),
      provider: d.provider,
      model: d.model.trim(),
      ...(editingId2 && !d.apiKey.trim()
        ? { _keepKeyOf: editingId2 }
        : { apiKey: d.apiKey.trim() }),
      ...(d.baseUrl.trim() ? { baseUrl: d.baseUrl.trim() } : {}),
      ...(Object.keys(limit).length > 0 ? { limit } : {}),
      ...(d.maxRetries.trim() ? { maxRetries: Number(d.maxRetries) } : {}),
      ...(d.timeoutMs.trim() ? { timeoutMs: Number(d.timeoutMs) } : {}),
      ...(d.weight.trim() ? { weight: Number(d.weight) } : {}),
      ...(capabilities ? { capabilities } : {}),
    };
  }

  async function handleSave(
    d: RouteDraft,
    editId: string | null,
  ): Promise<string | null> {
    const route = draftToRoute(d, editId);
    const pricing =
      d.priceIn.trim() || d.priceOut.trim()
        ? {
            [route.id as string]: [
              Number(d.priceIn.trim() || 0),
              Number(d.priceOut.trim() || 0),
            ],
          }
        : undefined;

    const routesPayload = editId
      ? routes.map((r) => stripToInput(r)).map((r) =>
          r.id === editId ? route : r,
        )
      : [...routes.map(stripToInput), route];

    return saveConfig({ routes: routesPayload, ...(pricing ? { pricing } : {}) });
  }

  async function removeRoute(id: string) {
    const res = await fetch(`/api/config?id=${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: res.statusText }));
      setConfigError(data.error ?? res.statusText);
      return;
    }
    setConfigError(null);
    refreshChain();
  }

  async function moveRoute(from: number, to: number) {
    if (to < 0 || to >= routes.length) return;
    const reordered = [...routes];
    const [moved] = reordered.splice(from, 1);
    reordered.splice(to, 0, moved!);
    await saveConfig({ routes: reordered.map(stripToInput) });
  }

  async function duplicateRoute(route: ServerRoute) {
    const base = route.id.replace(/-\d+$/, "");
    let id = `${base}-1`;
    let n = 2;
    while (routes.some((r) => r.id === id)) id = `${base}-${n++}`;
    const dupe = {
      ...stripToInput(route),
      id,
      _keepKeyOf: route.id,
    };
    await saveConfig({ routes: [...routes.map(stripToInput), dupe] });
  }

  async function testChain() {
    setProbing(true);
    setProbes(new Map());
    try {
      const res = await fetch("/api/test-chain", { method: "POST" });
      const data = (await res.json()) as { results?: TestResult[] };
      const map = new Map<string, TestResult>();
      for (const r of data.results ?? []) map.set(r.id, r);
      setProbes(map);
    } catch (err) {
      setConfigError((err as Error).message);
    } finally {
      setProbing(false);
    }
  }

  // ── chat ────────────────────────────────────────────────────────────────

  async function send() {
    const text = input.trim();
    if (!text || busy) return;

    const history = [
      ...messages
        .filter((m) => m.role !== "error")
        .map((m) => ({ role: m.role, content: m.content })),
      { role: "user" as const, content: text },
    ];
    setMessages([...history, { role: "assistant", content: "" }]);
    setInput("");
    setBusy(true);
    scrollDown();

    const patchLast = (patch: (m: Msg) => Msg) =>
      setMessages((prev) => {
        const next = [...prev];
        next[next.length - 1] = patch(next[next.length - 1]!);
        return next;
      });

    const abort = new AbortController();
    abortRef.current = abort;

    const c = controls;
    const routingExtras = {
      ...(c.task.trim() ? { task: c.task.trim() } : {}),
      ...(c.deadlineMs.trim() ? { deadlineMs: Number(c.deadlineMs) } : {}),
      ...(c.maxCostUsd.trim() ? { maxCostUsd: Number(c.maxCostUsd) } : {}),
      ...(c.maxLatencyMs.trim() ? { maxLatencyMs: Number(c.maxLatencyMs) } : {}),
      ...(c.requireTools ? { requireTools: true } : {}),
    };

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messages: history.map((m) => ({ role: m.role, content: m.content })),
          ...routingExtras,
        }),
        signal: abort.signal,
      });

      if (!res.ok || !res.body) {
        const detail = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(detail.error ?? `HTTP ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          if (!line.trim()) continue;
          const msg = JSON.parse(line) as ChatFrame;

          if (msg.type === "plan") {
            const { type: _t, ...plan } = msg;
            patchLast((m) => ({ ...m, plan }));
          } else if (msg.type === "event") {
            patchLast((m) => ({ ...m, events: [...(m.events ?? []), msg] }));
          } else if (msg.type === "delta") {
            patchLast((m) => ({ ...m, content: m.content + msg.text }));
          } else if (msg.type === "stats") {
            const { type: _t, ...stats } = msg;
            patchLast((m) => ({ ...m, stats }));
          } else if (msg.type === "done") {
            patchLast((m) => ({ ...m, finish: msg.finish }));
          } else if (msg.type === "error") {
            patchLast((m) => ({
              ...m,
              role: "error",
              content: m.content + msg.message,
            }));
          }
          scrollDown();
        }
      }
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        patchLast((m) => ({ ...m, finish: m.finish ?? "stopped" }));
      } else {
        patchLast(() => ({
          role: "error",
          content: (err as Error).message,
        }));
      }
    } finally {
      abortRef.current = null;
      setBusy(false);
      scrollDown();
    }
  }

  async function rateLastReply(success: boolean) {
    const last = [...messages]
      .reverse()
      .find((m) => m.role === "assistant" && m.stats?.routeId);
    if (!last?.stats?.routeId) return;
    await fetch("/api/outcome", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        routeId: last.stats.routeId,
        ...(controls.task.trim() ? { task: controls.task.trim() } : {}),
        success,
        latencyMs: last.stats.totalMs,
        ...(last.stats.costUsd !== undefined
          ? { costUsd: last.stats.costUsd }
          : {}),
      }),
    }).catch(() => {});
    void refreshHealth();
  }

  // ── render ──────────────────────────────────────────────────────────────

  const primaryChainLabel =
    routes.length > 0 ? routes.map((r) => r.id).join(" → ") : "chain empty";

  return (
    <div className="app">
      <Header
        strategy={strategy}
        routeCount={routes.length}
        healthOpen={healthOpen}
        onToggleHealth={() => setHealthOpen((v) => !v)}
        onStrategyChange={(next) => {
          setStrategy(next);
          void saveConfig({ routes: routes.map(stripToInput), ...(next ? {} : { strategy: undefined }) })
            .then(() => refreshChain());
        }}
      />

      <div className={`cols ${healthOpen ? "with-health" : ""}`}>
        <ChainRail
          routes={routes}
          probes={probes}
          probing={probing}
          onAdd={() => {
            setEditingId(null);
            setDraft(emptyDraft());
          }}
          onEdit={(r) => {
            setEditingId(r.id);
            setDraft(editDraftFrom(r));
          }}
          onDuplicate={(r) => void duplicateRoute(r)}
          onRemove={(id) => void removeRoute(id)}
          onMove={(from, to) => void moveRoute(from, to)}
          onProbe={() => void testChain()}
        />

        <main className="traffic">
          <div className="traffic-head">
            <span className="eyebrow">traffic</span>
            <span className="dim mono">{primaryChainLabel}</span>
          </div>

          <div className="log" ref={logRef}>
            {messages.length === 0 && (
              <div className="empty center">
                <p className="empty-title">No traffic yet.</p>
                <p className="empty-sub">
                  Send a message to watch it walk the chain — the dry-run plan,
                  every retry and skip, and the streamed answer appear here.
                </p>
              </div>
            )}
            {messages.map((m, i) => (
              <MessageRow
                key={i}
                msg={m}
                streaming={busy && i === messages.length - 1 && m.role === "assistant" && !m.finish}
                canRate={
                  !busy &&
                  m.role === "assistant" &&
                  m.finish === "stop" &&
                  !!m.stats?.routeId
                }
                onRate={(s) => void rateLastReply(s)}
              />
            ))}
          </div>

          <Composer
            input={input}
            setInput={setInput}
            controls={controls}
            setControls={setControls}
            busy={busy}
            disabled={routes.length === 0}
            onSubmit={() => void send()}
            onStop={() => abortRef.current?.abort()}
          />
        </main>

        <HealthRail
          open={healthOpen}
          stats={engineStats}
          onClose={() => setHealthOpen(false)}
        />
      </div>

      {configError && (
        <div className="toast error" role="alert">
          {configError}
          <button type="button" className="icon" onClick={() => setConfigError(null)}>
            ✕
          </button>
        </div>
      )}

      <RouteEditorModal
        draft={draft}
        editingId={editingId}
        routes={routes}
        onClose={() => {
          setDraft(null);
          setEditingId(null);
        }}
        onSave={handleSave}
      />
    </div>
  );
}

// ── message rendering ─────────────────────────────────────────────────────

function MessageRow({
  msg,
  streaming,
  canRate,
  onRate,
}: {
  msg: Msg;
  streaming: boolean;
  canRate: boolean;
  onRate: (success: boolean) => void;
}) {
  if (msg.role === "user") {
    return (
      <div className="row user-row">
        <div className="bubble user">{msg.content}</div>
      </div>
    );
  }
  return (
    <div className={`row assistant-row ${msg.role === "error" ? "is-error" : ""}`}>
      {msg.plan && <PlanCard plan={msg.plan} />}
      {(msg.events?.length ?? 0) > 0 && <EventTimeline events={msg.events!} />}
      <div className={`bubble assistant ${msg.role === "error" ? "error" : ""}`}>
        {msg.content ? (
          <Formatted text={msg.content} streaming={streaming} />
        ) : (
          <span className="dim">{msg.role === "error" ? "" : "…"}</span>
        )}
      </div>
      {msg.stats && (
        <div className="stat-strip mono">
          <b>{msg.stats.ttftMs}ms</b> ttft
          <i>·</i>
          {msg.stats.tokens} tok
          <i>·</i>
          {msg.stats.tps} tok/s
          <i>·</i>
          {msg.stats.costUsd !== undefined && (
            <>
              ${msg.stats.costUsd.toExponential(2)}
              <i>·</i>
            </>
          )}
          via <b>{msg.stats.routeId ?? msg.stats.provider}{msg.stats.model ? `/${msg.stats.model}` : ""}</b>
        </div>
      )}
      {canRate && (
        <div className="rate-row">
          <button className="chip-btn" title="good answer — feeds quality-first routing" onClick={() => onRate(true)}>
            👍 good
          </button>
          <button className="chip-btn" title="bad answer — feeds quality-first routing" onClick={() => onRate(false)}>
            👎 bad
          </button>
          <span className="dim">records an outcome for adaptive routing</span>
        </div>
      )}
    </div>
  );
}

function Composer({
  input,
  setInput,
  controls,
  setControls,
  busy,
  disabled,
  onSubmit,
  onStop,
}: {
  input: string;
  setInput: (v: string) => void;
  controls: CallControls;
  setControls: (c: CallControls) => void;
  busy: boolean;
  disabled: boolean;
  onSubmit: () => void;
  onStop: () => void;
}) {
  return (
    <div className="composer">
      <details className="controls-pop">
        <summary className="chip-btn">routing controls</summary>
        <div className="controls-grid">
          <label>
            <span>task · quality-first bucket</span>
            <input
              value={controls.task}
              placeholder="summarize"
              onChange={(e) => setControls({ ...controls, task: e.target.value })}
            />
          </label>
          <label>
            <span>deadline ms · whole call</span>
            <input
              inputMode="numeric"
              value={controls.deadlineMs}
              placeholder="5000"
              onChange={(e) =>
                setControls({ ...controls, deadlineMs: e.target.value.replace(/\D/g, "") })
              }
            />
          </label>
          <label>
            <span>max cost usd · estimate</span>
            <input
              inputMode="decimal"
              value={controls.maxCostUsd}
              placeholder="0.01"
              onChange={(e) =>
                setControls({ ...controls, maxCostUsd: e.target.value.replace(/[^\d.]/g, "") })
              }
            />
          </label>
          <label>
            <span>max p50 ms · observed</span>
            <input
              inputMode="numeric"
              value={controls.maxLatencyMs}
              placeholder="1500"
              onChange={(e) =>
                setControls({ ...controls, maxLatencyMs: e.target.value.replace(/\D/g, "") })
              }
            />
          </label>
          <label className="cap-check">
            <input
              type="checkbox"
              checked={controls.requireTools}
              onChange={(e) =>
                setControls({ ...controls, requireTools: e.target.checked })
              }
            />
            require tools (hard constraint)
          </label>
        </div>
      </details>

      <form
        className="composer-form"
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit();
        }}
      >
        <textarea
          rows={1}
          value={input}
          placeholder={disabled ? "Add a stop first…" : "Say something…"}
          disabled={disabled}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              onSubmit();
            }
          }}
        />
        {busy ? (
          <button type="button" className="btn danger" onClick={onStop}>
            stop
          </button>
        ) : (
          <button type="submit" className="btn primary" disabled={disabled || !input.trim()}>
            send
          </button>
        )}
      </form>
    </div>
  );
}

// ── helpers ───────────────────────────────────────────────────────────────

function editDraftFrom(r: ServerRoute): RouteDraft {
  return {
    id: r.id,
    provider: r.provider,
    model: r.model,
    apiKey: "", // blank = keep stored key
    baseUrl: r.baseUrl ?? "",
    rpm: r.limit?.rpm ? String(r.limit.rpm) : "",
    tpm: r.limit?.tpm ? String(r.limit.tpm) : "",
    maxRetries: r.maxRetries !== undefined ? String(r.maxRetries) : "",
    timeoutMs: r.timeoutMs !== undefined ? String(r.timeoutMs) : "",
    weight: r.weight !== undefined ? String(r.weight) : "",
    contextWindow:
      r.capabilities?.contextWindow !== undefined
        ? String(r.capabilities.contextWindow)
        : "",
    priceIn: "",
    priceOut: "",
    caps: {
      tools: r.capabilities?.tools === true,
      vision: r.capabilities?.vision === true,
      structuredOutput: r.capabilities?.structuredOutput === true,
      streaming: r.capabilities?.streaming !== false,
      reasoning: r.capabilities?.reasoning === true,
      embeddings: r.capabilities?.embeddings === true,
    },
  };
}

function stripToInput(r: ServerRoute): Record<string, unknown> {
  return {
    id: r.id,
    provider: r.provider,
    model: r.model,
    _keepKeyOf: r.id,
    ...(r.baseUrl ? { baseUrl: r.baseUrl } : {}),
    ...(r.limit?.rpm || r.limit?.tpm
      ? { limit: { rpm: r.limit.rpm, tpm: r.limit.tpm } }
      : {}),
    ...(r.maxRetries !== undefined ? { maxRetries: r.maxRetries } : {}),
    ...(r.timeoutMs !== undefined ? { timeoutMs: r.timeoutMs } : {}),
    ...(r.weight !== undefined ? { weight: r.weight } : {}),
    ...(r.capabilities ? { capabilities: r.capabilities } : {}),
  };
}
