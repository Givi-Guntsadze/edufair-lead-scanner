# Live scanner stress test — 2026-10-08

Result: data integrity and eventual synchronization passed. Immediate server
confirmation did not stay within one or two seconds under the extreme burst.

## Environment and scope

- Published GitHub Pages frontend: main commit `ec391ee` (deployment successful).
- Existing Apps Script web-app deployment, redeployed by the organizer.
- Live private `fair-scan-file`; no registration workbook or registration PII read.
- Playwright with installed Chrome 155, 35 isolated browser contexts, one distinct
  active participant link per context: 18 regular and 17 campus-enabled.
- Twenty approved temporary tickets: `TST81001` through `TST81020`.
- Actual QR images delivered through controlled camera streams to the production
  decoder, with real campus-button clicks. No direct scan-callback injection.
- JSON body with `text/plain;charset=UTF-8`; normal readable browser responses,
  no disabled browser security and no opaque `no-cors` uploads.

## Results

| Check | Observed result |
| --- | --- |
| Intended unique institution/ticket pairs | 700 |
| Rows read back through the Google Sheets connector | 700 |
| Missing / extra / duplicate / wrong-campus rows | 0 / 0 / 0 / 0 |
| Pre-existing rows preserved | Yes, exact baseline comparison |
| Final browser queues | 700 synced, 0 pending, 0 rejected |
| Final institution UIs | All 35 displayed All synced |
| First simultaneous upload burst | 35 institutions started within 383 ms |
| QR capture latency | Median 163 ms; 95th percentile 357 ms; maximum 595 ms |
| Simultaneous QR-frame release spread | 24–31 ms in completed full rounds |
| Last capture to final successful acknowledgement | 187 seconds |
| JavaScript page errors | 0 |
| Credentials remaining on terminal queue items | 0 |

Visitors were presented at two-second intervals in rapid bursts. The overall
capture period was 247 seconds, including pauses between bursts and a camera
fixture investigation; it was not a single uninterrupted 40-second run.
One synthetic camera stream missed a frame. Re-presenting the QR and explicitly
requesting camera-frame delivery resolved it; no app behavior was changed.
All 700 captures are accounted for in the final reconciliation.

All 17 campus selectors reset after capture. Cycling through options included
Undecided, and each captured campus matched its final sheet row. Repeating
real QRs at regular and campus scanners left their queues and campus assignments
unchanged. Real upload timeouts and busy responses exercised automatic retries;
580 successful acknowledgements explicitly reported an already-saved duplicate.
Despite those retries, each institution/ticket pair appeared exactly once.

Three scanners were deliberately disconnected while capturing the last two
new tickets. A pending queue survived reload unchanged while its upload endpoint
was temporarily blocked, then synchronized after reconnecting. Automatic
synchronization drained every queue without a manual Sync Now click.

Reviewed screenshots cover regular and campus pending/synchronized feedback,
campus reset, and regular scanner controls at 390×844 and 360×800 phone layouts.
Primary regular controls remained visible with no horizontal overflow. Dense
campus pages use their existing scrollable layout. Screenshot artifacts remain
local under `output/playwright/`; no credentials or request traces are published.

## Operational caveat and cleanup

Fast local capture is independent of upload completion. This test triggered
115 per-scan server-busy results and repeated nine-second request timeouts;
retries recovered, but server confirmations took minutes to finish. Do not
close a volunteer's scanner or clear its storage while uploads remain pending.
Wait for All synced before ending its session.

This finite desktop Chrome exercise does not guarantee unlimited sustained
throughput, Google provider availability, or physical phone camera/autofocus
behavior. No additional Apps Script deployment is needed for the header fix.

The organizer can remove Raw_Scans rows whose UUID is one of `TST81001`–`TST81020`
and remove those same 20 values from valid_tickets. Test rows/tickets were left
in place as agreed. Identify them by value, not a stale row range: n8n continues
appending legitimate tickets. Participant records, tokens, and other rows were
not modified. Owned test browser sessions were closed after verification.
