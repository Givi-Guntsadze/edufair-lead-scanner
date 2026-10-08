# PR #4 security and reliability review

Reviewed: 2026-10-08. Scope: oversized batch rejection only.

## Outcome

The reported vulnerability is real and the proposed production change is
appropriate. No additional production-code changes were needed. The fix
changes only the early rejection branch in `Code.gs:137`; `index.html` and
the normal scan-processing path are unchanged. Additional regressions and
deployment notes were added to the same PR branch. This is local validation,
not proof of a deployed Apps Script version or event-scale load testing.
GitHub currently reports no CI checks on this draft PR; the evidence here is
the locally executed repository suites and source review.
An independent read-only reviewer found no actionable Critical, Important, or
Minor issues and independently reran the suites and vulnerable-main regression.
The verified totals are 57 frontend, 4 email, and 7 Python test cases, plus the
receiver, participant-link, and campus-parity assertion suites.

## Finding 1 — High: unauthenticated response/work amplification

On `main`, `handleScanRequest` maps an oversized, attacker-controlled scan array,
normalizes each item, and includes each supplied `client_id` in its error
response. This happens before participant authentication. An attacker can
increase rejection work and response size without a valid scanner credential,
potentially consuming receiver resources needed by legitimate scanners.

PR #4 instead returns one fixed response:

```json
{"results":[],"result":"error","code":"invalid_request"}
```

Rejection does not access per-scan fields, Sheets, caches, or locks. The fix
removes this rejection-path amplification; it does not eliminate JSON parsing
cost, platform quotas, or all possible denial-of-service risks. No new body-size
policy or rate limiting is introduced two days before the event.

## Compatibility and verification

- The PR regression fails against `origin/main:Code.gs` and passes against the
  patched receiver, establishing that it detects the original vulnerability.
- 11, 1,000, and 10,000 unauthenticated items produce the same exact response;
  service-call tripwires ensure no normalization or scan processing occurs.
- Exactly 10 legitimate regular/campus scans remain accepted. Campus metadata
  is stored correctly, and duplicate replay adds no rows.
- A backlog larger than 10 still drains in multiple requests, not one oversized
  request; existing 12/23/100-scan queue tests remain green.
- For regular and campus scanners, a batch-level error without individual
  acknowledgements preserves scans, tokens, and campus metadata as pending.
  It stops that drain and a subsequent successful retry syncs the whole queue.
- Legacy single-scan POSTs, authorization/revocation, invalid tickets/campuses,
  transient failures, offline persistence, email escaping, and Python reporting
  remain covered by the passing existing suites.

## Deployment boundary

The draft PR is not merged, and the live Apps Script was not modified. After
approval, copy this branch's `Code.gs` into the scanner-workbook Apps Script
project and deploy a new version using the existing `/exec` URL. No token
rotation, participant-link regeneration, Sheet migration, or frontend
deployment is needed. Updating GitHub alone does not deploy the receiver.

The second security issue and multi-scanner Playwright stress test remain
separate follow-up work, as requested.
