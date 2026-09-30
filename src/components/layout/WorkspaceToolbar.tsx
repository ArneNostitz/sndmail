import { ChevronRight, Plus } from "lucide-react";
import { AccountSwitcher } from "../accounts/AccountSwitcher";
import { useComposerStore } from "@/stores/composerStore";
import { useHistoryNav } from "@/hooks/useHistoryNav";
import { SearchBar } from "../search/SearchBar";
import { WindowControls } from "./TitleBar";

interface WorkspaceToolbarProps {
  onAddAccount: () => void;
}

/**
 * The window controls and primary mailbox controls share one unobtrusive
 * canvas-level bar. Mail navigation itself remains in the left rail.
 */
export function WorkspaceToolbar({ onAddAccount }: WorkspaceToolbarProps) {
  const openComposer = useComposerStore((s) => s.openComposer);
  const { back, forward, canGoBack } = useHistoryNav();

  return (
    <header className="workspace-toolbar flex h-12 shrink-0 items-center gap-2 px-3" data-tauri-drag-region>
      <div className="shrink-0" data-tauri-drag-region>
        <WindowControls />
      </div>
      <div className="w-52 shrink-0">
        <AccountSwitcher collapsed={false} onAddAccount={onAddAccount} />
      </div>
      <button
        onClick={() => openComposer()}
        className="toolbar-compose interactive-btn flex shrink-0 items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium"
      >
        <Plus size={16} />
        Compose
      </button>
      <div className="flex shrink-0 items-center gap-0.5">
        <button
          onClick={back}
          disabled={!canGoBack}
          title="Back"
          className="toolbar-icon-button"
        >
          <ChevronRight size={17} className="rotate-180" />
        </button>
        <button onClick={forward} title="Forward" className="toolbar-icon-button">
          <ChevronRight size={17} />
        </button>
      </div>
      <div className="min-w-0 max-w-xl flex-1" data-tauri-drag-region={undefined}>
        <SearchBar />
      </div>
    </header>
  );
}
