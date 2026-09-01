# EduFair Lead Scanner Context

Updated: 2026-09-01

## Current State

The post-event reporting workflow supports the registration field `Which Fair`.
After `registrations.csv` is matched to `raw_scans.csv` by `UUID`, every
institution-specific report includes the registrant's fair location. Reports
remain one CSV per institution; recipients can filter the `Which Fair` column
to separate Tbilisi and Batumi attendees.

The public scanner workflow is unchanged. `Code.gs`, `ParticipantLinks.gs`, and
`index.html` do not need redeployment for this reporting-only change.

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
