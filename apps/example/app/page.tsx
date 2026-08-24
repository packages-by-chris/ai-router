"use client";

import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

interface AttemptEvent {
  routeId: string;
  provider: string;
  model: string;
  outcome: "ok" | "error" | "retry" | "skipped_rate_limit" | "unsupported";
  attempts: number;
  keyIndex?: number;
  kind?: string;
  message?: string;
}

interface Stats {
  provider?: string;
  model?: string;
  ttftMs: number;
  totalMs: number;
  tokens: number;
  tps: number;
}

interface Msg {
  role: "user" | "assistant" | "error";
  content: string;
  events?: AttemptEvent[];
  finish?: string;
  stats?: Stats;
}

/** What GET /api/config returns per route (keys masked server-side). */
interface ServerRoute {
  id: string;
  provider: string;
  model: string;
  baseUrl?: string;
  limit?: { rpm?: number; tpm?: number };
  keys: string[];
}

interface RouteDraft {
  id: string;
  provider: string;
  model: string;
  apiKey: string;
  baseUrl: string;
  rpm: string;
}

interface TestResult {
  id: string;
  provider: string;
  model: string;
  ok: boolean;
  ms: number;
  sample?: string;
  error?: string;
}

const PROVIDERS = ["openai", "anthropic", "gemini", "openai-compatible"];

const emptyDraft = (): RouteDraft => ({
  id: "",
  provider: "openai",
  model: "",
  apiKey: "",
  baseUrl: "",
  rpm: "",
});

/** Markdown-lite: fenced code blocks, `inline code`, **bold**, *italic*, # headings, - lists. */
function renderInline(text: string, keyPrefix: string): ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*|\*[^*\n]+\*|`[^`]+`)/g);
  return parts.map((part, i) => {
    const key = `${keyPrefix}-${i}`;
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={key}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith("*") && part.endsWith("*") && part.length > 2) {
      return <em key={key}>{part.slice(1, -1)}</em>;
    }
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      return (
        <code key={key} className="inline-code">
          {part.slice(1, -1)}
        </code>
      );
    }
    return <span key={key}>{part}</span>;
  });
}

function Formatted({ text, streaming }: { text: string; streaming: boolean }) {
  const blocks = text.split(/```/);
  const elements: ReactNode[] = [];
  let key = 0;

  for (let i = 0; i < blocks.length; i++) {
    if (i % 2 === 1) {
      elements.push(
        <pre key={key++} className="codeblock">
          <code>{blocks[i]!.replace(/^\w*\n/, "")}</code>
        </pre>,
      );
    } else {
      const lines = blocks[i]!.split("\n");
      let listItems: ReactNode[] = [];

      const flushList = () => {
        if (listItems.length > 0) {
          elements.push(<ul key={key++}>{listItems}</ul>);
          listItems = [];
        }
      };

      for (const line of lines) {
        const trimmed = line.trim();
        // Headings
        const headingMatch = trimmed.match(/^(#{1,4})\s+(.*)/);
        if (headingMatch) {
          flushList();
          const level = headingMatch[1]!.length;
          const heading = renderInline(headingMatch[2]!, `${key}`);
          if (level === 1) elements.push(<h1 key={key++}>{heading}</h1>);
          else if (level === 2) elements.push(<h2 key={key++}>{heading}</h2>);
          else if (level === 3) elements.push(<h3 key={key++}>{heading}</h3>);
          else elements.push(<h4 key={key++}>{heading}</h4>);
          continue;
        }
        // Unordered list items
        const listMatch = trimmed.match(/^[-*]\s+(.*)/);
        if (listMatch) {
          listItems.push(
            <li key={key++}>{renderInline(listMatch[1]!, `${key}`)}</li>,
          );
          continue;
        }
        // Ordered list items
        const olMatch = trimmed.match(/^\d+\.\s+(.*)/);
        if (olMatch) {
          listItems.push(
            <li key={key++}>{renderInline(olMatch[1]!, `${key}`)}</li>,
          );
          continue;
        }
        // Horizontal rule
        if (/^[-*_]{3,}\s*$/.test(trimmed)) {
          flushList();
          elements.push(<hr key={key++} />);
          continue;
        }
        // Empty line = paragraph break
        if (trimmed === "") {
          flushList();
          continue;
        }
        // Regular paragraph line
        flushList();
        elements.push(
          <p key={key++}>
            {renderInline(trimmed, `${key}`)}
          </p>,
        );
      }
      flushList();
    }
  }

  return (
    <>
      {elements}
      {streaming && <span className="caret" />}
    </>
  );
}

export default function Page() {
  // chain (server state, masked)
  const [routes, setRoutes] = useState<ServerRoute[]>([]);
  const [configMsg, setConfigMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // draft form — null = list view
  const [draft, setDraft] = useState<RouteDraft | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null); // null = new route

  // chain tester
  const [testing, setTesting] = useState(false);
  const [testResults, setTestResults] = useState<TestResult[] | null>(null);

  // chat
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  const scrollDown = () =>
    requestAnimationFrame(() =>
      logRef.current?.scrollTo({ top: logRef.current.scrollHeight }),
    );

  const refreshChain = () =>
    fetch("/api/config")
      .then((r) => r.json())
      .then((data) => setRoutes(data.routes ?? []))
      .catch(() => {});

  useEffect(() => {
    void refreshChain();
  }, []);

  function updateDraft(patch: Partial<RouteDraft>) {
    setDraft((prev) => (prev ? { ...prev, ...patch } : prev));
  }

  function startAdd() {
    setDraft(emptyDraft());
    setEditingId(null);
    setConfigMsg(null);
  }

  function startEdit(route: ServerRoute) {
    setDraft({
      id: route.id,
      provider: route.provider,
      model: route.model,
      apiKey: "", // blank = keep stored key
      baseUrl: route.baseUrl ?? "",
      rpm: route.limit?.rpm ? String(route.limit.rpm) : "",
    });
    setEditingId(route.id);
    setConfigMsg(null);
  }

  function cancelDraft() {
    setDraft(null);
    setEditingId(null);
    setConfigMsg(null);
  }

  async function saveDraft() {
    if (!draft) return;
    setConfigMsg(null);
    const isEdit = editingId !== null;
    const route: Record<string, unknown> = {
      id: draft.id.trim(),
      provider: draft.provider,
      model: draft.model.trim(),
      ...(isEdit && !draft.apiKey.trim()
        ? { _keepKeyOf: editingId }
        : { apiKey: draft.apiKey.trim() }),
      ...(draft.baseUrl.trim() ? { baseUrl: dtrim(draft.baseUrl) } : {}),
      ...(draft.rpm.trim() ? { limit: { rpm: Number(draft.rpm) } } : {}),
    };

    const res = await fetch("/api/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        routes: isEdit
          ? replaceById(routes, editingId!, route)
          : [...routes.map(stripToInput), route],
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      setConfigMsg({ ok: false, text: data.error ?? `HTTP ${res.status}` });
      return;
    }
    setDraft(null);
    setEditingId(null);
    void refreshChain();
  }

  async function removeRoute(id: string) {
    const res = await fetch(`/api/config?id=${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: res.statusText }));
      setConfigMsg({ ok: false, text: data.error });
      return;
    }
    void refreshChain();
  }

  async function moveRoute(fromIndex: number, toIndex: number) {
    if (toIndex < 0 || toIndex >= routes.length) return;
    const reordered = [...routes];
    const [moved] = reordered.splice(fromIndex, 1);
    reordered.splice(toIndex, 0, moved!);

    const res = await fetch("/api/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ routes: reordered.map(stripToInput) }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: res.statusText }));
      setConfigMsg({ ok: false, text: data.error });
      return;
    }
    void refreshChain();
  }

  async function duplicateRoute(route: ServerRoute) {
    const baseId = route.id.replace(/-\d+$/, "");
    let newId = `${baseId}-1`;
    let n = 2;
    while (routes.some((r) => r.id === newId)) {
      newId = `${baseId}-${n++}`;
    }

    const dupe = {
      id: newId,
      provider: route.provider,
      model: route.model,
      _keepKeyOf: route.id,
      ...(route.baseUrl ? { baseUrl: route.baseUrl } : {}),
      ...(route.limit?.rpm ? { limit: { rpm: route.limit.rpm } } : {}),
    };

    const res = await fetch("/api/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        routes: [...routes.map(stripToInput), dupe],
      }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: res.statusText }));
      setConfigMsg({ ok: false, text: data.error });
      return;
    }
    void refreshChain();
  }

  async function testChain() {
    setTesting(true);
    setTestResults(null);
    try {
      const res = await fetch("/api/test-chain", { method: "POST" });
      const data = await res.json();
      setTestResults(data.results ?? []);
    } catch (err) {
      setTestResults([
        {
          id: "?",
          provider: "?",
          model: "?",
          ok: false,
          ms: 0,
          error: (err as Error).message,
        },
      ]);
    } finally {
      setTesting(false);
    }
  }

  async function send() {
    const text = input.trim();
    if (!text || busy) return;

    const history = [...messages, { role: "user" as const, content: text }];
    setMessages([...history, { role: "assistant", content: "", events: [] }]);
    setInput("");
    setBusy(true);
    scrollDown();

    const patchLast = (patch: (m: Msg) => Msg) =>
      setMessages((prev) => {
        const next = [...prev];
        next[next.length - 1] = patch(next[next.length - 1]!);
        return next;
      });

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messages: history.map((m) => ({ role: m.role, content: m.content })),
        }),
      });

      if (!res.ok || !res.body) {
        const detail = await res
          .json()
          .catch(() => ({ error: res.statusText }));
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
          const msg = JSON.parse(line) as
            | ({ type: "event" } & AttemptEvent)
            | { type: "delta"; text: string }
            | ({ type: "stats" } & Stats)
            | { type: "done"; finish: string }
            | { type: "error"; message: string };

          if (msg.type === "event") {
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
      patchLast(() => ({ role: "error", content: (err as Error).message }));
    } finally {
      setBusy(false);
      scrollDown();
    }
  }

  const outcomeLabel: Record<AttemptEvent["outcome"], string> = {
    ok: "served",
    error: "failed",
    retry: "retrying",
    skipped_rate_limit: "rate-limited · skip",
    unsupported: "unsupported",
  };

  const probeFor = (id: string) => testResults?.find((t) => t.id === id);

  return (
    <main className="shell">
      <aside className="sidebar">
        <div className="eyebrow">schematic</div>
        <h1 className="wordmark">
          ai-router <span>/ traffic console</span>
        </h1>
        <p className="sub">
          One endpoint over every provider. Patch the fallback chain, then send
          traffic — each retry, skip, and hand-off shows up in the timeline.
        </p>

        <section className="panel">
          <div className="eyebrow">fallback chain</div>

          {routes.length === 0 ? (
            <p className="empty-trace">No stops yet. Add the first one.</p>
          ) : (
            <div className="trace">
              {routes.map((r, i) => {
                const probe = probeFor(r.id);
                return (
                  <div
                    key={r.id}
                    className={`node${probe ? (probe.ok ? " probe-ok" : " probe-fail") : ""}`}
                  >
                    <div className="node-card">
                      <div className="ci-head">
                        <span className="ci-id">
                          {i + 1}· {r.id}
                        </span>
                        <span className="ci-actions">
                          <button
                            className="icon"
                            type="button"
                            title={`Move ${r.id} up`}
                            disabled={i === 0}
                            onClick={() => void moveRoute(i, i - 1)}
                          >
                            ↑
                          </button>
                          <button
                            className="icon"
                            type="button"
                            title={`Move ${r.id} down`}
                            disabled={i === routes.length - 1}
                            onClick={() => void moveRoute(i, i + 1)}
                          >
                            ↓
                          </button>
                          <button
                            className="icon"
                            type="button"
                            title={`Edit ${r.id}`}
                            onClick={() => startEdit(r)}
                          >
                            ✎
                          </button>
                          <button
                            className="icon"
                            type="button"
                            title={`Duplicate ${r.id}`}
                            onClick={() => void duplicateRoute(r)}
                          >
                            ⧉
                          </button>
                          <button
                            className="icon"
                            type="button"
                            title={`Remove ${r.id}`}
                            onClick={() => void removeRoute(r.id)}
                          >
                            ✕
                          </button>
                        </span>
                      </div>
                      <div className="ci-meta">
                        {r.provider}/{r.model}
                      </div>
                      <div className="ci-meta dim">
                        {[...r.keys, ...(r.limit?.rpm ? [`rpm ${r.limit.rpm}`] : [])]
                          .join(" · ") || "—"}
                      </div>
                      {probe && (
                        <div className={`probe-line ${probe.ok ? "ok" : "fail"}`}>
                          {probe.ok
                            ? `probe ✓ ${probe.ms}ms`
                            : `probe ✗ ${probe.ms}ms — ${probe.error ?? "failed"}`}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {draft === null ? (
            <div className="panel-actions">
              <button className="ghost" type="button" onClick={startAdd}>
                + Add stop
              </button>
              <button
                className="ghost"
                type="button"
                disabled={testing || routes.length === 0}
                onClick={() => void testChain()}
              >
                {testing ? "Probing…" : "Probe chain"}
              </button>
            </div>
          ) : (
            <div className="draft">
              <div className="eyebrow">
                {editingId ? `editing "${editingId}"` : "new stop"}
              </div>

              <div className="route-row" style={{ marginTop: 10 }}>
                <input
                  className="cell id"
                  placeholder="id"
                  value={draft.id}
                  onChange={(e) => updateDraft({ id: e.target.value })}
                />
                <select
                  className="cell"
                  value={draft.provider}
                  onChange={(e) => updateDraft({ provider: e.target.value })}
                >
                  {PROVIDERS.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
                <input
                  className="cell model"
                  placeholder="model — e.g. gpt-4o-mini"
                  value={draft.model}
                  onChange={(e) => updateDraft({ model: e.target.value })}
                />
                <input
                  className="cell key"
                  placeholder={
                    editingId ? "blank keeps the current key" : "api key"
                  }
                  type="password"
                  value={draft.apiKey}
                  onChange={(e) => updateDraft({ apiKey: e.target.value })}
                />
                <input
                  className="cell url"
                  placeholder="base url — openai-compatible only"
                  value={draft.baseUrl}
                  onChange={(e) => updateDraft({ baseUrl: e.target.value })}
                />
                <input
                  className="cell rpm"
                  placeholder="rpm limit"
                  value={draft.rpm}
                  onChange={(e) =>
                    updateDraft({ rpm: e.target.value.replace(/\D/g, "") })
                  }
                />
              </div>

              <div className="panel-actions">
                <button className="ghost" type="button" onClick={cancelDraft}>
                  Cancel
                </button>
                <button className="button" type="button" onClick={() => void saveDraft()}>
                  Save stop
                </button>
              </div>
            </div>
          )}

          {configMsg && (
            <p className={configMsg.ok ? "config-ok" : "config-err"}>
              {configMsg.text}
            </p>
          )}

          <p className="hint">
            Keys stay in server memory for this session only. Probes send one
            ~8-token completion per stop.
          </p>
        </section>
      </aside>

      <section className="chat">
        <div className="traffic-head">
          <span className="eyebrow">traffic</span>
          <span className="eyebrow">
            {routes.length > 0
              ? `${routes.length} stop${routes.length === 1 ? "" : "s"} · ${
                  routes.map((r) => r.id).join(" → ")
                }`
              : "chain empty"}
          </span>
        </div>

        <div className="log" ref={logRef}>
          {messages.length === 0 && (
            <div style={{ margin: "auto", textAlign: "center" }}>
              <p className="eyebrow" style={{ marginBottom: 8 }}>no traffic yet</p>
              <p className="sub" style={{ margin: 0 }}>
                Send a message to watch it move down the chain.
              </p>
            </div>
          )}
          {messages.map((m, i) => {
            const isStreaming =
              busy && i === messages.length - 1 && m.role === "assistant" && !m.finish;
            return (
              <div key={i} className={`msg-wrap ${m.role}`}>
                {(m.events?.length ?? 0) > 0 && (
                  <div className="timeline">
                    {m.events!.map((e, j) => (
                      <div key={j} className={`evt evt-${e.outcome}`}>
                        <span className="evt-outcome">{outcomeLabel[e.outcome]}</span>
                        <span className="evt-route">{e.routeId}</span>
                        {e.attempts > 0 && (
                          <span>try {e.attempts}</span>
                        )}
                        {e.keyIndex !== undefined && e.outcome !== "ok" && (
                          <span>key#{e.keyIndex}</span>
                        )}
                        {e.kind && <span>{e.kind}</span>}
                        {e.message && <span className="evt-msg">{e.message}</span>}
                      </div>
                    ))}
                  </div>
                )}
                <div className={`msg ${m.role}`}>
                  {m.role === "assistant" && m.content ? (
                    <Formatted text={m.content} streaming={isStreaming} />
                  ) : (
                    m.content || (m.role === "assistant" ? "…" : "")
                  )}
                  {m.finish && <span className="finish">{m.finish}</span>}
                </div>
                {m.stats && m.role !== "error" && (
                  <div className="stats">
                    <b>{m.stats.ttftMs}ms</b> first token
                    <span className="tick">·</span>
                    <b>{m.stats.tokens}</b> tok
                    <span className="tick">·</span>
                    <b>{m.stats.tps}</b> tok/s
                    <span className="tick">·</span>
                    {(m.stats.totalMs / 1000).toFixed(1)}s
                    {m.stats.provider && (
                      <>
                        <span className="tick">·</span>
                        via{" "}
                        <b>
                          {m.stats.provider}
                          {m.stats.model ? `/${m.stats.model}` : ""}
                        </b>
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <textarea
            className="input"
            rows={1}
            value={input}
            placeholder="Say something…"
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <button className="button" type="submit" disabled={busy || !input.trim()}>
            {busy ? "…" : "Send"}
          </button>
        </form>
      </section>
    </main>
  );
}

function dtrim(s: string): string {
  return s.trim();
}

function stripToInput(r: ServerRoute): Record<string, unknown> {
  return {
    id: r.id,
    provider: r.provider,
    model: r.model,
    // keys masked client-side; reattach via _keepKeyOf so removals/reorders
    // don't lose credentials
    _keepKeyOf: r.id,
    ...(r.baseUrl ? { baseUrl: r.baseUrl } : {}),
    ...(r.limit?.rpm ? { limit: { rpm: r.limit.rpm } } : {}),
  };
}

function replaceById(
  routes: ServerRoute[],
  id: string,
  route: Record<string, unknown>,
): Record<string, unknown>[] {
  return routes.map((r) => (r.id === id ? route : stripToInput(r)));
}
