# RecallOS · 知我

LiveUI can share persistent preferences with local agent harnesses through the optional RecallOS adapter. [RecallOS source and installation](https://github.com/tongmd/personalmemoryos).

## Pinned source dependency

RecallOS is a Git submodule at `vendor/recallos`, initially pinned to `v0.2.0`. The parent repository records an exact commit, so switching or rolling back a Ulemi release also selects its RecallOS source version. Web, iOS app, APK, and Android updater CI all check out submodules recursively. Deployment archives expand that recorded commit rather than omitting the gitlink.

```sh
git clone --recurse-submodules https://github.com/tongmd/liveuiagent.git
# For an existing checkout, or after switching releases:
git submodule update --init --recursive
```

To deliberately upgrade RecallOS, fetch and check out the intended tag/commit inside `vendor/recallos`, then commit the changed gitlink in Ulemi. Do not use `git submodule update --remote` in reproducible builds. GitHub's ordinary source ZIP/tar downloads omit submodule contents; use a recursive clone or the deployment archive script.

The mobile hosted workspace and web use the same server-side adapter. The Python/Git backend and gateway credentials remain on the server; a submodule does not embed them in an APK or iOS binary, nor does it add memory to the separate offline assistant. Runtime enabling remains controlled by the configuration below.

## Runtime connection

Set server-only `RECALLOS_URL` and `RECALLOS_TOKEN` to enable it. The URL is the authenticated loopback RPC gateway, not an MCP endpoint. Keep the bearer token on the application server; never include it in client-side configuration. A remote LiveUI server should connect over a private tunnel. Configure the gateway's `--shared-owner` to exactly match the authenticated LiveUI username that should share the desktop repository. Other owners get isolated repositories. Existing upstream user authentication remains authoritative.

The first access imports that owner's legacy explicit and contextual SQLite memories into private Git. Content, app scope, condition, dimension, expiry, and provenance are retained. Imports have stable event IDs, so restarting cannot resurrect deleted imports. Existing SQLite rows remain intact as a migration backup; all enabled memory reads and writes then use RecallOS. Without these environment variables the existing SQLite backend continues to work.

Each personalization request refreshes the committed snapshot before reading. Existing extraction and selection still validate feedback evidence and choose memories relevant to the current task. Model interpretation remains probabilistic; a successful write alone does not demonstrate adherence. A stale edit to a rule changed by another harness returns a conflict instead of silently overwriting it. The personal endpoint reports the active brand and revision under `recallos`.

Back up the SQLite database and record the current application release before enabling the adapter. To revert the deployment, restore the prior release/environment and restart the application. New RecallOS changes remain in its private Git history; the legacy SQLite snapshot does not contain post-migration changes. Reconcile/export those changes before returning to SQLite as an active backend. Preference undo should ordinarily use RecallOS's compensating `memory_revert` operation rather than resetting Git or restoring an old database.

Verification: `npm run build:server` and `npm run test:memory`. Tests cover idempotent migration without resurrection, user/project isolation, and contextual feedback persistence without legacy SQLite writes.
