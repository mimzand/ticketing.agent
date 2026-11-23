# Golden eval and override feedback

`@ticket/eval` measures the classifier on a fixed set of tickets and turns operator
overrides into review material. It runs the real host path (`createAgentHost`, the
host rules, SQLite in a temporary folder) against a fake Ollama that lives in the same
process: no socket is opened and the company server is never called. Nothing in this
package trains a model or changes a department.

## Run it

```sh
yarn eval                              # every file in packages/eval/golden
yarn eval eval-out/override-cases.json # plus extra suite files (paths from the repo root)
```

The command prints a short summary and exits 1 when any case fails (0 when all pass).
`yarn test` runs the same suite too, so CI fails on a broken golden.

## The suite files

`packages/eval/golden/*.json`, one suite per file, validated by `SuiteFileSchema`
(`packages/eval/src/suite.ts`). The checked-in files are synthetic: use invented
subjects and bodies, and only `@example.com` (or `.org` / `.net`) addresses.

```jsonc
{
  "formatVersion": 1,
  "suite": "golden",
  "threshold": 0.7,                       // CLASSIFY_MIN_CONFIDENCE for this file
  "catalogues": {                          // the department catalogue(s) the cases use
    "default": [{ "id": "billing", "name": "Billing", "description": "…",
                  "active": true, "aliases": [], "examples": [] }]
  },
  "cases": [ /* see below */ ]
}
```

### Add a golden case

Append an object to `cases` in `golden/golden.json` (or start a new file in `golden/`):

```jsonc
{
  "id": "billing-invoice",               // unique in the file: lowercase, digits, . _ -
  "source": "golden",                    // hand-written ("override" is for generated cases)
  "description": "A wrong invoice amount goes to billing.",
  "catalogue": "default",                // a key of "catalogues"
  "ticket": { "externalId": "g-001", "subject": "…", "body": "…", "channel": "email" },
  "reply": { "kind": "scripted",
             "output": { "departmentId": "billing", "confidence": 0.92,
                         "rationale": "…", "quote": "…" } },
  "expect": { "status": "labeled", "departmentId": "billing",
              "confidence": "above",     // optional: above/below the threshold
              "quote": "…" }             // optional: the stored quote, or null
}
```

- `reply` is what the fake Ollama answers:
  - `scripted` sends `output` as JSON. It may break the schema on purpose.
  - `recorded` sends `content` exactly as a real model returned it, with optional `model` and `recordedAt`. To measure a model, replace scripted replies with recorded ones; the rest of the case stays the same.
  - `error` answers an HTTP status, so the decision is `failed`.
- `expect.status` is `labeled`, `needs_review`, or `failed`. `departmentId` is set exactly when the status is `labeled`, and it must be active in the catalogue. Classify never yields `overridden`.
- `history` (optional): up to 5 earlier tickets from the same sender. Each has `ticket`, `reply`, and an optional `override` department id. They are classified (and overridden) first, so the case ticket sees them as sender memory. History tickets and the case ticket all need the same `email`.
- `wrongReply` (optional): a counter-check. With this reply instead, the expectation must *not* hold. Otherwise the case fails, because it could not catch that answer.

Each case runs in a fresh database: the catalogue is created through the host (inactive
departments are created, then deactivated), so the taxonomy version comes from the
normal host rules.

## Read the report

```text
Golden eval: 19 cases (17 golden, 2 override): 19 passed, 0 failed
Accuracy: 100.0% (19/19 applied labels match)
Mismatches: needs_review 0 · failed 0 · run errors 0
department  precision  recall  tp/fp/fn
billing        100.0%  100.0%  4/0/0
Catalogue golden/default: taxonomy v5 · sha256 6639092e432b
FAIL golden/some-case: department billing, expected it
```

- **Accuracy:** the share of cases whose applied department (the stored id when the status is `labeled`, otherwise none) equals the expected one. It counts every case that produced a decision.
- **Precision:** of the cases that applied this department, how many expected it.
- **Recall:** of the cases that expected this department, how many got it.
- `tp/fp/fn`: true positives, false positives, false negatives. A dash means there was nothing to divide by.
- **Mismatches:** `needs_review` counts cases where exactly one of expected and actual is `needs_review`; `failed` works the same way. Run errors are cases that threw before a decision was stored.
- **Catalogue:** the taxonomy version the host stored on that catalogue's decisions, and a short hash of the catalogue as written in the file. Compare these across runs before and after a model or taxonomy change.
- **FAIL:** lines give the case id and the reasons. They never include ticket text, addresses, file paths, or tokens.

## Override feedback

When an operator overrides a decision the classifier had labeled, the first override keeps
the classifier's department as `replacedDepartmentId`. Those rows are the feedback.

1. **Export** (read only, API key, same auth as the other ticket routes):

   ```sh
   mkdir -p eval-out
   curl -H "X-API-Key: $API_KEY" http://127.0.0.1:8787/v1/tickets:override-feedback > eval-out/override-feedback.json
   ```

   Over the protocol the method is `tickets.overrideFeedback`. The export holds up to 500 rows, newest first. Each row has `ticketId`, `externalId`, `subject`, `body`, `channel`, `createdAt`, `replacedDepartmentId` (the classifier's department), `departmentId` (the operator's), `status`, `confidence`, `rationale`, `quote`, and `taxonomyVersion`. Beside the rows are the current catalogue and its taxonomy version.

   The export never contains the sender email, and there is no option to include it. Rows overridden from `needs_review` or `failed` are not included, because the classifier applied no department there.

2. **Generate** the two artifacts:

   ```sh
   yarn workspace @ticket/eval run feedback eval-out/override-feedback.json   # writes to eval-out/
   ```

   - `override-cases.json`: a suite file of `source: "override"` cases. Each case expects the operator department under the exported catalogue, with `origin` pointing back to the ticket.
     - Its `reply` is a placeholder that answers the operator department, so in scripted mode it checks that the current catalogue still accepts that label. Replace it with a recorded reply to measure a model.
     - Its `wrongReply` is the classifier's stored answer, which must fail.
     - Overrides whose operator department is now inactive or deleted, or equal to the classifier's, are skipped and counted.
   - `few-shot-candidates.json`: one short example per override (`subject — body`, whitespace collapsed, anything that looks like an email replaced by `[email]`, at most 300 characters) for the operator department, with `approval: "operator"`. Examples the department already has are skipped.

3. **Review.** `eval-out/` is git-ignored because it holds real ticket text.
   - Run the cases with `yarn eval eval-out/override-cases.json`.
   - To keep a case, rewrite its ticket as synthetic text before moving it into `packages/eval/golden/`.
   - To use a few-shot candidate, an operator copies the example into the department's examples in Departments (or with `PATCH /v1/departments/{id}`).

   Nothing is written to the catalogue automatically, and no model is fine-tuned.

`packages/eval/fixtures/override-feedback.sample.json` is a synthetic export.
`golden/overrides-sample.json` and `fixtures/few-shot-candidates.sample.json` are generated
from it, and a test keeps them in step with the generator.
