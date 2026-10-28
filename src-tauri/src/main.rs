// delcc — custom frontend shell. WebView hits oj.tmathcoding.vn/api/v3 directly.
// pass #55: windows-subsystem UNCONDITIONALLY (was release-only) - a debug build ran
// as a console-subsystem app, so the oracle carried a blank companion console window
// next to the app. Official ships the same way. The shell prints nothing to stdout.
#![windows_subsystem = "windows"]

use std::collections::HashMap;
use std::sync::OnceLock;

mod fonts;
mod cph;
use cph::{cph_compile, cph_detect, cph_run, cph_set_override, cph_stop, CphState};

// pass #65: ONE shared client per process. Per-call builds paid a fresh TLS
// handshake + pool teardown on every request — the 10-30s polls and the 500-page
// rankings sweep all route through here. Builder failure is a dead TLS stack:
// fatal, so get_or_init panics instead of per-call Err strings.
fn http() -> &'static reqwest::Client {
    static HTTP: OnceLock<reqwest::Client> = OnceLock::new();
    HTTP.get_or_init(|| {
        reqwest::Client::builder()
            .http1_only()
            .user_agent(concat!("delcc/", env!("CARGO_PKG_VERSION")))
            // pass #78 (Sonnet S5): redirect policy made explicit — the pinned-host
            // posture. Same-host redirects (Django slash normalization etc.) follow,
            // bounded; anything that would land off the judge stops with the 3xx
            // response, so the caller sees the status honestly instead of a surprise
            // host receiving the request.
            .redirect(reqwest::redirect::Policy::custom(|attempt| {
                if attempt.previous().len() >= 3 {
                    return attempt.error("too many redirects");
                }
                match (attempt.url().scheme(), attempt.url().host_str()) {
                    ("https", Some("oj.tmathcoding.vn")) => attempt.follow(),
                    _ => attempt.stop(),
                }
            }))
            .build()
            .expect("delcc http client")
    })
}
// pass #18: same-origin HTML GET for the public site (avatar harvest). The webview
// fetch is CORS-blocked on profile pages; the shell talks, the page renders.
#[tauri::command]
async fn site_fetch(path: String) -> Result<String, String> {
    const BASE: &str = "https://oj.tmathcoding.vn";
    if !path.starts_with('/') || path.contains("..") { return Err("bad path".into()); }
    let resp = http().get(format!("{BASE}{path}")).timeout(std::time::Duration::from_secs(15)).send().await.map_err(|e| format!("send: {e}"))?;
    let status = resp.status().as_u16();
    let text = resp.text().await.map_err(|e| format!("body: {e}"))?;
    serde_json::to_string(&serde_json::json!({ "status": status, "body": text }))
        .map_err(|e| format!("encode: {e}"))
}
// pass #10: installed font families for the settings font picker
use fonts::fonts_list;

// Rust-side HTTP transport. The WebView fetch stack proved unreliable on this
// box (plain `fetch` to a CORS-open endpoint still died with `Failed to fetch`,
// while curl + python had zero trouble). So: the shell does the talking, the
// page does the rendering. Same trick the official client uses — except ours
// is inspectable right here. Returns {status, body} as JSON text; the frontend
// decides what statuses mean.
#[tauri::command]
async fn api_fetch(
    method: String,
    path: String,
    body: Option<String>,
    headers: HashMap<String, String>,
) -> Result<String, String> {
    const BASE: &str = "https://oj.tmathcoding.vn/api/v3";
    // pass #78 (Sonnet S5): the path guard site_fetch has always had, copied here — the
    // WebView is content, not a trusted caller. Scoped to the path portion only: query
    // strings legitimately carry user search text (fuzzy filters may contain dots).
    let (ppath, _query) = match path.split_once('?') {
        Some((p, q)) => (p, Some(q)),
        None => (path.as_str(), None),
    };
    if !ppath.starts_with('/') || ppath.contains("..") { return Err("bad path".into()); }
    let mut req = http().request(
        method.parse::<reqwest::Method>().map_err(|e| format!("method: {e}"))?,
        format!("{BASE}{path}"),
    );
    for (k, v) in &headers {
        req = req.header(k, v);
    }
    // NOTE: do NOT force Content-Type here. The frontend already sends it,
    // and reqwest appends a second copy instead of replacing — the pair of
    // identical `content-type` headers is exactly what the WAF bounced with
    // `Invalid HTTP Header: 'CONTENT-TYPE'` (captured byte-for-byte 2026-10-15).
    if let Some(b) = body {
        req = req.body(b);
    }
    let resp = req.timeout(std::time::Duration::from_secs(30)).send().await.map_err(|e| format!("send: {e}"))?;
    let status = resp.status().as_u16();
    let text = resp.text().await.map_err(|e| format!("body: {e}"))?;
    serde_json::to_string(&serde_json::json!({ "status": status, "body": text }))
        .map_err(|e| format!("encode: {e}"))
}

pub const DELCC_LAYOUT: &str = match option_env!("DELCC_LAYOUT") {
    Some(s) => s,
    None => "baseplate",
};

#[tauri::command]
fn get_layout() -> String {
    DELCC_LAYOUT.to_string()
}

// System-browser opener for the Google PKCE step. https only; the URL is a single
// argv entry for the OS opener, never passed through a shell.
// pass #78 (Sonnet S6): host allowlist — open_url is the only path from webview
// content to the OS shell, so it opens only hosts delcc has a reason to open: the
// judge, the Google OAuth consent page, the project's GitHub (repo + release
// downloads; the browser follows GitHub's own redirects, not us), and YouTube
// (About-pane video links). Rejections are honest errors the caller can show.
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    if !url.starts_with("https://") {
        return Err("only https:// urls".into());
    }
    const ALLOWED: &[&str] = &[
        "oj.tmathcoding.vn",                            // the judge itself
        "downloads.tmathcoding.vn",                     // official release feed installer_url (probe 2026-10-27)
        "accounts.google.com",                          // Google OAuth consent (PKCE step)
        "github.com", "objects.githubusercontent.com",  // repo + release downloads
        "www.youtube.com", "www.youtube-nocookie.com", "youtu.be", "m.youtube.com",
    ];
    let parsed = reqwest::Url::parse(&url).map_err(|e| format!("url: {e}"))?;
    let host = parsed.host_str().unwrap_or("");
    if !ALLOWED.contains(&host) {
        return Err(format!("open_url: host '{host}' is not on the allowlist"));
    }
    #[cfg(target_os = "windows")]
    let mut cmd = std::process::Command::new("explorer");
    #[cfg(target_os = "macos")]
    let mut cmd = std::process::Command::new("open");
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut cmd = std::process::Command::new("xdg-open");
    cmd.arg(&url).spawn().map(|_| ()).map_err(|e| format!("open: {e}"))
}

// The window title follows the layout's official client (tmath exe version resource:
// ProductName "TMATH Code Client" 1.0.9, read from the installed binary 2026-10-22).
fn window_title() -> &'static str {
    if DELCC_LAYOUT == "tmath" { "TMATH Code Client" } else { "delcc \u{2014} custom frontend" }
}

fn main() {
    tauri::Builder::default()
        .manage(CphState::default())
        .invoke_handler(tauri::generate_handler![api_fetch, site_fetch, get_layout, open_url, fonts_list, cph_detect, cph_set_override, cph_run, cph_compile, cph_stop])
        .setup(move |app| {
            if DELCC_LAYOUT == "tmath" {
                use tauri::Manager;
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.set_title(window_title());
                }
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building delcc")
        .run(|app, event| {
            // app exit: kill a still-running local job's process tree, drop the cached build dir
            if let tauri::RunEvent::Exit = event {
                use tauri::Manager;
                if let Some(state) = app.try_state::<CphState>() {
                    state.cleanup();
                }
            }
        });
}
