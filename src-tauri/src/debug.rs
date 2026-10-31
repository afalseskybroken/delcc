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
use std::process::{Child, ChildStdin, Command, Stdio};
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

fn find_gdb_candidates(compiler: &str) -> Vec<PathBuf> {
    let mut out = Vec::new();
    // sibling first: the toolchain's own gdb understands its own binaries
    if let Some(dir) = Path::new(compiler).parent() {
        out.push(dir.join("gdb.exe"));
        out.push(dir.join("gdb"));
    }
    if let Some(paths) = std::env::var_os("PATH") {
        for p in std::env::split_paths(&paths) {
            out.push(p.join("gdb.exe"));
            out.push(p.join("gdb"));
        }
    }
    out
}

/// Sibling-of-compiler first, then PATH; both gated at gdb >= 8 (7.6.1 verified broken:
/// no file redirection). Returns (path, version string) or an honest error naming what
/// was probed.
pub fn find_gdb(compiler: &str) -> Result<(PathBuf, String), String> {
    let mut probed: Vec<String> = Vec::new();
    for cand in find_gdb_candidates(compiler) {
        if !cand.is_file() {
            continue;
        }
        let out = match Command::new(&cand).arg("--version").output() {
            Ok(o) => o,
            Err(_) => continue,
        };
        let first = String::from_utf8_lossy(&out.stdout).lines().next().unwrap_or("").to_string();
        match parse_gdb_version(&first) {
            Some((major, ver)) if major >= 8 => return Ok((cand, ver)),
            Some((_major, ver)) => probed.push(format!("{} (gdb {ver}, needs >= 8)", cand.display())),
            None => probed.push(format!("{} (unrecognized version line)", cand.display())),
        }
    }
    Err(if probed.is_empty() {
        "no gdb found next to the compiler or on PATH — step-by-step needs gdb 8+ (C/C++)".into()
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

static SESSION: Mutex<Option<Session>> = Mutex::new(None);

pub fn with_session<T>(f: impl FnOnce(&mut Session) -> Result<T, String>) -> Result<T, String> {
    let mut slot = SESSION.lock().map_err(|_| "debug session lock poisoned")?;
    match slot.as_mut() {
        Some(s) => f(s),
        None => Err("no debug session is running".into()),
    }
}

/// Polite shutdown: -gdb-exit, then taskkill the tree if gdb lingers, then Drop cleans up.
/// Used by debug_stop, by debug_start's self-heal, and by the app's own job slot rules.
pub fn stop_session() -> bool {
    let mut slot = match SESSION.lock() {
        Ok(s) => s,
        Err(_) => return false,
    };
    match slot.take() {
        Some(mut s) => {
            if let Some(stdin) = s.stdin.as_mut() {
                let _ = writeln!(stdin, "0-gdb-exit");
                let _ = stdin.flush();
            }
            let deadline = Instant::now() + Duration::from_millis(1500);
            while Instant::now() < deadline {
                match s.child.try_wait() {
                    Ok(Some(_)) => break,
                    Ok(None) => std::thread::sleep(Duration::from_millis(50)),
                    Err(_) => break,
                }
            }
            let pid = s.child.id();
            let _ = s.child.kill();
            let _ = s.child.wait();
            if pid != 0 {
                crate::cph::kill_tree(pid); // belt and suspenders: the inferior, not just gdb
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
        match std::fs::read(&self.out_path) {
            Ok(bytes) => {
                let truncated = bytes.len() > OUTPUT_SNAPSHOT_CAP;
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
            Err(_) => (String::new(), false), // nothing flushed yet — honest empty
        }
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
/// through the allowlist. Spawns gdb, breaks on main, runs with file redirection, and
/// returns the first snapshot (stopped at main, or exited if main never hit).
pub struct StartParams {
    pub exe: PathBuf,
    pub dir: PathBuf,     // owns the build dir; removed on Drop
    pub stdin_text: String,
    pub compiler_binary: String,
    pub guard: crate::cph::JobGuard,
    #[cfg(windows)]
    pub job: Option<crate::cph::job::Job>,
}

pub fn start(params: StartParams) -> Result<DebugSnapshot, String> {
    // self-heal: one session at a time — an abandoned one is stopped first
    stop_session();
    let (gdb_path, ver) = find_gdb(&params.compiler_binary)?;
    let dir = params.dir.clone();
    let in_path = dir.join("stdin.txt");
    let out_path = dir.join("stdout.txt");
    let cleanup = |e: String| { let _ = std::fs::remove_dir_all(&dir); e };
    std::fs::write(&in_path, &params.stdin_text).map_err(|e| cleanup(format!("write stdin: {e}")))?;

    let gdb_str = gdb_path.to_string_lossy().into_owned();
    let mut child = match crate::cph::new_cmd(&gdb_str)
        .args(["--quiet", "--interpreter=mi2"])
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
    if let Err(e) = s.transact("-break-insert main", STEP_TIMEOUT) {
        let _ = stop_inner(&mut s);
        return Err(format!("no main() to break on: {e}"));
    }
    let run_cmd = build_run_command(&in_path, &s.out_path);
    s.transact(&format!("-interpreter-exec console \"{run_cmd}\""), STEP_TIMEOUT)?;
    let stop_raw = s.wait_stopped(STEP_TIMEOUT)?;
    let snap = s.snapshot(&stop_raw)?;

    let mut slot = SESSION.lock().map_err(|_| "debug session lock poisoned")?;
    *slot = Some(s);
    Ok(snap)
}

fn stop_inner(s: &mut Session) -> Result<(), String> {
    if let Some(stdin) = s.stdin.as_mut() {
        let _ = writeln!(stdin, "0-gdb-exit");
        let _ = stdin.flush();
    }
    Ok(())
}

/// One debugging step. kind: over | into | out | continue.
pub fn step(kind: &str) -> Result<DebugSnapshot, String> {
    let exec = match kind {
        "over" => "-exec-next",
        "into" => "-exec-step",
        "out" => "-exec-finish",
        "continue" => "-exec-continue",
        other => return Err(format!("unknown step kind '{other}'")),
    };
    with_session(|s| {
        s.transact(exec, STEP_TIMEOUT)?;
        let stop_raw = s.wait_stopped(STEP_TIMEOUT)?;
        s.snapshot(&stop_raw)
    })
}

// ---------- tests (no gdb required) ----------

#[cfg(test)]
mod tests {
    use super::*;

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
