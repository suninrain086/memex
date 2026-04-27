import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CardStore } from "../../../src/lib/store.js";
import { runPipeline } from "../../../src/importers/agent-sessions/pipeline.js";
import type {
  CanonicalSession,
  DistillerFn,
  SessionAdapter,
  CardDraft,
} from "../../../src/importers/agent-sessions/types.js";
import { estimateTokens } from "../../../src/importers/agent-sessions/chunker.js";
import { parseFrontmatter } from "../../../src/lib/parser.js";

function fakeSession(): CanonicalSession {
  return {
    source: "claude-code",
    sessionId: "S-1",
    cwd: "/tmp/proj",
    gitBranch: "main",
    startDate: "2026-04-19",
    turns: [
      { role: "user", text: "Q1", tokens: estimateTokens("Q1") },
      { role: "assistant", text: "A1 long".repeat(20), tokens: estimateTokens("A1 long") },
      { role: "user", text: "Q2", tokens: estimateTokens("Q2") },
      { role: "assistant", text: "A2", tokens: estimateTokens("A2") },
    ],
  };
}

function makeAdapter(sessions: CanonicalSession[]): SessionAdapter {
  return {
    name: "test",
    description: "test",
    listSessions: async () => sessions,
  };
}

describe("runPipeline (with mock distiller)", () => {
  let dir: string;
  let store: CardStore;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "memex-pipeline-"));
    store = new CardStore(join(dir, "cards"), join(dir, "archive"));
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("writes cards from distiller drafts", async () => {
    const distill: DistillerFn = async ({ chunk }) => {
      const d: CardDraft = {
        slug: `topic-${chunk.index}`,
        title: `Topic ${chunk.index}`,
        body: `Insight body for chunk ${chunk.index}.`,
        tags: ["test"],
      };
      return [d];
    };
    const result = await runPipeline({
      store,
      adapter: makeAdapter([fakeSession()]),
      list: {},
      distill,
    });
    expect(result.cardsWritten).toBe(1);
    const written = await readFile(join(dir, "cards", "topic-0.md"), "utf-8");
    const { data, content } = parseFrontmatter(written);
    expect(data.source).toBe("claude-code");
    expect(data.session_id).toBe("S-1");
    expect(data.session_cwd).toBe("/tmp/proj");
    expect(content).toContain("Insight body for chunk 0");
  });

  it("dry-run writes nothing", async () => {
    const distill: DistillerFn = async ({ chunk }) => [{
      slug: `t-${chunk.index}`, title: "T", body: "b",
    }];
    const r = await runPipeline({
      store,
      adapter: makeAdapter([fakeSession()]),
      list: {},
      distill,
      dryRun: true,
    });
    expect(r.cardsWritten).toBe(1); // counted as proposed-write
    // file should not exist
    await expect(readFile(join(dir, "cards", "t-0.md"), "utf-8")).rejects.toThrow();
  });

  it("idempotent re-import skips duplicate session_id+slug", async () => {
    const distill: DistillerFn = async () => [{
      slug: "same-topic", title: "Same", body: "body",
    }];
    const adapter = makeAdapter([fakeSession()]);
    const r1 = await runPipeline({ store, adapter, list: {}, distill });
    expect(r1.cardsWritten).toBe(1);
    const r2 = await runPipeline({ store, adapter, list: {}, distill });
    expect(r2.cardsWritten).toBe(0);
    expect(r2.skipped).toBe(1);
  });

  it("survives a distiller throw", async () => {
    const distill: DistillerFn = async () => { throw new Error("boom"); };
    const r = await runPipeline({
      store,
      adapter: makeAdapter([fakeSession()]),
      list: {},
      distill,
    });
    expect(r.cardsWritten).toBe(0);
    expect(r.draftsProposed).toBe(0);
  });
});
