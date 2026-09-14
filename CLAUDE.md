# CLAUDE.md — typeorm-cloud-sync

Local-first sync between a TypeORM SQLite database and Firestore. The app that dogfoods it is
`../daily` (Ionic/Angular); it consumes this package as a pinned GitHub commit, so a change here is
not visible to the app until it is pushed and re-pinned with `daily/scripts/update-typeorm-cloud-sync.sh`.

## Commands

- `npm run build` — tsc to `lib/`
- `npm test` — Jest (sql.js in bare Node, no Firebase needed). Run one file with
  `npx jest --config jestconfig.json src/__tests__/<file>.spec.ts`.
- `npm run format` — prettier

## Layout

- `src/models/` — `StoreRecord` (base entity), `BaseUser`, `StoreChangeLog` (the upload outbox), `Meta`.
- `src/sqlite-store.ts` — the local side; `resolve()` is conflict resolution.
- `src/cloud/cloud-store.ts` — abstract orchestration: drain (`updateCloudFromChangeLog`), download
  apply (`resolveRecords`), downloading refcount, subscribers, disposal.
- `src/cloud/firebase/cloud-firebase-firestore.ts` — Firestore adapter: paged catch-up + live
  listeners (`subscribeObj`), user document listener.
- `src/cloud/firebase/protocol/` — SDK-agnostic versioned write protocol (`StoreRecordWriter`,
  `PathBuilder`, `FirestorePort`), shared with the app's Cloud Functions.
- `src/tenant.ts` — one account's isolated stack + registry.
- `src/__tests__/` — `fake-cloud-store.ts` and `fake-firestore-port.ts` let the orchestration run
  without Firebase. `sync-invariants.spec.ts` holds expected-failing tests for known defects.

## Invariants

Every change must preserve these. When a change touches one, add or update a test for it.

1. **A change-log row is deleted only by the drain that observed that exact version of it.**
   An edit that lands mid-upload must stay queued.
2. **Cloud-origin writes never invent data.** Timestamps travel with the record; entity listeners are
   off for cloud-origin saves; a document whose `changeId` is not above the local row's is a no-op.
3. **The download cursor is per collection, persisted, and advanced only by cloud deliveries.**
   Never derived from local rows, never moved by an upload.
4. **Listeners are never torn down in order to upload.** Own echoes are harmless under (2).
5. **The drain has a fixed trigger set and cannot wedge:** commit, network up, private cloud
   initialized, download settled, app resume. Per-record timeout; a failure continues the loop.
6. **Nothing user-visible waits on `downloading$`.** It coalesces cloud-origin applies; a user's own
   commit repaints immediately. A failed setup still settles the indicator.
7. **No DataSource access after dispose.** Dispose awaits the drain, the access chain, and in-flight
   applies; callbacks check a disposed flag.
8. **The device never deletes what the cloud is not known to hold.**

## Working rules

- Local-first is the hard constraint: no local commit may await the network.
- `sync-invariants.spec.ts` uses `test.failing` for defects that are still open. A fix is complete when
  its test fails as "expected failure passed"; flip it to `test` in the same commit. Never delete one.
- Comments describe the present design, not history. If you fix a cause, correct any comment that
  asserted a different one.
- Full words in names; no abbreviations.
- Do not diagnose "Cannot read properties of undefined (reading 'query')" as concurrency: in
  TypeORM's Capacitor driver it is a query issued after `dataSource.destroy()`.
