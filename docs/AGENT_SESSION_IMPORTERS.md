# Agent Session Importers — Design & Usage

> Branch: `feat/agent-session-importers`
> Status: M1 (framework) + M2 (Claude Code adapter) shipped, all 8 acceptance gates green
> Author: Jingwei (Hermes) + Claude Code (Opus 4.7)

## TL;DR

Bulk-import historical AI-agent conversation transcripts (currently: Claude Code) into memex as **distilled atomic Zettelkasten cards** — not raw dumps. The pipeline reads JSONL session files, splits them at user-message boundaries, sends each chunk to a distiller LLM (default: Claude Opus 4.7 via copilot-gateway worker), and writes 0–3 atomic cards per chunk with full provenance frontmatter. Re-imports are idempotent.

```
memex import claude-code --dry-run                     # preview
memex import claude-code --since 2026-04-01            # by date
memex import claude-code --project /path/to/repo       # by project
memex import claude-code --max-sessions 5              # cap count
```

---

## 1. Why this exists

memex was added to a developer machine **after** the user had already accumulated weeks/months of AI-agent transcripts (Claude Code, Codex, Copilot CLI, VS Code Copilot Chat). Those transcripts hold real cross-session insights — but mechanical dump-import would violate the Zettelkasten principle ("digest, never dump"). We need an importer that distills.

The flomo importer pattern set the precedent: read source → curate via LLM → emit atomic cards with `source: <provider>` provenance. Agent-session importers extend that pattern to a different (and more structured) source format.

## 2. Architecture

### 2.1 Pipeline

```
SessionAdapter.listSessions()
   → CanonicalSession[]           (provider-agnostic shape)
     → chunkSession                (split at user-msg boundaries, ≤8K tokens each)
       → DistillerFn                (LLM call → JSON cards array)
         → CardDraft[]              (0–3 atomic insights per chunk)
           → resolveWikilinks       (peer + existing-card aware)
             → resolveSlugForWrite  (idempotent: skip on same source+session_id)
               → store.writeCard()
```

### 2.2 File map (`src/importers/agent-sessions/`)

| File | Role | LOC |
|------|------|-----|
| `types.ts` | `CanonicalSession`, `CanonicalTurn`, `CardDraft`, `SessionAdapter`, `DistillerFn`, `PipelineOptions`, `PipelineResult` | small |
| `chunker.ts` | `estimateTokens` (chars/4 heuristic), `chunkSession` (greedy pack with hard 8K cap, splits ONLY at user-message boundaries) | small |
| `distiller.ts` | `createCopilotDistiller` — fetch-based Anthropic Messages client with `JACKY_COPILOT_KEY`; `parseDistillResponse` extracts strict-JSON `{cards:[…]}` | medium |
| `dedup.ts` | `slugify` (kebab/ASCII/≤60 chars), `resolveSlugForWrite` (idempotent skip), `resolveWikilinks` (peer + existing-card matching) | medium |
| `pipeline.ts` | `runPipeline` — orchestration; renders cards with custom YAML scalar quoter (mirrors `parser.ts` rules) | medium |
| `claude-code.ts` | `ClaudeCodeAdapter` — parses `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`, handles string-or-block content, filters tool noise | medium |
| `claude-code-importer.ts` | Wraps the adapter as a memex `Importer` (matches `Importer` interface from `src/importers/index.ts`); reads env, constructs distiller, surfaces `draftsProposed/sessions/chunks` telemetry | small |
| `index.ts` | Barrel re-exports | tiny |

### 2.3 CLI surface

`src/commands/import.ts` was widened to recognize agent-session importers (those returning `draftsProposed/sessions/chunks` in `ImportResult`) and emit a richer summary line. New flags surfaced through `src/cli.ts` for `import claude-code`:

| Flag | Effect |
|------|--------|
| `--dry-run` | Discover + chunk + distill, but skip `store.writeCard()` |
| `--since YYYY-MM-DD` | Filter sessions by mtime |
| `--project <path>` | Filter sessions by their original `cwd` (accepts either real path or `-Users-...` encoded form) |
| `--max-sessions N` | Cap session count for safety |
| `--model <id>` | Override distiller model (default `claude-opus-4-7`) |
| `--review` | Reserved for future interactive curation TUI; currently a no-op flag |

### 2.4 Card frontmatter

```yaml
---
title: <slug-derived-title>
created: "YYYY-MM-DD"
source: claude-code
tags: [agent-import, claude-code, <session-date>, <model-suggested-tags>]
session_id: <uuid>
session_cwd: <original-cwd>
session_git_branch: <branch>     # only if present in JSONL
---
```

Provenance is the critical bit: `source` + `session_id` + `session_cwd` enable idempotent re-imports (the dedup layer detects "same provenance + same slug" and skips).

## 3. Key design decisions

### 3.1 Ship a separate `claude-code-importer.ts`, don't widen `Importer` interface

The existing `Importer` interface (used by `openclaw`, `flomo`) assumes a flat directory of files. Session pipelines have richer telemetry (sessions/chunks/drafts) and need provider-specific knobs (`--since`, `--model`). We kept the interface narrow and added a wrapper that:

- Implements `Importer` for CLI registration uniformity
- Returns extended `ImportResult` (`draftsProposed`, `sessions`, `chunks`)
- Constructs the distiller from env at runtime so unit tests can inject mocks

This lets `memex import claude-code` live in the same `getImporter()` registry as `openclaw` without forcing every importer to grow LLM concerns.

### 3.2 Custom YAML scalar quoter, not `parser.stringifyFrontmatter`

`stringifyFrontmatter` produced block-scalar `>-` output that broke our re-parse round-trip when titles contained special chars. Per `AGENTS.md` we cannot replace `parser.ts` with `js-yaml`, so we wrote a tiny `yamlScalar` mirroring its quoting rules in `pipeline.ts::renderCard`. This keeps imported cards parser-stable on subsequent reads.

### 3.3 `{"cards": []}` is a designed signal, not an error

When the distiller LLM judges a chunk not worth saving (small talk, partial transcripts, garbage), it returns `{"cards":[]}`. The pipeline treats this as **success with zero output**, not failure. This is essential — it's what enforces the "atomic, non-obvious insights only" quality bar. Verified empirically: short iTerm2 sessions produce 0 cards, the meaty memex-development session produced 6.

### 3.4 Distiller is dependency-injected via `DistillerFn`

`createCopilotDistiller` returns a `DistillerFn` (signature: `(chunk, peers) => Promise<CardDraft[]>`). Tests inject mocks. Production wires the real LLM call. This is the seam that lets future adapters swap in different distill strategies (e.g., per-provider system prompts) without touching pipeline code.

### 3.5 `MEMEX_DISTILL_DEBUG=1` for raw-response inspection

When debugging "0 drafts emitted" symptoms, set this env var. The distiller will print the first 800 chars of the raw LLM response on stderr when `cards.length === 0` AND raw text was non-empty. Helped during M2 commissioning to distinguish "empty response" from "malformed JSON" from "valid empty cards array".

### 3.6 dist/ deliberately excluded from feature commits

The repo tracks `dist/` (npm publish workflow). For a feature branch we keep dist/ rebuilds OUT of commits — the maintainer's release flow rebuilds. This avoids merge conflicts on bundle artifacts and keeps PR diffs reviewable.

## 4. Acceptance gates (all green)

| # | Gate | Result |
|---|------|--------|
| 1 | `npm test` | 499/499 (25 new in `tests/importers/agent-sessions/`) |
| 2 | `npm run build` | clean (known `node-llama-cpp` TS warning ignored per AGENTS.md) |
| 3a | dry-run smoke | iTerm2 single-session → discovered 1, chunked 1, 0 cards (model judgment) |
| 3b | live smoke | memex own session (600KB transcript, 2 chunks) → **6 cards, quality "excellent"** |
| 4 | `docs/ARCHITECTURE.md` §10.5 | added |
| 5 | `README.md` import section | added |
| 6 | `git diff main` self-review | clean, no leaked secrets, no dead code |
| 7 | logical commits | 5 Conventional Commits, no dist |
| 8 | push to fork | `feat/agent-session-importers` on `suninrain086/memex` |

## 5. Pitfalls observed (and codified)

### 5.1 copilot-gateway beta header allowlist

Worker (`copilot.suninrain086.workers.dev`) maintains a strict allowlist of `anthropic-beta` header values. When Claude Code v2.1.114 starts forwarding `context-management-2025-06-27`, the worker rejects with `400 invalid_request_error`. **Fix**: add new beta values to worker allowlist as Anthropic ships them.

### 5.2 Opus 4.7 effort levels are model-gated

`claude-opus-4-7` rejects `output_config.effort: "high"` (`invalid_reasoning_effort`, only `medium` allowed). Claude Code's `--effort high` flag silently maps OK; the issue surfaces only when launching with explicit high effort. **Fix**: `/effort medium` mid-session.

### 5.3 Claude Code agent-loop retry vs. tool error

Don't conflate Claude Code's TUI banner `⎿ API Error: 400 …` with task failure. That message is its own meta-LLM call (planner) failing, not the bash tool. The actual command output above the banner is what matters. Several "stuck" moments during M2 were actually completed work + a transient agent-loop hiccup.

### 5.4 Model id must stay bare

Hermes config + worker requires bare `claude-opus-4-7` — the `[1m]` suffix Claude Code CLI uses internally for 1M-context gating must NOT leak into outbound requests. Worker rejects bracketed model ids with `400 model_not_supported`.

## 6. Usage cookbook

### 6.1 First-time setup

```bash
# 1. Set the API key (worker forwards to Copilot)
export JACKY_COPILOT_KEY=sk-...   # add to ~/.zshrc / ~/.bashrc

# 2. (optional) Verify worker is reachable
curl -sS https://copilot.suninrain086.workers.dev/v1/messages \
  -H "x-api-key: $JACKY_COPILOT_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -d '{"model":"claude-opus-4-7","max_tokens":20,"messages":[{"role":"user","content":"ping"}]}'

# 3. Build (only needed on the feature branch — npm publish handles dist/ later)
cd ~/work/projects/github/memex
npm install
npm run build
```

### 6.2 Dry-run preview (recommended first step)

```bash
node dist/cli.js import claude-code --dry-run --max-sessions 3
```

Output:
```
discovered 3 session(s) from claude-code
session abc123… → 2 chunk(s)
session def456… → 1 chunk(s)
…
0 cards would be created, 0 skipped (sessions=3 chunks=4 drafts=N)
```

### 6.3 Targeted import (one project)

```bash
node dist/cli.js import claude-code \
  --project /Users/jackyzeng/projects/chromium-atlas \
  --since 2026-04-01
```

The `--project` flag accepts either the real path or the `-Users-...` encoded form Claude Code uses on disk.

### 6.4 Sandbox import (write to temp memex, inspect, then commit)

```bash
rm -rf /tmp/memex-import-test
MEMEX_HOME=/tmp/memex-import-test node dist/cli.js import claude-code \
  --project /Users/jackyzeng/work/projects/github/memex \
  --max-sessions 1

# Inspect produced cards
ls /tmp/memex-import-test/cards/
cat /tmp/memex-import-test/cards/<some-slug>.md

# If happy, run against real memex
node dist/cli.js import claude-code --project … --max-sessions 1
```

### 6.5 Production import (full sweep)

```bash
node dist/cli.js import claude-code               # all sessions, all projects
```

For very large transcript backlogs, batch:
```bash
for proj in chromium-atlas memex-card-browser memex; do
  node dist/cli.js import claude-code \
    --project "/Users/jackyzeng/work/projects/github/$proj" \
    --max-sessions 20
done
```

### 6.6 Re-import is idempotent

Running the same import twice is safe — slug-collision check verifies `source: claude-code` AND matching `session_id`, then skips. You'll see `skipped=N` in the summary.

### 6.7 Debugging

| Symptom | Action |
|---------|--------|
| "0 cards … sessions=N chunks=M drafts=0" | Set `MEMEX_DISTILL_DEBUG=1` to see raw LLM responses; usually means model judged content unworthy |
| "JACKY_COPILOT_KEY not set" | `export JACKY_COPILOT_KEY=sk-…` |
| `400 Unexpected value 'context-management-…' for anthropic-beta` | Update worker allowlist (cloudflare worker source) |
| `400 invalid_reasoning_effort` | Drop `--effort high` for Opus models, use `medium` |
| `400 model_not_supported` | Ensure model id is bare `claude-opus-4-7` (no `[1m]` suffix) |

## 7. Roadmap (M3+)

Not yet shipped:

- **M3** — Codex adapter (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`)
- **M4** — Copilot CLI adapter (`~/.copilot/session-store.db`, SQLite)
- **M5** — VS Code Copilot Chat adapter (`~/Library/Application Support/Code/.../chatSessions/*.jsonl`)
- **M6** — Interactive `--review` TUI (curate proposed drafts before write)
- **`memex import all`** convenience command (fan-out across all configured providers)
- **MCP tool wrapper** — expose `agent_session_import` so other agents can trigger imports

The pipeline (`runPipeline`) is provider-agnostic — every M3+ milestone is a new `SessionAdapter` + a thin `Importer` wrapper, no pipeline changes needed.

## 8. Files changed (this PR)

```
src/importers/agent-sessions/                        (NEW DIR, 8 files)
src/importers/index.ts                               (registered claude-code)
src/commands/import.ts                               (richer summary)
src/cli.ts                                           (new flags)
tests/fixtures/claude-code-session.jsonl             (NEW)
tests/importers/agent-sessions/                      (NEW DIR, 4 test files, 25 tests)
docs/ARCHITECTURE.md                                 (§10.5 added)
README.md                                            (import section added)
docs/AGENT_SESSION_IMPORTERS.md                      (this doc)
```

## 9. Commits

```
99484fd docs: document agent session importers
b09c416 test(importers): add fixture + unit tests for agent-session pipeline
cf3a250 feat(cli): wire claude-code importer into memex import
a308210 feat(importers): add Claude Code session adapter (M2)
cd193c5 feat(importers): add agent-session pipeline framework (M1)
```

Branch: https://github.com/suninrain086/memex/tree/feat/agent-session-importers
