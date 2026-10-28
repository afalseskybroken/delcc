// delcc-app/src-tauri/src/cph.rs
// Local Competitive Programming Helper: detect what's on PATH, compile the editor's
// current source, run it against test cases the user typed in, time-limit it, diff
// it client-side. There is no way to pull real judge test data through the contract
// (confirmed — see SHIP_TO_CLAUDE.md), so this never touches the network: it is a
// local sandbox-free runner, same trust level as running the file yourself in a
// terminal. One footgun worth a comment, nothing more — see `capture`.
//
// pass #11 (Claude): serde output is snake_case again (the TS side has always read
// snake_case — see transport.ts), commands are async so the UI thread is never the
// one waiting on a compiler, and `cph_compile` / `cph_stop` exist. One job at a time:
// the single `active` slot in `CphState` is what Stop addresses.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, hash_map::DefaultHasher};
use std::fs;
use std::hash::{Hash, Hasher};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

#[cfg(windows)]
fn new_cmd(bin: &str) -> Command {
    use std::os::windows::process::CommandExt;
    let mut c = Command::new(bin);
    c.creation_flags(0x08000000); // CREATE_NO_WINDOW — else every run flashes a console
    c
}
#[cfg(not(windows))]
fn new_cmd(bin: &str) -> Command {
    Command::new(bin)
}

/// Kills `pid` and every descendant. `Child::kill` only ever reaches the direct child, so a
/// `java`/`python` launcher, a shell-out, or a user program that forked would survive a timeout
/// or a Stop press and keep the stdout pipe open (which also wedges the reader threads).
/// Windows: `taskkill /T /F` (argv only, no shell). Elsewhere: the child was started as its own
/// process group leader (see `capture`), so a negative pid addresses the whole group.
fn kill_tree(pid: u32) {
    #[cfg(windows)]
    {
        let mut c = new_cmd("taskkill");
        c.args(["/PID", &pid.to_string(), "/T", "/F"]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        let _ = c.status();
    }
    #[cfg(not(windows))]
    {
        let mut c = Command::new("kill");
        c.args(["-KILL", "--", &format!("-{pid}")]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        let _ = c.status();
    }
}

// ---------- lane 1: Windows Job Object memory cap (`job-mem-cap`, DEFAULT since pass #49) ----------
// FFI VERIFIED on the Windows box (2026-10-26): compiles clean, attach/peak/limit paths
// exercised by the pass-30 memory UI. Default-on so shipped builds enforce the advertised
// caps, and KILL_ON_JOB_CLOSE reaps any process that somehow survived kill_tree.
//
// Bonus the lane didn't ask for but falls out of doing this properly: KILL_ON_JOB_CLOSE
// means dropping the Job terminates the whole process tree, not just the direct child —
// closes the long-standing "child survives kill()" gap (a `go run` or shelled-out compiler
// spawning a grandchild previously could outlive `child.kill()`).
#[cfg(all(windows, feature = "job-mem-cap"))]
mod job {
    use std::ffi::c_void;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        QueryInformationJobObject, SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_JOB_MEMORY, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    pub struct Job(HANDLE);

    impl Job {
        // Best-effort only: any failure here just means no cap this run — same as before this lane.
        pub fn attach(child: &std::process::Child, memory_limit_mb: u64) -> Option<Job> {
            unsafe {
                let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if job.is_null() { // windows-sys ≥0.52: HANDLE is a *mut c_void, not an isize — no == 0
                    return None;
                }
                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                info.BasicLimitInformation.LimitFlags =
                    JOB_OBJECT_LIMIT_JOB_MEMORY | JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                info.JobMemoryLimit = (memory_limit_mb as usize).saturating_mul(1024 * 1024);
                let ok = SetInformationJobObject(
                    job,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const c_void,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                );
                if ok == 0 {
                    CloseHandle(job);
                    return None;
                }
                let proc_handle = child.as_raw_handle() as HANDLE;
                let ok = AssignProcessToJobObject(job, proc_handle);
                if ok == 0 {
                    CloseHandle(job);
                    return None;
                }
                Some(Job(job))
            }
        }

        // Peak committed memory the job ever reported, in bytes. None if the query failed.
        pub fn peak_bytes(&self) -> Option<u64> {
            unsafe {
                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                let mut returned: u32 = 0;
                let ok = QueryInformationJobObject(
                    self.0,
                    JobObjectExtendedLimitInformation,
                    &mut info as *mut _ as *mut c_void,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                    &mut returned,
                );
                if ok == 0 {
                    return None;
                }
                Some(info.PeakJobMemoryUsed as u64)
            }
        }
    }

    impl Drop for Job {
        fn drop(&mut self) {
            // KILL_ON_JOB_CLOSE: this also reaps any surviving descendant processes.
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

// ---------- shared state: one active job, one cached build ----------

const COMPILE_LIMIT: Duration = Duration::from_secs(120);
const LOG_CAP: usize = 64 * 1024;
// Execution data and display data have different bounds. Verdicts use complete
// output up to this limit; exceeding it is an explicit RE, never a clipped WA.
const OUTPUT_CAP: usize = 1024 * 1024; // per stream, for compilers as well as programs
const OUTPUT_LIMIT_MESSAGE: &str = "output limit exceeded (1048576 bytes per stream)";
const PIPE_POLL: Duration = Duration::from_millis(5);

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner()) // a panicked job must never brick Stop
}

struct ActiveJob {
    id: u64,
    cancel: AtomicBool,
    pid: AtomicU32, // 0 = nothing running right now
}

struct Build {
    key: u64,      // hash(lang, binary, source) — a Run on unchanged source skips the compiler
    tmp: PathBuf,  // build dir, removed when replaced or on app exit
    artifact: PathBuf, // must still exist for the entry to count as a hit
    log: String,
}

#[derive(Default)]
struct Inner {
    active: Mutex<Option<Arc<ActiveJob>>>,
    cache: Mutex<Option<Build>>,
    allowed: Mutex<AllowedBinaries>, // pass #78: the exec allowlist, see validate_binary
}

// pass #78 (Sonnet S1 leg 2): what `cph_run`/`cph_compile` may execute.
// (a) the fixed candidate names the detector probes, (b) the toolchains the last
// cph_detect actually answered with, (c) paths the user registered through Settings
// (mirrored into the shell via `cph_set_override` — localStorage alone is
// webview-writable, so it cannot be trusted from here). Everything else is rejected
// before any process is touched.
#[derive(Default)]
struct AllowedBinaries {
    detected: HashMap<String, HashSet<String>>, // lang_key -> binaries the detector answered with
    overrides: HashMap<String, String>,         // lang_key -> Settings-registered path
}

#[derive(Default, Clone)]
pub struct CphState(Arc<Inner>);

static JOB_SEQ: AtomicU64 = AtomicU64::new(1);

struct JobGuard {
    inner: Arc<Inner>,
    job: Arc<ActiveJob>,
}

impl JobGuard {
    fn begin(inner: &Arc<Inner>) -> Result<JobGuard, String> {
        let mut slot = lock(&inner.active);
        if slot.is_some() {
            return Err("a local run is already in progress".into());
        }
        let job = Arc::new(ActiveJob { id: JOB_SEQ.fetch_add(1, Ordering::Relaxed), cancel: AtomicBool::new(false), pid: AtomicU32::new(0) });
        *slot = Some(job.clone());
        Ok(JobGuard { inner: inner.clone(), job })
    }
}

impl Drop for JobGuard {
    fn drop(&mut self) {
        let mut slot = lock(&self.inner.active);
        if slot.as_ref().map(|j| j.id) == Some(self.job.id) {
            *slot = None;
        }
    }
}

impl CphState {
    /// Flags the running job; the poll loop in `capture` kills its process tree within ~15 ms.
    pub fn stop(&self) -> bool {
        match lock(&self.0.active).as_ref() {
            Some(j) => { j.cancel.store(true, Ordering::SeqCst); true }
            None => false,
        }
    }

    /// App exit: kill whatever is running right now and drop the cached build dir.
    pub fn cleanup(&self) {
        if let Some(j) = lock(&self.0.active).as_ref() {
            j.cancel.store(true, Ordering::SeqCst);
            let pid = j.pid.load(Ordering::SeqCst);
            if pid != 0 { kill_tree(pid); }
        }
        if let Some(b) = lock(&self.0.cache).take() {
            let _ = fs::remove_dir_all(&b.tmp);
        }
    }
}

fn set_cache(inner: &Inner, build: Build) {
    let old = lock(&inner.cache).replace(build);
    if let Some(o) = old { let _ = fs::remove_dir_all(&o.tmp); }
}

// The build cache key must include the C++ standard (pass #52): switching the language
// select between CPP17 and CPP20 with unchanged source must NOT reuse the old binary.
fn key_of(lang_key: &str, binary: &str, source: &str, std: Option<&str>) -> u64 {
    let mut h = DefaultHasher::new();
    lang_key.hash(&mut h);
    binary.hash(&mut h);
    source.hash(&mut h);
    std.hash(&mut h);
    h.finish()
}

// argv-only commands mean a hostile std cannot inject anything, but a stray flag value
// would still produce a confusing compiler error — accept only real -std shapes.
fn sanitize_std(std: &Option<String>) -> Option<String> {
    match std.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(s) if s.len() <= 16 && s.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '+') => Some(s.to_string()),
        _ => None,
    }
}

fn new_tmp_dir(job_id: u64) -> Result<PathBuf, String> {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp: PathBuf = std::env::temp_dir().join(format!("delcc-cph-{stamp}-{job_id}"));
    fs::create_dir_all(&tmp).map_err(|e| format!("tmp dir: {e}"))?;
    Ok(tmp)
}

// ---------- detect ----------

#[derive(Serialize)]
pub struct Toolchain {
    lang_key: String, // matches lib/langmap.ts buckets: cpp/python/java/rust/go/pascal/javascript
    label: String,
    binary: String, // the exact candidate name that answered — fed back into cph_run
    version: String,
}

fn probe_one(candidates: &[&str], version_args: &[&str]) -> Option<(String, String)> {
    for bin in candidates {
        let mut c = new_cmd(bin);
        c.args(version_args);
        if let Ok(out) = c.output() {
            // several of these (java -version, fpc -iV on some builds) write to stderr, not stdout.
            let combined = format!(
                "{}{}",
                String::from_utf8_lossy(&out.stdout),
                String::from_utf8_lossy(&out.stderr)
            );
            let first_line = combined.lines().next().unwrap_or("").trim().to_string();
            // Nyx pass #8 gate, re-ported over the Claude pass #11 payload: a probe must SUCCEED and
            // print its own version. The Microsoft Store app-execution-alias stubs (python3/python)
            // run fine, print "Python was not found..." and exit 9009 — the first real detect
            // claimed the stub as a Python toolchain. status gate + marketing-line guard.
            const NOT_FOUND: &str = "was not found";
            if out.status.success() && !first_line.is_empty() && !first_line.contains(NOT_FOUND) {
                return Some((bin.to_string(), first_line));
            }
        }
    }
    None
}

fn push(out: &mut Vec<Toolchain>, lang_key: &str, label: &str, found: Option<(String, String)>) {
    if let Some((binary, version)) = found {
        out.push(Toolchain { lang_key: lang_key.into(), label: label.into(), binary, version });
    }
}

fn detect_all() -> Vec<Toolchain> {
    let mut out = Vec::new();
    push(&mut out, "cpp", "C++", probe_one(&["g++", "clang++"], &["--version"]));
    push(&mut out, "python", "Python", probe_one(&["python3", "python"], &["--version"]));
    push(&mut out, "rust", "Rust", probe_one(&["rustc"], &["--version"]));
    push(&mut out, "go", "Go", probe_one(&["go"], &["version"]));
    push(&mut out, "pascal", "Pascal", probe_one(&["fpc"], &["-iV"]));
    push(&mut out, "javascript", "Node.js", probe_one(&["node"], &["--version"]));
    // java needs both compiler and runtime; only claim it when both answer.
    if probe_one(&["javac"], &["-version"]).is_some() {
        push(&mut out, "java", "Java", probe_one(&["java"], &["-version"]));
    }
    out
}

// Async + spawn_blocking: a plain `fn` command runs on the main thread in Tauri 2 and the
// probes (java -version in particular) would freeze the window while they run.
#[tauri::command]
pub async fn cph_detect(state: tauri::State<'_, CphState>) -> Result<Vec<Toolchain>, String> {
    let found = tauri::async_runtime::spawn_blocking(detect_all).await.unwrap_or_default();
    {
        let mut allowed = lock(&state.0.allowed);
        allowed.detected = found.iter().fold(HashMap::new(), |mut m, t| {
            m.entry(t.lang_key.clone()).or_default().insert(t.binary.clone());
            m
        });
    }
    Ok(found)
}

// ---------- pass #78: execution allowlist (Sonnet S1 leg 2) ----------

fn validate_binary_shape(bin: &str) -> Result<(), String> {
    if bin.trim().is_empty() {
        return Err("CPH: no toolchain binary given".into());
    }
    if bin.len() > 260 {
        return Err("CPH: toolchain path too long".into());
    }
    if bin.chars().any(|c| c.is_control()) {
        return Err("CPH: toolchain path has control characters".into());
    }
    Ok(())
}

// The detector's candidate table as a lang -> name floor. A bare name here runs as-is
// (PATH lookup) — exactly what cph_detect probes before claiming it, so admitting it
// never admits anything the detector wouldn't have run itself.
fn candidate_lang(name: &str) -> Option<&'static str> {
    Some(match name {
        "g++" | "clang++" => "cpp",
        "python3" | "python" => "python",
        "rustc" => "rust",
        "go" => "go",
        "fpc" => "pascal",
        "node" => "javascript",
        "javac" | "java" => "java",
        _ => return None,
    })
}

fn validate_binary(inner: &Inner, lang_key: &str, binary: &str) -> Result<(), String> {
    validate_binary_shape(binary)?;
    if candidate_lang(binary) == Some(lang_key) {
        return Ok(());
    }
    let allowed = lock(&inner.allowed);
    if allowed.detected.get(lang_key).map(|set| set.contains(binary)).unwrap_or(false) {
        return Ok(());
    }
    if allowed.overrides.get(lang_key).map(|v| v == binary).unwrap_or(false) {
        return Ok(());
    }
    Err(format!(
        "CPH: binary '{binary}' is not an allowed {lang_key} toolchain (detected candidates or Settings overrides only)"
    ))
}

// Settings' per-language toolchain override (lib/cph.ts) mirrors its choice here so
// cph_run/cph_compile can admit it. A path-shaped binary must exist — an honest error
// now beats a confusing spawn failure later. Blank clears the registration.
#[tauri::command]
pub async fn cph_set_override(state: tauri::State<'_, CphState>, lang_key: String, binary: String) -> Result<(), String> {
    let bin = binary.trim().to_string();
    if bin.is_empty() {
        lock(&state.0.allowed).overrides.remove(&lang_key);
        return Ok(());
    }
    validate_binary_shape(&bin)?;
    if (bin.contains('\\') || bin.contains('/')) && !Path::new(&bin).is_file() {
        return Err(format!("CPH: no file at '{bin}'"));
    }
    lock(&state.0.allowed).overrides.insert(lang_key, bin);
    Ok(())
}

// ---------- wire types ----------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CphCase {
    id: String,
    input: String,
    expected: Option<String>,
    #[serde(default)]
    time_limit_ms: Option<u64>,   // lane 2: per-case override, falls back to the request's time_limit_ms
    #[serde(default)]
    memory_limit_mb: Option<u64>, // lane 1: per-case override; only enforced with the `job-mem-cap` feature
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CphRunRequest {
    lang_key: String,
    binary: String, // from the matching cph_detect() Toolchain.binary — no re-probing here
    source: String,
    cases: Vec<CphCase>,
    time_limit_ms: u64,
    #[serde(default)]
    memory_limit_mb: Option<u64>, // panel-wide default (lane asked for 256 as the fallback)
    #[serde(default)]
    std: Option<String>, // pass #52: selected C++ standard (c++03..c++20); None = compiler default
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CphCompileRequest {
    lang_key: String,
    binary: String,
    source: String,
    #[serde(default)]
    std: Option<String>,
}

// Output structs are snake_case on purpose: lib/transport.ts, lib/cph.ts, tmath/solve.ts and
// main.ts all read compile_ok / compile_log / time_ms / lang_key. (They were camelCase before
// pass #11, which made every field the TS side reads come back undefined.)
#[derive(Serialize)]
pub struct CphCaseResult {
    id: String,
    verdict: String, // AC | WA | RE | TLE | MLE | RAN (no expected output given) | CANCELLED
    stdout: String,
    stderr: String,
    time_ms: u128,
    exit_code: Option<i32>,
}

#[derive(Serialize)]
pub struct CphRunResponse {
    compile_ok: bool,
    compile_log: String,
    results: Vec<CphCaseResult>,
    cancelled: bool,
}

#[derive(Serialize)]
pub struct CphCompileResponse {
    compile_ok: bool,
    compile_log: String,
    exit_code: Option<i32>,
    time_ms: u128,
    cancelled: bool,
}

// ---------- process capture ----------

struct Captured {
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    status: Option<ExitStatus>,
    elapsed_ms: u128,
    timed_out: bool,
    cancelled: bool,
    output_limited: bool,
    capture_err: Option<String>,
    peak_bytes: Option<u64>, // Some(_) only when built with `job-mem-cap` and attach succeeded
    spawn_err: Option<String>,
}

fn clip(bytes: &[u8]) -> String {
    let mut s = String::from_utf8_lossy(&bytes[..bytes.len().min(LOG_CAP)]).to_string();
    if bytes.len() > LOG_CAP { s.push_str("\n…(truncated)"); }
    s
}

// A regular file provides finite stdin without a blocking writer thread. A child
// that exits while a descendant keeps stdin open can no longer wedge a join.
struct InputSpool(PathBuf);
impl Drop for InputSpool {
    fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); }
}

fn spool_input(input: &str, job_id: u64) -> std::io::Result<(InputSpool, fs::File)> {
    let dir = new_tmp_dir(job_id).map_err(std::io::Error::other)?;
    let spool = InputSpool(dir);
    let mut file = fs::OpenOptions::new().read(true).write(true).create_new(true).open(spool.0.join("stdin"))?;
    file.write_all(input.as_bytes())?;
    file.seek(SeekFrom::Start(0))?;
    Ok((spool, file))
}

#[cfg(windows)]
trait CapturePipe: Read + std::os::windows::io::AsRawHandle + Send {}
#[cfg(windows)]
impl<T: Read + std::os::windows::io::AsRawHandle + Send> CapturePipe for T {}
#[cfg(unix)]
trait CapturePipe: Read + std::os::fd::AsRawFd + Send {}
#[cfg(unix)]
impl<T: Read + std::os::fd::AsRawFd + Send> CapturePipe for T {}

// Only read bytes known to be available. The reader owns this pipe exclusively,
// so another consumer cannot drain it between the readiness check and Read.
#[cfg(windows)]
fn pipe_ready(pipe: &impl CapturePipe) -> std::io::Result<Option<usize>> {
    use std::ffi::c_void;
    #[link(name = "kernel32")]
    extern "system" {
        fn PeekNamedPipe(handle: *mut c_void, buffer: *mut c_void, size: u32,
            read: *mut u32, available: *mut u32, remaining: *mut u32) -> i32;
    }
    let mut available = 0;
    let ok = unsafe { PeekNamedPipe(pipe.as_raw_handle(), std::ptr::null_mut(), 0,
        std::ptr::null_mut(), &mut available, std::ptr::null_mut()) };
    if ok != 0 { return Ok(Some(available as usize)); }
    let error = std::io::Error::last_os_error();
    if matches!(error.raw_os_error(), Some(109) | Some(233)) { Ok(None) } else { Err(error) }
}

#[cfg(unix)]
fn pipe_ready(pipe: &impl CapturePipe) -> std::io::Result<Option<usize>> {
    #[repr(C)]
    struct PollFd { fd: i32, events: i16, revents: i16 }
    extern "C" { fn poll(fds: *mut PollFd, count: usize, timeout: i32) -> i32; }
    let mut fd = PollFd { fd: pipe.as_raw_fd(), events: 1, revents: 0 }; // POLLIN
    let ready = unsafe { poll(&mut fd, 1, 0) };
    if ready < 0 { return Err(std::io::Error::last_os_error()); }
    // POLLHUP/POLLERR also require a final read, which returns remaining data/EOF.
    if ready == 0 { Ok(Some(0)) } else { Ok(Some(4096)) }
}

struct PipeOutput { bytes: Vec<u8>, error: Option<String> }

fn read_pipe(mut pipe: impl CapturePipe, stop: Arc<AtomicBool>, limited: Arc<AtomicBool>, failed: Arc<AtomicBool>) -> PipeOutput {
    let mut output = PipeOutput { bytes: Vec::new(), error: None };
    let mut chunk = [0u8; 4096];
    while !stop.load(Ordering::SeqCst) {
        let available = match pipe_ready(&pipe) {
            Ok(None) => break,
            Ok(Some(0)) => { std::thread::sleep(PIPE_POLL); continue; }
            Ok(Some(n)) => n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => { output.error = Some(e.to_string()); break; }
        };
        // The extra byte distinguishes exactly-at-limit output from overflow.
        let take = available.min(chunk.len()).min(OUTPUT_CAP - output.bytes.len() + 1);
        match pipe.read(&mut chunk[..take]) {
            Ok(0) => break,
            Ok(n) => {
                let retained = n.min(OUTPUT_CAP - output.bytes.len());
                output.bytes.extend_from_slice(&chunk[..retained]);
                if n > retained { limited.store(true, Ordering::SeqCst); break; }
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) if e.kind() == std::io::ErrorKind::BrokenPipe => break,
            Err(e) => { output.error = Some(e.to_string()); break; }
        }
    }
    if output.error.is_some() { failed.store(true, Ordering::SeqCst); }
    output
}

// Runs one process with a wall-clock limit, watching the job's cancel flag. No syscall
// sandbox regardless of platform — it is the user's own code running at the user's
// own privilege level, exactly like running it from a terminal. With the `job-mem-cap`
// feature on Windows, a committed-memory cap is attached too (see the `job` module);
// everywhere else, no memory limit. Threads drain stdout/stderr concurrently with the
// run so large output can't deadlock the pipe. Timeout and Stop both kill the whole tree.
fn capture(mut cmd: Command, input: Option<&str>, limit: Duration, _memory_limit_mb: Option<u64>, job: &ActiveJob) -> Captured {
    let mut result = Captured {
        stdout: Vec::new(), stderr: Vec::new(), status: None, elapsed_ms: 0,
        timed_out: false, cancelled: false, output_limited: false, capture_err: None,
        peak_bytes: None, spawn_err: None,
    };
    let mut input_spool = None;
    let stdin = match input.filter(|s| !s.is_empty()) {
        Some(input) => match spool_input(input, job.id) {
            Ok((spool, file)) => { input_spool = Some(spool); Stdio::from(file) }
            Err(e) => { result.spawn_err = Some(format!("stdin: {e}")); return result; }
        },
        None => Stdio::null(),
    };
    cmd.stdin(stdin).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0); // own group -> kill_tree can reach every descendant
    }
    let mut child: Child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            drop(cmd); // close the input handle before removing its temporary file
            result.spawn_err = Some(e.to_string());
            return result;
        }
    };
    drop(cmd);
    let pid = child.id();
    job.pid.store(pid, Ordering::SeqCst);

    #[cfg(all(windows, feature = "job-mem-cap"))]
    let _job = _memory_limit_mb.and_then(|mb| job::Job::attach(&child, mb));

    let stop_readers = Arc::new(AtomicBool::new(false));
    let limited = Arc::new(AtomicBool::new(false));
    let failed = Arc::new(AtomicBool::new(false));
    let stdout_pipe = child.stdout.take().expect("piped stdout");
    let stderr_pipe = child.stderr.take().expect("piped stderr");
    let (stop, cap, fail) = (stop_readers.clone(), limited.clone(), failed.clone());
    let out_reader = std::thread::spawn(move || read_pipe(stdout_pipe, stop, cap, fail));
    let (stop, cap, fail) = (stop_readers.clone(), limited.clone(), failed.clone());
    let err_reader = std::thread::spawn(move || read_pipe(stderr_pipe, stop, cap, fail));

    let start = Instant::now();
    loop {
        if result.status.is_none() {
            match child.try_wait() {
                Ok(status) => result.status = status,
                Err(e) => result.capture_err = Some(format!("wait: {e}")),
            }
        }
        result.cancelled = job.cancel.load(Ordering::SeqCst);
        result.output_limited = limited.load(Ordering::SeqCst);
        // Completion includes both pipe readers. A reaped parent is not proof that
        // inherited handles closed, so deadline and Stop remain live during drain.
        if result.status.is_some() && out_reader.is_finished() && err_reader.is_finished()
            && !result.cancelled && !result.output_limited && !failed.load(Ordering::SeqCst) {
            break;
        }
        result.timed_out = !result.cancelled && !result.output_limited && start.elapsed() >= limit;
        if result.cancelled || result.timed_out || result.output_limited || failed.load(Ordering::SeqCst) || result.capture_err.is_some() {
            kill_tree(pid);
            let _ = child.kill(); // fallback if taskkill/kill is unavailable
            if result.status.is_none() { result.status = child.wait().ok(); }
            break;
        }
        std::thread::sleep(PIPE_POLL);
    }

    // query peak memory BEFORE the job handle drops — dropping it (KILL_ON_JOB_CLOSE)
    // is also what guarantees any surviving descendant actually dies.
    #[cfg(all(windows, feature = "job-mem-cap"))]
    { result.peak_bytes = _job.as_ref().and_then(|j| j.peak_bytes()); drop(_job); }
    // Readers check this flag before every bounded nonblocking read. No blocked
    // worker is detached, even if a descendant escaped process-tree termination.
    stop_readers.store(true, Ordering::SeqCst);
    let stdout = out_reader.join();
    let stderr = err_reader.join();
    for (name, stream) in [("stdout", stdout), ("stderr", stderr)] {
        match stream {
            Ok(stream) => {
                if let Some(e) = stream.error { result.capture_err = Some(format!("{name}: {e}")); }
                if name == "stdout" { result.stdout = stream.bytes; } else { result.stderr = stream.bytes; }
            }
            Err(_) => result.capture_err = Some(format!("{name} reader panicked")),
        }
    }
    result.output_limited |= limited.load(Ordering::SeqCst);
    result.elapsed_ms = start.elapsed().as_millis();
    job.pid.store(0, Ordering::SeqCst);
    drop(child);
    drop(input_spool);
    result
}

struct RunOutcome {
    stdout: Vec<u8>,
    stderr: String,
    time_ms: u128,
    timed_out: bool,
    cancelled: bool,
    output_limited: bool,
    capture_failed: bool,
    exit_code: Option<i32>,
    peak_bytes: Option<u64>,
}

fn run_one(cmd: Command, input: &str, limit_ms: u64, memory_limit_mb: Option<u64>, job: &ActiveJob) -> RunOutcome {
    let c = capture(cmd, Some(input), Duration::from_millis(limit_ms), memory_limit_mb, job);
    if let Some(e) = c.spawn_err {
        return RunOutcome { stdout: Vec::new(), stderr: format!("spawn: {e}"), time_ms: 0, timed_out: false, cancelled: false, output_limited: false, capture_failed: true, exit_code: None, peak_bytes: None };
    }
    let mut stderr = clip(&c.stderr);
    if c.output_limited { stderr.push_str(&format!("\n{OUTPUT_LIMIT_MESSAGE}")); }
    if let Some(e) = &c.capture_err { stderr.push_str(&format!("\ncapture: {e}")); }
    RunOutcome {
        stdout: c.stdout,
        stderr,
        time_ms: c.elapsed_ms,
        timed_out: c.timed_out,
        cancelled: c.cancelled,
        output_limited: c.output_limited,
        capture_failed: c.capture_err.is_some(),
        exit_code: c.status.and_then(|s| s.code()),
        peak_bytes: c.peak_bytes,
    }
}

// ---------- build ----------

fn exe_path(tmp: &Path) -> PathBuf {
    tmp.join(if cfg!(windows) { "main.exe" } else { "main" })
}

fn source_name(lang_key: &str) -> Option<&'static str> {
    Some(match lang_key {
        "cpp" => "main.cpp",
        "rust" => "main.rs",
        "pascal" => "main.pas",
        "java" => "Main.java", // judge-shaped assumption, stated up front: `public class Main`. Surfaced in the UI tooltip too.
        "python" => "main.py",
        "javascript" => "main.js",
        "go" => "main.go",
        _ => return None,
    })
}

// What has to exist for a cached build dir to still be runnable.
fn artifact_path(lang_key: &str, tmp: &Path) -> PathBuf {
    match lang_key {
        "java" => tmp.join("Main.class"),
        "python" | "javascript" => tmp.join(source_name(lang_key).unwrap_or("main")),
        _ => exe_path(tmp),
    }
}

fn run_command(lang_key: &str, binary: &str, tmp: &Path) -> Result<Command, String> {
    match lang_key {
        "cpp" | "rust" | "pascal" | "go" => Ok(new_cmd(exe_path(tmp).to_string_lossy().as_ref())),
        "java" => {
            let mut c = new_cmd("java");
            c.current_dir(tmp).arg("-cp").arg(tmp).arg("Main");
            Ok(c)
        }
        "python" | "javascript" => {
            let mut c = new_cmd(binary);
            c.current_dir(tmp).arg(tmp.join(source_name(lang_key).unwrap_or("main")));
            Ok(c)
        }
        other => Err(format!("CPH: unsupported language '{other}'")),
    }
}

struct Prep {
    ok: bool,
    log: String,
    exit_code: Option<i32>,
    cancelled: bool,
}

fn compile_step(cmd: Command, who: &str, both_streams: bool, must_exist: Option<&Path>, job: &ActiveJob) -> Result<Prep, String> {
    let c = capture(cmd, None, COMPILE_LIMIT, None, job);
    if let Some(e) = c.spawn_err {
        return Err(format!("{who} spawn: {e}"));
    }
    let mut log = if both_streams {
        // fpc puts its errors on stdout, not stderr.
        format!("{}{}", clip(&c.stdout), clip(&c.stderr))
    } else {
        clip(&c.stderr)
    };
    if c.timed_out {
        log.push_str(&format!("\ncompile timed out after {} s", COMPILE_LIMIT.as_secs()));
    }
    if c.output_limited { log.push_str(&format!("\n{OUTPUT_LIMIT_MESSAGE}")); }
    if let Some(e) = &c.capture_err { log.push_str(&format!("\ncapture: {e}")); }
    let ok = !c.timed_out && !c.cancelled && !c.output_limited && c.capture_err.is_none() && c.status.map(|s| s.success()).unwrap_or(false) && must_exist.map(|p| p.exists()).unwrap_or(true);
    Ok(Prep { ok, log, exit_code: c.status.and_then(|s| s.code()), cancelled: c.cancelled })
}

fn ok_prep() -> Prep {
    Prep { ok: true, log: String::new(), exit_code: Some(0), cancelled: false }
}

// Writes the source and builds it. `check_scripts`: python/node have no build step; the explicit
// Compile button runs a syntax check for them (official client: "Kiểm tra cú pháp" on PY3),
// while Run skips it and lets the interpreter report any error per case, exactly as before.
fn prepare(lang_key: &str, binary: &str, source: &str, tmp: &Path, check_scripts: bool, job: &ActiveJob, std: Option<&str>) -> Result<Prep, String> {
    let name = source_name(lang_key).ok_or_else(|| format!("CPH: unsupported language '{lang_key}'"))?;
    let src = tmp.join(name);
    fs::write(&src, source).map_err(|e| format!("write source: {e}"))?;
    let bin = exe_path(tmp);
    match lang_key {
        "cpp" => {
            // pass #52: -std rides the selected judge language (c++03..c++20); None leaves the
            // toolchain's own default — the old hardcoded -std=c++17 restricted every compile.
            let mut c = new_cmd(binary);
            c.current_dir(tmp).arg("-O2");
            if let Some(s) = std { c.arg(format!("-std={s}")); }
            c.arg("-o").arg(&bin).arg(&src);
            compile_step(c, binary, false, None, job)
        }
        "rust" => {
            let mut c = new_cmd(binary);
            c.current_dir(tmp).arg("-O").arg("-o").arg(&bin).arg(&src);
            compile_step(c, binary, false, None, job)
        }
        "pascal" => {
            let mut c = new_cmd(binary);
            c.current_dir(tmp).arg("-O2").arg(format!("-o{}", bin.to_string_lossy())).arg(&src);
            compile_step(c, binary, true, Some(&bin), job)
        }
        "java" => {
            let mut c = new_cmd("javac");
            c.current_dir(tmp).arg("-d").arg(tmp).arg(&src);
            compile_step(c, "javac", false, None, job)
        }
        "go" => {
            // was `go run` per case (compile errors surfaced as per-case RE, and every case
            // recompiled). Building once gives a real compile step: CE state, faster cases.
            let mut c = new_cmd(binary);
            c.current_dir(tmp).arg("build").arg("-o").arg(&bin).arg(&src);
            compile_step(c, binary, false, Some(&bin), job)
        }
        "python" if check_scripts => {
            let mut c = new_cmd(binary);
            c.current_dir(tmp).arg("-m").arg("py_compile").arg(&src);
            compile_step(c, binary, false, None, job)
        }
        "javascript" if check_scripts => {
            let mut c = new_cmd(binary);
            c.current_dir(tmp).arg("--check").arg(&src);
            compile_step(c, binary, false, None, job)
        }
        _ => Ok(ok_prep()),
    }
}

// ---------- commands ----------

// trailing-whitespace / line-ending insensitive compare — standard judge-style normalization.
fn normalize(s: &str) -> String {
    s.replace("\r\n", "\n")
        .lines()
        .map(|l| l.trim_end())
        .collect::<Vec<_>>()
        .join("\n")
        .trim_end()
        .to_string()
}

fn compile_blocking(inner: Arc<Inner>, req: CphCompileRequest) -> Result<CphCompileResponse, String> {
    validate_binary(&inner, &req.lang_key, &req.binary)?; // pass #78: before any slot or process is touched
    let guard = JobGuard::begin(&inner)?;
    let t0 = Instant::now();
    let std = sanitize_std(&req.std);
    let tmp = new_tmp_dir(guard.job.id)?;
    let prep = match prepare(&req.lang_key, &req.binary, &req.source, &tmp, true, &guard.job, std.as_deref()) {
        Ok(p) => p,
        Err(e) => { let _ = fs::remove_dir_all(&tmp); return Err(e); }
    };
    if prep.ok {
        // keep the build: a Run on unchanged source reuses it instead of invoking the compiler again
        let artifact = artifact_path(&req.lang_key, &tmp);
        set_cache(&inner, Build { key: key_of(&req.lang_key, &req.binary, &req.source, std.as_deref()), tmp, artifact, log: prep.log.clone() });
    } else {
        let _ = fs::remove_dir_all(&tmp);
    }
    Ok(CphCompileResponse {
        compile_ok: prep.ok,
        compile_log: prep.log,
        exit_code: prep.exit_code,
        time_ms: t0.elapsed().as_millis(),
        cancelled: prep.cancelled,
    })
}

fn run_blocking(inner: Arc<Inner>, req: CphRunRequest) -> Result<CphRunResponse, String> {
    validate_binary(&inner, &req.lang_key, &req.binary)?; // pass #78: before any slot or process is touched
    let guard = JobGuard::begin(&inner)?;
    let job: &ActiveJob = &guard.job;
    let limit_ms = req.time_limit_ms.clamp(100, 10_000);
    let std = sanitize_std(&req.std);
    let key = key_of(&req.lang_key, &req.binary, &req.source, std.as_deref());

    let hit = {
        let cache = lock(&inner.cache);
        cache.as_ref().filter(|b| b.key == key && b.artifact.exists()).map(|b| (b.tmp.clone(), b.log.clone()))
    };
    let (tmp, compile_log) = match hit {
        Some(h) => h,
        None => {
            let tmp = new_tmp_dir(job.id)?;
            let prep = match prepare(&req.lang_key, &req.binary, &req.source, &tmp, false, job, std.as_deref()) {
                Ok(p) => p,
                Err(e) => { let _ = fs::remove_dir_all(&tmp); return Err(e); }
            };
            if !prep.ok {
                let _ = fs::remove_dir_all(&tmp);
                return Ok(CphRunResponse { compile_ok: false, compile_log: prep.log, results: vec![], cancelled: prep.cancelled });
            }
            let artifact = artifact_path(&req.lang_key, &tmp);
            set_cache(&inner, Build { key, tmp: tmp.clone(), artifact, log: prep.log.clone() });
            (tmp, prep.log)
        }
    };

    // NOTE for the lane-1 UI control (when it lands): 256MB is fine for cpp/py/js/go,
    // but the JVM commits hundreds of MB at startup before User code runs — a 256MB
    // commit cap strangles Java runs immediately. Default java runs higher (512+).
    let default_mem_mb = req.memory_limit_mb.unwrap_or(256); // lane 1's own stated default
    let mut results = Vec::with_capacity(req.cases.len());
    let mut cancelled = false;
    for case in &req.cases {
        if job.cancel.load(Ordering::SeqCst) { cancelled = true; break; }
        let cmd = run_command(&req.lang_key, &req.binary, &tmp)?;
        let case_limit_ms = case.time_limit_ms.unwrap_or(limit_ms).clamp(100, 10_000); // lane 2
        let case_mem_mb = case.memory_limit_mb.unwrap_or(default_mem_mb);
        let out = run_one(cmd, &case.input, case_limit_ms, Some(case_mem_mb), job);
        let verdict = if out.cancelled {
            "CANCELLED"
        } else if out.timed_out {
            "TLE"
        } else if out.output_limited || out.capture_failed {
            "RE"
        } else if out.exit_code != Some(0) {
            // peak_bytes is only ever Some(_) with `job-mem-cap` on Windows; everywhere
            // else this is always a plain RE, same as before lane 1 existed.
            match out.peak_bytes {
                Some(peak) if peak >= case_mem_mb.saturating_mul(1024 * 1024) => "MLE",
                _ => "RE",
            }
        } else {
            match case.expected.as_deref() {
                None => "RAN",
                Some(exp) if exp.trim().is_empty() => "RAN",
                Some(exp) => if normalize(&String::from_utf8_lossy(&out.stdout)) == normalize(exp) { "AC" } else { "WA" },
            }
        };
        let was_cancelled = out.cancelled;
        results.push(CphCaseResult {
            id: case.id.clone(), verdict: verdict.to_string(), stdout: clip(&out.stdout), stderr: out.stderr, time_ms: out.time_ms, exit_code: out.exit_code,
        });
        if was_cancelled { cancelled = true; break; }
    }
    Ok(CphRunResponse { compile_ok: true, compile_log, results, cancelled })
}

#[tauri::command]
pub async fn cph_compile(state: tauri::State<'_, CphState>, req: CphCompileRequest) -> Result<CphCompileResponse, String> {
    let inner = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || compile_blocking(inner, req)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn cph_run(state: tauri::State<'_, CphState>, req: CphRunRequest) -> Result<CphRunResponse, String> {
    let inner = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || run_blocking(inner, req)).await.map_err(|e| e.to_string())?
}

// Returns whether there was a job to stop. Cheap and non-blocking on purpose: the kill itself
// happens on the job's own poll thread.
#[tauri::command]
pub async fn cph_stop(state: tauri::State<'_, CphState>) -> Result<bool, String> {
    Ok(state.stop())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn binary_validation_rejects_unknown_executables() {
        let inner = Inner::default();
        for (lang, bin) in [("cpp", "cmd.exe"), ("python", "powershell"), ("cpp", "../../evil"), ("cpp", "")] {
            assert!(validate_binary(&inner, lang, bin).is_err(), "{lang}:{bin}");
        }
    }

    #[test]
    fn binary_validation_accepts_detector_candidates_for_their_language() {
        let inner = Inner::default();
        assert!(validate_binary(&inner, "cpp", "g++").is_ok());
        assert!(validate_binary(&inner, "cpp", "clang++").is_ok());
        assert!(validate_binary(&inner, "python", "python").is_ok());
        assert!(validate_binary(&inner, "python", "python3").is_ok());
        assert!(validate_binary(&inner, "java", "javac").is_ok());
        // a candidate of another language is NOT allowed
        assert!(validate_binary(&inner, "python", "g++").is_err());
    }

    #[test]
    fn binary_validation_accepts_live_detected_toolchains() {
        let inner = Inner::default();
        lock(&inner.allowed).detected.entry("cpp".into()).or_default().insert("C:\\mingw\\bin\\g++.exe".into());
        assert!(validate_binary(&inner, "cpp", "C:\\mingw\\bin\\g++.exe").is_ok());
        // detected for cpp, demanded for python — rejected
        assert!(validate_binary(&inner, "python", "C:\\mingw\\bin\\g++.exe").is_err());
    }

    #[test]
    fn binary_validation_accepts_registered_overrides_per_language() {
        let inner = Inner::default();
        lock(&inner.allowed).overrides.insert("cpp".into(), "C:\\tc\\g++-custom.exe".into());
        assert!(validate_binary(&inner, "cpp", "C:\\tc\\g++-custom.exe").is_ok());
        assert!(validate_binary(&inner, "python", "C:\\tc\\g++-custom.exe").is_err());
    }

    #[test]
    fn run_blocking_rejects_unknown_binary_before_any_process_work() {
        let inner = Arc::new(Inner::default());
        let req = CphRunRequest {
            lang_key: "cpp".into(),
            binary: "cmd.exe".into(),
            source: "int main(){}".into(),
            cases: vec![],
            time_limit_ms: 1000,
            memory_limit_mb: None,
            std: None,
        };
        match run_blocking(inner, req) {
            Err(e) => assert!(e.contains("not an allowed"), "{e}"),
            Ok(_) => panic!("cph_run accepted binary 'cmd.exe'"),
        }
    }
}
