import type { CardDraft, DistillerFn, DistillerInput } from "./types.js";

export const DEFAULT_DISTILL_MODEL = "claude-opus-4-7";
export const COPILOT_GATEWAY_BASE = "https://copilot.suninrain086.workers.dev";
const ANTHROPIC_VERSION = "2023-06-01";
const LARGE_CONTEXT_BETA = "context-1m-2025-08-07";
const LARGE_CONTEXT_THRESHOLD_TOKENS = 100_000;

const SYSTEM_PROMPT = `You are distilling AI-agent conversation transcripts into Zettelkasten cards for memex.
RULES:
- Atomic: ONE non-obvious insight per card. Skip trivial chatter, /help output, ANSI dumps.
- Title <=60 chars, noun-phrase form.
- Body in markdown, Feynman-style explanation in your own words. 2-8 short paragraphs max.
- Use [[wikilinks]] for related concepts. Prefer slugs from related_slugs hints when relevant.
- Output 0-3 cards per chunk. Empty array if nothing worth saving.
- Output STRICT JSON only, no prose, no code fences. Schema:
  {"cards":[{"slug":"kebab-case","title":"...","body":"...","tags":["..."],"related_slugs":["..."]}]}`;

export interface CopilotDistillerOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  /** Per-request timeout in ms. */
  timeoutMs?: number;
}

interface AnthropicResponse {
  content?: Array<{ type: string; text?: string }>;
  error?: { message?: string; type?: string };
}

function buildUserPrompt(input: DistillerInput): string {
  const sessionMeta = [
    `source: ${input.session.source}`,
    `session_id: ${input.session.sessionId}`,
    input.session.cwd ? `cwd: ${input.session.cwd}` : "",
    input.session.startDate ? `start_date: ${input.session.startDate}` : "",
    input.session.gitBranch ? `git_branch: ${input.session.gitBranch}` : "",
  ].filter(Boolean).join("\n");

  const hint = input.siblingSlugs.length > 0
    ? `\nrelated_slug_hints: ${input.siblingSlugs.join(", ")}\n`
    : "";

  return `Distill the following conversation chunk into 0-3 atomic Zettelkasten cards.

<session_meta>
${sessionMeta}
</session_meta>${hint}
<chunk index="${input.chunk.index}" tokens="${input.chunk.tokens}">
${input.chunk.text}
</chunk>

Respond with JSON only.`;
}

/** Best-effort JSON extraction (tolerates accidental code fences). */
function parseDistillResponse(text: string): CardDraft[] {
  if (!text) return [];
  let body = text.trim();
  // Strip ```json ... ``` if the model insists.
  const fence = body.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) body = fence[1].trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    // Try to recover the first {...} block.
    const m = body.match(/\{[\s\S]*\}/);
    if (!m) return [];
    try { parsed = JSON.parse(m[0]); } catch { return []; }
  }
  if (!parsed || typeof parsed !== "object") return [];
  const cards = (parsed as { cards?: unknown }).cards;
  if (!Array.isArray(cards)) return [];
  const out: CardDraft[] = [];
  for (const c of cards) {
    if (!c || typeof c !== "object") continue;
    const draft = c as Record<string, unknown>;
    const slug = typeof draft.slug === "string" ? draft.slug.trim() : "";
    const title = typeof draft.title === "string" ? draft.title.trim() : "";
    const body = typeof draft.body === "string" ? draft.body : "";
    if (!slug || !title || !body) continue;
    out.push({
      slug,
      title,
      body,
      tags: Array.isArray(draft.tags)
        ? (draft.tags as unknown[]).filter((t): t is string => typeof t === "string")
        : undefined,
      related_slugs: Array.isArray(draft.related_slugs)
        ? (draft.related_slugs as unknown[]).filter((t): t is string => typeof t === "string")
        : undefined,
    });
  }
  return out;
}

/**
 * Build a DistillerFn backed by the copilot-gateway worker
 * (Anthropic Messages API mode). No new dependencies — uses built-in fetch.
 */
export function createCopilotDistiller(opts: CopilotDistillerOptions): DistillerFn {
  const model = opts.model ?? DEFAULT_DISTILL_MODEL;
  const base = (opts.baseUrl ?? COPILOT_GATEWAY_BASE).replace(/\/+$/, "");
  const timeoutMs = opts.timeoutMs ?? 120_000;

  return async (input: DistillerInput): Promise<CardDraft[]> => {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-api-key": opts.apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    };
    if (input.chunk.tokens >= LARGE_CONTEXT_THRESHOLD_TOKENS) {
      headers["anthropic-beta"] = LARGE_CONTEXT_BETA;
    }

    const body = {
      model,
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: buildUserPrompt(input) }],
    };

    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(`${base}/v1/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(t);
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`distill request failed (${res.status}): ${errText.slice(0, 500)}`);
    }
    const json = (await res.json()) as AnthropicResponse;
    if (json.error) {
      throw new Error(`distill error: ${json.error.message ?? json.error.type ?? "unknown"}`);
    }
    const text = (json.content ?? [])
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text!)
      .join("\n");
    const drafts = parseDistillResponse(text);
    if (drafts.length === 0 && text.length > 0 && process.env.MEMEX_DISTILL_DEBUG) {
      // Surface the raw text to aid diagnosis when nothing parses out.
      console.error(`[distill] no drafts parsed from response (${text.length} chars):\n${text.slice(0, 800)}`);
    }
    return drafts;
  };
}

// Exposed for unit tests.
export const __testing = { parseDistillResponse, buildUserPrompt };
