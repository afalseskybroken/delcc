// src-tauri/src/secure.rs — pass #78 (Sonnet S2): the DPAPI-protected key/value store.
// Tokens leave the webview's localStorage: the page calls secure_put/secure_get/
// secure_del, values are encrypted with CryptProtectData (user scope, machine-bound)
// and stored as blobs under <app_data>/secure/<name>.bin. DPAPI is NOT a sandbox —
// anything already running as the same Windows user can decrypt these blobs, exactly
// like it could steal the official client's Credential Manager entry. The honest
// boundary it moves: from "read a plaintext file" to "run code as the user" — which is
// the documented posture (SECURITY.md, "Authentication data at rest").

use std::fs;
use std::path::PathBuf;
use tauri::Manager;

const MAX_VALUE: usize = 256 * 1024; // tokens + profile lists are KBs; reject absurd sizes

fn valid_name(name: &str) -> Result<(), String> {
    let ok = !name.is_empty()
        && name.len() <= 64
        && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
    if ok { Ok(()) } else { Err("bad secure-store name".into()) }
}

fn blob_path(app: &tauri::AppHandle, name: &str) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| format!("app data dir: {e}"))?.join("secure");
    fs::create_dir_all(&dir).map_err(|e| format!("secure dir: {e}"))?;
    Ok(dir.join(format!("{name}.bin")))
}

// pass #158 (wave-c C4c/L12): the ciphertext is size-capped BEFORE the read — a
// corrupted or hand-planted oversized blob cannot allocate unbounded memory (the
// 256 KiB write limit has ~4x headroom for the DPAPI wrapper).
const MAX_BLOB: u64 = 1024 * 1024;

// pass #163 (wave-12 W12-11): read a secure blob with NotFound → Ok(None) — the
// first-boot contract secure_get promises. #158's metadata pre-check turned a missing
// file into a hard Err("secure read: …"), so a clean first boot looked like a store
// failure. NotFound (on stat OR the read) → None; every other error still propagates.
// Path-based and pure so the missing/present/oversized cases are testable without an
// AppHandle (the DPAPI roundtrip stays in the windows-gated tests below).
fn read_capped_blob(path: &std::path::Path) -> Result<Option<Vec<u8>>, String> {
    let meta = match fs::metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("secure read: {e}")),
    };
    if meta.len() > MAX_BLOB {
        return Err("secure store: blob exceeds the size bound".into());
    }
    match fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("secure read: {e}")),
    }
}

#[cfg(all(windows, feature = "secure-store"))]
mod dpapi {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN,
    };

    fn last_err(what: &str) -> String {
        format!("{what}: {}", std::io::Error::last_os_error())
    }

    pub fn protect(plain: &[u8]) -> Result<Vec<u8>, String> {
        unsafe {
            let input = CRYPT_INTEGER_BLOB { cbData: plain.len() as u32, pbData: plain.as_ptr() as *mut u8 };
            let mut out = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
            // CRYPTPROTECT_UI_FORBIDDEN: a headless shell must never pop a prompt.
            let ok = CryptProtectData(
                &input, std::ptr::null(), std::ptr::null_mut(), std::ptr::null_mut(),
                std::ptr::null_mut(), CRYPTPROTECT_UI_FORBIDDEN, &mut out,
            );
            if ok == 0 { return Err(last_err("CryptProtectData")); }
            let bytes = std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec();
            LocalFree(out.pbData.cast());
            Ok(bytes)
        }
    }

    pub fn unprotect(blob: &[u8]) -> Result<Vec<u8>, String> {
        unsafe {
            let input = CRYPT_INTEGER_BLOB { cbData: blob.len() as u32, pbData: blob.as_ptr() as *mut u8 };
            let mut out = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };
            let ok = CryptUnprotectData(
                &input, std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null_mut(),
                std::ptr::null_mut(), CRYPTPROTECT_UI_FORBIDDEN, &mut out,
            );
            if ok == 0 { return Err(last_err("CryptUnprotectData")); }
            let bytes = std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec();
            LocalFree(out.pbData.cast());
            Ok(bytes)
        }
    }
}

#[cfg(all(windows, feature = "secure-store"))]
use dpapi::{protect, unprotect};

#[cfg(not(all(windows, feature = "secure-store")))]
fn protect(_plain: &[u8]) -> Result<Vec<u8>, String> {
    Err("secure store requires Windows (DPAPI)".into())
}
#[cfg(not(all(windows, feature = "secure-store")))]
fn unprotect(_blob: &[u8]) -> Result<Vec<u8>, String> {
    Err("secure store requires Windows (DPAPI)".into())
}

#[tauri::command]
pub async fn secure_put(app: tauri::AppHandle, name: String, plaintext: String) -> Result<(), String> {
    valid_name(&name)?;
    if plaintext.len() > MAX_VALUE {
        return Err("secure store: value too large".into());
    }
    let blob = tauri::async_runtime::spawn_blocking(move || protect(plaintext.as_bytes()))
        .await
        .map_err(|e| format!("join: {e}"))??;
    // pass #144 (wave-8 W8-L11): the file write rides spawn_blocking too — DPAPI was
    // already off-thread, but the fs write sat on the IPC thread.
    // pass #163 (wave-12 W12-12): blob_path (create_dir_all) rides the SAME closure —
    // it was still on the async path, the exact blocking-I/O-on-IPC class #158 fixed
    // for secure_get. The whole put now touches the filesystem only off-thread.
    tauri::async_runtime::spawn_blocking(move || {
        let path = blob_path(&app, &name)?;
        fs::write(path, blob).map_err(|e| format!("secure write: {e}"))
    })
        .await
        .map_err(|e| format!("join: {e}"))?
}

// Ok(None) = nothing stored under this name yet — first boot, not an error.
#[tauri::command]
pub async fn secure_get(app: tauri::AppHandle, name: String) -> Result<Option<String>, String> {
    valid_name(&name)?;
    // pass #158 (wave-c C4c/L13): blob_path (create_dir_all included) moves INTO the
    // blocking closure — the async path no longer touches the filesystem.
    let path = tauri::async_runtime::spawn_blocking(move || blob_path(&app, &name))
        .await
        .map_err(|e| format!("join: {e}"))??;
    // pass #163 (wave-12 W12-11): the capped read with NotFound → Ok(None) lives in
    // read_capped_blob (the first-boot contract; #158's pre-check had turned a missing
    // file into a hard Err). It rides spawn_blocking like every other fs touch here.
    let blob = tauri::async_runtime::spawn_blocking(move || read_capped_blob(&path))
        .await
        .map_err(|e| format!("join: {e}"))??;
    let Some(blob) = blob else { return Ok(None); };
    let plain = tauri::async_runtime::spawn_blocking(move || unprotect(&blob))
        .await
        .map_err(|e| format!("join: {e}"))??;
    String::from_utf8(plain).map(Some).map_err(|_| "secure store: value is not utf-8".into())
}

#[tauri::command]
pub async fn secure_del(app: tauri::AppHandle, name: String) -> Result<(), String> {
    valid_name(&name)?;
    // pass #144 (W8-L11): the delete is blocking file I/O — off the IPC thread.
    // pass #163 (wave-12 W12-12): blob_path (create_dir_all) rides the SAME closure,
    // off the async path, matching secure_get/secure_put.
    tauri::async_runtime::spawn_blocking(move || {
        let path = blob_path(&app, &name)?;
        if path.exists() {
            fs::remove_file(&path).map_err(|e| format!("secure delete: {e}"))?;
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("join: {e}"))?
}

#[cfg(test)]
mod blob_tests {
    use super::*;

    // pass #163 (wave-12 W12-11): the first-boot contract — a missing blob is Ok(None),
    // not an Err (#158's metadata pre-check had turned NotFound into a hard error). The
    // size cap is still enforced before the read. Pure fs, so this runs on every platform.
    #[test]
    fn read_capped_blob_contract() {
        let dir = std::env::temp_dir().join(format!("delcc-secure-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        let missing = dir.join("absent.bin");
        assert_eq!(read_capped_blob(&missing).unwrap(), None, "first boot: nothing stored → Ok(None)");

        let present = dir.join("present.bin");
        fs::write(&present, b"ciphertext").unwrap();
        assert_eq!(read_capped_blob(&present).unwrap(), Some(b"ciphertext".to_vec()));

        let big = dir.join("big.bin");
        fs::write(&big, vec![0u8; (MAX_BLOB as usize) + 1]).unwrap();
        assert!(read_capped_blob(&big).is_err(), "an oversized blob is rejected before the read");

        let _ = fs::remove_dir_all(&dir);
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn protect_roundtrip() {
        let secret = "refresh-token-payload-±-unicode";
        let blob = protect(secret.as_bytes()).expect("protect");
        assert_ne!(blob, secret.as_bytes());
        let plain = unprotect(&blob).expect("unprotect");
        assert_eq!(String::from_utf8(plain).unwrap(), secret);
    }

    #[test]
    fn unprotect_rejects_garbage() {
        assert!(unprotect(b"not a dpapi blob at all").is_err());
    }

    #[test]
    fn names_are_tight() {
        assert!(valid_name("auth").is_ok());
        assert!(valid_name("profiles.v2").is_ok());
        assert!(valid_name("../evil").is_err());
        assert!(valid_name("").is_err());
        assert!(valid_name("a\\b").is_err());
        assert!(valid_name("x".repeat(65).as_str()).is_err());
    }
}
