import {
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

export type TooltipPlacement = "top" | "bottom" | "left" | "right";

interface TooltipProps {
  /** What the tooltip says. A string, or richer markup for status lines. */
  content: ReactNode;
  /** The single element the tooltip belongs to. Must accept a ref and mouse/focus handlers. */
  children: ReactElement;
  placement?: TooltipPlacement;
  /** Milliseconds before it appears. Zero by design — see below. */
  delay?: number;
  /** Set false to leave the element untouched, e.g. when there is nothing to say. */
  enabled?: boolean;
  className?: string;
}

/** Space between the element and the bubble. */
const GAP = 8;

/**
 * An instant tooltip.
 *
 * The system `title` tooltip waits about a second, cannot be styled, and on
 * macOS sometimes never comes at all. A control whose meaning has to be
 * hovered for should explain itself the moment the pointer arrives, so this
 * shows at once, follows the element through scrolling and resizing, and is
 * rendered through a portal so no ancestor's overflow can clip it.
 *
 * It sits at the top of the stacking order — a tooltip explains whatever is
 * in front, so anything painting over it is a bug — and opens on focus as
 * well as hover, so keyboard users get the same words. It closes on Escape. It is decoration, not the only way to learn
 * something: anything vital still needs to be in the element itself.
 */
export function Tooltip({
  content,
  children,
  placement = "top",
  delay = 0,
  enabled = true,
  className = "",
}: TooltipProps) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const anchorRef = useRef<HTMLElement | null>(null);
  const bubbleRef = useRef<HTMLDivElement | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = useCallback(() => {
    if (!enabled) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    if (delay > 0) {
      timerRef.current = setTimeout(() => setOpen(true), delay);
    } else {
      setOpen(true);
    }
  }, [enabled, delay]);

  const hide = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    setOpen(false);
  }, []);

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  // Place the bubble against the element, flipping to the other side when the
  // preferred one would leave the window
  const reposition = useCallback(() => {
    const anchor = anchorRef.current;
    const bubble = bubbleRef.current;
    if (!anchor || !bubble) return;
    const a = anchor.getBoundingClientRect();
    const b = bubble.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Prefer the requested side, then its opposite, then whichever
    // perpendicular side has more room. The portal lets the bubble cross
    // card, sidebar, and scroll-container edges; only the app viewport bounds
    // constrain it.
    const available: Record<TooltipPlacement, number> = {
      top: a.top - GAP,
      bottom: vh - a.bottom - GAP,
      left: a.left - GAP,
      right: vw - a.right - GAP,
    };
    const needed: Record<TooltipPlacement, number> = {
      top: b.height,
      bottom: b.height,
      left: b.width,
      right: b.width,
    };
    const opposite: Record<TooltipPlacement, TooltipPlacement> = {
      top: "bottom",
      bottom: "top",
      left: "right",
      right: "left",
    };
    const perpendicular = placement === "top" || placement === "bottom"
      ? ["right", "left"] as const
      : ["bottom", "top"] as const;
    const candidates: TooltipPlacement[] = [placement, opposite[placement], ...perpendicular];
    const side = candidates.find((candidate) => available[candidate] >= needed[candidate])
      ?? candidates.reduce((best, candidate) =>
        available[candidate] > available[best] ? candidate : best,
      );

    let top: number;
    let left: number;
    switch (side) {
      case "bottom":
        top = a.bottom + GAP;
        left = a.left + a.width / 2 - b.width / 2;
        break;
      case "left":
        top = a.top + a.height / 2 - b.height / 2;
        left = a.left - b.width - GAP;
        break;
      case "right":
        top = a.top + a.height / 2 - b.height / 2;
        left = a.right + GAP;
        break;
      default:
        top = a.top - b.height - GAP;
        left = a.left + a.width / 2 - b.width / 2;
    }
    // Keep it on screen even when the element sits at an edge
    left = Math.max(GAP, Math.min(left, vw - b.width - GAP));
    top = Math.max(GAP, Math.min(top, vh - b.height - GAP));
    setPosition({ top, left });
  }, [placement]);

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    reposition();
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);
    return () => {
      window.removeEventListener("scroll", reposition, true);
      window.removeEventListener("resize", reposition);
    };
  }, [open, reposition, content]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") hide(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, hide]);

  if (!isValidElement(children)) return children;
  if (!enabled || content == null || content === "") return children;

  const child = children as ReactElement<Record<string, unknown>>;
  const childProps = child.props;

  const anchored = cloneElement(child, {
    ref: (node: HTMLElement | null) => {
      anchorRef.current = node;
      const inner = (child as unknown as { ref?: unknown }).ref;
      if (typeof inner === "function") inner(node);
      else if (inner && typeof inner === "object") (inner as { current: unknown }).current = node;
    },
    "aria-describedby": open ? id : undefined,
    onMouseEnter: (e: unknown) => { show(); (childProps.onMouseEnter as ((e: unknown) => void) | undefined)?.(e); },
    onMouseLeave: (e: unknown) => { hide(); (childProps.onMouseLeave as ((e: unknown) => void) | undefined)?.(e); },
    onFocus: (e: unknown) => { show(); (childProps.onFocus as ((e: unknown) => void) | undefined)?.(e); },
    onBlur: (e: unknown) => { hide(); (childProps.onBlur as ((e: unknown) => void) | undefined)?.(e); },
  });

  return (
    <>
      {anchored}
      {open &&
        createPortal(
          <div
            ref={bubbleRef}
            id={id}
            role="tooltip"
            className={`fixed z-[9999] max-w-xs px-2.5 py-1.5 rounded-lg border border-border-primary bg-bg-primary text-text-primary text-xs shadow-lg glass-panel pointer-events-none tooltip-enter ${className}`}
            style={{
              top: position?.top ?? -9999,
              left: position?.left ?? -9999,
              maxWidth: "calc(100vw - 16px)",
              // Measured first, then placed — never paint it in the corner
              visibility: position ? "visible" : "hidden",
            }}
          >
            {content}
          </div>,
          document.body,
        )}
    </>
  );
}
