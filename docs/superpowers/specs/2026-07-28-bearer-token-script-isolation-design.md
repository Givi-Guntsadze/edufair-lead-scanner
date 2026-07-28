# Bearer Token Script Isolation Design

## Goal

Prevent remotely hosted JavaScript from executing in the scanner page origin
and reading participant bearer tokens, while preserving the scanner's existing
cross-browser and offline behavior.

## Context

Participant credentials arrive in the URL fragment and remain in browser memory
or the offline queue until a pending scan synchronizes. Any script running in
the page origin can read those values or intercept the credential-bearing POST.
The current production page loads `html5-qrcode` 2.3.8 from `unpkg.com`, so the
CDN response is part of the application's credential boundary.

The draft branch replaces that dependency with a small `BarcodeDetector` shim.
That removes the remote execution path, but `BarcodeDetector` has limited
browser availability and is documented as a progressive enhancement rather
than a complete decoder. A detector-only implementation would disable scanning
on supported phones whose browser does not expose the API, notably iOS Safari.

## Considered Approaches

1. Add Subresource Integrity to the remote script. This pins the response, but
   retains a runtime CDN and network dependency for a credential-bearing page.
2. Maintain a custom `BarcodeDetector` implementation plus a fallback decoder.
   This duplicates scanner-library behavior and creates a new maintenance and
   compatibility surface.
3. Vendor the exact upstream `html5-qrcode` 2.3.8 release artifact. This keeps
   the previously deployed scanner interface and cross-browser fallback while
   serving executable code only from the application origin.

Approach 3 is selected because it makes the smallest functional change and
directly removes the identified supply-chain exposure.

## Design

- Store the unmodified upstream `html5-qrcode.min.js` v2.3.8 release asset under
  `vendor/` and reference it with a relative same-origin URL.
- Pin the vendored artifact in the frontend regression suite with its SHA-256
  digest so accidental or unreviewed replacement fails verification.
- Include the upstream Apache-2.0 license and a short provenance notice.
- Keep the existing `Html5Qrcode` construction and `start()` call unchanged.
- Keep bearer-token parsing, offline queueing, POST synchronization, and server
  authorization unchanged.

## Error Handling

The existing page-level camera error handler remains authoritative. Library,
permission, or camera failures reject `start()` and display the existing static
camera-access message without rendering attacker-controlled values.

## Verification

- Prove the regression test fails against the detector-only branch.
- Verify the HTML loads only same-origin scripts.
- Verify the vendored file's exact SHA-256 digest and license provenance.
- Run the frontend, Apps Script, participant-link, Python syntax, JavaScript
  syntax, and whitespace checks.
- Preserve the manual phone matrix in `TESTING.md`; no deployment or merge is
  part of this branch-completion task.
