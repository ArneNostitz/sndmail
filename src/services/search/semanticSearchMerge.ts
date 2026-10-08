import type { SearchMatch } from "@/stores/threadStore";
import type { SemanticHit } from "./semanticSearchRuntime";

/** Label-shaped subset the merge needs; the store's Label satisfies it. */
export interface SemanticScopeLabel {
  id: string;
  name: string | null;
}

export interface SemanticMergeScope {
  accountIds?: string[];
  labelIds?: string[];
  excludeSpamTrash?: boolean;
  labels?: SemanticScopeLabel[];
}

function metadataString(hit: SemanticHit, key: string): string | null {
  const value = hit.metadata?.[key];
  return typeof value === "string" && value.trim() ? value : null;
}

/**
 * Decide whether one semantic hit belongs to the scope the user searched in.
 *
 * The index stores tags as [account email, ...label names], so label scoping
 * matches both the label id and its display name, case-insensitively — the
 * search bar scopes by id while the indexer wrote names. A label we cannot
 * resolve is matched by id alone (inclusive on unknown).
 */
export function semanticHitPassesScope(
  hit: SemanticHit,
  scope: SemanticMergeScope,
): boolean {
  if (scope.accountIds?.length) {
    const account = metadataString(hit, "account");
    if (account && !scope.accountIds.includes(account)) return false;
  }
  if (scope.labelIds?.length) {
    const tags = new Set((hit.tags ?? []).map((tag) => tag.toLowerCase()));
    const candidates = scope.labelIds.flatMap((id) => {
      const label = scope.labels?.find((l) => l.id === id);
      return label?.name
        ? [id.toLowerCase(), label.name.toLowerCase()]
        : [id.toLowerCase()];
    });
    if (!candidates.some((candidate) => tags.has(candidate))) return false;
  }
  if (scope.excludeSpamTrash) {
    const tags = new Set((hit.tags ?? []).map((tag) => tag.toLowerCase()));
    if (tags.has("spam") || tags.has("trash")) return false;
  }
  return true;
}

function hitExcerpt(hit: SemanticHit): string | null {
  const raw = hit.semanticEvidence?.passage ?? hit.snippet ?? null;
  return raw?.replace(/\s+/g, " ").trim() || null;
}

/**
 * Add semantic hits to the keyword matches, grouped per thread. Semantic is
 * strictly additive: a thread the keyword search already found keeps its
 * keyword excerpt (only filling one in when missing) and gains message ids;
 * new threads arrive with a semantic excerpt.
 *
 * Returns the number of threads added that the keyword search had not found.
 */
export function mergeSemanticHits(
  hits: SemanticHit[],
  matches: Map<string, SearchMatch>,
  scope: SemanticMergeScope,
): number {
  let added = 0;
  for (const hit of hits) {
    if (!semanticHitPassesScope(hit, scope)) continue;
    const threadId = metadataString(hit, "threadId");
    if (!threadId) continue;
    const messageId = metadataString(hit, "messageId");
    const messageIds = messageId ? new Set([messageId]) : new Set<string>();
    const existing = matches.get(threadId);
    if (existing) {
      for (const id of messageIds) existing.messageIds.add(id);
      if (!existing.excerpt) existing.excerpt = hitExcerpt(hit);
    } else {
      matches.set(threadId, { messageIds, excerpt: hitExcerpt(hit) });
      added += 1;
    }
  }
  return added;
}
