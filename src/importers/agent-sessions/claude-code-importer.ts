import type { Importer, SessionImportOptions, ImportResult } from "../index.js";
import { ClaudeCodeAdapter } from "./claude-code.js";
import { runPipeline } from "./pipeline.js";
import { createCopilotDistiller, DEFAULT_DISTILL_MODEL } from "./distiller.js";

const API_KEY_ENV = "JACKY_COPILOT_KEY";

/**
 * Adapter wrapper that exposes the Claude Code session importer through
 * the shared `Importer` interface so `memex import claude-code` works
 * the same way as other importers.
 */
export class ClaudeCodeImporter implements Importer {
  name = "claude-code";
  description = "Distill Claude Code session transcripts into atomic cards (LLM)";

  async runSessions(opts: SessionImportOptions): Promise<ImportResult> {
    const apiKey = process.env[API_KEY_ENV];
    if (!apiKey) {
      throw new Error(
        `Missing ${API_KEY_ENV} environment variable. ` +
        `The Claude Code importer needs API access through the copilot-gateway worker. ` +
        `Set it in your shell, e.g.:  export ${API_KEY_ENV}=...`
      );
    }
    const distill = createCopilotDistiller({
      apiKey,
      model: opts.model ?? DEFAULT_DISTILL_MODEL,
    });
    const result = await runPipeline({
      store: opts.store,
      adapter: new ClaudeCodeAdapter(),
      list: { since: opts.since, project: opts.project, maxSessions: opts.maxSessions },
      distill,
      dryRun: opts.dryRun,
      review: opts.review,
      onLog: opts.onLog,
    });
    return {
      created: result.cardsWritten,
      skipped: result.skipped,
      draftsProposed: result.draftsProposed,
      sessions: result.sessions,
      chunks: result.chunks,
    };
  }
}
