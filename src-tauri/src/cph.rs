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
use std::sync::mpsc;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

#[cfg(windows)]
pub(crate) fn new_cmd(bin: &str) -> Command {
    use std::os::windows::process::CommandExt;
    let mut c = Command::new(bin);
    c.creation_flags(0x08000000); // CREATE_NO_WINDOW — else every run flashes a console
    c
}
#[cfg(not(windows))]
pub(crate) fn new_cmd(bin: &str) -> Command {
    Command::new(bin)
}

/// Kills `pid` and every descendant. `Child::kill` only ever reaches the direct child, so a
/// `java`/`python` launcher, a shell-out, or a user program that forked would survive a timeout
/// or a Stop press and keep the stdout pipe open (which also wedges the reader threads).
/// Windows: `taskkill /T /F` (argv only, no shell). Elsewhere: the child was started as its own
/// process group leader (see `capture`), so a negative pid addresses the whole group.
pub(crate) fn kill_tree(pid: u32) {
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
pub(crate) mod job {
    use std::ffi::c_void;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        QueryInformationJobObject, SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_JOB_MEMORY, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    pub struct Job(HANDLE);
    // An exclusively-owned HANDLE is safe to move between threads; the debug session
    // (static Mutex) requires Send.
    unsafe impl Send for Job {}

    impl Job {
        // Best-effort only: any failure here just means no cap this run — same as before this lane.
        pub fn attach(child: &std::process::Child, memory_limit_mb: u64) -> Option<Job> {
            Self::attach_with(child, Some(memory_limit_mb))
        }
        // pass #106: KILL_ON_JOB_CLOSE only — the debugger's gdb+inferior tree must die with
        // delcc, but a debug run must NOT inherit the run memory cap (a heap-hungry program
        // is exactly when you step through it).
        pub fn track(child: &std::process::Child) -> Option<Job> {
            Self::attach_with(child, None)
        }
        fn attach_with(child: &std::process::Child, memory_limit_mb: Option<u64>) -> Option<Job> {
            unsafe {
                let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if job.is_null() { // windows-sys ≥0.52: HANDLE is a *mut c_void, not an isize — no == 0
                    return None;
                }
                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
                    | memory_limit_mb.map(|_| JOB_OBJECT_LIMIT_JOB_MEMORY).unwrap_or(0);
                info.JobMemoryLimit = memory_limit_mb.map(|mb| (mb as usize).saturating_mul(1024 * 1024)).unwrap_or(0);
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

// pass #142 (wave-8 W8-10): the spawn-to-assign window is CLOSED. A child spawned
// normally can fork a descendant BEFORE AssignProcessToJobObject runs — that descendant
// is never in the job, so the memory cap and KILL_ON_JOB_CLOSE do not reach it. The
// child is now created SUSPENDED (its single initial thread never runs), assigned, and
// only then resumed; anything it spawns from its first instruction onward inherits the
// job. A failed resume is fatal to the run (killed + error) rather than a silent hang.
#[cfg(all(windows, feature = "job-mem-cap"))]
pub(crate) fn spawn_suspended(cmd: &mut Command) -> std::io::Result<Child> {
    use std::os::windows::process::CommandExt;
    // CREATE_NO_WINDOW (the new_cmd default, re-applied) | CREATE_SUSPENDED
    cmd.creation_flags(0x0800_0000 | 0x0000_0004);
    cmd.spawn()
}

#[cfg(all(windows, feature = "job-mem-cap"))]
pub(crate) fn resume_process(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
    };
    use windows_sys::Win32::System::Threading::{OpenThread, ResumeThread, THREAD_SUSPEND_RESUME};
    unsafe {
        let snap: HANDLE = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
        if snap.is_null() {
            return false;
        }
        let mut entry: THREADENTRY32 = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<THREADENTRY32>() as u32;
        let mut resumed = false;
        if Thread32First(snap, &mut entry) != 0 {
            loop {
                if entry.th32OwnerProcessID == pid {
                    // a CREATE_SUSPENDED process owns exactly one thread — its entry
                    let h: HANDLE = OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID);
                    if !h.is_null() {
                        ResumeThread(h);
                        CloseHandle(h);
                        resumed = true;
                        break;
                    }
                }
                if Thread32Next(snap, &mut entry) == 0 {
                    break;
                }
            }
        }
        CloseHandle(snap);
        resumed
    }
}

// Spawn + job assignment in the W8-10 order (suspended → assign → resume), shared by
// the memory-capped run path and the debug engines' tracked spawns.
#[cfg(all(windows, feature = "job-mem-cap"))]
pub(crate) fn spawn_tracked_suspended(
    cmd: &mut Command,
    memory_limit_mb: Option<u64>,
) -> Result<(Child, Option<job::Job>), String> {
    let mut child = spawn_suspended(cmd).map_err(|e| e.to_string())?;
    let job = match memory_limit_mb {
        Some(mb) => job::Job::attach(&child, mb),
        None => job::Job::track(&child),
    };
    if !resume_process(child.id()) {
        let _ = child.kill();
        let _ = child.wait();
        return Err("resume after job assignment failed".into());
    }
    Ok((child, job))
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
pub(crate) struct Inner {
    active: Mutex<Option<Arc<ActiveJob>>>,
    cache: Mutex<Option<Build>>,
    allowed: Mutex<AllowedBinaries>, // pass #78: the exec allowlist, see validate_binary
    persist_dir: Mutex<Option<PathBuf>>, // pass #96: where the override registry lives
    detect_cache: Mutex<Option<(std::time::Instant, Vec<Toolchain>)>>, // pass #129 (A5): the 60 s detection TTL
    detect_gate: tauri::async_runtime::Mutex<()>, // pass #141 (W8-L01): concurrent detections coalesce here
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
    // pass #142 (wave-8 W8-06): binaries the detector probed WITHOUT any consent — the
    // trusted-installation class (PATH names, Program Files / user-profile fixed roots).
    // The debugger's sibling rule auto-trusts a gdb ONLY next to one of these; the
    // sibling of a confirmed planted candidate or of a Settings override rides the
    // debugger consent like every other unprobed executable.
    trusted_detect: HashSet<String>,
    overrides: HashMap<String, String>,         // lang_key -> Settings-registered path
    confirmed_fixed: HashSet<String>,           // pass #101: planted-root/extension candidates the user confirmed
    refused_fixed: HashSet<String>,             // pass #123 (wave-4 N6b): sticky refusal — the path is never re-asked and never re-run; Settings' explicit override is the way to change one's mind
}

#[derive(Default, Clone)]
pub struct CphState(Arc<Inner>);

static JOB_SEQ: AtomicU64 = AtomicU64::new(1);

pub(crate) struct JobGuard {
    inner: Arc<Inner>,
    job: Arc<ActiveJob>,
}

impl JobGuard {
    pub(crate) fn begin(inner: &Arc<Inner>) -> Result<JobGuard, String> {
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
    /// Where the persisted override registry lives (app data dir). Set once in setup().
    pub fn set_persist_dir(&self, dir: PathBuf) {
        *lock(&self.0.persist_dir) = Some(dir);
    }

    /// Boot-time load of the persisted override registry (pass #96). Entries already
    /// registered in this session win — the load only fills gaps. Pass #101: the file
    /// may be the OLD flat {lang: path} map or the NEW {overrides, confirmed_fixed}
    /// document — both load, the new format wins on save.
    pub fn load_persisted_overrides(&self) {
        let Some(dir) = lock(&self.0.persist_dir).clone() else { return; };
        let Ok(text) = fs::read_to_string(dir.join("cph-overrides.json")) else { return; };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else { return; };
        let mut allowed = lock(&self.0.allowed);
        let fill = |map: &serde_json::Map<String, serde_json::Value>, allowed: &mut AllowedBinaries| {
            for (lang, path) in map {
                if let Some(p) = path.as_str() {
                    allowed.overrides.entry(lang.clone()).or_insert_with(|| p.to_string());
                }
            }
        };
        match v.as_object() {
            Some(o) if o.contains_key("overrides") || o.contains_key("confirmed_fixed") || o.contains_key("refused_fixed") => {
                if let Some(m) = o.get("overrides").and_then(|m| m.as_object()) {
                    fill(m, &mut allowed);
                }
                if let Some(list) = o.get("confirmed_fixed").and_then(|l| l.as_array()) {
                    for p in list {
                        if let Some(s) = p.as_str() {
                            allowed.confirmed_fixed.insert(s.to_string());
                        }
                    }
                }
                if let Some(list) = o.get("refused_fixed").and_then(|l| l.as_array()) {
                    for p in list {
                        if let Some(s) = p.as_str() {
                            allowed.refused_fixed.insert(s.to_string());
                        }
                    }
                }
            }
            Some(o) => fill(o, &mut allowed), // old flat format
            None => {}                        // unrecognizable — ignore, do not poison the session
        }
    }

    /// Write the registry after every confirmed change (tmp + rename — a crash mid-write
    /// must never leave a half file that silently loses the user's confirmations).
    fn save_persisted_overrides(&self) {
        let Some(dir) = lock(&self.0.persist_dir).clone() else { return; };
        let (map, fixed, refused) = { let a = lock(&self.0.allowed); (a.overrides.clone(), a.confirmed_fixed.clone(), a.refused_fixed.clone()) };
        if fs::create_dir_all(&dir).is_err() { return; }
        let doc = serde_json::json!({ "overrides": map, "confirmed_fixed": fixed, "refused_fixed": refused });
        let Ok(json) = serde_json::to_string_pretty(&doc) else { return; };
        let tmp = dir.join("cph-overrides.json.tmp");
        if fs::write(&tmp, json).is_ok() {
            let _ = fs::rename(&tmp, dir.join("cph-overrides.json"));
        }
    }

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

#[derive(Serialize, Clone)]
pub struct Toolchain {
    lang_key: String, // matches lib/langmap.ts buckets: cpp/python/java/rust/go/pascal/javascript
    label: String,
    binary: String, // the exact candidate name that answered — fed back into cph_run
    version: String,
}

// pass #142 (wave-8 W8-07): the shared version-probe runner. Command::output() waits for
// EOF and buffers EVERYTHING — an approved-but-malfunctioning executable could hang
// detection forever (the spawn_blocking worker never returns; forced rescans piled up
// blocked workers) or flood host memory with version output. Every probe now runs under
// a hard deadline and a byte cap: both pipes are drained by threads into capped buffers,
// the child is killed at the deadline, and only a SUCCESS exit is admitted.
pub(crate) const PROBE_TIMEOUT: Duration = Duration::from_secs(5);
pub(crate) const PROBE_CAP: usize = 64 * 1024;

fn drain_capped<R: std::io::Read + Send + 'static>(pipe: R, cap: usize, tx: mpsc::Sender<Vec<u8>>) {
    std::thread::spawn(move || {
        let mut reader = pipe;
        let mut buf: Vec<u8> = Vec::new();
        let mut chunk = [0u8; 4096];
        loop {
            match reader.read(&mut chunk) {
                Ok(0) => break,
                Ok(n) => {
                    let room = cap.saturating_sub(buf.len());
                    let take = n.min(room);
                    buf.extend_from_slice(&chunk[..take]);
                    if buf.len() >= cap {
                        break; // cap reached — stop draining; the deadline path reaps the child
                    }
                }
                Err(_) => break,
            }
        }
        let _ = tx.send(buf);
    });
}

// Runs `bin args` with stdin closed, returns (exit_success, combined stdout+stderr up to
// ~2*cap). None = the child could not be spawned. A child that never exits is killed at
// the deadline; the pipes close and the drain threads finish.
pub(crate) fn probe_with_limit(bin: &str, args: &[&str], timeout: Duration, cap: usize) -> Option<(bool, String)> {
    let mut c = new_cmd(bin);
    c.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = c.spawn().ok()?;
    let out_pipe = child.stdout.take()?;
    let err_pipe = child.stderr.take()?;
    let (tx, rx) = mpsc::channel::<Vec<u8>>();
    drain_capped(out_pipe, cap, tx.clone());
    drain_capped(err_pipe, cap, tx);
    let deadline = Instant::now() + timeout;
    let mut collected: Vec<u8> = Vec::new();
    let mut readers_done = 0;
    while readers_done < 2 {
        let now = Instant::now();
        if now >= deadline {
            break;
        }
        match rx.recv_timeout(deadline - now) {
            Ok(buf) => {
                collected.extend_from_slice(&buf);
                readers_done += 1;
            }
            Err(_) => break, // timeout or disconnect — the deadline path owns it now
        }
    }
    // The child must be gone by the deadline too: a drain that stopped at the cap leaves
    // it blocked on a full pipe, so it is killed, not waited on forever.
    let mut status = None;
    while Instant::now() < deadline {
        match child.try_wait() {
            Ok(Some(s)) => {
                status = Some(s);
                break;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
            Err(_) => break,
        }
    }
    if status.is_none() {
        let _ = child.kill();
        status = child.wait().ok();
    }
    let ok = status.map(|s| s.success()).unwrap_or(false);
    Some((ok, String::from_utf8_lossy(&collected).into_owned()))
}

fn probe_one(candidates: &[&str], version_args: &[&str]) -> Option<(String, String)> {
    for bin in candidates {
        let Some((ok, combined)) = probe_with_limit(bin, version_args, PROBE_TIMEOUT, PROBE_CAP) else {
            continue;
        };
        // several of these (java -version, fpc -iV on some builds) write to stderr, not stdout.
        let first_line = combined.lines().next().unwrap_or("").trim().to_string();
        // Nyx pass #8 gate, re-ported over the Claude pass #11 payload: a probe must SUCCEED and
        // print its own version. The Microsoft Store app-execution-alias stubs (python3/python)
        // run fine, print "Python was not found..." and exit 9009 — the first real detect
        // claimed the stub as a Python toolchain. status gate + marketing-line guard.
        const NOT_FOUND: &str = "was not found";
        if ok && !first_line.is_empty() && !first_line.contains(NOT_FOUND) {
            return Some((bin.to_string(), first_line));
        }
    }
    None
}

fn push(out: &mut Vec<Toolchain>, lang_key: &str, label: &str, found: Option<(String, String)>) {
    if let Some((binary, version)) = found {
        out.push(Toolchain { lang_key: lang_key.into(), label: label.into(), binary, version });
    }
}

fn have(out: &[Toolchain], lang_key: &str) -> bool {
    out.iter().any(|t| t.lang_key == lang_key)
}

// pass #100 (He: "more probing locations — standard default installation paths of
// common compilers/interpreters, if non-PATH'd"): after the PATH probes fail for a
// language, try the well-known fixed install locations. is_file() gates every
// pass #123 (wave-4 N6b, audit- + adjudication-confirmed): a PLANTED candidate is a
// PATH, not a toolchain. The version probe EXECUTES the file, and execution now
// happens only AFTER the native confirmation in cph_detect accepts the path
// (existence-checked only here — `is_file` runs no code). Refusals persist too, so
// a path is asked exactly once, ever. The comment this replaces claimed planted
// candidates were "never executed-or-admitted silently" while push_fixed ran
// `<candidate> --version` before anyone was asked — the exact gap N6b names; this
// restructure makes the claim true.
struct PlantedCandidate {
    lang_key: String,
    label: String,
    path: std::path::PathBuf,
    version_args: &'static [&'static str],
}

fn have_planted(planted: &[PlantedCandidate], lang_key: &str) -> bool {
    planted.iter().any(|c| c.lang_key == lang_key)
}

fn push_fixed(out: &mut Vec<Toolchain>, planted: &mut Vec<PlantedCandidate>, plant: bool, lang_key: &str, label: &str, candidates: Vec<std::path::PathBuf>, version_args: &'static [&'static str]) {
    if have(out, lang_key) || have_planted(planted, lang_key) {
        return;
    }
    for c in candidates {
        if !c.is_file() {
            continue;
        }
        if plant {
            // existence check only — the probe (an execution) is gated by consent in cph_detect
            planted.push(PlantedCandidate { lang_key: lang_key.into(), label: label.into(), path: c, version_args });
            return;
        }
        if let Some((binary, version)) = probe_one(&[c.to_string_lossy().as_ref()], version_args) {
            out.push(Toolchain { lang_key: lang_key.into(), label: label.into(), binary, version });
            return;
        }
    }
}

// Version-numbered install dirs (Python312, jdk-21.0.3, 3.2.2 …): newest first so the
// probe prefers the latest toolchain when several are installed.
fn glob_dirs(dir: &std::path::Path, prefix: &str) -> Vec<std::path::PathBuf> {
    let mut v: Vec<std::path::PathBuf> = match std::fs::read_dir(dir) {
        Ok(rd) => rd
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| p.is_dir() && p.file_name().is_some_and(|n| n.to_string_lossy().starts_with(prefix)))
            .collect(),
        Err(_) => Vec::new(),
    };
    v.sort();
    v.reverse();
    v
}

// pass #100 (He: "same for probing compiler/interpreter off VSCode"): some VS Code
// extensions bundle a MinGW/Python toolchain. The scan is BOUNDED so it can never
// become a filesystem crawl: direct extension dirs only (60 max), walk depth 3,
// hard entry cap, node_modules/.git pruned, at most two hits per language.
fn walk_find(dir: &std::path::Path, name: &str, depth: u8, checked: &mut usize, cap: usize) -> Vec<std::path::PathBuf> {
    let mut found = Vec::new();
    if depth == 0 || *checked >= cap {
        return found;
    }
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.filter_map(|e| e.ok()) {
            *checked += 1;
            if *checked >= cap {
                break;
            }
            let p = e.path();
            let fname = p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
            if fname == "node_modules" || fname == ".git" {
                continue;
            }
            if p.is_file() && fname == name {
                found.push(p);
            } else if p.is_dir() {
                found.extend(walk_find(&p, name, depth - 1, checked, cap));
            }
            if found.len() >= 2 {
                break;
            }
        }
    }
    found
}

fn vscode_extension_toolchains(profile: &std::path::Path) -> (Vec<std::path::PathBuf>, Vec<std::path::PathBuf>) {
    let mut gpp = Vec::new();
    let mut py = Vec::new();
    let ext = profile.join(".vscode").join("extensions");
    let mut checked = 0usize;
    if let Ok(rd) = std::fs::read_dir(&ext) {
        for e in rd.filter_map(|e| e.ok()).take(60) {
            let d = e.path();
            if !d.is_dir() {
                continue;
            }
            if gpp.len() < 2 {
                gpp.extend(walk_find(&d, "g++.exe", 3, &mut checked, 400).into_iter().take(2));
            }
            if py.len() < 2 {
                py.extend(walk_find(&d, "python.exe", 3, &mut checked, 400).into_iter().take(2));
            }
            if gpp.len() >= 2 && py.len() >= 2 {
                break;
            }
        }
    }
    (gpp, py)
}

// Returns (trusted, planted): trusted = PATH + admin-writable Program Files roots +
// the running user's own profile dirs (LOCALAPPDATA/USERPROFILE — a same-account
// attacker can already execute code, so there is nothing to gate); planted = C:\-root
// dirs (a standard user can create those on default Windows) and VS Code extension
// bundles — each gated by the native confirmation in cph_detect before any use.
fn detect_all() -> (Vec<Toolchain>, Vec<PlantedCandidate>) {
    let mut out = Vec::new();
    let mut planted: Vec<PlantedCandidate> = Vec::new();
    // PATH probes first — a toolchain the user put on PATH always wins.
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
    let local = std::env::var_os("LOCALAPPDATA").map(std::path::PathBuf::from);
    let profile = std::env::var_os("USERPROFILE").map(std::path::PathBuf::from);
    let pf = |p: std::path::PathBuf| -> Vec<std::path::PathBuf> { vec![p] };
    // pass #99/#100: trusted fixed locations — admin-writable Program Files and the
    // per-user profile dirs (Code::Blocks per-user, Dev-C++ all-users, rustup, Node).
    push_fixed(&mut out, &mut planted, false, "cpp", "C++", {
        let mut v = Vec::new();
        if let Some(lad) = &local {
            v.push(lad.join(r"Programs\CodeBlocks\MinGW\bin\g++.exe"));
        }
        v.extend([
            std::path::PathBuf::from(r"C:\Program Files\CodeBlocks\MinGW\bin\g++.exe"),
            std::path::PathBuf::from(r"C:\Program Files (x86)\Dev-Cpp\MinGW64\bin\g++.exe"),
        ]);
        v
    }, &["--version"]);
    // python: per-user installer default (newest first) + Program Files — trusted
    if let Some(lad) = &local {
        for d in glob_dirs(&lad.join(r"Programs\Python"), "Python") {
            push_fixed(&mut out, &mut planted, false, "python", "Python", pf(d.join("python.exe")), &["--version"]);
            if have(&out, "python") {
                break;
            }
        }
    }
    if !have(&out, "python") {
        for d in glob_dirs(std::path::Path::new(r"C:\Program Files"), "Python") {
            push_fixed(&mut out, &mut planted, false, "python", "Python", pf(d.join("python.exe")), &["--version"]);
            if have(&out, "python") {
                break;
            }
        }
    }
    // rustup's default never touches PATH on machines where cargo was skipped
    if let Some(prof) = &profile {
        push_fixed(&mut out, &mut planted, false, "rust", "Rust", pf(prof.join(r".cargo\bin\rustc.exe")), &["--version"]);
    }
    push_fixed(&mut out, &mut planted, false, "go", "Go", vec![
        std::path::PathBuf::from(r"C:\Program Files\Go\bin\go.exe"),
    ], &["version"]);
    push_fixed(&mut out, &mut planted, false, "javascript", "Node.js", vec![
        std::path::PathBuf::from(r"C:\Program Files\nodejs\node.exe"),
    ], &["--version"]);
    // java: the JDK vendors' default roots (newest first); both javac and java must
    // answer from the SAME directory, matching the PATH rule above.
    if !have(&out, "java") {
        'java: for root in [std::path::PathBuf::from(r"C:\Program Files\Java"), std::path::PathBuf::from(r"C:\Program Files\Eclipse Adoptium"), std::path::PathBuf::from(r"C:\Program Files (x86)\Java")] {
            for d in glob_dirs(&root, "jdk") {
                let bin = d.join("bin");
                let javac = bin.join("javac.exe");
                let java = bin.join("java.exe");
                if javac.is_file() && java.is_file() {
                    if let (Some((_c1, jc)), Some((_c2, _jr))) = (
                        probe_one(&[javac.to_string_lossy().as_ref()], &["-version"]),
                        probe_one(&[java.to_string_lossy().as_ref()], &["-version"]),
                    ) {
                        out.push(Toolchain {
                            lang_key: "java".into(),
                            label: "Java".into(),
                            binary: javac.to_string_lossy().to_string(),
                            version: jc,
                        });
                        break 'java;
                    }
                }
            }
        }
    }
    // pass #101 (wave-3 N6): PLANTED-root candidates — standard users can create C:\
    // dirs on default Windows, so a cross-user plant lands here and must be confirmed
    // before delcc ever executes it. Same toolchains as #100, relocated by trust.
    push_fixed(&mut out, &mut planted, true, "cpp", "C++", vec![
        std::path::PathBuf::from(r"C:\MinGW\bin\g++.exe"),
        std::path::PathBuf::from(r"C:\mingw64\bin\g++.exe"),
        std::path::PathBuf::from(r"C:\TDM-GCC-64\bin\g++.exe"),
        std::path::PathBuf::from(r"C:\msys64\mingw64\bin\g++.exe"),
        std::path::PathBuf::from(r"C:\msys64\ucrt64\bin\g++.exe"),
        std::path::PathBuf::from(r"C:\Dev-Cpp\MinGW64\bin\g++.exe"),
    ], &["--version"]);
    if !have(&out, "python") && !have_planted(&planted, "python") {
        for d in glob_dirs(std::path::Path::new(r"C:\"), "Python3") {
            push_fixed(&mut out, &mut planted, true, "python", "Python", pf(d.join("python.exe")), &["--version"]);
            if have(&out, "python") || have_planted(&planted, "python") {
                break;
            }
        }
    }
    push_fixed(&mut out, &mut planted, true, "go", "Go", vec![
        std::path::PathBuf::from(r"C:\Go\bin\go.exe"),
    ], &["version"]);
    // FPC ships versioned (C:\FPC\3.2.2\bin\...); Lazarus bundles its own at C:\lazarus
    if !have(&out, "pascal") && !have_planted(&planted, "pascal") {
        'fpc: for root in [std::path::PathBuf::from(r"C:\FPC"), std::path::PathBuf::from(r"C:\lazarus\fpc")] {
            for d in glob_dirs(&root, "") {
                for arch in ["i386-win32", "x86_64-win64"] {
                    let exe = d.join("bin").join(arch).join("fpc.exe");
                    if exe.is_file() {
                        push_fixed(&mut out, &mut planted, true, "pascal", "Pascal", pf(exe), &["-iV"]);
                        if have(&out, "pascal") || have_planted(&planted, "pascal") {
                            break 'fpc;
                        }
                    }
                }
            }
        }
    }
    // VS Code extension-bundled toolchains (bounded scan) — planted: an extension dir
    // is same-account writable, and conservatively we confirm before executing
    if let Some(prof) = &profile {
        let (gpp, py) = vscode_extension_toolchains(prof);
        for p in gpp {
            push_fixed(&mut out, &mut planted, true, "cpp", "C++", pf(p), &["--version"]);
            if have(&out, "cpp") || have_planted(&planted, "cpp") {
                break;
            }
        }
        for p in py {
            push_fixed(&mut out, &mut planted, true, "python", "Python", pf(p), &["--version"]);
            if have(&out, "python") || have_planted(&planted, "python") {
                break;
            }
        }
    }
    (out, planted)
}

// Async + spawn_blocking: a plain `fn` command runs on the main thread in Tauri 2 and the
// probes (java -version in particular) would freeze the window while they run.
#[tauri::command]
pub async fn cph_detect(state: tauri::State<'_, CphState>, force: Option<bool>) -> Result<Vec<Toolchain>, String> {
    // pass #129 (attack-surface A5/P5): the full probe set spawns 10–30 short-lived
    // processes per call, and the command is reachable by any page JS — the pinned CSP
    // was the only wall between a compromised page and a spawn loop running for the
    // app's lifetime. A 60 s TTL cache turns "unbounded spawn loop" into "one spawn set
    // per minute"; the cached answer is the POST-consent result (confirmed planted
    // entries included), and the Settings button passes force=true for a real re-scan —
    // the change-of-mind path that also refreshes the cache.
    const DETECT_TTL: std::time::Duration = std::time::Duration::from_secs(60);
    let force = force.unwrap_or(false);
    if !force {
        let cached = lock(&state.0.detect_cache);
        if let Some((at, tcs)) = cached.as_ref() {
            if at.elapsed() < DETECT_TTL {
                return Ok(tcs.clone());
            }
        }
    }
    // pass #141 (wave-8 W8-L01): force=true used to skip the TTL entirely — page JS
    // could issue concurrent forced calls and each would run the full 10–30-process
    // probe set, bypassing exactly the spawn-loop mitigation the cache provides. ALL
    // detection now serializes on one async gate: a caller arriving mid-scan waits for
    // the winner, then reads the cache it just wrote; and a forced rescan is honored at
    // most once per 3 s (the Settings change-of-mind button keeps working — a loop of
    // forced calls degrades to the cached answer instead of a spawn storm).
    const FORCE_MIN_INTERVAL: std::time::Duration = std::time::Duration::from_secs(3);
    let _gate = state.0.detect_gate.lock().await;
    {
        let cached = lock(&state.0.detect_cache);
        if let Some((at, tcs)) = cached.as_ref() {
            if at.elapsed() < DETECT_TTL || (force && at.elapsed() < FORCE_MIN_INTERVAL) {
                return Ok(tcs.clone());
            }
        }
    }
    let (mut found, planted) = tauri::async_runtime::spawn_blocking(detect_all).await.unwrap_or_default();
    // pass #101/#123 (wave-4 N6b): planted candidates (C:\-root dirs, VS Code extension
    // bundles) NEVER execute until the native confirmation accepts the path — the
    // version probe IS an execution, so consent now comes strictly FIRST (the old
    // order probed and then asked, running a planted file before anyone was asked;
    // the dialog also no longer shows a version string obtained by running the very
    // thing it asks about). An acceptance persists and probes here; a refusal
    // persists too (pass #123), so the path is never re-asked and never re-run —
    // Settings' explicit override is the way to change one's mind.
    for cand in planted {
        let path_str = cand.path.to_string_lossy().to_string();
        let (confirmed, refused) = {
            let allowed = lock(&state.0.allowed);
            (allowed.confirmed_fixed.contains(&path_str), allowed.refused_fixed.contains(&path_str))
        };
        if refused {
            continue; // sticky refusal — do not ask again, do not run
        }
        if !confirmed && !confirm_override(&cand.lang_key, &path_str) {
            let mut allowed = lock(&state.0.allowed);
            if allowed.refused_fixed.insert(path_str) {
                drop(allowed);
                state.save_persisted_overrides();
            }
            continue;
        }
        if !confirmed {
            let mut allowed = lock(&state.0.allowed);
            if allowed.confirmed_fixed.insert(path_str.clone()) {
                drop(allowed);
                state.save_persisted_overrides();
            }
        }
        // consent (or a prior acceptance) is on record — only NOW does the candidate run
        if let Some((binary, version)) = probe_one(&[path_str.as_str()], cand.version_args) {
            found.push(Toolchain { lang_key: cand.lang_key, label: cand.label, binary, version });
        }
    }
    {
        let mut allowed = lock(&state.0.allowed);
        allowed.detected = found.iter().fold(HashMap::new(), |mut m, t| {
            m.entry(t.lang_key.clone()).or_default().insert(t.binary.clone());
            m
        });
        // pass #142 (W8-06): the trust class split — everything detected WITHOUT consent
        // is a trusted installation; confirmed planted candidates (their paths sit in
        // confirmed_fixed) and Settings overrides (the overrides map) name a path the
        // user chose for the COMPILER, and their sibling gdb never was.
        allowed.trusted_detect = found
            .iter()
            .filter(|t| {
                !allowed.confirmed_fixed.contains(&t.binary)
                    && !allowed.overrides.values().any(|v| v == &t.binary)
            })
            .map(|t| t.binary.clone())
            .collect();
    }
    *lock(&state.0.detect_cache) = Some((std::time::Instant::now(), found.clone()));
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

// The version flag each language's own detector probe answers with — kept for reference
// in comments only; see confirm_override below for why probing is NOT the override gate.

// Settings' per-language toolchain override (lib/cph.ts) mirrors its choice here so
// cph_run/cph_compile can admit it. pass #96 (re-audit N1): shape + existence alone
// admitted ANY existing file — the webview could register cmd.exe silently and only the
// pinned CSP stood in the way. A version-probe gate was tried first and DROPPED: console
// binaries like cmd.exe exit 0 printing interactive banners ("Microsoft Windows
// [Version 10.0.…]"), so classifying binaries by their --version output is whack-a-mole.
// The robust boundary is the one the re-audit recommended: the confirmation happens
// OUTSIDE the page — a native dialog the user must accept. Registration persists across
// sessions, so the dialog fires only when an override actually changes (first set, or a
// value the persisted registry does not already hold). Blank clears the registration.
// pass #101 (wave-3 N1b, audit-confirmed): the dialog was MB_OKCANCEL but the result
// was compared to IDYES — an OK/Cancel box returns IDOK/IDCANCEL, never IDYES, so the
// confirmation could NEVER succeed and no toolchain override was ever registrable.
// MB_YESNO matches the question being asked; the return-code mapping is a pure fn so
// tests reach it on every platform (the dialog itself stays cfg'd out of tests).
fn confirm_rc_is_yes(rc: i32) -> bool {
    rc == 6 // windows_sys IDYES; 1=IDOK, 2=IDCANCEL, 7=IDNO all refuse
}

// pass #102 (wave-3 P2): the button set is stated ONCE, as raw values usable on every
// platform, so the pairing test can pin the rc mapping to the actual dialog — N1b's
// root cause was precisely a flag/mapping mismatch (OK/Cancel buttons paired with an
// IDYES check). Values: MB_YESNO=0x4, MB_ICONQUESTION=0x20, MB_SETFOREGROUND=0x10000,
// MB_TOPMOST=0x40000 (windows_sys constants).
const OVERRIDE_DIALOG_FLAGS: u32 = 0x4 | 0x20 | 0x10000 | 0x40000;

#[cfg(all(windows, not(test)))]
fn confirm_override(lang_key: &str, bin: &str) -> bool {
    confirm_dialog(
        "delcc \u{2014} toolchain override",
        &format!(
            "Allow \u{201c}{bin}\u{201d} to be used as the {lang_key} toolchain?\r\n\r\nOnly confirm a path you chose yourself in delcc Settings. Refuse anything else."
        ),
    )
}
// pass #129 (attack-surface A3 symmetry): the debugger consent uses the same native-dialog
// machinery with its own wording. pass #142 (wave-8 W8-06): this gate now covers every
// debugger candidate that is NOT auto-trusted — PATH-derived ones AND the sibling gdb of
// a consent-gated or Settings-overridden compiler (the user's action named the compiler,
// never the debugger beside it) — so "came off PATH" alone would understate the gate.
#[cfg(all(windows, not(test)))]
fn confirm_debugger(bin: &str) -> bool {
    confirm_dialog(
        "delcc \u{2014} debugger consent",
        &format!(
            "Allow \u{201c}{bin}\u{201d} to run as the step-by-step debugger?\r\n\r\ndelcc only auto-trusts the debugger shipped beside a toolchain it detected on its own. This candidate was not. Refuse it if you did not install it."
        ),
    )
}
// pass #129: the MessageBoxW body both consent dialogs share (the button set, flags, and
// rc mapping stay exactly the ones pinned by #101/#102).
#[cfg(all(windows, not(test)))]
fn confirm_dialog(title: &str, message: &str) -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::MessageBoxW;
    let text: Vec<u16> = message.encode_utf16().chain(std::iter::once(0)).collect();
    let title: Vec<u16> = format!("{title}\u{0}").encode_utf16().collect();
    unsafe {
        confirm_rc_is_yes(MessageBoxW(
            std::ptr::null_mut(),
            text.as_ptr(),
            title.as_ptr(),
            OVERRIDE_DIALOG_FLAGS,
        ))
    }
}
#[cfg(any(not(windows), test))]
fn confirm_override(_lang_key: &str, _bin: &str) -> bool {
    true // test builds and non-Windows builds have no dialog to show
}
#[cfg(any(not(windows), test))]
fn confirm_debugger(_bin: &str) -> bool {
    true // test builds and non-Windows builds have no dialog to show
}

// pass #129 (attack-surface A3 symmetry): the planted-class confirm-once pattern (#123's
// A2 fix) applied to the debug lane's gdb selection. A PATH-derived gdb is not the
// compiler's own toolchain — the version gate alone admits any gdb.exe that prints a
// plausible number (audit A3.2), and probing it IS an execution. Consent comes strictly
// BEFORE the probe; refusals are sticky and persisted (never re-asked, never re-run);
// acceptances are persisted too, so the dialog fires once per path, ever. Sibling-of-
// compiler candidates never reach here (they inherit the allowlist's trust in the
// compiler — see debug.rs find_gdb_candidates).
pub(crate) fn consent_debugger(state: &CphState, bin: &str) -> bool {
    let (confirmed, refused) = {
        let allowed = lock(&state.0.allowed);
        (allowed.confirmed_fixed.contains(bin), allowed.refused_fixed.contains(bin))
    };
    if refused {
        return false; // sticky refusal — do not ask again, do not run
    }
    if confirmed {
        return true;
    }
    if !confirm_debugger(bin) {
        let mut allowed = lock(&state.0.allowed);
        if allowed.refused_fixed.insert(bin.to_string()) {
            drop(allowed);
            state.save_persisted_overrides();
        }
        return false;
    }
    let mut allowed = lock(&state.0.allowed);
    if allowed.confirmed_fixed.insert(bin.to_string()) {
        drop(allowed);
        state.save_persisted_overrides();
    }
    true
}

#[tauri::command]
pub async fn cph_set_override(state: tauri::State<'_, CphState>, lang_key: String, binary: String) -> Result<(), String> {
    let bin = binary.trim().to_string();
    if bin.is_empty() {
        let changed = { lock(&state.0.allowed).overrides.remove(&lang_key).is_some() };
        if changed { state.save_persisted_overrides(); }
        return Ok(());
    }
    validate_binary_shape(&bin)?;
    if (bin.contains('\\') || bin.contains('/')) && !Path::new(&bin).is_file() {
        return Err(format!("CPH: no file at '{bin}'"));
    }
    // already registered verbatim → silent no-op (the mirror fires on every boot/run)
    {
        let allowed = lock(&state.0.allowed);
        if allowed.overrides.get(&lang_key).map(|v| v == &bin).unwrap_or(false) {
            return Ok(());
        }
    }
    if !confirm_override(&lang_key, &bin) {
        return Err(format!(
            "CPH: the {lang_key} toolchain override was not confirmed — nothing registered"
        ));
    }
    lock(&state.0.allowed).overrides.insert(lang_key, bin);
    state.save_persisted_overrides();
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
    // pass #142 (wave-8 W8-10): a memory-capped run spawns SUSPENDED, attaches to its
    // Job, then resumes — the old spawn-then-attach window let a fast child fork a
    // descendant the cap and KILL_ON_JOB_CLOSE never covered. Runs without a cap keep
    // the plain spawn (their containment is kill_tree, which reaches the whole tree).
    #[cfg(all(windows, feature = "job-mem-cap"))]
    let (mut child, _job) = match _memory_limit_mb {
        Some(_) => match spawn_tracked_suspended(&mut cmd, _memory_limit_mb) {
            Ok(pair) => pair,
            Err(e) => {
                drop(cmd); // close the input handle before removing its temporary file
                result.spawn_err = Some(e);
                return result;
            }
        },
        None => (
            match cmd.spawn() {
                Ok(c) => c,
                Err(e) => {
                    drop(cmd);
                    result.spawn_err = Some(e.to_string());
                    return result;
                }
            },
            None,
        ),
    };
    #[cfg(not(all(windows, feature = "job-mem-cap")))]
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
            // pass #123 (attack-surface A4): the allowlist validates a specific javac
            // path — run ITS SIBLING java so the runtime is the same JDK the detector
            // answered with and Settings displays. Bare "javac" has no sibling dir to
            // speak of → honest PATH fallback, exactly the pre-#123 behavior.
            let sibling = Path::new(binary).parent().map(|d| d.join("java.exe")).filter(|p| p.is_file());
            let mut c = match sibling {
                Some(j) => new_cmd(j.to_string_lossy().as_ref()),
                None => new_cmd("java"),
            };
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
// `debug`: pass #106 — the -g -O0 build for the step-by-step debugger (same allowlisted
// compiler, same tmp layout; only the optimization flags differ).
#[allow(clippy::too_many_arguments)] // the flags are orthogonal; a struct would just move the noise
fn prepare(lang_key: &str, binary: &str, source: &str, tmp: &Path, check_scripts: bool, job: &ActiveJob, std: Option<&str>, debug: bool) -> Result<Prep, String> {
    let name = source_name(lang_key).ok_or_else(|| format!("CPH: unsupported language '{lang_key}'"))?;
    let src = tmp.join(name);
    fs::write(&src, source).map_err(|e| format!("write source: {e}"))?;
    let bin = exe_path(tmp);
    match lang_key {
        "cpp" => {
            // pass #52: -std rides the selected judge language (c++03..c++20); None leaves the
            // toolchain's own default — the old hardcoded -std=c++17 restricted every compile.
            let mut c = new_cmd(binary);
            c.current_dir(tmp);
            if debug { c.arg("-g").arg("-O0"); } else { c.arg("-O2"); }
            if let Some(s) = std { c.arg(format!("-std={s}")); }
            c.arg("-o").arg(&bin).arg(&src);
            compile_step(c, binary, false, None, job)
        }
        "rust" => {
            let mut c = new_cmd(binary);
            // pass #124: the step-by-step lane builds with `-g` (debuginfo) — gdb maps
            // the binary back to the draft's lines; there is no -O0 concept in rustc
            // and unoptimized codegen is what stepping wants.
            if debug { c.arg("-g"); } else { c.arg("-O"); }
            c.arg("-o").arg(&bin).arg(&src);
            compile_step(c, binary, false, None, job)
        }
        "pascal" => {
            let mut c = new_cmd(binary);
            // pass #124: `-g` (DWARF) for the step-by-step lane — gdb steps fpc output.
            if debug { c.arg("-g"); } else { c.arg("-O2"); }
            c.arg("-o").arg(&bin).arg(&src);
            compile_step(c, binary, true, Some(&bin), job)
        }
        "java" => {
            // pass #123 (attack-surface A4): compile with the VALIDATED javac — the
            // #78 gate validated a specific binary; running bare PATH javac instead
            // meant the gate's promise wasn't the whole truth for java.
            let mut c = new_cmd(binary);
            c.current_dir(tmp).arg("-d").arg(tmp).arg(&src);
            compile_step(c, binary, false, None, job)
        }
        "go" => {
            // was `go run` per case (compile errors surfaced as per-case RE, and every case
            // recompiled). Building once gives a real compile step: CE state, faster cases.
            let mut c = new_cmd(binary);
            c.current_dir(tmp);
            // pass #124: the step-by-step lane disables optimizations and inlining —
            // the standard gdb-on-Go recipe; without it every step lands in the runtime.
            if debug { c.arg("-gcflags=all=-N -l"); }
            c.arg("build").arg("-o").arg(&bin).arg(&src);
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
    let prep = match prepare(&req.lang_key, &req.binary, &req.source, &tmp, true, &guard.job, std.as_deref(), false) {
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
            let prep = match prepare(&req.lang_key, &req.binary, &req.source, &tmp, false, job, std.as_deref(), false) {
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

// ---------- pass #106: step-by-step (Shift+Run) ----------
// The debugger executes ONLY a binary this module just compiled through the #78 allowlist
// (gdb is chosen Rust-side: sibling of the compiler, then PATH, gated at >= 8 — 7.6.1
// probed broken on file redirection). The session holds the Job slot for its lifetime, so
// runs are refused while you debug; an abandoned session self-heals on the next start.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugStartRequest {
    lang_key: String,
    binary: String,
    source: String,
    #[serde(default)]
    stdin_text: String,
    #[serde(default)]
    std: Option<String>,
}

fn debug_start_blocking(inner: Arc<Inner>, req: DebugStartRequest) -> Result<crate::debug::DebugSnapshot, String> {
    // pass #124 (He: "port [Step-by-step execution] to non-C++ languages?"): the gdb
    // lane now covers cpp/rust/go/pascal (per-language debug builds + entry symbols)
    // and python runs on its own pdb lane (a generated wrapper — the debuggee's stdin
    // stays the case file, pdb's own stream is parsed Rust-side). java (jdb) and
    // javascript (the inspector's CDP) stay queued with honest errors — no silent
    // pretending.
    match req.lang_key.as_str() {
        "cpp" | "rust" | "go" | "pascal" | "python" => {}
        "java" => return Err("step-by-step for java is queued (jdb lane) — cpp/rust/go/pascal via gdb and python via pdb are wired today".into()),
        "javascript" => return Err("step-by-step for javascript is queued (inspector/CDP lane) — cpp/rust/go/pascal via gdb and python via pdb are wired today".into()),
        other => return Err(format!("step-by-step: unsupported language '{other}'")),
    }
    validate_binary(&inner, &req.lang_key, &req.binary)?;
    let guard = JobGuard::begin(&inner)?;
    let std = sanitize_std(&req.std);
    let tmp = new_tmp_dir(guard.job.id)?;
    let prep = match prepare(&req.lang_key, &req.binary, &req.source, &tmp, false, &guard.job, std.as_deref(), true) {
        Ok(p) => p,
        Err(e) => { let _ = fs::remove_dir_all(&tmp); return Err(e); }
    };
    if !prep.ok {
        let _ = fs::remove_dir_all(&tmp);
        return Err(format!("compile failed:\n{}", prep.log));
    }
    let params = crate::debug::StartParams {
        lang_key: req.lang_key.clone(),
        exe: exe_path(&tmp),
        source_path: tmp.join(source_name(&req.lang_key).unwrap_or("main")),
        dir: tmp,
        stdin_text: req.stdin_text,
        compiler_binary: req.binary.clone(),
        // pass #142 (wave-8 W8-06): the sibling-gdb auto-trust extends ONLY to compilers
        // the detector probed without any consent (trusted_detect). Confirmed planted
        // candidates and Settings overrides bought trust for the COMPILER path alone —
        // their sibling debugger rides the consent gate like everything else.
        compiler_trusted: lock(&inner.allowed).trusted_detect.contains(&req.binary),
        guard,
        #[cfg(windows)]
        job: None,
    };
    // pass #129 (attack-surface A3 symmetry): PATH-derived gdb candidates ride the
    // confirm-once consent gate before their version probe may execute them.
    let consent_state = CphState(inner.clone());
    let consent = |bin: &str| consent_debugger(&consent_state, bin);
    crate::debug::start(params, &consent)
}

#[tauri::command]
pub async fn debug_start(state: tauri::State<'_, CphState>, req: DebugStartRequest) -> Result<crate::debug::DebugSnapshot, String> {
    let inner = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || debug_start_blocking(inner, req)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn debug_step(kind: String, steps: Option<u32>) -> Result<crate::debug::DebugSnapshot, String> {
    // pass #130 (He): the step slider's count — None (missing arg) and out-of-range
    // values clamp to one honest step inside debug::step.
    tauri::async_runtime::spawn_blocking(move || crate::debug::step(&kind, steps.unwrap_or(1))).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn debug_stop() -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || Ok(crate::debug::stop_session())).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn probe_with_limit_kills_hanging_and_flooding_children() {
        // pass #142 (wave-8 W8-07): the probe runner's deadline and cap are load-bearing
        // — a hung "compiler" must not pin the detect worker, a flooding one must not
        // balloon host memory. Real children on the real OS: ping outlives the deadline
        // and gets killed (nonzero, no success), the echo flood is capped.
        let start = Instant::now();
        let (ok, _out) = probe_with_limit("cmd", &["/c", "ping", "-n", "60", "127.0.0.1"], PROBE_TIMEOUT, PROBE_CAP).expect("spawns");
        assert!(!ok, "the deadline-killed child is not a success exit");
        assert!(start.elapsed() < Duration::from_secs(15), "the deadline actually fires (took {:?})", start.elapsed());
        let (_ok2, out) = probe_with_limit(
            "cmd",
            &["/c", "for /l %i in (1,1,200000) do @echo 0123456789012345678901234567890123456789"],
            PROBE_TIMEOUT,
            PROBE_CAP,
        ).expect("spawns");
        assert!(out.len() <= 2 * PROBE_CAP, "the combined output is capped ({} bytes)", out.len());
    }

    #[test]
    fn refusal_persists_across_reload() {
        // pass #123 (wave-4 N6b): a refusal must be STICKY — persisted with the
        // registry and reloaded, so a planted path is asked exactly once and a
        // refused candidate is never re-run on a later detection cycle.
        let dir = std::env::temp_dir().join(format!("delcc-cph-refusal-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("temp dir");
        let state = CphState::default();
        state.set_persist_dir(dir.clone());
        {
            let mut allowed = lock(&state.0.allowed);
            allowed.refused_fixed.insert(r"C:\MinGW\bin\g++.exe".to_string());
        }
        state.save_persisted_overrides();
        let fresh = CphState::default();
        fresh.set_persist_dir(dir.clone());
        fresh.load_persisted_overrides();
        let refused = { lock(&fresh.0.allowed).refused_fixed.contains(r"C:\MinGW\bin\g++.exe") };
        let confirmed = { lock(&fresh.0.allowed).confirmed_fixed.contains(r"C:\MinGW\bin\g++.exe") };
        let _ = fs::remove_dir_all(&dir);
        assert!(refused, "a refusal must survive a reload");
        assert!(!confirmed, "a refusal must never masquerade as an acceptance");
    }

    #[test]
    fn planted_candidate_carries_no_version() {
        // pass #123 (wave-4 N6b): the structural half of the fix — a PlantedCandidate
        // has no version field at all, so detection literally cannot execute-and-fill
        // a toolchain for a planted path; only cph_detect's post-consent probe can.
        let c = PlantedCandidate {
            lang_key: "cpp".into(),
            label: "C++".into(),
            path: std::path::PathBuf::from(r"C:\MinGW\bin\g++.exe"),
            version_args: &["--version"],
        };
        assert_eq!(c.lang_key, "cpp");
        assert!(c.path.is_absolute());
    }

    #[test]
    fn override_dialog_rc_mapping() {
        // pass #101 (wave-3 N1b): the shipped MB_OKCANCEL-vs-IDYES comparison made the
        // override dialog UNACCEPTABLE forever (OK/Cancel returns 1/2, never IDYES=6).
        // Only a real YES accepts; every other return code refuses.
        assert!(confirm_rc_is_yes(6)); // IDYES
        assert!(!confirm_rc_is_yes(1)); // IDOK
        assert!(!confirm_rc_is_yes(2)); // IDCANCEL
        assert!(!confirm_rc_is_yes(7)); // IDNO
        assert!(!confirm_rc_is_yes(0));
    }

    #[test]
    fn override_dialog_flags_are_a_yesno_box() {
        // pass #102 (wave-3 P2): pin the dialog's button set to the rc mapping. N1b's
        // root cause was exactly this pairing drifting apart — OK/Cancel buttons
        // (IDOK=1) checked against IDYES=6. The MessageBox button-set field is the low
        // nibble: 0x0=OK, 0x1=OKCANCEL, 0x3=YESNOCANCEL, 0x4=YESNO. The whole field
        // must be exactly MB_YESNO — no other button set may ride along.
        assert_eq!(OVERRIDE_DIALOG_FLAGS & 0xF, 0x4, "the button-set field must be exactly MB_YESNO so IDYES (6) is the accept code");
    }

    #[cfg(windows)]
    #[test]
    fn override_dialog_flags_match_windows_sys_constants() {
        // The raw-value const must stay identical to the real windows_sys constants —
        // this runs on every Windows machine (dev box AND the windows-latest CI job).
        use windows_sys::Win32::UI::WindowsAndMessaging::{MB_ICONQUESTION, MB_OKCANCEL, MB_SETFOREGROUND, MB_TOPMOST, MB_YESNO};
        assert_eq!(OVERRIDE_DIALOG_FLAGS, MB_YESNO | MB_ICONQUESTION | MB_SETFOREGROUND | MB_TOPMOST);
        assert_eq!(OVERRIDE_DIALOG_FLAGS & MB_OKCANCEL, 0);
        assert_eq!(MB_YESNO, 0x4);
        assert_eq!(windows_sys::Win32::UI::WindowsAndMessaging::IDYES, 6);
    }

    #[test]
    fn persisted_registry_loads_both_formats_and_saves_new() {
        // pass #101: the old flat {lang: path} map and the new {overrides,
        // confirmed_fixed} document must both load; unrecognizable JSON is ignored.
        let state = CphState::default();
        let dir = std::env::temp_dir().join(format!("delcc-cph-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        state.set_persist_dir(dir.clone());
        // old format
        std::fs::write(dir.join("cph-overrides.json"), r#"{"cpp":"C:\\old\\g++.exe"}"#).unwrap();
        state.load_persisted_overrides();
        assert_eq!(lock(&state.0.allowed).overrides.get("cpp").map(String::as_str), Some(r"C:\old\g++.exe"));
        // new format (overrides + confirmed_fixed)
        std::fs::write(dir.join("cph-overrides.json"), r#"{"overrides":{"python":"C:\\new\\python.exe"},"confirmed_fixed":["C:\\MinGW\\bin\\g++.exe"]}"#).unwrap();
        state.load_persisted_overrides();
        {
            let allowed = lock(&state.0.allowed);
            assert_eq!(allowed.overrides.get("python").map(String::as_str), Some(r"C:\new\python.exe"));
            assert!(allowed.confirmed_fixed.contains(r"C:\MinGW\bin\g++.exe"));
        }
        // save writes the new document shape
        state.save_persisted_overrides();
        let saved = std::fs::read_to_string(dir.join("cph-overrides.json")).unwrap();
        assert!(saved.contains(r#""overrides""#) && saved.contains(r#""confirmed_fixed""#));
        let _ = std::fs::remove_dir_all(&dir);
    }

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

    #[test]
    fn override_registry_persists_across_a_relaunch() {
        // pass #96: the confirm dialog must only ever fire for a genuinely new/changed
        // override — which only holds if the registry survives relaunches.
        let dir = std::env::temp_dir().join(format!("delcc-test-ovr-{}-{}", std::process::id(), JOB_SEQ.load(Ordering::Relaxed)));
        let _ = std::fs::remove_dir_all(&dir);
        let s1 = CphState::default();
        s1.set_persist_dir(dir.clone());
        lock(&s1.0.allowed).overrides.insert("cpp".into(), "C:\\tc\\g++.exe".into());
        s1.save_persisted_overrides();

        let s2 = CphState::default();
        s2.set_persist_dir(dir.clone());
        s2.load_persisted_overrides();
        assert_eq!(lock(&s2.0.allowed).overrides.get("cpp").map(|v| v.as_str()), Some("C:\\tc\\g++.exe"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
