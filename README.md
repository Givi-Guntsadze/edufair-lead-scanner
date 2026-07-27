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
|-- email-templates/confirmation-email.html
`-- wordpress/ticket-id-generator.php
```

## 1. Registration Workbook and n8n

The original restricted Google Sheets file contains only the `Registrations`
tab and the full registration data, including each eight-character UUID.

For each completed registration, the n8n workflow must perform these operations
in order:

1. Generate the UUID.
2. Append the full registration to `Registrations`.
3. Append that same UUID, with no PII, to `fair-scan-file` -> `valid_tickets`.
4. Send the confirmation email and QR code only after both writes succeed.

The n8n Google Sheets node for `valid_tickets` maps the generated identifier to
the `UUID` column.

## 2. Scanner Workbook

The restricted `fair-scan-file` Google Sheets file uses these exact,
case-sensitive tab names and headers:

### `Raw_Scans`

| Timestamp | Uni_ID | UUID |
| --- | --- | --- |

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

Validated changes are developed on the security branch and must not be merged
to `main` until the automated tests, new Apps Script deployment, and manual phone
matrix in `TESTING.md` pass.

## 7. Event-Day Behavior

A participant opens their generated `Scanner_URL`. The public participant ID is
used for display, while the token in the URL fragment authorizes synchronization.

- Valid scans are queued locally and sync when online.
- The token is sent in a POST body, not in the Apps Script request URL.
- Apps Script derives the trusted `Uni_ID` from the token.
- The UUID must exist in `valid_tickets`.
- A repeated `Uni_ID + UUID` pair is treated as a successful duplicate and is
  not appended again.
- Invalid participant links or tickets are marked rejected rather than retried
  forever.
- Network and temporary server failures remain pending for automatic retry.

`Raw_Scans` contains only `Timestamp`, `Uni_ID`, and `UUID`.

## 8. Post-Event Processing

The existing Python processor is unchanged.

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
`valid_tickets` are not Python inputs.

## Automated Tests

Run from the repository root:

```powershell
node tests/code_test.js
node tests/participant_links_test.js
node --test tests/index_test.js
python -m py_compile scripts/process_leads.py
```

See `TESTING.md` for the deployment and phone verification matrix.
