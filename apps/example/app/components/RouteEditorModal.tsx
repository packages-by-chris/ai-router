"use client";

import { useEffect, useState } from "react";
import { CAPABILITY_FLAGS, KEYLESS_PROVIDERS, PROVIDERS, type CapabilityFlag } from "./constants";
import type { ServerRoute } from "./types";

export interface RouteDraft {
  id: string;
  provider: string;
  model: string;
  apiKey: string;
  baseUrl: string;
  rpm: string;
  tpm: string;
  maxRetries: string;
  timeoutMs: string;
  weight: string;
  contextWindow: string;
  priceIn: string;
  priceOut: string;
  caps: Record<CapabilityFlag, boolean>;
}

export function emptyDraft(): RouteDraft {
  return {
    id: "",
    provider: "openai",
    model: "",
    apiKey: "",
    baseUrl: "",
    rpm: "",
    tpm: "",
    maxRetries: "",
    timeoutMs: "",
    weight: "",
    contextWindow: "",
    priceIn: "",
    priceOut: "",
    caps: {
      tools: false,
      vision: false,
      structuredOutput: false,
      streaming: true,
      reasoning: false,
      embeddings: false,
    },
  };
}

/** Field-level checks with copy a human can act on. */
function validate(
  draft: RouteDraft,
  routes: ServerRoute[],
  editingId: string | null,
): Partial<Record<keyof RouteDraft, string>> {
  const errors: Partial<Record<keyof RouteDraft, string>> = {};
  const id = draft.id.trim();

  if (!id) errors.id = "Name this stop — something short like “fast”.";
  else if (!/^[a-zA-Z0-9-]+$/.test(id))
    errors.id = "Letters, numbers, and dashes only.";
  else if (routes.some((r) => r.id === id && id !== editingId))
    errors.id = `“${id}” already exists — pick another name.`;

  if (!draft.model.trim()) errors.model = "Add the provider model — e.g. gpt-4o-mini.";

  if (
    editingId === null &&
    !draft.apiKey.trim() &&
    !KEYLESS_PROVIDERS.has(draft.provider)
  ) {
    errors.apiKey = `Paste a key for ${draft.provider} — server memory only.`;
  }

  const url = draft.baseUrl.trim();
  if (draft.provider === "openai-compatible" && !url)
    errors.baseUrl = "OpenAI-compatible endpoints need a base URL.";
  else if (url && !/^https?:\/\//i.test(url))
    errors.baseUrl = "Start with http:// or https://.";

  for (const [field, min] of [
    ["rpm", 1],
    ["tpm", 1],
    ["maxRetries", 0],
    ["timeoutMs", 1],
    ["weight", 0],
    ["contextWindow", 1],
    ["priceIn", 0],
    ["priceOut", 0],
  ] as const) {
    const v = draft[field].trim();
    if (v && !(Number(v) >= min))
      errors[field] = "Must be a non-negative number." as never;
  }

  return errors;
}

export function RouteEditorModal({
  draft,
  editingId,
  routes,
  onClose,
  onSave,
}: {
  draft: RouteDraft | null;
  editingId: string | null;
  routes: ServerRoute[];
  onClose: () => void;
  onSave: (
    draft: RouteDraft,
    editingId: string | null,
  ) => Promise<string | null>; // returns error text or null on success
}) {
  const [local, setLocal] = useState<RouteDraft | null>(draft);
  const [errors, setErrors] = useState<Partial<Record<keyof RouteDraft, string>>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => setLocal(draft), [draft]);

  if (!local) return null;

  const patch = (p: Partial<RouteDraft>) =>
    setLocal((prev) => (prev ? { ...prev, ...p } : prev));

  async function save() {
    if (!local) return;
    const problems = validate(local, routes, editingId);
    setErrors(problems);
    if (Object.keys(problems).length > 0) return;
    setSaving(true);
    const err = await onSave(local, editingId);
    setSaving(false);
    if (err) {
      setErrors({ id: err });
      return;
    }
    onClose();
  }

  return (
    <div className="modal-scrim" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="eyebrow">{editingId ? `editing "${editingId}"` : "new stop"}</span>
          <button type="button" className="icon" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="modal-body">
          <section className="form-section">
            <div className="eyebrow">identity</div>
            <div className="grid3">
              <Field label="id" error={errors.id}>
                <input
                  value={local.id}
                  placeholder="fast"
                  onChange={(e) => patch({ id: e.target.value })}
                />
              </Field>
              <Field label="provider">
                <select
                  value={local.provider}
                  onChange={(e) => patch({ provider: e.target.value })}
                >
                  {PROVIDERS.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="model" error={errors.model}>
                <input
                  value={local.model}
                  placeholder="gpt-4o-mini"
                  onChange={(e) => patch({ model: e.target.value })}
                />
              </Field>
            </div>
            <Field label={editingId ? "api key · blank keeps current" : "api key"} error={errors.apiKey}>
              <input
                type="password"
                value={local.apiKey}
                placeholder={
                  KEYLESS_PROVIDERS.has(local.provider) ? "not needed for this preset" : "sk-…"
                }
                disabled={KEYLESS_PROVIDERS.has(local.provider)}
                onChange={(e) => patch({ apiKey: e.target.value })}
              />
            </Field>
            <Field label="base url · openai-compatible only" error={errors.baseUrl}>
              <input
                value={local.baseUrl}
                placeholder="https://api.together.xyz/v1"
                onChange={(e) => patch({ baseUrl: e.target.value })}
              />
            </Field>
          </section>

          <section className="form-section">
            <div className="eyebrow">reliability & limits</div>
            <div className="grid4">
              <Field label="max retries" error={errors.maxRetries}>
                <input
                  inputMode="numeric"
                  value={local.maxRetries}
                  placeholder="2"
                  onChange={(e) => patch({ maxRetries: e.target.value.replace(/\D/g, "") })}
                />
              </Field>
              <Field label="timeout ms" error={errors.timeoutMs}>
                <input
                  inputMode="numeric"
                  value={local.timeoutMs}
                  placeholder="30000"
                  onChange={(e) => patch({ timeoutMs: e.target.value.replace(/\D/g, "") })}
                />
              </Field>
              <Field label="rpm limit" error={errors.rpm}>
                <input
                  inputMode="numeric"
                  value={local.rpm}
                  placeholder="—"
                  onChange={(e) => patch({ rpm: e.target.value.replace(/\D/g, "") })}
                />
              </Field>
              <Field label="tpm limit" error={errors.tpm}>
                <input
                  inputMode="numeric"
                  value={local.tpm}
                  placeholder="—"
                  onChange={(e) => patch({ tpm: e.target.value.replace(/\D/g, "") })}
                />
              </Field>
              <Field label="weight (weighted strategy)" error={errors.weight}>
                <input
                  inputMode="decimal"
                  value={local.weight}
                  placeholder="1"
                  onChange={(e) => patch({ weight: e.target.value.replace(/[^\d.]/g, "") })}
                />
              </Field>
            </div>
          </section>

          <section className="form-section">
            <div className="eyebrow">declared capabilities</div>
            <p className="field-hint">
              Declaring opts this stop into capability filtering — omitted flags mean
              “not supported” to the router.
            </p>
            <div className="cap-grid">
              {CAPABILITY_FLAGS.map((cap) => (
                <label key={cap} className="cap-check">
                  <input
                    type="checkbox"
                    checked={local.caps[cap]}
                    onChange={(e) =>
                      patch({ caps: { ...local.caps, [cap]: e.target.checked } })
                    }
                  />
                  {cap}
                </label>
              ))}
              <Field label="context window" error={errors.contextWindow}>
                <input
                  inputMode="numeric"
                  value={local.contextWindow}
                  placeholder="128000"
                  onChange={(e) =>
                    patch({ contextWindow: e.target.value.replace(/\D/g, "") })
                  }
                />
              </Field>
            </div>
          </section>

          <section className="form-section">
            <div className="eyebrow">pricing · usd per 1M tokens</div>
            <p className="field-hint">Feeds cheapest / balanced strategies and maxCostUsd.</p>
            <div className="grid2">
              <Field label="input" error={errors.priceIn}>
                <input
                  inputMode="decimal"
                  value={local.priceIn}
                  placeholder="0.15"
                  onChange={(e) => patch({ priceIn: e.target.value.replace(/[^\d.]/g, "") })}
                />
              </Field>
              <Field label="output" error={errors.priceOut}>
                <input
                  inputMode="decimal"
                  value={local.priceOut}
                  placeholder="0.60"
                  onChange={(e) => patch({ priceOut: e.target.value.replace(/[^\d.]/g, "") })}
                />
              </Field>
            </div>
          </section>
        </div>

        <div className="modal-foot">
          <button type="button" className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn primary" onClick={() => void save()} disabled={saving}>
            {saving ? "Saving…" : "Save stop"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  error,
  children,
}: {
  label: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <label className={`field ${error ? "has-error" : ""}`}>
      <span className="field-label">{label}</span>
      {children}
      {error && <span className="field-error">{error}</span>}
    </label>
  );
}
