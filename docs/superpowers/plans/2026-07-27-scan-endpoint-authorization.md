# Scan Endpoint Authorization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Authorize every scan with an organizer-generated participant token and a UUID from the PII-free ticket allowlist, while preserving offline scanning and the existing two-CSV report processor.

**Architecture:** A Google Apps Script project bound only to `fair-scan-file` validates POSTed participant credentials against `participant_url`, validates UUIDs against `valid_tickets`, and atomically appends unique events to `Raw_Scans`. A separate organizer-only Apps Script file generates and rotates secret-bearing participant URLs, while the static scanner reads the token from the URL fragment and queues authenticated POST requests offline.

**Tech Stack:** Vanilla browser JavaScript, Google Apps Script V8, Google Sheets, Node.js built-in test runner and `vm`, GitHub Pages.

---

## File Map

- Modify `Code.gs`: public POST receiver, current-workbook schema, token/ticket authorization, idempotent append, safe errors.
- Create `ParticipantLinks.gs`: organizer-run token generation and selected-row rotation.
- Modify `index.html`: fail-closed configuration, fragment token parsing, authenticated POST synchronization, rejected queue state.
- Replace `tests/code_test.js`: in-memory Apps Script/Sheets harness and backend security regressions.
- Create `tests/participant_links_test.js`: participant-link generation and rotation regressions.
- Modify `tests/index_test.js`: browser harness for fragment parsing, POST requests, and queue transitions.
- Modify `README.md`: two-workbook setup, exact tab schemas, n8n flow, link generation, deployment.
- Modify `TESTING.md`: automated and manual security checks.
- Do not modify `scripts/process_leads.py`: its two-file UUID join already matches the approved architecture.

### Task 1: Build the authorized scan receiver with TDD

**Files:**
- Modify: `tests/code_test.js`
- Modify: `Code.gs`

- [ ] **Step 1: Replace the backend harness and write failing authorization tests**

Create in-memory sheets named exactly `Raw_Scans`, `participant_url`, and
`valid_tickets`. Load `Code.gs` in a VM context that supplies `ContentService`,
`LockService`, `SpreadsheetApp`, and deterministic `Utilities.computeDigest`.
The tests must exercise these request helpers:

```javascript
function postRequest({ participantId, token, uuid, timestamp = '2026-07-27T12:00:00.000Z' }) {
  return JSON.parse(context.doPost({
    parameter: {
      participant_id: participantId,
      token,
      uuid,
      timestamp
    },
    postData: {
      type: 'application/x-www-form-urlencoded',
      contents: new URLSearchParams({
        participant_id: participantId,
        token,
        uuid,
        timestamp
      }).toString()
    }
  }).text);
}

assert.deepStrictEqual(JSON.parse(context.doGet({ parameter: {} }).text), {
  result: 'error',
  code: 'method_not_allowed'
});

assert.strictEqual(postRequest({
  participantId: 'constructor',
  token: VALID_TOKEN,
  uuid: 'A1B2C3D4'
}).result, 'success');

assert.strictEqual(postRequest({
  participantId: 'ie',
  token: VALID_TOKEN,
  uuid: 'A1B2C3D4'
}).code, 'unauthorized');

assert.strictEqual(postRequest({
  participantId: 'constructor',
  token: UNKNOWN_TOKEN,
  uuid: 'A1B2C3D4'
}).code, 'unauthorized');

assert.strictEqual(postRequest({
  participantId: 'constructor',
  token: VALID_TOKEN,
  uuid: 'ZZZZZZZZ'
}).code, 'invalid_ticket');
```

Also assert that an inactive participant is unauthorized, malformed tokens and
UUIDs do not write, a repeated participant/UUID pair returns
`{ result: 'success', duplicate: true }`, the trusted sheet participant ID is
the value appended, and exception responses never contain token or row data.

- [ ] **Step 2: Run the backend test to verify it fails**

Run:

```powershell
node tests/code_test.js
```

Expected: FAIL because the current receiver accepts GET writes and has no token,
participant allowlist, valid-ticket lookup, or duplicate protection.

- [ ] **Step 3: Implement the minimal authorized receiver**

Replace the receiver with these interfaces and behavior:

```javascript
const SCAN_SHEETS = Object.freeze({
  RAW_SCANS: 'Raw_Scans',
  PARTICIPANTS: 'participant_url',
  VALID_TICKETS: 'valid_tickets'
});

const SCAN_HEADERS = Object.freeze({
  RAW_SCANS: ['Timestamp', 'Uni_ID', 'UUID'],
  PARTICIPANTS: ['Participant_Name', 'Participant_ID', 'Token_Hash', 'Active', 'Scanner_URL'],
  VALID_TICKETS: ['UUID']
});

const TOKEN_PATTERN = /^[a-f0-9]{64}$/;
const TICKET_ID_PATTERN = /^[A-Z0-9]{8}$/;

function doGet() {
  return createResponse({ result: 'error', code: 'method_not_allowed' });
}

function doPost(e) {
  return handleScanRequest(e);
}

function handleScanRequest(e) {
  const data = parsePostParameters(e);
  if (!isValidParticipantId(data.participant_id) ||
      !TOKEN_PATTERN.test(data.token || '') ||
      !isValidTicketId(data.uuid) ||
      !isValidTimestamp(data.timestamp)) {
    return createResponse({ result: 'error', code: 'invalid_request' });
  }

  try {
    const spreadsheet = getConfiguredScanSpreadsheet();
    const participants = requireSheetWithHeaders(
      spreadsheet,
      SCAN_SHEETS.PARTICIPANTS,
      SCAN_HEADERS.PARTICIPANTS
    );
    const tickets = requireSheetWithHeaders(
      spreadsheet,
      SCAN_SHEETS.VALID_TICKETS,
      SCAN_HEADERS.VALID_TICKETS
    );
    const rawScans = requireSheetWithHeaders(
      spreadsheet,
      SCAN_SHEETS.RAW_SCANS,
      SCAN_HEADERS.RAW_SCANS
    );

    const participant = findActiveParticipant(participants, hashToken(data.token));
    if (!participant || participant.id !== data.participant_id) {
      return createResponse({ result: 'error', code: 'unauthorized' });
    }
    if (!ticketExists(tickets, data.uuid)) {
      return createResponse({ result: 'error', code: 'invalid_ticket' });
    }

    const lock = LockService.getScriptLock();
    try {
      lock.waitLock(10000);
    } catch (error) {
      return createResponse({ result: 'error', code: 'server_busy' });
    }

    try {
      if (scanExists(rawScans, participant.id, data.uuid)) {
        return createResponse({ result: 'success', duplicate: true });
      }
      rawScans.appendRow([
        new Date(data.timestamp),
        neutralizeFormula(participant.id),
        neutralizeFormula(data.uuid)
      ]);
      return createResponse({ result: 'success', duplicate: false });
    } finally {
      lock.releaseLock();
    }
  } catch (error) {
    console.error('Scan receiver error: ' + String(error));
    return createResponse({ result: 'error', code: 'server_error' });
  }
}

function getConfiguredScanSpreadsheet() {
  const spreadsheetId = PropertiesService
    .getScriptProperties()
    .getProperty('SCAN_SPREADSHEET_ID');
  if (!/^[A-Za-z0-9_-]{20,}$/.test(spreadsheetId || '')) {
    throw new Error('Scanner workbook is not configured. Run setup first.');
  }
  return SpreadsheetApp.openById(spreadsheetId);
}
```

Implement the referenced helpers with fixed-header checks, SHA-256 lowercase
hex encoding, exact boolean/string `TRUE` handling, full-cell UUID membership,
and full participant/UUID duplicate comparison. `parsePostParameters` accepts
only `e.parameter` values supplied by the URL-encoded POST. `setup()` creates
missing tabs and headers only when run manually; a public request never creates
or repairs configuration.

- [ ] **Step 4: Run the backend tests to verify they pass**

Run:

```powershell
node tests/code_test.js
```

Expected: `Code.gs authorization tests passed` with exit code 0.

- [ ] **Step 5: Commit the receiver**

```powershell
git add -- Code.gs tests/code_test.js
git commit -m "security: authorize scan ingestion"
```

### Task 2: Generate and rotate participant links with TDD

**Files:**
- Create: `ParticipantLinks.gs`
- Create: `tests/participant_links_test.js`

- [ ] **Step 1: Write failing participant-link tests**

Load `Code.gs` and `ParticipantLinks.gs` into a VM context with deterministic
`Utilities.getUuid()` values and a fake active range. Cover this sequence:

```javascript
context.generateParticipantUrls();

assert.match(participantRows[1][2], /^[a-f0-9]{64}$/);
assert.equal(participantRows[1][3], true);
assert.match(
  participantRows[1][4],
  /^https:\/\/givi-guntsadze\.github\.io\/edufair-lead-scanner\/\?uni=constructor#token=[a-f0-9]{64}$/
);

const originalRow = [...participantRows[1]];
context.generateParticipantUrls();
assert.deepStrictEqual(participantRows[1], originalRow);

context.rotateSelectedParticipantUrl();
assert.notEqual(participantRows[1][2], originalRow[2]);
assert.notEqual(participantRows[1][4], originalRow[4]);
```

Also reject missing names, unsafe/formula-prefixed IDs, duplicate participant
IDs, a selected header row, a selection on another tab, and a non-HTTPS scanner
base URL. Verify that neither function writes a plaintext token outside the
`Scanner_URL` cell.

- [ ] **Step 2: Run the generator test to verify it fails**

Run:

```powershell
node tests/participant_links_test.js
```

Expected: FAIL because `ParticipantLinks.gs` and its functions do not exist.

- [ ] **Step 3: Implement organizer-only link administration**

Create `ParticipantLinks.gs` with this public administrative surface:

```javascript
const SCANNER_BASE_URL = 'https://givi-guntsadze.github.io/edufair-lead-scanner/';

function generateParticipantUrls() {
  const sheet = requireParticipantAdminSheet();
  validateHttpsScannerBaseUrl();
  const rows = getParticipantRows(sheet);
  assertUniqueParticipantIds(rows);

  rows.forEach(function(row) {
    if (!row.name && !row.id && !row.hash && !row.url) return;
    validateParticipantAdminRow(row);
    if (row.hash || row.url) return;
    writeParticipantCredential(sheet, row.rowNumber, createParticipantCredential(row.id));
  });
}

function rotateSelectedParticipantUrl() {
  const sheet = requireParticipantAdminSheet();
  const range = sheet.getActiveRange();
  if (!range || range.getRow() < 2 || range.getNumRows() !== 1) {
    throw new Error('Select exactly one participant row before rotating its URL.');
  }
  const row = readParticipantRow(sheet, range.getRow());
  validateParticipantAdminRow(row);
  writeParticipantCredential(sheet, row.rowNumber, createParticipantCredential(row.id));
}

function createParticipantCredential(participantId) {
  const token = (Utilities.getUuid() + Utilities.getUuid())
    .replace(/-/g, '')
    .toLowerCase();
  return {
    hash: hashToken(token),
    active: true,
    url: SCANNER_BASE_URL + '?uni=' + encodeURIComponent(participantId) +
      '#token=' + encodeURIComponent(token)
  };
}
```

Use range writes only for `Token_Hash`, `Active`, and `Scanner_URL`. Never
overwrite `Participant_Name` or `Participant_ID`. Generation skips entirely
blank rows and never rotates an existing row implicitly.

- [ ] **Step 4: Run generator and backend regressions**

Run:

```powershell
node tests/participant_links_test.js
node tests/code_test.js
```

Expected: both commands exit 0 and print their success messages.

- [ ] **Step 5: Commit participant link administration**

```powershell
git add -- ParticipantLinks.gs tests/participant_links_test.js
git commit -m "feat: generate authorized participant links"
```

### Task 3: Authenticate the offline scanner with TDD

**Files:**
- Modify: `tests/index_test.js`
- Modify: `index.html`

- [ ] **Step 1: Extend the browser harness and write failing token-flow tests**

Give the fake window both `location.search` and `location.hash`, record fetch
calls, and allow queued mock responses. Add tests proving:

```javascript
test('does not start without a token', () => {
  assert.throws(
    () => createHarness({ search: '?uni=constructor', hash: '' }),
    /Invalid participant link/
  );
});

test('posts the participant credential without putting it in the URL', async () => {
  const harness = createHarness({
    search: '?uni=constructor',
    hash: `#token=${VALID_TOKEN}`,
    online: true,
    fetchResponses: [{ result: 'success', duplicate: false }]
  });
  harness.context.onScanSuccess('A1B2C3D4');
  await harness.flushPromises();

  assert.equal(harness.fetchCalls[0].url, API_URL);
  assert.equal(harness.fetchCalls[0].options.method, 'POST');
  assert.doesNotMatch(harness.fetchCalls[0].url, new RegExp(VALID_TOKEN));
  const body = new URLSearchParams(harness.fetchCalls[0].options.body);
  assert.equal(body.get('participant_id'), 'constructor');
  assert.equal(body.get('token'), VALID_TOKEN);
  assert.equal(body.get('uuid'), 'A1B2C3D4');
});
```

Add separate tests for duplicate success, unauthorized and invalid-ticket
rejection without retry, network/server-busy retention as pending, safe token
non-rendering, offline persistence across a new harness, and the unconfigured
API sentinel preventing camera startup.

- [ ] **Step 2: Run the frontend tests to verify they fail**

Run:

```powershell
node --test tests/index_test.js
```

Expected: FAIL because the current page accepts tokenless links, sends GET
requests, and has no rejected state.

- [ ] **Step 3: Implement the authenticated scanner flow**

Set the deployment sentinel and token parser:

```javascript
const UNCONFIGURED_API_URL = 'UNCONFIGURED_FAIR_SCAN_WEB_APP_URL';
const API_URL = UNCONFIGURED_API_URL;
const TOKEN_PATTERN = /^[a-f0-9]{64}$/;

const urlParams = new URLSearchParams(window.location.search);
const fragmentParams = new URLSearchParams(window.location.hash.slice(1));
const UNI_ID = urlParams.get('uni');
const PARTICIPANT_TOKEN = fragmentParams.get('token');

if (!isValidUniversityId(UNI_ID) ||
    !TOKEN_PATTERN.test(PARTICIPANT_TOKEN || '') ||
    API_URL === UNCONFIGURED_API_URL) {
  renderConfigurationError();
  throw new Error('Invalid participant link or scanner deployment configuration');
}
```

Queue each scan with `participantId`, `token`, `uuid`, timestamp, and one of
`pending`, `synced`, or `rejected`. Replace GET synchronization with:

```javascript
const body = new URLSearchParams({
  participant_id: scan.participantId,
  token: scan.token,
  uuid: scan.uuid,
  timestamp: scan.timestamp
});

const response = await fetch(API_URL, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
  body: body.toString(),
  redirect: 'follow'
});
const result = await response.json();
```

Treat `success` including duplicates as synced. Treat `unauthorized`,
`invalid_request`, and `invalid_ticket` as rejected. Keep `server_busy`,
`server_error`, malformed responses, HTTP failures, and network errors pending.
Build all scan-list content with `createElement` and `textContent`; never place
the token in text, logs, element IDs, or request URLs.

- [ ] **Step 4: Run frontend and backend tests**

Run:

```powershell
node --test tests/index_test.js
node tests/code_test.js
node tests/participant_links_test.js
```

Expected: all commands exit 0.

- [ ] **Step 5: Commit the scanner client**

```powershell
git add -- index.html tests/index_test.js
git commit -m "security: authenticate offline scan sync"
```

### Task 4: Document the exact deployment and operational workflow

**Files:**
- Modify: `README.md`
- Modify: `TESTING.md`

- [ ] **Step 1: Replace the old single-workbook and GET-link instructions**

Document these exact operational facts:

```text
Registration workbook: Registrations (PII, n8n full-row destination)
fair-scan-file: Raw_Scans, participant_url, valid_tickets (PII-free)
n8n ordering: Registrations -> valid_tickets -> confirmation email
Raw_Scans headers: Timestamp, Uni_ID, UUID
participant_url headers: Participant_Name, Participant_ID, Token_Hash, Active, Scanner_URL
valid_tickets header: UUID
```

Explain how to paste `Code.gs` and `ParticipantLinks.gs` into the bound Apps
Script project, run `generateParticipantUrls`, deploy a new web app as the owner
with access set to anyone, replace `UNCONFIGURED_FAIR_SCAN_WEB_APP_URL` in
`index.html`, and publish the scanner frontend. State that the old registration
workbook deployment must not be reused.

- [ ] **Step 2: Document automated and manual verification**

Add the exact Node commands and a manual matrix for: valid scan, invalid UUID,
duplicate, inactive link, rotated link, mismatched `uni`, offline queue, later
sync, and confirmation that no token is present in the Apps Script request URL.
Retain the two-CSV `process_leads.py` instructions unchanged.

- [ ] **Step 3: Check documentation consistency and formatting**

Run:

```powershell
rg -n "HARVARD|YALE|New deployment.*update the URL|Registration Sheet.*Raw_Scans|method: 'GET'" README.md TESTING.md Code.gs index.html
git diff --check
```

Expected: no obsolete example or GET-write instruction, and `git diff --check`
exits 0.

- [ ] **Step 4: Commit the documentation**

```powershell
git add -- README.md TESTING.md
git commit -m "docs: describe isolated scan deployment"
```

### Task 5: Run final security verification and prepare deployment handoff

**Files:**
- Verify all changed files
- Do not modify `scripts/process_leads.py`

- [ ] **Step 1: Run the complete automated suite**

```powershell
node tests/code_test.js
node tests/participant_links_test.js
node --test tests/index_test.js
python -m py_compile scripts/process_leads.py
```

Expected: all three JavaScript suites pass and Python compilation exits 0.

- [ ] **Step 2: Run static security and secret checks**

```powershell
rg -n "appendRow|doGet|doPost|innerHTML|API_URL|token|Token_Hash|SpreadsheetApp\.open" Code.gs ParticipantLinks.gs index.html
rg -n "AKfy|script\.google\.com/macros/s/.+/exec" . --glob '!docs/superpowers/specs/**' --glob '!docs/superpowers/plans/**'
git diff --check
```

Expected: only `doPost` reaches `appendRow` for scans, no registration-workbook
deployment URL or ID remains, the single `SpreadsheetApp.openById` call reads
the ID recorded by `setup` from Script Properties, the token is never rendered
or placed in a request URL, and whitespace checks pass.

- [ ] **Step 3: Review the complete branch diff**

```powershell
git diff origin/main...HEAD --stat
git diff origin/main...HEAD -- Code.gs ParticipantLinks.gs index.html tests README.md TESTING.md
git status --short --branch
```

Expected: only the approved scanner authorization, tests, and documentation are
present; `scripts/process_leads.py` is unchanged; no unrelated user changes are
staged.

- [ ] **Step 4: Push validated commits to the existing branch**

```powershell
git push origin codex/fix-public-scan-writes-formula-injection-vulnerability
```

Expected: the remote branch and draft pull request advance while `main` remains
unchanged.

- [ ] **Step 5: Complete deployment after the new Apps Script URL exists**

The organizer creates the versioned web-app deployment from the Apps Script
project bound to `fair-scan-file` and supplies its `/exec` URL. Replace the
sentinel in `index.html`, rerun Task 5 Steps 1-3, commit the one-line URL change,
push it to the same branch, and perform the manual phone matrix from
`TESTING.md`. Do not mark the security branch ready to merge until this deployed
integration passes.
