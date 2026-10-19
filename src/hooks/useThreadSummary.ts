import { useCallback, useEffect, useRef, useState } from "react";
import { isAiAvailable } from "@/services/ai/providerManager";
import { summarizeThread } from "@/services/ai/aiService";
import { deleteAiCache, getAiCache } from "@/services/db/aiCache";
import { reportError } from "@/stores/toastStore";
import { navigateToSettings } from "@/router/navigate";
import type { DbMessage } from "@/services/db/messages";

/** What the `z` shortcut fires; the open reading pane answers it. */
export const SUMMARIZE_THREAD_EVENT = "sndmail-summarize-thread";

interface UseThreadSummaryArgs {
  threadId: string;
  accountId: string | null;
  messages: DbMessage[];
}

export interface ThreadSummaryControl {
  /** A provider is configured and there is more than one message to read. */
  canRequest: boolean;
  summary: string | null;
  loading: boolean;
  collapsed: boolean;
  /** The explicit call: summarise, or reveal what is already cached. */
  request: () => void;
  /** Throw the cached summary away and generate it again. */
  refresh: () => void;
  toggleCollapsed: () => void;
}

/**
 * Thread summaries, on demand.
 *
 * Opening a thread reads only the `ai_cache` row, so a summary made earlier
 * comes back instantly and one that was never made costs nothing until the
 * user asks for it. A model call happens in exactly two places: the
 * "Summarize" button and the `z` shortcut — both land here.
 */
export function useThreadSummary({ threadId, accountId, messages }: UseThreadSummaryArgs): ThreadSummaryControl {
  const [available, setAvailable] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  // A ref, not the state, so two presses in the same tick cannot both pass.
  const loadingRef = useRef(false);

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    isAiAvailable()
      .then((value) => { if (!cancelled) setAvailable(value); })
      .catch(() => { if (!cancelled) setAvailable(false); });
    return () => { cancelled = true; };
  }, [accountId]);

  // A summary generated earlier is shown at once — no provider call, and
  // nothing here ever writes one.
  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    setSummary(null);
    getAiCache(accountId, threadId, "summary")
      .then((cached) => { if (!cancelled && cached) setSummary(cached); })
      .catch((err) => console.error("Could not read the cached summary:", err));
    return () => { cancelled = true; };
  }, [accountId, threadId]);

  const runSummary = useCallback(async () => {
    if (!accountId || loadingRef.current) return;
    // The provider may have been configured since this thread was opened.
    if (!available && !(await isAiAvailable().catch(() => false))) {
      reportError("Summaries need an AI provider", undefined, {
        label: "Open AI settings",
        run: () => navigateToSettings("ai"),
      });
      return;
    }
    loadingRef.current = true;
    setLoading(true);
    setCollapsed(false);
    try {
      setSummary(await summarizeThread(threadId, accountId, messages));
    } catch (err) {
      reportError("Could not summarize this conversation", err, {
        label: "Open AI settings",
        run: () => navigateToSettings("ai"),
      });
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, [accountId, available, threadId, messages]);

  const request = useCallback(() => {
    // Already generated: the call is spent, so this only brings it back into
    // view — asking again would bill the user for the same text.
    if (summary !== null) {
      setCollapsed(false);
      return;
    }
    void runSummary();
  }, [summary, runSummary]);

  const refresh = useCallback(async () => {
    if (!accountId) return;
    try {
      await deleteAiCache(accountId, threadId, "summary");
    } catch (err) {
      console.error("Could not drop the cached summary:", err);
    }
    await runSummary();
  }, [accountId, threadId, runSummary]);

  const toggleCollapsed = useCallback(() => setCollapsed((value) => !value), []);

  useEffect(() => {
    const handler = () => request();
    window.addEventListener(SUMMARIZE_THREAD_EVENT, handler);
    return () => window.removeEventListener(SUMMARIZE_THREAD_EVENT, handler);
  }, [request]);

  return {
    canRequest: available && messages.length >= 2 && !!accountId,
    summary,
    loading,
    collapsed,
    request,
    refresh,
    toggleCollapsed,
  };
}
