# System validation

Date: 2026-10-30. Tests use isolated accounts and an isolated candidate database. Production credentials remain on the host. Real-model checks are separate from deterministic fixtures.

## Acceptance matrix

| Layer | Checks | Outcome |
| --- | --- | --- |
| Offline core | API, deployment, frontend contracts | 45/45 passed |
| Native runtime | Orchestration, app state, permissions, ownership, deadlines, evidence | 145/145 passed |
| Host integration | Complete-app execution and DSH bridge | 102/102 passed |
| DSH plugin | Worker process and transport lifecycle | 92/93 in full run; process cleanup test reported macOS `kill EPERM`; isolated runner suite subsequently passed 9/9 |
| Personal-agent lifecycle | Each of six harnesses: create, preference learning, correction, view state, revision, failure, reopen, owner isolation, later-app preference reuse | 6/6 passed |
| Official CLI compatibility | Qwen Code, Kimi Code, ZCode against local test provider; roles/order/model/Unicode, one provider call, no tools, cleanup, deadlines | 6/6 passed |
| Rich UI and GUI integration | Persisted workspaces, references, actual WebGL rendering, state save, GUI planner, personal context | 36/36 passed |
| Legacy visual interaction | Complete application visual revision and activity | 7/7 passed |
| Settings integration | Harness resolution and matching model | 7/7 passed |
| Browser controls | Desktop, mobile, 320px, keyboard viewport, long text, dropdown persistence, failure rollback, model in generation request, base prefix | Passed |
| Current-record regression | Valid actions select a real durable record; rejected actions preserve the prior selection; reopening preserves references | 3/3 passed |

Counts from different targeted suites overlap; they are not an aggregate count of unique tests. The full offline command had the process-cleanup failure recorded above; it is not described as an entirely green run.

## Real model lifecycle

Each row created a 3D room application, supplied a conditional long-term preference, saved view state, changed the default harness for future applications, revised the original app using its bound harness, and reopened the saved version. Color and position changed as requested; scale, records, identity and view state were retained. A one-time normal-font request did not remove the long-term large-font preference.

| Harness | Actual model | Outcome |
| --- | --- | --- |
| LiveUIAgent | DeepSeek-V4.1-Flash | Passed |
| Codex | gpt-6-astra | Passed |
| DSH | DeepSeek-V4.1-Flash | Passed |
| Qwen Code | Qwen3.8-Flash | Passed |
| Kimi Code | Kimi-K3 | Passed |
| ZCode | GLM-5.3-FlashX | Passed |

The first candidate run exposed a production relay that predated ordered host-message forwarding. It returned a generic startup answer instead of processing the application request. The relay prerequisite was corrected and all three new CLIs passed the real lifecycle again. A stale Codex reverse tunnel was separately repaired before the Codex lifecycle passed.

## Browser workflow and release verification

- Actual Qwen workspace: open its rendered 3D preview, submit a green-color revision in the browser, verify the persisted object, reload the gallery, and check mobile layout. Passed with no browser exceptions. The first automation clicked during the opening animation; the corrected test waits for the rendered view and stable controls before clicking.
- Native reading journal: generated forms and preview; entered a book and note; saved; restored fields through the per-item edit control; changed the note; saved and reopened. Updated content and the selected record reference persisted, and the gallery displayed the saved book.
- The native workflow also exposed intermittent empty responses from DeepSeek's independent verifier. Those attempts were recorded as failures, not successful writes. A separate selected-record defect was corrected with a persistence regression test. The representative save/edit/reopen flow passed; this does not mean every model invocation was successful.
- Failure receipt: submitted an invalid native action with a known input; verified terminal error, preserved input, actual harness and model in the account's interaction history. Passed.
- Deployment: applied 15 reviewed module/asset changes and the three CLI launch configurations, with production hash checks, private backups and idle-job checks. Existing user defaults and application data were retained; health returned `ok` and the owner's six runtime choices were available.

## Reproduce

```sh
npm run build
npm run test:offline
node --import tsx --test tests/personal-agent-lifecycle.test.ts tests/domestic-harness.test.ts tests/rich-workspaces.test.ts tests/native-main-list.test.ts
npm run test:runtime-ui
```

For an isolated real-provider acceptance run (creates test apps and preferences, consumes API tokens):

```sh
LIVEUI_TEST_REAL_MODELS=1 \
LIVEUI_TEST_BASE_URL=http://127.0.0.1:8787 \
LIVEUI_TEST_OWNER=dedicated-qa-account \
LIVEUI_TEST_HARNESSES=native,dsh,qwen,kimi,zcode \
node scripts/test-personal-agent-live.mjs
```

Include `codex` only for a test account explicitly enabled on its relay. Use a dedicated account because generated apps and memories are retained for inspection; the script restores the initial default harness/model. Browser acceptance additionally checks rendered controls and preview refresh.

The CLI tests require the runtime paths documented in [deployment instructions](../deploy/domestic-harnesses.md); without those paths, the three optional official-runtime cases skip. Fixture tests do not establish compatibility with a paid endpoint, so release acceptance also exercises the configured real models.

## Scope

This checks representative paths and error handling, not every possible generated application. Service workflows remain in the native/HTML execution paths; rich component workspaces implement visual interactions and revisions. Durable return visits are tested. Autonomous recurring background workflows are not implied by that result. See [system design](../SYSTEM_DESIGN.md).
