import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { convert } from "html-to-text";
import type { UniversalDocument } from "../types";
import { workerSignal } from "../runtime-control";
import { expandPath } from "../shared";

const execFileAsync = promisify(execFile);
// Same whitespace characters as JavaScript String.trim(), used by readableBody.
const SQL_WHITESPACE = "char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)";

interface MailRow {
  rowid: number;
  id: string;
  account_id: string;
  thread_id: string;
  subject: string | null;
  from_name: string | null;
  from_address: string | null;
  to_addresses: string | null;
  snippet: string | null;
  body_text: string | null;
  body_html: string | null;
  body_length: number;
  date: number;
  account_email: string;
  labels: string;
}

// Read the live WAL through SQLite; never copy, checkpoint, or write snd's DB.
export async function collectSndDocuments(_exportPath?: string, dbPathOverride?: string, onBatch?: (documents: UniversalDocument[]) => Promise<void>): Promise<UniversalDocument[]> {
  const path = expandPath(dbPathOverride || process.env.VELO_DB_PATH || process.env.VELO_DATABASE_PATH ||
    join(homedir(), "Library", "Application Support", "com.anydaysomething.velopro", "velo.db"));
  try { await access(path); } catch {
    throw new Error(`snd database not found: ${path}. Set snd DB Path in extension preferences.`);
  }
  const documents: UniversalDocument[] = [];
  let cursor = 0;
  while (true) {
    workerSignal.throwIfAborted();
    const query = `SELECT m.rowid, m.id, m.account_id, m.thread_id, m.subject,
      m.from_name, m.from_address, m.to_addresses, m.snippet,
      substr(m.body_text, 1, 1000000) AS body_text,
      CASE WHEN length(trim(COALESCE(m.body_text,''), ${SQL_WHITESPACE})) > 0 THEN NULL ELSE substr(m.body_html, 1, 1000000) END AS body_html,
      length(CASE WHEN length(trim(COALESCE(m.body_text,''), ${SQL_WHITESPACE})) > 0 THEN m.body_text ELSE COALESCE(m.body_html,'') END) AS body_length,
      m.date, a.email AS account_email,
      (SELECT GROUP_CONCAT(COALESCE(l.name, tl.label_id), ', ')
       FROM thread_labels tl LEFT JOIN labels l ON l.account_id = tl.account_id AND l.id = tl.label_id
       WHERE tl.account_id = m.account_id AND tl.thread_id = m.thread_id) AS labels
      FROM messages m JOIN accounts a ON a.id = m.account_id
      WHERE m.rowid > ${cursor} ORDER BY m.rowid LIMIT 5;`;
    const { stdout } = await execFileAsync("/usr/bin/sqlite3", ["-readonly", "-json", "-cmd", ".timeout 3000", path, query], {
      timeout: 30000, maxBuffer: 64 * 1024 * 1024, signal: workerSignal,
    });
    const rows = JSON.parse(stdout || "[]") as MailRow[];
    if (!rows.length) break;
    for (const row of rows) {
      const sender = [row.from_name, row.from_address].filter(Boolean).join(" ");
      const readable = readableBody(row.body_text, row.body_html);
      const body = (readable || row.snippet || "").slice(0, 100000);
      const snippet = row.snippet || body.slice(0, 600);
      documents.push({
        id: createHash("sha256").update(JSON.stringify(["velo", row.account_id, row.id])).digest("hex"),
        source: "velo", title: row.subject || "(No Subject)",
        subtitle: `${sender} | ${row.labels || "Mail"} | ${row.account_email}`,
        snippet, content: [sender, row.to_addresses, body].filter(Boolean).join("\n"),
        app: "snd", open_type: "app", open_target: "com.anydaysomething.velopro",
        tags: [row.account_email, ...(row.labels || "").split(", ")].filter(Boolean),
        metadata: { account: row.account_id, accountName: row.account_email, threadId: row.thread_id,
          messageId: row.id, from: sender, to: row.to_addresses, labels: row.labels || "", folder: row.labels || "Mail",
          body_index_truncated: readable.length > 100000 || row.body_length > 1000000,
          body_missing: !row.body_length },
        updated_at: Math.trunc(row.date < 1e12 ? row.date * 1000 : row.date),
      });
      cursor = row.rowid;
    }
    if (onBatch) {
      await onBatch(documents.splice(0));
    }
  }
  return documents;
}

export function readableBody(plain: unknown, html: unknown): string {
  if (typeof plain === "string" && plain.trim()) return plain.replace(/\r\n?/g, "\n");
  return convert(String(html || ""), { wordwrap: false, limits: { maxInputLength: 1000000 }, selectors: [
    { selector: "img", format: "skip" }, { selector: "style", format: "skip" }, { selector: "script", format: "skip" },
    { selector: "a", options: { ignoreHref: true } },
  ] });
}

export interface MailContent { subject: string; body: string; from: string; to: string; date: number; truncated: boolean }

export async function readSndMessage(accountId: string, messageId: string, dbPathOverride?: string, signal?: AbortSignal): Promise<MailContent> {
  signal?.throwIfAborted();
  const path = expandPath(dbPathOverride || process.env.VELO_DB_PATH || process.env.VELO_DATABASE_PATH ||
    join(homedir(), "Library", "Application Support", "com.anydaysomething.velopro", "velo.db"));
  const literal = (value: string) => `'${value.replace(/'/g, "''")}'`;
  const query = `SELECT subject, substr(body_text,1,1000000) AS body_text, substr(body_html,1,1000000) AS body_html,
    length(CASE WHEN length(trim(COALESCE(body_text,''), ${SQL_WHITESPACE})) > 0 THEN body_text ELSE COALESCE(body_html,'') END) AS body_length, from_name, from_address, to_addresses, date, body_cached
    FROM messages WHERE account_id = ${literal(accountId)} AND id = ${literal(messageId)} LIMIT 1;`;
  const { stdout } = await execFileAsync("/usr/bin/sqlite3", ["-readonly", "-json", "-cmd", ".timeout 3000", path, query],
    { timeout: 15000, maxBuffer: 24 * 1024 * 1024, signal });
  signal?.throwIfAborted();
  const row = (JSON.parse(stdout || "[]") as Array<Record<string, unknown>>)[0];
  if (!row) throw new Error("This message is no longer in snd's local database.");
  const plain = String(row.body_text || "");
  const html = String(row.body_html || "");
  if (!plain && !html && !row.body_cached) throw new Error("This email's body has not been downloaded by snd yet. Open it in snd, then retry.");
  return { subject: String(row.subject || "(No Subject)"),
    body: readableBody(plain, html), truncated: Number(row.body_length) > 1000000,
    from: [row.from_name, row.from_address].filter(Boolean).join(" "), to: String(row.to_addresses || ""), date: Number(row.date),
  };
}
