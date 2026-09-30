import { useEffect, useId, useRef, useState } from "react";
import { Download, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import {
  downloadSemanticSearchModel,
  getSemanticSearchStatus,
  reindexSemanticSearch,
  setSemanticSearchEnabled,
  type SemanticSearchStatus,
} from "@/services/search/semanticSearchRuntime";

type Action = "enable" | "disable" | "download" | "cancel-download" | "reindex" | "refresh";

const ACTION_LABELS: Record<Action, string> = {
  enable: "Starting local search...",
  disable: "Stopping local search...",
  download: "Requesting model download...",
  "cancel-download": "Cancelling model download...",
  reindex: "Requesting mail index update...",
  refresh: "Checking status...",
};

// Agreed native state literals; unknown values are shown in the details below.
const STATE_LABELS: Record<string, string> = {
  unsupported: "Unavailable on this platform",
  disabled: "Disabled",
  model_required: "Model download required",
  downloading: "Downloading model",
  starting: "Starting local search",
  indexing: "Indexing mail",
  ready: "Ready",
  conflict: "Local server cannot start",
  error: "Local search needs attention",
};

const MODEL_LABELS: Record<string, string> = {
  missing: "Not downloaded",
  downloading: "Downloading",
  ready: "Downloaded and ready",
  error: "Download needs attention",
};

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error) || "Unknown native error";
  } catch {
    return "Unknown native error";
  }
}

function formatBytes(bytes: number): string {
  return `${(Math.max(0, bytes) / 1024 / 1024).toLocaleString(undefined, {
    maximumFractionDigits: 1,
  })} MiB`;
}

export function SemanticSearchSettings() {
  const id = useId();
  const [status, setStatus] = useState<SemanticSearchStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [action, setAction] = useState<Action | null>(null);
  const requestRef = useRef<((next: Action) => void) | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let running = false;
    let mutating = false;
    let pending: Action | null = null;

    async function run() {
      if (signal.aborted || running) return;
      running = true;
      const next = pending;
      pending = null;
      mutating = next !== null;
      try {
        let result: SemanticSearchStatus;
        switch (next) {
          case "enable":
          case "disable":
          case "cancel-download":
            result = await setSemanticSearchEnabled(next === "enable", signal);
            break;
          case "download":
            result = await downloadSemanticSearchModel(signal);
            break;
          case "reindex":
            result = await reindexSemanticSearch(signal);
            break;
          default:
            result = await getSemanticSearchStatus(signal);
        }
        if (signal.aborted) return;
        setStatus(result);
        setStatusError(null);
        if (next && next !== "refresh") setActionError(null);
      } catch (error) {
        if (signal.aborted) return;
        if (next && next !== "refresh") {
          setActionError(`${ACTION_LABELS[next].replace(/\.\.\.$/, "")} failed: ${errorMessage(error)}`);
        } else {
          setStatusError(`Could not read local search status: ${errorMessage(error)}`);
        }
      } finally {
        running = false;
        mutating = false;
        if (!signal.aborted) {
          if (next) setAction(null);
          // A click during a status read runs immediately after that read.
          // Otherwise schedule from completion, never with an overlapping interval.
          if (pending) void run();
          else timer = setTimeout(() => void run(), 2000);
        }
      }
    }

    requestRef.current = (next) => {
      if (signal.aborted || pending || mutating) return;
      if (timer !== undefined) clearTimeout(timer);
      pending = next;
      setAction(next);
      void run();
    };
    void run();

    return () => {
      controller.abort();
      if (timer !== undefined) clearTimeout(timer);
      requestRef.current = null;
    };
  }, []);

  const modelReady = status?.modelState === "ready";
  const downloading = status?.modelState === "downloading" || status?.state === "downloading";
  const indexing = status?.state === "indexing";
  const starting = status?.state === "starting";
  const failed = status?.state === "error" || status?.state === "conflict" || status?.modelState === "error";
  const enabled = status?.enabled ?? false;
  const busy = action !== null;
  const downloaded = Math.max(0, status?.downloadedBytes ?? 0);
  const total = status?.totalBytes;
  const progress = total != null && total > 0
    ? Math.min(100, Math.max(0, downloaded / total * 100))
    : null;
  // The off path stays available even if native status is stale or the model fails.
  const toggleDisabled = busy || !status || (!enabled && (
    !status.supported || !modelReady || downloading || statusError !== null
  ));
  const canReindex = status?.supported && enabled && modelReady &&
    status.state === "ready" && !statusError && !busy;
  const statusLabel = action
    ? ACTION_LABELS[action]
    : !status
      ? statusError ? "Status unavailable" : "Checking local search..."
      : !status.supported
        ? STATE_LABELS.unsupported
        : downloading
          ? STATE_LABELS.downloading
          : STATE_LABELS[status.state] ?? "Unknown runtime status";

  return (
    <section aria-labelledby={`${id}-heading`} className="mb-6 space-y-3">
      <h3 id={`${id}-heading`} className="text-xs font-semibold uppercase tracking-wider text-text-tertiary">
        Local semantic search
      </h3>
      <div className="flex items-center justify-between gap-4">
        <div>
          <span id={`${id}-label`} className="text-sm text-text-secondary">Enable local search</span>
          <p id={`${id}-description`} className="mt-0.5 text-xs text-text-tertiary">
            Private, on-device search of your sndmail mail. The local server and model run as part of sndmail.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-labelledby={`${id}-label`}
          aria-describedby={`${id}-description ${id}-enable-help`}
          disabled={toggleDisabled}
          onClick={() => requestRef.current?.(enabled ? "disable" : "enable")}
          className={`relative h-5 w-10 shrink-0 rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50 ${enabled ? "bg-accent" : "bg-bg-tertiary"}`}
        >
          <span className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${enabled ? "translate-x-5" : ""}`} />
        </button>
      </div>
      <p id={`${id}-enable-help`} className="text-xs text-text-tertiary">
        Download the model before enabling. Turning this off stops the server and indexer, retaining the model and index.
        Quitting sndmail stops them; hiding or closing the window keeps them running.
      </p>

      <div className="space-y-3 rounded-lg border border-border-primary bg-bg-secondary p-4">
        <div role="status" aria-live="polite" className={`flex items-center gap-2 text-sm font-medium ${failed ? "text-danger" : "text-text-primary"}`}>
          {busy || downloading || indexing || starting || (!status && !statusError)
            ? <Spinner size={14} label={statusLabel} />
            : null}
          <span>{statusLabel}</span>
        </div>
        {status?.message ? (
          <p role={failed ? "alert" : undefined} className={`break-words text-xs ${failed ? "text-danger" : "text-text-secondary"}`}>
            {status.message}
          </p>
        ) : null}
        {statusError ? (
          <div role="alert" className="space-y-2">
            <p className="break-words text-xs text-danger">{statusError} {status ? "Showing the last known status." : ""}</p>
            <Button type="button" disabled={busy} onClick={() => requestRef.current?.("refresh")}>Retry status</Button>
          </div>
        ) : null}
        {actionError ? <p role="alert" className="break-words text-xs text-danger">{actionError}</p> : null}

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm text-text-secondary">Search model</p>
            <p className="text-xs text-text-tertiary">
              {status ? MODEL_LABELS[status.modelState] ?? `Unknown model status: ${status.modelState}` : "Waiting for status"}
            </p>
          </div>
          {downloading ? (
            <Button
              type="button"
              disabled={busy}
              onClick={() => requestRef.current?.("cancel-download")}
            >
              {action === "cancel-download" ? "Cancelling..." : "Cancel download"}
            </Button>
          ) : !modelReady ? (
            <Button
              type="button"
              icon={<Download size={14} aria-hidden="true" />}
              disabled={!status?.supported || busy || downloading || statusError !== null}
              onClick={() => requestRef.current?.("download")}
            >
              {downloading ? "Downloading..." : status?.modelState === "error" || actionError
                ? "Retry model download" : "Download model"}
            </Button>
          ) : null}
        </div>
        {downloading || (!modelReady && downloaded > 0) ? (
          <div className="space-y-1.5">
            <div
              role="progressbar"
              aria-label="Model download"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={progress === null ? undefined : Math.round(progress)}
              aria-valuetext={`${formatBytes(downloaded)} downloaded${total != null && total > 0 ? ` of ${formatBytes(total)}` : "; total size not yet reported"}`}
              className="h-1.5 overflow-hidden rounded-full bg-bg-tertiary"
            >
              {progress !== null ? <div className="h-full bg-accent" style={{ width: `${progress}%` }} /> : null}
            </div>
            <p className="text-xs text-text-tertiary">
              {formatBytes(downloaded)}{total != null && total > 0 ? ` / ${formatBytes(total)} (${Math.floor(progress ?? 0)}%)` : " downloaded; waiting for total size"}
            </p>
          </div>
        ) : null}

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border-primary pt-3">
          <div>
            <p className="text-sm text-text-secondary">Mail index</p>
            <p className="text-xs text-text-tertiary">
              {status?.indexedDocuments != null
                ? `${status.indexedDocuments.toLocaleString()} documents indexed`
                : "Indexed count not yet available"}
              {indexing ? ". Indexing in progress." : !enabled ? ". Indexer stopped." : ""}
            </p>
          </div>
          <Button
            type="button"
            icon={<RefreshCw size={14} aria-hidden="true" />}
            disabled={!canReindex}
            aria-describedby={`${id}-reindex-help`}
            onClick={() => requestRef.current?.("reindex")}
          >
            {indexing ? "Updating index..." : "Update index"}
          </Button>
        </div>
        <p id={`${id}-reindex-help`} className="text-xs text-text-tertiary">
          Update scans for new or changed mail and reuses existing embeddings without rebuilding the index.
          Available when local search is enabled and ready.
        </p>
      </div>

      <p className="text-xs text-text-tertiary">
        Initial model download: about 453 MiB. For a full mail index, plan for roughly 1-2 GB of disk space and RAM;
        actual use depends on your mailbox and may be higher. Mail stays on your device; internet access is needed to download the model.
      </p>
      <p className="text-xs text-text-tertiary">
        This runtime powers Raycast for now. Search inside sndmail continues to use its existing full-text search.
      </p>
      {status ? (
        <details className="text-xs text-text-tertiary">
          <summary className="cursor-pointer rounded focus-visible:outline-2 focus-visible:outline-accent">Local search details</summary>
          <dl className="mt-2 space-y-1 break-all">
            <div><dt className="inline font-medium">Model: </dt><dd className="inline">{status.modelId || "Not reported"}</dd></div>
            <div><dt className="inline font-medium">Data folder: </dt><dd className="inline">{status.dataPath || "Not reported"}</dd></div>
            <div><dt className="inline font-medium">Runtime state: </dt><dd className="inline">{status.state}</dd></div>
            <div><dt className="inline font-medium">Model state: </dt><dd className="inline">{status.modelState}</dd></div>
          </dl>
        </details>
      ) : null}
    </section>
  );
}
