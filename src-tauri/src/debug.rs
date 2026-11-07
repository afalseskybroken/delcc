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

/// pass #129 (attack-surface A3 symmetry): candidates carry a trust class. Sibling
/// candidates inherit whatever trust the COMPILER itself has — same directory, same
/// execution class as running the compiler. pass #141 (wave-8 W8-06) states the
/// boundary honestly: the persisted consent records and the Settings overrides name
/// the COMPILER path only, so approving a compiler also approves its sibling gdb
/// WITHOUT a second prompt — even when the compiler itself only ran because the user
/// consented to it. That is a disclosed consent boundary, not an audited one: the
/// per-executable model (#101) and the sibling rule disagree until the provenance-aware
/// fix (consent for the exact debugger path whenever the compiler was consent-gated or
/// overridden — wave-8 Batch B) lands. Every PATH-derived candidate is the UNTRUSTED
/// class: same-user-writable, and the version gate alone admits any binary that prints
/// a plausible number — those ride the confirm-once consent gate in find_gdb before
/// their `--version` may execute. A bare compiler name has no real sibling directory
/// (parent is ""), and a CWD-relative "gdb.exe" is not the toolchain's own gdb —
/// skipped rather than probed.
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
/// no file redirection). PATH-class candidates additionally ride the confirm-once
/// consent gate (A3 symmetry) BEFORE the version probe — probing is an execution.
/// Returns (path, version string) or an honest error naming what was probed and what
/// was refused.
pub fn find_gdb(compiler: &str, consent: &dyn Fn(&str) -> bool) -> Result<(PathBuf, String), String> {
    let mut probed: Vec<String> = Vec::new();
    for (cand, trusted) in find_gdb_candidates(compiler) {
        if !cand.is_file() {
            continue;
        }
        let path_str = cand.to_string_lossy().to_string();
        if !trusted && !consent(&path_str) {
            probed.push(format!("{path_str} (refused by the user)"));
            continue;
        }
        let out = match crate::cph::new_cmd(&path_str).arg("--version").output() {
            Ok(o) => o,
            Err(_) => continue,
        };
        // pass #141 (wave-8 W8-07, partial — the rest is queued Batch C): probe_one's
        // doctrine holds here too — a probe must SUCCEED. The old loop read stdout with
        // no exit check, so any binary that printed a plausible version line on its way
        // to a nonzero exit was admitted as "gdb".
        if !out.status.success() {
            probed.push(format!("{} (probe exited nonzero)", cand.display()));
            continue;
        }
        let first = String::from_utf8_lossy(&out.stdout).lines().next().unwrap_or("").to_string();
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

pub struct Session {
    child: Child,
    stdin: Option<ChildStdin>,
    rx: Receiver<ReaderLine>,
    dir: PathBuf,
    out_path: PathBuf,
    seq: i32,
    events: VecDeque<String>,
    #[cfg(windows)]
    _job: Option<crate::cph::job::Job>,
    /// Held for the whole session: while you debug, cph_run/cph_compile stay refused
    /// ("a local run is already in progress") — one compiler/Job slot, one truth.
    _guard: crate::cph::JobGuard,
}

impl Drop for Session {
    fn drop(&mut self) {
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

/// Polite shutdown per engine, then Drop cleans up.
/// Used by debug_stop, by debug_start's self-heal, and by the app's own job slot rules.
pub fn stop_session() -> bool {
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
            let now = Instant::now();
            if now >= deadline {
                return Err("gdb did not answer in time — Stop the session and retry".into());
            }
            match self.rx.recv_timeout(deadline - now) {
                Ok(ReaderLine(LineKind::Result(Some(t), class, values))) if t == tok => {
                    if class == "error" {
                        return Err(format!("gdb: {values}"));
                    }
                    return Ok(values);
                }
                Ok(ReaderLine(LineKind::Result(_, _, _))) => {} // stale/async record — skip
                Ok(ReaderLine(LineKind::Event(raw))) => self.events.push_back(raw),
                Ok(ReaderLine(LineKind::Other)) => {}
                Ok(ReaderLine(LineKind::Eof)) => return Err("gdb exited unexpectedly".into()),
                Err(RecvTimeoutError::Timeout) => {
                    return Err("gdb did not answer in time — Stop the session and retry".into())
                }
                Err(RecvTimeoutError::Disconnected) => return Err("gdb exited unexpectedly".into()),
            }
        }
    }

    /// Consumes events until the next *stopped (or the program exits). Ops are strictly
    /// sequential from the UI — buttons disable while a step is in flight — so the first
    /// *stopped after the exec is the answer.
    fn wait_stopped(&mut self, timeout: Duration) -> Result<String, String> {
        let deadline = Instant::now() + timeout;
        loop {
            if let Some(raw) = self.events.pop_front() {
                return Ok(raw);
            }
            let now = Instant::now();
            if now >= deadline {
                return Err("the program did not stop in time — Stop the session and retry".into());
            }
            match self.rx.recv_timeout(deadline - now) {
                Ok(ReaderLine(LineKind::Event(raw))) => return Ok(raw),
                Ok(ReaderLine(LineKind::Eof)) | Err(RecvTimeoutError::Disconnected) => {
                    return Err("gdb exited unexpectedly".into())
                }
                Ok(ReaderLine(LineKind::Other)) => {}
                Ok(ReaderLine(_)) => {} // result records of already-answered transacts
                Err(RecvTimeoutError::Timeout) => {
                    return Err("the program did not stop in time — Stop the session and retry".into())
                }
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
                for var in vars {
                    let name = var.get("name").and_then(|n| n.as_str()).unwrap_or("").to_string();
                    if name.is_empty() {
                        continue;
                    }
                    let kind = var.get("type").and_then(|t| t.as_str()).unwrap_or("").to_string();
                    let value = var.get("value").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    locals.push(DebugLocal { name, kind, value });
                    if locals.iter().map(|l| l.name.len() + l.kind.len() + l.value.len() + 24).sum::<usize>() > LOCALS_JSON_CAP {
                        locals.pop();
                        locals_truncated = true;
                        break;
                    }
                }
            }
        }
        Ok(DebugSnapshot { line, function, locals, locals_truncated, output, output_truncated, exited: false, exit_code: None })
    }
}

fn spawn_reader(child_stdout: std::process::ChildStdout, tx: mpsc::Sender<ReaderLine>) {
    std::thread::spawn(move || {
        let reader = BufReader::new(child_stdout);
        for line in reader.lines() {
            let Ok(line) = line else { break };
            let trimmed = line.trim_end();
            if trimmed == "(gdb)" {
                continue;
            }
            let kind = classify(trimmed);
            if tx.send(ReaderLine(kind)).is_err() {
                break;
            }
        }
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
    pub guard: crate::cph::JobGuard,
    #[cfg(windows)]
    pub job: Option<crate::cph::job::Job>,
}

pub fn start(params: StartParams, consent: &dyn Fn(&str) -> bool) -> Result<DebugSnapshot, String> {
    // pass #124: engine dispatch — python rides pdb (its own lane below); the compiled
    // family rides gdb with per-language entry symbols. The consent gate (A3 symmetry,
    // pass #129) only concerns the gdb lane's PATH-class debugger candidates.
    if params.lang_key == "python" {
        return start_pdb(params);
    }
    start_gdb(params, consent)
}

fn start_gdb(params: StartParams, consent: &dyn Fn(&str) -> bool) -> Result<DebugSnapshot, String> {
    // self-heal: one session at a time — an abandoned one is stopped first
    stop_session();
    let (gdb_path, ver) = find_gdb(&params.compiler_binary, consent)?;
    let dir = params.dir.clone();
    let in_path = dir.join("stdin.txt");
    let out_path = dir.join("stdout.txt");
    let cleanup = |e: String| { let _ = std::fs::remove_dir_all(&dir); e };
    std::fs::write(&in_path, &params.stdin_text).map_err(|e| cleanup(format!("write stdin: {e}")))?;

    let gdb_str = gdb_path.to_string_lossy().into_owned();
    let mut child = match crate::cph::new_cmd(&gdb_str)
        // pass #123 (attack-surface A3): `-nx` skips user/system .gdbinit — MI needs no
        // init-file conveniences, and an init file is one more thing the plant-a-file
        // adversary (the A2 class) could inject into every debug session.
        .args(["--quiet", "-nx", "--interpreter=mi2"])
        .arg(&params.exe)
        .current_dir(&dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => return Err(cleanup(format!("spawn gdb: {e}"))),
    };
    #[cfg(windows)]
    let job = params.job.or_else(|| crate::cph::job::Job::track(&child));
    let stdout = child.stdout.take().ok_or("gdb stdout")?;
    let stdin = child.stdin.take().ok_or("gdb stdin")?;
    let (tx, rx) = mpsc::channel();
    spawn_reader(stdout, tx);

    let mut s = Session {
        child,
        stdin: Some(stdin),
        rx,
        dir,
        out_path,
        seq: 0,
        events: VecDeque::new(),
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
    rx: Receiver<String>,
    dir: PathBuf,
    out_path: PathBuf,
    stderr_tail: std::collections::VecDeque<String>, // debuggee stderr (tracebacks…) — display, capped
    #[cfg(windows)]
    _job: Option<crate::cph::job::Job>,
    _guard: crate::cph::JobGuard,
}

impl Drop for PdbSession {
    fn drop(&mut self) {
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

fn spawn_line_reader(child_stderr: std::process::ChildStderr, tx: mpsc::Sender<String>) {
    std::thread::spawn(move || {
        let reader = BufReader::new(child_stderr);
        for line in reader.lines() {
            let Ok(line) = line else { break };
            if tx.send(line).is_err() {
                break;
            }
        }
        // EOF — the channel disconnects; wait_location maps that to "the program is gone"
    });
}

const PDB_TAIL_LINES: usize = 60;

impl PdbSession {
    fn send(&mut self, cmd: &str) -> Result<(), String> {
        let stdin = self.stdin.as_mut().ok_or("pdb stdin closed")?;
        writeln!(stdin, "{cmd}").map_err(|e| format!("pdb write: {e}"))?;
        stdin.flush().map_err(|e| format!("pdb flush: {e}"))
    }

    fn push_tail(&mut self, line: String) {
        if self.stderr_tail.len() >= PDB_TAIL_LINES {
            self.stderr_tail.pop_front();
        }
        self.stderr_tail.push_back(line);
    }

    /// Reads stderr lines until the next location line — a stop. Ok(None) = the stream
    /// ended (the wrapper exited: the program finished, crashed past pdb, or quit).
    fn wait_location(&mut self, timeout: Duration) -> Result<Option<(u32, Option<String>)>, String> {
        let deadline = Instant::now() + timeout;
        loop {
            let now = Instant::now();
            if now >= deadline {
                return Err("the program did not stop in time — Stop the session and retry".into());
            }
            match self.rx.recv_timeout(deadline - now) {
                Ok(raw) => {
                    let line = raw.trim_end().to_string();
                    if let Some((n, func)) = parse_pdb_location(&line) {
                        return Ok(Some((n, func)));
                    }
                    if !line.trim_start_matches("(Pdb) ").trim().is_empty() {
                        self.push_tail(line);
                    }
                }
                Err(RecvTimeoutError::Timeout) => {
                    return Err("the program did not stop in time — Stop the session and retry".into())
                }
                Err(RecvTimeoutError::Disconnected) => return Ok(None),
            }
        }
    }

    /// One line in, one line out: json.dumps keeps the answer single-line and repr()
    /// pre-stringifies every value, so nothing but text crosses the protocol.
    fn query_locals(&mut self) -> (Vec<DebugLocal>, bool) {
        const EXPR: &str = "__import__('json').dumps([[str(k), type(v).__name__, repr(v)] for k, v in sorted(locals().items(), key=lambda i: str(i[0]))])";
        if self.send(&format!("p {EXPR}")).is_err() {
            return (Vec::new(), false);
        }
        let deadline = Instant::now() + STEP_TIMEOUT;
        let mut locals = Vec::new();
        let mut truncated = false;
        loop {
            let now = Instant::now();
            if now >= deadline {
                return (locals, true);
            }
            match self.rx.recv_timeout(deadline - now) {
                Ok(raw) => {
                    let line = raw.trim_start_matches("(Pdb) ").trim_end().to_string();
                    if line.is_empty() {
                        continue;
                    }
                    if let Ok(rows) = serde_json::from_str::<Vec<Vec<String>>>(&line) {
                        for row in rows {
                            if row.len() != 3 {
                                continue;
                            }
                            if locals.iter().map(|l: &DebugLocal| l.name.len() + l.kind.len() + l.value.len() + 24).sum::<usize>() > LOCALS_JSON_CAP {
                                truncated = true;
                                break;
                            }
                            locals.push(DebugLocal { name: row[0].clone(), kind: row[1].clone(), value: row[2].clone() });
                        }
                        return (locals, truncated);
                    }
                    self.push_tail(line); // not the answer — keep for display
                }
                Err(RecvTimeoutError::Timeout) => return (locals, true),
                Err(RecvTimeoutError::Disconnected) => return (locals, false),
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
        DebugSnapshot { line, function, locals, locals_truncated, output, output_truncated, exited: false, exit_code: None }
    }

    fn exited_snapshot(&mut self) -> DebugSnapshot {
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
        DebugSnapshot { line: None, function: None, locals: Vec::new(), locals_truncated: false, output, output_truncated, exited: true, exit_code: None }
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
    let dir = params.dir.clone();
    let in_path = dir.join("stdin.txt");
    let out_path = dir.join("stdout.txt");
    let cleanup = |e: String| { let _ = std::fs::remove_dir_all(&dir); e };
    std::fs::write(&in_path, &params.stdin_text).map_err(|e| cleanup(format!("write stdin: {e}")))?;
    let wrapper = dir.join("pdb-wrapper.py");
    std::fs::write(&wrapper, pdb_wrapper_script(&params.source_path, &in_path))
        .map_err(|e| cleanup(format!("write pdb wrapper: {e}")))?;
    let out_file = std::fs::File::create(&out_path).map_err(|e| cleanup(format!("open output: {e}")))?;
    let mut child = match crate::cph::new_cmd(&params.compiler_binary)
        .arg("-u") // unbuffered — the protocol must never sit in a stdout buffer
        .arg(wrapper.as_os_str())
        .current_dir(&dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::from(out_file))
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => return Err(cleanup(format!("spawn python: {e}"))),
    };
    #[cfg(windows)]
    let job = params.job.or_else(|| crate::cph::job::Job::track(&child));
    let stderr = child.stderr.take().ok_or("python stderr")?;
    let stdin = child.stdin.take().ok_or("python stdin")?;
    let (tx, rx) = mpsc::channel();
    spawn_line_reader(stderr, tx);
    let mut s = PdbSession {
        child,
        stdin: Some(stdin),
        rx,
        dir,
        out_path,
        stderr_tail: std::collections::VecDeque::new(),
        #[cfg(windows)]
        _job: job,
        _guard: params.guard,
    };
    // the initial stop: set_step parks on the draft's first executable line
    match s.wait_location(STEP_TIMEOUT)? {
        Some((line, function)) => {
            let snap = s.snapshot(Some(line), function);
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
    fn gdb_candidates_mark_path_entries_untrusted() {
        // pass #129 (attack-surface A3 symmetry): sibling-of-compiler candidates carry
        // the compiler's own trust; every PATH-derived candidate is the untrusted class
        // that rides the consent gate before its version probe may execute it.
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
