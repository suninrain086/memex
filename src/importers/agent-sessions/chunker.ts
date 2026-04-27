import type { CanonicalSession, ChunkedSession, SessionChunk } from "./types.js";

/** Token cap per chunk. ~8K tokens × ~4 chars/token ≈ 32K chars budget. */
export const DEFAULT_CHUNK_TOKEN_CAP = 8000;

/**
 * Cheap token estimate. Real BPE is unnecessary here — we just need a
 * stable cap so the distiller call stays well under model context.
 * Heuristic: 1 token ≈ 4 characters of English / mixed text.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

function renderTurn(role: string, text: string): string {
  const label = role === "user" ? "USER" : role === "assistant" ? "ASSISTANT" : "TOOL";
  return `### ${label}\n${text}\n`;
}

/**
 * Split a session into ≤capTokens chunks, breaking only at user-message
 * boundaries (so each chunk represents one or more complete user→assistant
 * exchanges). If a single user-block is itself larger than the cap, emit
 * it as one oversized chunk — the distiller will still cope.
 */
export function chunkSession(
  session: CanonicalSession,
  capTokens: number = DEFAULT_CHUNK_TOKEN_CAP
): ChunkedSession {
  const chunks: SessionChunk[] = [];
  if (session.turns.length === 0) {
    return { session, chunks };
  }

  // Group consecutive turns into "user-blocks": each block starts with a
  // user turn (or begins the session) and includes everything until the
  // next user turn.
  const blocks: { start: number; end: number; tokens: number; text: string }[] = [];
  let blockStart = 0;
  for (let i = 1; i <= session.turns.length; i++) {
    const isBoundary = i === session.turns.length || session.turns[i].role === "user";
    if (isBoundary) {
      const slice = session.turns.slice(blockStart, i);
      const text = slice.map((t) => renderTurn(t.role, t.text)).join("\n");
      const tokens = slice.reduce((s, t) => s + t.tokens, 0);
      blocks.push({ start: blockStart, end: i - 1, tokens, text });
      blockStart = i;
    }
  }

  // Greedily pack blocks into chunks under the token cap.
  let buf: typeof blocks = [];
  let bufTokens = 0;
  let chunkIndex = 0;

  const flush = () => {
    if (buf.length === 0) return;
    chunks.push({
      index: chunkIndex++,
      text: buf.map((b) => b.text).join("\n"),
      tokens: bufTokens,
      turnRange: [buf[0].start, buf[buf.length - 1].end],
    });
    buf = [];
    bufTokens = 0;
  };

  for (const block of blocks) {
    if (bufTokens > 0 && bufTokens + block.tokens > capTokens) {
      flush();
    }
    buf.push(block);
    bufTokens += block.tokens;
  }
  flush();

  return { session, chunks };
}
