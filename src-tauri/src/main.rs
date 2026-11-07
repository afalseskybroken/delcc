// delcc — custom frontend shell. WebView hits oj.tmathcoding.vn/api/v3 directly.
// pass #55: windows-subsystem UNCONDITIONALLY (was release-only) - a debug build ran
// as a console-subsystem app, so the oracle carried a blank companion console window
// next to the app. Official ships the same way. The shell prints nothing to stdout.
#![windows_subsystem = "windows"]

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

mod fonts;
mod cph;
mod debug;
mod secure;
use cph::{cph_compile, cph_detect, cph_run, cph_set_override, cph_stop, debug_start, debug_step, debug_stop, CphState};
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
// pass #129 (attack-surface P1): asset_fetch built a fresh reqwest client per call — a
// fresh TLS handshake + pool teardown for every About-pane image. Clients are cached per
// host; each still carries its resolve-pin, so a cache hit reuses the address that was
// verified public when the client was built and never re-resolves — a STRICTER posture
// than the old per-call re-resolve (the rebind window stays closed, the handshake cost
// drops to once per host). Map capped at 16 hosts; overflow clears it (About panes touch
// a handful of hosts at most).
fn asset_clients() -> &'static Mutex<HashMap<String, reqwest::Client>> {
    static CACHE: OnceLock<Mutex<HashMap<String, reqwest::Client>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

// pass #129 (attack-surface A6): every other byte path in the tree is capped (asset_fetch
// 2 MiB, worker 1 MiB/stream, debug snapshot 64 KiB, secure store 256 KiB) — site_fetch and
// api_fetch were the two widest doors without a bound. The judge is the trusted origin, but
// a hostile-or-broken response (or a redirect loop inside the allowed host) must not grow
// RSS without limit. 8 MiB sits far above any real judge page (list/rankings pages are tens
// of KB) and errors honestly at the cap. Chunk-streamed (content-length checked first, the
// running size checked per chunk — chunked encoding has no length header to pre-check);
// UTF-8 lossy matches reqwest text()'s default-charset behavior for the judge's UTF-8.
const BODY_CAP: usize = 8 * 1024 * 1024;
// pass #141 (wave-8 W8-01): the shared byte-cap pair — read_capped_text's streaming
// pattern generalized so asset_fetch's 2 MiB image cap rides the same mechanism. The
// body is consumed as CHUNKS and rejected the moment it would cross the cap: a
// chunked/unknown-length server used to get bytes().await to allocate the COMPLETE
// response before the cap ran (the advertised cap did not stop the allocation). The
// Content-Length short-circuit stays, and every chunk is counted before it lands, so
// the worst-case allocation is cap + one chunk.
async fn read_capped_body(mut resp: reqwest::Response, cap: usize) -> Result<Vec<u8>, String> {
    if let Some(len) = resp.content_length() {
        if len as usize > cap { return Err(format!("TOO_LARGE {len}")); }
    }
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(|e| format!("body: {e}"))? {
        if buf.len() + chunk.len() > cap { return Err("TOO_LARGE".into()); }
        buf.extend_from_slice(&chunk);
    }
    Ok(buf)
}
async fn read_capped_text(resp: reqwest::Response) -> Result<String, String> {
    // chunked encoding has no length header to pre-check — the running size is checked per chunk
    Ok(String::from_utf8_lossy(&read_capped_body(resp, BODY_CAP).await?).into_owned())
}

// pass #18: same-origin HTML GET for the public site (avatar harvest). The webview
// fetch is CORS-blocked on profile pages; the shell talks, the page renders.
#[tauri::command]
async fn site_fetch(path: String) -> Result<String, String> {
    const BASE: &str = "https://oj.tmathcoding.vn";
    if !path.starts_with('/') || path.contains("..") { return Err("bad path".into()); }
    let resp = http().get(format!("{BASE}{path}")).timeout(std::time::Duration::from_secs(15)).send().await.map_err(|e| format!("send: {e}"))?;
    let status = resp.status().as_u16();
    let text = read_capped_text(resp).await?;
    serde_json::to_string(&serde_json::json!({ "status": status, "body": text }))
        .map_err(|e| format!("encode: {e}"))
}
// pass #10: installed font families for the settings font picker
use fonts::fonts_list;

// pass #83 (He): profile-provided About images render again — fetched by the SHELL, not
// the webview (the CSP stays pinned; images enter the page as data: URLs). Isolation
// posture: https-only, image-only content types, 2 MiB cap streamed (#141, W8-01), 10 s
// timeout per hop, no cookies or tokens ever attached. The image host sees the viewer's
// IP (same as the official client). pass #96 (re-audit N2): the hostname is resolved
// ONCE, every resolved address is verified public, and the client is PINNED to that
// address — the connection can only hit the IP we verified, closing the classic rebind
// window (verify A, connect B). pass #142 (wave-8 W8-04): that gate now covers EVERY
// redirect hop — automatic redirect-following is OFF, and the fetch loop drives at most
// three hops, each through the exact same resolve → verify-all-addresses → pin
// procedure as the original host (the old shape string-checked a hop's hostname and let
// it resolve normally — a public attacker server could redirect to a name resolving
// into private infrastructure). Trailing-dot hostnames ("localhost.") normalize before
// the suffix checks. The command carries no credentials and caps the response, so the
// blast radius is one capped-size image fetch, never a token.
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
            // pass #142 (W8-04): the trailing-dot form ("localhost.") used to evade the
            // exact-match suffix checks; normalize before judging.
            let h = h.trim_matches(|c| c == '[' || c == ']').trim_end_matches('.').to_lowercase();
            if h == "localhost" || h.ends_with(".localhost") || h.ends_with(".local") || h.ends_with(".internal") { return false; }
            match h.parse::<std::net::IpAddr>() {
                Ok(ip) => is_public_ip(ip),
                Err(_) => true,
            }
        }
    }
}
// The resolved-IP validation helper every hop shares (pass #142, W8-04): resolve the
// hostname ONCE, refuse if ANY answer is not public, and hand back a client pinned to
// the verified address. Cached per (normalized) host — a cache hit skips the DNS
// round-trip and reuses the client whose address was verified when it was built.
async fn pinned_client(url: &reqwest::Url) -> Result<reqwest::Client, String> {
    let raw_host = url.host_str().ok_or("FORBIDDEN")?.to_string();
    let host = raw_host.trim_matches(|c| c == '[' || c == ']').trim_end_matches('.').to_string();
    let cached = asset_clients().lock().unwrap_or_else(|e| e.into_inner()).get(&host.to_lowercase()).cloned();
    if let Some(c) = cached {
        return Ok(c);
    }
    // pass #96: resolve once, verify every answer, pin. A hostname resolving to ANY
    // non-public address is refused outright (round-robin rebinding included).
    let mut builder = reqwest::Client::builder()
        .http1_only()
        .user_agent(concat!("delcc/", env!("CARGO_PKG_VERSION")))
        .timeout(std::time::Duration::from_secs(10))
        // pass #142 (W8-04): NO automatic redirects — asset_fetch's loop validates and
        // drives every hop itself, so the client must never follow one on its own.
        .redirect(reqwest::redirect::Policy::none());
    let host_is_literal = host.parse::<std::net::IpAddr>().is_ok();
    if !host_is_literal {
        let target = format!("{host}:{}", url.port_or_known_default().unwrap_or(443));
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
    let client = builder.build().map_err(|e| format!("client: {e}"))?;
    let mut cache = asset_clients().lock().unwrap_or_else(|e| e.into_inner());
    if cache.len() >= 16 { cache.clear(); }
    cache.insert(host.to_lowercase(), client.clone());
    drop(cache);
    Ok(client)
}
// The hop gate (pass #142, W8-04): resolve a redirect Location against the current URL,
// then apply the SAME string checks as the original — https, public host.
fn redirect_target(current: &reqwest::Url, location: &str) -> Result<reqwest::Url, String> {
    let next = current.join(location).map_err(|_| "FORBIDDEN bad redirect location".to_string())?;
    if next.scheme() != "https" { return Err("FORBIDDEN non-https redirect".into()); }
    if !public_https_host(&next) { return Err("FORBIDDEN redirect to a non-public host".into()); }
    Ok(next)
}
#[tauri::command]
async fn asset_fetch(url: String) -> Result<String, String> {
    use base64::Engine as _;
    const MAX: usize = 2 * 1024 * 1024;
    const MAX_HOPS: usize = 3;
    let mut current: reqwest::Url = url.parse().map_err(|_| "INVALID_ARGUMENT".to_string())?;
    if !public_https_host(&current) { return Err("FORBIDDEN".to_string()); }
    let mut resp = None;
    for hops in 0..=MAX_HOPS {
        let client = pinned_client(&current).await?;
        let r = client.get(current.clone()).header("Accept", "image/*").send().await.map_err(|e| format!("send: {e}"))?;
        let status = r.status().as_u16();
        if (300..400).contains(&status) {
            if hops == MAX_HOPS {
                return Err("FORBIDDEN too many redirects".into());
            }
            let loc = r.headers().get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .ok_or("FORBIDDEN redirect without a location")?
                .to_string();
            current = redirect_target(&current, &loc)?;
            continue;
        }
        resp = Some(r);
        break;
    }
    let resp = resp.ok_or("FORBIDDEN too many redirects")?;
    let status = resp.status().as_u16();
    if !(200..300).contains(&status) { return Err(format!("API_ERROR {status}")); }
    let ct = resp.headers().get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok()).unwrap_or("").split(';').next().unwrap_or("").trim().to_lowercase();
    if !ct.starts_with("image/") { return Err("UNSUPPORTED".to_string()); }
    // pass #141 (W8-01): streamed + rejected at the cap (read_capped_body) — the old
    // bytes().await fully buffered the response before the size check ran.
    let bytes = read_capped_body(resp, MAX).await?;
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
    let text = read_capped_text(resp).await?;
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

// pass #127 (a friend's suggestion via He): F11 toggles the window fullscreen — the
// shell owns the window API, so the webview asks through this command instead of a
// new capability grant. Returns the resulting state for honest logging.
#[tauri::command]
fn toggle_fullscreen(window: tauri::WebviewWindow) -> Result<bool, String> {
    let fs = window.is_fullscreen().map_err(|e| format!("fullscreen: {e}"))?;
    window.set_fullscreen(!fs).map_err(|e| format!("fullscreen: {e}"))?;
    Ok(!fs)
}

// pass #134 (He: the footnote update dot — [Up to date] / [Update available], visible
// even with the tools panel minimized): the ONE honest source for "a newer delcc exists"
// is delcc's own GitHub releases feed (the judge's client-releases feed cannot say it —
// delcc adopts whatever client version that feed demands, by the documented shim, so it
// is always "in sync" with the judge by construction). Posture, disclosed in SECURITY.md:
// a READ-ONLY GET of the repo's latest-release endpoint on api.github.com, no tokens or
// cookies ever attached, 10 s timeout, the same 8 MiB body cap as every other byte path,
// once per boot from the frontend. Comparison: delcc's own CARGO_PKG_VERSION vs the
// release tag (v0.3.36a-alpha → 0,3,36) — numeric triples only; anything unparseable on
// either side is "unknown", and the frontend shows a neutral dot (no evidence, no claim).
// The URL is pinned to exactly one host:path — webview content cannot aim it elsewhere.
#[tauri::command]
async fn update_check() -> Result<String, String> {
    // /releases?per_page=1, NOT /releases/latest: every delcc release ships as a
    // PRERELEASE (the alpha train), and GitHub's latest endpoint excludes prereleases —
    // it 404'd on the live oracle (0.3.37 first boot, element "Update check unavailable").
    // The newest release entry is exactly what "a newer delcc exists" means here.
    const ENDPOINT: &str = "https://api.github.com/repos/afalseskybroken/delcc/releases?per_page=1";
    let current = env!("CARGO_PKG_VERSION").to_string();
    let resp = http().get(ENDPOINT)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .timeout(std::time::Duration::from_secs(10))
        .send().await.map_err(|e| format!("send: {e}"))?;
    let status = resp.status().as_u16();
    if !(200..300).contains(&status) { return Err(format!("API_ERROR {status}")); }
    let body = read_capped_text(resp).await?;
    let list = serde_json::from_str::<serde_json::Value>(&body).map_err(|e| format!("parse: {e}"))?;
    let tag = list.as_array().and_then(|a| a.first())
        .and_then(|r| r.get("tag_name")).and_then(|t| t.as_str()).unwrap_or("").to_string();
    // pass #141 (wave-8 W8-L04): TRI-STATE. An empty/missing/unparseable tag used to
    // encode as update_available:false — indistinguishable from a current install, so a
    // malformed feed read as "Up to date". null = no usable evidence; the frontend maps
    // it to the neutral "unknown" dot (same posture as offline/rate-limited).
    serde_json::to_string(&serde_json::json!({
        "current": current,
        "latest": tag,
        "update_available": update_available_value(&tag, &current),
    }))
    .map_err(|e| format!("encode: {e}"))
}
// The tri-state encoded as JSON: Some(bool) → true/false, None → null.
fn update_available_value(tag: &str, current: &str) -> serde_json::Value {
    match (version_triple(tag), version_triple(current)) {
        (Some(_), Some(_)) => serde_json::Value::Bool(version_gt(tag, current)),
        _ => serde_json::Value::Null,
    }
}

// Numeric-triple comparison for delcc's version spellings: "v0.3.31a-alpha" and
// "0.3.36-alpha" both parse to (0,3,31)/(0,3,36) — leading `v` ignored, each dot component
// takes its numeric prefix, the alpha suffix never compares. Unparseable → None.
fn version_triple(v: &str) -> Option<(u64, u64, u64)> {
    let core = v.trim().strip_prefix('v').unwrap_or(v.trim());
    let mut it = core.split('.');
    let num = |s: Option<&str>| -> Option<u64> {
        let s = s?;
        let digits: String = s.chars().take_while(|c| c.is_ascii_digit()).collect();
        if digits.is_empty() { return None; }
        digits.parse::<u64>().ok()
    };
    let major = num(it.next())?;
    let minor = num(it.next())?;
    let patch = num(it.next())?;
    Some((major, minor, patch))
}
fn version_gt(candidate: &str, current: &str) -> bool {
    match (version_triple(candidate), version_triple(current)) {
        (Some(a), Some(b)) => a > b,
        _ => false, // unknown versions never claim an update exists
    }
}

// pass #136 (wave-5 audit H1, HIGH): the raw-string gate for open_url. The #131b
// handoff claimed the URL "cannot contain a quote itself" — FALSE: a WHATWG parser
// accepts `https://github.com/a" & calc.exe & "b` and keeps `github.com` as the host,
// so the allowlist (which runs on the PARSED copy) passes while the RAW string carries
// the quote into `cmd /C start "" "<url>"` — the quote closes start's argument and the
// rest runs as a command. Server-controlled strings reach this command
// (st.authorization_url on Google sign-in, m.installer_url on the download click), so
// a compromised judge or a TLS-intercepting proxy could drive it. Two layers here:
// (1) this gate — the RAW string must be free of quotes and C0/C1 control characters
// before anything proceeds (belt), and (2) the Windows handoff below calls
// ShellExecuteW DIRECTLY — cmd /C start is gone entirely, so no cmd parser exists to
// reinterpret & | ^ %VAR% even in the worst case (suspenders). Percent-encoding stays
// legal (a plain %XX in a query string is normal); it is inert without cmd.
fn open_url_has_hostile_chars(raw: &str) -> bool {
    raw.bytes().any(|b| b == b'"' || b < 0x20 || b == 0x7f)
}

// System-browser opener for the Google PKCE step. https only; the URL is a single
// argv entry for the OS opener, never passed through a shell.
// pass #78 (Sonnet S6): host allowlist — open_url is the only path from webview
// content to the OS shell, so it opens only hosts delcc has a reason to open: the
// judge, the Google OAuth consent page, the project's GitHub (repo + release
// downloads; the browser follows GitHub's own redirects, not us), and YouTube
// (About-pane video links). Rejections are honest errors the caller can show.
#[tauri::command]
async fn open_url(url: String) -> Result<(), String> {
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
    // pass #136 (wave-5 H1): the gate runs on the RAW string — the parsed copy has
    // already normalized hostile bytes away, which is exactly how the quote survived
    // to the handoff in the first place. Rejected here, before any handoff.
    if open_url_has_hostile_chars(&url) {
        return Err("open_url: the url carries quote or control characters this handoff refuses".into());
    }
    // The handoff receives the PARSED copy (parsed.as_str()) — the canonical form of
    // the same URL the allowlist judged — never the raw string.
    // pass #136: Windows dials ShellExecuteW directly. The #131b `cmd /C start` hop is
    // GONE: with no cmd process there is no command parser to reinterpret & | ^ %VAR%
    // at all, which retires the whole injection class this gate belts against. The
    // canonical default-browser handoff also keeps the #131b property that mattered
    // (explorer.exe treated the argument as a filesystem path and silently opened
    // nothing; ShellExecuteW's "open" verb on an https URL reaches the registered
    // browser, and a return value > 32 proves it dispatched).
    // pass #144 (wave-8 W8-L11): the whole handoff rides spawn_blocking —
    // ShellExecuteW is SYNCHRONOUS, and a sync Tauri command ran it on the main
    // thread, stalling the window for the length of a browser launch.
    #[cfg(target_os = "windows")]
    {
        let canonical = parsed.as_str().to_string();
        tauri::async_runtime::spawn_blocking(move || {
        use windows_sys::Win32::System::Com::CoInitializeEx;
        use windows_sys::Win32::UI::Shell::ShellExecuteW;
        // pass #136, the live-smoke finding: ShellExecuteW dispatches URL protocols through
        // the shell's COM objects, and a Tauri command thread has NO COM apartment — the
        // documented prerequisite. Without it the call silently no-ops (the oracle's GitHub
        // button produced nothing while the OS path via PowerShell worked). Initialize here;
        // a thread that already has an apartment answers RPC_E_CHANGED_MODE and is fine as-is.
        let hr = unsafe { CoInitializeEx(std::ptr::null_mut(), 2 /* COINIT_APARTMENTTHREADED */) };
        let verb: Vec<u16> = "open\u{0}".encode_utf16().collect();
        let file: Vec<u16> = canonical.encode_utf16().chain(std::iter::once(0)).collect();
        // SW_SHOWNORMAL = 1 (Win32_UI_WindowsAndMessaging's constant, inlined raw so the
        // shell feature stays the only new one). Success is an HINSTANCE > 32.
        let res = unsafe {
            ShellExecuteW(
                std::ptr::null_mut(),
                verb.as_ptr(),
                file.as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                1,
            )
        };
        if hr >= 0 {
            // pass #138 (wave-6 fact-check, the auditor was RIGHT): the balance condition
            // was `hr == 0` — S_OK only. CoInitializeEx ALSO returns S_FALSE (1) when the
            // apartment was already initialized, and the COM contract requires EVERY
            // successful init — S_OK and S_FALSE alike — to be balanced by CoUninitialize.
            // The old condition leaked a reference count on every S_FALSE call. SUCCEEDED
            // (hr >= 0) is the documented boundary: S_OK and S_FALSE balance,
            // RPC_E_CHANGED_MODE (a negative failure — the thread already has a different
            // apartment kind) does not. A pool thread runs many commands; each call that
            // took a reference gives it back before returning.
            #[cfg(target_os = "windows")]
            unsafe {
                use windows_sys::Win32::System::Com::CoUninitialize;
                CoUninitialize();
            }
        }
        if (res as isize) <= 32 {
            return Err(format!("open: ShellExecuteW failed ({})", res as isize));
        }
        Ok(())
        })
        .await
        .map_err(|e| format!("join: {e}"))?
    }
    #[cfg(not(target_os = "windows"))]
    {
        let canonical = parsed.as_str().to_string();
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(target_os = "macos")]
            let mut cmd = std::process::Command::new("open");
            #[cfg(all(unix, not(target_os = "macos")))]
            let mut cmd = std::process::Command::new("xdg-open");
            cmd.arg(canonical).spawn().map(|_| ()).map_err(|e| format!("open: {e}"))
        })
        .await
        .map_err(|e| format!("join: {e}"))?
    }
}

// pass #139 (He's wave-6 P3 ruling): the stock window title is delcc's OWN — the #137
// icon revert removed the official mark, and the title now follows it, so a delcc
// window is identifiable as delcc at a glance end to end. The Settings → identity
// override (WINDOW_TITLE_KEY) still wins when set — custom theming keeps the titlebar
// exactly as it had (the #106 feature is untouched).
fn window_title() -> &'static str {
    if DELCC_LAYOUT == "tmath" { "delcc" } else { "delcc \u{2014} custom frontend" }
}

// pass #106 (He): user-customizable window identity — a custom title and/or window icon
// (window + taskbar on Windows) applied live and re-applied on launch from the prefs.
// The .exe file icon is fixed at build time; the Settings copy says so honestly.
// The icon arrives as base64 RGBA the WEBVIEW decoded on a canvas: no image crate, no new
// deps, and any browser-decodable format works. Bounds: title ≤ 120 chars, control chars
// stripped; RGBA exactly w*h*4, ≤ 512×512 (the frontend canvas downscales to ≤ 256).
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IdentityIcon {
    width: u32,
    height: u32,
    rgba: String, // base64
}

#[tauri::command]
fn identity_apply(window: tauri::WebviewWindow, title: Option<String>, icon: Option<IdentityIcon>, reset_icon: Option<bool>) -> Result<(), String> {
    if let Some(t) = title {
        let cleaned: String = t.chars().filter(|c| !c.is_control()).take(120).collect();
        let t = if cleaned.trim().is_empty() { window_title().to_string() } else { cleaned };
        window.set_title(&t).map_err(|e| format!("title: {e}"))?;
    }
    if reset_icon.unwrap_or(false) {
        // restore the bundle icon — default_window_icon is the one tauri.conf ships
        use tauri::Manager;
        let img = window.app_handle().default_window_icon().cloned();
        if let Some(img) = img {
            window.set_icon(img).map_err(|e| format!("icon: {e}"))?;
        }
    } else if let Some(ic) = icon {
        if ic.width == 0 || ic.height == 0 || ic.width > 512 || ic.height > 512 {
            return Err("icon: dimensions must be 1..=512 px".into());
        }
        use base64::Engine;
        let rgba = base64::engine::general_purpose::STANDARD
            .decode(&ic.rgba)
            .map_err(|e| format!("icon: bad base64: {e}"))?;
        let expected = ic.width as usize * ic.height as usize * 4;
        if rgba.len() != expected {
            return Err(format!("icon: RGBA payload {} bytes, expected {expected}", rgba.len()));
        }
        let img = tauri::image::Image::new_owned(rgba, ic.width, ic.height);
        window.set_icon(img).map_err(|e| format!("icon: {e}"))?;
    }
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .manage(CphState::default())
        .invoke_handler(tauri::generate_handler![api_fetch, site_fetch, asset_fetch, get_layout, toggle_fullscreen, open_url, update_check, fonts_list, cph_detect, cph_set_override, cph_run, cph_compile, cph_stop, debug_start, debug_step, debug_stop, identity_apply, secure_put, secure_get, secure_del])
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
    fn version_compare_handles_delcc_and_tag_spellings() {
        // pass #134 (the update dot): the release tag and the package version spell
        // versions differently — the comparison must read both and stay honest on junk.
        assert!(version_gt("v0.3.37a-alpha", "0.3.36-alpha"));
        assert!(version_gt("v1.0.0", "0.99.99"));
        assert!(!version_gt("v0.3.36a-alpha", "0.3.36-alpha"), "same triple = no update");
        assert!(!version_gt("v0.3.35a-alpha", "0.3.36-alpha"));
        assert!(!version_gt("v0.3.36b-alpha", "0.3.36-alpha"), "the alpha suffix never compares");
        assert!(!version_gt("", "0.3.36-alpha"), "unparseable candidate never claims an update");
        assert!(!version_gt("v0.3.37a-alpha", ""), "unparseable current never claims an update");
        assert_eq!(version_triple("v0.3.31a-alpha"), Some((0, 3, 31)));
        assert_eq!(version_triple("0.3.36-alpha"), Some((0, 3, 36)));
    }

    #[test]
    fn update_check_malformed_metadata_is_unknown_not_up_to_date() {
        // pass #141 (wave-8 W8-L04): the tri-state. An empty tag (an empty releases
        // array, a missing tag_name) or an unparseable version used to encode as
        // update_available:false — the frontend then painted "Up to date" over a
        // malformed feed. null = no usable evidence; the frontend shows the neutral dot.
        assert_eq!(update_available_value("", "0.3.44"), serde_json::Value::Null);
        assert_eq!(update_available_value("not-a-version", "0.3.44"), serde_json::Value::Null);
        assert_eq!(update_available_value("v0.3.45a-alpha", "garbage"), serde_json::Value::Null);
        assert_eq!(update_available_value("v0.3.45a-alpha", "0.3.44-alpha"), serde_json::Value::Bool(true));
        assert_eq!(update_available_value("v0.3.44a-alpha", "0.3.44-alpha"), serde_json::Value::Bool(false));
        assert_eq!(update_available_value("v0.3.43a-alpha", "0.3.44-alpha"), serde_json::Value::Bool(false));
    }

    #[test]
    fn redirect_hops_ride_the_full_gate() {
        // pass #142 (wave-8 W8-04): every hop resolves and re-validates — the unit gate
        // here pins the string-level half (the resolved-IP half runs in pinned_client,
        // which the hop loop calls for the target host too). The wave-8 payload shape:
        // a public attacker server redirecting to private infrastructure must refuse.
        let start: reqwest::Url = "https://images.example.com/a.png".parse().unwrap();
        // a relative Location resolves against the current URL (the common shape)
        let next = redirect_target(&start, "/b.png").expect("relative hop passes");
        assert_eq!(next.as_str(), "https://images.example.com/b.png");
        // non-https hops are refused outright
        let e = redirect_target(&start, "http://images.example.com/b.png").unwrap_err();
        assert!(e.contains("non-https"), "{e}");
        // a hop to a private-address literal is refused
        let e = redirect_target(&start, "https://192.168.1.10/x").unwrap_err();
        assert!(e.contains("non-public"), "{e}");
        // a hop to a loopback literal is refused
        assert!(redirect_target(&start, "https://127.0.0.1/x").is_err());
        // the trailing-dot localhost form (the wave-8 evasion shape) is refused
        assert!(redirect_target(&start, "https://localhost./x").is_err());
        assert!(!public_https_host(&"https://localhost./x".parse().unwrap()));
        assert!(public_https_host(&"https://images.example.com/x".parse().unwrap()));
    }

    #[test]
    fn open_url_gate_rejects_what_the_parser_normalizes() {
        // pass #136 (wave-5 H1): the audit's exact payload — the WHATWG parser keeps
        // `github.com` as the host (allowlist PASSES on the parsed copy) while the RAW
        // string carries the quote that would close start's argument and split the
        // command. The gate must run on the raw string and reject it.
        let payload = "https://github.com/a\" & calc.exe & \"b";
        let parsed = reqwest::Url::parse(payload).unwrap();
        assert_eq!(parsed.host_str(), Some("github.com"), "the audit's premise: the host allowlist would pass this");
        assert!(open_url_has_hostile_chars(payload), "the raw string carries the quote");
        // the same URL, percent-encoded — the form the parser normalizes TO — is inert
        // and must pass (a plain %XX is legal; it is cmd that is gone, not percent).
        assert!(!open_url_has_hostile_chars(parsed.as_str()), "the canonical percent-encoded form passes");
        // control characters are refused in the raw string too
        assert!(open_url_has_hostile_chars("https://github.com/\u{1f}"));
        assert!(open_url_has_hostile_chars("https://github.com/a\u{7f}b"));
        assert!(open_url_has_hostile_chars("https://github.com/a\nb"));
        // clean URLs — including the real call sites' shapes — pass untouched
        assert!(!open_url_has_hostile_chars("https://accounts.google.com/o/oauth2/v2/auth?client_id=x&redirect_uri=y&response_type=code"));
        assert!(!open_url_has_hostile_chars("https://github.com/afalseskybroken/delcc/releases"));
        assert!(!open_url_has_hostile_chars("https://downloads.tmathcoding.vn/releases/1.1.0-pilot-1/TMATH-Code-Client_1.1.0_windows-x64.exe"));
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
