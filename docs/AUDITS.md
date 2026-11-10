# Audit trail

delcc is audited by independent LLM auditors; every finding is adjudicated
against the source (confirmed findings fixed, misfires documented) before
anything ships. This page is the honest history — including what each
auditor missed.

| Wave | Auditor | Method | Result |
| --- | --- | --- | --- |
| 1–7 | Claude Sonnet 5.5 | diff-driven, per pass | findings fixed in-pass; wave 7 came back clean |
| 8 | Kimi K3.1 Pro (via Qoder) | **whole-tree** sweep | 12 Medium + 18 Low, all 12 Mediums adjudicator-confirmed and fixed (#141–#144) |
| re-audit | Claude Sonnet 5.5 | whole repo at `105f1f0` | 4 code findings, all confirmed in source and fixed (#145); its own calibration note: diff-driven waves miss what whole-tree catches |
| 9 (tree-scoped) | Claude Sonnet 5.5 | whole tree at `edb9553` | 2 P2 findings confirmed and fixed (#154): unescaped boot-failure screen and raw server numerics; CI least-privilege + SHA pin; `taskkill` absolute path; all-validated-address pinning. Its four wave-8 items re-verified fixed in source |
| 10 (tree-scoped) | Buffy (Freebuff agent) | whole tree at `bc3530b` | 3 new findings: position-agnostic `taskkill` launch, host-only pin cache ignoring port, unbounded icon base64 decode; plus the wave-9 P2 batch fixed. The unscoped-`/submissions` question stays OPEN (needs maintainer scope call) |

## Standing disclosures (not findings — owned limitations)

- The nested `mermaid → katex` advisory chain (4 low, GHSA-238p-pmpm-9mq7):
  no 0.16.x fix exists and this box's npm silently drops `overrides`;
  the fix path is the Excalidraw 0.17.6 major upgrade, tracked upstream.
- The AGE annotation layer (pen/erase marks) is bitmap-based screen space —
  pen marks do not follow graph zooms (v1 semantics, disclosed in the
  release notes since #152).
- The non-Windows consent boundary: dev-lane consent gates answer `true`
  (no dialog host exists on those platforms); the shipped Windows target is
  unaffected. Disclosed in code and [SECURITY.md](SECURITY.md).
- Browser-level pinch in the desktop app is subject to WebView2's known
  divergence from Chrome ([WebView2Feedback #5179](https://github.com/MicrosoftEdge/WebView2Feedback/issues/5179)):
  wheel/ctrl+wheel/buttons cover every webview-reachable input, and page-side
  code cannot catch gestures the webview never emits.

## The rule

An auditor's misfire is documented, not hidden; a confirmed finding ships
fixed, not argued. The audit trail is the project's face — same standard as
the code.
