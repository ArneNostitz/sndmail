import { useState, useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Minus, Square, X, Copy } from "lucide-react";
import { useHistoryNav } from "@/hooks/useHistoryNav";

const isMac = navigator.userAgent.includes("Macintosh");

export function WindowControls() {
  const [maximized, setMaximized] = useState(false);
  const { back, forward, canGoBack } = useHistoryNav();

  useEffect(() => {
    const appWindow = getCurrentWindow();
    appWindow.isMaximized().then(setMaximized);

    // Listen for resize events to track maximize state
    let unlisten: (() => void) | undefined;
    appWindow.onResized(() => {
      appWindow.isMaximized().then(setMaximized);
    }).then((fn) => { unlisten = fn; });

    return () => { unlisten?.(); };
  }, []);

  const handleMinimize = () => getCurrentWindow().minimize();
  const handleMaximize = () => getCurrentWindow().toggleMaximize();
  const handleClose = () => getCurrentWindow().close();

  return (
    <div
      data-tauri-drag-region
      className={`flex h-9 items-center justify-center gap-2 select-none ${isMac ? "w-[4.5rem]" : ""}`}
      aria-label="Window controls"
    >
      {!isMac && (
        <>
          <button onClick={handleClose} title="Close" className="window-light window-light-close" aria-label="Close window">
            <X size={9} />
          </button>
          <button onClick={handleMinimize} title="Minimize" className="window-light window-light-minimize" aria-label="Minimize window">
            <Minus size={9} />
          </button>
          <button onClick={handleMaximize} title={maximized ? "Restore" : "Maximize"} className="window-light window-light-maximize" aria-label={maximized ? "Restore window" : "Maximize window"}>
            {maximized ? <Copy size={8} /> : <Square size={8} />}
          </button>
        </>
      )}
      {!isMac && (
        <span className="ml-1 text-[0.625rem] font-medium text-text-tertiary">sndmail</span>
      )}
      <div className="sr-only">
        <button onClick={back} disabled={!canGoBack}>Back</button>
        <button onClick={forward}>Forward</button>
      </div>
    </div>
  );
}

/** Backward-compatible export for pop-out surfaces that still import it. */
export const TitleBar = WindowControls;
