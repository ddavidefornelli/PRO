use crate::cloud::{CommandError, Result};
use std::path::{Path, PathBuf};

pub fn safe_link(target: &str) -> Result<String> {
    let bad = || {
        CommandError::new(
            "validation",
            "Only HTTP/HTTPS links without credentials can be opened.",
        )
    };
    let url = url::Url::parse(target).map_err(|_| bad())?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || target.chars().any(char::is_control)
    {
        return Err(bad());
    }
    Ok(url.to_string())
}
pub fn safe_file(target: &str) -> Result<PathBuf> {
    let bad = || {
        CommandError::new("validation", "This file is unavailable on this device or is not a supported local document. Reattach it on this device; executable files and network paths are not supported.")
    };
    let path = Path::new(target);
    if !path.is_absolute() || target.starts_with("//") || target.chars().any(char::is_control) {
        return Err(bad());
    }
    #[cfg(not(windows))]
    if target.starts_with("\\\\") {
        return Err(bad());
    }
    #[cfg(windows)]
    if !local_windows_path(path) {
        return Err(bad());
    }
    let path = path.canonicalize().map_err(|_| bad())?;
    #[cfg(windows)]
    if !local_windows_path(&path) {
        return Err(bad());
    }
    let metadata = path.metadata().map_err(|_| bad())?;
    if !metadata.is_file() {
        return Err(bad());
    }
    // Allow documents only. Files still open in their default app and may contain malicious content.
    let extension = path
        .extension()
        .and_then(|v| v.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !matches!(
        extension.as_str(),
        "pdf"
            | "txt"
            | "md"
            | "csv"
            | "json"
            | "png"
            | "jpg"
            | "jpeg"
            | "gif"
            | "webp"
            | "docx"
            | "xlsx"
            | "pptx"
            | "odt"
            | "ods"
            | "odp"
    ) {
        return Err(bad());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o111 != 0 {
            return Err(bad());
        }
    }
    Ok(path)
}

#[cfg(windows)]
fn local_windows_path(path: &Path) -> bool {
    use std::path::{Component, Prefix};
    matches!(path.components().next(), Some(Component::Prefix(prefix))
        if matches!(prefix.kind(), Prefix::Disk(_) | Prefix::VerbatimDisk(_)))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_custom_protocols_credentials_and_remote_files() {
        for link in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "https://user:pass@example.com",
            "ms-settings:test",
        ] {
            assert!(safe_link(link).is_err());
        }
        assert!(safe_link("https://example.com/path").is_ok());
        for path in [
            "relative.pdf",
            "\\\\server\\share\\test.pdf",
            "//server/share/test.pdf",
        ] {
            assert!(safe_file(path).is_err());
        }
    }
}
