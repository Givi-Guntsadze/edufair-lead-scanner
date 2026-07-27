# Scan Endpoint Authorization Design

**Date:** 2026-07-27

**Status:** Approved for implementation

**Branch:** `codex/fix-public-scan-writes-formula-injection-vulnerability`

## Objective

Prevent anonymous callers from writing arbitrary scan rows while preserving the
event-day, no-login, offline-first scanner workflow. Isolate registration PII
from the public Google Apps Script web app and retain the existing two-CSV
post-event report process.

## Architecture

### Registration workbook

The existing private registration workbook contains only the `Registrations`
tab. n8n writes each full registration, including its eight-character UUID, to
this workbook. No public Apps Script web app is bound to this file.

### Scanner workbook

The private `fair-scan-file` workbook contains exactly these tabs:

| Tab | Columns | Purpose |
| --- | --- | --- |
| `Raw_Scans` | `Timestamp`, `Uni_ID`, `UUID` | PII-free accepted scan events |
| `participant_url` | `Participant_Name`, `Participant_ID`, `Token_Hash`, `Active`, `Scanner_URL` | Authorized participants and generated links |
| `valid_tickets` | `UUID` | PII-free allowlist populated by n8n |

The scan receiver and participant-link administrator are files in one Apps
Script project bound to `fair-scan-file`. The public `doPost` entry point is the
only write path; public `doGet` requests receive a method-not-allowed response.
Administrative link-generation functions are not HTTP routes and are run
manually by an organizer.

### Post-event processor

The existing `scripts/process_leads.py` remains unchanged. It receives:

1. `registrations.csv` exported from the registration workbook; and
2. `raw_scans.csv` exported from the scanner workbook's `Raw_Scans` tab.

It joins them on UUID and creates one registration-data CSV per `Uni_ID`.
Neither `participant_url` nor `valid_tickets` is an input to this processor.

## n8n Registration Sequence

For each successful website registration, n8n performs these actions in order:

1. Generate the UUID.
2. Append the full record, including UUID, to `Registrations`.
3. Append the same UUID and no PII to `fair-scan-file` -> `valid_tickets`.
4. Send the confirmation email and QR code only after both writes succeed.

n8n retries or alerts on the second write rather than issuing a QR code that is
not yet present in `valid_tickets`. Duplicate UUID rows in `valid_tickets` do
not change authorization behavior, although n8n should avoid them when its
retry facilities allow.

## Participant Link Administration

A new repository file, `ParticipantLinks.gs`, supplies organizer-only
functions. The organizer enters `Participant_Name` and `Participant_ID` in
`participant_url`, then manually generates missing links.

For each eligible row, the generator:

1. Validates the participant name and ID and rejects duplicate IDs.
2. Generates a high-entropy, unguessable token.
3. Stores a SHA-256 token hash in `Token_Hash`.
4. Sets `Active` to `TRUE`.
5. Writes the full URL to `Scanner_URL` without putting the raw token in a
   separate column.

The URL has this form:

```text
SCANNER_BASE_URL?uni=constructor#token=RANDOM_SECRET
```

`SCANNER_BASE_URL` is an organizer-configured HTTPS constant. The fragment
keeps the token out of the static host request and referrer. Because the raw
token remains inside `Scanner_URL`, the URL is treated as a credential and the
workbook remains organizer-only.

Generation never overwrites an existing token or URL. A separate explicit
rotation function operates only on the selected participant row, replaces its
token hash and URL, and invalidates the previously distributed link. Setting
`Active` to `FALSE` revokes a link without regenerating it.

## Scan Request and Authorization

The browser reads the public participant ID from the query string and the
secret token from the URL fragment. It does not place the token in the static
host request. During synchronization it sends an HTTPS POST request with a
URL-encoded body containing:

- `participant_id`
- `token`
- `uuid`
- the original client scan timestamp

The server compares `participant_id` with the participant derived from the
token to detect a modified or mismatched link. It never uses the client value
as authorization or as the value written to `Raw_Scans`.

For every POST, Apps Script:

1. Validates the request shape, token format, UUID format, and timestamp.
2. Hashes the submitted token.
3. Finds an exact matching `Token_Hash` in `participant_url`.
4. Requires `Active` to be `TRUE` and derives the trusted `Participant_ID`.
5. Requires the submitted `participant_id` to match the derived ID.
6. Requires the UUID to exist in `valid_tickets`.
7. Acquires the script lock and checks for an existing
   `Participant_ID + UUID` pair in `Raw_Scans`.
8. Appends `Timestamp`, trusted `Participant_ID`, and UUID only if the pair is
   new.

A duplicate request returns an idempotent success response so a network retry
does not remain stuck in the offline queue. `doGet` no longer writes data and
returns a method-not-allowed JSON response.

## Frontend and Offline Behavior

The scanner fails closed and does not start the camera when the token, public
participant ID, or Apps Script deployment URL is missing or malformed. The
currently committed registration-workbook Apps Script URL is removed and
replaced with a deliberately invalid deployment placeholder until the new
`fair-scan-file` web app is deployed.

Offline scans remain queued locally with the participant credential needed to
sync them after a restart. The frontend never logs the token or renders it in
the interface. Existing safe DOM rendering and spreadsheet-formula defenses
remain in place.

Response handling distinguishes:

- **success or duplicate:** mark the queue item synchronized;
- **invalid/inactive participant or invalid ticket:** mark it rejected and stop
  automatic retries for that item;
- **network error or server busy:** keep it pending and retry later.

The POST uses a CORS-safelisted, URL-encoded body. The deployed Apps Script
redirect/response behavior must pass a real-browser integration test before
release; there is no fallback that puts the bearer token into a GET URL.

## Least Privilege and Data Handling

The Apps Script is bound only to `fair-scan-file`, never opens the registration
workbook, and uses the narrowest verified current-spreadsheet authorization
scope. It returns only generic result codes and never returns sheet rows,
participant names, token hashes, raw tokens, or registration data.

Security-relevant values are derived server-side. Participant IDs and UUIDs
retain strict validation, and spreadsheet-formula neutralization remains as
defense in depth on every written string.

## Code Changes

- `Code.gs`: POST-only authorized ingestion, ticket lookup, server-derived
  participant ID, duplicate protection, safe errors, and scanner-workbook
  setup.
- `ParticipantLinks.gs`: manual missing-link generation and explicit selected-row
  token rotation.
- `index.html`: fragment-token parsing, fail-closed configuration, authorized
  POST synchronization, and permanent-versus-transient queue outcomes.
- `tests/code_test.js`: Apps Script authorization, allowlist, rotation-related
  data behavior, injection, and idempotency regression tests.
- `tests/index_test.js`: token parsing, no-token failure, POST payload, queue
  transitions, safe rendering, and offline retry tests.
- `README.md` and `TESTING.md`: exact workbook schemas, n8n sequence, manual link
  generation, two-CSV reporting, new deployment, and end-to-end verification.
- `scripts/process_leads.py`: no functional change.

## Verification and Release

Automated tests must cover:

- valid, unknown, malformed, inactive, and rotated participant tokens;
- existing and nonexistent ticket UUIDs;
- duplicate scan idempotency;
- client attempts to substitute a different participant ID;
- formula-injection payloads and safe DOM rendering;
- missing deployment configuration;
- offline queue success, rejection, and retry behavior; and
- link generation that does not overwrite existing URLs.

Manual verification uses the `/dev` test deployment first, followed by a new
versioned web-app deployment bound to `fair-scan-file`. After deployment, the
new `/exec` URL replaces the fail-closed placeholder in `index.html`. A final
phone test confirms one valid scan, one invalid ticket, one duplicate scan, an
inactive participant link, offline queuing, and later synchronization.

No change is merged to `main` as part of this work. Validated commits are pushed
to the existing security branch so the draft pull request updates
automatically.
