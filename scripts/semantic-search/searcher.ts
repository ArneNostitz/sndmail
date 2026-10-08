import { lstat, readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { createTypesenseConnection, type TypesenseConnection } from "./shared";
import { searchCollection } from "./typesense";
import type { SearchHit } from "./types";

interface SearcherConfig {
  url: string; apiKey: string; collection: string;
}
class SearcherError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

// The searcher shares the worker's private configuration file. Lock fields and
// the mail database path belong to the indexing worker only and are ignored.
async function loadConfig(path: string): Promise<SearcherConfig> {
  if (!isAbsolute(path)) throw new SearcherError("invalid_config", "The searcher needs an absolute configuration path.");
  const stat = await lstat(path);
  if (!stat.isFile() || stat.size > 65536 || (stat.mode & 0o077) !== 0 ||
    (process.getuid && stat.uid !== process.getuid())) {
    throw new SearcherError("unsafe_config", "Searcher configuration must be a private regular file owned by the current user.");
  }
  let value: Partial<SearcherConfig>;
  try { value = JSON.parse(await readFile(path, "utf8")) as Partial<SearcherConfig>; }
  catch { throw new SearcherError("invalid_config", "Searcher configuration is not valid JSON."); }
  if (!value || typeof value.url !== "string" || typeof value.apiKey !== "string" || !value.apiKey.trim() ||
    typeof value.collection !== "string" || !/^[a-zA-Z0-9_-]+$/.test(value.collection)) {
    throw new SearcherError("invalid_config", "Searcher configuration requires a local URL, API key, and collection.");
  }
  return value as SearcherConfig;
}

function connectionFor(config: SearcherConfig): TypesenseConnection {
  let url: URL;
  try { url = new URL(config.url); }
  catch { throw new SearcherError("invalid_config", "The search server URL is invalid."); }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
    !["http:", "https:"].includes(url.protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new SearcherError("nonlocal_server", "The searcher only connects to a loopback search server.");
  }
  return createTypesenseConnection({ typesenseHost: url.hostname, typesensePort: url.port || (url.protocol === "https:" ? "443" : "80"),
    typesenseProtocol: url.protocol.slice(0, -1), typesenseApiKey: config.apiKey, collectionName: config.collection });
}

// Emit only search results. Never log raw errors, configuration, URLs, paths,
// or the API key. Internal messages stay in the exit code's generic failure.
function printHits(hits: SearchHit[]): void {
  const safe = hits.map((hit) => ({
    id: hit.id, title: hit.title, subtitle: hit.subtitle, snippet: hit.snippet,
    tags: hit.tags || [], metadata: hit.metadata, matchKind: hit.matchKind,
    relevance: hit.relevance, semanticEvidence: hit.semanticEvidence,
  }));
  process.stdout.write(JSON.stringify({ hits: safe }) + "\n");
}

function parseArguments(args: string[]): { configPath: string; query: string; limit?: number } {
  let configPath: string | undefined;
  let query: string | undefined;
  let limit: number | undefined;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (!configPath && !argument.startsWith("--")) { configPath = argument; continue; }
    if (argument === "--query" && index + 1 < args.length && !args[index + 1].startsWith("--")) { query = args[++index]; continue; }
    if (argument === "--limit" && index + 1 < args.length) {
      const value = Number(args[++index]);
      if (Number.isFinite(value)) limit = Math.max(1, Math.min(100, Math.trunc(value)));
      continue;
    }
    throw new SearcherError("invalid_arguments", "Usage: searcher.cjs <private-config-file> --query <text> [--limit N]");
  }
  if (!configPath || typeof query !== "string" || !query.trim()) {
    throw new SearcherError("invalid_arguments", "Usage: searcher.cjs <private-config-file> --query <text> [--limit N]");
  }
  return { configPath, query, limit };
}

async function run(): Promise<void> {
  const { configPath, query, limit } = parseArguments(process.argv.slice(2));
  const config = await loadConfig(configPath);
  const connection = connectionFor(config);
  const hits = await searchCollection(connection, { query, source: "sndmail" }, limit ?? 20);
  printHits(hits);
}

void run().catch(() => {
  // The searcher's results are additive to the local full-text search; any
  // failure is reported generically so internals never reach stdout.
  process.stdout.write(JSON.stringify({ error: "Local semantic search is unavailable right now." }) + "\n");
  process.exitCode = 1;
});
