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
    let latestX = startX;
    let frame = 0;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      latestX = moveEvent.clientX;
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const nextWidth = Math.min(400, Math.max(200, startWidth + startX - latestX));
        if (paneRef.current) paneRef.current.style.width = `${nextWidth}px`;
      });
    };

    const handleMouseUp = (upEvent: MouseEvent) => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      if (frame) cancelAnimationFrame(frame);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      const nextWidth = Math.min(400, Math.max(200, startWidth + startX - upEvent.clientX));
      if (paneRef.current) paneRef.current.style.width = `${nextWidth}px`;
      setWidth(nextWidth);
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
    <div
      ref={paneRef}
      id="details-pane"
      style={{ width }}
      className="group absolute inset-y-0 right-0 z-20 h-full shrink-0 border-l border-border-secondary bg-bg-primary shadow-xl group-hover:border-l-text-tertiary @[640px]:relative @[640px]:inset-auto @[640px]:z-auto @[640px]:shadow-none"
    >
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
        className="absolute inset-y-0 left-[-8.5px] z-10 flex w-4 cursor-col-resize items-stretch justify-center bg-transparent outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-text-tertiary"
      />
      <div className="h-full w-full min-w-0 overflow-hidden">
        {children}
      </div>
    </div>
  );
}
