# Bearer Token Script Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve a verified QR decoder from the scanner origin without breaking cross-browser scanning.

**Architecture:** Replace the detector-only shim with the unmodified upstream `html5-qrcode` 2.3.8 release asset. Pin the artifact by SHA-256 in the existing Node frontend suite and record its Apache-2.0 provenance.

**Tech Stack:** Static HTML, browser JavaScript, Node.js built-in test runner, GitHub Pages.

---

### Task 1: Add the cross-browser scanner regression

**Files:**
- Modify: `tests/index_test.js`

- [ ] **Step 1: Write the failing test**

Import `node:crypto`, require `index.html` to reference
`vendor/html5-qrcode.min.js`, reject remote script URLs, and assert that the
vendored asset hashes to
`660b12437b1d747e3e68b8be0685c08cb728140110ad213f167b14b66f8b1d8e`.

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `node --test --test-name-pattern="verified same-origin" tests/index_test.js`

Expected: FAIL because the branch still references `scanner.js`.

### Task 2: Vendor the verified release

**Files:**
- Create: `vendor/html5-qrcode.min.js`
- Create: `vendor/html5-qrcode.LICENSE`
- Create: `THIRD_PARTY_NOTICES.md`
- Modify: `index.html`
- Delete: `scanner.js`

- [ ] **Step 1: Copy the verified upstream artifacts**

Copy the unmodified v2.3.8 GitHub release asset and its Apache-2.0 license into
`vendor/`. Record the upstream tag, release URL, local path, and SHA-256 digest
in `THIRD_PARTY_NOTICES.md`.

- [ ] **Step 2: Load the vendored decoder**

Change the head script source to:

```html
<script src="vendor/html5-qrcode.min.js"></script>
```

Remove the detector-only `scanner.js` implementation.

- [ ] **Step 3: Run the focused test to verify it passes**

Run: `node --test --test-name-pattern="verified same-origin" tests/index_test.js`

Expected: PASS.

### Task 3: Verify and review the branch

**Files:**
- Modify only if review finds a validated defect.

- [ ] **Step 1: Run the complete local verification matrix**

Run:

```powershell
node tests/code_test.js
node tests/participant_links_test.js
node --test tests/index_test.js
node --check vendor/html5-qrcode.min.js
python -m py_compile scripts/process_leads.py
git diff --check main...HEAD
```

Expected: both standalone suites pass, all 15 frontend subtests pass, syntax
checks exit zero, and the diff check emits no errors.

- [ ] **Step 2: Review the final diff**

Compare the branch with `main`, verify the vendored hash independently, and
check that no remote executable script or bearer token was added to tracked
files.

- [ ] **Step 3: Commit and push**

Commit the validated implementation with a security-focused message and push
`codex/fix-bearer-scan-tokens-exposure` to `origin`. Do not merge `main`.
