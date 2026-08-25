"use client";

import type { AttemptEvent, RoutingExplanation } from "@/lib/protocol";
import type { ReactNode } from "react";
import { OUTCOME_LABEL } from "./constants";

/** Markdown-lite renderer: fences, headings, lists, inline styles. */
export function Formatted({ text, streaming }: { text: string; streaming: boolean }) {
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
        const t = line.trim();
        const h = t.match(/^(#{1,4})\s+(.*)/);
        if (h) {
          flushList();
          const lvl = h[1]!.length;
          const node = inline(h[2]!, `h${key}`);
          if (lvl === 1) elements.push(<h1 key={key++}>{node}</h1>);
          else if (lvl === 2) elements.push(<h2 key={key++}>{node}</h2>);
          else if (lvl === 3) elements.push(<h3 key={key++}>{node}</h3>);
          else elements.push(<h4 key={key++}>{node}</h4>);
          continue;
        }
        if (/^[-*]\s+/.test(t)) {
          listItems.push(<li key={key++}>{inline(t.replace(/^[-*]\s+/, ""), `l${key}`)}</li>);
          continue;
        }
        if (/^\d+\.\s+/.test(t)) {
          listItems.push(<li key={key++}>{inline(t.replace(/^\d+\.\s+/, ""), `o${key}`)}</li>);
          continue;
        }
        if (/^[-*_]{3,}$/.test(t)) {
          flushList();
          elements.push(<hr key={key++} />);
          continue;
        }
        if (t === "") {
          flushList();
          continue;
        }
        flushList();
        elements.push(<p key={key++}>{inline(t, `p${key}`)}</p>);
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

function inline(text: string, keyPrefix: string): ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*|\*[^*\n]+\*|`[^`]+`)/g);
  return parts.map((part, i) => {
    const key = `${keyPrefix}-${i}`;
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4)
      return <strong key={key}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("*") && part.endsWith("*") && part.length > 2)
      return <em key={key}>{part.slice(1, -1)}</em>;
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2)
      return (
        <code key={key} className="inline-code">
          {part.slice(1, -1)}
        </code>
      );
    return <span key={key}>{part}</span>;
  });
}

/** Dry-run decision card rendered above a response. */
export function PlanCard({ plan }: { plan: RoutingExplanation }) {
  return (
    <div className="plan">
      <div className="plan-head">
        <span className="eyebrow">routing plan</span>
        <span className="plan-tags">
          <span className="chip">{plan.strategy}</span>
          {plan.task ? <span className="chip">task · {plan.task}</span> : null}
        </span>
      </div>
      {plan.candidates.map((c) => (
        <div
          key={c.routeId}
          className={`plan-row ${c.status}`}
          title={c.reasons.join(" · ") || undefined}
        >
          <b>
            {c.status === "selected" ? "✓" : c.status === "rejected" ? "✗" : "·"} {c.routeId}
          </b>
          <span className="dim">{c.provider}/{c.model}</span>
          {c.estimatedCostUsd !== undefined && (
            <span className="chip num">${c.estimatedCostUsd.toExponential(1)}</span>
          )}
          {c.observedLatencyMs !== undefined && (
            <span className="chip num">p50 {c.observedLatencyMs}ms</span>
          )}
          {c.score !== undefined && <span className="chip num">score {c.score.toFixed(2)}</span>}
          {c.status !== "backup" && c.reasons.length > 0 && (
            <span className="plan-reason dim">{c.reasons[0]}</span>
          )}
        </div>
      ))}
    </div>
  );
}

/** Vertical event trail: retries, skips, hand-offs. */
export function EventTimeline({ events }: { events: AttemptEvent[] }) {
  if (events.length === 0) return null;
  return (
    <ol className="timeline">
      {events.map((e, j) => (
        <li key={j} className={`evt ${e.outcome}`}>
          <span className={`evt-dot ${e.outcome}`} />
          <span className="evt-outcome">{OUTCOME_LABEL[e.outcome] ?? e.outcome}</span>
          <b className="evt-route">{e.routeId}</b>
          {e.attempts > 0 && e.outcome !== "ok" && <span>try {e.attempts}</span>}
          {e.keyIndex !== undefined && e.outcome !== "ok" && <span>key#{e.keyIndex}</span>}
          {e.kind && <span className="chip chip-kind">{e.kind}</span>}
          {e.latencyMs !== undefined && e.outcome === "ok" && (
            <span>{e.latencyMs}ms</span>
          )}
          {e.message && <span className="evt-msg dim">{e.message}</span>}
        </li>
      ))}
    </ol>
  );
}
