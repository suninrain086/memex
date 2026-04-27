import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { CardStore } from "../lib/store.js";
import { getImporter, listImporters } from "../importers/index.js";

interface ImportCommandResult {
  success: boolean;
  output?: string;
  error?: string;
}

export interface ImportCommandOptions {
  dryRun?: boolean;
  dir?: string;
  // Session-importer flags (ignored by bulk-file importers).
  since?: string;
  project?: string;
  maxSessions?: number;
  model?: string;
  review?: boolean;
}

export async function importCommand(
  store: CardStore,
  source: string | undefined,
  opts: ImportCommandOptions
): Promise<ImportCommandResult> {
  if (!source) {
    const available = listImporters();
    const list = available
      .map((i) => `  ${i.name.padEnd(14)} ${i.description}`)
      .join("\n");
    return {
      success: true,
      output:
        `Available importers:\n${list}\n\n` +
        `Usage:\n` +
        `  memex import <source> [--dry-run] [--dir <path>]\n` +
        `  memex import claude-code [--since YYYY-MM-DD] [--project <path>] [--max-sessions N] [--model <id>] [--review]`,
    };
  }

  const importer = getImporter(source);
  if (!importer) {
    const names = listImporters().map((i) => i.name).join(", ");
    return {
      success: false,
      error: `Unknown importer: "${source}". Available: ${names}`,
    };
  }

  const logs: string[] = [];
  const onLog = (msg: string) => logs.push(msg);

  try {
    if (importer.runSessions) {
      const result = await importer.runSessions({
        store,
        dryRun: opts.dryRun,
        review: opts.review,
        since: opts.since,
        project: opts.project,
        maxSessions: opts.maxSessions,
        model: opts.model,
        onLog,
      });
      const summary = `${result.created} cards ${opts.dryRun ? "would be " : ""}created, ${result.skipped} skipped (sessions=${result.sessions ?? "?"} chunks=${result.chunks ?? "?"} drafts=${result.draftsProposed ?? "?"})`;
      logs.push("", summary);
      return { success: true, output: logs.join("\n") };
    }

    if (!importer.run || !importer.defaultSourceDir) {
      return { success: false, error: `Importer "${source}" is not runnable` };
    }

    const sourceDir = opts.dir || join(homedir(), importer.defaultSourceDir);
    if (!existsSync(sourceDir)) {
      return { success: false, error: `Source directory not found: ${sourceDir}` };
    }
    const result = await importer.run({
      store,
      sourceDir,
      dryRun: opts.dryRun,
      onLog,
    });
    const summary = `${result.created} cards ${opts.dryRun ? "would be " : ""}created, ${result.skipped} skipped`;
    logs.push("", summary);
    if (!opts.dryRun && result.created > 0) {
      logs.push("Run 'memex serve' to visualize!");
    }
    return { success: true, output: logs.join("\n") };
  } catch (err) {
    return {
      success: false,
      output: logs.join("\n"),
      error: (err as Error).message,
    };
  }
}
