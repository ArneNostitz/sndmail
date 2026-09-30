import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function expandPath(value: string): string {
  return resolve(value === "~" ? homedir() : value.startsWith("~/") ? join(homedir(), value.slice(2)) : value);
}

export interface TypesenseConnection {
  host: string;
  port: number;
  protocol: "http" | "https";
  apiKey: string;
  collection: string;
}

export interface SearchCommandConfig extends TypesenseConnection {
  resultLimit: number;
}

export interface IndexerConfig extends TypesenseConnection {
  batchSize: number;
  folders: string[];
  obsidianVaults: string[];
  sndmailExportPath?: string;
  veloExportPath?: string;
  sndmailDbPath?: string;
  veloDbPath?: string;
  sourceFilter?: Array<"sndmail" | "velo" | "obsidian" | "file">;
}

export function createTypesenseConnection(config: {
  typesenseHost?: string;
  typesensePort?: string;
  typesenseProtocol?: string;
  typesenseApiKey?: string;
  collectionName?: string;
}): TypesenseConnection {
  const host = (config.typesenseHost || process.env.TYPESENSE_HOST || "127.0.0.1").trim();
  const port = Number.parseInt(config.typesensePort || process.env.TYPESENSE_PORT || "8108", 10);
  const protocol = ((config.typesenseProtocol || process.env.TYPESENSE_PROTOCOL || "http").trim() || "http").toLowerCase();
  const apiKey = config.typesenseApiKey || process.env.TYPESENSE_API_KEY || "";
  const collection = (config.collectionName || process.env.TYPESENSE_COLLECTION || "universal-search").trim();

  if (Number.isNaN(port) || port <= 0 || port > 65535) {
    throw new Error("Invalid TYPESENSE_PORT");
  }

  if (!apiKey) {
    throw new Error("Missing TYPESENSE_API_KEY");
  }

  if (protocol !== "http" && protocol !== "https") {
    throw new Error("TYPESENSE_PROTOCOL must be 'http' or 'https'");
  }

  if (!["localhost", "127.0.0.1", "[::1]", "::1"].includes(host)) {
    throw new Error("Typesense Host must be localhost, 127.0.0.1, or ::1. Mail and file content stays on this Mac.");
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(collection)) throw new Error("Collection must contain only letters, numbers, _ or -.");
  return { host: host === "::1" ? "[::1]" : host, port, protocol: protocol as "http" | "https", apiKey, collection };
}

export function parseCommaList(value?: string): string[] {
  if (value?.trim().startsWith("[")) {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) throw new Error("Expected a JSON array of folder paths.");
    return parsed.map((item: string) => item.trim()).filter(Boolean);
  }
  return (value || "")
    .split(/[,\n]/)
    .map((value) => value.trim())
    .filter(Boolean);
}
