import { Sparkles, ChevronDown, ChevronUp, RefreshCw } from "lucide-react";

import { Tooltip } from "@/components/ui/Tooltip";

interface ThreadSummaryProps {
  summary: string | null;
  loading: boolean;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onRefresh: () => void;
}

/**
 * The summary card.
 *
 * It renders state the reading pane owns (`useThreadSummary`) and renders
 * nothing when there is nothing to show — opening a thread never spends an AI
 * call, so the card only exists after the user asked for it or a cached
 * summary was read back.
 */
export function ThreadSummary({ summary, loading, collapsed, onToggleCollapsed, onRefresh }: ThreadSummaryProps) {
  if (!summary && !loading) return null;

  return (
    <div className="mx-4 my-2 p-3 rounded-lg bg-accent/5 border border-accent/20">
      <button
        onClick={onToggleCollapsed}
        className="flex items-center gap-2 w-full text-left"
      >
        <Sparkles size={14} className="text-accent shrink-0" />
        <span className="text-xs font-medium text-accent flex-1">AI Summary</span>
        {summary && (
          <Tooltip content="Refresh summary"><span
            role="button"
            aria-label="Refresh summary"
            tabIndex={0}
            onClick={(e) => { e.stopPropagation(); onRefresh(); }}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); e.preventDefault(); onRefresh(); } }}
            className="p-0.5 text-text-tertiary hover:text-accent transition-colors cursor-pointer"

          >
            <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
          </span></Tooltip>
        )}
        {collapsed ? <ChevronDown size={14} className="text-text-tertiary" /> : <ChevronUp size={14} className="text-text-tertiary" />}
      </button>
      {!collapsed && (
        <div className="mt-2 text-sm text-text-secondary">
          {loading && !summary && (
            <div className="flex items-center gap-2 text-text-tertiary">
              <div className="w-3 h-3 border-2 border-accent/30 border-t-accent rounded-full animate-spin" />
              <span className="text-xs">Generating summary...</span>
            </div>
          )}
          {summary && <p className="text-xs leading-relaxed">{summary}</p>}
        </div>
      )}
    </div>
  );
}
