import { describe, it, expect } from "vitest";
import { chunkSession, estimateTokens } from "../../../src/importers/agent-sessions/chunker.js";
import type { CanonicalSession } from "../../../src/importers/agent-sessions/types.js";

function makeSession(turns: Array<{ role: "user" | "assistant" | "tool"; text: string }>): CanonicalSession {
  return {
    source: "test",
    sessionId: "s1",
    turns: turns.map((t) => ({ ...t, tokens: estimateTokens(t.text) })),
  };
}

describe("estimateTokens", () => {
  it("returns 0 for empty", () => {
    expect(estimateTokens("")).toBe(0);
  });
  it("approximates 1 token per 4 chars", () => {
    expect(estimateTokens("x".repeat(40))).toBe(10);
  });
});

describe("chunkSession", () => {
  it("returns empty chunks for empty session", () => {
    const out = chunkSession(makeSession([]));
    expect(out.chunks).toEqual([]);
  });

  it("packs all turns into one chunk when under cap", () => {
    const out = chunkSession(
      makeSession([
        { role: "user", text: "Q1" },
        { role: "assistant", text: "A1" },
        { role: "user", text: "Q2" },
        { role: "assistant", text: "A2" },
      ]),
      1000
    );
    expect(out.chunks.length).toBe(1);
    expect(out.chunks[0].turnRange).toEqual([0, 3]);
  });

  it("breaks only at user-message boundaries", () => {
    // Cap small enough to force a split between blocks but not within.
    const big = "x".repeat(2000); // 500 tokens
    const out = chunkSession(
      makeSession([
        { role: "user", text: "Q1" },
        { role: "assistant", text: big },
        { role: "user", text: "Q2" },
        { role: "assistant", text: big },
      ]),
      600
    );
    expect(out.chunks.length).toBe(2);
    // Each chunk starts at a user turn.
    for (const c of out.chunks) {
      expect(c.text.startsWith("### USER")).toBe(true);
    }
  });

  it("emits oversized single block as its own chunk", () => {
    const huge = "x".repeat(40_000);
    const out = chunkSession(
      makeSession([
        { role: "user", text: "tiny" },
        { role: "assistant", text: huge },
      ]),
      100
    );
    expect(out.chunks.length).toBe(1);
    expect(out.chunks[0].tokens).toBeGreaterThan(100);
  });
});
