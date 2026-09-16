# EduFair Lead Scanner

An offline-first QR lead scanner for education fairs. Participant links are
authorized with organizer-generated bearer tokens, and the public scan receiver
is isolated from registration PII.

## Architecture

```text
Website registration
  -> n8n generates UUID
  -> full record goes to private Registrations workbook
  -> UUID only goes to fair-scan-file / valid_tickets
  -> confirmation email and QR code are sent

Participant scanner URL
  -> browser queues QR scans offline
  -> Apps Script validates participant token and UUID
  -> accepted unique scan goes to fair-scan-file / Raw_Scans

Post-event
  -> export registrations.csv and raw_scans.csv
  -> process_leads.py joins on UUID
  -> one full-registration CSV per participant
```

The Apps Script web app is bound only to `fair-scan-file`. It never opens or
reads the workbook containing the `Registrations` tab.

## Repository Structure

```text
edufair-lead-scanner/
|-- index.html                     Static scanner for GitHub Pages
|-- Code.gs                        Authorized Apps Script scan receiver
|-- ParticipantLinks.gs            Organizer-only participant URL generator
|-- scripts/process_leads.py       Two-CSV post-event lead splitter
|-- tests/code_test.js             Receiver security regressions
|-- tests/participant_links_test.js
|-- tests/index_test.js            Browser/offline queue regressions
|-- tests/email_template_test.js   Confirmation-email escaping regressions
|-- vendor/html5-qrcode.min.js     Pinned same-origin QR decoder
|-- email-templates/confirmation-email.html
`-- wordpress/ticket-id-generator.php
```

## 1. Registration Workbook and n8n

The original restricted Google Sheets file contains only the `Registrations`
tab and the full registration data, including each eight-character UUID.

For each completed registration, the n8n workflow must perform these operations
in order:

1. Generate the UUID.
2. Append the full registration, including `Which Fair`, to `Registrations`.
3. Append that same UUID, with no PII, to `fair-scan-file` -> `valid_tickets`.
4. Send the confirmation email and QR code only after both writes succeed.

The n8n Google Sheets node for `valid_tickets` maps the generated identifier to
the `UUID` column.

## 2. Scanner Workbook

The restricted `fair-scan-file` Google Sheets file uses these exact,
case-sensitive tab names and headers:

### `Raw_Scans`

| Timestamp | Uni_ID | UUID | Campus |
| --- | --- | --- | --- |

`Campus` is optional scan metadata, not registration PII. It is populated
only for institutions with configured campus options (see "Campus Intent
Capture" below); other scans leave it blank.

### `participant_url`

| Participant_Name | Participant_ID | Token_Hash | Active | Scanner_URL |
| --- | --- | --- | --- | --- |

### `valid_tickets`

| UUID |
| --- |

Only organizers should have access to this workbook. A generated `Scanner_URL`
contains a bearer token and must be treated like a credential.

## 3. Install the Apps Script

1. Open `fair-scan-file`.
2. Select **Extensions -> Apps Script**.
3. Replace the editor's `Code.gs` with this repository's `Code.gs`.
4. Add a second script file named `ParticipantLinks.gs` and paste the repository
   file with the same name.
5. Save the project.
6. Run `setup` once from the Apps Script editor and authorize it. The function
   verifies the three tabs and exact headers without overwriting existing data.

When run from the editor, `setup` records the bound `fair-scan-file` ID in Apps
Script Properties. Google does not make bound-file "active spreadsheet" methods
available during web-app execution, so the public receiver opens only that
recorded scanner-workbook ID. The project contains no registration-workbook ID.
Do not paste or deploy it from the registration workbook.

## 4. Generate Participant URLs

For each participant, enter only the first two cells in `participant_url`:

| Participant_Name | Participant_ID |
| --- | --- |
| Constructor University | constructor |
| IE University | ie |

`Participant_ID` is an organizer-defined stable identifier. It can contain
letters, numbers, internal spaces, `/`, and non-Latin text, but it cannot:

- exceed 50 characters;
- have surrounding whitespace;
- begin with `=`, `+`, `-`, or `@`, including after leading apostrophes; or
- contain control or filename-unsafe characters: `< > : " \ | ? *`.

Run `generateParticipantUrls` manually from the Apps Script editor. It fills
`Token_Hash`, sets `Active` to `TRUE`, and writes the complete `Scanner_URL`.
Running it again does not overwrite an existing link.

To revoke a link, set its `Active` cell to `FALSE`. To replace a compromised
link, select exactly one participant data row and run
`rotateSelectedParticipantUrl`; the old URL immediately becomes invalid.

The generator currently targets:

```text
https://givi-guntsadze.github.io/edufair-lead-scanner/
```

If the static scanner moves, change `SCANNER_BASE_URL` in `ParticipantLinks.gs`
before generating or rotating links.

## 5. Deploy the New Web App

Because this is a new Apps Script project bound to `fair-scan-file`, create a
new deployment:

1. Select **Deploy -> New deployment**.
2. Choose **Web app**.
3. Set **Execute as** to **Me**.
4. Set access to **Anyone**.
5. Deploy and copy the URL ending in `/exec`.

Do not reuse the old web app deployed from the registration workbook.

Open `index.html` and replace:

```javascript
const API_URL = UNCONFIGURED_API_URL;
```

with the new deployment URL:

```javascript
const API_URL = 'https://script.google.com/macros/s/YOUR_NEW_DEPLOYMENT_ID/exec';
```

Until that replacement is made, the scanner intentionally fails closed and
does not start the camera.

For later Apps Script updates, use **Deploy -> Manage deployments**, edit the
active deployment, select a new version, and deploy. That preserves the `/exec`
URL.

After the new deployment passes the live verification matrix, open the Apps
Script project formerly bound to the registration workbook and select
**Deploy -> Manage deployments -> Archive** for its old web-app deployment.
Deleting or replacing the editor source alone does not disable a versioned
deployment, because the active deployment continues serving its selected code
version until it is updated or archived.

## 6. Publish the Scanner

The production scanner is hosted at:

```text
https://givi-guntsadze.github.io/edufair-lead-scanner/
```

The QR decoder is the vendored `html5-qrcode` 2.3.8 release. It is served from
the scanner origin so a remote CDN cannot execute in the credential-bearing
page. Its provenance, checksum, and license are recorded in
`THIRD_PARTY_NOTICES.md`.

Validated changes are developed on the security branch and must not be merged
to `main` until the automated tests, new Apps Script deployment, and manual phone
matrix in `TESTING.md` pass.

## 7. Event-Day Behavior

A participant opens their generated `Scanner_URL`. The public participant ID is
used for display, while the token in the URL fragment authorizes synchronization.

- A scan is saved to the local queue immediately on capture; the volunteer can
  scan the next visitor right away without waiting on the network.
- Pending scans sync in micro-batches (up to 10 per request, immediately after
  every capture and again every 5 seconds) instead of one HTTP request per
  scan. See "9. High-Volume Synchronization" for the full design.
- The token is sent in a POST body, not in the Apps Script request URL.
- Apps Script derives the trusted `Uni_ID` from the token.
- The UUID must exist in `valid_tickets`.
- A repeated `Uni_ID + UUID` pair is treated as a successful duplicate and is
  not appended again. The same UUID scanned by a *different* institution is a
  separate, independently valid pair.
- Invalid participant links, campuses, or tickets are marked rejected rather
  than retried forever, with a human-readable reason shown next to the scan.
- Network failures, request timeouts, and a busy backend all remain pending
  for automatic retry, shown with their own reason (e.g. "server busy,
  retrying").

`Raw_Scans` contains `Timestamp`, `Uni_ID`, `UUID`, and optionally `Campus`.

## 8. Campus Intent Capture

Some institutions have more than one campus or location. For those
institutions, the volunteer asks the visitor which campus they are
interested in, taps that option in the scanner, and only then scans the
visitor's QR code. The selected campus is stored with that one scan and the
selector immediately clears, so the next visitor must be asked again.

Institutions without configured campus options keep the original fast
scanning flow: no selector appears and no extra tap is required.

### Where the configuration lives

Campus options are a static, offline-safe configuration keyed by
`Participant_ID`, kept identical in both `Code.gs` and `index.html` (the
`CAMPUS_CONFIG` constant in each file, between matching `CAMPUS_CONFIG:BEGIN`
/ `CAMPUS_CONFIG:END` markers). `tests/campus_config_test.js` asserts the two
copies never drift apart. The scanner never fetches the campus reference
Google Sheet at runtime, so it remains fully offline-capable.

To add another institution later, add one more entry ending in
`'Undecided'` to both copies:

```javascript
participantId: [
    'Campus A',
    'Campus B',
    'Undecided'
]
```

### Offline and backward-compatible behavior

- Campus is attached to the individual queued scan object, not a shared
  global. Changing the on-screen selection later never mutates an
  already-queued scan, and syncing always sends the campus that was stored
  with that specific scan.
- Older queue items created before this feature (or by institutions with no
  configured campus) simply have no `campus` value; `normalizeStoredScan`
  keeps loading them normally.
- The server treats `campus` as optional protocol metadata: a request
  without it remains valid. A supplied value is validated only against the
  authenticated participant's own configured allowlist (which always
  includes `Undecided`); any other value is rejected with `invalid_campus`
  and nothing is written.

### Post-event export

`scripts/process_leads.py` includes a `Campus` column in the institution
report whenever the joined data has one. Legacy `raw_scans.csv` exports
without a `Campus` column, and non-campus institutions, continue to generate
reports exactly as before.

### Safe schema migration

`Raw_Scans` gains `Campus` as an additive fourth column. See `TESTING.md`
for the exact production migration and staged deployment order — the header
must be added, and verified safe under the *current* production Apps
Script, before the new campus-aware server code is ever deployed.

## 9. High-Volume Synchronization

The scanner is designed for 30+ participant tables scanning simultaneously,
with one volunteer capable of scanning several visitors back-to-back and the
same visitor legitimately being scanned by multiple institutions.

### Micro-batching

`index.html` sends up to 10 pending scans per HTTP request (a JSON body of
`{ scans: [...] }`) instead of one request per scan. Each scan keeps its own
participant ID, bearer credential, UUID, campus, and timestamp; a batch never
mixes them up. Every scan gets its own outcome back from the server (matched
by a client-generated `client_id`, not by array position), so one rejected or
still-pending scan in a batch never affects the others.

**10 is a transport limit only, never a limit on how many scans can be
queued or eventually accepted.** A scan is written to `localStorage`
immediately on capture and stays there, unconditionally, until its own
individual server result comes back as synced or a permanent rejection —
nothing is ever removed just for having been included in a request. Every
`sync()` call drains the *entire* pending queue automatically, one 10-scan
request after another, back-to-back with no wait and no volunteer action in
between: 12 pending scans send as 10 then 2, 23 as 10, 10, then 3, and so on
however large the backlog gets. A volunteer's only job is to keep scanning —
nothing needs to be clicked or retried to "continue" a large batch, and
nothing is ever dropped just because more than 10 scans piled up.

The one thing that legitimately stops an in-progress drain is a transient
outcome — a network failure, a request timeout, or a `server_busy`/
`server_error` result for any scan in the current batch. Sending another
batch immediately afterward would not be safe, so the drain stops there:
everything not yet resolved is left exactly as pending, and picked up again
automatically by the 5-second retry interval or the next triggered sync — no
scan is ever lost, only delayed. `Code.gs` mirrors this on the way in: the
official frontend never sends more than 10 scans per request (it chunks
locally), but if a request somehow arrives oversized anyway, the backend
rejects that malformed request outright (one `invalid_request` result per
submitted scan) rather than silently truncating it, which would otherwise
drop the excess scans with no result at all.

`Code.gs` also still accepts the original single-scan
`application/x-www-form-urlencoded` request and answers with the original
flat `{ result, code, duplicate }` shape. This is not a legacy compatibility
shim for old devices — it exists so the static frontend (GitHub Pages) and
the Apps Script backend, which redeploy independently and manually, can never
silently reject every scan just because one was updated before the other.

### Request timeout

Every sync request carries a 9-second `AbortController` timeout. A timed-out
request is treated exactly like a network failure — the scans in that batch
stay pending and retry automatically — never a permanent rejection. This
keeps one slow or hung request from blocking the sync loop indefinitely.

### Caching (Apps Script `CacheService`)

Three lookups that used to read a full sheet on every single scan are now
cache-assisted:

| Cache | Key | TTL | Caches | Miss behavior |
| --- | --- | --- | --- | --- |
| Valid ticket | UUID | 5 min | Only confirmed-valid UUIDs | Falls back to a live `valid_tickets` read; a brand-new ticket is usable on the very next scan, not bounded by the TTL |
| Participant auth | token hash | 60 sec | Both found-active and not-found/inactive | Falls back to a live `participant_url` read |
| Duplicate (`Uni_ID`+`UUID`) | hash of the pair | 6 hours (event-day) | Only confirmed-written pairs | Falls back to a live `Raw_Scans` read |

None of these caches can ever authorize a UUID that isn't genuinely in
`valid_tickets`: a cache miss always re-checks the sheet before rejecting, so
"not yet cached" is never treated as "invalid." `valid_tickets` therefore
remains the sole source of truth.

The participant cache is the one deliberate tradeoff: because it caches
*both* outcomes for up to 60 seconds, a just-revoked (`Active` -> `FALSE`) or
just-rotated participant link can keep working for up to that window. 60
seconds was chosen because revocation/rotation is already a manual,
non-emergency organizer action (see section 4) — not a live incident
response — so a short bounded delay is an acceptable tradeoff for avoiding a
`participant_url` read on nearly every scan.

### Lock scope and duration

The script lock (`LockService`) now protects only the final write phase — a
cache recheck plus one batched range write — never validation, ticket/
participant lookups, or the pre-lock duplicate check. The wait is 2 seconds,
not the previous 10: a batch that can't get the lock in that window returns
`server_busy` immediately for the affected scans, which stay pending and
retry automatically, rather than holding a volunteer's device on an open
connection for up to 10 seconds. A batch made up entirely of duplicates never
takes the lock at all.

### Duplicate semantics (unchanged)

Duplicate detection is still scoped to `Uni_ID + UUID`, never globally by
UUID alone:

```
SKEMA + ABC12345  -> valid
INTO  + ABC12345  -> also valid (different institution, same visitor)
SKEMA + ABC12345  -> duplicate success, no second row
```

### Efficient writes

Accepted scans in a batch are written with one `Range.setValues()` call
instead of one `appendRow()` per scan.

## 10. Post-Event Processing

The registration export uses these columns (surrounding header whitespace is
trimmed automatically): `timestamp`, `Name`, `Last Name`, `Email`, `Phone`,
`Which programs?`, `Age`, `Intake Year`, `Country`, `Which Fair`,
`Additional Info`, `Consent`, and `UUID`.

1. Export the registration workbook's `Registrations` tab as
   `registrations.csv`.
2. Export `fair-scan-file` -> `Raw_Scans` as `raw_scans.csv`.
3. Place both files in the repository root.
4. Run:

```powershell
pip install -r requirements.txt
python scripts/process_leads.py
```

The script joins the two files by UUID and creates `reports/leads_<Uni_ID>.csv`
for every participant with accepted scans. `participant_url` and
`valid_tickets` are not Python inputs. Each institution receives one CSV with a
`Which Fair` column that it can filter by city, and a `Campus` column when the
scan data includes one.

## Automated Tests

Run from the repository root:

```powershell
node tests/code_test.js
node tests/participant_links_test.js
node --test tests/index_test.js
node --test tests/email_template_test.js
node tests/campus_config_test.js
python -X utf8 tests/process_leads_test.py
python -m py_compile scripts/process_leads.py
```

See `TESTING.md` for the deployment and phone verification matrix.
