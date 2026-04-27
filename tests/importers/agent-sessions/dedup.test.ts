import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CardStore } from "../../../src/lib/store.js";
import {
  resolveSlugForWrite,
  resolveWikilinks,
  slugify,
} from "../../../src/importers/agent-sessions/dedup.js";

describe("slugify", () => {
  it("lowercases and kebabs", () => {
    expect(slugify("Hello World!")).toBe("hello-world");
  });
  it("strips diacritics", () => {
    expect(slugify("Café Crème")).toBe("cafe-creme");
  });
  it("falls back to 'card' when empty", () => {
    expect(slugify("!!!")).toBe("card");
  });
  it("caps at 60 chars", () => {
    expect(slugify("a".repeat(120)).length).toBe(60);
  });
});

describe("resolveSlugForWrite", () => {
  let dir: string;
  let store: CardStore;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "memex-dedup-"));
    store = new CardStore(join(dir, "cards"), join(dir, "archive"));
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("returns base slug when no collision", async () => {
    const out = await resolveSlugForWrite(store, "My Topic", { source: "claude-code", sessionId: "s1" });
    expect(out).toBe("my-topic");
  });

  it("appends -2 on collision with different source/session", async () => {
    await store.writeCard("my-topic", "---\ntitle: X\nsource: openclaw\n---\nbody");
    const out = await resolveSlugForWrite(store, "My Topic", { source: "claude-code", sessionId: "s1" });
    expect(out).toBe("my-topic-2");
  });

  it("returns null (skip) when same source AND session_id already imported", async () => {
    await store.writeCard(
      "my-topic",
      "---\ntitle: X\nsource: claude-code\nsession_id: s1\n---\nbody"
    );
    const out = await resolveSlugForWrite(store, "My Topic", { source: "claude-code", sessionId: "s1" });
    expect(out).toBeNull();
  });
});

describe("resolveWikilinks", () => {
  it("rewrites links to existing slug exact match", () => {
    const out = resolveWikilinks(
      [{ slug: "a", title: "A", body: "see [[Vitest Tips]]" }],
      ["vitest-tips", "other"],
      []
    );
    expect(out[0].body).toBe("see [[vitest-tips]]");
  });
  it("leaves dangling links alone when no match", () => {
    const out = resolveWikilinks(
      [{ slug: "a", title: "A", body: "see [[no-such-thing]]" }],
      ["other"],
      []
    );
    expect(out[0].body).toBe("see [[no-such-thing]]");
  });
  it("preserves peer-batch slugs", () => {
    const out = resolveWikilinks(
      [{ slug: "a", title: "A", body: "see [[peer]]" }],
      [],
      ["peer"]
    );
    expect(out[0].body).toBe("see [[peer]]");
  });
});
