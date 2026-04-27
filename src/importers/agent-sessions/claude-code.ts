import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { estimateTokens } from "./chunker.js";
import type {
  AdapterListOptions,
  CanonicalSession,
  CanonicalTurn,
  SessionAdapter,
} from "./types.js";

export const CLAUDE_CODE_PROJECTS_DIR = join(homedir(), ".claude", "projects");

/** Encode a real cwd path the way Claude Code does (slashes → dashes). */
export function encodeProjectDir(realPath: string): string {
  // Claude Code drops the leading separator and replaces `/` with `-`.
  return realPath.replace(/^[/\\]/, "-").replace(/[/\\]/g, "-");
}

/** Decode a Claude Code project dir name back to a path-ish string. */
export function decodeProjectDir(encoded: string): string {
  // Lossy — original separators may have been `/`, but for display purposes
  // we restore POSIX-style.
  return "/" + encoded.replace(/^-/, "").replace(/-/g, "/");
}

interface RawJsonl {
  type?: string;
  uuid?: string;
  parentUuid?: string | null;
  isMeta?: boolean;
  isSidechain?: boolean;
  timestamp?: string;
  cwd?: string;
  sessionId?: string;
  gitBranch?: string;
  message?: {
    role?: string;
    content?: unknown;
  };
}

interface ContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  name?: string;
  input?: unknown;
  content?: unknown;
  tool_use_id?: string;
}

function isMetaUserNoise(content: string): boolean {
  // Claude Code injects local-command artifacts that aren't real user turns.
  return (
    content.startsWith("<local-command-caveat>") ||
    content.startsWith("<local-command-stdout>") ||
    content.startsWith("<local-command-stderr>")
  );
}

function renderToolResult(block: ContentBlock): string {
  const inner = block.content;
  if (typeof inner === "string") {
    return `[tool_result] ${truncate(inner, 600)}`;
  }
  if (Array.isArray(inner)) {
    const text = inner
      .map((b: ContentBlock) => (typeof b?.text === "string" ? b.text : ""))
      .filter(Boolean)
      .join("\n");
    return `[tool_result] ${truncate(text, 600)}`;
  }
  return "[tool_result]";
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + "…";
}

/** Render content (string OR block-array) into canonical text + role hint. */
function renderContent(content: unknown): { text: string; sawToolResult: boolean } {
  if (content == null) return { text: "", sawToolResult: false };
  if (typeof content === "string") return { text: content, sawToolResult: false };
  if (!Array.isArray(content)) return { text: String(content), sawToolResult: false };

  const parts: string[] = [];
  let sawToolResult = false;
  for (const raw of content) {
    const block = (raw ?? {}) as ContentBlock;
    switch (block.type) {
      case "text":
        if (block.text) parts.push(block.text);
        break;
      case "thinking":
        if (block.thinking) parts.push(`[thinking] ${truncate(block.thinking, 1200)}`);
        break;
      case "tool_use":
        parts.push(`[tool: ${block.name ?? "unknown"}]`);
        break;
      case "tool_result":
        sawToolResult = true;
        parts.push(renderToolResult(block));
        break;
      default:
        if (typeof block.text === "string") parts.push(block.text);
    }
  }
  return { text: parts.join("\n"), sawToolResult };
}

function recordToTurn(rec: RawJsonl): CanonicalTurn | null {
  if (!rec.message || !rec.message.role) return null;
  const role = rec.message.role;
  const { text, sawToolResult } = renderContent(rec.message.content);
  if (!text.trim()) return null;
  if (role === "user") {
    if (rec.isMeta || isMetaUserNoise(text.trim())) return null;
    // tool_result blocks arrive nested inside user records — bucket as "tool".
    const turnRole = sawToolResult && !text.replace(/\[tool_result\][\s\S]*/g, "").trim()
      ? "tool"
      : "user";
    return {
      role: turnRole,
      text,
      timestamp: rec.timestamp,
      tokens: estimateTokens(text),
    };
  }
  if (role === "assistant") {
    return {
      role: "assistant",
      text,
      timestamp: rec.timestamp,
      tokens: estimateTokens(text),
    };
  }
  return null;
}

export async function parseClaudeCodeSession(
  filePath: string
): Promise<CanonicalSession | null> {
  const raw = await readFile(filePath, "utf-8");
  const turns: CanonicalTurn[] = [];
  let sessionId = "";
  let cwd: string | undefined;
  let gitBranch: string | undefined;
  let earliest: string | undefined;

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let rec: RawJsonl;
    try { rec = JSON.parse(line) as RawJsonl; } catch { continue; }
    if (rec.type === "permission-mode" || rec.type === "file-history-snapshot") {
      if (!sessionId && rec.sessionId) sessionId = rec.sessionId;
      continue;
    }
    if (rec.sessionId && !sessionId) sessionId = rec.sessionId;
    if (rec.cwd && !cwd) cwd = rec.cwd;
    if (rec.gitBranch && !gitBranch) gitBranch = rec.gitBranch;
    if (rec.timestamp && (!earliest || rec.timestamp < earliest)) earliest = rec.timestamp;

    if (rec.type === "user" || rec.type === "assistant") {
      const turn = recordToTurn(rec);
      if (turn) turns.push(turn);
    }
  }

  if (turns.length === 0) return null;
  if (!sessionId) {
    sessionId = filePath.split("/").pop()!.replace(/\.jsonl$/, "");
  }

  return {
    source: "claude-code",
    sessionId,
    cwd,
    gitBranch,
    startDate: earliest ? earliest.slice(0, 10) : undefined,
    turns,
  };
}

export class ClaudeCodeAdapter implements SessionAdapter {
  name = "claude-code";
  description = "Import Claude Code session transcripts (~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl)";

  constructor(private projectsDir: string = CLAUDE_CODE_PROJECTS_DIR) {}

  async listSessions(opts: AdapterListOptions): Promise<CanonicalSession[]> {
    let projectDirs: string[];
    try {
      const entries = await readdir(this.projectsDir, { withFileTypes: true });
      projectDirs = entries
        .filter((e) => e.isDirectory())
        .map((e) => join(this.projectsDir, e.name));
    } catch {
      return [];
    }

    if (opts.project) {
      const wanted = opts.project.startsWith("-")
        ? opts.project
        : encodeProjectDir(opts.project);
      projectDirs = projectDirs.filter(
        (d) => d.endsWith(`/${wanted}`) || d.endsWith(wanted)
      );
    }

    type Candidate = { file: string; mtimeMs: number };
    const candidates: Candidate[] = [];
    for (const dir of projectDirs) {
      let files: string[];
      try { files = await readdir(dir); } catch { continue; }
      for (const f of files) {
        if (!f.endsWith(".jsonl")) continue;
        const full = join(dir, f);
        try {
          const s = await stat(full);
          candidates.push({ file: full, mtimeMs: s.mtimeMs });
        } catch { /* ignore */ }
      }
    }
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);

    const sessions: CanonicalSession[] = [];
    for (const c of candidates) {
      if (opts.maxSessions != null && sessions.length >= opts.maxSessions) break;
      const session = await parseClaudeCodeSession(c.file);
      if (!session) continue;
      if (opts.since && session.startDate && session.startDate < opts.since) continue;
      sessions.push(session);
    }
    return sessions;
  }
}
