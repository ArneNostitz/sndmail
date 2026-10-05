use base64::Engine;
use std::path::{Path, PathBuf};

/// Strip path separators and control characters so a hostile attachment
/// filename cannot escape the destination directory.
fn sanitize_filename(name: &str, fallback: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect();
    let cleaned = cleaned.trim().trim_start_matches('.').to_string();
    if cleaned.is_empty() {
        fallback.to_string()
    } else {
        cleaned
    }
}

/// Split "report.pdf" into ("report", ".pdf"); no extension → ("name", "").
fn split_ext(name: &str) -> (&str, &str) {
    match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    }
}

/// Pick a path in `dir` for `name` that does not collide with an existing
/// file, appending " (1)", " (2)", ... before the extension.
fn unique_path(dir: &Path, name: &str) -> PathBuf {
    let candidate = dir.join(name);
    if !candidate.exists() {
        return candidate;
    }
    let (stem, ext) = split_ext(name);
    for i in 1.. {
        let candidate = dir.join(format!("{stem} ({i}){ext}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    unreachable!()
}

/// Uniquify `name` against the names already used within one batch,
/// appending " (1)", " (2)", ... before the extension.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn batch_unique_name(used: &mut std::collections::HashSet<String>, name: &str) -> String {
    if used.insert(name.to_string()) {
        return name.to_string();
    }
    let (stem, ext) = split_ext(name);
    for i in 1.. {
        let candidate = format!("{stem} ({i}){ext}");
        if used.insert(candidate.clone()) {
            return candidate;
        }
    }
    unreachable!()
}

fn decode_base64(data: &str) -> Result<Vec<u8>, String> {
    base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|e| format!("Invalid attachment data: {e}"))
}

/// Write attachment bytes into `dir`, never overwriting an existing file.
/// Returns the full path the file was saved to.
#[tauri::command]
pub fn save_attachment(dir: String, filename: String, data_base64: String) -> Result<String, String> {
    let bytes = decode_base64(&data_base64)?;
    let dir_path = Path::new(&dir);
    std::fs::create_dir_all(dir_path).map_err(|e| format!("Cannot create folder: {e}"))?;
    let name = sanitize_filename(&filename, "attachment");
    let path = unique_path(dir_path, &name);
    std::fs::write(&path, bytes).map_err(|e| format!("Cannot write file: {e}"))?;
    Ok(path.to_string_lossy().into_owned())
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuicklookFile {
    pub filename: String,
    pub data_base64: String,
}

/// Write the attachments to temp files and open them in macOS Quick Look —
/// the first file is shown, ←/→ inside Quick Look moves through the rest.
/// Errors on other platforms so the frontend can fall back to its own preview.
#[tauri::command]
pub fn quicklook_attachment(files: Vec<QuicklookFile>) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        if files.is_empty() {
            return Err("No files to preview".to_string());
        }
        let dir = std::env::temp_dir().join("snd-quicklook");
        std::fs::create_dir_all(&dir).map_err(|e| format!("Cannot create temp folder: {e}"))?;
        // Overwriting between invocations is fine — previewing the same file
        // twice should not pile up copies. Within one batch names must stay
        // distinct or files would clobber each other.
        let mut used = std::collections::HashSet::new();
        let mut paths = Vec::with_capacity(files.len());
        for file in &files {
            let bytes = decode_base64(&file.data_base64)?;
            let name = batch_unique_name(&mut used, &sanitize_filename(&file.filename, "attachment"));
            let path = dir.join(name);
            std::fs::write(&path, bytes).map_err(|e| format!("Cannot write temp file: {e}"))?;
            paths.push(path);
        }
        std::process::Command::new("qlmanage")
            .arg("-p")
            .args(&paths)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map_err(|e| format!("Cannot open Quick Look: {e}"))?;
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = files;
        Err("Quick Look is only available on macOS".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_strips_separators_and_leading_dots() {
        assert_eq!(sanitize_filename("../../etc/passwd", "f"), "_.._etc_passwd");
        assert_eq!(sanitize_filename("..\\evil.exe", "f"), "_evil.exe");
        assert_eq!(sanitize_filename("  ", "fallback"), "fallback");
        assert_eq!(sanitize_filename("report.pdf", "f"), "report.pdf");
    }

    #[test]
    fn batch_unique_name_appends_counter_within_batch() {
        let mut used = std::collections::HashSet::new();
        assert_eq!(batch_unique_name(&mut used, "a.pdf"), "a.pdf");
        assert_eq!(batch_unique_name(&mut used, "a.pdf"), "a (1).pdf");
        assert_eq!(batch_unique_name(&mut used, "a.pdf"), "a (2).pdf");
        assert_eq!(batch_unique_name(&mut used, "b"), "b");
        assert_eq!(batch_unique_name(&mut used, "b"), "b (1)");
    }

    #[test]
    fn unique_path_appends_counter() {
        let dir = std::env::temp_dir().join(format!("snd-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.txt"), b"x").unwrap();
        assert_eq!(unique_path(&dir, "a.txt"), dir.join("a (1).txt"));
        std::fs::write(dir.join("a (1).txt"), b"x").unwrap();
        assert_eq!(unique_path(&dir, "a.txt"), dir.join("a (2).txt"));
        assert_eq!(unique_path(&dir, "b.txt"), dir.join("b.txt"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
