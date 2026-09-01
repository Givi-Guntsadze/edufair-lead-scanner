# Which Fair Report Column Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Include each registration's `Which Fair` value in the single institution-specific CSV produced after UUID matching.

**Architecture:** Keep the scanner and Sheets boundaries unchanged. Extend only the post-event processor's explicit export allowlist, prove the behavior with a two-city regression test, and align the operator documentation.

**Tech Stack:** Python 3, pandas, unittest, Markdown documentation

---

### Task 1: Add the two-city report regression

**Files:**
- Modify: `tests/process_leads_test.py`

- [x] **Step 1: Write the failing test**

Add a test that creates two registration rows with the same scanned
institution, one `Tbilisi` and one `Batumi`, runs the real processing functions,
and asserts that exactly one report contains both rows and a `Which Fair`
column between `Country` and `Additional Info`.

- [x] **Step 2: Run the targeted test to verify it fails**

Run:

```powershell
python -X utf8 -m unittest tests.process_leads_test.ProcessLeadsTest.test_report_includes_which_fair_for_both_cities
```

Expected: failure because `Which Fair` is absent from the generated report.

### Task 2: Add the approved report field

**Files:**
- Modify: `scripts/process_leads.py`
- Test: `tests/process_leads_test.py`

- [x] **Step 1: Add the minimal implementation**

Insert the exact field name into `priority_columns`:

```python
'Which programs?', 'Age', 'Intake Year', 'Country',
'Which Fair', 'Additional Info', 'Consent',
```

- [x] **Step 2: Run the targeted test to verify it passes**

Run:

```powershell
python -X utf8 -m unittest tests.process_leads_test.ProcessLeadsTest.test_report_includes_which_fair_for_both_cities
```

Expected: one passing test.

- [x] **Step 3: Run the complete processor test file**

Run:

```powershell
python -X utf8 tests/process_leads_test.py
```

Expected: all processor tests pass.

### Task 3: Align operator documentation

**Files:**
- Modify: `README.md`
- Modify: `TESTING.md`

- [x] **Step 1: Update documented schemas**

Add `Which Fair` after `Country` and before `Additional Info` in the documented
registration-export and institution-report column lists. State that reports
remain one CSV per institution and recipients can filter the column by city.

- [x] **Step 2: Check documentation and whitespace**

Run:

```powershell
rg -n "Which Fair" README.md TESTING.md scripts/process_leads.py tests/process_leads_test.py
git diff --check
```

Expected: the field appears in code, regression coverage, and both operator
documents; no whitespace errors are reported.

### Task 4: Verify the repository result

**Files:**
- Verify: `scripts/process_leads.py`
- Verify: `tests/process_leads_test.py`
- Verify: `README.md`
- Verify: `TESTING.md`

- [x] **Step 1: Run all repository tests**

Run:

```powershell
node tests/code_test.js
node tests/participant_links_test.js
node --test tests/index_test.js
node --test tests/email_template_test.js
python -X utf8 tests/process_leads_test.py
python -m py_compile scripts/process_leads.py
```

Expected: every suite passes with zero failures.

- [x] **Step 2: Inspect the final diff and worktree**

Run:

```powershell
git diff --check
git diff -- scripts/process_leads.py tests/process_leads_test.py README.md TESTING.md
git status --short --branch
```

Expected: only the planned code, test, documentation, and plan files differ;
the scanner application files remain unchanged.
