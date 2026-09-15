# EduFair Scanner Verification

The automated suites validate local behavior. A real Apps Script deployment and
phone test are still required before the security branch is ready to merge.

## Automated Verification

Run from the repository root:

```powershell
node tests/code_test.js
node tests/participant_links_test.js
node --test tests/index_test.js
node --test tests/email_template_test.js
node tests/campus_config_test.js
python -m py_compile scripts/process_leads.py
python -X utf8 tests/process_leads_test.py
git diff --check
```

Expected results:

- `Code.gs authorization tests passed`
- `Participant link generation tests passed`
- twenty-nine passing frontend subtests
- four passing confirmation-email escaping subtests
- `Campus configuration parity tests passed`
- Python compilation exits with code 0
- seven passing `process_leads_test.py` cases
- `git diff --check` produces no errors

The suites cover token and UUID validation, inactive links, participant-ID
substitution, duplicate idempotency, formula injection, safe DOM rendering,
POST-body synchronization, offline persistence, rejected scans, and transient
retry behavior.

## Apps Script Pre-deployment Check

1. Confirm the Apps Script project is opened from `fair-scan-file`, not the
   registration workbook.
2. Confirm it contains the current `Code.gs` and `ParticipantLinks.gs`.
3. Run `setup` and verify these exact tabs and header rows:
   - `Raw_Scans`: `Timestamp`, `Uni_ID`, `UUID`
   - `participant_url`: `Participant_Name`, `Participant_ID`, `Token_Hash`,
     `Active`, `Scanner_URL`
   - `valid_tickets`: `UUID`
4. Add a temporary participant name and ID, run `generateParticipantUrls`, and
   verify that a 64-character hash and complete URL appear.
5. Run `generateParticipantUrls` again and verify the existing URL is unchanged.
6. Select that row, run `rotateSelectedParticipantUrl`, and verify the URL and
   hash both change while the name and ID stay unchanged.

## New Web App Deployment

1. Select **Deploy -> New deployment -> Web app**.
2. Use **Execute as: Me** and **Access: Anyone**.
3. Deploy and copy the new `/exec` URL.
4. Replace `const API_URL = UNCONFIGURED_API_URL;` in `index.html` with that URL.
5. Rerun all automated verification commands.
6. Commit and push the URL change to the same security branch.

Opening the `/exec` URL directly sends GET and should return:

```json
{"result":"error","code":"method_not_allowed"}
```

It must not create a row in `Raw_Scans`.

## Campus Intent Capture — Production Migration and Deployment

This feature was implemented and automated-tested entirely on
`feature/campus-intent-capture`. Nothing below has been run against the live
workbook or the production Apps Script deployment. Follow this exact order
when it is time to roll it out:

1. **Add the header only.** From the Apps Script editor bound to
   `fair-scan-file`, run `migrateRawScansAddCampusColumn()` once. It adds
   `Campus` as column D's header and does not touch any existing header cell
   or row. Running it again is a no-op.
2. **Keep the current production Apps Script running.** Do not deploy the
   new `Code.gs` yet.
3. **Verify current production scans still append normally** with column D
   blank — scan a real or test QR and confirm the existing three-column
   behavior is unaffected by the new header.
4. **Only then deploy the new Apps Script version** (this branch's
   `Code.gs` and `ParticipantLinks.gs`) via **Deploy -> Manage deployments**,
   selecting a new version on the existing deployment so the `/exec` URL is
   preserved.
5. **Verify the new server version** with the campus-aware phone matrix
   below, using test UUIDs only.
6. **Only after server verification, publish the new scanner frontend**
   (this branch's `index.html`) to GitHub Pages from `main`, after this
   branch has been reviewed and merged.

Because the new `Code.gs` requires all four `Raw_Scans` headers
(`Timestamp`, `Uni_ID`, `UUID`, `Campus`), deploying it before step 1 will
fail closed (`server_error`) rather than silently miswrite data.

## Manual Branch Testing (before merge)

Do this on the feature branch, without touching production:

- Serve `index.html` locally or via Codespaces (not production GitHub
  Pages).
- Point it at a non-production Apps Script deployment/version, or an
  isolated test copy of `fair-scan-file`, not the live workbook.
- Use test UUIDs only — no registration PII.

Matrix:

1. A non-configured Participant_ID gets the unchanged fast scanner (no
   selector, immediate scan).
2. A campus-enabled Participant_ID (e.g. `ieu`) shows the selector before
   scanning.
3. Each campus button for that institution.
4. The `Undecided` option.
5. Offline scanning with a campus selected.
6. Multiple offline visitors in a row with different campus choices.
7. Reconnect and sync; confirm each synced row carries its own campus.
8. A duplicate visitor (same UUID scanned twice) — no second row, campus
   reset before the next visitor.
9. An invalid/unknown UUID — rejected, and the selected campus is retained
   for an immediate retry.
10. A modified `?uni=` value with the original token — still unauthorized.
11. An invalid campus payload (tamper the request) — rejected as
    `invalid_campus`, no row written.
12. An inactive participant — still rejected.
13. Token rotation still invalidates the old link and activates the new one.
14. The generated `leads_<Uni_ID>.csv` contains the correct `Campus` value
    per row.
15. A legacy `raw_scans.csv` (no `Campus` column) still processes correctly.

## Live Phone Matrix

Use a generated participant URL and a test UUID already present in
`valid_tickets`.

| Scenario | Expected result |
| --- | --- |
| Valid participant link + valid UUID | One row appears in `Raw_Scans`; client turns green |
| Scan the same UUID again | No second row; client treats duplicate as synchronized |
| Eight-character UUID absent from `valid_tickets` | No row; client turns red/rejected |
| Change `?uni=` while keeping the token | No row; request is unauthorized/rejected |
| Set participant `Active` to `FALSE` | Existing URL is rejected |
| Rotate the selected participant URL | Old URL is rejected; new URL succeeds |
| Disable network and scan a valid UUID | Yellow pending item remains locally |
| Restore network | Pending item syncs once and turns green |
| Temporary server/network failure | Item remains pending and retries later |

## Browser Network Inspection

For one valid synchronization, inspect the browser's Network panel:

- Method is `POST`.
- Request URL is exactly the configured Apps Script `/exec` URL.
- The participant token is absent from the request URL.
- The URL-encoded request body contains `participant_id`, `token`, `uuid`, and
  `timestamp`.
- The response is `{ "result": "success", ... }`.
- The browser console does not contain the token.

## Sheet and Privacy Check

After the live matrix:

- `Raw_Scans` contains only timestamp, participant ID, UUID, and (optionally)
  a validated Campus value — never free text.
- `valid_tickets` contains UUIDs only.
- `participant_url` contains no registration PII.
- The Apps Script code contains no registration workbook ID or `openByUrl` call.
- Its single `openById` call receives only the `SCAN_SPREADSHEET_ID` recorded by
  `setup` from the bound `fair-scan-file` project.
- After the new deployment succeeds, the old registration-workbook web-app
  deployment is archived through **Deploy -> Manage deployments -> Archive**.
  Deleting only its current script source is not treated as disabling the old
  versioned deployment.

## Post-event Smoke Test

Export:

- `registrations.csv` from the private registration workbook; and
- `raw_scans.csv` from `fair-scan-file` -> `Raw_Scans`.

Run:

```powershell
python scripts/process_leads.py registrations.csv raw_scans.csv
```

Verify that each `reports/leads_<Uni_ID>.csv` contains only registrations whose
UUID was scanned for that participant. The reporting script does not receive
participant tokens or the `valid_tickets` export.

The participant report columns must include `Name`, `Last Name`, `Email`,
`Phone`, `Which programs?`, `Age`, `Intake Year`, `Country`, `Additional Info`,
and `Consent`, with `Which Fair` between `Country` and `Additional Info`.
Registrations from Tbilisi and Batumi scanned for the same institution must
remain in one institution CSV so the recipient can filter by city.

When `raw_scans.csv` includes a `Campus` column, the report must also include
`Campus` with the value recorded for that scan (including `Undecided`).
A legacy `raw_scans.csv` without that column must continue producing reports
without a `Campus` column, exactly as before.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Configuration Error before camera starts | Confirm the new `/exec` URL replaced the API sentinel and use a generated participant URL |
| Every scan is rejected as unauthorized | Confirm `Token_Hash`, `Active`, and `Scanner_URL` are from the same participant row |
| Valid QR is rejected | Confirm n8n wrote the exact uppercase eight-character UUID to `valid_tickets` |
| Item stays pending | Check connectivity, Apps Script executions, deployment access, and POST response |
| `server_error` response | Verify all three exact tab names and header rows |
| Old link still works after rotation | Confirm the latest Apps Script version is deployed and the old hash was replaced |
