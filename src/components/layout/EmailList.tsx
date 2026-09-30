import { useEffect, useCallback, useMemo, useRef, useState } from "react";
import { CSSTransition } from "react-transition-group";
import { ThreadCard } from "../email/ThreadCard";
import { CategoryTabs } from "../email/CategoryTabs";
import { EmailListSkeleton } from "../ui/Skeleton";
import { useThreadStore, type Thread } from "@/stores/threadStore";
import { useAccountStore, listedAccountIds } from "@/stores/accountStore";
import { collectOwnAddresses } from "@/services/accounts/ownAddresses";
import { useUIStore } from "@/stores/uiStore";
import { useActiveLabel, useSelectedThreadId, useActiveCategory } from "@/hooks/useRouteNavigation";
import { navigateToThread, navigateToLabel } from "@/router/navigate";
import { getThreadsForAccounts, getThreadsForCategoryAcrossAccounts, getThreadsByIds, deleteThread as deleteThreadFromDb, mergeThreads } from "@/services/db/threads";
import { getCategoriesForThreads, getCategoryUnreadCounts } from "@/services/db/threadCategories";
import { getTaskThreadIds, getReminderThreadIds } from "@/services/db/tasks";
import { getBundleRules, getHeldThreadIds, getBundleSummaries, type DbBundleRule } from "@/services/db/bundleRules";
import { getGmailClient } from "@/services/gmail/tokenManager";
import { archiveThread, trashThread, permanentDeleteThread, spamThread, runBulkAction, type BulkTarget } from "@/services/emailActions";
import { confirmDelete } from "@/utils/confirmDelete";
import { useLabelStore } from "@/stores/labelStore";
import { useSmartFolderStore } from "@/stores/smartFolderStore";
import { useContextMenuStore } from "@/stores/contextMenuStore";
import { useComposerStore } from "@/stores/composerStore";
import { getMessagesForThread } from "@/services/db/messages";
import { getSmartFolderSearchQuery, mapSmartFolderRows, type SmartFolderRow } from "@/services/search/smartFolderQuery";
import { getDb } from "@/services/db/connection";
import { Archive, Trash2, X, Ban, Filter, ChevronRight, Package, FolderSearch, UserSearch, MailMinus, Check, AlertCircle, Merge } from "lucide-react";
import { getLabelsForThreadPage } from "@/services/db/threads";
import { EmptyState } from "../ui/EmptyState";
import {
  InboxClearIllustration,
  NoSearchResultsIllustration,
  NoAccountIllustration,
  GenericEmptyIllustration,
} from "../ui/illustrations";
import { getListSearchTerms } from "@/utils/searchHighlight";

const PAGE_SIZE = 50;

// Map sidebar labels to Gmail label IDs. An array is one list drawn from
// several labels — the combined view reads a correspondence in order rather
// than making the user alternate between Inbox and Sent.
const LABEL_MAP: Record<string, string | string[]> = {
  inbox: "INBOX",
  conversations: ["INBOX", "SENT"],
  starred: "STARRED",
  sent: "SENT",
  drafts: "DRAFT",
  trash: "TRASH",
  spam: "SPAM",
  snoozed: "SNOOZED",
  all: "", // no filter
};

export function EmailList({ width, listRef }: { width?: number; listRef?: React.Ref<HTMLDivElement> }) {
  const threads = useThreadStore((s) => s.threads);
  const selectedThreadId = useSelectedThreadId();
  const selectedThreadIds = useThreadStore((s) => s.selectedThreadIds);
  const isLoading = useThreadStore((s) => s.isLoading);
  const setThreads = useThreadStore((s) => s.setThreads);
  const setLoading = useThreadStore((s) => s.setLoading);
  const clearMultiSelect = useThreadStore((s) => s.clearMultiSelect);
  const selectAll = useThreadStore((s) => s.selectAll);
  const activeAccountId = useAccountStore((s) => s.activeAccountId);
  const accounts = useAccountStore((s) => s.accounts);
  const unifiedInbox = useAccountStore((s) => s.unifiedInbox);
  // Which mailboxes this list draws from — every active one when unified.
  const accountIds = useMemo(
    () => listedAccountIds({ accounts, activeAccountId, unifiedInbox }),
    [accounts, activeAccountId, unifiedInbox],
  );
  const accountScopeKey = accountIds.join(",");

  // Addresses belonging to the user, so the list can show who replied rather
  // than the user's own address on threads they started.
  const [ownAddresses, setOwnAddresses] = useState<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    collectOwnAddresses(accounts, accountIds).then((addresses) => {
      if (!cancelled) setOwnAddresses(addresses);
    });
    return () => { cancelled = true; };
  }, [accounts, accountScopeKey]);
  const ownAddressKey = ownAddresses.join(",");
  const activeLabel = useActiveLabel();
  const readFilter = useUIStore((s) => s.readFilter);
  const setReadFilter = useUIStore((s) => s.setReadFilter);
  const readingPanePosition = useUIStore((s) => s.readingPanePosition);
  const userLabels = useLabelStore((s) => s.labels);
  const smartFolders = useSmartFolderStore((s) => s.folders);

  // Detect smart folder mode
  const isSmartFolder = activeLabel.startsWith("smart-folder:");
  const smartFolderId = isSmartFolder ? activeLabel.replace("smart-folder:", "") : null;
  const activeSmartFolder = smartFolderId ? smartFolders.find((f) => f.id === smartFolderId) ?? null : null;

  const inboxViewMode = useUIStore((s) => s.inboxViewMode);
  const routerCategory = useActiveCategory();

  // In split mode, use the router's category; in unified mode, always use "All"
  const activeCategory = inboxViewMode === "split" ? routerCategory : "All";
  const setActiveCategory = inboxViewMode === "split"
    ? (cat: string) => navigateToLabel("inbox", { category: cat })
    : () => {};

  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const [categoryMap, setCategoryMap] = useState<Map<string, string>>(() => new Map());
  const [categoryUnreadCounts, setCategoryUnreadCounts] = useState<Map<string, number>>(() => new Map());
  const [followUpThreadIds, setFollowUpThreadIds] = useState<Set<string>>(() => new Set());
  const [taskThreadIds, setTaskThreadIds] = useState<Set<string>>(() => new Set());
  const [bundleRules, setBundleRules] = useState<DbBundleRule[]>([]);
  const [heldThreadIds, setHeldThreadIds] = useState<Set<string>>(() => new Set());
  const [expandedBundles, setExpandedBundles] = useState<Set<string>>(() => new Set());
  const [bundleSummaries, setBundleSummaries] = useState<Map<string, { count: number; latestSubject: string | null; latestSender: string | null }>>(() => new Map());
  const [inboxFocus, setInboxFocus] = useState<"all" | "important">("all");

  const openMenu = useContextMenuStore((s) => s.openMenu);
  const multiSelectCount = selectedThreadIds.size;

  const openComposer = useComposerStore((s) => s.openComposer);
  const multiSelectBarRef = useRef<HTMLDivElement>(null);

  // Quick actions next to the search box, acting on the selected thread
  const selectedThread = selectedThreadId
    ? threads.find((t) => t.id === selectedThreadId) ?? null
    : null;
  const [unsubStatus, setUnsubStatus] = useState<"idle" | "loading" | "done" | "failed" | "none">("idle");
  const unsubResetRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // A different selection means a different unsubscribe target
  useEffect(() => {
    setUnsubStatus("idle");
    if (unsubResetRef.current) clearTimeout(unsubResetRef.current);
  }, [selectedThreadId]);

  const handleShowAllFromSender = useCallback(async () => {
    const sender = selectedThread?.fromAddress;
    if (!sender) return;
    const query = `from:${sender}`;
    const { searchQuery, setSearch, clearSearch } = useThreadStore.getState();
    // Clicking again reverses the search and returns to the mailbox view
    if (searchQuery === query) {
      clearSearch();
      return;
    }
    setSearch(query, new Set());
  }, [selectedThread, activeAccountId, unifiedInbox]);

  const handleQuickUnsubscribe = useCallback(async () => {
    if (!selectedThread || unsubStatus === "loading" || unsubStatus === "done") return;
    const threadAccountId = selectedThread.accountId || activeAccountId;
    if (!threadAccountId) return;

    setUnsubStatus("loading");
    try {
      const messages = await getMessagesForThread(threadAccountId, selectedThread.id);
      const target = [...messages].reverse().find((m) => m.list_unsubscribe);
      if (!target?.list_unsubscribe) {
        setUnsubStatus("none");
        unsubResetRef.current = setTimeout(() => setUnsubStatus("idle"), 2500);
        return;
      }
      const { executeUnsubscribe } = await import("@/services/unsubscribe/unsubscribeManager");
      const result = await executeUnsubscribe(
        threadAccountId,
        selectedThread.id,
        target.from_address ?? "unknown",
        target.from_name,
        target.list_unsubscribe,
        target.list_unsubscribe_post,
      );
      setUnsubStatus(result.success ? "done" : "failed");
    } catch (err) {
      console.error("Quick unsubscribe failed:", err);
      setUnsubStatus("failed");
    }
  }, [selectedThread, activeAccountId, unsubStatus]);

  const handleThreadContextMenu = useCallback((e: React.MouseEvent, threadId: string) => {
    e.preventDefault();
    openMenu("thread", { x: e.clientX, y: e.clientY }, { threadId });
  }, [openMenu]);

  const handleDraftClick = useCallback(async (thread: Thread) => {
    // In the unified list each thread belongs to its own mailbox
    const threadAccountId = thread.accountId || activeAccountId;
    if (!threadAccountId) return;
    try {
      const messages = await getMessagesForThread(threadAccountId, thread.id);
      // Get the last message (the draft)
      const draftMsg = messages[messages.length - 1];
      if (!draftMsg) return;

      // Look up the Gmail draft ID so auto-save can update the existing draft
      let draftId: string | null = null;
      try {
        const client = await getGmailClient(threadAccountId);
        const drafts = await client.listDrafts();
        const match = drafts.find((d) => d.message.id === draftMsg.id);
        if (match) draftId = match.id;
      } catch {
        // If we can't get draft ID, composer will create a new draft on save
      }

      const to = draftMsg.to_addresses
        ? draftMsg.to_addresses.split(",").map((a) => a.trim()).filter(Boolean)
        : [];
      const cc = draftMsg.cc_addresses
        ? draftMsg.cc_addresses.split(",").map((a) => a.trim()).filter(Boolean)
        : [];
      const bcc = draftMsg.bcc_addresses
        ? draftMsg.bcc_addresses.split(",").map((a) => a.trim()).filter(Boolean)
        : [];

      openComposer({
        mode: "new",
        to,
        cc,
        bcc,
        subject: draftMsg.subject ?? "",
        bodyHtml: draftMsg.body_html ?? draftMsg.body_text ?? "",
        threadId: thread.id,
        draftId,
        // Reopen the draft in the mailbox that holds it, under the identity it
        // was written from
        accountId: threadAccountId,
        fromEmail: draftMsg.from_address,
      });
    } catch (err) {
      console.error("Failed to open draft:", err);
    }
  }, [activeAccountId, openComposer]);

  const handleThreadClick = useCallback((thread: Thread) => {
    // Choosing from the list means following this thread's sender again
    useUIStore.getState().clearPinnedContact();
    if (activeLabel === "drafts") {
      handleDraftClick(thread);
    } else {
      useThreadStore.getState().cacheThread(thread);
      navigateToThread(thread.id);
    }
  }, [activeLabel, handleDraftClick]);

  // A selection can span mailboxes in a unified list, so each thread goes
  // through its own account — and through emailActions, which handles the
  // optimistic row removal, the local DB write and the offline queue.
  const accountForThread = useCallback(
    (id: string): string | null =>
      useThreadStore.getState().threadMap.get(id)?.accountId
      ?? useThreadStore.getState().cachedThreads.get(id)?.accountId
      ?? activeAccountId,
    [activeAccountId],
  );

  const threadById = useCallback(
    (id: string): Thread | undefined =>
      useThreadStore.getState().threadMap.get(id)
      ?? useThreadStore.getState().cachedThreads.get(id),
    [],
  );

  // The selection as (account, thread) pairs — a unified list spans mailboxes
  const selectedTargets = useCallback((): BulkTarget[] => {
    const targets: BulkTarget[] = [];
    for (const threadId of useThreadStore.getState().selectedThreadIds) {
      const accountId = accountForThread(threadId);
      if (accountId) targets.push({ accountId, threadId });
    }
    return targets;
  }, [accountForThread]);

  const handleBulkDelete = async () => {
    if (multiSelectCount === 0) return;
    const isTrashView = activeLabel === "trash";
    const targets = selectedTargets();
    if (!(await confirmDelete(targets.length, isTrashView))) return;
    // Rows fade together and the selection clears at once — the server calls
    // finish in the background
    clearMultiSelect();
    await runBulkAction(
      targets,
      async ({ accountId, threadId }) => {
        if (isTrashView) {
          await permanentDeleteThread(accountId, threadId, []);
          await deleteThreadFromDb(accountId, threadId);
        } else {
          await trashThread(accountId, threadId, []);
        }
      },
      { removes: true },
    );
  };

  const handleBulkArchive = async () => {
    if (multiSelectCount === 0) return;
    const targets = selectedTargets();
    clearMultiSelect();
    await runBulkAction(
      targets,
      ({ accountId, threadId }) => archiveThread(accountId, threadId, []),
      { removes: true },
    );
  };

  // Fold the selected conversations into the oldest of them. Same mailbox
  // only: a thread id, a draft and a send-as address are valid in exactly one
  // account, so a merged row spanning two would break every action on it.
  const mergeableAccountId = useMemo(() => {
    if (multiSelectCount < 2) return null;
    const accountIds = new Set(
      [...selectedThreadIds].map((id) => accountForThread(id)).filter(Boolean),
    );
    return accountIds.size === 1 ? ([...accountIds][0] as string) : null;
  }, [selectedThreadIds, multiSelectCount, accountForThread]);

  const handleMerge = async () => {
    if (!mergeableAccountId) return;
    const ids = [...selectedThreadIds];
    // The oldest keeps the row: a conversation is named by how it started
    const ordered = ids
      .map((id) => threadById(id))
      .filter((t): t is Thread => !!t)
      .sort((a, b) => a.lastMessageAt - b.lastMessageAt);
    const target = ordered[0];
    if (!target) return;
    try {
      await mergeThreads(mergeableAccountId, target.id, ids);
      clearMultiSelect();
      await loadThreads();
      navigateToThread(target.id);
    } catch (err) {
      console.error("Failed to merge conversations:", err);
    }
  };

  const handleBulkSpam = async () => {
    if (multiSelectCount === 0) return;
    const targets = selectedTargets();
    const isSpamView = activeLabel === "spam";
    clearMultiSelect();
    await runBulkAction(
      targets,
      ({ accountId, threadId }) => spamThread(accountId, threadId, [], !isSpamView),
      { removes: true },
    );
  };

  const searchThreadIds = useThreadStore((s) => s.searchThreadIds);
  const searchQuery = useThreadStore((s) => s.searchQuery);
  const searchMatches = useThreadStore((s) => s.searchMatches);
  const searchHighlightTerms = useMemo(
    () => getListSearchTerms(searchQuery),
    [searchQuery],
  );

  const ownAddressSet = useMemo(
    () => new Set(ownAddresses.map((a) => a.toLowerCase())),
    [ownAddressKey], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const mapDbThreads = useCallback(async (dbThreads: Awaited<ReturnType<typeof getThreadsForAccounts>>): Promise<Thread[]> => {
    const pageLabels = await getLabelsForThreadPage(dbThreads);
    return Promise.all(
      dbThreads.map(async (t) => {
        const labelIds = pageLabels.get(JSON.stringify([t.account_id, t.id])) ?? [];
        return {
          id: t.id,
          accountId: t.account_id,
          subject: t.subject,
          snippet: t.snippet,
          lastMessageAt: t.last_message_at ?? 0,
          messageCount: t.message_count,
          isRead: t.is_read === 1,
          isStarred: t.is_starred === 1,
          isPinned: t.is_pinned === 1,
          isMuted: t.is_muted === 1,
          hasAttachments: t.has_attachments === 1,
          labelIds,
          // Prefer whoever replied over the user's own address on a thread
          // they started — the peer is null only when nobody else has written
          fromName: t.peer_address ? (t.peer_name ?? null) : t.from_name,
          fromAddress: t.peer_address ?? t.from_address,
          // from_address is the true last sender, peer_address is whoever
          // last wrote who is not the user — so they differ exactly when the
          // newest message is the user's own
          lastFromMe: !!t.from_address && ownAddressSet.has(t.from_address.toLowerCase()),
        };
      }),
    );
  }, [ownAddressSet]);

  // Search hits can live anywhere in the mailbox, so they are loaded straight
  // from the DB — filtering the currently loaded label page would hide every
  // hit outside it.
  const [searchResults, setSearchResults] = useState<{ ids: Set<string>; threads: Thread[] } | null>(null);
  useEffect(() => {
    if (searchThreadIds === null) {
      setSearchResults(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const rows = await getThreadsByIds(accountIds, [...searchThreadIds], ownAddresses);
        const mapped = await mapDbThreads(rows);
        const order = new Map([...searchThreadIds].map((id, index) => [id, index]));
        mapped.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
        if (cancelled) return;
        // Cache each result so opening one outside the current label works
        const { cacheThread } = useThreadStore.getState();
        mapped.forEach(cacheThread);
        setSearchResults({ ids: searchThreadIds, threads: mapped });
      } catch (err) {
        console.error("Failed to load search results:", err);
        if (!cancelled) setSearchResults({ ids: searchThreadIds, threads: [] });
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchThreadIds, accountScopeKey, ownAddressKey, mapDbThreads]);

  const filteredThreads = useMemo(() => {
    // Never display results belonging to an older query while loading.
    let filtered = searchThreadIds !== null
      ? searchResults?.ids === searchThreadIds ? searchResults.threads : []
      : threads;
    // Apply read filter
    if (searchThreadIds === null && readFilter === "unread") filtered = filtered.filter((t) => !t.isRead);
    else if (searchThreadIds === null && readFilter === "read") filtered = filtered.filter((t) => t.isRead);
    // The top-level inbox choice is deliberately simple: everything, or the
    // conversations the user marked as worth holding on to.
    if (searchThreadIds === null && activeLabel === "inbox" && inboxFocus === "important") {
      filtered = filtered.filter((t) => t.isPinned || t.isStarred);
    }
    // Category filtering is now server-side (Phase 4) — no client-side filter needed
    return filtered;
  }, [threads, readFilter, searchThreadIds, searchResults, activeLabel, inboxFocus]);

  // Pre-compute bundled category Set for O(1) lookups in filter
  const bundledCategorySet = useMemo(
    () => new Set(bundleRules.map((r) => r.category)),
    [bundleRules],
  );

  // Memoize visible threads (excludes bundled/held threads in "All" inbox view)
  const visibleThreads = useMemo(() => {
    // Search results are not a mailbox view — never hide hits behind bundles
    if (searchThreadIds !== null) return filteredThreads;
    if (activeLabel !== "inbox" || activeCategory !== "All") return filteredThreads;
    return filteredThreads.filter((t) => {
      const cat = categoryMap.get(t.id);
      if (cat && bundledCategorySet.has(cat)) return false;
      if (heldThreadIds.has(t.id)) return false;
      return true;
    });
  }, [filteredThreads, searchThreadIds, activeLabel, activeCategory, categoryMap, bundledCategorySet, heldThreadIds]);

  // Selection is made against what is on screen, so the store has to know
  // which rows those are — search hits and filtered views included
  const setVisibleThreadIds = useThreadStore((s) => s.setVisibleThreadIds);
  const visibleIdKey = visibleThreads.map((t) => t.id).join(",");
  useEffect(() => {
    setVisibleThreadIds(visibleIdKey ? visibleIdKey.split(",") : []);
  }, [visibleIdKey, setVisibleThreadIds]);

  const clearSearch = useThreadStore((s) => s.clearSearch);

  // A search survives every background reload. Only moving to another view
  // ends it — sync finishes every 60s and used to wipe the box mid-read.
  useEffect(() => {
    clearSearch();
  }, [accountScopeKey, activeLabel, activeCategory, clearSearch]);

  const loadThreads = useCallback(async () => {
    if (accountIds.length === 0) {
      setThreads([]);
      return;
    }

    setLoading(true);
    setHasMore(true);
    try {
      // Smart folder query path — smart folders are saved per account, so this
      // view stays scoped to the active one even in the unified list.
      if (isSmartFolder && activeSmartFolder && activeAccountId) {
        const { sql, params } = getSmartFolderSearchQuery(
          activeSmartFolder.query,
          activeAccountId,
          PAGE_SIZE,
        );
        const db = await getDb();
        const rows = await db.select<SmartFolderRow[]>(sql, params);
        const mapped = await mapSmartFolderRows(rows);
        setThreads(mapped);
        setHasMore(false); // Smart folders load all at once
      } else {
        let dbThreads;
        // Server-side category filtering for inbox
        if (activeLabel === "inbox" && activeCategory !== "All") {
          dbThreads = await getThreadsForCategoryAcrossAccounts(
            accountIds,
            activeCategory,
            PAGE_SIZE,
            0,
            ownAddresses,
          );
        } else {
          const gmailLabelId = LABEL_MAP[activeLabel] ?? activeLabel;
          dbThreads = await getThreadsForAccounts(
            accountIds,
            gmailLabelId.length === 0 ? undefined : gmailLabelId,
            PAGE_SIZE,
            0,
            ownAddresses,
          );
        }

        const mapped = await mapDbThreads(dbThreads);
        setThreads(mapped);
        setHasMore(dbThreads.length === PAGE_SIZE);
      }
    } catch (err) {
      console.error("Failed to load threads:", err);
    } finally {
      setLoading(false);
    }
  }, [activeAccountId, accountScopeKey, ownAddressKey, activeLabel, activeCategory, isSmartFolder, activeSmartFolder, setThreads, setLoading, mapDbThreads]);

  const loadMore = useCallback(async () => {
    if (accountIds.length === 0 || loadingMore || !hasMore) return;

    setLoadingMore(true);
    try {
      const offset = threads.length;
      let dbThreads;
      if (activeLabel === "inbox" && activeCategory !== "All") {
        dbThreads = await getThreadsForCategoryAcrossAccounts(
          accountIds,
          activeCategory,
          PAGE_SIZE,
          offset,
          ownAddresses,
        );
      } else {
        const gmailLabelId = LABEL_MAP[activeLabel] ?? activeLabel;
        dbThreads = await getThreadsForAccounts(
          accountIds,
          gmailLabelId.length === 0 ? undefined : gmailLabelId,
          PAGE_SIZE,
          offset,
          ownAddresses,
        );
      }

      const mapped = await mapDbThreads(dbThreads);
      if (mapped.length > 0) {
        setThreads([...threads, ...mapped]);
      }
      setHasMore(dbThreads.length === PAGE_SIZE);
    } catch (err) {
      console.error("Failed to load more threads:", err);
    } finally {
      setLoadingMore(false);
    }
  }, [accountScopeKey, ownAddressKey, activeLabel, activeCategory, threads, loadingMore, hasMore, setThreads, mapDbThreads]);

  useEffect(() => {
    loadThreads();
  }, [loadThreads]);

  // Stable thread ID key — only changes when the actual set of thread IDs changes, not on every array reference
  const threadIdKey = useMemo(() => threads.map((t) => t.id).join(","), [threads]);

  // Load all thread metadata (categories, unread counts, follow-ups, bundles) in one coordinated effect
  useEffect(() => {
    let cancelled = false;

    if (!activeAccountId) {
      setCategoryMap(new Map());
      setCategoryUnreadCounts(new Map());
      setFollowUpThreadIds(new Set());
      setTaskThreadIds(new Set());
      setBundleRules([]);
      setHeldThreadIds(new Set());
      setBundleSummaries(new Map());
      return;
    }

    const threadIds = threadIdKey ? threadIdKey.split(",") : [];
    const isInbox = activeLabel === "inbox";
    const isAllCategory = activeCategory === "All";

    const loadMetadata = async () => {
      try {
        // Build all promises based on current view
        const promises: Promise<void>[] = [];

        // Categories (only for inbox "All" tab with threads)
        if (isInbox && isAllCategory && threadIds.length > 0) {
          promises.push(
            getCategoriesForThreads(activeAccountId, threadIds).then((result) => {
              if (!cancelled) setCategoryMap(result);
            }),
          );
        } else {
          setCategoryMap(new Map());
        }

        // Unread counts (only for inbox)
        if (isInbox) {
          promises.push(
            getCategoryUnreadCounts(activeAccountId).then((result) => {
              if (!cancelled) setCategoryUnreadCounts(result);
            }),
          );
        } else {
          setCategoryUnreadCounts(new Map());
        }

        // Follow-up bells, read from the reminder tasks so a unified list
        // shows them for every mailbox rather than only the active one
        if (threadIds.length > 0) {
          promises.push(
            getReminderThreadIds(accountIds).then((result) => {
              if (!cancelled) setFollowUpThreadIds(result);
            }).catch(() => {
              if (!cancelled) setFollowUpThreadIds(new Set());
            }),
          );
        } else {
          setFollowUpThreadIds(new Set());
        }

        // Task indicators — threads with an open task linked
        if (threadIds.length > 0) {
          promises.push(
            getTaskThreadIds(accountIds, threadIds).then((result) => {
              if (!cancelled) setTaskThreadIds(result);
            }).catch(() => {
              if (!cancelled) setTaskThreadIds(new Set());
            }),
          );
        } else {
          setTaskThreadIds(new Set());
        }

        // Bundle rules + held threads (only for inbox)
        if (isInbox) {
          promises.push(
            getBundleRules(activeAccountId).then(async (rules) => {
              if (cancelled) return;
              const bundled = rules.filter((r) => r.is_bundled);
              setBundleRules(bundled);
              // Batch-fetch all summaries in 2 queries instead of 2N
              if (bundled.length > 0) {
                const summaries = await getBundleSummaries(activeAccountId, bundled.map((r) => r.category)).catch(() => new Map());
                if (!cancelled) setBundleSummaries(summaries);
              } else {
                if (!cancelled) setBundleSummaries(new Map());
              }
            }).catch(() => {
              if (!cancelled) setBundleRules([]);
            }),
          );
          promises.push(
            getHeldThreadIds(activeAccountId).then((result) => {
              if (!cancelled) setHeldThreadIds(result);
            }).catch(() => {
              if (!cancelled) setHeldThreadIds(new Set());
            }),
          );
        } else {
          setBundleRules([]);
          setHeldThreadIds(new Set());
          setBundleSummaries(new Map());
        }

        await Promise.all(promises);
      } catch (err) {
        console.error("Failed to load thread metadata:", err);
      }
    };

    loadMetadata();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadIdKey, activeLabel, activeCategory, activeAccountId, accountScopeKey]);

  // Auto-scroll selected thread into view (triggered by keyboard navigation)
  useEffect(() => {
    if (!selectedThreadId || !scrollContainerRef.current) return;
    const el = scrollContainerRef.current.querySelector(`[data-thread-id="${CSS.escape(selectedThreadId)}"]`);
    if (el) {
      el.scrollIntoView({ block: "nearest" });
    }
  }, [selectedThreadId]);

  // Listen for sync completion to reload (debounced to avoid waterfall from multiple emitters)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const handler = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => loadThreads(), 500);
    };
    window.addEventListener("sndmail-sync-done", handler);
    return () => {
      window.removeEventListener("sndmail-sync-done", handler);
      if (timer) clearTimeout(timer);
    };
  }, [loadThreads, accountScopeKey, activeLabel]);

  // A merge removes a row from every list it appeared in
  useEffect(() => {
    const handler = () => { loadThreads(); };
    window.addEventListener("sndmail-threads-merged", handler);
    return () => window.removeEventListener("sndmail-threads-merged", handler);
  }, [loadThreads]);

  // A long initial sync stores threads as it goes; surface them while it runs
  // rather than leaving the list empty. Skipped during a search, since reloading
  // the label view would drop the user's results mid-typing.
  useEffect(() => {
    const handler = () => {
      if (useThreadStore.getState().searchThreadIds !== null) return;
      loadThreads();
    };
    window.addEventListener("sndmail-sync-progress", handler);
    return () => window.removeEventListener("sndmail-sync-progress", handler);
  }, [loadThreads]);

  // Infinite scroll: load more when near bottom
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = container;
      if (scrollHeight - scrollTop - clientHeight < 200) {
        loadMore();
      }
    };

    container.addEventListener("scroll", handleScroll, { passive: true });
    return () => container.removeEventListener("scroll", handleScroll);
  }, [loadMore]);

  return (
    <div
      ref={listRef}
      className={`flex flex-col bg-bg-primary ${
        readingPanePosition === "right"
          ? "min-w-[240px] shrink-0 border-r border-border-secondary"
          : readingPanePosition === "bottom"
            ? "w-full border-b border-border-secondary h-[40%] min-h-[200px]"
            : "w-full flex-1"
      }`}
      style={readingPanePosition === "right" && width ? { width } : undefined}
    >
      {/* Header */}
      <div className="px-3 py-2 flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-text-primary capitalize flex items-center gap-1.5">
            {isSmartFolder && <FolderSearch size={14} className="text-accent shrink-0" />}
            {searchThreadIds !== null
              ? "Search results"
              : isSmartFolder
                ? activeSmartFolder?.name ?? "Smart Folder"
                : activeLabel === "inbox" && inboxViewMode === "split" && activeCategory !== "All"
                  ? `Inbox — ${activeCategory}`
                  : LABEL_MAP[activeLabel] !== undefined
                    ? activeLabel
                    : userLabels.find((l) => l.id === activeLabel)?.name ?? activeLabel}
          </h2>
          <span className="text-xs text-text-tertiary">
            {filteredThreads.length} conversation{filteredThreads.length !== 1 ? "s" : ""}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            onClick={handleShowAllFromSender}
            disabled={!selectedThread?.fromAddress}
            title={
              selectedThread?.fromAddress && searchQuery === `from:${selectedThread.fromAddress}`
                ? "Clear this search and go back to the mailbox"
                : selectedThread?.fromAddress
                  ? `Show all messages from ${selectedThread.fromAddress}`
                  : "Select a thread to search by its sender"
            }
            className={`rounded-lg p-1.5 transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
              selectedThread?.fromAddress && searchQuery === `from:${selectedThread.fromAddress}`
                ? "bg-accent/10 text-accent hover:bg-accent/20"
                : "text-text-tertiary hover:bg-bg-hover hover:text-text-primary"
            }`}
          >
            <UserSearch size={15} />
          </button>
          <button
            onClick={handleQuickUnsubscribe}
            disabled={!selectedThread}
            title={
              unsubStatus === "done"
                ? "Unsubscribed"
                : unsubStatus === "none"
                  ? "No unsubscribe link in this thread"
                  : unsubStatus === "failed"
                    ? "Unsubscribe failed — click to retry"
                    : selectedThread
                      ? "Unsubscribe from this sender"
                      : "Select a thread to unsubscribe"
            }
            className={`rounded-lg p-1.5 transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
              unsubStatus === "done"
                ? "text-success"
                : unsubStatus === "failed" || unsubStatus === "none"
                  ? "text-danger"
                  : "text-text-tertiary hover:bg-bg-hover hover:text-text-primary"
            }`}
          >
            {unsubStatus === "done" ? (
              <Check size={15} />
            ) : unsubStatus === "none" ? (
              <AlertCircle size={15} />
            ) : (
              <MailMinus size={15} className={unsubStatus === "loading" ? "animate-pulse" : ""} />
            )}
          </button>
          {activeLabel === "inbox" && searchThreadIds === null ? (
          <div className="flex items-center rounded-full bg-bg-tertiary/80 p-1 shadow-[inset_0_1px_1px_rgba(80,66,50,0.06)]">
            <button
              onClick={() => setInboxFocus("all")}
              aria-pressed={inboxFocus === "all"}
              className={`rounded-full px-2.5 py-1 text-xs font-medium transition-colors ${
                inboxFocus === "all" ? "bg-bg-primary text-text-primary shadow-sm" : "text-text-tertiary hover:text-text-secondary"
              }`}
            >
              All
            </button>
            <button
              onClick={() => setInboxFocus("important")}
              aria-pressed={inboxFocus === "important"}
              className={`rounded-full px-2.5 py-1 text-xs font-medium transition-colors ${
                inboxFocus === "important" ? "bg-bg-primary text-text-primary shadow-sm" : "text-text-tertiary hover:text-text-secondary"
              }`}
            >
              Important
            </button>
          </div>
          ) : (
          <select
            value={readFilter}
            onChange={(e) => setReadFilter(e.target.value as "all" | "read" | "unread")}
            className="text-xs bg-bg-tertiary text-text-secondary px-2 py-1 rounded-full border-0"
          >
            <option value="all">All</option>
            <option value="unread">Unread</option>
            <option value="read">Read</option>
          </select>
          )}
        </div>
      </div>

      {/* Category tabs (inbox + split mode only) */}
      {activeLabel === "inbox" && inboxViewMode === "split" && (
        <CategoryTabs
          activeCategory={activeCategory}
          onCategoryChange={setActiveCategory}
          unreadCounts={Object.fromEntries(categoryUnreadCounts)}
        />
      )}

      {/* Multi-select action bar */}
      <CSSTransition nodeRef={multiSelectBarRef} in={multiSelectCount > 0} timeout={150} classNames="slide-down" unmountOnExit>
        <div ref={multiSelectBarRef} className="px-3 py-2 border-b border-border-primary bg-accent/5 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-text-primary">
              {multiSelectCount} selected
            </span>
            {multiSelectCount < visibleThreads.length && (
              <button
                onClick={selectAll}
                className="text-xs text-accent hover:text-accent-hover transition-colors"
              >
                Select all
              </button>
            )}
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={handleBulkArchive}
              title="Archive selected"
              className="p-1.5 text-text-secondary hover:text-text-primary hover:bg-bg-hover rounded transition-colors"
            >
              <Archive size={14} />
            </button>
            <button
              onClick={handleBulkDelete}
              title="Delete selected"
              className="p-1.5 text-text-secondary hover:text-error hover:bg-bg-hover rounded transition-colors"
            >
              <Trash2 size={14} />
            </button>
            {mergeableAccountId && (
              <button
                onClick={handleMerge}
                title="Merge into one conversation"
                className="p-1.5 text-text-secondary hover:text-accent hover:bg-bg-hover rounded transition-colors"
              >
                <Merge size={14} />
              </button>
            )}
            <button
              onClick={handleBulkSpam}
              title={activeLabel === "spam" ? "Not spam" : "Report spam"}
              className="p-1.5 text-text-secondary hover:text-text-primary hover:bg-bg-hover rounded transition-colors"
            >
              <Ban size={14} />
            </button>
            <button
              onClick={clearMultiSelect}
              title="Clear selection"
              className="p-1.5 text-text-secondary hover:text-text-primary hover:bg-bg-hover rounded transition-colors"
            >
              <X size={14} />
            </button>
          </div>
        </div>
      </CSSTransition>

      {/* Thread list */}
      <div ref={scrollContainerRef} className="flex-1 overflow-y-auto py-1.5">
        {isLoading && threads.length === 0 ? (
          <EmailListSkeleton />
        ) : filteredThreads.length === 0 && bundleRules.length === 0 ? (
          <EmptyStateForContext
            searchQuery={searchQuery}
            activeAccountId={activeAccountId}
            activeLabel={activeLabel}
            readFilter={readFilter}
            activeCategory={activeCategory}
          />
        ) : (
          <>
            {/* Bundle rows for "All" inbox view */}
            {activeLabel === "inbox" && activeCategory === "All" && bundleRules.map((rule) => {
              const summary = bundleSummaries.get(rule.category);
              if (!summary || summary.count === 0) return null;
              const isExpanded = expandedBundles.has(rule.category);
              const bundledThreads = isExpanded
                ? filteredThreads.filter((t) => categoryMap.get(t.id) === rule.category)
                : [];
              return (
                <div key={`bundle-${rule.category}`}>
                  <button
                    onClick={() => {
                      setExpandedBundles((prev) => {
                        const next = new Set(prev);
                        if (next.has(rule.category)) next.delete(rule.category);
                        else next.add(rule.category);
                        return next;
                      });
                    }}
                    className="w-full text-left px-4 py-3 border-b border-border-secondary hover:bg-bg-hover transition-colors flex items-center gap-3"
                  >
                    <div className="w-9 h-9 rounded-full bg-accent/15 flex items-center justify-center shrink-0">
                      <Package size={16} className="text-accent" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-text-primary">
                          {rule.category}
                        </span>
                        <span className="text-xs bg-accent/15 text-accent px-1.5 rounded-full">
                          {summary.count}
                        </span>
                      </div>
                      <span className="text-xs text-text-tertiary truncate block mt-0.5">
                        {summary.latestSender && `${summary.latestSender}: `}{summary.latestSubject ?? ""}
                      </span>
                    </div>
                    <ChevronRight
                      size={14}
                      className={`text-text-tertiary transition-transform shrink-0 ${isExpanded ? "rotate-90" : ""}`}
                    />
                  </button>
                  {isExpanded && bundledThreads.map((thread) => (
                    <div key={thread.id} className="pl-4">
                      <ThreadCard
                        thread={thread}
                        isSelected={thread.id === selectedThreadId}
                        onClick={handleThreadClick}
                        onContextMenu={handleThreadContextMenu}
                        category={rule.category}
                        hasFollowUp={followUpThreadIds.has(thread.id)}
                        hasTask={taskThreadIds.has(thread.id)}
                      />
                    </div>
                  ))}
                </div>
              );
            })}
            {visibleThreads.map((thread, idx) => {
              const prevThread = idx > 0 ? filteredThreads[idx - 1] : undefined;
              const showDivider = prevThread?.isPinned && !thread.isPinned;
              return (
                <div
                  key={thread.id}
                  data-thread-id={thread.id}
                  className={idx < 15 ? "stagger-in" : undefined}
                  style={idx < 15 ? { animationDelay: `${idx * 30}ms` } : undefined}
                >
                  {showDivider && (
                    <div className="px-4 py-1.5 text-xs font-medium text-text-tertiary uppercase tracking-wider bg-bg-tertiary/50 border-b border-border-secondary">
                      Other emails
                    </div>
                  )}
                  <ThreadCard
                    thread={thread}
                    isSelected={thread.id === selectedThreadId}
                    onClick={handleThreadClick}
                    onContextMenu={handleThreadContextMenu}
                    category={categoryMap.get(thread.id)}
                    showCategoryBadge={activeLabel === "inbox" && activeCategory === "All"}
                    showFolder={searchThreadIds !== null || activeLabel === "all" || isSmartFolder}
                    searchExcerpt={searchMatches.get(thread.id)?.excerpt}
                    highlightTerms={searchHighlightTerms}
                    hasFollowUp={followUpThreadIds.has(thread.id)}
                    hasTask={taskThreadIds.has(thread.id)}
                  />
                </div>
              );
            })}
            {loadingMore && (
              <div className="px-4 py-3 text-center text-xs text-text-tertiary">
                Loading more...
              </div>
            )}
            {!hasMore && threads.length > PAGE_SIZE && (
              <div className="px-4 py-3 text-center text-xs text-text-tertiary">
                All conversations loaded
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function EmptyStateForContext({
  searchQuery,
  activeAccountId,
  activeLabel,
  readFilter,
  activeCategory,
}: {
  searchQuery: string | null;
  activeAccountId: string | null;
  activeLabel: string;
  readFilter: string;
  activeCategory: string;
}) {
  if (searchQuery) {
    return <EmptyState illustration={NoSearchResultsIllustration} title="No results found" subtitle="Try a different search term" />;
  }
  if (readFilter !== "all") {
    return <EmptyState icon={Filter} title={`No ${readFilter} emails`} subtitle="Try changing the filter" />;
  }
  if (!activeAccountId) {
    return <EmptyState illustration={NoAccountIllustration} title="No account connected" subtitle="Add a Gmail account to get started" />;
  }

  switch (activeLabel) {
    case "inbox":
      if (activeCategory !== "All") {
        const categoryMessages: Record<string, { title: string; subtitle: string }> = {
          Primary: { title: "Primary is clear", subtitle: "No important conversations" },
          Updates: { title: "No updates", subtitle: "Notifications and transactional emails appear here" },
          Promotions: { title: "No promotions", subtitle: "Marketing and promotional emails appear here" },
          Social: { title: "No social emails", subtitle: "Social network notifications appear here" },
          Newsletters: { title: "No newsletters", subtitle: "Newsletters and subscriptions appear here" },
        };
        const msg = categoryMessages[activeCategory];
        if (msg) return <EmptyState illustration={InboxClearIllustration} title={msg.title} subtitle={msg.subtitle} />;
      }
      return <EmptyState illustration={InboxClearIllustration} title="You're all caught up" subtitle="No new conversations" />;
    case "starred":
      return <EmptyState illustration={GenericEmptyIllustration} title="No starred conversations" subtitle="Star emails to find them here" />;
    case "snoozed":
      return <EmptyState illustration={GenericEmptyIllustration} title="No snoozed emails" subtitle="Snoozed emails will appear here" />;
    case "sent":
      return <EmptyState illustration={GenericEmptyIllustration} title="No sent messages" />;
    case "drafts":
      return <EmptyState illustration={GenericEmptyIllustration} title="No drafts" />;
    case "trash":
      return <EmptyState illustration={GenericEmptyIllustration} title="Trash is empty" />;
    case "spam":
      return <EmptyState illustration={GenericEmptyIllustration} title="No spam" subtitle="Looking good!" />;
    case "all":
      return <EmptyState illustration={GenericEmptyIllustration} title="No emails yet" />;
    default:
      if (activeLabel.startsWith("smart-folder:")) {
        return <EmptyState icon={FolderSearch} title="No matching emails" subtitle="Try adjusting the smart folder query" />;
      }
      return <EmptyState illustration={GenericEmptyIllustration} title="Nothing here" subtitle="No conversations with this label" />;
  }
}
