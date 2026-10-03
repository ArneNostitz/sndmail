import { useState, useRef, useCallback, useEffect } from "react";
import { searchMessages } from "@/services/db/search";
import { useAccountStore, listedAccountIds } from "@/stores/accountStore";
import { useThreadStore, type SearchMatch } from "@/stores/threadStore";
import { useSmartFolderStore } from "@/stores/smartFolderStore";
import { InputDialog } from "@/components/ui/InputDialog";
import { Search, X, FolderPlus } from "lucide-react";

import { useActiveLabel } from "@/hooks/useRouteNavigation";
import { useLabelStore } from "@/stores/labelStore";
import { parseSearchQuery } from "@/services/search/searchParser";
import { resolveQueryTokens } from "@/services/search/smartFolderQuery";

import { Tooltip } from "@/components/ui/Tooltip";
const folderIds: Record<string, string[]> = {
  inbox: ["INBOX"],
  conversations: ["INBOX", "SENT"],
  sent: ["SENT"],
  drafts: ["DRAFT"],
  spam: ["SPAM"],
  trash: ["TRASH"],
  starred: ["STARRED"],
  snoozed: ["SNOOZED"],
  all: [],
  everywhere: [],
};

const searchPresets = [
  { label: "From", token: "from:", needsValue: true },
  { label: "To", token: "to:", needsValue: true },
  { label: "Subject", token: "subject:", needsValue: true },
  { label: "Has attachments", token: "has:attachment", needsValue: false },
  { label: "Unread", token: "is:unread", needsValue: false },
] as const;

function hasIncompleteOperator(query: string): boolean {
  return /(?:^|\s)(?:from|to|subject|before|after|label):\s*$/i.test(query);
}

function presetIsActive(query: string, token: string): boolean {
  const operator = token.slice(0, token.indexOf(":"));
  return token.endsWith(":")
    ? new RegExp(`(?:^|\\s)${operator}:`, "i").test(query)
    : new RegExp(`(?:^|\\s)${token.replace(":", "\\:")}(?=\\s|$)`, "i").test(query);
}

export function SearchBar() {
  const searchQuery = useThreadStore((s) => s.searchQuery);
  const activeAccountId = useAccountStore((s) => s.activeAccountId);
  const unifiedInbox = useAccountStore((s) => s.unifiedInbox);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const activeLabel = useActiveLabel();
  const labels = useLabelStore((s) => s.labels);
  const smartFolder = useSmartFolderStore((s) =>
    s.folders.find((f) => `smart-folder:${f.id}` === activeLabel),
  );
  const accountKey = useAccountStore((s) => listedAccountIds(s).join(","));
  const [scope, setScope] = useState("current");
  const [sort, setSort] = useState<"newest" | "oldest" | "relevance">("newest");
  const [error, setError] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [revision, setRevision] = useState(0);
  const currentName =
    smartFolder?.name ??
    labels.find((l) => l.id === activeLabel)?.name ??
    (activeLabel === "all"
      ? "All mail"
      : activeLabel.charAt(0).toUpperCase() + activeLabel.slice(1));
  useEffect(() => {
    setScope("current");
  }, [activeLabel, accountKey]);
  useEffect(() => {
    const refresh = () => setRevision((v) => v + 1);
    window.addEventListener("sndmail-sync-done", refresh);
    return () => window.removeEventListener("sndmail-sync-done", refresh);
  }, []);
  useEffect(() => {
    let cancelled = false;
    setError(null);
    if (!searchQuery.trim()) {
      setSearching(false);
      return;
    }
    if (hasIncompleteOperator(searchQuery)) {
      setSearching(false);
      return;
    }
    setSearching(true);
    const timer = setTimeout(async () => {
      try {
        const folder = scope === "current" ? activeLabel : scope;
        const labelIds =
          folderIds[folder] ??
          (folder.startsWith("smart-folder:") ? [] : [folder]);
        const hits = await searchMessages(
          searchQuery,
          unifiedInbox ? undefined : (activeAccountId ?? undefined),
          500,
          {
            accountIds: accountKey ? accountKey.split(",") : [],
          labelIds,
          sort,
            excludeSpamTrash:
              folder !== "everywhere" &&
              folder !== "spam" &&
              folder !== "trash",
            ...(scope === "current" && smartFolder
              ? {
                  savedQuery: parseSearchQuery(
                    resolveQueryTokens(smartFolder.query),
                  ),
                }
              : {}),
          },
        );
        if (!cancelled) {
          const matches = new Map<string, SearchMatch>();
          for (const hit of hits) {
            const existing = matches.get(hit.thread_id);
            if (existing) {
              existing.messageIds.add(hit.message_id);
              if (!existing.excerpt && hit.match_excerpt) {
                existing.excerpt = hit.match_excerpt.replace(/\s+/g, " ").trim();
              }
            } else {
              matches.set(hit.thread_id, {
                messageIds: new Set([hit.message_id]),
                excerpt: hit.match_excerpt?.replace(/\s+/g, " ").trim() || null,
              });
            }
          }
          useThreadStore
            .getState()
            .setSearch(searchQuery, new Set(matches.keys()), matches);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          useThreadStore.getState().setSearch(searchQuery, new Set());
        }
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [
    searchQuery,
    scope,
    sort,
    activeLabel,
    activeAccountId,
    unifiedInbox,
    accountKey,
    revision,
    smartFolder,
  ]);

  const [showSaveModal, setShowSaveModal] = useState(false);

  const handleSaveAsSmartFolder = useCallback(() => {
    if (useThreadStore.getState().searchQuery.trim().length < 2) return;
    setShowSaveModal(true);
  }, []);

  const handleChange = (value: string) => {
    useThreadStore.getState().setSearch(value, value.trim() ? new Set() : null);
  };

  const handleClear = useCallback(() => {
    useThreadStore.getState().clearSearch();
    inputRef.current?.focus();
  }, []);

  const handlePreset = useCallback((token: string, needsValue: boolean) => {
    const current = useThreadStore.getState().searchQuery.trim();
    let next = current;
    if (needsValue) {
      if (!presetIsActive(current, token)) next = `${current} ${token}`.trim();
    } else {
      const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const tokenPattern = new RegExp(`(?:^|\\s)${escaped}(?=\\s|$)`, "i");
      next = tokenPattern.test(current)
        ? current.replace(tokenPattern, " ").replace(/\s+/g, " ").trim()
        : `${current} ${token}`.trim();
    }
    useThreadStore.getState().setSearch(next, next ? new Set() : null);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(next.length, next.length);
    });
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      useThreadStore.getState().clearSearch();
      inputRef.current?.blur();
    }
  };

  return (
    <div>
      <div className="relative">
        <Search
          size={14}
          className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-tertiary pointer-events-none"
        />
        <input
          ref={inputRef}
          type="text"
          aria-label="Search mail"
          value={searchQuery}
          onChange={(e) => handleChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Search... (from: to: has:attachment)"
          className="w-full bg-bg-secondary/80 text-text-primary text-sm pl-9 pr-14 py-2.5 rounded-full shadow-[inset_0_1px_1px_rgba(80,66,50,0.06)] focus:bg-white focus:ring-2 focus:ring-accent/15 focus:outline-none placeholder:text-text-tertiary"
        />
        {searchQuery && (
          <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
            {searchQuery.trim().length >= 2 && (
              <Tooltip content="Save as Smart Folder"><button
                onClick={handleSaveAsSmartFolder}
                className="text-text-tertiary hover:text-accent transition-colors"

              >
                <FolderPlus size={14} />
              </button></Tooltip>
            )}
            <button
              onClick={handleClear}
              aria-label="Clear search"
              className="text-text-tertiary hover:text-text-primary transition-colors"
            >
              <X size={14} />
            </button>
          </div>
        )}
      </div>
      {searchQuery.trim() && (
        <div className="mt-1.5 space-y-1.5">
          <label className="flex items-center gap-2 text-xs text-text-secondary">
            Sort
            <select
              aria-label="Sort search results"
              value={sort}
              onChange={(event) => setSort(event.target.value as typeof sort)}
              className="rounded border border-border-primary bg-bg-primary px-2 py-1 text-text-primary"
            >
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
              <option value="relevance">Relevance</option>
            </select>
          </label>
          <div
            className="flex flex-wrap gap-1"
            role="group"
            aria-label="Search folders"
          >
            {[
              ["current", currentName],
              ["all", "All mail"],
              ["spam", "Spam"],
              ["trash", "Trash"],
              ["everywhere", "All folders"],
            ]
              .filter(([id]) => id !== "all" || activeLabel !== "all")
              .map(([id, name]) => (
                <button
                  key={id}
                  type="button"
                  aria-pressed={scope === id}
                  onClick={() => setScope(id!)}
                  className={`rounded-full px-2 py-0.5 text-xs ${scope === id ? "bg-accent text-white" : "bg-bg-tertiary text-text-secondary hover:bg-bg-hover"}`}
                >
                  {name}
                </button>
              ))}
          </div>
          <div className="flex flex-wrap gap-1" role="group" aria-label="Search filters">
            {searchPresets.map(({ label, token, needsValue }) => {
              const active = presetIsActive(searchQuery, token);
              return (
                <button
                  key={token}
                  type="button"
                  aria-pressed={active}
                  onClick={() => handlePreset(token, needsValue)}
                  className={`rounded-full border px-2 py-0.5 text-xs transition-colors ${active ? "border-accent/40 bg-accent-light text-accent" : "border-border-primary text-text-secondary hover:bg-bg-hover"}`}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </div>
      )}
      {searchQuery && (
        <p role="status" className="text-xs text-text-tertiary mt-1">
          {hasIncompleteOperator(searchQuery)
            ? "Type a value to finish this filter"
            : searching
            ? "Searching…"
            : "Searching downloaded mail • up to 500 message matches"}
        </p>
      )}
      {error && (
        <p role="alert" className="text-xs text-danger mt-1">
          Search failed: {error}
        </p>
      )}
      <InputDialog
        isOpen={showSaveModal}
        onClose={() => setShowSaveModal(false)}
        onSubmit={(values) => {
          useSmartFolderStore
            .getState()
            .createFolder(
              values.name!.trim(),
              useThreadStore.getState().searchQuery.trim(),
              activeAccountId ?? undefined,
            );
        }}
        title="Save as Smart Folder"
        fields={[
          { key: "name", label: "Name", defaultValue: searchQuery.trim() },
        ]}
        submitLabel="Save"
      />
    </div>
  );
}
