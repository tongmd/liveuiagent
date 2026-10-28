# Generating useful evolving applications

A request such as “compare the results in my CSV”, “connect the ideas in my notes”, or “build a spatial structure I can explore” should produce an application whose main interaction fits that task. DSH chooses the layout and writes domain controls and input parsers. The host supplies the shared lifecycle and rendering primitives.

## Data source planning

`planAppWorldServices` selects real external operations from the available service descriptions. Local uploads, local preferences and geometric construction need no external business service. Reading or changing an external account still selects its actual service. This planner does not design a second interface or icon package.

## Workspace lifecycle

`window.liveuiagent.ui.workspace` owns a generated content container. Its API separates source records/photos, preferences and local view state, and the last acknowledged generated tree.

- `setRecords` and `setPhotos` validate and save source changes before publishing them. Identical updates preserve the existing generated view.
- `setPreferences` saves explicit choices that enter subsequent generation context.
- `generate` uses the current request, actual iframe/content dimensions, available components, committed preferences, source references and prior layout. It retains the previous view and request on failure.
- Plot values, Diagram nodes/direct relationships, checklist changes and Scene3D camera controls are real local interactions. Relevant state survives reopening without invoking a model.
- `saveSnapshot`, `listSnapshots`, `restoreSnapshot` and `deleteSnapshot` expose saved layouts and interaction state. Restore requires matching source data, validates the tree and waits for a storage acknowledgement. Photos are referenced rather than duplicated in history.

New applications use this controller instead of guessing storage keys or implementing another generation/render/save framework. The controller exclusively owns its container. App-specific toolbars, file parsers and history controls live outside it. The injected `LIVEUI_UI_API.md` is the complete contract; unknown methods are not implied by related methods.

## Generated expressions

The bounded presentation tree supports ordinary content containers, record/checklist leaves, source photos and three interactive visual primitives:

| Primitive | Task | Local interaction |
| --- | --- | --- |
| Plot | Compare supplied numeric results | Select an exact point or series value |
| Diagram | Explore relationships | Select a node and its direct connections |
| Scene3D | Explore procedural spatial structure | Orbit, zoom and adjust spacing |

The model chooses an appropriate expression and composition. There is no required number of visual primitives or fixed application template. A change of focus should change the relevant structure or comparison; original source content remains available through stable references.

## Verification

The browser delivery gate drives the actual visible generation control, returns two different controlled trees, checks native SVG/WebGL output, waits for asynchronous save acknowledgement, tests failure retention and reopens a fresh iframe. Apps that require a local TXT/CSV import can declare a bounded synthetic `app.json.verificationInput`; the gate imports it through the actual file chooser in the isolated browser. It is never inserted into the delivered app or its real records.

An application that declares the maintained protocol is checked even if the original request did not use a particular generation keyword. Upload controls may use a native label, a recognizable import button or a local disclosure followed by the file chooser. Initially disabled controls must become usable after entering a request.

Failure reports identify the failed phase and include bounded visible status, generation/render counts and saved-tree diagnostics. This information reaches the single repair attempt. Retrying the same failed creation first revalidates the existing draft against the current browser contract. An unchanged valid draft keeps its application ID and is published through the normal path with `reusedDeliveryFrom` and zero new model/tool calls. Invalid drafts continue to generation and the bounded repair step; cancellation, unavailable browser checks and nonregular recovery files cannot bypass verification.

A successful controlled gate proves integration behavior, not model quality, domain correctness or every custom control. Actual model generation and domain interactions require separate live checks.

Focused checks:

```sh
npm run build
npx tsx --test tests/ui-workspace.test.ts tests/structured-ui-runtime.test.ts tests/structured-ui-rich-selection.test.ts tests/structured-ui.test.ts tests/dsh-tool-planning.test.ts
node --test packages/dsh-plugin/tests/presentation-delivery.test.mjs packages/dsh-plugin/tests/host-ui-reference.test.mjs packages/dsh-plugin/tests/prompts.test.mjs
```

## Bounds

The workspace accepts up to 80 records and 80 photos within its 1MB source envelope. History holds at most six snapshots and 500KB; capacity errors never silently evict old content. Structured generation uses one model request with a 2048-token response budget and a 25-second deadline. DSH application creation has an eight-minute generation stage and one three-minute repair stage within the overall job timeout. Existing provider selection remains unchanged.
