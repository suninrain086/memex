/**
 * Canonical types shared by all agent-session source adapters
 * (Claude Code, Codex, Copilot CLI, Copilot Chat, ...).
 *
 * The pipeline is:
 *   Adapter → CanonicalSession[] → Chunker → ChunkedSession[]
 *     → Distiller → CardDraft[] → Dedup/Wikilink → store.writeCard()
 */

export type CanonicalRole = "user" | "assistant" | "tool";

export interface CanonicalTurn {
  role: CanonicalRole;
  /** Plain text representation. Tool blocks rendered as `[tool: name]` markers. */
  text: string;
  /** ISO 8601 timestamp if available. */
  timestamp?: string;
  /** Approximate token count of `text` (chunker uses this). */
  tokens: number;
}

export interface CanonicalSession {
  /** Source adapter id ("claude-code", "codex", ...). */
  source: string;
  /** Stable per-source session id. */
  sessionId: string;
  /** Working directory captured by the agent at session time, if any. */
  cwd?: string;
  /** Earliest turn timestamp, ISO date (YYYY-MM-DD). */
  startDate?: string;
  /** Git branch at session time, if recorded. */
  gitBranch?: string;
  turns: CanonicalTurn[];
}

export interface SessionChunk {
  index: number;
  text: string;
  tokens: number;
  /** Indices into the parent session's `turns` array covered by this chunk. */
  turnRange: [number, number];
}

export interface ChunkedSession {
  session: CanonicalSession;
  chunks: SessionChunk[];
}

export interface CardDraft {
  slug: string;
  title: string;
  body: string;
  tags?: string[];
  related_slugs?: string[];
}

export interface DistillerInput {
  session: CanonicalSession;
  chunk: SessionChunk;
  /** Suggested slugs from earlier chunks in the same batch (for cross-link hints). */
  siblingSlugs: string[];
}

export type DistillerFn = (input: DistillerInput) => Promise<CardDraft[]>;

export interface SessionAdapter {
  name: string;
  description: string;
  /**
   * Discover sessions for this source.
   *
   * Adapters may filter by `since`, `project`, or cap with `maxSessions`.
   */
  listSessions(opts: AdapterListOptions): Promise<CanonicalSession[]>;
}

export interface AdapterListOptions {
  /** Only include sessions whose startDate >= this YYYY-MM-DD. */
  since?: string;
  /** Source-specific project filter (raw or encoded path for Claude Code). */
  project?: string;
  /** Hard cap on session count (newest first). */
  maxSessions?: number;
}

export interface PipelineOptions {
  store: import("../../lib/store.js").CardStore;
  adapter: SessionAdapter;
  list: AdapterListOptions;
  distill: DistillerFn;
  dryRun?: boolean;
  /** When true, log a one-line preview per draft before writing. */
  review?: boolean;
  onLog?: (msg: string) => void;
}

export interface PipelineResult {
  sessions: number;
  chunks: number;
  draftsProposed: number;
  cardsWritten: number;
  skipped: number;
}
