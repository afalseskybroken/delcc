// delcc — custom frontend shell. WebView hits oj.tmathcoding.vn/api/v3 directly.
// pass #55: windows-subsystem UNCONDITIONALLY (was release-only) - a debug build ran
// as a console-subsystem app, so the oracle carried a blank companion console window
// next to the app. Official ships the same way. The shell prints nothing to stdout.
#![windows_subsystem = "windows"]

use std::collections::HashMap;
use std::sync::OnceLock;

mod fonts;
mod cph;
mod secure;
use cph::{cph_compile, cph_detect, cph_run, cph_set_override, cph_stop, CphState};
use secure::{secure_del, secure_get, secure_put};

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

// pass #83 (He): profile-provided About images render again — fetched by the SHELL, not
// the webview (the CSP stays pinned; images enter the page as data: URLs). Isolation
// posture: https-only, every redirect hop re-validated against a public host, image-only
// content types, 2 MiB cap, 10 s timeout, no cookies or tokens ever attached. The image
// host sees the viewer's IP (same as the official client). pass #96 (re-audit N2): the
// hostname is resolved ONCE, every resolved address is verified public, and the client is
// PINNED to that address — the connection can only hit the IP we verified, closing the
// classic rebind window (verify A, connect B). Disclosed residual: a redirect hop to a
// fresh host is string-checked and then resolves normally (the pin covers the original
// host only). The command carries no credentials and caps the response, so the blast
// radius is one capped-size image fetch, never a token.
fn is_public_v4(ip: std::net::Ipv4Addr) -> bool {
    let o = ip.octets();
    !(ip.is_loopback() || ip.is_private() || ip.is_link_local() || ip.is_unspecified()
        || ip.is_broadcast() || o[0] == 0
        // CGNAT 100.64.0.0/10: second octet 64..=127. (The pre-#96 mask tested == 128,
        // which blocks 100.128/10 instead — caught by the #96 table test.)
        || (o[0] == 100 && (o[1] & 0xc0) == 64)
        || (o[0] == 192 && o[1] == 0 && o[2] == 2)
        || (o[0] == 198 && (o[1] & 0xfe) == 18))
}
fn is_public_v6(ip: std::net::Ipv6Addr) -> bool {
    !(ip.is_loopback() || ip.is_unspecified()
        || (ip.segments()[0] & 0xfe00) == 0xfc00
        || (ip.segments()[0] & 0xffc0) == 0xfe80)
}
// std treats IPv4-mapped IPv6 (::ffff:a.b.c.d) as neither loopback nor private — the raw
// v6 checks let ::ffff:127.0.0.1 through. Unwrap it and judge the embedded v4.
fn is_public_ip(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v4) => is_public_v4(v4),
        std::net::IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => is_public_v4(v4),
            None => is_public_v6(v6),
        },
    }
}
fn public_https_host(url: &reqwest::Url) -> bool {
    if url.scheme() != "https" { return false; }
    match url.host_str() {
        None => false,
        Some(h) => {
            let h = h.trim_matches(|c| c == '[' || c == ']').to_lowercase();
            if h == "localhost" || h.ends_with(".localhost") || h.ends_with(".local") || h.ends_with(".internal") { return false; }
            match h.parse::<std::net::IpAddr>() {
                Ok(ip) => is_public_ip(ip),
                Err(_) => true,
            }
        }
    }
}
#[tauri::command]
async fn asset_fetch(url: String) -> Result<String, String> {
    use base64::Engine as _;
    const MAX: usize = 2 * 1024 * 1024;
    let parsed: reqwest::Url = url.parse().map_err(|_| "INVALID_ARGUMENT".to_string())?;
    if !public_https_host(&parsed) { return Err("FORBIDDEN".to_string()); }
    // pass #96: resolve once, verify every answer, pin. A hostname resolving to ANY
    // non-public address is refused outright (round-robin rebinding included).
    let mut builder = reqwest::Client::builder()
        .http1_only()
        .user_agent(concat!("delcc/", env!("CARGO_PKG_VERSION")))
        .timeout(std::time::Duration::from_secs(10));
    let host = parsed.host_str().ok_or("FORBIDDEN")?.to_string();
    let host_is_literal = host.trim_matches(|c| c == '[' || c == ']').parse::<std::net::IpAddr>().is_ok();
    if !host_is_literal {
        let target = format!("{host}:{}", parsed.port_or_known_default().unwrap_or(443));
        let addrs: Vec<std::net::SocketAddr> = tauri::async_runtime::spawn_blocking(move || {
            use std::net::ToSocketAddrs;
            target.to_socket_addrs().map(|it| it.collect()).map_err(|e| e.to_string())
        })
        .await
        .map_err(|e| format!("join: {e}"))?
        .map_err(|e| format!("DNS_RESOLUTION_FAILED {e}"))?;
        if addrs.is_empty() { return Err("DNS_RESOLUTION_FAILED empty".into()); }
        if let Some(bad) = addrs.iter().find(|a| !is_public_ip(a.ip())) {
            return Err(format!("FORBIDDEN non-public address {bad}"));
        }
        builder = builder.resolve(&host, addrs[0]);
    }
    let client = builder
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 3 { return attempt.error("too many redirects"); }
            if !public_https_host(attempt.url()) { return attempt.error("redirect to a non-public host"); }
            attempt.follow()
        }))
        .build()
        .map_err(|e| format!("client: {e}"))?;
    let resp = client.get(parsed).header("Accept", "image/*").send().await.map_err(|e| format!("send: {e}"))?;
    let status = resp.status().as_u16();
    if !(200..300).contains(&status) { return Err(format!("API_ERROR {status}")); }
    let ct = resp.headers().get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok()).unwrap_or("").split(';').next().unwrap_or("").trim().to_lowercase();
    if !ct.starts_with("image/") { return Err("UNSUPPORTED".to_string()); }
    if let Some(len) = resp.content_length() { if len as usize > MAX { return Err("TOO_LARGE".to_string()); } }
    let bytes = resp.bytes().await.map_err(|e| format!("body: {e}"))?;
    if bytes.len() > MAX { return Err("TOO_LARGE".to_string()); }
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(format!("data:{ct};base64,{b64}"))
}

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
        .invoke_handler(tauri::generate_handler![api_fetch, site_fetch, asset_fetch, get_layout, open_url, fonts_list, cph_detect, cph_set_override, cph_run, cph_compile, cph_stop, secure_put, secure_get, secure_del])
        .setup(move |app| {
            {
                use tauri::Manager;
                // pass #96: point the CPH override registry at the app data dir and load
                // what the user already confirmed in previous sessions — the confirm
                // dialog must only ever fire for a genuinely new/changed override.
                let state: tauri::State<CphState> = app.state();
                if let Ok(dir) = app.path().app_data_dir() {
                    state.set_persist_dir(dir);
                    state.load_persisted_overrides();
                }
                if DELCC_LAYOUT == "tmath" {
                    if let Some(w) = app.get_webview_window("main") {
                        let _ = w.set_title(window_title());
                    }
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

#[cfg(test)]
mod asset_tests {
    use super::*;

    fn u(s: &str) -> reqwest::Url {
        s.parse().unwrap()
    }

    #[test]
    fn v4_special_ranges_are_not_public() {
        for ip in ["127.0.0.1", "10.1.2.3", "192.168.1.1", "172.16.0.9", "169.254.9.9",
            "0.0.0.0", "100.64.0.1", "192.0.2.9", "198.18.0.5", "255.255.255.255"] {
            let ip: std::net::Ipv4Addr = ip.parse().unwrap();
            assert!(!is_public_v4(ip), "{ip}");
        }
        assert!(is_public_v4("8.8.8.8".parse().unwrap()));
    }

    #[test]
    fn v6_locals_are_not_public_and_mapped_v4_unwraps() {
        for ip in ["::1", "::", "fc00::1", "fe80::1"] {
            assert!(!is_public_v6(ip.parse().unwrap()), "{ip}");
        }
        assert!(is_public_v6("2001:4860:4860::8888".parse().unwrap()));
        // IPv4-mapped: std's raw v6 checks let 127.0.0.1 through — the unwrap must not.
        assert!(!is_public_ip("::ffff:127.0.0.1".parse().unwrap()));
        assert!(!is_public_ip("::ffff:192.168.0.9".parse().unwrap()));
        assert!(is_public_ip("::ffff:8.8.8.8".parse().unwrap()));
    }

    #[test]
    fn public_https_host_gates_scheme_names_and_literals() {
        assert!(!public_https_host(&u("http://example.com/x")));
        for bad in ["https://127.0.0.1/x", "https://[::1]/x", "https://[::ffff:127.0.0.1]/x",
            "https://localhost/x", "https://a.localhost/x", "https://box.local/x",
            "https://svc.internal/x", "https://10.0.0.9/x", "https://192.168.1.9/x"] {
            assert!(!public_https_host(&u(bad)), "{bad}");
        }
        for good in ["https://example.com/x", "https://oj.tmathcoding.vn/api/v3",
            "https://8.8.8.8/img.png", "https://[2001:4860:4860::8888]/img.png"] {
            assert!(public_https_host(&u(good)), "{good}");
        }
    }
}
