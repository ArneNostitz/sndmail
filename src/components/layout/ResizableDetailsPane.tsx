import { useCallback, useRef, type ReactNode } from "react";
import { useUIStore } from "@/stores/uiStore";

interface ResizableDetailsPaneProps {
  children: ReactNode;
}

export function ResizableDetailsPane({ children }: ResizableDetailsPaneProps) {
  const width = useUIStore((s) => s.detailsPaneWidth);
  const setWidth = useUIStore((s) => s.setDetailsPaneWidth);
  const paneRef = useRef<HTMLDivElement | null>(null);

  const handleMouseDown = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = paneRef.current?.offsetWidth ?? width;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const nextWidth = Math.min(400, Math.max(200, startWidth + startX - moveEvent.clientX));
      if (paneRef.current) paneRef.current.style.width = `${nextWidth}px`;
    };

    const handleMouseUp = (upEvent: MouseEvent) => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      setWidth(Math.min(400, Math.max(200, startWidth + startX - upEvent.clientX)));
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }, [setWidth, width]);

  const handleKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      setWidth(width + 16);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      setWidth(width - 16);
    }
  }, [setWidth, width]);

  return (
    <div className="absolute inset-y-0 right-0 z-20 flex h-full shrink-0 shadow-xl @[640px]:relative @[640px]:inset-auto @[640px]:z-auto @[640px]:shadow-none">
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize details pane"
        aria-valuemin={200}
        aria-valuemax={400}
        aria-valuenow={width}
        tabIndex={0}
        onMouseDown={handleMouseDown}
        onKeyDown={handleKeyDown}
        className="group flex w-2 shrink-0 cursor-col-resize items-center justify-center outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-text-tertiary"
      >
        <span className="h-full w-px bg-transparent transition-colors group-hover:bg-border-primary group-active:bg-text-tertiary" />
      </div>
      <div
        ref={paneRef}
        id="details-pane"
        style={{ width }}
        className="h-full min-w-0 shrink-0 overflow-hidden border-l border-border-secondary bg-bg-primary"
      >
        {children}
      </div>
    </div>
  );
}
