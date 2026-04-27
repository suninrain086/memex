import { describe, it, expect } from "vitest";
import { join } from "node:path";
import {
  ClaudeCodeAdapter,
  parseClaudeCodeSession,
  encodeProjectDir,
} from "../../../src/importers/agent-sessions/claude-code.js";

const FIXTURE = join(__dirname, "..", "..", "fixtures", "claude-code-session.jsonl");

describe("parseClaudeCodeSession (fixture)", () => {
  it("parses sessionId, cwd, gitBranch, startDate", async () => {
    const s = await parseClaudeCodeSession(FIXTURE);
    expect(s).not.toBeNull();
    expect(s!.sessionId).toBe("fixture-001");
    expect(s!.cwd).toBe("/Users/jackyzeng/work/tools/iTerm2");
    expect(s!.gitBranch).toBe("main");
    expect(s!.startDate).toBe("2026-04-19");
    expect(s!.source).toBe("claude-code");
  });

  it("drops local-command-caveat / isMeta noise", async () => {
    const s = (await parseClaudeCodeSession(FIXTURE))!;
    for (const t of s.turns) {
      expect(t.text).not.toMatch(/local-command-caveat/);
    }
  });

  it("renders text + thinking + tool_use blocks; tool_result becomes a tool turn", async () => {
    const s = (await parseClaudeCodeSession(FIXTURE))!;
    const roles = s.turns.map((t) => t.role);
    expect(roles).toContain("user");
    expect(roles).toContain("assistant");
    expect(roles).toContain("tool");
    const assistant = s.turns.find((t) => t.role === "assistant")!;
    expect(assistant.text).toMatch(/\[thinking\]/);
    expect(assistant.text).toMatch(/\[tool: Bash\]/);
  });
});

describe("encodeProjectDir", () => {
  it("matches the leading-dash + dash-separated form", () => {
    expect(encodeProjectDir("/Users/jackyzeng/work/tools/iTerm2")).toBe(
      "-Users-jackyzeng-work-tools-iTerm2"
    );
  });
});

describe("ClaudeCodeAdapter (empty / missing)", () => {
  it("returns [] when projects dir does not exist", async () => {
    const adapter = new ClaudeCodeAdapter("/tmp/this-path-should-not-exist-xyz");
    const out = await adapter.listSessions({});
    expect(out).toEqual([]);
  });
});
