# EduFair Lead Scanner Context

Updated: 2026-09-16

## Current State

The post-event reporting workflow supports the registration field `Which Fair`.
After `registrations.csv` is matched to `raw_scans.csv` by `UUID`, every
institution-specific report includes the registrant's fair location. Reports
remain one CSV per institution; recipients can filter the `Which Fair` column
to separate Tbilisi and Batumi attendees.

Campus Intent Capture (merged from `feature/campus-intent-capture` into
`main`, deployed to production) adds an optional campus/location selector to
the scanner for institutions with more than one campus. For those
institutions, the volunteer taps the visitor's chosen campus before
scanning; the choice is stored with that one scan and the selector
immediately resets. Institutions without configured campuses keep the
original fast, no-extra-tap flow. Campus options are a static,
offline-embedded configuration (`CAMPUS_CONFIG` in `Code.gs` and
`index.html`, kept identical by `tests/campus_config_test.js`) keyed by
`Participant_ID` — the campus reference Google Sheet is never fetched at
runtime. `Raw_Scans` was migrated in place to add the `Campus` header
(`migrateRawScansAddCampusColumn()` in `Code.gs`), the production Apps
Script was redeployed to a campus-aware version behind the same `/exec` URL,
and the new `index.html` is live on GitHub Pages. See `README.md` section 8
for the volunteer workflow and `TESTING.md` for the migration/rollout record.
The `feature/campus-intent-capture` branch is kept around, not deleted.

The scanner frontend (`index.html`) was subsequently given a visual
refresh — branded **traQRecord** (shown alongside the Participant_ID on
every screen, including the configuration-error state), restyled with a
five-color palette (wine `#5f0f40`, crimson `#9a031e`, amber `#fb8b24`,
burnt orange `#e36414`, teal `#0f4c5c`): a gradient frame around the camera
view, amber-outlined/wine-filled campus buttons, a distinctly-colored recent
scans panel, and a burnt-orange Sync Now button. This was a look-and-feel
only change — no scanning, queueing, sync, or campus-gating behavior was
touched, and the full test suite (frontend, Apps Script, participant links,
email template, Python processor) still passes unchanged.

A high-volume synchronization optimization was implemented on
`feature/high-volume-sync-optimization` and merged into `main`. **Not yet
deployed**: the live Apps Script deployment and the published GitHub Pages
`index.html` are still the pre-optimization versions until the manual
redeploy steps in `TESTING.md`'s "High-Volume Synchronization — Deployment"
section are carried out. It targets the real event-day load: 30+ participant tables
scanning simultaneously, one volunteer scanning several visitors
back-to-back, and the same visitor legitimately being scanned by multiple
institutions. `index.html` now sends pending scans in micro-batches (up to
10 per request, JSON body) with a 9-second `AbortController` timeout instead
of one unbounded request per scan, so scanning itself is never blocked on
Google Sheets. `Code.gs` adds `CacheService`-backed caching for valid-ticket
lookups, participant authentication, and duplicate detection (each with its
own documented TTL and a cache-miss that always falls back to a live sheet
read, so a cache can never authorize something the sheet doesn't actually
say is valid), narrows the script lock to a ~2-second wait around only the
final write, and writes accepted scans in one batched range write instead of
one `appendRow()` each. `Code.gs` still accepts the original single-scan
form-encoded protocol alongside the new batched one, specifically so the
frontend and backend can be redeployed independently without a deployment
ordering mistake silently rejecting every scan (the exact failure mode hit
once already with a `CAMPUS_CONFIG` update — see the `invalid_campus` row in
`TESTING.md`'s troubleshooting table). Duplicate semantics, authentication,
UUID/campus validation, and the `Raw_Scans` schema are all unchanged. See
`README.md` section 9 for the full design and `TESTING.md` for the
deployment and verification steps.

The batching design was subsequently tightened so the 10-scan batch size is
purely a transport limit, never a cap on how many scans can be queued or
eventually accepted. `sync()` now loops, sending consecutive 10-scan
requests back-to-back with no wait and no volunteer action in between, until
the entire pending queue is drained (12 scans send as 10 then 2, 100 as ten
requests of 10, and so on) or a batch comes back with any transient outcome,
at which point the drain stops early and whatever is left pending is picked
up automatically on the next retry tick — never lost, only delayed.
`Code.gs` now rejects (rather than silently truncates) a single request that
somehow arrives with more than 10 scans, since the official frontend never
sends one and a truncation would otherwise drop scans with no result
returned for them at all.

Outside of that pending deployment, the public scanner workflow is unchanged.
`Code.gs`, `ParticipantLinks.gs`, and `index.html` do not need redeployment
for the `Which Fair` reporting-only change described below.

## Data Flow

1. The registration form sends the complete registration payload, including
   `Which Fair`, to n8n.
2. n8n appends the full record to the private registration workbook and appends
   only the generated `UUID` to `fair-scan-file` -> `valid_tickets`.
3. Authorized participant scanner links write accepted scans to `Raw_Scans` as
   `Timestamp`, `Uni_ID`, and `UUID`.
4. After the event, organizers export the registration tab as
   `registrations.csv` and `Raw_Scans` as `raw_scans.csv`.
5. `scripts/process_leads.py` joins the exports by `UUID` and creates one
   `reports/leads_<Uni_ID>.csv` per institution.

## Approved Institution Report Fields

The explicit report allowlist includes:

`Name`, `Last Name`, `Email`, `Phone`, `Which programs?`, `Age`, `Intake Year`,
`Country`, `Which Fair`, `Additional Info`, and `Consent`.

Keeping an explicit allowlist prevents future internal registration columns
from being disclosed automatically.

## Verification

- The live registration header was verified to contain the exact field name
  `Which Fair` between `Country` and `Additional Info`.
- The regression test covers one Tbilisi and one Batumi registration scanned
  for the same institution.
- The test verifies one institution CSV, both rows, exact city values, and the
  expected column position.
- All Apps Script, participant-link, scanner-client, email-template, and Python
  processor tests pass.

## Operator Action

When generating reports, export a fresh `registrations.csv` that includes the
`Which Fair` header. Older local exports without that column remain compatible,
but their generated reports cannot contain a fair location.
