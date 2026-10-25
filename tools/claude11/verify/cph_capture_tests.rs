// Append to the current cph.rs using run-cph-capture-tests.ps1. These controlled
// fixtures use no real compiler/interpreter other than rustc to build the fixture.
#[cfg(test)]
mod capture_regressions {
    use super::*;
    use std::thread;

    struct Fixture { dir: PathBuf, binary: PathBuf, marker: PathBuf }
    impl Drop for Fixture {
        fn drop(&mut self) {
            if let Ok(pid) = fs::read_to_string(&self.marker).unwrap_or_default().parse::<u32>() {
                #[cfg(windows)] kill_tree(pid);
                #[cfg(unix)] { let _ = Command::new("kill").args(["-KILL", &pid.to_string()]).status(); }
            }
            let _ = fs::remove_dir_all(&self.dir);
        }
    }
    impl Fixture {
        fn new() -> Self {
            let dir = new_tmp_dir(JOB_SEQ.fetch_add(1, Ordering::Relaxed)).unwrap();
            let fixture = Self { binary: dir.join(if cfg!(windows) { "fixture.exe" } else { "fixture" }), marker: dir.join("descendant.pid"), dir };
            let source = fixture.dir.join("fixture.rs");
            fs::write(&source, r#"
use std::{env, fs, io::{self, Read, Write}, process::{Command, Stdio}, thread, time::Duration};
fn main() {
    let args: Vec<_> = env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("--hold") {
        fs::write(&args[1], std::process::id().to_string()).unwrap();
        thread::sleep(Duration::from_secs(4)); // never an unbounded fixture
        return;
    }
    let source = fs::read_to_string(args.last().unwrap()).unwrap();
    let (mode, body) = source.split_once('\n').unwrap_or((&source, ""));
    if args.iter().any(|arg| arg == "-m") { return; } // successful syntax check
    match mode {
        "echo" => { let mut input = Vec::new(); io::stdin().read_to_end(&mut input).unwrap(); io::stdout().write_all(&input).unwrap(); }
        "text" => { io::stdout().write_all(body.as_bytes()).unwrap(); }
        "stdout" | "stderr" | "both" => {
            let count: usize = body.trim().parse().unwrap();
            let bytes = vec![b'x'; count];
            if mode == "stdout" { let _ = io::stdout().write_all(&bytes); }
            else if mode == "stderr" { let _ = io::stderr().write_all(&bytes); }
            else {
                let extra = bytes.clone();
                let out = thread::spawn(move || { let _ = io::stdout().write_all(&extra); });
                let _ = io::stderr().write_all(&bytes); let _ = out.join();
            }
        }
        "inherit" => {
            Command::new(env::current_exe().unwrap()).args(["--hold", body.trim()])
                .stdin(Stdio::inherit()).stdout(Stdio::inherit()).stderr(Stdio::inherit()).spawn().unwrap();
        }
        "wait" => thread::sleep(Duration::from_secs(4)),
        other => panic!("unexpected fixture mode: {other}"),
    }
}
"#).unwrap();
            let mut cmd = new_cmd("rustc");
            cmd.arg("--edition=2021").arg(source).arg("-o").arg(&fixture.binary);
            let built = capture(cmd, None, Duration::from_secs(30), None, &job());
            assert!(built.spawn_err.is_none() && built.capture_err.is_none() && !built.timed_out,
                "fixture build failed: {:?} {:?}", built.spawn_err, built.capture_err);
            assert!(built.status.unwrap().success(), "{}", clip(&built.stderr));
            fixture
        }
        fn binary(&self) -> String { self.binary.to_string_lossy().into_owned() }
        fn command(&self, source: &str) -> Command {
            let path = self.dir.join("capture.txt"); fs::write(&path, source).unwrap();
            let mut cmd = new_cmd(&self.binary()); cmd.arg(path); cmd
        }
        fn inherited(&self) -> String { format!("inherit\n{}", self.marker.display()) }
    }
    fn job() -> ActiveJob { ActiveJob { id: JOB_SEQ.fetch_add(1, Ordering::Relaxed), cancel: AtomicBool::new(false), pid: AtomicU32::new(0) } }
    fn case(input: &str, expected: Option<&str>) -> CphCase {
        CphCase { id: "case".into(), input: input.into(), expected: expected.map(str::to_owned), time_limit_ms: None, memory_limit_mb: None }
    }
    fn request(f: &Fixture, source: &str, cases: Vec<CphCase>) -> CphRunRequest {
        CphRunRequest { lang_key: "python".into(), binary: f.binary(), source: source.into(), cases, time_limit_ms: 2_000, memory_limit_mb: None }
    }
    struct StateCleanup(CphState);
    impl Drop for StateCleanup { fn drop(&mut self) { self.0.cleanup(); } }
    fn wait_until(mut condition: impl FnMut() -> bool) {
        let start = Instant::now();
        while !condition() { assert!(start.elapsed() < Duration::from_secs(2), "fixture readiness timed out"); thread::sleep(PIPE_POLL); }
    }

    #[test]
    fn complete_stdin_is_delivered_without_a_writer_thread() {
        let fixture = Fixture::new(); let job = job();
        let input = "hello stdin\n".repeat(20_000);
        let result = capture(fixture.command("echo"), Some(&input), Duration::from_secs(2), None, &job);
        assert_eq!(result.stdout, input.as_bytes()); assert_eq!(result.stderr, b"");
        assert!(result.status.unwrap().success() && !result.timed_out && !result.output_limited && result.capture_err.is_none());
        assert_eq!(job.pid.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn exited_parent_with_inherited_pipes_remains_deadline_bounded() {
        let fixture = Fixture::new(); let job = job(); let start = Instant::now();
        let result = capture(fixture.command(&fixture.inherited()), Some(&"a".repeat(2 * OUTPUT_CAP)), Duration::from_millis(250), Some(256), &job);
        assert!(result.timed_out, "inherited pipes must not hide behind the parent's successful exit");
        assert!(start.elapsed() < Duration::from_secs(2), "capture waited for the descendant: {:?}", start.elapsed());
        assert_eq!(job.pid.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn stop_during_inherited_pipe_drain_releases_slot_and_accepts_next_run() {
        let fixture = Fixture::new(); let state = CphState::default(); let _cleanup = StateCleanup(state.clone());
        let mut req = request(&fixture, &fixture.inherited(), vec![case(&"a".repeat(2 * OUTPUT_CAP), None)]);
        req.time_limit_ms = 3_000;
        let inner = state.0.clone(); let pending = thread::spawn(move || run_blocking(inner, req).unwrap());
        wait_until(|| fixture.marker.exists());
        // The fixture parent exits directly after spawn. Let its reaping finish;
        // the descendant remains alive and holds all three inherited handles.
        thread::sleep(Duration::from_millis(150));
        let start = Instant::now(); assert!(state.stop());
        let response = pending.join().unwrap();
        assert!(start.elapsed() < Duration::from_secs(2)); assert!(response.cancelled);
        assert_eq!(response.results[0].verdict, "CANCELLED");
        assert!(lock(&state.0.active).is_none()); assert!(!state.stop());
        let next = run_blocking(state.0.clone(), request(&fixture, "text\nnext", vec![case("", Some("next"))])).unwrap();
        assert_eq!(next.results[0].verdict, "AC");
    }

    #[test]
    fn stdout_and_stderr_capture_allocations_stop_at_the_execution_bound() {
        let fixture = Fixture::new();
        for stream in ["stdout", "stderr", "both"] {
            let start = Instant::now();
            let result = capture(fixture.command(&format!("{stream}\n{}", OUTPUT_CAP * 4)), None, Duration::from_secs(3), None, &job());
            assert!(result.output_limited, "{stream}");
            assert!(result.stdout.len() <= OUTPUT_CAP && result.stderr.len() <= OUTPUT_CAP);
            assert!(start.elapsed() < Duration::from_secs(2), "{stream}: {:?}", start.elapsed());
        }
    }

    #[test]
    fn overflow_is_re_with_a_diagnostic_and_failed_compile_is_not_cached() {
        let fixture = Fixture::new(); let state = CphState::default(); let _cleanup = StateCleanup(state.clone());
        let source = format!("stdout\n{}", OUTPUT_CAP + 1);
        let response = run_blocking(state.0.clone(), request(&fixture, &source, vec![case("", Some("x"))])).unwrap();
        assert_eq!(response.results[0].verdict, "RE");
        assert!(response.results[0].stderr.contains(OUTPUT_LIMIT_MESSAGE));
        assert!(response.results[0].stdout.len() < LOG_CAP + 100);
        state.cleanup();
        let response = compile_blocking(state.0.clone(), CphCompileRequest { lang_key: "cpp".into(), binary: fixture.binary(), source: format!("stderr\n{}", OUTPUT_CAP + 1) }).unwrap();
        assert!(!response.compile_ok && !response.cancelled);
        assert!(response.compile_log.contains(OUTPUT_LIMIT_MESSAGE));
        assert!(lock(&state.0.cache).is_none());
    }

    #[test]
    fn exactly_at_execution_limit_is_accepted_and_only_the_display_is_clipped() {
        let fixture = Fixture::new(); let state = CphState::default(); let _cleanup = StateCleanup(state.clone());
        let expected = "x".repeat(OUTPUT_CAP);
        let response = run_blocking(state.0.clone(), request(&fixture, &format!("stdout\n{OUTPUT_CAP}"), vec![case("", Some(&expected))])).unwrap();
        assert_eq!(response.results[0].verdict, "AC");
        assert!(response.results[0].stdout.ends_with("…(truncated)"));
        assert!(!response.results[0].stderr.contains(OUTPUT_LIMIT_MESSAGE));
    }

    #[test]
    fn comparison_includes_bytes_after_display_boundary_and_multibyte_text() {
        let fixture = Fixture::new(); let state = CphState::default(); let _cleanup = StateCleanup(state.clone());
        let expected = format!("{}λ-tail", "x".repeat(LOG_CAP - 1));
        let wrong = expected.replace("tail", "fail");
        let response = run_blocking(state.0.clone(), request(&fixture, &format!("text\n{expected}"), vec![case("", Some(&expected)), case("", Some(&wrong))])).unwrap();
        assert_eq!(response.results.iter().map(|r| r.verdict.as_str()).collect::<Vec<_>>(), ["AC", "WA"]);
        assert!(response.results[0].stdout.ends_with("…(truncated)"));
    }

    #[test]
    fn comparison_preserves_leading_whitespace_and_blank_expected_convention() {
        let fixture = Fixture::new(); let state = CphState::default(); let _cleanup = StateCleanup(state.clone());
        let response = run_blocking(state.0.clone(), request(&fixture, "text\n \tanswer  \r\n", vec![
            case("", Some(" \tanswer\n")), case("", Some("answer")), case("", Some(" \t\n")), case("", None)
        ])).unwrap();
        assert_eq!(response.results.iter().map(|r| r.verdict.as_str()).collect::<Vec<_>>(), ["AC", "WA", "RAN", "RAN"]);
    }

    #[test]
    fn compile_cache_is_reused_and_stop_does_not_leak_to_next_job() {
        let fixture = Fixture::new(); let state = CphState::default(); let _cleanup = StateCleanup(state.clone());
        let compile = compile_blocking(state.0.clone(), CphCompileRequest { lang_key: "python".into(), binary: fixture.binary(), source: "echo".into() }).unwrap();
        assert!(compile.compile_ok);
        let previous = lock(&state.0.cache).as_ref().unwrap().tmp.clone();
        let run = run_blocking(state.0.clone(), request(&fixture, "echo", vec![case("42\n", Some("42"))])).unwrap();
        assert_eq!(run.results[0].verdict, "AC"); assert_eq!(lock(&state.0.cache).as_ref().unwrap().tmp, previous);
        let guard = JobGuard::begin(&state.0).unwrap(); assert!(state.stop()); drop(guard);
        let next = run_blocking(state.0.clone(), request(&fixture, "echo", vec![case("7", Some("7"))])).unwrap();
        assert!(!next.cancelled); assert_eq!(next.results[0].verdict, "AC");
    }
}
