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
    fs::write(blob_path(&app, &name)?, blob).map_err(|e| format!("secure write: {e}"))
}

// Ok(None) = nothing stored under this name yet — first boot, not an error.
#[tauri::command]
pub async fn secure_get(app: tauri::AppHandle, name: String) -> Result<Option<String>, String> {
    valid_name(&name)?;
    let path = blob_path(&app, &name)?;
    if !path.exists() { return Ok(None); }
    let blob = fs::read(&path).map_err(|e| format!("secure read: {e}"))?;
    let plain = tauri::async_runtime::spawn_blocking(move || unprotect(&blob))
        .await
        .map_err(|e| format!("join: {e}"))??;
    String::from_utf8(plain).map(Some).map_err(|_| "secure store: value is not utf-8".into())
}

#[tauri::command]
pub async fn secure_del(app: tauri::AppHandle, name: String) -> Result<(), String> {
    valid_name(&name)?;
    let path = blob_path(&app, &name)?;
    if path.exists() {
        fs::remove_file(&path).map_err(|e| format!("secure delete: {e}"))?;
    }
    Ok(())
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
