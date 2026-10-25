#!/usr/bin/env python3
"""delcc-e2e.py — config-driven phase scaffold over plain HTTPS (no CORS, no inject).

Config:
  tools/delcc-e2e.local.toml   — your creds/targets, gitignored, never committed.
  tools/delcc-e2e.example.toml — the template; copy it and fill in the [auth] section.

Phases (see README-e2e.md for what each one does and can't verify from here):
  login contests-list problem-open statement-fetch harvest submit-mock

submit-mock produces a REAL submission on the live tenant. It is off unless BOTH
  (a) [danger] allow_live_submit = true in your local.toml, AND
  (b) --allow-live-submit is passed on the command line.
Either alone is not enough — this is deliberate, not a bug.

Run:
  python tools/delcc-e2e.py                          # all safe phases, in order
  python tools/delcc-e2e.py --phases login,harvest    # just these, in order
  python tools/delcc-e2e.py --phases submit-mock --allow-live-submit

Exit code is non-zero on any phase failure. Output is plain stdout, one fact per line —
no status theater, nothing to interpret.
"""
import argparse
import json
import pathlib
import random
import string
import sys
import time
import urllib.error
import urllib.request

try:
    import tomllib
except ImportError:
    print("needs Python 3.11+ (stdlib tomllib) — this box's python3 is older.", file=sys.stderr)
    sys.exit(2)

ROOT = pathlib.Path(__file__).resolve().parent
BASE = "https://oj.tmathcoding.vn/api/v3"
ALL_PHASES = ["login", "contests-list", "problem-open", "statement-fetch", "harvest"]
# submit-mock is deliberately not in ALL_PHASES — see the double-gate above.

DEVICE_ID = "delcc-e2e-" + "".join(random.choice(string.ascii_lowercase + string.digits) for _ in range(16))
HEADERS = {
    "X-Client-Version": "1.0.9",
    "X-Device-Id": DEVICE_ID,
    "User-Agent": "delcc/0.1.0",  # honest client, same UA the app itself sends — standing rule, not optional here
}

PENDING_STATUSES = ("judging", "waiting", "pending", "queued", "")


def call(method, path, body=None, token=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        BASE + "/" + path, data=data, method=method,
        headers={"Content-Type": "application/json", **HEADERS,
                 **({"Authorization": "Bearer " + token} if token else {})})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode())
        except Exception:
            return e.code, str(e)
    except urllib.error.URLError as e:
        return 0, str(e.reason)


def load_config(path: pathlib.Path) -> dict:
    if not path.exists():
        print(f"missing {path}")
        print(f"copy tools/delcc-e2e.example.toml to {path.name} and fill in [auth].")
        sys.exit(2)
    with open(path, "rb") as f:
        return tomllib.load(f)


def as_list(x):
    return x if isinstance(x, list) else (x.get("data", []) if isinstance(x, dict) else [])


class Ctx:
    """Carries state between phases that ran in the same process (token, chosen problem)."""
    def __init__(self):
        self.token = None
        self.contest_key = None
        self.problem_code = None
        self.problem_is_contest = False


def phase_login(cfg, ctx: Ctx) -> bool:
    u, p = cfg.get("auth", {}).get("username"), cfg.get("auth", {}).get("password")
    if not u or not p:
        print("login: [auth] username/password empty in local.toml")
        return False
    code, tok = call("POST", "auth/login", {"username": u, "password": p})
    print("login:", code)
    if code != 200:
        print("  ", str(tok)[:200])
        return False
    ctx.token = tok["access_token"]
    print("  token ok, expires_in:", tok.get("access_expires_in"))
    return True


def phase_contests_list(cfg, ctx: Ctx) -> bool:
    code, contests = call("GET", "contests", token=ctx.token)
    print("contests-list:", code)
    if code != 200:
        print("  ", str(contests)[:200])
        return False
    arr = as_list(contests)
    print("  count:", len(arr))
    for c in arr[:5]:
        print("   ", c.get("key") or c.get("contestKey") or c.get("code"), "|", c.get("name"))
    return True


def phase_problem_open(cfg, ctx: Ctx) -> bool:
    run_cfg = cfg.get("run", {})
    contest_key = (run_cfg.get("contest") or "").strip()
    target = (run_cfg.get("problem") or "").strip()

    if contest_key:
        ctx.contest_key = contest_key
        ctx.problem_is_contest = True
        code, jr = call("POST", f"contests/{contest_key}/join", {}, token=ctx.token)
        print("problem-open: join:", code, str(jr)[:120] if code != 200 else "(joined or already in)")
        code, plist = call("GET", f"contests/{contest_key}/problems", token=ctx.token)
        print("  contest problems:", code)
        if code != 200:
            print("  ", str(plist)[:200])
            return False
        parr = as_list(plist)
    else:
        ctx.problem_is_contest = False
        code, plist = call("GET", "problems", token=ctx.token)
        print("problem-open: public problems:", code)
        if code != 200:
            print("  ", str(plist)[:200])
            return False
        parr = as_list(plist)

    if not parr:
        print("  no problems visible — nothing to target")
        return False
    if not target:
        target = parr[0].get("code")
        print("  no [run].problem configured, using first:", target)
    ctx.problem_code = target
    return True


def phase_statement_fetch(cfg, ctx: Ctx) -> bool:
    if not ctx.problem_code:
        print("statement-fetch: no problem resolved — run problem-open first")
        return False
    path = (f"contests/{ctx.contest_key}/problems/{ctx.problem_code}" if ctx.problem_is_contest
            else f"problems/{ctx.problem_code}")
    code, det = call("GET", path, token=ctx.token)
    print("statement-fetch:", code)
    if code != 200:
        print("  ", str(det)[:200])
        return False
    print("  statement len:", len(det.get("statement", "") or ""))
    print("  allowed_languages:", det.get("allowed_languages"))
    print("  io_method:", det.get("io_method"))
    print("  has_submission:", det.get("has_submission"))
    return True


def phase_harvest(cfg, ctx: Ctx) -> bool:
    """Read-only mirror of the CPH harvester: list past submissions for the resolved
    problem, pull detail on a few, report what's actually viewable. Never writes anything."""
    if not ctx.problem_code:
        print("harvest: no problem resolved — run problem-open first")
        return False
    code, subs = call("GET", f"submissions?problem={ctx.problem_code}&page_size=10", token=ctx.token)
    print("harvest: submissions list:", code)
    if code != 200:
        print("  ", str(subs)[:200])
        return False
    arr = as_list(subs)
    print("  found:", len(arr))
    viewable = 0
    for s in arr[:6]:
        sid = s.get("id")
        if sid is None:
            continue
        dcode, d = call("GET", f"submissions/{sid}", token=ctx.token)
        can_view = dcode == 200 and isinstance(d, dict) and d.get("can_view_detail") is not False
        n_cases = len(d.get("cases", []) or []) if isinstance(d, dict) else 0
        if can_view:
            viewable += 1
        print(f"   #{sid}: {dcode} | can_view_detail={can_view} | cases={n_cases}")
    print(f"  viewable: {viewable}/{min(len(arr), 6)}")
    return True


def phase_submit_mock(cfg, ctx: Ctx, allow_live_submit_flag: bool) -> bool:
    danger = cfg.get("danger", {})
    if not danger.get("allow_live_submit"):
        print("submit-mock: [danger].allow_live_submit is not true in local.toml — refusing.")
        return False
    if not allow_live_submit_flag:
        print("submit-mock: --allow-live-submit was not passed on the command line — refusing.")
        print("  (config alone is not enough on purpose — both gates must be explicit.)")
        return False
    if not ctx.problem_code:
        print("submit-mock: no problem resolved — run problem-open first")
        return False

    lang = danger.get("submit_language", "CPP20")
    src = danger.get("submit_source", 'print("XINCHAO!")')
    path = (f"contests/{ctx.contest_key}/problems/{ctx.problem_code}/submit" if ctx.problem_is_contest
            else f"problems/{ctx.problem_code}/submit")
    print(f"submit-mock: THIS IS A REAL SUBMISSION to {ctx.problem_code} ({lang}).")
    code, sub = call("POST", path, {"language_key": lang, "source": src}, token=ctx.token)
    print("  submit:", code, str(sub)[:200])
    if code != 200:
        return False
    sid = sub.get("submission_id")
    if sid is None:
        print("  no submission_id in response — can't poll")
        return False

    sub_path = (f"contests/{ctx.contest_key}/problems/{ctx.problem_code}/submission/{sid}"
                if ctx.problem_is_contest else f"submissions/{sid}")
    settled = False
    for _ in range(30):
        time.sleep(2)
        code, s = call("GET", sub_path, token=ctx.token)
        st = s.get("status", "") if isinstance(s, dict) else ""
        disp = s.get("status_display") or s.get("result") if isinstance(s, dict) else None
        pts = s.get("points") if isinstance(s, dict) else "?"
        print(f"  poll: {st} / {disp} pts={pts}")
        if st not in PENDING_STATUSES:
            settled = True
            break
    if not settled:
        print("  gave up after 30 polls without a terminal status — submission may still be judging.")
    return True


PHASE_FNS = {
    "login": phase_login,
    "contests-list": phase_contests_list,
    "problem-open": phase_problem_open,
    "statement-fetch": phase_statement_fetch,
    "harvest": phase_harvest,
    # submit-mock handled separately below — it needs the CLI flag, not just cfg
}


def main(argv):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--config", default=str(ROOT / "delcc-e2e.local.toml"))
    ap.add_argument("--phases", default=",".join(ALL_PHASES),
                     help="comma list from: " + ",".join(ALL_PHASES + ["submit-mock"]))
    ap.add_argument("--allow-live-submit", action="store_true",
                     help="required (together with [danger].allow_live_submit=true in the config) to run submit-mock")
    args = ap.parse_args(argv[1:])

    cfg = load_config(pathlib.Path(args.config))
    ctx = Ctx()
    requested = [p.strip() for p in args.phases.split(",") if p.strip()]

    ok = True
    for name in requested:
        if name == "submit-mock":
            ok = phase_submit_mock(cfg, ctx, args.allow_live_submit) and ok
            continue
        fn = PHASE_FNS.get(name)
        if not fn:
            print(f"unknown phase: {name} (known: {', '.join(ALL_PHASES + ['submit-mock'])})")
            return 2
        ok = fn(cfg, ctx) and ok
        if not ok:
            print(f"phase '{name}' failed — stopping.")
            break

    print("RUN COMPLETE —", "OK" if ok else "FAILED")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
