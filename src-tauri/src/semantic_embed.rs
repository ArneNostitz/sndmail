//! In-process embedding engine for local semantic search.
//!
//! Loads the pinned multilingual-e5-small ONNX model plus its tokenizer from
//! the managed model directory, runs inference on the CPU execution
//! provider, and returns L2-normalized vectors ready for cosine search.
//! Nothing stays resident by itself: the manager loads the `Embedder` on
//! demand and drops it after an idle window, so disabled or idle semantic
//! search costs no memory.

use std::path::Path;
use std::sync::Mutex;

use ndarray::{Array2, ArrayViewD};
use ort::session::Session;
use ort::value::Tensor;
use tokenizers::tokenizer::{PaddingParams, Tokenizer, TruncationParams};
use tokenizers::utils::padding::{PaddingDirection, PaddingStrategy};

/// Prefix the e5 family requires on indexed passages.
pub const PASSAGE_PREFIX: &str = "passage: ";
/// Prefix the e5 family requires on queries.
pub const QUERY_PREFIX: &str = "query: ";
/// Output width of multilingual-e5-small.
pub const DIMENSIONS: usize = 384;
/// Maximum sequence length the tokenizer enforces.
const MAX_LENGTH: usize = 512;
/// Texts encoded per encoder pass. The indexer paces its batches to a CPU
/// budget; a modest batch keeps peak memory flat while amortizing per-run
/// session overhead.
const BATCH_SIZE: usize = 8;

pub struct Embedder {
    // ort sessions run through `&mut self`, so inference goes through a lock.
    session: Mutex<Session>,
    tokenizer: Tokenizer,
}

impl Embedder {
    /// Loads the model and tokenizer from the managed model directory.
    /// Inference is capped at half the cores to honour the same CPU budget
    /// the old background indexer paced itself to.
    pub fn load(model_dir: &Path) -> Result<Self, String> {
        let model_path = model_dir.join("model.onnx");
        let tokenizer_path = model_dir.join("tokenizer.json");
        let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
        let intra_threads = (cores / 2).max(1);
        let session = Session::builder()
            .map_err(|e| format!("Cannot create the embedding session: {e}"))?
            .with_intra_threads(intra_threads)
            .map_err(|e| format!("Cannot set the embedding session threads: {e}"))?
            .commit_from_file(&model_path)
            .map_err(|e| format!("Cannot load the embedding model: {e}"))?;
        let mut tokenizer = Tokenizer::from_file(&tokenizer_path)
            .map_err(|e| format!("Cannot load the embedding tokenizer: {e}"))?;
        tokenizer.with_padding(Some(PaddingParams {
            // Pad to the longest text in each batch: the attention mask
            // makes any padding width correct, and short passages then
            // cost a fraction of a fixed 512-token run.
            strategy: PaddingStrategy::BatchLongest,
            direction: PaddingDirection::Right,
            pad_id: 0,
            pad_type_id: 0,
            pad_token: "<pad>".to_string(),
            pad_to_multiple_of: None,
        }));
        tokenizer
            .with_truncation(Some(TruncationParams {
                max_length: MAX_LENGTH,
                ..Default::default()
            }))
            .map_err(|e| format!("Cannot configure truncation: {e}"))?;
        Ok(Self {
            session: Mutex::new(session),
            tokenizer,
        })
    }

    /// Embeds indexed passages (adds the `passage:` prefix the e5 family
    /// requires). Input and output lengths match.
    pub fn embed_passages(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, String> {
        let prefixed: Vec<String> = texts
            .iter()
            .map(|text| format!("{PASSAGE_PREFIX}{text}"))
            .collect();
        self.embed_all(&prefixed)
    }

    /// Embeds a search query (adds the `query:` prefix, trimmed input).
    pub fn embed_query(&self, query: &str) -> Result<Vec<f32>, String> {
        let trimmed = query.trim();
        if trimmed.is_empty() {
            return Err("Cannot embed an empty query.".into());
        }
        let mut vectors = self.embed_all(&[format!("{QUERY_PREFIX}{trimmed}")])?;
        if vectors.len() != 1 {
            return Err("The embedding model returned no query vector.".into());
        }
        Ok(vectors.remove(0))
    }

    fn embed_all(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, String> {
        let mut out = Vec::with_capacity(texts.len());
        for chunk in texts.chunks(BATCH_SIZE) {
            out.extend(self.embed_chunk(chunk)?);
        }
        Ok(out)
    }

    fn embed_chunk(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, String> {
        let refs: Vec<&str> = texts.iter().map(|text| text.as_str()).collect();
        let encodings = self
            .tokenizer
            .encode_batch(refs, true)
            .map_err(|e| format!("Cannot tokenize text for embedding: {e}"))?;
        let batch = encodings.len();
        let seq = encodings.first().map(|e| e.get_ids().len()).unwrap_or(0);
        if seq == 0 {
            return Err("The embedding tokenizer produced an empty window.".into());
        }
        let mut ids = Vec::with_capacity(batch * seq);
        let mut mask = Vec::with_capacity(batch * seq);
        for encoding in &encodings {
            ids.extend(encoding.get_ids().iter().map(|&value| value as i64));
            mask.extend(encoding.get_attention_mask().iter().map(|&value| value as i64));
        }
        // The exported XLM-R graph declares a token_type_ids input; e5 feeds it zeros.
        let type_ids = vec![0i64; batch * seq];
        let ids = Array2::from_shape_vec((batch, seq), ids)
            .map_err(|e| format!("Cannot prepare embedding inputs: {e}"))?;
        let mask = Array2::from_shape_vec((batch, seq), mask)
            .map_err(|e| format!("Cannot prepare embedding inputs: {e}"))?;
        let type_ids = Array2::from_shape_vec((batch, seq), type_ids)
            .map_err(|e| format!("Cannot prepare embedding inputs: {e}"))?;
        // The pooling pass needs the mask after it is moved into the session.
        let mask_for_pooling = mask.clone();
        // ort takes tensors, not raw arrays: wrap each input first.
        let ids_input = Tensor::from_array(ids)
            .map_err(|e| format!("Cannot prepare embedding inputs: {e}"))?;
        let mask_input = Tensor::from_array(mask)
            .map_err(|e| format!("Cannot prepare embedding inputs: {e}"))?;
        let type_ids_input = Tensor::from_array(type_ids)
            .map_err(|e| format!("Cannot prepare embedding inputs: {e}"))?;
        let mut session = self
            .session
            .lock()
            .map_err(|_| "Cannot access the embedding session.".to_string())?;
        let outputs = session
            .run(ort::inputs![
                "input_ids" => ids_input,
                "attention_mask" => mask_input,
                "token_type_ids" => type_ids_input,
            ])
            .map_err(|e| format!("Cannot run the embedding model: {e}"))?;
        let hidden: ArrayViewD<f32> = outputs["last_hidden_state"]
            .try_extract_array::<f32>()
            .map_err(|e| format!("Cannot read the embedding output: {e}"))?;
        pool_and_normalize(hidden, &mask_for_pooling)
    }
}

/// Attention-mask-weighted mean pooling over the last hidden state, followed
/// by L2 normalization — the pooling the e5 family specifies.
fn pool_and_normalize(
    hidden: ArrayViewD<f32>,
    mask: &Array2<i64>,
) -> Result<Vec<Vec<f32>>, String> {
    let shape = hidden.shape();
    if shape.len() != 3 {
        return Err("Unexpected embedding output shape.".into());
    }
    let (batch, seq, width) = (shape[0], shape[1], shape[2]);
    if width != DIMENSIONS {
        return Err(format!("Unexpected embedding width: {width}"));
    }
    let mut pooled = vec![vec![0f32; width]; batch];
    for b in 0..batch {
        let mut attended = 0usize;
        for s in 0..seq {
            if mask.get((b, s)).copied().unwrap_or(0) == 0 {
                continue;
            }
            attended += 1;
            for d in 0..width {
                pooled[b][d] += hidden[[b, s, d]];
            }
        }
        if attended == 0 {
            return Err("The embedding model attended to no tokens.".into());
        }
        let norm: f32 = pooled[b].iter().map(|value| value * value).sum::<f32>().sqrt();
        if !norm.is_finite() || norm < 1e-6 {
            return Err("The embedding model produced a degenerate vector.".into());
        }
        let scale = 1.0 / norm;
        for value in &mut pooled[b] {
            *value *= scale;
        }
    }
    Ok(pooled)
}
