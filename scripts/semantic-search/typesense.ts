import { createHash, randomUUID } from "node:crypto";
import { restAfterEmbedding } from "./indexing-budget";
import { workerSignal } from "./runtime-control";
import { createTypesenseConnection, type TypesenseConnection } from "./shared";
import { documentPassages, SEMANTIC_MODEL, SEMANTIC_VERSION, type PassageDocument } from "./passages";
import type { QuerySourceFilter, SearchHit, SearchStatus, TypesenseQueryResponse, UniversalDocument } from "./types";

export const HIGHLIGHT_START = "\uE000";
export const HIGHLIGHT_END = "\uE001";
const RESULT_FIELDS = "id,source,title,subtitle,snippet,open_type,open_target,app,tags,metadata,updated_at";
const SOURCES = ["sndmail", "file", "obsidian"];
const MODEL_CONFIG = { model_name: SEMANTIC_MODEL, indexing_prefix: "passage: ", query_prefix: "query: " };

function baseUrl(config: TypesenseConnection) {
  // Enforce loopback even for callers constructing a connection directly.
  const safe = createTypesenseConnection({ typesenseHost: config.host, typesensePort: String(config.port),
    typesenseProtocol: config.protocol, typesenseApiKey: config.apiKey, collectionName: config.collection });
  return `${safe.protocol}://${safe.host}:${safe.port}`;
}

class TypesenseError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

async function request(config: TypesenseConnection, path: string, init: RequestInit = {}, timeout = 30000): Promise<Response> {
  const deadline = AbortSignal.timeout(timeout);
  const response = await fetch(`${baseUrl(config)}${path}`, { ...init, redirect: "error",
    signal: AbortSignal.any([workerSignal, deadline, ...(init.signal ? [init.signal] : [])]),
    headers: { "Content-Type": "application/json", "X-TYPESENSE-API-KEY": config.apiKey, ...init.headers },
  });
  if (!response.ok) throw new TypesenseError(response.status, `Typesense ${response.status}: ${(await response.text()).slice(0, 400)}`);
  return response;
}

interface Field {
  name: string; type: string; facet?: boolean; optional?: boolean; index?: boolean; num_dim?: number;
  embed?: { from: string[]; model_config: { model_name: string; indexing_prefix?: string; query_prefix?: string } };
}
interface CollectionSchema { name: string; fields: Field[] }

async function collectionSchema(config: TypesenseConnection, name: string, signal?: AbortSignal): Promise<CollectionSchema | undefined> {
  try { return await (await request(config, `/collections/${name}`, { signal })).json() as CollectionSchema; }
  catch (error) { if (error instanceof TypesenseError && error.status === 404) return undefined; throw error; }
}

export async function ensureCollection(config: TypesenseConnection): Promise<void> {
  const existing = await collectionSchema(config, config.collection);
  if (existing) {
    const generation = existing.fields.find((field) => field.name === "index_generation");
    if (generation && generation.type !== "string") throw new Error("Incompatible index_generation field; use a dedicated collection.");
    const additions = [
      ...(!generation ? [{ name: "index_generation", type: "string", optional: true }] : []),
      ...(!existing.fields.some((field) => field.name === "semantic_fingerprint") ?
        [{ name: "semantic_fingerprint", type: "string", optional: true, index: false }] : []),
      ...(!existing.fields.some((field) => field.name === "last_seen_scan") ?
        [{ name: "last_seen_scan", type: "string", optional: true, index: false }] : []),
    ];
    if (additions.length) await request(config, `/collections/${config.collection}`, {
      method: "PATCH", body: JSON.stringify({ fields: additions }),
    });
    return;
  }
  await request(config, "/collections", { method: "POST", body: JSON.stringify({ name: config.collection,
    enable_nested_fields: true, fields: [
      { name: "source", type: "string", facet: true }, { name: "title", type: "string" },
      { name: "subtitle", type: "string", optional: true }, { name: "snippet", type: "string", optional: true },
      { name: "content", type: "string" }, { name: "app", type: "string", facet: true },
      { name: "open_type", type: "string" }, { name: "open_target", type: "string" },
      { name: "tags", type: "string[]", facet: true, optional: true },
      { name: "metadata", type: "object", optional: true, index: false }, { name: "updated_at", type: "int64" },
      { name: "index_generation", type: "string", optional: true },
      { name: "semantic_fingerprint", type: "string", optional: true, index: false },
      { name: "last_seen_scan", type: "string", optional: true, index: false },
    ], default_sorting_field: "updated_at",
  }) });
}

const passageCollection = (config: TypesenseConnection) => `${config.collection}-passages-e5-v1`;
const stateCollection = (config: TypesenseConnection) => `${config.collection}-semantic-state-v1`;

function checkPassageSchema(schema: CollectionSchema | undefined): void {
  const vector = schema?.fields.find((field) => field.name === "embedding");
  const model = vector?.embed?.model_config;
  if (!vector || vector.type !== "float[]" || vector.num_dim !== 384 ||
    vector.embed?.from.join(",") !== "content" || model?.model_name !== SEMANTIC_MODEL ||
    model.indexing_prefix !== MODEL_CONFIG.indexing_prefix || model.query_prefix !== MODEL_CONFIG.query_prefix) {
    throw new Error("Local multilingual passage index is missing or incompatible. Run Update Search Index; use a new collection name for an incompatible schema.");
  }
}

export async function ensureSemanticCollections(config: TypesenseConnection): Promise<void> {
  const state = stateCollection(config);
  const stateSchema = await collectionSchema(config, state);
  if (stateSchema && !stateSchema.fields.some((field) => field.name === "scan_id")) {
    await request(config, `/collections/${state}`, { method: "PATCH", body: JSON.stringify({
      fields: [{ name: "scan_id", type: "string", optional: true }],
    }) });
  }
  if (!stateSchema) await request(config, "/collections", { method: "POST", body: JSON.stringify({
    name: state, fields: [
      { name: "source", type: "string", facet: true }, { name: "status", type: "string" },
      { name: "generation", type: "string" }, { name: "version", type: "string" },
      { name: "scan_id", type: "string" },
      { name: "documents", type: "int64" }, { name: "passages", type: "int64" },
      { name: "message", type: "string" }, { name: "updated_at", type: "int64" },
    ],
  }) });
  const name = passageCollection(config);
  const existing = await collectionSchema(config, name);
  if (existing) { checkPassageSchema(existing); return; }
  // Only the explicit indexing command calls this. Collection creation may
  // download the public model; inference stays inside the local Typesense process.
  await request(config, "/collections", { method: "POST", body: JSON.stringify({
    name, fields: [
      { name: "document_id", type: "string", facet: true },
      { name: "source", type: "string", facet: true }, { name: "app", type: "string", facet: true },
      { name: "content", type: "string" }, { name: "passage", type: "string", index: false },
      { name: "title_context", type: "string", index: false }, { name: "passage_index", type: "int32" },
      { name: "index_generation", type: "string" }, { name: "updated_at", type: "int64" },
      { name: "embedding", type: "float[]", num_dim: 384, embed: { from: ["content"], model_config: MODEL_CONFIG } },
    ],
  }) }, 600000);
}

async function importRecords(config: TypesenseConnection, name: string, records: object[], batchSize: number, action: "upsert" | "update" = "upsert"): Promise<void> {
  for (let offset = 0; offset < records.length; offset += batchSize) {
    const batch = records.slice(offset, offset + batchSize);
    const response = await request(config, `/collections/${name}/documents/import?action=${action}&batch_size=${batchSize}`, {
      method: "POST", headers: { "Content-Type": "text/plain" },
      body: batch.map((document) => JSON.stringify(document)).join("\n"),
    }, 180000);
    const results = (await response.text()).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { success: boolean; error?: string });
    if (results.length !== batch.length || results.some((result) => !result.success)) {
      throw new Error(`Some documents were not indexed: ${results.find((result) => !result.success)?.error || "incomplete import response"}`);
    }
  }
}

export async function upsertDocuments(config: TypesenseConnection, documents: UniversalDocument[]): Promise<void> {
  await ensureCollection(config);
  await importRecords(config, config.collection, documents, 100);
}

export interface SemanticSourceState {
  id: string; source: string; status: "building" | "ready" | "failed";
  generation: string; scan_id: string; version: string; documents: number; passages: number; message: string; updated_at: number;
}

async function saveState(config: TypesenseConnection, state: SemanticSourceState): Promise<void> {
  await importRecords(config, stateCollection(config), [state], 1);
}

export async function beginSemanticSource(config: TypesenseConnection, source: string): Promise<SemanticSourceState> {
  const previous = (await readStates(config, source)).find((state) => state.source === source);
  // A generation identifies reusable embeddings, not which records still exist.
  // Every attempt gets a fresh scan marker, including interrupted retries.
  const resume = previous?.version === SEMANTIC_VERSION;
  const state: SemanticSourceState = { id: source, source, status: "building", generation: resume ? previous.generation : randomUUID(),
    scan_id: randomUUID(), version: SEMANTIC_VERSION, documents: 0, passages: 0, message: "", updated_at: Date.now() };
  await saveState(config, state);
  return state;
}

export async function indexSemanticBatch(config: TypesenseConnection, documents: UniversalDocument[], generation: string,
  progress?: (passages: number, reused: number, restMilliseconds?: number) => void, scanId = generation): Promise<void> {
  if (!documents.length) return;
  if (documents.some((document) => !/^[a-f0-9]+$/.test(document.id))) throw new Error("Invalid original document ID.");
  const previous = await searchData<{ hits: Array<{ document: { id: string; index_generation?: string; semantic_fingerprint?: string } }> }>(
    config, config.collection, { q: "*", query_by: "title", per_page: "100",
      include_fields: "id,index_generation,semantic_fingerprint",
      filter_by: `id:=[${documents.map((document) => document.id).join(",")}]` });
  const fingerprints = new Map(previous.hits.map((hit) => [hit.document.id, hit.document]));
  const fingerprint = (document: UniversalDocument) => createHash("sha256")
    .update(JSON.stringify([SEMANTIC_VERSION, document.title, document.content, document.snippet, document.subtitle, document.tags, document.source, document.app])).digest("hex");
  const changed = documents.filter((document) => {
    const old = fingerprints.get(document.id);
    return old?.index_generation !== generation || old.semantic_fingerprint !== fingerprint(document);
  });
  const changedIds = new Set(changed.map((document) => document.id));
  // Reset the completion marker before writing passages. A crash therefore
  // never allows a partially imported mail to be skipped on resume.
  await importRecords(config, config.collection, documents.map((document) => ({
    ...document, index_generation: generation, last_seen_scan: scanId,
    semantic_fingerprint: changedIds.has(document.id) ? "" : fingerprint(document),
  })), 100);
  if (changed.length) {
    const filter = new URLSearchParams({ filter_by: `document_id:=[${changed.map((document) => document.id).join(",")}] && index_generation:=${filterValue(generation)}` });
    await request(config, `/collections/${passageCollection(config)}/documents?${filter}`, { method: "DELETE" });
  }
  let batch: PassageDocument[] = [];
  let embedded = 0;
  const reused = documents.length - changed.length;
  const flush = async () => {
    if (!batch.length) return;
    workerSignal.throwIfAborted();
    const startedAt = performance.now();
    await importRecords(config, passageCollection(config), batch, 16);
    embedded += batch.length;
    batch = [];
    // Success-only pacing: errors bypass the wait. The worker's abort signal
    // cancels rests immediately when disabled or when its sndmail parent exits.
    await restAfterEmbedding(startedAt, (remaining) => progress?.(embedded, reused, remaining));
  };
  for (const document of changed) for (const passage of documentPassages(document, generation)) {
    batch.push(passage);
    if (batch.length === 16) await flush();
  }
  await flush();
  if (changed.length) await importRecords(config, config.collection,
    changed.map((document) => ({ id: document.id, semantic_fingerprint: fingerprint(document) })), 100, "update");
  progress?.(embedded, reused);
}

function filterValue(value: string): string {
  if (!/^[\w .-]+$/.test(value)) throw new Error("Invalid source or application filter.");
  return `\`${value}\``;
}

interface ExportRecord { id: string; index_generation?: string; last_seen_scan?: string; document_id?: string }

// Stream reconciliation with a bounded deletion buffer. Generation markers
// replace the corpus-sized retained-ID set on the active indexing path.
async function pruneDocuments(config: TypesenseConnection, name: string, source: string,
  keep: (records: ExportRecord[]) => Set<string> | Promise<Set<string>>): Promise<void> {
  const query = new URLSearchParams({ filter_by: `source:=${filterValue(source)}`, include_fields: "id,index_generation,last_seen_scan,document_id" });
  const response = await request(config, `/collections/${name}/documents/export?${query}`, {}, 600000);
  let batch: ExportRecord[] = [];
  const flush = async () => {
    if (!batch.length) return;
    const retained = await keep(batch);
    const stale = batch.filter((record) => !retained.has(record.id)).map((record) => record.id);
    batch = [];
    if (!stale.length) return;
    if (stale.some((id) => !/^[a-f0-9]+$/.test(id))) throw new Error("Unexpected document ID; use a dedicated universal-search collection.");
    const deletion = new URLSearchParams({ filter_by: `source:=${filterValue(source)} && id:=[${stale.join(",")}]` });
    await request(config, `/collections/${name}/documents?${deletion}`, { method: "DELETE" });
  };
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Typesense returned an empty export stream.");
  const decoder = new TextDecoder();
  let buffer = "";
  const consume = async (line: string) => {
    if (!line.trim()) return;
    batch.push(JSON.parse(line) as ExportRecord);
    if (batch.length >= 100) await flush();
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) { await consume(buffer.slice(0, end)); buffer = buffer.slice(end + 1); }
      if (buffer.length > 65536) throw new Error("Oversized Typesense reconciliation record.");
      if (done) break;
    }
    await consume(buffer);
    await flush();
  } finally { await reader.cancel(); reader.releaseLock(); }
}

export async function removeStaleDocuments(config: TypesenseConnection, source: string, retained: Set<string>): Promise<void> {
  await pruneDocuments(config, config.collection, source, () => retained);
}

async function searchData<T>(config: TypesenseConnection, name: string, parameters: Record<string, string>, signal?: AbortSignal): Promise<T> {
  const response = await request(config, `/collections/${name}/documents/search?${new URLSearchParams(parameters)}`, { signal });
  const data = await response.json() as T & { search_cutoff?: boolean };
  if (data.search_cutoff) throw new Error("Typesense stopped this search early. The index is busy; retry when indexing finishes.");
  return data;
}

interface CountsResponse { found: number; facet_counts?: Array<{ field_name: string; counts: Array<{ value: string; count: number }> }> }

async function sourceCounts(config: TypesenseConnection, name: string, source?: string, signal?: AbortSignal): Promise<Map<string, number>> {
  const data = await searchData<CountsResponse>(config, name, { q: "*", query_by: "source", per_page: "1", include_fields: "id",
    facet_by: "source", max_facet_values: "100", ...(source ? { filter_by: `source:=${filterValue(source)}` } : {}) }, signal);
  return new Map(data.facet_counts?.find((facet) => facet.field_name === "source")?.counts.map((entry) => [entry.value, entry.count]) || []);
}

export async function finishSemanticSource(config: TypesenseConnection, state: SemanticSourceState, message: string): Promise<number> {
  // Prune by the completed scan, not the reusable embedding generation. Delete
  // parents first so a crash/retry cannot reuse a fingerprint after its passages
  // were removed. Then stream passage batches and remove old/orphaned records.
  await pruneDocuments(config, config.collection, state.source, (records) => new Set(records
    .filter((record) => record.index_generation === state.generation && record.last_seen_scan === state.scan_id)
    .map((record) => record.id)));
  await pruneDocuments(config, passageCollection(config), state.source, async (records) => {
    const candidates = records.filter((record) => record.index_generation === state.generation);
    const ids = [...new Set(candidates.map((record) => record.document_id || ""))];
    if (!ids.length) return new Set<string>();
    if (ids.some((id) => !/^[a-f0-9]+$/.test(id))) throw new Error("Invalid parent ID during passage reconciliation.");
    const parents = await searchData<{ hits: Array<{ document: { id: string } }> }>(config, config.collection, {
      q: "*", query_by: "source", per_page: "100", include_fields: "id",
      filter_by: `source:=${filterValue(state.source)} && id:=[${ids.join(",")}]`,
    });
    const retained = new Set(parents.hits.map((hit) => hit.document.id));
    return new Set(candidates.filter((record) => retained.has(record.document_id!)).map((record) => record.id));
  });
  const [parents, passages] = await Promise.all([
    sourceCounts(config, config.collection, state.source), sourceCounts(config, passageCollection(config), state.source),
  ]);
  const documents = parents.get(state.source) || 0;
  const count = passages.get(state.source) || 0;
  if (documents > 0 && count < documents) throw new Error("The semantic index has fewer passages than documents.");
  await saveState(config, { ...state, status: "ready", documents, passages: count, message, updated_at: Date.now() });
  return documents;
}

export async function failSemanticSource(config: TypesenseConnection, state: SemanticSourceState, error: string): Promise<void> {
  await saveState(config, { ...state, status: "failed", message: error, updated_at: Date.now() });
}

async function readStates(config: TypesenseConnection, source?: string, signal?: AbortSignal): Promise<SemanticSourceState[]> {
  const data = await searchData<{ hits: Array<{ document: SemanticSourceState }> }>(config, stateCollection(config), {
    q: "*", query_by: "source", per_page: "100", ...(source ? { filter_by: `source:=${filterValue(source)}` } : {}),
  }, signal);
  return data.hits.map((hit) => hit.document);
}

async function readyStates(config: TypesenseConnection, source?: string, signal?: AbortSignal): Promise<SemanticSourceState[]> {
  const [schema, states, parents, passages] = await Promise.all([
    collectionSchema(config, passageCollection(config), signal), readStates(config, source, signal),
    sourceCounts(config, config.collection, source, signal), sourceCounts(config, passageCollection(config), source, signal),
  ]);
  checkPassageSchema(schema);
  if (!states.length) throw new Error("No completed multilingual index. Run Update Search Index to activate local semantic search.");
  const relevant = new Set([...states.map((state) => state.source), ...parents.keys(), ...passages.keys(), ...(source ? [source] : [])]);
  for (const item of relevant) {
    const state = states.find((entry) => entry.source === item);
    if (!state || state.version !== SEMANTIC_VERSION || state.status !== "ready") {
      throw new Error(`Semantic index for ${item} is ${state?.status || "missing"}. ${state?.message || ""} Run Update Search Index and wait for completion.`);
    }
    if (state.documents !== (parents.get(item) || 0) || state.passages !== (passages.get(item) || 0)) {
      throw new Error(`Semantic coverage for ${item} is incomplete. Run Update Search Index before searching.`);
    }
  }
  return states;
}

function stateStamp(states: SemanticSourceState[]): string {
  return states.map((state) => [state.source, state.generation, state.scan_id, state.status, state.version, state.updated_at].join(":")).sort().join("|");
}

function mapHit(hit: TypesenseQueryResponse["hits"][number]): SearchHit {
  const matches: Array<{ field: string; snippet: string }> = [];
  for (const field of ["title", "subtitle", "content", "tags"]) {
    const entry = hit.highlight?.[field];
    for (const value of Array.isArray(entry) ? entry : entry ? [entry] : []) {
      if (typeof value.snippet === "string" && value.snippet.includes(HIGHLIGHT_START)) matches.push({ field, snippet: value.snippet });
    }
    if (!matches.some((match) => match.field === field)) {
      const legacy = hit.highlights?.find((item) => item.field === field);
      if (legacy?.snippet?.includes(HIGHLIGHT_START)) matches.push({ field, snippet: legacy.snippet });
    }
  }
  const matchedContent = hit.highlight?.content?.snippet || hit.highlights?.find((item) => item.field === "content")?.snippet;
  return { id: hit.document.id, source: hit.document.source, title: hit.document.title,
    subtitle: hit.document.subtitle || "", snippet: matchedContent || hit.document.snippet || "", app: hit.document.app,
    openType: hit.document.open_type, openTarget: hit.document.open_target, tags: hit.document.tags || [],
    metadata: hit.document.metadata, relevance: hit.text_match || 0, matches };
}

interface SemanticResponse {
  grouped_hits: Array<{ hits: Array<{ document: PassageDocument; vector_distance: number }> }>;
}

export async function searchCollection(config: TypesenseConnection, input: QuerySourceFilter, limit: number,
  signal?: AbortSignal, onStatus?: (status: SearchStatus) => void): Promise<SearchHit[]> {
  if (!input.query.trim()) return [];
  const count = Number.isFinite(limit) ? Math.max(1, Math.min(100, Math.trunc(limit))) : 20;
  const candidates = Math.min(100, Math.max(40, count * 3));
  const filters: string[] = [];
  if (input.source === "sndmail") filters.push("source:=sndmail");
  else if (input.source) filters.push(`source:=${filterValue(input.source)}`);
  if (input.app === "sndmail") filters.push("app:=sndmail");
  else if (input.app) filters.push(`app:=${filterValue(input.app)}`);
  const scoped: Record<string, string> = {};
  if (filters.length) scoped.filter_by = filters.join(" && ");
  // A recognized application scope needs only that source to be ready.
  const healthSource = input.source || ({ sndmail: "sndmail", Finder: "file", Obsidian: "obsidian" } as Record<string, string>)[input.app || ""];
  if (healthSource && !SOURCES.includes(healthSource)) throw new Error("Unknown search source.");
  try {
    const states = await readyStates(config, healthSource, signal);
    const lexicalParameters = { q: input.query, query_by: "title,subtitle,content,tags", query_by_weights: "5,3,1,2",
      per_page: String(candidates), sort_by: input.query === "*" ? "updated_at:desc" : "_text_match:desc,updated_at:desc",
      include_fields: RESULT_FIELDS, highlight_fields: "title,subtitle,content,tags",
      highlight_start_tag: HIGHLIGHT_START, highlight_end_tag: HIGHLIGHT_END,
      snippet_threshold: "80", highlight_affix_num_tokens: "12", drop_tokens_threshold: "0", ...scoped };
    const [lexical, semantic] = await Promise.all([
      searchData<TypesenseQueryResponse>(config, config.collection, lexicalParameters, signal),
      input.query === "*" ? Promise.resolve(undefined) : searchData<SemanticResponse>(config, passageCollection(config), {
        q: input.query, query_by: "embedding", vector_query: "embedding:([], k:1000, distance_threshold:0.25)",
        per_page: String(candidates), group_by: "document_id", group_limit: "1",
        include_fields: "document_id,passage,title_context,passage_index,source,app", exclude_fields: "embedding,content",
        ...scoped,
      }, signal),
    ]);
    const ranked = new Map<string, SearchHit>();
    lexical.hits.forEach((raw, rank) => {
      const hit = mapHit(raw);
      hit.relevance = 0.35 / (60 + rank + 1);
      hit.matchKind = input.query === "*" ? "browse" : "lexical";
      ranked.set(hit.id, hit);
    });
    if (semantic) {
      if (!Array.isArray(semantic.grouped_hits)) throw new Error("Typesense did not return grouped semantic passages.");
      const evidence = semantic.grouped_hits.flatMap((group) => group.hits.slice(0, 1));
      const ids = [...new Set(evidence.map((hit) => hit.document.document_id))];
      if (ids.some((id) => !/^[a-f0-9]+$/.test(id))) throw new Error("Invalid original document ID in passage index.");
      const originals = ids.length ? await searchData<TypesenseQueryResponse>(config, config.collection, {
        q: "*", query_by: "title", include_fields: RESULT_FIELDS, per_page: String(ids.length),
        filter_by: [...filters, `id:=[${ids.join(",")}]`].join(" && "),
      }, signal) : { found: 0, hits: [] };
      const parentMap = new Map(originals.hits.map((hit) => [hit.document.id, hit]));
      const seen = new Set<string>();
      evidence.forEach((raw, rank) => {
        const id = raw.document.document_id;
        if (seen.has(id)) return;
        seen.add(id);
        const original = parentMap.get(id);
        if (!original) throw new Error("A semantic passage has no matching original document. Run Update Search Index.");
        if (!Number.isFinite(raw.vector_distance)) throw new Error("Typesense omitted a semantic distance.");
        const hit = ranked.get(id) || { ...mapHit(original), relevance: 0, matchKind: "semantic" as const };
        hit.matchKind = hit.matchKind === "lexical" ? "hybrid" : "semantic";
        hit.relevance += 0.65 / (60 + rank + 1);
        hit.semanticEvidence = { passage: raw.document.passage, titleContext: raw.document.title_context, distance: raw.vector_distance };
        ranked.set(id, hit);
      });
    }
    // Do not return a mixture if indexing started while the query was in flight.
    if (stateStamp(states) !== stateStamp(await readStates(config, healthSource, signal))) {
      throw new Error("The index changed during search. Wait for indexing to finish, then refresh results.");
    }
    const notice = states.filter((state) => state.message).map((state) => `${state.source}: ${state.message}`).join("\n");
    onStatus?.({ mode: input.query === "*" ? "browse" : "hybrid", notice });
    return [...ranked.values()].sort((a, b) => b.relevance - a.relevance).slice(0, count)
      .map((hit) => ({ ...hit, indexNotice: notice || undefined }));
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error(`Local multilingual search unavailable: ${(error as Error).message}`);
  }
}
