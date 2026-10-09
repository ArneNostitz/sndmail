//! Sidecar vector store for local semantic search.
//!
//! A single SQLite database (`vectors.db`) owned exclusively by the Rust
//! process. Passages and their pinned model vectors are upserted
//! incrementally by the in-process indexer; queries brute-force cosine over
//! the stored vectors and only materialize the winning rows. There is no
//! resident server and nothing runs while semantic search is off.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::time::Duration;

use serde_json::Value as Json;
use sqlx::sqlite::{
    SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteSynchronous,
};
use sqlx::{Row, SqlitePool};

use crate::semantic_documents::{PassageDoc, SEMANTIC_VERSION};
use crate::semantic_embed::DIMENSIONS;

/// Minimum cosine similarity for a passage to count as a match. Mirrors the
/// distance filter the old Typesense searcher applied; tune if semantic
/// results are too sparse or too noisy.
const MIN_COSINE: f32 = 0.5;
/// Rows fetched per chunk while scanning vectors; keeps a single query's
/// memory bounded on large indexes.
const SCAN_CHUNK: i64 = 2_000;
/// Bind-variable batch for `IN (...)` statements (SQLite parameter limit).
const ID_CHUNK: usize = 500;
/// Bytes per stored vector: `DIMENSIONS` f32 values, little-endian.
const VEC_BYTES: usize = DIMENSIONS * 4;

pub struct VectorStore {
    pool: SqlitePool,
}

pub struct ScoredPassage {
    pub doc: PassageDoc,
    pub score: f32,
}

impl VectorStore {
    /// Opens (creating if needed) the sidecar database under the semantic
    /// search data root and reconciles its schema version.
    pub async fn open(root: &Path) -> Result<Self, String> {
        let path = root.join("vectors.db");
        let options = SqliteConnectOptions::new()
            .filename(&path)
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal)
            .synchronous(SqliteSynchronous::Normal)
            .busy_timeout(Duration::from_secs(5));
        let pool = SqlitePoolOptions::new()
            .max_connections(2)
            .connect_with(options)
            .await
            .map_err(|e| format!("Cannot open the semantic index database: {e}"))?;
        let store = Self { pool };
        store.initialize().await?;
        Ok(store)
    }

    async fn initialize(&self) -> Result<(), String> {
        for statement in [
            "CREATE TABLE IF NOT EXISTS passages (\
id TEXT PRIMARY KEY, \
message_fingerprint TEXT NOT NULL, \
title TEXT NOT NULL, \
subtitle TEXT, \
snippet TEXT NOT NULL, \
content TEXT NOT NULL, \
tags TEXT NOT NULL, \
metadata TEXT NOT NULL, \
account_id TEXT NOT NULL, \
thread_id TEXT NOT NULL, \
message_id TEXT NOT NULL, \
vec BLOB NOT NULL)",
            "CREATE INDEX IF NOT EXISTS passages_message_id ON passages (message_id)",
            "CREATE TABLE IF NOT EXISTS semantic_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
        ] {
            sqlx::query(statement)
                .execute(&self.pool)
                .await
                .map_err(|e| format!("Cannot prepare the semantic index database: {e}"))?;
        }
        let existing: Option<String> = sqlx::query(
            "SELECT value FROM semantic_meta WHERE key = 'schema_version'",
        )
        .fetch_optional(&self.pool)
        .await
        .map_err(|e| format!("Cannot read the semantic index version: {e}"))?
        .and_then(|row| row.try_get::<String, _>("value").ok());
        match existing {
            Some(version) if version == SEMANTIC_VERSION => {}
            _ => {
                // Fresh database or passages built by a different index
                // format: start over so vectors always match the format
                // they will be searched with.
                sqlx::query("DELETE FROM passages")
                    .execute(&self.pool)
                    .await
                    .map_err(|e| format!("Cannot reset the semantic index: {e}"))?;
                sqlx::query(
                    "INSERT OR REPLACE INTO semantic_meta (key, value) VALUES ('schema_version', ?)",
                )
                .bind(SEMANTIC_VERSION)
                .execute(&self.pool)
                .await
                .map_err(|e| format!("Cannot record the semantic index version: {e}"))?;
            }
        }
        Ok(())
    }

    /// Number of indexed passages.
    pub async fn count_passages(&self) -> Result<u64, String> {
        let row = sqlx::query("SELECT COUNT(*) AS n FROM passages")
            .fetch_one(&self.pool)
            .await
            .map_err(|e| format!("Cannot count indexed passages: {e}"))?;
        let n: i64 = row
            .try_get("n")
            .map_err(|e| format!("Cannot count indexed passages: {e}"))?;
        Ok(n.max(0) as u64)
    }

    /// Stored fingerprint per indexed message — all passages of one message
    /// share it, so a single row per message suffices.
    pub async fn message_fingerprints(&self) -> Result<HashMap<String, String>, String> {
        let rows = sqlx::query(
            "SELECT message_id, MIN(message_fingerprint) AS message_fingerprint \
FROM passages GROUP BY message_id",
        )
        .fetch_all(&self.pool)
        .await
        .map_err(|e| format!("Cannot read indexed messages: {e}"))?;
        let mut out = HashMap::with_capacity(rows.len());
        for row in rows {
            let message_id: String = row
                .try_get("message_id")
                .map_err(|e| format!("Cannot read indexed messages: {e}"))?;
            let message_fingerprint: String = row
                .try_get("message_fingerprint")
                .map_err(|e| format!("Cannot read indexed messages: {e}"))?;
            out.insert(message_id, message_fingerprint);
        }
        Ok(out)
    }

    /// Atomically replaces all passages of one message.
    pub async fn replace_message_passages(
        &self,
        message_id: &str,
        docs: &[PassageDoc],
        vectors: &[Vec<f32>],
    ) -> Result<(), String> {
        if docs.len() != vectors.len() {
            return Err("Passage/vector count mismatch while indexing.".into());
        }
        let mut tx = self
            .pool
            .begin()
            .await
            .map_err(|e| format!("Cannot start a semantic index write: {e}"))?;
        sqlx::query("DELETE FROM passages WHERE message_id = ?")
            .bind(message_id)
            .execute(&mut *tx)
            .await
            .map_err(|e| format!("Cannot replace indexed passages: {e}"))?;
        for (doc, vector) in docs.iter().zip(vectors) {
            if vector.len() != DIMENSIONS {
                return Err(format!(
                    "Unexpected vector width for an indexed passage: {}",
                    vector.len()
                ));
            }
            let mut bytes = Vec::with_capacity(VEC_BYTES);
            for value in vector {
                bytes.extend_from_slice(&value.to_le_bytes());
            }
            let tags = serde_json::to_string(&doc.tags).unwrap_or_else(|_| "[]".into());
            let metadata = serde_json::to_string(&doc.metadata).unwrap_or_else(|_| "{}".into());
            sqlx::query(
                "INSERT OR REPLACE INTO passages \
(id, message_fingerprint, title, subtitle, snippet, content, tags, metadata, \
account_id, thread_id, message_id, vec) \
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(&doc.id)
            .bind(&doc.message_fingerprint)
            .bind(&doc.title)
            .bind(doc.subtitle.as_deref())
            .bind(doc.snippet.as_str())
            .bind(&doc.content)
            .bind(&tags)
            .bind(&metadata)
            .bind(&doc.account_id)
            .bind(&doc.thread_id)
            .bind(&doc.message_id)
            .bind(&bytes)
            .execute(&mut *tx)
            .await
            .map_err(|e| format!("Cannot store an indexed passage: {e}"))?;
        }
        tx.commit()
            .await
            .map_err(|e| format!("Cannot commit indexed passages: {e}"))?;
        Ok(())
    }

    /// Drops passages whose message is no longer present in the mail
    /// database. Returns the number of removed passages.
    pub async fn prune_messages(&self, live_message_ids: &[String]) -> Result<u64, String> {
        let live: HashSet<&str> = live_message_ids.iter().map(|id| id.as_str()).collect();
        let stored: Vec<String> = sqlx::query("SELECT DISTINCT message_id FROM passages")
            .fetch_all(&self.pool)
            .await
            .map_err(|e| format!("Cannot read indexed messages: {e}"))?
            .into_iter()
            .map(|row| {
                row.try_get::<String, _>("message_id")
                    .unwrap_or_default()
            })
            .collect();
        let dead: Vec<String> = stored
            .into_iter()
            .filter(|id| !live.contains(id.as_str()))
            .collect();
        let mut removed = 0u64;
        for chunk in dead.chunks(ID_CHUNK) {
            let placeholders = vec!["?"; chunk.len()].join(", ");
            let sql = format!("DELETE FROM passages WHERE message_id IN ({placeholders})");
            let mut query = sqlx::query(&sql);
            for id in chunk {
                query = query.bind(id.as_str());
            }
            let result = query
                .execute(&self.pool)
                .await
                .map_err(|e| format!("Cannot prune stale passages: {e}"))?;
            removed += result.rows_affected();
        }
        Ok(removed)
    }

    /// Empties the index (reindex entry point).
    pub async fn clear(&self) -> Result<(), String> {
        sqlx::query("DELETE FROM passages")
            .execute(&self.pool)
            .await
            .map_err(|e| format!("Cannot clear the semantic index: {e}"))?;
        Ok(())
    }

    /// Brute-force cosine search over all stored vectors, chunked so memory
    /// stays bounded; only the winning rows are materialized in full.
    pub async fn search(
        &self,
        query_vector: &[f32],
        limit: usize,
    ) -> Result<Vec<ScoredPassage>, String> {
        let limit = limit.clamp(1, 100);
        let query = normalize(query_vector)?;
        let mut scored: Vec<(String, f32)> = Vec::new();
        let mut cursor: i64 = 0;
        loop {
            let rows = sqlx::query(
                "SELECT rowid, id, vec FROM passages WHERE rowid > ? ORDER BY rowid LIMIT ?",
            )
            .bind(cursor)
            .bind(SCAN_CHUNK)
            .fetch_all(&self.pool)
            .await
            .map_err(|e| format!("Cannot scan the semantic index: {e}"))?;
            if rows.is_empty() {
                break;
            }
            for row in &rows {
                cursor = row
                    .try_get::<i64, _>("rowid")
                    .map_err(|e| format!("Cannot scan the semantic index: {e}"))?;
                let id: String = row
                    .try_get("id")
                    .map_err(|e| format!("Cannot scan the semantic index: {e}"))?;
                let blob: Vec<u8> = row
                    .try_get("vec")
                    .map_err(|e| format!("Cannot scan the semantic index: {e}"))?;
                if let Some(similarity) = cosine(&query, &blob) {
                    if similarity >= MIN_COSINE {
                        scored.push((id, similarity));
                    }
                }
            }
            if (rows.len() as i64) < SCAN_CHUNK {
                break;
            }
        }
        scored.sort_by(|a, b| b.1.total_cmp(&a.1));
        scored.truncate(limit);
        if scored.is_empty() {
            return Ok(Vec::new());
        }
        let ids: Vec<String> = scored.iter().map(|(id, _)| id.clone()).collect();
        let mut docs = self.load_passages(&ids).await?;
        Ok(scored
            .into_iter()
            .filter_map(|(id, score)| {
                docs.remove(&id).map(|doc| ScoredPassage { doc, score })
            })
            .collect())
    }

    async fn load_passages(&self, ids: &[String]) -> Result<HashMap<String, PassageDoc>, String> {
        let mut docs = HashMap::new();
        for chunk in ids.chunks(ID_CHUNK) {
            let placeholders = vec!["?"; chunk.len()].join(", ");
            let sql = format!(
                "SELECT id, message_fingerprint, title, subtitle, snippet, content, tags, \
metadata, account_id, thread_id, message_id FROM passages WHERE id IN ({placeholders})"
            );
            let mut query = sqlx::query(&sql);
            for id in chunk {
                query = query.bind(id.as_str());
            }
            let rows = query
                .fetch_all(&self.pool)
                .await
                .map_err(|e| format!("Cannot load matched passages: {e}"))?;
            for row in rows {
                let id: String = row
                    .try_get("id")
                    .map_err(|e| format!("Cannot load matched passages: {e}"))?;
                let tags_raw: String = row
                    .try_get("tags")
                    .map_err(|e| format!("Cannot load matched passages: {e}"))?;
                let metadata_raw: String = row
                    .try_get("metadata")
                    .map_err(|e| format!("Cannot load matched passages: {e}"))?;
                let title: String = row
                    .try_get("title")
                    .map_err(|e| format!("Cannot load matched passages: {e}"))?;
                let subtitle: Option<String> = row.try_get("subtitle").ok().flatten();
                let snippet: String = row
                    .try_get("snippet")
                    .map_err(|e| format!("Cannot load matched passages: {e}"))?;
                let content: String = row
                    .try_get("content")
                    .map_err(|e| format!("Cannot load matched passages: {e}"))?;
                let message_fingerprint: String = row
                    .try_get("message_fingerprint")
                    .map_err(|e| format!("Cannot load matched passages: {e}"))?;
                let account_id: String = row
                    .try_get("account_id")
                    .map_err(|e| format!("Cannot load matched passages: {e}"))?;
                let thread_id: String = row
                    .try_get("thread_id")
                    .map_err(|e| format!("Cannot load matched passages: {e}"))?;
                let message_id: String = row
                    .try_get("message_id")
                    .map_err(|e| format!("Cannot load matched passages: {e}"))?;
                let tags: Vec<String> = serde_json::from_str(&tags_raw).unwrap_or_default();
                let metadata: Json = serde_json::from_str(&metadata_raw).unwrap_or(Json::Null);
                docs.insert(
                    id,
                    PassageDoc {
                        id: row
                            .try_get("id")
                            .map_err(|e| format!("Cannot load matched passages: {e}"))?,
                        message_fingerprint,
                        title,
                        subtitle,
                        snippet,
                        content,
                        tags,
                        metadata,
                        account_id,
                        thread_id,
                        message_id,
                    },
                );
            }
        }
        Ok(docs)
    }
}

/// Normalizes a vector defensively so a caller cannot skew scores.
fn normalize(vector: &[f32]) -> Result<Vec<f32>, String> {
    if vector.len() != DIMENSIONS {
        return Err("Unexpected query vector width.".into());
    }
    let norm: f32 = vector.iter().map(|value| value * value).sum::<f32>().sqrt();
    if !norm.is_finite() || norm < 1e-6 {
        return Err("The embedding model produced a degenerate query vector.".into());
    }
    Ok(vector.iter().map(|value| value / norm).collect())
}

/// Cosine similarity between the normalized query and a stored vector; the
/// stored vector is defensively re-normalized so a corrupted row cannot
/// distort scores. Returns `None` for unreadable or degenerate rows.
fn cosine(query: &[f32], blob: &[u8]) -> Option<f32> {
    if blob.len() != VEC_BYTES {
        return None;
    }
    let mut norm: f32 = 0.0;
    let mut dot: f32 = 0.0;
    for (offset, q) in query.iter().enumerate() {
        let bytes = [
            blob[offset * 4],
            blob[offset * 4 + 1],
            blob[offset * 4 + 2],
            blob[offset * 4 + 3],
        ];
        let value = f32::from_le_bytes(bytes);
        if !value.is_finite() {
            return None;
        }
        norm += value * value;
        dot += q * value;
    }
    norm = norm.sqrt();
    if !norm.is_finite() || norm < 1e-6 {
        return None;
    }
    let similarity = dot / norm;
    if similarity.is_finite() {
        Some(similarity)
    } else {
        None
    }
}
