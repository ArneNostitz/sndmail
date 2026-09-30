import { useCallback, useRef } from "react";
import { EmailList } from "./EmailList";
import { ReadingPane } from "./ReadingPane";
import { useUIStore } from "@/stores/uiStore";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";

function ResizableEmailLayout() {
  const emailListWidth = useUIStore((s) => s.emailListWidth);
  const setEmailListWidth = useUIStore((s) => s.setEmailListWidth);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = listRef.current?.offsetWidth ?? emailListWidth;

    const handleMouseMove = (ev: MouseEvent) => {
      const delta = ev.clientX - startX;
      const newWidth = Math.min(800, Math.max(240, startWidth + delta));
      if (listRef.current) listRef.current.style.width = `${newWidth}px`;
    };

    const handleMouseUp = (ev: MouseEvent) => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      const delta = ev.clientX - startX;
      const finalWidth = Math.min(800, Math.max(240, startWidth + delta));
      setEmailListWidth(finalWidth);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, [emailListWidth, setEmailListWidth]);

  const handleResizeKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const delta = e.key === "ArrowLeft" ? -16 : 16;
    setEmailListWidth(Math.min(800, Math.max(240, emailListWidth + delta)));
  }, [emailListWidth, setEmailListWidth]);

  return (
    <div ref={containerRef} className="workspace-canvas flex flex-1 min-w-0 flex-row">
      <EmailList width={emailListWidth} listRef={listRef} />
      <div
        onMouseDown={handleMouseDown}
        onKeyDown={handleResizeKeyDown}
        tabIndex={0}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize message list"
        className="w-1 cursor-col-resize bg-transparent hover:bg-border-primary active:bg-text-tertiary transition-colors shrink-0"
      />
      <ReadingPane />
    </div>
  );
}

export function MailLayout() {
  const readingPanePosition = useUIStore((s) => s.readingPanePosition);

  if (readingPanePosition === "right") {
    return (
      <ErrorBoundary name="EmailLayout">
        <ResizableEmailLayout />
      </ErrorBoundary>
    );
  }

  return (
    <div className={`workspace-canvas flex flex-1 min-w-0 ${readingPanePosition === "bottom" ? "flex-col" : "flex-row"}`}>
      <ErrorBoundary name="EmailList">
        <EmailList />
      </ErrorBoundary>
      {readingPanePosition !== "hidden" && (
        <ErrorBoundary name="ReadingPane">
          <ReadingPane />
        </ErrorBoundary>
      )}
    </div>
  );
}
