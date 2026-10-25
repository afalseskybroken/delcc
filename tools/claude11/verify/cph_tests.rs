// appended to a copy of cph.rs inside a scratch crate (serde+serde_json, a stub `tauri` module, `#[tauri::command]` stripped)
#[cfg(test)]
mod t {
    use super::*;
    fn case(id:&str,input:&str,exp:Option<&str>)->CphCase{ CphCase{ id:id.into(), input:input.into(), expected:exp.map(|s|s.into()), time_limit_ms:None, memory_limit_mb:None } }
    fn run_req(lang:&str,bin:&str,src:&str,cases:Vec<CphCase>,limit:u64)->CphRunRequest{ CphRunRequest{ lang_key:lang.into(), binary:bin.into(), source:src.into(), cases, time_limit_ms:limit, memory_limit_mb:None } }
    const CPP: &str = "#include <bits/stdc++.h>\nint main(){int a,b;std::cin>>a>>b;std::cout<<a+b<<\"\\n\";}";

    #[test] fn serde_keys_are_snake_case() {
        let r = CphRunResponse{ compile_ok:true, compile_log:"".into(), results:vec![CphCaseResult{id:"1".into(),verdict:"AC".into(),stdout:"".into(),stderr:"".into(),time_ms:3,exit_code:Some(0)}], cancelled:false };
        let j = serde_json::to_string(&r).unwrap();
        for k in ["compile_ok","compile_log","time_ms","exit_code","cancelled"] { assert!(j.contains(&format!("\"{k}\"")), "{j}"); }
        assert!(!j.contains("compileOk") && !j.contains("timeMs"), "{j}");
        let tc = serde_json::to_string(&Toolchain{lang_key:"cpp".into(),label:"C++".into(),binary:"g++".into(),version:"x".into()}).unwrap();
        assert!(tc.contains("\"lang_key\"") && !tc.contains("langKey"), "{tc}");
        // request side stays camelCase (what transport.ts sends)
        let q: CphRunRequest = serde_json::from_str(r#"{"langKey":"cpp","binary":"g++","source":"x","cases":[{"id":"1","input":"","expected":null,"timeLimitMs":500}],"timeLimitMs":2000,"memoryLimitMb":256}"#).unwrap();
        assert_eq!(q.lang_key,"cpp"); assert_eq!(q.cases[0].time_limit_ms,Some(500));
    }

    #[test] fn cpp_compile_run_and_cache() {
        let st = CphState::default();
        let c = compile_blocking(st.0.clone(), CphCompileRequest{lang_key:"cpp".into(),binary:"g++".into(),source:CPP.into()}).unwrap();
        assert!(c.compile_ok, "{}", c.compile_log);
        let dir1 = lock(&st.0.cache).as_ref().unwrap().tmp.clone();
        let r = run_blocking(st.0.clone(), run_req("cpp","g++",CPP,vec![case("a","1 2\n",Some("3")),case("b","1 2\n",Some("4")),case("c","5 6\n",None)],2000)).unwrap();
        let v: Vec<_> = r.results.iter().map(|x| x.verdict.as_str()).collect();
        assert_eq!(v, ["AC","WA","RAN"]); assert!(r.compile_ok && !r.cancelled);
        assert_eq!(r.results[0].exit_code, Some(0));
        // unchanged source => same build dir reused (no recompile)
        assert_eq!(lock(&st.0.cache).as_ref().unwrap().tmp, dir1);
        // changed source => new build, old dir gone
        let src2 = CPP.replace("a+b","a*b");
        let r2 = run_blocking(st.0.clone(), run_req("cpp","g++",&src2,vec![case("a","2 3\n",Some("6"))],2000)).unwrap();
        assert_eq!(r2.results[0].verdict,"AC");
        assert_ne!(lock(&st.0.cache).as_ref().unwrap().tmp, dir1); assert!(!dir1.exists());
        st.cleanup(); assert!(lock(&st.0.cache).is_none());
    }

    #[test] fn compile_error_reported() {
        let st = CphState::default();
        let c = compile_blocking(st.0.clone(), CphCompileRequest{lang_key:"cpp".into(),binary:"g++".into(),source:"int main(){ nope }".into()}).unwrap();
        assert!(!c.compile_ok && !c.compile_log.is_empty() && c.exit_code != Some(0));
        let r = run_blocking(st.0.clone(), run_req("cpp","g++","int main(){ nope }",vec![case("a","",None)],1000)).unwrap();
        assert!(!r.compile_ok && r.results.is_empty());
        assert!(lock(&st.0.cache).is_none()); // failed builds are not cached, dir removed
    }

    #[test] fn python_syntax_check_and_run() {
        let st = CphState::default();
        let bad = compile_blocking(st.0.clone(), CphCompileRequest{lang_key:"python".into(),binary:"python3".into(),source:"def (:\n".into()}).unwrap();
        assert!(!bad.compile_ok && !bad.compile_log.is_empty(), "{}", bad.compile_log);
        let good = compile_blocking(st.0.clone(), CphCompileRequest{lang_key:"python".into(),binary:"python3".into(),source:"print(1)\n".into()}).unwrap();
        assert!(good.compile_ok, "{}", good.compile_log);
        let r = run_blocking(st.0.clone(), run_req("python","python3","print(int(input())*2)\n",vec![case("a","21\n",Some("42"))],2000)).unwrap();
        assert_eq!(r.results[0].verdict,"AC");
        st.cleanup();
    }

    #[test] fn node_syntax_check() {
        let st = CphState::default();
        let bad = compile_blocking(st.0.clone(), CphCompileRequest{lang_key:"javascript".into(),binary:"node".into(),source:"let = ;".into()}).unwrap();
        assert!(!bad.compile_ok, "{}", bad.compile_log);
        st.cleanup();
    }

    #[test] fn tle_kills_and_returns_promptly() {
        let st = CphState::default();
        let t0 = Instant::now();
        let r = run_blocking(st.0.clone(), run_req("python","python3","while True: pass\n",vec![case("a","",None)],300)).unwrap();
        assert_eq!(r.results[0].verdict,"TLE"); assert!(t0.elapsed() < Duration::from_secs(3), "{:?}", t0.elapsed());
        st.cleanup();
    }

    // the grandchild holds the stdout pipe open: with child.kill() alone this blocks ~30 s in read_to_end
    #[test] fn tle_kills_whole_tree() {
        let st = CphState::default();
        let src = "import subprocess,sys\nsubprocess.Popen(['sleep','30'])\nsubprocess.run(['sleep','30'])\n";
        let t0 = Instant::now();
        let r = run_blocking(st.0.clone(), run_req("python","python3",src,vec![case("a","",None)],300)).unwrap();
        assert_eq!(r.results[0].verdict,"TLE");
        assert!(t0.elapsed() < Duration::from_secs(5), "tree not killed: {:?}", t0.elapsed());
        st.cleanup();
    }

    #[test] fn stop_cancels_running_job_and_frees_slot() {
        let st = CphState::default();
        let inner = st.0.clone();
        let h = std::thread::spawn(move || run_blocking(inner, run_req("python","python3","import time\ntime.sleep(60)\n",vec![case("a","",None),case("b","",None)],10_000)).unwrap());
        std::thread::sleep(Duration::from_millis(700));
        // a second job while one is active is refused
        assert!(run_blocking(st.0.clone(), run_req("python","python3","print(1)\n",vec![case("x","",None)],1000)).is_err());
        let t0 = Instant::now();
        assert!(st.stop());
        let r = h.join().unwrap();
        assert!(t0.elapsed() < Duration::from_secs(2), "{:?}", t0.elapsed());
        assert!(r.cancelled); assert_eq!(r.results.len(), 1); assert_eq!(r.results[0].verdict,"CANCELLED");
        assert!(lock(&st.0.active).is_none()); assert!(!st.stop());
        // and the next run works
        let ok = run_blocking(st.0.clone(), run_req("python","python3","print(7)\n",vec![case("a","",Some("7"))],2000)).unwrap();
        assert_eq!(ok.results[0].verdict,"AC");
        st.cleanup();
    }

    #[test] fn stop_during_compile() {
        let st = CphState::default();
        let inner = st.0.clone();
        // heavy template recursion keeps g++ busy for a while
        let src = "template<int N> struct F{ static const long long v = F<N-1>::v + F<N-2>::v; }; template<> struct F<0>{static const long long v=0;}; template<> struct F<1>{static const long long v=1;}; #include <vector>\nint main(){ std::vector<int> v; return F<900>::v; }";
        let h = std::thread::spawn(move || compile_blocking(inner, CphCompileRequest{lang_key:"cpp".into(),binary:"g++".into(),source:src.into()}).unwrap());
        std::thread::sleep(Duration::from_millis(250));
        st.stop();
        let r = h.join().unwrap();
        // either it was still compiling (cancelled) or g++ finished/failed fast on this box — never a hang
        assert!(r.cancelled || r.time_ms < 5_000, "{:?}", r.time_ms);
        st.cleanup();
    }
}

// B1.A: additive stop/exit tests. Run this module alone with `stop_semantics`.
// Requires rustc and its platform linker; a std-only fixture controls compiler/runtime outcomes.
#[cfg(test)]
mod stop_semantics {
    use super::*;
    use std::sync::Barrier;
    use std::thread::{self, JoinHandle};

    struct Cleanup(CphState);
    impl Drop for Cleanup { fn drop(&mut self) { self.0.cleanup(); } }

    struct Pending<T> { state: CphState, handle: Option<JoinHandle<T>> }
    impl<T: Send + 'static> Pending<T> {
        fn start(state: &CphState, work: impl FnOnce(Arc<Inner>) -> T + Send + 'static) -> Self {
            let inner = state.0.clone();
            Self { state: state.clone(), handle: Some(thread::spawn(move || work(inner))) }
        }
        fn finish(&mut self) -> T { self.handle.take().unwrap().join().unwrap_or_else(|_| panic!("worker panicked")) }
    }
    impl<T> Drop for Pending<T> {
        fn drop(&mut self) {
            // Assertion failures must not leave a worker, compiler, or cached build behind.
            self.state.cleanup();
            if let Some(handle) = self.handle.take() { let _ = handle.join(); }
            self.state.cleanup();
        }
    }

    struct Tool { dir: PathBuf, binary: PathBuf }
    impl Drop for Tool { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.dir); } }
    impl Tool {
        fn new() -> Self {
            let dir = new_tmp_dir(JOB_SEQ.fetch_add(1, Ordering::Relaxed)).unwrap();
            let tool = Self { binary: dir.join(if cfg!(windows) { "fixture.exe" } else { "fixture" }), dir };
            let src = tool.dir.join("fixture.rs");
            fs::write(&src, r#"
use std::{env, fs, io::{self, Write}, path::PathBuf, thread, time::{Duration, Instant}};
fn main() {
    let args: Vec<_> = env::args().skip(1).collect();
    let source = fs::read_to_string(args.last().expect("source argument")).unwrap();
    let mut lines = source.lines();
    let mode = lines.next().unwrap_or("");
    if mode == "compile_wait" {
        let marker = PathBuf::from(lines.next().unwrap());
        let staging = marker.with_extension("pending");
        eprintln!("fixture compiler started");
        fs::write(&staging, env::current_dir().unwrap().to_string_lossy().as_bytes()).unwrap();
        fs::rename(staging, marker).unwrap(); // complete path published atomically
    }
    if mode == "compile_wait" || mode == "wait" {
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline { thread::sleep(Duration::from_millis(10)); }
        std::process::exit(93); // bounded even if cancellation regresses
    }
    if args.iter().any(|a| a == "-o") {
        let out = &args[args.iter().position(|a| a == "-o").unwrap() + 1];
        fs::copy(env::current_exe().unwrap(), out).unwrap();
        return;
    }
    assert_eq!(mode, "exit");
    let code: i32 = lines.next().unwrap().parse().unwrap();
    print!("{}", lines.collect::<Vec<_>>().join("\n"));
    io::stdout().flush().unwrap();
    std::process::exit(code);
}
"#).unwrap();
            let mut cmd = new_cmd("rustc");
            cmd.arg("--edition=2021").arg(&src).arg("-o").arg(&tool.binary);
            let job = ActiveJob { id: 0, cancel: AtomicBool::new(false), pid: AtomicU32::new(0) };
            let built = capture(cmd, None, Duration::from_secs(30), None, &job);
            assert!(built.spawn_err.is_none(), "fixture rustc unavailable: {:?}", built.spawn_err);
            assert!(!built.timed_out && built.status.map(|s| s.success()).unwrap_or(false),
                "fixture rustc failed: {}", clip(&built.stderr));
            tool
        }
        fn name(&self) -> String { self.binary.to_string_lossy().into_owned() }
    }

    fn request(binary: String, source: &str, expected: Option<&str>) -> CphRunRequest {
        CphRunRequest { lang_key: "python".into(), binary, source: source.into(),
            cases: vec![CphCase { id: "case".into(), input: String::new(), expected: expected.map(str::to_owned),
                time_limit_ms: None, memory_limit_mb: None }], time_limit_ms: 2_000, memory_limit_mb: None }
    }

    #[test]
    fn b1_cph_stop_flag_is_idle_false_active_true_and_reset_for_next_job() {
        // cph_stop is exactly Ok(state.stop()); exercise that flag path without a Tauri runtime.
        let state = CphState::default();
        assert!(!state.stop());
        let guard = JobGuard::begin(&state.0).unwrap();
        assert!(!guard.job.cancel.load(Ordering::SeqCst));
        assert!(state.stop());
        assert!(state.stop(), "repeated Stop still addresses the same active job");
        assert!(guard.job.cancel.load(Ordering::SeqCst));
        assert_eq!(guard.job.pid.load(Ordering::SeqCst), 0, "flagging does not launch or kill a process");
        assert!(lock(&state.0.active).is_some(), "Stop does not release the slot; JobGuard does");
        drop(guard);
        assert!(!state.stop());
        let next = JobGuard::begin(&state.0).unwrap();
        assert!(!next.job.cancel.load(Ordering::SeqCst), "Stop must not leak into the next job");
    }

    #[test]
    fn b1_single_active_slot_accepts_exactly_one_concurrent_claimant() {
        let state = CphState::default();
        let start = Arc::new(Barrier::new(9));
        let attempted = Arc::new(Barrier::new(8));
        let workers: Vec<_> = (0..8).map(|_| {
            let (inner, start, attempted) = (state.0.clone(), start.clone(), attempted.clone());
            thread::spawn(move || {
                start.wait();
                let guard = JobGuard::begin(&inner);
                // The successful guard stays alive until every competing begin has returned.
                attempted.wait();
                guard.map(|_| true).unwrap_or_else(|e| { assert_eq!(e, "a local run is already in progress"); false })
            })
        }).collect();
        start.wait();
        let accepted = workers.into_iter().map(|w| usize::from(w.join().unwrap())).sum::<usize>();
        assert_eq!(accepted, 1);
        assert!(lock(&state.0.active).is_none());
        let _next = JobGuard::begin(&state.0).unwrap();
    }

    #[test]
    fn b1_actual_exit_codes_map_to_ac_wa_ran_and_re() {
        let tool = Tool::new();
        let cleanup = Cleanup(CphState::default());
        let state = &cleanup.0;
        let scenarios = [
            ("zero matching output", 0, Some("answer"), "AC"),
            ("zero different output", 0, Some("different"), "WA"),
            ("zero without expected output", 0, None, "RAN"),
            ("zero with blank expected output", 0, Some(" \r\n\t"), "RAN"),
            ("nonzero overrides matching output", 1, Some("answer"), "RE"),
            ("nonzero without expected output", 7, None, "RE"),
            ("largest portable exit byte", 255, Some("different"), "RE"),
        ];
        for (name, code, expected, verdict) in scenarios {
            let response = run_blocking(state.0.clone(), request(tool.name(), &format!("exit\n{code}\nanswer"), expected)).unwrap();
            assert!(response.compile_ok && !response.cancelled, "{name}");
            assert_eq!(response.results.len(), 1, "{name}");
            let result = &response.results[0];
            assert_eq!(result.exit_code, Some(code), "{name}");
            assert_eq!(result.stdout, "answer", "{name}");
            assert_eq!(result.verdict, verdict, "{name}");
            assert!(lock(&state.0.active).is_none(), "{name}");
        }
        // No child status exists after a spawn failure: None is RE, never success.
        let absent = tool.dir.join("nonexistent-interpreter").to_string_lossy().into_owned();
        let response = run_blocking(state.0.clone(), request(absent, "exit\n0\nanswer", Some("answer"))).unwrap();
        assert!(response.compile_ok && !response.cancelled);
        assert_eq!(response.results[0].exit_code, None);
        assert_eq!(response.results[0].verdict, "RE");
        assert!(response.results[0].stderr.starts_with("spawn: "));
    }

    #[test]
    fn b1_timeout_verdict_takes_precedence_over_killed_child_exit_code() {
        let tool = Tool::new();
        let cleanup = Cleanup(CphState::default());
        let mut req = request(tool.name(), "wait", None);
        req.time_limit_ms = 100;
        let response = run_blocking(cleanup.0.0.clone(), req).unwrap();
        assert!(response.compile_ok && !response.cancelled);
        assert_eq!(response.results[0].verdict, "TLE");
        // Windows reports a termination code; Unix commonly reports no numeric exit code.
        assert_ne!(response.results[0].exit_code, Some(0));
    }

    #[test]
    fn b1_cancellation_during_compile_preserves_cache_and_releases_compile_and_run_slots() {
        let tool = Tool::new();
        for run_mode in [false, true] {
            let cleanup = Cleanup(CphState::default());
            let state = &cleanup.0;
            // A script with zero cases seeds a valid cache without launching a child.
            let mut seed = request(tool.name(), "exit\n0\nseed", None);
            seed.cases.clear();
            assert!(run_blocking(state.0.clone(), seed).unwrap().compile_ok);
            let (old_key, old_tmp) = {
                let cache = lock(&state.0.cache);
                let build = cache.as_ref().unwrap();
                (build.key, build.tmp.clone())
            };
            let marker = tool.dir.join(format!("compile-started-{run_mode}"));
            let source = format!("compile_wait\n{}", marker.display());
            let binary = tool.name();
            enum Response { Compile(CphCompileResponse), Run(CphRunResponse) }
            let mut pending = Pending::start(state, move |inner| {
                if run_mode {
                    let mut req = request(binary, &source, None);
                    req.lang_key = "cpp".into();
                    run_blocking(inner, req).map(Response::Run)
                } else {
                    compile_blocking(inner, CphCompileRequest { lang_key: "cpp".into(), binary, source }).map(Response::Compile)
                }
            });
            let deadline = Instant::now() + Duration::from_secs(5);
            let (cancelled_tmp, job) = loop {
                if let Ok(path) = fs::read_to_string(&marker) {
                    let active = lock(&state.0.active).as_ref().cloned();
                    if let Some(job) = active {
                        // The child may publish its marker before capture publishes the PID.
                        if job.pid.load(Ordering::SeqCst) != 0 { break (PathBuf::from(path), job); }
                    }
                }
                assert!(Instant::now() < deadline, "compiler did not publish its started marker");
                assert!(!pending.handle.as_ref().unwrap().is_finished(), "compiler ended before Stop");
                thread::sleep(Duration::from_millis(5));
            };
            assert_ne!(job.pid.load(Ordering::SeqCst), 0);
            // Both entry points reject work while this compiler owns the single slot.
            assert!(run_blocking(state.0.clone(), request(tool.name(), "exit\n0\n", None)).is_err());
            assert!(compile_blocking(state.0.clone(), CphCompileRequest { lang_key: "cpp".into(), binary: tool.name(), source: "compile_ok".into() }).is_err());
            assert!(state.stop());
            match pending.finish().unwrap() {
                Response::Compile(r) => {
                    assert!(!r.compile_ok && r.cancelled);
                    assert_ne!(r.exit_code, Some(0));
                    assert!(r.compile_log.contains("fixture compiler started"));
                }
                Response::Run(r) => {
                    assert!(!r.compile_ok && r.cancelled);
                    assert!(r.results.is_empty(), "no cases run after cancelled compilation");
                    assert!(r.compile_log.contains("fixture compiler started"));
                }
            }
            assert_eq!(job.pid.load(Ordering::SeqCst), 0);
            assert!(lock(&state.0.active).is_none());
            assert!(!state.stop());
            assert!(!cancelled_tmp.exists(), "cancelled build directory must be removed");
            {
                let cache = lock(&state.0.cache);
                let build = cache.as_ref().unwrap();
                assert_eq!(build.key, old_key);
                assert_eq!(build.tmp, old_tmp);
                assert!(build.artifact.exists(), "a failed replacement preserves the previous build");
            }
            let next = compile_blocking(state.0.clone(), CphCompileRequest { lang_key: "cpp".into(), binary: tool.name(), source: "compile_ok".into() }).unwrap();
            assert!(next.compile_ok && !next.cancelled, "slot and cancellation flag are reusable");
            assert_eq!(next.exit_code, Some(0));
            assert!(!old_tmp.exists(), "successful replacement retires the old cache");
        }
    }
}
