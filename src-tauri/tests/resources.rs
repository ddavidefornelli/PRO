//! Real temporary files only; never launches an application or touches user documents.
use pro_lib::resources::{safe_file, safe_link};
use std::{
    fs,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};

struct Sandbox(PathBuf);
impl Sandbox {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "pro-resource-test-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn file(&self, name: &str) -> PathBuf {
        let path = self.0.join(name);
        fs::write(&path, b"Fixture document, never opened").unwrap();
        path
    }
}
impl Drop for Sandbox {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}
macro_rules! document {
    ($name:ident, $extension:literal) => {
        #[test]
        fn $name() {
            let dir = Sandbox::new();
            let file = dir.file(concat!("document.", $extension));
            assert_eq!(
                safe_file(file.to_str().unwrap()).unwrap(),
                file.canonicalize().unwrap()
            );
        }
    };
}
document!(pdf, "pdf");
document!(text, "txt");
document!(markdown, "md");
document!(csv, "csv");
document!(json, "json");
document!(png, "png");
document!(jpg, "jpg");
document!(jpeg, "jpeg");
document!(gif, "gif");
document!(webp, "webp");
document!(word, "docx");
document!(excel, "xlsx");
document!(powerpoint, "pptx");
document!(opendocument_text, "odt");
document!(opendocument_sheet, "ods");
document!(opendocument_slides, "odp");
document!(uppercase_extension, "PDF");

#[test]
fn scripts_executables_shortcuts_and_double_extensions_are_rejected() {
    let dir = Sandbox::new();
    for name in [
        "bad.exe",
        "bad.bat",
        "bad.cmd",
        "bad.ps1",
        "bad.sh",
        "bad.app",
        "bad.command",
        "bad.scpt",
        "bad.js",
        "bad.py",
        "bad.jar",
        "bad.lnk",
        "bad.url",
        "bad.html",
        "bad.svg",
        "bad.dmg",
        "bad.zip",
        "bad",
        "invoice.pdf.exe",
    ] {
        assert!(
            safe_file(dir.file(name).to_str().unwrap()).is_err(),
            "{name}"
        );
    }
}
#[test]
fn missing_files_directories_relative_and_control_character_paths_are_rejected() {
    let dir = Sandbox::new();
    for path in [
        dir.0.join("missing.pdf").to_string_lossy().into_owned(),
        dir.0.to_string_lossy().into_owned(),
        "relative.pdf".into(),
        "".into(),
        "/tmp/file\0.pdf".into(),
        "/tmp/file\n.pdf".into(),
        "//server/private.pdf".into(),
        "\\\\server\\share\\file.pdf".into(),
        "\\\\?\\UNC\\server\\file.pdf".into(),
    ] {
        assert!(safe_file(&path).is_err(), "{path:?}");
    }
}
#[test]
fn spaces_unicode_and_dot_segments_resolve_to_a_supported_local_document() {
    let dir = Sandbox::new();
    let file = dir.file("Résumé 🧪 with spaces.PDF");
    let path = dir.0.join(".").join("Résumé 🧪 with spaces.PDF");
    assert_eq!(
        safe_file(path.to_str().unwrap()).unwrap(),
        file.canonicalize().unwrap()
    );
}
#[cfg(unix)]
#[test]
fn executable_permissions_reject_even_an_allowlisted_extension() {
    use std::os::unix::fs::PermissionsExt;
    let dir = Sandbox::new();
    let file = dir.file("executable.pdf");
    for mode in [0o700, 0o610, 0o601, 0o755] {
        fs::set_permissions(&file, fs::Permissions::from_mode(mode)).unwrap();
        assert!(safe_file(file.to_str().unwrap()).is_err(), "mode {mode:o}");
    }
    fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).unwrap();
    assert!(safe_file(file.to_str().unwrap()).is_ok());
}
#[cfg(unix)]
#[test]
fn symlinks_revalidate_the_canonical_target_not_the_friendly_filename() {
    use std::os::unix::fs::symlink;
    let dir = Sandbox::new();
    let executable = dir.file("danger.sh");
    let alias = dir.0.join("invoice.pdf");
    symlink(&executable, &alias).unwrap();
    assert!(safe_file(alias.to_str().unwrap()).is_err());
    fs::remove_file(&alias).unwrap();
    let doc = dir.file("real.pdf");
    symlink(&doc, &alias).unwrap();
    assert_eq!(
        safe_file(alias.to_str().unwrap()).unwrap(),
        doc.canonicalize().unwrap()
    );
    fs::remove_file(&doc).unwrap();
    assert!(safe_file(alias.to_str().unwrap()).is_err());
}
#[test]
fn unsafe_link_matrix_never_reaches_the_default_application() {
    for url in [
        "",
        "example.com",
        "//example.com",
        "file:///tmp/doc.pdf",
        "javascript:alert(1)",
        "data:text/html,evil",
        "mailto:private@example.com",
        "ms-settings:display",
        "ftp://example.com",
        "https://user@example.com",
        "https://user:pass@example.com",
        "https://:password@example.com",
        "https://example.com\nattack",
        "https://example.com/\0",
        "http://",
        "https://[broken",
    ] {
        assert!(safe_link(url).is_err(), "{url:?}");
    }
}
#[test]
fn valid_links_preserve_query_fragments_unicode_hosts_and_explicit_ports() {
    for url in [
        "https://example.com",
        "http://example.com:8080/a?b=c#d",
        "https://例え.テスト/path",
        "https://[::1]/path",
        "https://example.com/path%20with%20spaces",
        "HTTPS://EXAMPLE.COM/path",
    ] {
        let safe = safe_link(url).unwrap();
        let parsed = url::Url::parse(&safe).unwrap();
        assert!(matches!(parsed.scheme(), "http" | "https"));
        assert!(parsed.host_str().is_some());
        assert!(parsed.username().is_empty());
        assert!(parsed.password().is_none());
    }
}
