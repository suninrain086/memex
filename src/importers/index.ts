import { CardStore } from "../lib/store.js";

/**
 * Common interface for all memory importers.
 *
 * Two flavors:
 *  - "bulk-file": reads a directory of source files (e.g. openclaw markdown
 *    daily-notes), runs synchronously, no LLM. Implements `Importer.run`.
 *  - "agent-session": reads conversation transcripts and uses an LLM
 *    distiller to produce atomic Zettelkasten cards. Implements
 *    `Importer.runSessions`.
 *
 * To add a new bulk-file importer:
 * 1. Create src/importers/<name>.ts implementing Importer
 * 2. Register it in src/importers/index.ts
 * 3. Run: memex import <name> [--dry-run]
 *
 * To add a new agent-session importer:
 * 1. Create a SessionAdapter under src/importers/agent-sessions/
 * 2. Wrap it as an `Importer` here (see ClaudeCodeImporter)
 */
export interface ImportResult {
  created: number;
  skipped: number;
  /** Optional richer telemetry (session importers fill this in). */
  draftsProposed?: number;
  sessions?: number;
  chunks?: number;
}

export interface ImportOptions {
  store: CardStore;
  sourceDir: string;
  dryRun?: boolean;
  onLog?: (msg: string) => void;
}

export interface SessionImportOptions {
  store: CardStore;
  dryRun?: boolean;
  review?: boolean;
  since?: string;
  project?: string;
  maxSessions?: number;
  model?: string;
  onLog?: (msg: string) => void;
}

export interface Importer {
  name: string;
  description: string;
  /** "bulk-file" importers honor `defaultSourceDir` + `run`. */
  defaultSourceDir?: string;
  run?(opts: ImportOptions): Promise<ImportResult>;
  /** Agent-session importers expose this instead of `run`. */
  runSessions?(opts: SessionImportOptions): Promise<ImportResult>;
}

// --- Importer registry ---

import { OpenClawImporter } from "./openclaw.js";
import { ClaudeCodeImporter } from "./agent-sessions/claude-code-importer.js";

const importers: Record<string, Importer> = {};

function register(importer: Importer) {
  importers[importer.name] = importer;
}

register(new OpenClawImporter());
register(new ClaudeCodeImporter());
// register(new ObsidianImporter());  // future
// register(new NotionImporter());    // future

export function getImporter(name: string): Importer | undefined {
  return importers[name];
}

export function listImporters(): Importer[] {
  return Object.values(importers);
}
