export type OpenType = "path" | "url" | "app";

export interface UniversalDocument {
  id: string;
  source: "sndmail" | "velo" | "obsidian" | "file" | string;
  title: string;
  subtitle?: string;
  snippet?: string;
  content?: string;
  app: string;
  open_type: OpenType;
  open_target: string;
  tags?: string[];
  metadata?: Record<string, string | number | boolean | null>;
  updated_at: number;
}

export interface QuerySourceFilter {
  source?: string;
  app?: string;
  query: string;
}

export interface SearchHit {
  id: string;
  source: string;
  title: string;
  subtitle: string;
  snippet: string;
  app: string;
  openType: OpenType;
  openTarget: string;
  tags?: string[];
  metadata?: Record<string, string | number | boolean | null>;
  relevance: number;
  matches?: Array<{ field: string; snippet: string }>;
  matchKind?: "lexical" | "semantic" | "hybrid" | "browse";
  semanticEvidence?: { passage: string; titleContext: string; distance: number };
  indexNotice?: string;
}

export interface TypesenseQueryResponse {
  found: number;
  hits: Array<{
    document: UniversalDocument;
    text_match: number;
    highlight?: Record<string, { snippet?: string; value?: string }>;
    highlights?: Array<{ field: string; snippet?: string; value?: string }>;
  }>;
}

export interface SearchStatus { mode: "hybrid" | "browse"; notice?: string }
