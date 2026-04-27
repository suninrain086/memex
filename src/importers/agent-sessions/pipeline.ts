import { chunkSession } from "./chunker.js";
import { resolveSlugForWrite, resolveWikilinks } from "./dedup.js";
import type {
  CardDraft,
  CanonicalSession,
  PipelineOptions,
  PipelineResult,
} from "./types.js";

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function yamlScalar(value: string): string {
  // Mirror parser.ts stringifyFrontmatter quoting rule for safety.
  if (value === "" || /[:#{}[\],&*?|>!%@`']/.test(value)) {
    return `'${value.replace(/'/g, "''")}'`;
  }
  return value;
}

function renderCard(
  draft: CardDraft,
  session: CanonicalSession
): string {
  const created = session.startDate || todayIso();
  const sessionDateTag = session.startDate ?? created;
  const baseTags = ["agent-import", session.source, sessionDateTag];
  const merged = Array.from(
    new Set([...(draft.tags ?? []), ...baseTags].map((t) => String(t).trim()).filter(Boolean))
  );
  const tagsLine = `[${merged.map((t) => (/[\s,:#]/.test(t) ? `"${t}"` : t)).join(", ")}]`;
  const lines = [
    `title: ${yamlScalar(draft.title.replace(/\n/g, " ").trim())}`,
    `created: "${created}"`,
    `source: ${yamlScalar(session.source)}`,
    `tags: ${tagsLine}`,
    `session_id: ${yamlScalar(session.sessionId)}`,
  ];
  if (session.cwd) lines.push(`session_cwd: ${yamlScalar(session.cwd)}`);
  if (session.gitBranch) lines.push(`session_git_branch: ${yamlScalar(session.gitBranch)}`);
  return `---\n${lines.join("\n")}\n---\n\n${draft.body.trim()}\n`;
}

/**
 * End-to-end: discover sessions → chunk → distill → dedup → write.
 * Designed to be deterministic when `distill` is mocked.
 */
export async function runPipeline(opts: PipelineOptions): Promise<PipelineResult> {
  const log = opts.onLog ?? (() => {});
  const result: PipelineResult = {
    sessions: 0,
    chunks: 0,
    draftsProposed: 0,
    cardsWritten: 0,
    skipped: 0,
  };

  const sessions = await opts.adapter.listSessions(opts.list);
  result.sessions = sessions.length;
  log(`discovered ${sessions.length} session(s) from ${opts.adapter.name}`);

  // Snapshot existing slugs once for wikilink resolution.
  const existingSlugs = (await opts.store.scanAll()).map((c) => c.slug);

  for (const session of sessions) {
    const chunked = chunkSession(session);
    result.chunks += chunked.chunks.length;
    log(`session ${session.sessionId} → ${chunked.chunks.length} chunk(s)`);

    const sessionDrafts: CardDraft[] = [];
    const siblingSlugs: string[] = [];

    for (const chunk of chunked.chunks) {
      let drafts: CardDraft[] = [];
      try {
        drafts = await opts.distill({ session, chunk, siblingSlugs });
      } catch (err) {
        log(`  distill error on chunk ${chunk.index}: ${(err as Error).message}`);
        continue;
      }
      result.draftsProposed += drafts.length;
      for (const d of drafts) siblingSlugs.push(d.slug);
      sessionDrafts.push(...drafts);
    }

    if (sessionDrafts.length === 0) continue;

    const resolved = resolveWikilinks(sessionDrafts, existingSlugs, siblingSlugs);

    for (const draft of resolved) {
      const finalSlug = await resolveSlugForWrite(opts.store, draft.slug, {
        source: session.source,
        sessionId: session.sessionId,
      });
      if (finalSlug === null) {
        result.skipped++;
        log(`  ↻ skip ${draft.slug} (already imported from this session)`);
        continue;
      }

      const card = renderCard({ ...draft, slug: finalSlug }, session);

      if (opts.review || opts.dryRun) {
        const preview = draft.body.split("\n").find((l) => l.trim().length > 0)?.slice(0, 80) ?? "";
        log(`  ${opts.dryRun ? "[dry-run] would write" : "[review]"} ${finalSlug}: ${draft.title} — ${preview}`);
      }

      if (!opts.dryRun) {
        await opts.store.writeCard(finalSlug, card);
        existingSlugs.push(finalSlug);
        log(`  ✓ ${finalSlug}.md`);
      }
      result.cardsWritten++;
    }
  }

  return result;
}
