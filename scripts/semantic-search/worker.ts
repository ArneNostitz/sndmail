import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createTypesenseConnection, type TypesenseConnection } from "./shared";
import { collectVeloDocuments } from "./providers/velo";
import { beginSemanticSource, ensureCollection, ensureSemanticCollections, failSemanticSource,
  finishSemanticSource, indexSemanticBatch, type SemanticSourceState } from "./typesense";
import { indexingCpuBudgetPercent } from "./indexing-budget";
import { stopWorker, waitForNextWork, workerSignal } from "./runtime-control";

interface WorkerConfig {
  url: string; apiKey: string; collection: string; sndmailDatabasePath?: string; veloDatabasePath?: string;
  lockPath?: string; lockOwnerToken?: string;
}
let nativeState: "indexing" | "ready" | "error" = "indexing";
let indexedDocuments = 0;
class WorkerError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

// Emit only this module's fixed messages and numeric progress. Never log raw
// fetch/SQLite errors, configuration, URLs, paths, mail fields, or stack traces.
function emit(type: string, fields: Record<string, string | number | boolean> = {}): void {
  if (type === "started" || type === "progress") nativeState = "indexing";
  else if (type === "ready") nativeState = "ready";
  else if (type === "error") nativeState = "error";
  if (typeof fields.documents === "number") indexedDocuments = fields.documents;
  else if (typeof fields.processed === "number") indexedDocuments = fields.processed;
  if (type === "progress" && process.stdout.writableLength > 65536) return;
  if (!process.stdout.destroyed) process.stdout.write(JSON.stringify({ state: nativeState, indexedDocuments,
    type, timestamp: Date.now(), source: "sndmail", ...fields }) + "\n");
}

function safeFailure(error: unknown): { code: string; message: string } {
  if (error instanceof WorkerError) return { code: error.code, message: error.message };
  const value = error as { status?: number; code?: string; name?: string } | undefined;
  if (typeof value?.status === "number" && value.status >= 400 && value.status <= 599) {
    return { code: "typesense_" + value.status, message: "The local search server rejected an indexing request." };
  }
  if (value?.name === "TimeoutError") return { code: "request_timeout", message: "A local indexing request timed out. The worker will retry later." };
  if (value?.code === "ENOENT") return { code: "local_file_missing", message: "A required local file is unavailable." };
  if (value?.code === "EACCES" || value?.code === "EPERM") return { code: "local_access_denied", message: "The worker cannot access a required local resource." };
  return { code: "index_failed", message: "Local mail indexing failed. Check the managed server and mail database before retrying." };
}

async function loadConfig(path: string): Promise<WorkerConfig> {
  if (!isAbsolute(path)) throw new WorkerError("invalid_config", "The worker needs an absolute configuration path.");
  const stat = await lstat(path);
  if (!stat.isFile() || stat.size > 65536 || (stat.mode & 0o077) !== 0 ||
    (process.getuid && stat.uid !== process.getuid())) {
    throw new WorkerError("unsafe_config", "Worker configuration must be a private regular file owned by the current user.");
  }
  let value: Partial<WorkerConfig>;
  try { value = JSON.parse(await readFile(path, "utf8")) as Partial<WorkerConfig>; }
  catch { throw new WorkerError("invalid_config", "Worker configuration is not valid JSON."); }
  if (!value || typeof value.url !== "string" || typeof value.apiKey !== "string" || !value.apiKey.trim() ||
    typeof value.collection !== "string" || !/^[a-zA-Z0-9_-]+$/.test(value.collection) ||
    typeof (value.sndmailDatabasePath || value.veloDatabasePath) !== "string" || !isAbsolute(value.sndmailDatabasePath || value.veloDatabasePath || "")) {
    throw new WorkerError("invalid_config", "Worker configuration requires a local URL, API key, collection, and absolute mail database path.");
  }
  if (value.lockPath !== undefined || value.lockOwnerToken !== undefined) {
    if (typeof value.lockPath !== "string" || !isAbsolute(value.lockPath) ||
      resolve(value.lockPath) !== resolve(dirname(path), "velo-worker-v1.lock") ||
      typeof value.lockOwnerToken !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.lockOwnerToken)) {
      throw new WorkerError("invalid_lock_config", "Managed worker locking requires its dedicated lock path and a launch ownership token.");
    }
  }
  return value as WorkerConfig;
}

function connectionFor(config: WorkerConfig): TypesenseConnection {
  let url: URL;
  try { url = new URL(config.url); }
  catch { throw new WorkerError("invalid_config", "The search server URL is invalid."); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
    !["http:", "https:"].includes(url.protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new WorkerError("nonlocal_server", "The semantic worker only connects to a loopback search server.");
  }
  return createTypesenseConnection({ typesenseHost: url.hostname, typesensePort: url.port || (url.protocol === "https:" ? "443" : "80"),
    typesenseProtocol: url.protocol.slice(0, -1), typesenseApiKey: config.apiKey, collectionName: config.collection });
}

async function ownLock(configPath: string, collection: string, lockPath?: string, lockOwnerToken?: string): Promise<() => Promise<void>> {
  const managed = lockPath !== undefined && lockOwnerToken !== undefined;
  if (managed) await awaitNativeOwnership(configPath, lockOwnerToken);
  workerSignal.throwIfAborted();
  const directory = managed ? lockPath : join(dirname(configPath), "." + collection + ".semantic-worker.lock");
  const token = managed ? lockOwnerToken : randomUUID();
  const marker = join(directory, managed ? "owner.json" : token);
  try { await mkdir(directory, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new WorkerError("worker_lock_busy", "Another worker or a stale worker lock exists. Confirm the previous worker stopped before recovery.");
    }
    throw error;
  }
  try {
    const owner = managed ? { pid: process.pid, ownerToken: token } : { pid: process.pid, parentPid: process.ppid, token };
    await writeFile(marker, JSON.stringify(owner), { flag: "wx", mode: 0o600 });
  }
  catch (error) { await rmdir(directory).catch(() => {}); throw error; }
  return async () => {
    // Native may recover a managed marker only after confirming the recorded
    // owned process group is dead. Normal cleanup verifies both launch token
    // and PID; a foreign, replaced, or malformed marker is never removed.
    if (managed) {
      try {
        if (!(await lstat(marker)).isFile()) return;
        const owner: unknown = JSON.parse(await readFile(marker, "utf8"));
        if (!owner || typeof owner !== "object" ||
          (owner as { pid?: unknown }).pid !== process.pid ||
          (owner as { ownerToken?: unknown }).ownerToken !== token) return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
    }
    // Legacy mode still deletes only its unpredictable UUID marker. Never
    // recursively remove a lock or clear the standalone indexer's index.lock.
    try { await unlink(marker); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    try { await rmdir(directory); }
    catch (error) {
      if (!["ENOENT", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code || "")) throw error;
    }
  };
}

async function awaitNativeOwnership(configPath: string, ownerToken: string): Promise<void> {
  const path = join(dirname(configPath), "worker-owner.json");
  const supervisorPid = process.ppid;
  const deadline = performance.now() + 5000;
  while (performance.now() < deadline) {
    workerSignal.throwIfAborted();
    if (supervisorPid <= 1 || process.ppid !== supervisorPid) {
      throw new WorkerError("owner_handshake_failed", "The sndmail worker supervisor exited before ownership was recorded.");
    }
    try {
      const file = await lstat(path);
      if (!file.isFile() || file.size > 4096 || (file.mode & 0o077) !== 0 ||
        (process.getuid && file.uid !== process.getuid())) {
        throw new WorkerError("owner_handshake_failed", "The native worker ownership record is not a private regular file.");
      }
      let owner: unknown;
      try { owner = JSON.parse(await readFile(path, "utf8")); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") throw error;
        throw new WorkerError("owner_handshake_failed", "The native worker ownership record is invalid.");
      }
      if (!owner || typeof owner !== "object" ||
        !Number.isInteger((owner as { groupId?: unknown }).groupId) ||
        Number((owner as { groupId?: unknown }).groupId) <= 1 ||
        typeof (owner as { ownerToken?: unknown }).ownerToken !== "string") {
        throw new WorkerError("owner_handshake_failed", "The native worker ownership record is invalid.");
      }
      if ((owner as { ownerToken: string }).ownerToken === ownerToken &&
        (owner as { groupId: number }).groupId === supervisorPid) {
        workerSignal.throwIfAborted();
        if (process.ppid !== supervisorPid) {
          throw new WorkerError("owner_handshake_failed", "The sndmail worker supervisor exited before lock acquisition.");
        }
        return;
      }
      // A prior launch's well-formed record may remain until native atomically
      // publishes this launch. Never create a lock from that stale record.
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await waitForNextWork(50);
  }
  throw new WorkerError("owner_handshake_timeout", "sndmail did not confirm worker ownership before the startup deadline.");
}

function scanIntervalMs(): number {
  const value = Number(process.env.SNDMAIL_SEMANTIC_INTERVAL_SECONDS || process.env.VELO_SEMANTIC_INTERVAL_SECONDS || 300);
  return (Number.isFinite(value) ? Math.min(3600, Math.max(60, value)) : 300) * 1000;
}

async function scan(connection: TypesenseConnection, config: WorkerConfig): Promise<void> {
  workerSignal.throwIfAborted();
  emit("progress", { phase: "preparing" });
  // Native Settings must provision/validate the model cache before spawning
  // this worker. Typesense can otherwise try its own public-model download.
  await ensureCollection(connection);
  await ensureSemanticCollections(connection);
  const sourceFilter = ["sndmail"] as const;
  for (const source of sourceFilter) {
    let state: SemanticSourceState | undefined;
    let processed = 0;
    let embedded = 0;
    let reused = 0;
    try {
      state = await beginSemanticSource(connection, source);
      const active = state;
      await collectVeloDocuments(undefined, config.sndmailDatabasePath || config.veloDatabasePath, async (documents) => {
        workerSignal.throwIfAborted();
        let batchEmbedded = 0;
        let batchReused = 0;
        await indexSemanticBatch(connection, documents, active.generation, (passages, unchanged, restMs = 0) => {
          batchEmbedded = passages;
          batchReused = unchanged;
          emit("progress", { phase: restMs > 0 ? "resting" : "indexing", processed,
            embedded: embedded + passages, reused: reused + unchanged, restMs, cpuBudgetPercent: indexingCpuBudgetPercent() });
        }, active.scan_id);
        processed += documents.length;
        embedded += batchEmbedded;
        reused += batchReused;
      });
      emit("progress", { phase: "reconciling", processed, embedded, reused });
      const documents = await finishSemanticSource(connection, active, "");
      emit("ready", { documents, embedded, reused });
    } catch (error) {
      if (state && !workerSignal.aborted) {
        const failure = safeFailure(error);
        // Announce failure before the best-effort status write, which can itself
        // fail if Typesense has stopped. Never defer this behind a pacing wait.
        emit("error", { ...failure, retryable: true });
        try { await failSemanticSource(connection, state, failure.message); }
        catch { emit("error", { code: "status_write_failed", message: "Index completion status could not be saved.", retryable: true }); }
      }
      throw error;
    }
  }
}

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  const configPath = args.length === 1 ? args[0] : args.length === 2 && args[0] === "--config" ? args[1] : undefined;
  if (!configPath) {
    throw new WorkerError("invalid_arguments", "Usage: indexer.cjs <private-config-file>");
  }
  const parentPid = process.ppid;
  if (parentPid <= 1) throw new WorkerError("parent_required", "The semantic worker must be started by its sndmail parent process.");
  process.on("SIGTERM", stopWorker);
  process.on("SIGINT", stopWorker);
  process.stdout.on("error", stopWorker);
  const parentWatch = setInterval(() => { if (process.ppid !== parentPid) stopWorker(); }, 1000);
  parentWatch.unref();
  let release: (() => Promise<void>) | undefined;
  try {
    const config = await loadConfig(configPath);
    const connection = connectionFor(config);
    workerSignal.throwIfAborted();
    release = await ownLock(configPath, config.collection, config.lockPath, config.lockOwnerToken);
    emit("started", { pid: process.pid, cpuBudgetPercent: indexingCpuBudgetPercent(), intervalMs: scanIntervalMs() });
    let failures = 0;
    while (!workerSignal.aborted) {
      try { await scan(connection, config); failures = 0; }
      catch (error) {
        if (workerSignal.aborted) break;
        failures = Math.min(4, failures + 1);
        emit("error", { ...safeFailure(error), retryable: true });
      }
      const delayMs = Math.min(3600000, scanIntervalMs() * 2 ** failures);
      emit("waiting", { delayMs });
      await waitForNextWork(delayMs);
    }
  } finally {
    clearInterval(parentWatch);
    if (release) {
      try { await release(); }
      catch { emit("error", { code: "lock_cleanup_failed", message: "The worker could not remove its owned lock marker.", retryable: false }); }
    }
  }
}

void run().then(() => { emit("stopped"); }).catch((error: unknown) => {
  if (workerSignal.aborted) { emit("stopped"); return; }
  emit("error", { ...safeFailure(error), retryable: false });
  process.exitCode = 1;
});
