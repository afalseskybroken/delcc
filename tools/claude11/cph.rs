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
use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::io::{Read, Write};
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

// ---------- lane 1: Windows Job Object memory cap, opt-in (`job-mem-cap` feature) ----------
// UNVERIFIED FFI — written without a Windows box or cargo to compile it. Kept behind a
// feature flag specifically so a struct-layout or signature mistake here can never take
// down the default build (which pass #6 proved compiles and runs). Try it in isolation:
// `cargo build --features job-mem-cap`. If it fails, everything else still ships clean.
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

fn key_of(lang_key: &str, binary: &str, source: &str) -> u64 {
    let mut h = DefaultHasher::new();
    lang_key.hash(&mut h);
    binary.hash(&mut h);
    source.hash(&mut h);
    h.finish()
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
pub async fn cph_detect() -> Vec<Toolchain> {
    tauri::async_runtime::spawn_blocking(detect_all).await.unwrap_or_default()
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
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CphCompileRequest {
    lang_key: String,
    binary: String,
    source: String,
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
    peak_bytes: Option<u64>, // Some(_) only when built with `job-mem-cap` and attach succeeded
    spawn_err: Option<String>,
}

fn clip(bytes: &[u8]) -> String {
    let mut s = String::from_utf8_lossy(&bytes[..bytes.len().min(LOG_CAP)]).to_string();
    if bytes.len() > LOG_CAP { s.push_str("\n…(truncated)"); }
    s
}

// Runs one process with a wall-clock limit, watching the job's cancel flag. No syscall
// sandbox regardless of platform — it is the user's own code running at the user's
// own privilege level, exactly like running it from a terminal. With the `job-mem-cap`
// feature on Windows, a committed-memory cap is attached too (see the `job` module);
// everywhere else, no memory limit. Threads drain stdout/stderr concurrently with the
// run so large output can't deadlock the pipe. Timeout and Stop both kill the whole tree.
fn capture(mut cmd: Command, input: Option<&str>, limit: Duration, _memory_limit_mb: Option<u64>, job: &ActiveJob) -> Captured {
    cmd.stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() }).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0); // own group -> kill_tree can reach every descendant
    }
    let mut child: Child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            return Captured {
                stdout: Vec::new(), stderr: Vec::new(), status: None, elapsed_ms: 0,
                timed_out: false, cancelled: false, peak_bytes: None, spawn_err: Some(e.to_string()),
            }
        }
    };
    let pid = child.id();
    job.pid.store(pid, Ordering::SeqCst);

    #[cfg(all(windows, feature = "job-mem-cap"))]
    let _job = _memory_limit_mb.and_then(|mb| job::Job::attach(&child, mb));

    let writer = child.stdin.take().map(|mut stdin| {
        let input_owned = input.unwrap_or("").to_string();
        std::thread::spawn(move || {
            let _ = stdin.write_all(input_owned.as_bytes()); // drops stdin on return -> EOF for the child
        })
    });
    let mut stdout_pipe = child.stdout.take().expect("piped stdout");
    let mut stderr_pipe = child.stderr.take().expect("piped stderr");
    let out_reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout_pipe.read_to_end(&mut buf);
        buf
    });
    let err_reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stderr_pipe.read_to_end(&mut buf);
        buf
    });

    let start = Instant::now();
    let mut timed_out = false;
    let mut cancelled = false;
    let status: Option<ExitStatus> = loop {
        match child.try_wait() {
            Ok(Some(st)) => break Some(st),
            Ok(None) => {
                if job.cancel.load(Ordering::SeqCst) {
                    cancelled = true;
                } else if start.elapsed() > limit {
                    timed_out = true;
                }
                if cancelled || timed_out {
                    kill_tree(pid);
                    let _ = child.kill(); // belt and braces if taskkill/kill itself was unavailable
                    break child.wait().ok();
                }
                std::thread::sleep(Duration::from_millis(15));
            }
            Err(_) => break None,
        }
    };
    let elapsed_ms = start.elapsed().as_millis();
    job.pid.store(0, Ordering::SeqCst);

    // query peak memory BEFORE the job handle drops — dropping it (KILL_ON_JOB_CLOSE)
    // is also what guarantees any surviving descendant actually dies.
    #[cfg(all(windows, feature = "job-mem-cap"))]
    let peak_bytes = _job.as_ref().and_then(|j| j.peak_bytes());
    #[cfg(not(all(windows, feature = "job-mem-cap")))]
    let peak_bytes: Option<u64> = None;

    if let Some(w) = writer { let _ = w.join(); }
    let stdout = out_reader.join().unwrap_or_default();
    let stderr = err_reader.join().unwrap_or_default();

    Captured { stdout, stderr, status, elapsed_ms, timed_out, cancelled, peak_bytes, spawn_err: None }
}

struct RunOutcome {
    stdout: String,
    stderr: String,
    time_ms: u128,
    timed_out: bool,
    cancelled: bool,
    exit_code: Option<i32>,
    peak_bytes: Option<u64>,
}

fn run_one(cmd: Command, input: &str, limit_ms: u64, memory_limit_mb: Option<u64>, job: &ActiveJob) -> RunOutcome {
    let c = capture(cmd, Some(input), Duration::from_millis(limit_ms), memory_limit_mb, job);
    if let Some(e) = c.spawn_err {
        return RunOutcome { stdout: String::new(), stderr: format!("spawn: {e}"), time_ms: 0, timed_out: false, cancelled: false, exit_code: None, peak_bytes: None };
    }
    RunOutcome {
        stdout: clip(&c.stdout),
        stderr: clip(&c.stderr),
        time_ms: c.elapsed_ms,
        timed_out: c.timed_out,
        cancelled: c.cancelled,
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
    let ok = !c.timed_out && !c.cancelled && c.status.map(|s| s.success()).unwrap_or(false) && must_exist.map(|p| p.exists()).unwrap_or(true);
    Ok(Prep { ok, log, exit_code: c.status.and_then(|s| s.code()), cancelled: c.cancelled })
}

fn ok_prep() -> Prep {
    Prep { ok: true, log: String::new(), exit_code: Some(0), cancelled: false }
}

// Writes the source and builds it. `check_scripts`: python/node have no build step; the explicit
// Compile button runs a syntax check for them (official client: "Kiểm tra cú pháp" on PY3),
// while Run skips it and lets the interpreter report any error per case, exactly as before.
fn prepare(lang_key: &str, binary: &str, source: &str, tmp: &Path, check_scripts: bool, job: &ActiveJob) -> Result<Prep, String> {
    let name = source_name(lang_key).ok_or_else(|| format!("CPH: unsupported language '{lang_key}'"))?;
    let src = tmp.join(name);
    fs::write(&src, source).map_err(|e| format!("write source: {e}"))?;
    let bin = exe_path(tmp);
    match lang_key {
        "cpp" => {
            let mut c = new_cmd(binary);
            c.current_dir(tmp).arg("-O2").arg("-std=c++17").arg("-o").arg(&bin).arg(&src);
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
    let guard = JobGuard::begin(&inner)?;
    let t0 = Instant::now();
    let tmp = new_tmp_dir(guard.job.id)?;
    let prep = match prepare(&req.lang_key, &req.binary, &req.source, &tmp, true, &guard.job) {
        Ok(p) => p,
        Err(e) => { let _ = fs::remove_dir_all(&tmp); return Err(e); }
    };
    if prep.ok {
        // keep the build: a Run on unchanged source reuses it instead of invoking the compiler again
        let artifact = artifact_path(&req.lang_key, &tmp);
        set_cache(&inner, Build { key: key_of(&req.lang_key, &req.binary, &req.source), tmp, artifact, log: prep.log.clone() });
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
    let guard = JobGuard::begin(&inner)?;
    let job: &ActiveJob = &guard.job;
    let limit_ms = req.time_limit_ms.clamp(100, 10_000);
    let key = key_of(&req.lang_key, &req.binary, &req.source);

    let hit = {
        let cache = lock(&inner.cache);
        cache.as_ref().filter(|b| b.key == key && b.artifact.exists()).map(|b| (b.tmp.clone(), b.log.clone()))
    };
    let (tmp, compile_log) = match hit {
        Some(h) => h,
        None => {
            let tmp = new_tmp_dir(job.id)?;
            let prep = match prepare(&req.lang_key, &req.binary, &req.source, &tmp, false, job) {
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
        } else if out.exit_code != Some(0) {
            // peak_bytes is only ever Some(_) with `job-mem-cap` on Windows; everywhere
            // else this is always a plain RE, same as before lane 1 existed.
            match out.peak_bytes {
                Some(peak) if peak >= case_mem_mb.saturating_mul(1024 * 1024) => "MLE",
                _ => "RE",
            }
        } else {
            match case.expected.as_deref().map(str::trim) {
                None | Some("") => "RAN",
                Some(exp) => if normalize(&out.stdout) == normalize(exp) { "AC" } else { "WA" },
            }
        };
        let was_cancelled = out.cancelled;
        results.push(CphCaseResult {
            id: case.id.clone(), verdict: verdict.to_string(), stdout: out.stdout, stderr: out.stderr, time_ms: out.time_ms, exit_code: out.exit_code,
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
