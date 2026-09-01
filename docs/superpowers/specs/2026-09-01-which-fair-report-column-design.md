# Which Fair Participant Report Column

## Goal

Include the registration field `Which Fair` in every institution-specific lead
CSV generated after the event. Each institution continues to receive one CSV
and can filter its rows by city.

## Current State

The private registration workbook's `Registrations` tab contains the exact
header `Which Fair` between `Country` and `Additional Info`. The registration
CSV is joined to `raw_scans.csv` by `UUID`, but `scripts/process_leads.py`
exports only an explicit approved set of registration columns. `Which Fair` is
not yet in that set.

## Design

Add only `Which Fair` to the existing explicit `priority_columns` list in
`scripts/process_leads.py`, positioned after `Country` and before
`Additional Info`.

The output remains one file per institution:

```text
reports/leads_<Uni_ID>.csv
```

The processor will preserve the registration values exactly as supplied, such
as `Tbilisi` and `Batumi`. It will not create separate files by fair or city.

## Data Boundaries

No scanner-side schema or public endpoint changes are required:

- The registration workbook keeps the full registration record, including
  `Which Fair`.
- n8n continues copying only the generated `UUID` to `valid_tickets`.
- `Raw_Scans` remains limited to `Timestamp`, `Uni_ID`, and `UUID`.
- `Code.gs`, `ParticipantLinks.gs`, and `index.html` remain unchanged.

This keeps fair attendance information in the private registration workflow
until the organizer generates institution reports.

## Error Handling and Compatibility

The existing report behavior remains unchanged when `Which Fair` is absent:
the processor exports only approved columns that are present in the input.
Older registration rows with a blank fair value remain blank in the generated
report.

The explicit allowlist remains in place so future internal registration fields
are not sent to institutions automatically.

## Verification

Add a regression test with two registrations, one for `Tbilisi` and one for
`Batumi`, both scanned for the same institution. Verify that:

1. exactly one institution CSV is generated;
2. the CSV contains both registrations;
3. `Which Fair` appears after `Country` and before `Additional Info`;
4. the two city values are preserved exactly; and
5. the existing approved columns remain present and ordered as before.

Then run the complete repository test suite, Python compilation, and a direct
inspection of the generated CSV.

## Documentation

Update `README.md` and `TESTING.md` so the documented registration and
participant-report schemas include `Which Fair` in the same position.
