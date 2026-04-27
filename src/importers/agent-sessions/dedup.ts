import type { CardStore } from "../../lib/store.js";
import { parseFrontmatter } from "../../lib/parser.js";
import type { CardDraft } from "./types.js";

/**
 * kebab-case slugify, mirroring openclaw conventions but ASCII-only and
 * capped at 60 chars (matches the soft slug rule in ARCHITECTURE.md).
 */
export function slugify(text: string): string {
  const base = text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
  return base || "card";
}

/**
 * Resolve a slug collision.
 *
 *  - If no card at `slug`, return slug unchanged.
 *  - If the existing card has matching `source` AND matching `session_id`
 *    in frontmatter, the import is idempotent — return null to signal "skip".
 *  - Otherwise, append -2, -3, ... until a free slug is found.
 */
export async function resolveSlugForWrite(
  store: CardStore,
  rawSlug: string,
  meta: { source: string; sessionId: string }
): Promise<string | null> {
  const base = slugify(rawSlug);
  const existing = await store.resolve(base);
  if (!existing) return base;
  if (await sameSourceAndSession(store, base, meta)) {
    return null;
  }
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`.slice(0, 60);
    const hit = await store.resolve(candidate);
    if (!hit) return candidate;
    if (await sameSourceAndSession(store, candidate, meta)) {
      return null;
    }
  }
  throw new Error(`Slug exhaustion for base ${base}`);
}

async function sameSourceAndSession(
  store: CardStore,
  slug: string,
  meta: { source: string; sessionId: string }
): Promise<boolean> {
  try {
    const raw = await store.readCard(slug);
    const { data } = parseFrontmatter(raw);
    return data.source === meta.source && data.session_id === meta.sessionId;
  } catch {
    return false;
  }
}

/**
 * Walk drafts and rewrite their `[[wikilinks]]` so that each link points
 * at an existing slug whenever possible. Resolution order:
 *   1. Exact match in `existingSlugs` (case-insensitive).
 *   2. Exact match in `peerSlugs` (drafts in the same batch).
 *   3. Case-insensitive prefix match in `existingSlugs`.
 *   4. Otherwise leave the link as-is (memex tolerates dangling wikilinks).
 *
 * Also folds `related_slugs` into the body if any are missing.
 */
export function resolveWikilinks(
  drafts: CardDraft[],
  existingSlugs: string[],
  peerSlugs: string[]
): CardDraft[] {
  const lcExisting = new Map(existingSlugs.map((s) => [s.toLowerCase(), s]));
  const peerSet = new Set(peerSlugs.map((s) => s.toLowerCase()));

  const resolveOne = (raw: string): string => {
    const lc = raw.toLowerCase();
    const slug = slugify(raw);
    if (lcExisting.has(slug)) return lcExisting.get(slug)!;
    if (lcExisting.has(lc)) return lcExisting.get(lc)!;
    if (peerSet.has(slug) || peerSet.has(lc)) return raw;
    for (const [key, val] of lcExisting) {
      if (key.startsWith(slug) || slug.startsWith(key)) return val;
    }
    return raw;
  };

  return drafts.map((d) => ({
    ...d,
    body: d.body.replace(/\[\[([^\]\n]+)\]\]/g, (_m, target: string) => {
      const trimmed = target.trim();
      const resolved = resolveOne(trimmed);
      return `[[${resolved}]]`;
    }),
    related_slugs: d.related_slugs?.map(resolveOne),
  }));
}
