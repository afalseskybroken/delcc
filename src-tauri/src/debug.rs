// delcc-app/src-tauri/src/debug.rs
// pass #106 (HIGH-1, He: "Step-by-step execution?"): step-by-step execution for C/C++,
// driven by gdb's machine interface. Shift+Run compiles the draft with `-g -O0` (the SAME
// allowlisted compiler the run uses — see cph.rs debug_start), spawns
// `gdb --quiet --interpreter=mi2`, breaks on main, and serves step/into/continue
// snapshots: current line, locals, and whatever the program has flushed to its stdout
// file so far.
//
// Probed on the dev box (2026-10-31): gdb 14.2 (Strawberry) handles
// `run < "in.txt" > "out.txt"` through -interpreter-exec console — real stdin flows in,
// stdout lands in a file we can poll while stopped. MinGW's ancient gdb 7.6.1 passes args
// VERBATIM (no redirection; the inferior sees EOF) — so find_gdb gates candidates at
// major version >= 8 and says honestly what it found when nothing qualifies.
//
// Posture: the debugger only ever executes a binary WE just compiled through the
// #78 allowlist (same blast radius as cph_run). gdb itself is chosen Rust-side from the
// compiler's sibling directory or PATH — never from the webview. The whole gdb tree runs
// under a KILL_ON_JOB_CLOSE Job Object, so an orphaned session dies with delcc.

use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;

const STEP_TIMEOUT: Duration = Duration::from_secs(30);
const OUTPUT_SNAPSHOT_CAP: usize = 64 * 1024;
const LOCALS_JSON_CAP: usize = 64 * 1024;

// ---------- MI parsing (unit-tested against real probe records) ----------

#[derive(Debug, Clone, PartialEq)]
pub enum MiVal {
    Str(String),
    Tup(Vec<(String, MiVal)>),
    Lst(Vec<MiVal>),
}

impl MiVal {
    pub fn get(&self, key: &str) -> Option<&MiVal> {
        match self {
            MiVal::Tup(pairs) => pairs.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }
    pub fn as_str(&self) -> Option<&str> {
        match self {
            MiVal::Str(s) => Some(s),
            _ => None,
        }
    }
    pub fn as_list(&self) -> Option<&[MiVal]> {
        match self {
            MiVal::Lst(items) => Some(items),
            _ => None,
        }
    }
}

struct MiParser<'a> {
    chars: Vec<char>,
    pos: usize,
    _src: &'a str,
}

impl<'a> MiParser<'a> {
    fn new(src: &'a str) -> Self {
        MiParser { chars: src.chars().collect(), pos: 0, _src: src }
    }
    fn peek(&self) -> Option<char> {
        self.chars.get(self.pos).copied()
    }
    fn value(&mut self) -> Option<MiVal> {
        match self.peek()? {
            '"' => self.string().map(MiVal::Str),
            '{' => self.tuple(),
            '[' => self.list(),
            _ => None,
        }
    }
    fn string(&mut self) -> Option<String> {
        if self.peek()? != '"' {
            return None;
        }
        self.pos += 1;
        let mut out = String::new();
        loop {
            let c = self.chars.get(self.pos).copied()?;
            self.pos += 1;
            match c {
                '"' => return Some(out),
                '\\' => {
                    let e = self.chars.get(self.pos).copied()?;
                    self.pos += 1;
                    out.push(match e {
                        'n' => '\n',
                        'r' => '\r',
                        't' => '\t',
                        other => other, // \" \\ and everything else unescapes to itself
                    });
                }
                other => out.push(other),
            }
        }
    }
    fn ident(&mut self) -> Option<String> {
        let start = self.pos;
        while let Some(c) = self.peek() {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.' {
                self.pos += 1;
            } else {
                break;
            }
        }
        if self.pos == start {
            return None;
        }
        Some(self.chars[start..self.pos].iter().collect())
    }
    fn tuple(&mut self) -> Option<MiVal> {
        if self.peek()? != '{' {
            return None;
        }
        self.pos += 1;
        let mut pairs = Vec::new();
        if self.peek() == Some('}') {
            self.pos += 1;
            return Some(MiVal::Tup(pairs));
        }
        loop {
            let key = self.ident()?;
            if self.peek()? != '=' {
                return None;
            }
            self.pos += 1;
            let val = self.value()?;
            pairs.push((key, val));
            match self.peek()? {
                ',' => {
                    self.pos += 1;
                }
                '}' => {
                    self.pos += 1;
                    return Some(MiVal::Tup(pairs));
                }
                _ => return None,
            }
        }
    }
    fn list(&mut self) -> Option<MiVal> {
        if self.peek()? != '[' {
            return None;
        }
        self.pos += 1;
        let mut items = Vec::new();
        if self.peek() == Some(']') {
            self.pos += 1;
            return Some(MiVal::Lst(items));
        }
        loop {
            items.push(self.value()?);
            match self.peek()? {
                ',' => {
                    self.pos += 1;
                }
                ']' => {
                    self.pos += 1;
                    return Some(MiVal::Lst(items));
                }
                _ => return None,
            }
        }
    }
}

/// Parses the value part of an MI record (everything after `*stopped,` / `^done,`): a
/// bare comma-separated pair list (no braces), or a single string/tuple/list value.
pub fn parse_mi(src: &str) -> Option<MiVal> {
    let mut p = MiParser::new(src);
    let first = match p.peek() {
        Some('{') | Some('[') | Some('"') => p.value()?,
        _ => {
            let mut pairs: Vec<(String, MiVal)> = Vec::new();
            loop {
                let key = p.ident()?;
                if p.peek()? != '=' {
                    return None;
                }
                p.pos += 1;
                let val = p.value()?;
                pairs.push((key, val));
                if p.peek() == Some(',') {
                    p.pos += 1;
                } else {
                    break;
                }
            }
            MiVal::Tup(pairs)
        }
    };
    if p.pos != p.chars.len() {
        return None;
    }
    Some(first)
}

/// `GNU gdb (GDB) 7.6.1` -> 7 · `... built by Brecht Sanders, r8) 14.2` -> 14 · junk -> None.
pub fn parse_gdb_version(first_line: &str) -> Option<(u32, String)> {
    let last = first_line.split_whitespace().last()?;
    let mut parts = last.split('.');
    let major = parts.next()?.parse::<u32>().ok()?;
    Some((major, last.to_string()))
}

/// The console `run` with file redirection — the mechanism probed to work on gdb >= 8 on
/// Windows (paths are absolute, forward-slashed, and quoted: app temp dirs contain spaces).
pub fn build_run_command(input: &Path, output: &Path) -> String {
    let inp = input.to_string_lossy().replace('\\', "/");
    let outp = output.to_string_lossy().replace('\\', "/");
    format!("run < \"{inp}\" > \"{outp}\"")
}

/// pass #129 (attack-surface A3 symmetry): candidates carry a trust class — sibling-of-
/// compiler vs PATH-derived — and pass #142 (wave-8 W8-06) closes the consent-boundary
/// disagreement the wave-8 audit found: sibling candidates are auto-trusted ONLY when
/// the COMPILER itself is a trusted installation (detected without any consent — the
/// `trusted_detect` class in cph.rs). The sibling of a confirmed planted candidate or
/// of a Settings override was never named by the user's action, so it rides the same
/// confirm-once consent gate as every PATH-derived candidate BEFORE its `--version` may
/// execute. PATH-derived candidates are always the UNTRUSTED class: same-user-writable,
/// and the version gate alone admits any binary that prints a plausible number. A bare
/// compiler name has no real sibling directory (parent is ""), and a CWD-relative
/// "gdb.exe" is not the toolchain's own gdb — skipped rather than probed.
fn find_gdb_candidates(compiler: &str) -> Vec<(PathBuf, bool)> {
    let mut out = Vec::new();
    // sibling first: the toolchain's own gdb understands its own binaries
    if let Some(dir) = Path::new(compiler).parent() {
        if !dir.as_os_str().is_empty() {
            out.push((dir.join("gdb.exe"), true));
            out.push((dir.join("gdb"), true));
        }
    }
    if let Some(paths) = std::env::var_os("PATH") {
        for p in std::env::split_paths(&paths) {
            if p.as_os_str().is_empty() {
                continue;
            }
            out.push((p.join("gdb.exe"), false));
            out.push((p.join("gdb"), false));
        }
    }
    out
}

/// Sibling-of-compiler first, then PATH; both gated at gdb >= 8 (7.6.1 verified broken:
/// no file redirection). A sibling candidate is auto-trusted only when the compiler
/// itself is a trusted installation (`compiler_trusted` — pass #142, wave-8 W8-06);
/// otherwise it rides the same confirm-once consent gate as the PATH class, BEFORE the
/// version probe — probing is an execution. The probe itself runs deadlined and capped
/// (pass #142, wave-8 W8-07). Returns (path, version string) or an honest error naming
/// what was probed and what was refused.
pub fn find_gdb(compiler: &str, compiler_trusted: bool, consent: &dyn Fn(&str) -> bool) -> Result<(PathBuf, String), String> {
    let mut probed: Vec<String> = Vec::new();
    for (cand, sibling) in find_gdb_candidates(compiler) {
        if !cand.is_file() {
            continue;
        }
        let path_str = cand.to_string_lossy().to_string();
        let trusted = sibling && compiler_trusted;
        if !trusted && !consent(&path_str) {
            probed.push(format!("{path_str} (refused by the user)"));
            continue;
        }
        // pass #142 (wave-8 W8-07): the probe rides the shared deadline+cap runner — a
        // hung gdb can no longer pin the debug start, a flooding one cannot balloon
        // memory. Success required (probe_one's doctrine — #141).
        let Some((ok, combined)) = crate::cph::probe_with_limit(&path_str, &["--version"], crate::cph::PROBE_TIMEOUT, crate::cph::PROBE_CAP) else {
            probed.push(format!("{path_str} (spawn failed)"));
            continue;
        };
        if !ok {
            probed.push(format!("{} (probe exited nonzero)", cand.display()));
            continue;
        }
        let first = combined.lines().next().unwrap_or("").to_string();
        match parse_gdb_version(&first) {
            Some((major, ver)) if major >= 8 => return Ok((cand, ver)),
            Some((_major, ver)) => probed.push(format!("{} (gdb {ver}, needs >= 8)", cand.display())),
            None => probed.push(format!("{} (unrecognized version line)", cand.display())),
        }
    }
    Err(if probed.is_empty() {
        "no gdb found next to the compiler or on PATH — step-by-step needs gdb 8+ (the compiled family)".into()
    } else {
        format!("step-by-step needs gdb 8+; probed: {}", probed.join("; "))
    })
}

// ---------- session ----------

#[derive(Serialize)]
pub struct DebugLocal {
    pub name: String,
    pub kind: String,
    pub value: String,
}

#[derive(Serialize)]
pub struct DebugSnapshot {
    pub line: Option<u32>,
    pub function: Option<String>,
    pub locals: Vec<DebugLocal>,
    pub locals_truncated: bool,
    pub output: String,
    pub output_truncated: bool,
    pub exited: bool,
    pub exit_code: Option<i32>,
    /// pass #164 (wave-11 W11-L06): the output watcher killed the tree on the 32 MiB
    /// cap. Without this the disconnect read as an ordinary exit with an unknown code
    /// and the UI substituted zero — overflow could look like SUCCESS. Honest flag,
    /// surfaced verbatim; the gdb lane never sets it (serde default keeps the
    /// constructor sites compatible).
    #[serde(default)]
    pub overflow: bool,
}

enum LineKind {
    /// token, class ("done"/"error"/"running"), value part. The token PRECEDES the '^'
    /// when present (`12^done,...`); tokenless records start at '^' (`^running`).
    Result(Option<i32>, String, String),
    Event(String), // *stopped,...
    Other,         // =notify ~console &log (gdb)
    Eof,
}

fn classify(raw: &str) -> LineKind {
    // split off an optional leading numeric token before the '^'
    let (token, body) = match raw.find('^') {
        Some(0) => (None, &raw[1..]),
        Some(i) if raw[..i].chars().all(|c| c.is_ascii_digit()) => {
            (raw[..i].parse::<i32>().ok(), &raw[i + 1..])
        }
        _ => {
            return if raw.starts_with('*') {
                LineKind::Event(raw.to_string())
            } else {
                LineKind::Other
            }
        }
    };
    let (class, values) = match body.find(',') {
        Some(i) => (body[..i].to_string(), body[i + 1..].to_string()),
        None => (body.to_string(), String::new()),
    };
    LineKind::Result(token, class, values)
}

struct ReaderLine(LineKind);

// pass #142 (wave-8 W8-08): the inferior's stdout is redirected to a session file that
// the 64 KiB snapshot cap bounds for READING only — `continue` past an infinite print
// loop used to grow that file until the user stopped the session. A watcher thread
// stats the file every 500 ms; past DEBUG_OUTPUT_FILE_CAP it kills the ENGINE TREE
// (taskkill /T reaches gdb + the inferior through the external pid — no shared handles
// with the session thread) and raises a flag the wait paths turn into an honest error.
const DEBUG_OUTPUT_FILE_CAP: u64 = 32 * 1024 * 1024;
// pass #156 (wave-11 W11-10): the per-session gdb event-record ceiling (drop-oldest)
const DEBUG_EVENTS_CAP: usize = 512;
const OUTPUT_WATCH_INTERVAL: Duration = Duration::from_millis(500);
// pass #145 (wave-9 W9-01): how long a missing output file means "the inferior has
// not started yet" instead of "the session is gone". The gdb lane pre-creates the
// file, so this is a never-case in practice — the belt to that brace.
const OUTPUT_WATCH_GRACE: Duration = Duration::from_secs(10);

fn spawn_output_watcher(out_path: PathBuf, engine_pid: u32, overflow: std::sync::Arc<std::sync::atomic::AtomicBool>, shutdown: std::sync::Arc<std::sync::atomic::AtomicBool>) {
    use std::sync::atomic::Ordering;
    std::thread::spawn(move || {
        let started = std::time::Instant::now();
        while !shutdown.load(Ordering::SeqCst) {
            std::thread::sleep(OUTPUT_WATCH_INTERVAL);
            if shutdown.load(Ordering::SeqCst) {
                break;
            }
            match std::fs::metadata(&out_path) {
                Ok(m) => {
                    if m.len() > DEBUG_OUTPUT_FILE_CAP {
                        overflow.store(true, Ordering::SeqCst);
                        crate::cph::kill_tree(engine_pid);
                        break;
                    }
                }
                // pass #145 (W9-01): a NotFound inside the grace window is "the inferior
                // has not started yet" — the gdb lane's stdout.txt only appears when
                // `run … > stdout.txt` executes, and a slow gdb boot used to retire the
                // watcher before that (the 32 MiB guard silently disarmed for the whole
                // session). After the grace, any error means the session dir is gone —
                // the watcher retires.
                Err(e) if e.kind() == std::io::ErrorKind::NotFound && started.elapsed() < OUTPUT_WATCH_GRACE => {}
                // the session dir is gone — the session ended, the watcher retires
                Err(_) => break,
            }
        }
    });
}

// pass #142 (wave-8 W8-09): a thin wrapper that keeps the in-flight count of the
// unbounded std channel — the reader thread uses it for backpressure (stops reading,
// letting the OS pipe bound the producer) and never lets delcc-side memory grow with
// what a broken engine streams. The count is approximate (a gauge, not a contract).
struct BoundedRecv<T> {
    rx: Receiver<T>,
    pending: std::sync::Arc<std::sync::atomic::AtomicUsize>,
}

impl<T> BoundedRecv<T> {}

// pass #142 (W8-09): BufReader::lines() allocated the COMPLETE line before any cap — a
// single newline-less flood line ballooned the reader. Reads one line capped at `cap`
// bytes; overflow past the cap is DRAINED (protocol lines we care about are short and
// newline-terminated — a truncated junk line just fails to parse). None = clean EOF.
fn read_line_capped(reader: &mut impl BufRead, cap: usize) -> std::io::Result<Option<String>> {
    let mut out: Vec<u8> = Vec::new();
    let mut saw_any = false;
    loop {
        let available = match reader.fill_buf() {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        };
        if available.is_empty() {
            break;
        }
        saw_any = true;
        match available.iter().position(|&b| b == b'\n') {
            Some(pos) => {
                let take = &available[..pos];
                let room = cap.saturating_sub(out.len());
                out.extend_from_slice(&take[..take.len().min(room)]);
                reader.consume(pos + 1);
                break;
            }
            None => {
                let room = cap.saturating_sub(out.len());
                let n = available.len();
                out.extend_from_slice(&available[..n.min(room)]);
                reader.consume(n);
            }
        }
    }
    if !saw_any {
        return Ok(None);
    }
    Ok(Some(String::from_utf8_lossy(&out).into_owned()))
}

const LINE_CAP: usize = 256 * 1024;
const CHANNEL_HIGH_WATER: usize = 1024;

pub struct Session {
    child: Child,
    stdin: Option<ChildStdin>,
    rx: BoundedRecv<ReaderLine>,
    dir: PathBuf,
    out_path: PathBuf,
    seq: i32,
    events: VecDeque<String>, // pass #156: bounded at DEBUG_EVENTS_CAP, drop-oldest
    overflow: std::sync::Arc<std::sync::atomic::AtomicBool>,
    watcher_stop: std::sync::Arc<std::sync::atomic::AtomicBool>,
    #[cfg(windows)]
    _job: Option<crate::cph::job::Job>,
    /// Held for the whole session: while you debug, cph_run/cph_compile stay refused
    /// ("a local run is already in progress") — one compiler/Job slot, one truth.
    _guard: crate::cph::JobGuard,
}

impl Drop for Session {
    fn drop(&mut self) {
        use std::sync::atomic::Ordering;
        self.watcher_stop.store(true, Ordering::SeqCst);
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// One session slot, either engine. Dispatch lives in step()/stop_session().
enum Engine {
    Gdb(Session),
    Pdb(PdbSession),
}

impl Engine {
    fn child_mut(&mut self) -> &mut Child {
        match self {
            Engine::Gdb(s) => &mut s.child,
            Engine::Pdb(s) => &mut s.child,
        }
    }
}

static SESSION: Mutex<Option<Engine>> = Mutex::new(None);

// pass #144 (wave-8 W8-L16): set by stop_session BEFORE it tries the session lock.
// The step paths hold that lock through their waits — without this flag a Stop during
// a long in-flight step parked behind the mutex until the 30 s STEP_TIMEOUT expired.
// The wait loops poll it in small slices and unwind early, releasing the lock for
// stop_session, which then kills the engine tree as usual.
static INTERRUPT: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
const RECV_SLICE: Duration = Duration::from_millis(100);

enum RecvOutcome<T> {
    Got(T),
    TimedOut,
    Disconnected,
    Interrupted,
}

impl<T> BoundedRecv<T> {
    fn recv_sliced(&self, deadline: Instant, interrupt: &std::sync::atomic::AtomicBool) -> RecvOutcome<T> {
        use std::sync::atomic::Ordering;
        loop {
            if interrupt.load(Ordering::SeqCst) {
                return RecvOutcome::Interrupted;
            }
            let now = Instant::now();
            if now >= deadline {
                return RecvOutcome::TimedOut;
            }
            match self.rx.recv_timeout((deadline - now).min(RECV_SLICE)) {
                Ok(v) => {
                    if self.pending.load(Ordering::SeqCst) > 0 {
                        self.pending.fetch_sub(1, Ordering::SeqCst);
                    }
                    return RecvOutcome::Got(v);
                }
                Err(RecvTimeoutError::Timeout) => continue,
                Err(RecvTimeoutError::Disconnected) => return RecvOutcome::Disconnected,
            }
        }
    }
}

/// Polite shutdown per engine, then Drop cleans up.
/// Used by debug_stop, by debug_start's self-heal, and by the app's own job slot rules.
pub fn stop_session() -> bool {
    // pass #144 (W8-L16): the interrupt goes up first — an in-flight step unwinds on
    // its next 100 ms slice and releases the SESSION lock for the stop below.
    INTERRUPT.store(true, std::sync::atomic::Ordering::SeqCst);
    let mut slot = match SESSION.lock() {
        Ok(s) => s,
        Err(_) => return false,
    };
    match slot.take() {
        Some(mut engine) => {
            match &mut engine {
                Engine::Gdb(s) => {
                    if let Some(stdin) = s.stdin.as_mut() {
                        let _ = writeln!(stdin, "0-gdb-exit");
                        let _ = stdin.flush();
                    }
                }
                Engine::Pdb(s) => {
                    if let Some(stdin) = s.stdin.as_mut() {
                        // pdb's quit — the wrapper then exits; the tree-kill below is the belt
                        let _ = writeln!(stdin, "q");
                        let _ = stdin.flush();
                    }
                }
            }
            let child = engine.child_mut();
            let deadline = Instant::now() + Duration::from_millis(1500);
            while Instant::now() < deadline {
                match child.try_wait() {
                    Ok(Some(_)) => break,
                    Ok(None) => std::thread::sleep(Duration::from_millis(50)),
                    Err(_) => break,
                }
            }
            let pid = child.id();
            let _ = child.kill();
            let _ = child.wait();
            if pid != 0 {
                crate::cph::kill_tree(pid); // belt and suspenders: the inferior, not just the engine
            }
            true
        }
        None => false,
    }
}

impl Session {
    fn send(&mut self, cmd: &str) -> Result<(), String> {
        let stdin = self.stdin.as_mut().ok_or("gdb stdin closed")?;
        writeln!(stdin, "{cmd}").map_err(|e| format!("gdb write: {e}"))?;
        stdin.flush().map_err(|e| format!("gdb flush: {e}"))
    }

    /// pass #142 (W8-08): the engine-tree death is either "gdb exited unexpectedly" or —
    /// when the output watcher killed it — the honest overflow verdict.
    fn engine_death(&self) -> String {
        use std::sync::atomic::Ordering;
        if self.overflow.load(Ordering::SeqCst) {
            "the program's output overflowed the 32 MiB session cap — the session was stopped".into()
        } else {
            "gdb exited unexpectedly".into()
        }
    }

    /// The wait-timeout error, also overridden by an overflow verdict (a flooded
    /// session reports WHY instead of a generic timeout).
    fn wait_err(&self, default: &'static str) -> String {
        use std::sync::atomic::Ordering;
        if self.overflow.load(Ordering::SeqCst) {
            self.engine_death()
        } else {
            default.into()
        }
    }

    fn next_seq(&mut self) -> i32 {
        self.seq += 1;
        self.seq
    }

    /// Sends a tokenized command and waits for its result record. Events seen on the way
    /// are queued (the *stopped after an -exec-* is consumed by wait_stopped).
    fn transact(&mut self, cmd: &str, timeout: Duration) -> Result<String, String> {
        let tok = self.next_seq();
        self.send(&format!("{tok}{cmd}"))?;
        let deadline = Instant::now() + timeout;
        loop {
            match self.rx.recv_sliced(deadline, &INTERRUPT) {
                RecvOutcome::Got(ReaderLine(LineKind::Result(Some(t), class, values))) if t == tok => {
                    if class == "error" {
                        return Err(format!("gdb: {values}"));
                    }
                    return Ok(values);
                }
                RecvOutcome::Got(ReaderLine(LineKind::Result(_, _, _))) => {} // stale/async record — skip
                RecvOutcome::Got(ReaderLine(LineKind::Event(raw))) => {
                    // pass #156 (wave-11 W11-10): bound the event queue — transact()
                    // drains records into it with no other limit, so a malfunctioning
                    // approved debugger could grow host memory through any transaction.
                    // 512 records, drop-oldest: ops consume FIFO and only need recent
                    // events to find the next *stopped.
                    if self.events.len() >= DEBUG_EVENTS_CAP {
                        self.events.pop_front();
                    }
                    self.events.push_back(raw);
                }
                RecvOutcome::Got(ReaderLine(LineKind::Other)) => {}
                RecvOutcome::Got(ReaderLine(LineKind::Eof)) => return Err(self.engine_death()),
                RecvOutcome::TimedOut => {
                    return Err(self.wait_err("gdb did not answer in time — Stop the session and retry"))
                }
                RecvOutcome::Disconnected => return Err(self.engine_death()),
                RecvOutcome::Interrupted => return Err("the step was interrupted by Stop".into()),
            }
        }
    }

    /// Consumes events until the next *stopped (or the program exits). Ops are strictly
    /// sequential from the UI — buttons disable while a step is in flight — so the first
    /// *stopped after the exec is the answer.
    fn wait_stopped(&mut self, timeout: Duration) -> Result<String, String> {
        let deadline = Instant::now() + timeout;
        loop {
            // pass #163 (wave-12 W12-19): drain the queue to the next *stopped, not the
            // first record of any kind. transact() queues EVERY async event it sees before
            // the result token (=thread-created, =library-loaded, *running, …); returning
            // the first one handed snapshot() a non-stop record it parsed as a stop — the
            // desync the W11-10 comment promised against. The predicate is the SAME
            // "*stopped," snapshot() already strips, so the normal path (queue empty, the
            // first rx event is the stop) is byte-identical.
            if let Some(raw) = next_queued_stop(&mut self.events) {
                return Ok(raw);
            }
            match self.rx.recv_sliced(deadline, &INTERRUPT) {
                RecvOutcome::Got(ReaderLine(LineKind::Event(raw))) if raw.starts_with("*stopped,") => return Ok(raw),
                RecvOutcome::Got(ReaderLine(LineKind::Event(_))) => {} // non-stop notification — keep waiting
                RecvOutcome::Got(ReaderLine(LineKind::Eof)) | RecvOutcome::Disconnected => {
                    return Err(self.engine_death())
                }
                RecvOutcome::Got(ReaderLine(LineKind::Other)) => {}
                RecvOutcome::Got(ReaderLine(_)) => {} // result records of already-answered transacts
                RecvOutcome::TimedOut => {
                    return Err(self.wait_err("the program did not stop in time — Stop the session and retry"))
                }
                RecvOutcome::Interrupted => return Err("the step was interrupted by Stop".into()),
            }
        }
    }

    fn read_output(&self) -> (String, bool) {
        // pass #123 (attack-surface P2): O(cap) read — a debug session is exactly where
        // a program prints in a loop, and this used to `std::fs::read` the ENTIRE file
        // on every step/continue/next before throwing away all but the first cap bytes.
        // Display semantics preserved exactly: the file's FIRST cap bytes (what the
        // old code showed after truncation), same UTF-8 boundary handling, same flag.
        let len = match std::fs::metadata(&self.out_path) {
            Ok(m) => m.len(),
            Err(_) => return (String::new(), false), // nothing flushed yet — honest empty
        };
        if len == 0 {
            return (String::new(), false);
        }
        let truncated = len > OUTPUT_SNAPSHOT_CAP as u64;
        let want = if truncated { OUTPUT_SNAPSHOT_CAP } else { len as usize };
        use std::io::Read;
        let mut bytes = Vec::with_capacity(want);
        match std::fs::File::open(&self.out_path) {
            Ok(f) => {
                if f.take(want as u64).read_to_end(&mut bytes).is_err() {
                    return (String::new(), false);
                }
            }
            Err(_) => return (String::new(), false),
        }
        let mut end = bytes.len().min(OUTPUT_SNAPSHOT_CAP);
        // don't split a UTF-8 codepoint
        while end > 0 && (bytes[end - 1] & 0xC0) == 0x80 {
            end -= 1;
        }
        if truncated && end > 0 && (bytes[end - 1] & 0x80) != 0 {
            end -= 1;
        }
        let mut s = String::from_utf8_lossy(&bytes[..end]).into_owned();
        if truncated {
            s.push_str("\n…(output so far, truncated)");
        }
        (s, truncated)
    }

    fn snapshot(&mut self, stop_raw: &str) -> Result<DebugSnapshot, String> {
        let (output, output_truncated) = self.read_output();
        let stopped_v = stop_raw.strip_prefix("*stopped,").unwrap_or("");
        let exited = stopped_v.contains("exited-normally") || stopped_v.contains("exited-signalled");
        let exit_code = if stopped_v.contains("exited-normally") {
            Some(0)
        } else if let Some(v) = parse_mi(stopped_v) {
            v.get("reason").and_then(|r| r.as_str()).and_then(|r| r.strip_prefix("exited-signalled")).map(|_| -1)
        } else {
            None
        };
        if exited {
            return Ok(DebugSnapshot {
                line: None,
                function: None,
                locals: Vec::new(),
                locals_truncated: false,
                output,
                output_truncated,
                exited: true,
                exit_code,
                overflow: false,
            });
        }
        // frame: current line + function
        let (mut line, mut function) = (None, None);
        if let Ok(rest) = self.transact("-stack-info-frame", STEP_TIMEOUT) {
            if let Some(frame) = parse_mi(&rest).as_ref().and_then(|v| v.get("frame")) {
                line = frame.get("line").and_then(|l| l.as_str()).and_then(|s| s.parse().ok());
                function = frame.get("func").and_then(|f| f.as_str()).map(|s| s.to_string());
            }
        }
        // locals: --all-values with print elements capped at session start; still cap here
        let (mut locals, mut locals_truncated) = (Vec::new(), false);
        if let Ok(rest) = self.transact("-stack-list-variables --all-values", STEP_TIMEOUT) {
            if let Some(vars) = parse_mi(&rest).as_ref().and_then(|v| v.get("variables")).and_then(|v| v.as_list()) {
                // pass #142 (W8-09): the running cost is tracked incrementally — the old
                // loop re-summed every prior local on every row (O(n²) on wide frames).
                let mut running = 0usize;
                for var in vars {
                    let name = var.get("name").and_then(|n| n.as_str()).unwrap_or("").to_string();
                    if name.is_empty() {
                        continue;
                    }
                    let kind = var.get("type").and_then(|t| t.as_str()).unwrap_or("").to_string();
                    let value = var.get("value").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    let cost = name.len() + kind.len() + value.len() + 24;
                    if running + cost > LOCALS_JSON_CAP {
                        locals_truncated = true;
                        break;
                    }
                    running += cost;
                    locals.push(DebugLocal { name, kind, value });
                }
            }
        }
        Ok(DebugSnapshot { line, function, locals, locals_truncated, output, output_truncated, exited: false, exit_code: None, overflow: false })
    }
}

/// pass #163 (wave-12 W12-19): pop queued gdb events until the next *stopped, skipping the
/// async notifications (=thread-*, =library-loaded, *running, …) that transact() queues
/// before an exec's result token. Returns None when no stop is queued — the caller then
/// reads the engine stream. The "*stopped," predicate is the one snapshot() already relies
/// on, so this cannot reject a record snapshot() would have understood.
fn next_queued_stop(events: &mut VecDeque<String>) -> Option<String> {
    while let Some(raw) = events.pop_front() {
        if raw.starts_with("*stopped,") {
            return Some(raw);
        }
    }
    None
}

fn spawn_reader(
    child_stdout: std::process::ChildStdout,
    tx: mpsc::Sender<ReaderLine>,
    pending: std::sync::Arc<std::sync::atomic::AtomicUsize>,
    shutdown: std::sync::Arc<std::sync::atomic::AtomicBool>,
) {
    use std::sync::atomic::Ordering;
    std::thread::spawn(move || {
        let mut reader = BufReader::new(child_stdout);
        while let Ok(Some(line)) = read_line_capped(&mut reader, LINE_CAP) {
            // pass #142 (W8-09): backpressure — when the consumer falls behind, the
            // reader STOPS reading; the OS pipe fills and the producing side blocks.
            // delcc-side memory stays bounded no matter what the engine streams.
            while !shutdown.load(Ordering::SeqCst) && pending.load(Ordering::SeqCst) >= CHANNEL_HIGH_WATER {
                std::thread::sleep(Duration::from_millis(2));
            }
            let trimmed = line.trim_end().to_string();
            if trimmed == "(gdb)" {
                continue;
            }
            let kind = classify(&trimmed);
            pending.fetch_add(1, Ordering::SeqCst);
            if tx.send(ReaderLine(kind)).is_err() {
                break;
            }
        }
        pending.fetch_add(1, Ordering::SeqCst);
        let _ = tx.send(ReaderLine(LineKind::Eof));
    });
}

/// Compiles nothing here — the caller (cph.rs debug_start) has already built the artifact
/// through the allowlist. Spawns the engine for the language (gdb for the compiled
/// family, pdb for python), breaks on the language's entry, runs with file redirection,
/// and returns the first snapshot (stopped, or exited if entry never hit).
pub struct StartParams {
    pub lang_key: String,
    pub exe: PathBuf,
    pub source_path: PathBuf, // the draft inside the build dir (the pdb lane exec's THIS)
    pub dir: PathBuf,     // owns the build dir; removed on Drop
    pub stdin_text: String,
    pub compiler_binary: String,
    // pass #142 (wave-8 W8-06): whether the compiler is a trusted installation (detected
    // without consent). Only then may the sibling gdb be auto-trusted.
    pub compiler_trusted: bool,
    pub guard: crate::cph::JobGuard,
    #[cfg(windows)]
    pub job: Option<crate::cph::job::Job>,
}

pub fn start(params: StartParams, consent: &dyn Fn(&str) -> bool) -> Result<DebugSnapshot, String> {
    // pass #124: engine dispatch — python rides pdb (its own lane below); the compiled
    // family rides gdb with per-language entry symbols. The consent gate (A3 symmetry,
    // pass #129; provenance-aware since #142) only concerns the gdb lane's debugger
    // candidates: PATH-class always, and the sibling of a non-trusted compiler.
    if params.lang_key == "python" {
        return start_pdb(params);
    }
    start_gdb(params, consent)
}

fn start_gdb(params: StartParams, consent: &dyn Fn(&str) -> bool) -> Result<DebugSnapshot, String> {
    // self-heal: one session at a time — an abandoned one is stopped first
    stop_session();
    INTERRUPT.store(false, std::sync::atomic::Ordering::SeqCst);
    let (gdb_path, ver) = find_gdb(&params.compiler_binary, params.compiler_trusted, consent)?;
    let dir = params.dir.clone();
    let in_path = dir.join("stdin.txt");
    let out_path = dir.join("stdout.txt");
    let cleanup = |e: String| { let _ = std::fs::remove_dir_all(&dir); e };
    std::fs::write(&in_path, &params.stdin_text).map_err(|e| cleanup(format!("write stdin: {e}")))?;
    // pass #145 (wave-9 W9-01): pre-create the output file exactly as the pdb lane does
    // — the watcher's first tick lands +500 ms after spawn, but this file only appeared
    // when gdb's `run … > stdout.txt` started the inferior (after the break-insert
    // round trips), so a slow boot raced and lost and the guard never armed.
    std::fs::File::create(&out_path).map_err(|e| cleanup(format!("open output: {e}")))?;

    let gdb_str = gdb_path.to_string_lossy().into_owned();
    let mut cmd = crate::cph::new_cmd(&gdb_str);
    cmd // pass #123 (attack-surface A3): `-nx` skips user/system .gdbinit — MI needs no
        // init-file conveniences, and an init file is one more thing the plant-a-file
        // adversary (the A2 class) could inject into every debug session.
        .args(["--quiet", "-nx", "--interpreter=mi2"])
        .arg(&params.exe)
        .current_dir(&dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    // pass #142 (wave-8 W8-10): the engine is created SUSPENDED, assigned to its
    // KILL_ON_JOB_CLOSE job, then resumed — the old spawn-then-track window let a fast
    // gdb spawn the inferior before containment landed (the inferior inherited no job).
    #[cfg(all(windows, feature = "job-mem-cap"))]
    let (mut child, attached) = match crate::cph::spawn_tracked_suspended(&mut cmd, None) {
        Ok(pair) => pair,
        Err(e) => return Err(cleanup(format!("spawn gdb: {e}"))),
    };
    #[cfg(all(windows, feature = "job-mem-cap"))]
    let job = params.job.or(attached);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // pass #144 (wave-8 W8-L18): the gdb tree runs as its own process group so
        // kill_tree's negative-pid signal reaches every descendant — the same
        // guarantee the normal capture path has had since pass #96.
        cmd.process_group(0);
    }
    #[cfg(not(all(windows, feature = "job-mem-cap")))]
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return Err(cleanup(format!("spawn gdb: {e}"))),
    };
    #[cfg(not(all(windows, feature = "job-mem-cap")))]
    #[cfg(windows)]
    let job = params.job.or_else(|| crate::cph::job::Job::track(&child));
    let stdout = child.stdout.take().ok_or("gdb stdout")?;
    let stdin = child.stdin.take().ok_or("gdb stdin")?;
    let (tx, rx) = mpsc::channel();
    let pending = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let watcher_stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    spawn_reader(stdout, tx, pending.clone(), watcher_stop.clone());
    let overflow = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    // pass #142 (W8-08): the watcher needs the engine pid and the output path before
    // both move into the Session.
    spawn_output_watcher(out_path.clone(), child.id(), overflow.clone(), watcher_stop.clone());

    let mut s = Session {
        child,
        stdin: Some(stdin),
        rx: BoundedRecv { rx, pending },
        dir,
        out_path,
        seq: 0,
        events: VecDeque::new(),
        overflow,
        watcher_stop,
        #[cfg(windows)]
        _job: job,
        _guard: params.guard,
    };
    let _ = format!("gdb {ver}"); // version surfaced in errors by find_gdb; kept for logs

    // handshake: first prompt, then the settings, the breakpoint, and the run
    s.transact("-gdb-set pagination off", STEP_TIMEOUT)?;
    s.transact("-gdb-set print elements 64", STEP_TIMEOUT)?;
    // pass #124: the entry symbol is per language — plain `main` lands in std's
    // lang_start shim on Rust, and Go's entry is main.main; each tries its table in
    // order and an honest error names every symbol that missed.
    let symbols: &[&str] = match params.lang_key.as_str() {
        "rust" => &["main::main", "main"],
        "go" => &["main.main"],
        "pascal" => &["main", "PASCALMAIN"],
        _ => &["main"],
    };
    let mut last_err: Option<String> = None;
    let mut broke = false;
    for sym in symbols {
        match s.transact(&format!("-break-insert {sym}"), STEP_TIMEOUT) {
            Ok(_) => { broke = true; break; }
            Err(e) => last_err = Some(format!("no {sym}() to break on: {e}")),
        }
    }
    if !broke {
        let _ = stop_inner(&mut s);
        return Err(last_err.unwrap_or_else(|| "no entry symbol to break on".into()));
    }
    // pass #126 (He, live: `gdb: msg="Problem parsing arguments: …"`): the console
    // command's OWN quotes terminate the MI string — gdb parsed `run < ` and choked
    // (reproduced live on Strawberry gdb: unescaped = parse error, escaped = runs).
    // The inner quotes are MI-escaped so the console parser sees `run < "…" > "…"` whole.
    let run_cmd = mi_escape_console(&build_run_command(&in_path, &s.out_path));
    s.transact(&format!("-interpreter-exec console \"{run_cmd}\""), STEP_TIMEOUT)?;
    let stop_raw = s.wait_stopped(STEP_TIMEOUT)?;
    let snap = s.snapshot(&stop_raw)?;

    // pass #164 (wave-11 W11-L08): the publication point re-checks the interrupt.
    // A Stop landing anywhere during the startup round-trips (teardown, spawn,
    // handshake, the initial wait) leaves INTERRUPT raised; publishing after it
    // would resurrect a session the user already killed from a view that can no
    // longer see one. The flag stays raised through the swallowed Interrupted
    // outcomes (query_locals returns data, not Result), so this check is the one
    // atomic gate: hold the lock only AFTER the check — stop_session takes the
    // same lock, so a Stop racing the publish either takes the slot first (the
    // normal path) or the check below sees the raised flag and unwinds.
    if INTERRUPT.load(std::sync::atomic::Ordering::SeqCst) {
        let _ = stop_inner(&mut s);
        return Err("the session was stopped during startup".into());
    }
    let mut slot = SESSION.lock().map_err(|_| "debug session lock poisoned")?;
    *slot = Some(Engine::Gdb(s));
    Ok(snap)
}

/// MI string escaping for `-interpreter-exec console "…"` — the inner quotes of the
/// console command must not terminate the MI string (pass #126, reproduced live).
fn mi_escape_console(cmd: &str) -> String {
    cmd.replace('"', "\\\"")
}

fn stop_inner(s: &mut Session) -> Result<(), String> {
    if let Some(stdin) = s.stdin.as_mut() {
        let _ = writeln!(stdin, "0-gdb-exit");
        let _ = stdin.flush();
    }
    Ok(())
}

/// One debugging step. kind: over | into | out | continue.
/// pass #130 (He: "Slider to choose steps on [Step-by-step]"): one click may advance
/// SEVERAL engine steps — the slider's count rides `steps` (clamped 1..=20). The loop
/// repeats the same engine step and breaks early when the program exits, returning the
/// LAST snapshot; intermediate locations are deliberately not rendered (skipping is the
/// feature), the final location/locals/output are. A mid-loop engine error (the common
/// one: the program just exited) is swallowed in favor of the last good snapshot; an
/// error on the very first step propagates exactly as before. `continue` is FORCED to
/// a single engine step: N>1 continues would silently skip N breakpoints, which is
/// nobody's mental model of "steps per click".
pub fn step(kind: &str, steps: u32) -> Result<DebugSnapshot, String> {
    if !matches!(kind, "over" | "into" | "out" | "continue") {
        return Err(format!("unknown step kind '{kind}'"));
    }
    let steps = if kind == "continue" { 1 } else { steps.clamp(1, 20) };
    let mut slot = SESSION.lock().map_err(|_| "debug session lock poisoned")?;
    match slot.as_mut() {
        Some(Engine::Gdb(s)) => {
            let exec = match kind {
                "over" => "-exec-next",
                "into" => "-exec-step",
                "out" => "-exec-finish",
                _ => "-exec-continue",
            };
            let mut last: Option<DebugSnapshot> = None;
            for _ in 0..steps {
                match s.transact(exec, STEP_TIMEOUT).and_then(|_| s.wait_stopped(STEP_TIMEOUT)) {
                    Ok(stop_raw) => {
                        let snap = s.snapshot(&stop_raw)?;
                        let exited = snap.exited;
                        last = Some(snap);
                        if exited {
                            break;
                        }
                    }
                    Err(e) => return last.ok_or(e),
                }
            }
            last.ok_or_else(|| "debug step produced no stop".into())
        }
        Some(Engine::Pdb(s)) => {
            let mut last: Option<DebugSnapshot> = None;
            for _ in 0..steps {
                match s.step(kind) {
                    Ok(snap) => {
                        let exited = snap.exited;
                        last = Some(snap);
                        if exited {
                            break;
                        }
                    }
                    Err(e) => return last.ok_or(e),
                }
            }
            last.ok_or_else(|| "debug step produced no stop".into())
        }
        None => Err("no debug session is running".into()),
    }
}

// ---------- pass #124: the python lane (pdb) ----------
// A generated wrapper runs the draft under pdb with THREE separated streams: the
// debuggee's stdin is swapped to the case file (input() reads the case, never our
// command pipe), the program's stdout goes to the session output file, and pdb's own
// protocol stream (prompts, location lines, `p` results) rides stderr, which the
// reader parses Rust-side — no raw passthrough, the same fixed-command promise the
// gdb lane has (n/s/r/c plus one locals query per stop). set_step parks on the
// draft's first EXECUTABLE line, which is exactly the session's first snapshot.

pub struct PdbSession {
    child: Child,
    stdin: Option<ChildStdin>,
    rx: BoundedRecv<String>,
    dir: PathBuf,
    out_path: PathBuf,
    stderr_tail: std::collections::VecDeque<String>, // debuggee stderr (tracebacks…) — display, capped
    overflow: std::sync::Arc<std::sync::atomic::AtomicBool>,
    watcher_stop: std::sync::Arc<std::sync::atomic::AtomicBool>,
    #[cfg(windows)]
    _job: Option<crate::cph::job::Job>,
    _guard: crate::cph::JobGuard,
}

impl Drop for PdbSession {
    fn drop(&mut self) {
        use std::sync::atomic::Ordering;
        self.watcher_stop.store(true, Ordering::SeqCst);
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// The wrapper: JSON string literals are valid Python string literals for every escape
/// we emit, so paths ride without quoting hazards. `Pdb(stdin=sys.__stdin__)` is the
/// load-bearing line — sys.stdin was already swapped to the case file, and the COMMAND
/// pipe must stay the original process stdin.
/// pass #126 (He, live: "the wrapper exited before the first stop" on a valid draft):
/// the old script called the PRIVATE `Pdb._runscript`, which does not exist in the
/// 3.12.6/3.14.3 Windows builds at all (reproduced live — AttributeError on both).
/// The rewrite uses the public bdb surface only: reset + set_step stops at the first
/// EXECUTABLE line (comments/shebangs included in the file don't matter), and
/// `Pdb.run(code, main-globals)` executes the draft with __name__ == "__main__".
/// Verified live on 3.12.6 and 3.14.3: initial stop line 1 → n → line 2 → c → output.
fn pdb_wrapper_script(source: &Path, stdin_file: &Path) -> String {
    let src = serde_json::to_string(&source.to_string_lossy().replace('\\', "/")).unwrap_or_else(|_| "\"\"".into());
    let inp = serde_json::to_string(&stdin_file.to_string_lossy().replace('\\', "/")).unwrap_or_else(|_| "\"\"".into());
    format!(
        "import sys, pdb\n_t = {src}\nsys.argv = [_t]\nsys.stdin = open({inp}, \"r\", encoding=\"utf-8\", errors=\"replace\")\n_d = pdb.Pdb(stdin=sys.__stdin__, stdout=sys.stderr)\n_d.reset()\n_d.set_step()\n_g = {{\"__name__\": \"__main__\", \"__file__\": _t, \"__builtins__\": __builtins__}}\n_d.run(compile(open(_t, \"rb\").read(), _t, \"exec\"), _g)\n"
    )
}

/// `> <path>(<line>)<func>()` — with the pdb prompt possibly still sitting at the head
/// of the line (it prints without a newline, so the reader only sees it once the NEXT
/// line completes). The path may contain parens itself; the function's trailing ()
/// strips first, which anchors the (line) scan at the right paren.
pub fn parse_pdb_location(line: &str) -> Option<(u32, Option<String>)> {
    let rest = line.trim_start_matches("(Pdb) ").trim().strip_prefix("> ")?;
    let body = rest.strip_suffix("()")?;
    let open = body.rfind('(')?;
    let close = body[open..].find(')')? + open;
    let digits = &body[open + 1..close];
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let n = digits.parse::<u32>().ok()?;
    let func = body[close + 1..].trim().to_string();
    Some((n, if func.is_empty() { None } else { Some(func) }))
}

fn spawn_line_reader(
    child_stderr: std::process::ChildStderr,
    tx: mpsc::Sender<String>,
    pending: std::sync::Arc<std::sync::atomic::AtomicUsize>,
    shutdown: std::sync::Arc<std::sync::atomic::AtomicBool>,
) {
    use std::sync::atomic::Ordering;
    std::thread::spawn(move || {
        let mut reader = BufReader::new(child_stderr);
        // pass #142 (W8-09): byte-capped lines + consumer backpressure — a python
        // draft flooding ITS stderr can no longer balloon the reader or the channel.
        while let Ok(Some(line)) = read_line_capped(&mut reader, LINE_CAP) {
            while !shutdown.load(Ordering::SeqCst) && pending.load(Ordering::SeqCst) >= CHANNEL_HIGH_WATER {
                std::thread::sleep(Duration::from_millis(2));
            }
            pending.fetch_add(1, Ordering::SeqCst);
            if tx.send(line).is_err() {
                break;
            }
        }
        // EOF — the channel disconnects; wait_location maps that to "the program is gone"
    });
}

const PDB_TAIL_LINES: usize = 60;
const PDB_TAIL_BYTES: usize = 32 * 1024;

// pass #163 (wave-12 W12-06): truncate a String to at most `cap` BYTES, on a CHAR
// BOUNDARY. A plain `truncate(cap)` panics when cap lands mid-codepoint, and pdb stderr
// carries multibyte UTF-8 (Unicode identifiers and exception messages) — that panic
// poisons the session mutex, failing every later debug op. Walk back to the nearest
// boundary at or below cap (at most 3 bytes for UTF-8). Pure so the rule is testable
// without constructing a PdbSession.
fn truncate_tail_bytes(line: &mut String, cap: usize) {
    if line.len() <= cap {
        return;
    }
    let mut end = cap;
    while end > 0 && !line.is_char_boundary(end) {
        end -= 1;
    }
    line.truncate(end);
}

impl PdbSession {
    /// pass #142 (W8-08): the pdb wrapper's death is either the stream ending or the
    /// output watcher killing the tree — the overflow verdict wins when raised.
    fn engine_death(&self) -> String {
        use std::sync::atomic::Ordering;
        if self.overflow.load(Ordering::SeqCst) {
            "the program's output overflowed the 32 MiB session cap — the session was stopped".into()
        } else {
            "the wrapper exited".into()
        }
    }

    fn wait_err(&self, default: &'static str) -> String {
        use std::sync::atomic::Ordering;
        if self.overflow.load(Ordering::SeqCst) {
            self.engine_death()
        } else {
            default.into()
        }
    }

    fn send(&mut self, cmd: &str) -> Result<(), String> {
        let stdin = self.stdin.as_mut().ok_or("pdb stdin closed")?;
        writeln!(stdin, "{cmd}").map_err(|e| format!("pdb write: {e}"))?;
        stdin.flush().map_err(|e| format!("pdb flush: {e}"))
    }

    fn push_tail(&mut self, mut line: String) {
        // pass #142 (W8-09): byte-capped as well as line-capped — sixty 2 MB lines were a
        // 120 MB tail. The FRONT is dropped first (the newest traceback text wins).
        while !self.stderr_tail.is_empty()
            && (self.stderr_tail.len() >= PDB_TAIL_LINES
                || self.stderr_tail.iter().map(|l| l.len() + 1).sum::<usize>() + line.len() + 1 > PDB_TAIL_BYTES)
        {
            self.stderr_tail.pop_front();
        }
        // pass #157 (wave-11 W11-L05): a single line larger than the whole tail budget
        // used to be admitted whole after the front-drop — the cap was violated by the
        // very line it should have bounded. Truncate it to the budget (char-boundary-safe,
        // pass #163/W12-06 — a mid-codepoint byte truncate would panic and poison the mutex).
        truncate_tail_bytes(&mut line, PDB_TAIL_BYTES);
        self.stderr_tail.push_back(line);
    }

    /// Reads stderr lines until the next location line — a stop. Ok(None) = the stream
    /// ended (the wrapper exited: the program finished, crashed past pdb, or quit).
    fn wait_location(&mut self, timeout: Duration) -> Result<Option<(u32, Option<String>)>, String> {
        let deadline = Instant::now() + timeout;
        loop {
            match self.rx.recv_sliced(deadline, &INTERRUPT) {
                RecvOutcome::Got(raw) => {
                    let line = raw.trim_end().to_string();
                    if let Some((n, func)) = parse_pdb_location(&line) {
                        return Ok(Some((n, func)));
                    }
                    if !line.trim_start_matches("(Pdb) ").trim().is_empty() {
                        self.push_tail(line);
                    }
                }
                RecvOutcome::TimedOut => {
                    return Err(self.wait_err("the program did not stop in time — Stop the session and retry"))
                }
                RecvOutcome::Disconnected => return Ok(None),
                RecvOutcome::Interrupted => return Err("the step was interrupted by Stop".into()),
            }
        }
    }

    /// One line in, one line out: json.dumps keeps the answer single-line and repr()
    /// pre-stringifies every value, so nothing but text crosses the protocol.
    /// pass #142 (W8-09): the answer is PRE-BOUNDED at the source — at most 200 locals
    /// and repr strings cut at 2000 chars each — so a frame with pathological values
    /// cannot serialize an unbounded line; the reader's line cap and the JSON cap here
    /// are the second and third fences.
    fn query_locals(&mut self) -> (Vec<DebugLocal>, bool) {
        // pass #156 (wave-11 W11-09): the [:200] slice moved INSIDE the comprehension's
        // source — the old shape converted repr(v) for EVERY local, then sliced, so a
        // frame with many members paid unbounded Python-side evaluation before any
        // limit applied (the auditor measured 205 __repr__ calls for a 200-row result).
        // repr(v) itself still fully evaluates per value — a pathological __repr__ is
        // unbounded Python and cannot be capped from Rust; disclosed, not hidden.
        const EXPR: &str = "__import__('json').dumps([[str(k), type(v).__name__, repr(v)[:2000]] for k, v in sorted(locals().items(), key=lambda i: str(i[0]))[:200]])";
        if self.send(&format!("p {EXPR}")).is_err() {
            return (Vec::new(), false);
        }
        let deadline = Instant::now() + STEP_TIMEOUT;
        let mut locals = Vec::new();
        let mut truncated = false;
        // pass #142 (W8-09): the running cost is incremental (the old loop re-summed
        // every prior local per row), and the wrapper's own answer is pre-bounded
        // (PdbSession::LOCALS_EXPR caps count and repr length at the source).
        let mut running = 0usize;
        loop {
            match self.rx.recv_sliced(deadline, &INTERRUPT) {
                RecvOutcome::Got(raw) => {
                    let line = raw.trim_start_matches("(Pdb) ").trim_end().to_string();
                    if line.is_empty() {
                        continue;
                    }
                    if let Ok(rows) = serde_json::from_str::<Vec<Vec<String>>>(&line) {
                        for row in rows {
                            if row.len() != 3 {
                                continue;
                            }
                            let cost = row[0].len() + row[1].len() + row[2].len() + 24;
                            if running + cost > LOCALS_JSON_CAP {
                                truncated = true;
                                break;
                            }
                            running += cost;
                            locals.push(DebugLocal { name: row[0].clone(), kind: row[1].clone(), value: row[2].clone() });
                        }
                        return (locals, truncated);
                    }
                    self.push_tail(line); // not the answer — keep for display
                }
                RecvOutcome::TimedOut => return (locals, true),
                RecvOutcome::Disconnected => return (locals, false),
                RecvOutcome::Interrupted => return (locals, false),
            }
        }
    }

    fn read_output(&self) -> (String, bool) {
        // same O(cap) shape as the gdb lane — the program's stdout file, first cap bytes
        let len = match std::fs::metadata(&self.out_path) {
            Ok(m) => m.len(),
            Err(_) => return (String::new(), false),
        };
        if len == 0 {
            return (String::new(), false);
        }
        let truncated = len > OUTPUT_SNAPSHOT_CAP as u64;
        let want = if truncated { OUTPUT_SNAPSHOT_CAP } else { len as usize };
        use std::io::Read;
        let mut bytes = Vec::with_capacity(want);
        match std::fs::File::open(&self.out_path) {
            Ok(f) => {
                if f.take(want as u64).read_to_end(&mut bytes).is_err() {
                    return (String::new(), false);
                }
            }
            Err(_) => return (String::new(), false),
        }
        (String::from_utf8_lossy(&bytes[..bytes.len().min(OUTPUT_SNAPSHOT_CAP)]).into_owned(), truncated)
    }

    fn snapshot(&mut self, line: Option<u32>, function: Option<String>) -> DebugSnapshot {
        let (mut output, output_truncated) = self.read_output();
        if !self.stderr_tail.is_empty() {
            let tail: String = self.stderr_tail.drain(..).collect::<Vec<_>>().join("\n");
            if !tail.is_empty() {
                if !output.is_empty() {
                    output.push('\n');
                }
                output.push_str(&tail);
            }
        }
        let (locals, locals_truncated) = self.query_locals();
        DebugSnapshot { line, function, locals, locals_truncated, output, output_truncated, exited: false, exit_code: None, overflow: false }
    }

    fn exited_snapshot(&mut self) -> DebugSnapshot {
        // pass #164 (W11-L06): the overflow verdict rides the snapshot — an exit caused
        // by the output watcher's cap is flagged, never an anonymous exit_code: None
        // that the UI would paint as code 0.
        let (mut output, output_truncated) = self.read_output();
        if !self.stderr_tail.is_empty() {
            let tail: String = self.stderr_tail.drain(..).collect::<Vec<_>>().join("\n");
            if !tail.is_empty() {
                if !output.is_empty() {
                    output.push('\n');
                }
                output.push_str(&tail);
            }
        }
        let overflow = self.overflow.load(std::sync::atomic::Ordering::SeqCst);
        DebugSnapshot { line: None, function: None, locals: Vec::new(), locals_truncated: false, output, output_truncated, exited: true, exit_code: None, overflow }
    }

    fn step(&mut self, kind: &str) -> Result<DebugSnapshot, String> {
        let cmd = match kind {
            "over" => "n",
            "into" => "s",
            "out" => "r", // pdb's return = finish the current frame
            _ => "c",
        };
        if self.send(cmd).is_err() {
            return Ok(self.exited_snapshot());
        }
        match self.wait_location(STEP_TIMEOUT)? {
            Some((line, function)) => Ok(self.snapshot(Some(line), function)),
            None => Ok(self.exited_snapshot()), // the wrapper is gone — the program finished or quit
        }
    }
}

fn start_pdb(params: StartParams) -> Result<DebugSnapshot, String> {
    // self-heal: one session at a time — an abandoned one is stopped first
    stop_session();
    INTERRUPT.store(false, std::sync::atomic::Ordering::SeqCst);
    let dir = params.dir.clone();
    let in_path = dir.join("stdin.txt");
    let out_path = dir.join("stdout.txt");
    let cleanup = |e: String| { let _ = std::fs::remove_dir_all(&dir); e };
    std::fs::write(&in_path, &params.stdin_text).map_err(|e| cleanup(format!("write stdin: {e}")))?;
    let wrapper = dir.join("pdb-wrapper.py");
    std::fs::write(&wrapper, pdb_wrapper_script(&params.source_path, &in_path))
        .map_err(|e| cleanup(format!("write pdb wrapper: {e}")))?;
    let out_file = std::fs::File::create(&out_path).map_err(|e| cleanup(format!("open output: {e}")))?;
    let mut cmd = crate::cph::new_cmd(&params.compiler_binary);
    cmd.arg("-u") // unbuffered — the protocol must never sit in a stdout buffer
        .arg(wrapper.as_os_str())
        .current_dir(&dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::from(out_file))
        .stderr(Stdio::piped());
    // pass #142 (wave-8 W8-10): the same suspended → assign → resume order as the gdb lane.
    #[cfg(all(windows, feature = "job-mem-cap"))]
    let (mut child, attached) = match crate::cph::spawn_tracked_suspended(&mut cmd, None) {
        Ok(pair) => pair,
        Err(e) => return Err(cleanup(format!("spawn python: {e}"))),
    };
    #[cfg(all(windows, feature = "job-mem-cap"))]
    let job = params.job.or(attached);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0); // pass #144 (W8-L18): same group discipline as the gdb lane
    }
    #[cfg(not(all(windows, feature = "job-mem-cap")))]
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return Err(cleanup(format!("spawn python: {e}"))),
    };
    #[cfg(not(all(windows, feature = "job-mem-cap")))]
    #[cfg(windows)]
    let job = params.job.or_else(|| crate::cph::job::Job::track(&child));
    let stderr = child.stderr.take().ok_or("python stderr")?;
    let stdin = child.stdin.take().ok_or("python stdin")?;
    let (tx, rx) = mpsc::channel();
    let pending = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let watcher_stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    spawn_line_reader(stderr, tx, pending.clone(), watcher_stop.clone());
    let overflow = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    spawn_output_watcher(out_path.clone(), child.id(), overflow.clone(), watcher_stop.clone());
    let mut s = PdbSession {
        child,
        stdin: Some(stdin),
        rx: BoundedRecv { rx, pending },
        dir,
        out_path,
        stderr_tail: std::collections::VecDeque::new(),
        overflow,
        watcher_stop,
        #[cfg(windows)]
        _job: job,
        _guard: params.guard,
    };
    // the initial stop: set_step parks on the draft's first executable line
    match s.wait_location(STEP_TIMEOUT)? {
        Some((line, function)) => {
            let snap = s.snapshot(Some(line), function);
            // pass #164 (W11-L08): the same publication-point re-check as the gdb lane.
            // The pdb lane has no stop_inner (that is the gdb engine's helper): the
            // polite quit + the tree kill inline, exactly what stop_session does.
            if INTERRUPT.load(std::sync::atomic::Ordering::SeqCst) {
                if let Some(stdin) = s.stdin.as_mut() {
                    let _ = writeln!(stdin, "q");
                    let _ = stdin.flush();
                }
                let pid = s.child.id();
                let _ = s.child.kill();
                let _ = s.child.wait();
                if pid != 0 {
                    crate::cph::kill_tree(pid);
                }
                return Err("the session was stopped during startup".into());
            }
            let mut slot = SESSION.lock().map_err(|_| "debug session lock poisoned")?;
            *slot = Some(Engine::Pdb(s));
            Ok(snap)
        }
        // pass #126: diagnose-on-fail — the wrapper's stderr (the real traceback) rides
        // in the tail; the error carries it instead of a blind "may fail on import"
        None => {
            let tail: String = s.stderr_tail.drain(..).collect::<Vec<_>>().join("\n");
            Err(if tail.is_empty() {
                "the wrapper exited before the first stop — the draft may fail on import".into()
            } else {
                format!("the wrapper exited before the first stop:\n{tail}")
            })
        }
    }
}

// ---------- tests (no gdb required) ----------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncate_tail_bytes_never_splits_a_codepoint() {
        // pass #163 (wave-12 W12-06): a byte cap landing mid-codepoint must walk back to
        // a boundary, not panic (the panic poisoned the pdb session mutex). '😀' is 4
        // bytes — build a string whose cap index falls inside one.
        let mut s = "a".repeat(10) + "😀😀😀";
        let cap = 12; // byte 12 is inside the first emoji (10 a's occupy 0..10)
        assert!(!s.is_char_boundary(cap), "the test cap must land mid-codepoint");
        truncate_tail_bytes(&mut s, cap);
        assert!(s.len() <= cap);
        assert!(s.is_char_boundary(s.len()));
        assert_eq!(s, "a".repeat(10), "walked back to the boundary before the emoji");

        let mut small = "héllo".to_string(); // under the cap → untouched
        truncate_tail_bytes(&mut small, 100);
        assert_eq!(small, "héllo");

        let mut exact = "abcd".to_string(); // exactly at a boundary → kept whole
        truncate_tail_bytes(&mut exact, 4);
        assert_eq!(exact, "abcd");
    }

    #[test]
    fn next_queued_stop_skips_notifications_to_the_real_stop() {
        // pass #163 (wave-12 W12-19): transact() queues every async event before the exec
        // result token. wait_stopped must drain to the *stopped, not hand snapshot() the
        // first =thread-*/=library-loaded/*running notification (the desync).
        let mut q: VecDeque<String> = VecDeque::new();
        q.push_back("=thread-group-started,id=\"i1\",pid=\"123\"".into());
        q.push_back("=library-loaded,id=\"1\",target-name=\"ntdll.dll\"".into());
        q.push_back("*running,thread-id=\"all\"".into());
        q.push_back("*stopped,reason=\"breakpoint-hit\",bkptno=\"1\",frame={func=\"main\"}".into());
        q.push_back("=thread-selected,id=\"2\"".into());
        let got = next_queued_stop(&mut q);
        assert_eq!(got.as_deref(), Some("*stopped,reason=\"breakpoint-hit\",bkptno=\"1\",frame={func=\"main\"}"));
        // the stop and everything before it are consumed; the trailing notification stays
        // for the next op (it is not a stop, so it must not be returned ahead of one).
        assert_eq!(q.len(), 1);
        assert_eq!(q.front().map(|s| s.as_str()), Some("=thread-selected,id=\"2\""));

        // a queue with no stop drains to None (the caller then reads the engine stream)
        let mut none: VecDeque<String> = VecDeque::new();
        none.push_back("*running,thread-id=\"all\"".into());
        none.push_back("=breakpoint-modified,bkpt={number=\"1\"}".into());
        assert_eq!(next_queued_stop(&mut none), None);
        assert!(none.is_empty());

        // an empty queue is None
        assert_eq!(next_queued_stop(&mut VecDeque::new()), None);

        // the exit stop is a *stopped record too — it must be returned, not skipped
        let mut exit: VecDeque<String> = VecDeque::new();
        exit.push_back("*stopped,reason=\"exited-normally\"".into());
        assert_eq!(next_queued_stop(&mut exit).as_deref(), Some("*stopped,reason=\"exited-normally\""));
    }

    // pass #143 (self-sweep F3): the watcher's live poll → escalate → kill path. A
    // sacrificial real child (ping) plays the engine; the test grows the watched file
    // past the 32 MiB cap and asserts the flag raises AND the child tree dies.
    // (The full gdb-integrated smoke — an infinite printer through start_gdb — is
    // BLOCKED ON THIS BOX right now, not by delcc: the box runs Windhawk, whose
    // injected windhawk.dll acts as a second debugger in the inferior — under gdb,
    // every `continue` re-fires the entry breakpoint at the same address without
    // executing anything (raw-MI-verified: breakpoint times="2", same PC, empty
    // redirection file). delcc's own step/continue is equally affected on this box
    // until Windhawk excludes delcc/gdb/the compiler — recorded in the sweep doc.)
    #[cfg(windows)]
    #[test]
    fn output_watcher_kills_the_engine_tree_at_the_cap() {
        use std::io::Write;
        use std::sync::atomic::{AtomicBool, Ordering};
        let dir = std::env::temp_dir().join(format!("delcc-w8-08b-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let out = dir.join("stdout.txt");
        std::fs::write(&out, "").unwrap();
        let mut child = crate::cph::new_cmd("cmd")
            .args(["/c", "ping", "-n", "60", "127.0.0.1"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("the sacrificial engine spawns");
        let pid = child.id();
        let overflow = std::sync::Arc::new(AtomicBool::new(false));
        let shutdown = std::sync::Arc::new(AtomicBool::new(false));
        spawn_output_watcher(out.clone(), pid, overflow.clone(), shutdown.clone());
        // grow the watched file past the 32 MiB cap — the watcher's next poll kills
        let mut f = std::fs::OpenOptions::new().append(true).open(&out).unwrap();
        let chunk = vec![b'x'; 1024 * 1024];
        for _ in 0..34 {
            let _ = f.write_all(&chunk);
        }
        drop(f);
        let deadline = Instant::now() + Duration::from_secs(8);
        let (mut dead, mut flagged) = (false, false);
        while Instant::now() < deadline {
            flagged = overflow.load(Ordering::SeqCst);
            if matches!(child.try_wait(), Ok(Some(_))) {
                dead = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        shutdown.store(true, Ordering::SeqCst);
        let _ = child.kill();
        let _ = child.wait();
        let _ = std::fs::remove_dir_all(&dir);
        assert!(flagged, "the watcher raised the overflow flag");
        assert!(dead, "the engine tree was killed within the poll window");
    }

    // pass #145 (wave-9 W9-01): the gdb lane's stdout.txt only appears when the
    // inferior starts — the watcher must ride out the first NotFound ticks and still
    // kill at the cap once the file exists. (Pre-#145 the watcher retired on ANY
    // metadata error: a slow gdb boot silently disarmed the 32 MiB guard for the
    // whole session. The pre-create in start_gdb closes the race; the bounded
    // not-yet grace is the belt to that brace, and this test locks it.)
    #[cfg(windows)]
    #[test]
    fn output_watcher_survives_a_late_file_and_still_kills_at_the_cap() {
        use std::io::Write;
        use std::sync::atomic::{AtomicBool, Ordering};
        let dir = std::env::temp_dir().join(format!("delcc-w9-01-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let out = dir.join("stdout.txt");
        let mut child = crate::cph::new_cmd("cmd")
            .args(["/c", "ping", "-n", "60", "127.0.0.1"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("the sacrificial engine spawns");
        let pid = child.id();
        let overflow = std::sync::Arc::new(AtomicBool::new(false));
        let shutdown = std::sync::Arc::new(AtomicBool::new(false));
        spawn_output_watcher(out.clone(), pid, overflow.clone(), shutdown.clone());
        // the file does not exist yet — two-plus watcher ticks ride out the gap
        assert!(!out.exists());
        std::thread::sleep(Duration::from_millis(1200));
        assert!(!overflow.load(Ordering::SeqCst), "no flag before the file exists");
        // the inferior "starts": the file appears and grows past the cap
        let mut f = std::fs::OpenOptions::new().create(true).append(true).open(&out).unwrap();
        let chunk = vec![b'x'; 1024 * 1024];
        for _ in 0..34 {
            let _ = f.write_all(&chunk);
        }
        drop(f);
        let deadline = Instant::now() + Duration::from_secs(8);
        let (mut dead, mut flagged) = (false, false);
        while Instant::now() < deadline {
            flagged = overflow.load(Ordering::SeqCst);
            if matches!(child.try_wait(), Ok(Some(_))) {
                dead = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        shutdown.store(true, Ordering::SeqCst);
        let _ = child.kill();
        let _ = child.wait();
        let _ = std::fs::remove_dir_all(&dir);
        assert!(flagged, "the watcher raised the overflow flag after the late file");
        assert!(dead, "the engine tree was killed within the poll window");
    }

    #[test]
    fn sibling_gdb_consent_follows_compiler_provenance() {
        // pass #142 (wave-8 W8-06): the sibling candidate is auto-trusted ONLY for a
        // trusted-installation compiler; otherwise it rides the same consent gate as
        // the PATH class — BEFORE its version probe may execute. Structural check with
        // a consent closure recording calls: the sibling exists on disk as a text file
        // (its probe fails to spawn, but consent is consulted before any probe).
        let dir = std::env::temp_dir().join(format!("delcc-w8-06-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let compiler = dir.join("g++.exe");
        std::fs::write(&compiler, b"not a real compiler").unwrap();
        let sibling = dir.join("gdb.exe");
        std::fs::write(&sibling, b"not a real gdb").unwrap();
        let compiler_str = compiler.to_string_lossy().to_string();
        let sibling_str = sibling.to_string_lossy().to_string();
        let asked: std::cell::RefCell<Vec<String>> = std::cell::RefCell::new(Vec::new());
        let count = |p: &str| {
            asked.borrow_mut().push(p.to_string());
            true
        };
        let _ = find_gdb(&compiler_str, true, &count);
        assert!(
            !asked.borrow().iter().any(|p| p == &sibling_str),
            "a trusted compiler's sibling is auto-trusted — consent is never consulted"
        );
        let _ = find_gdb(&compiler_str, false, &count);
        assert!(
            asked.borrow().iter().any(|p| p == &sibling_str),
            "the sibling of an untrusted compiler rides the consent gate"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn gdb_candidates_mark_path_entries_untrusted() {
        // pass #129 (attack-surface A3 symmetry) + #142 (W8-06): sibling-of-compiler
        // candidates carry the SIBLING class (auto-trusted only for a trusted-install
        // compiler — see sibling_gdb_consent_follows_compiler_provenance); every
        // PATH-derived candidate is the untrusted class that rides the consent gate
        // before its version probe may execute it.
        let cands = find_gdb_candidates("/opt/tc/bin/g++");
        assert!(cands.len() >= 4, "two sibling candidates plus at least one PATH pair");
        assert!(cands[0].1 && cands[1].1, "the sibling pair is the trusted class");
        assert!(
            cands.iter().skip(2).all(|(_, trusted)| !*trusted),
            "everything after the sibling pair is PATH-derived and untrusted"
        );
        // a bare compiler name has no real sibling dir — the CWD-relative pair is skipped
        let bare = find_gdb_candidates("g++");
        assert!(
            bare.iter().all(|(_, trusted)| !*trusted),
            "no trusted candidates without a real compiler directory"
        );
        // (the refusal naming itself rides find_gdb's existing probed-list error — same
        // channel as the version failures; the consent gate deciding BEFORE any probe is
        // the property that matters here, and it is structural: consent is consulted
        // before new_cmd in find_gdb's loop)
    }

    #[test]
    fn mi_parses_breakpoint_stop_with_nested_frame() {
        // verbatim from the 2026-10-31 probe (gdb 14.2, *stopped on main)
        let raw = r#"reason="breakpoint-hit",disp="keep",bkptno="1",frame={addr="0x0040147b",func="main",args=[],file="t.cpp",fullname="D:\\txploitd\\probe gdb\\t.cpp",line="5",arch="i386"},thread-id="1",stopped-threads="all""#;
        let v = parse_mi(raw).expect("parses");
        assert_eq!(v.get("reason").and_then(|r| r.as_str()), Some("breakpoint-hit"));
        let frame = v.get("frame").expect("frame");
        assert_eq!(frame.get("func").and_then(|f| f.as_str()), Some("main"));
        assert_eq!(frame.get("line").and_then(|l| l.as_str()), Some("5"));
        // the fullname's MI escapes unescape: `\\` -> `\` (and the space survives verbatim)
        assert_eq!(
            frame.get("fullname").and_then(|f| f.as_str()),
            Some(r"D:\txploitd\probe gdb\t.cpp")
        );
    }

    #[test]
    fn mi_parses_variables_list_with_escaped_quotes() {
        let raw = r#"variables=[{name="s",type="std::string",value="{\"_M_p\": \"hi there\"}"},{name="x",type="int",value="3"}]"#;
        let v = parse_mi(raw).expect("parses");
        let vars = v.get("variables").and_then(|v| v.as_list()).expect("list");
        assert_eq!(vars.len(), 2);
        assert_eq!(vars[0].get("name").and_then(|n| n.as_str()), Some("s"));
        assert_eq!(vars[1].get("value").and_then(|v| v.as_str()), Some("3"));
    }

    #[test]
    fn mi_rejects_garbage_and_partial() {
        assert!(parse_mi(r#"frame={line="5""#).is_none()); // unterminated
        assert!(parse_mi(r#"frame={line=}"#).is_none()); // valueless
        assert!(parse_mi("plain").is_none());
    }

    #[test]
    fn gdb_version_gate_reads_both_real_lines() {
        assert_eq!(parse_gdb_version("GNU gdb (GDB) 7.6.1"), Some((7, "7.6.1".into())));
        assert_eq!(
            parse_gdb_version("GNU gdb (GDB for MinGW-W64 x86_64, built by Brecht Sanders, r8) 14.2"),
            Some((14, "14.2".into()))
        );
        assert_eq!(parse_gdb_version("gdb: command not found"), None);
        assert_eq!(parse_gdb_version(""), None);
    }

    #[test]
    fn run_command_quotes_and_forwardslashes() {
        let cmd = build_run_command(Path::new(r"C:\Users\Son Vjp Pro\Temp\stdin.txt"), Path::new(r"C:\Users\Son Vjp Pro\Temp\stdout.txt"));
        assert_eq!(
            cmd,
            r#"run < "C:/Users/Son Vjp Pro/Temp/stdin.txt" > "C:/Users/Son Vjp Pro/Temp/stdout.txt""#
        );
    }

    #[test]
    fn pdb_location_parses_prompts_parens_and_funcs() {
        // verbatim shapes: the prompt can head the line (it prints without a newline),
        // the temp path can contain parens itself, the func varies (<module>, main, …)
        assert_eq!(parse_pdb_location("(Pdb) > D:/t/main.py(12)<module>()"), Some((12, Some("<module>".into()))));
        assert_eq!(parse_pdb_location("> C:/Users/x (x86)/Temp/main.py(7)main()"), Some((7, Some("main".into()))));
        assert_eq!(parse_pdb_location("> D:/t/main.py(3)main()"), Some((3, Some("main".into()))));
        assert_eq!(parse_pdb_location("(Pdb) (Pdb) > D:/t/main.py(1)<module>()"), Some((1, Some("<module>".into()))));
        assert_eq!(parse_pdb_location("garbage"), None);
        assert_eq!(parse_pdb_location("> D:/t/main.py(main)<module>()"), None);
    }

    #[test]
    fn pdb_wrapper_separates_the_three_streams() {
        // the load-bearing lines: the case file becomes the debuggee's stdin, the
        // COMMAND pipe stays the original process stdin, pdb's protocol rides stderr,
        // and the draft runs via the PUBLIC bdb surface (reset + set_step + run) —
        // the private _runscript does not exist in the 3.12/3.14 Windows builds
        // (reproduced live, pass #126)
        let script = pdb_wrapper_script(Path::new(r"D:\t\d\main.py"), Path::new(r"D:\t\d\stdin.txt"));
        assert!(script.contains(r#"_t = "D:/t/d/main.py""#));
        assert!(script.contains(r#"sys.stdin = open("D:/t/d/stdin.txt""#));
        assert!(script.contains("pdb.Pdb(stdin=sys.__stdin__, stdout=sys.stderr)"));
        assert!(script.contains("_d.reset()\n_d.set_step()"));
        assert!(script.contains(r#""__name__": "__main__""#));
        assert!(!script.contains("_runscript"));
    }

    #[test]
    fn mi_console_escape_keeps_the_string_whole() {
        // pass #126: the console command's inner quotes ended the MI string early —
        // gdb parsed `run < ` and answered "Problem parsing arguments" (live repro);
        // escaped, the whole `run < "…" > "…"` reaches gdb's console parser intact
        let cmd = build_run_command(Path::new(r"D:\t\d\stdin.txt"), Path::new(r"D:\t\d\stdout.txt"));
        assert_eq!(cmd, r#"run < "D:/t/d/stdin.txt" > "D:/t/d/stdout.txt""#);
        let escaped = mi_escape_console(&cmd);
        assert_eq!(escaped, r#"run < \"D:/t/d/stdin.txt\" > \"D:/t/d/stdout.txt\""#);
        let line = format!("-interpreter-exec console \"{escaped}\"");
        assert_eq!(line.matches('"').count() % 2, 0, "the MI string must stay balanced");
    }

    #[test]
    fn classify_reads_results_events_and_prompts() {
        // tokenless class record
        match classify("^done,frame={line=\"5\"}") {
            LineKind::Result(None, class, values) => {
                assert_eq!(class, "done");
                assert_eq!(values, "frame={line=\"5\"}");
            }
            _ => panic!("result misclassified"),
        }
        // the token PRECEDES the caret — the shape the reader thread actually sees
        match classify("12^done,frame={line=\"5\"}") {
            LineKind::Result(Some(12), class, values) => {
                assert_eq!(class, "done");
                assert_eq!(values, "frame={line=\"5\"}");
            }
            _ => panic!("tokened result misclassified"),
        }
        match classify("3^error,msg=\"no main\"") {
            LineKind::Result(Some(3), class, _) => assert_eq!(class, "error"),
            _ => panic!("error record misclassified"),
        }
        match classify("^running") {
            LineKind::Result(None, class, values) => {
                assert_eq!(class, "running");
                assert_eq!(values, "");
            }
            _ => panic!("running misclassified"),
        }
        match classify("*stopped,reason=\"exited-normally\"") {
            LineKind::Event(raw) => assert!(raw.starts_with("*stopped")),
            _ => panic!("event misclassified"),
        }
        assert!(matches!(classify("(gdb)"), LineKind::Other));
        assert!(matches!(classify("=thread-group-started,id=\"i1\""), LineKind::Other));
        assert!(matches!(classify("~\"Reading symbols\""), LineKind::Other));
        assert!(matches!(classify("&\"warning: ...\""), LineKind::Other));
    }
}
