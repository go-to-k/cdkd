---
title: Supported Resources internals
description: "The AWS-side behaviour behind cdkd's Glue Iceberg refusal and its Glue Parameters preservation on update."
unlisted: true
---

# Supported Resources internals

Detail behind the two Glue sections of
[Per-Type Behaviour Notes](supported-resources-type-notes.md) that you need
only when changing the Glue provider or debugging one of these paths.

## Glue Iceberg refusal

The user-facing summary is
[Glue table Iceberg support](supported-resources-type-notes.md#glue-table-iceberg-support-icebergtableinput-is-refused).

**A `cdkd rollback` never hits that refusal.** A rollback replays from cdkd
state rather than from your template, so refusing would leave you with no
remedy at all — you cannot edit a state record from your CDK code, only by hand
in `state.json`. Both rollback paths therefore WARN and continue:

- **Update** — the rollback replays the previous state's properties through the
  provider's update path. cdkd does not wire Glue's update-only
  `UpdateOpenTableFormatInput` shape, so nothing is forwarded and no bad value
  can reach AWS from that path.
- **Reverse-replacement create** — the arm that revives the OLD table after a
  failed replacement calls `provider.create(...)` with the previous state's
  properties, flagged as a state replay. Here the value IS
  forwarded, so the restored table is degraded exactly as the original was:
  under the CFn spelling the AWS SDK drops the unknown member (the same silent
  drop that produced these state records) and the table comes back without its
  Iceberg metadata; under the SDK spelling Glue rejects the call and that one
  rollback operation fails. Either way the warning names `cdkd deploy` with the
  working shape as the fix-forward — strictly better than a refusal, which
  guaranteed the table was not restored at all.

This is a deliberate **parity divergence**: CloudFormation does not validate the
property, it forwards it and then rolls the stack back. No working deployment is
lost by refusing it, because the spec is undeployable on **both** paths:

- the raw `glue:CreateTable` API — the call cdkd itself makes — rejects every
  spec shape (`Location information cannot be null while creating an iceberg
  table` without a `TableInput.StorageDescriptor`, `Table metadata information
  present at multiple parts of input request` with one; the spec's own
  `Location` is never read);
- CloudFormation rolls every variant back with `Table metadata is expected only
  via TableInput or via IcebergTableInputProperties inside
  OpenTableFormatInput` — naming a property that exists in neither the CFn
  registry schema (`IcebergInput.IcebergTableInput`) nor `@aws-sdk/client-glue`
  (`IcebergInput.CreateIcebergTableInput`). That three-way contract mismatch is
  an AWS-side bug.

One route is not covered: a table whose cdkd state records
`provisionedBy: 'cc-api'` (reachable only via `--recreate-via-cc-api` or a
legacy state record) is routed to the Cloud Control provider, which forwards
the property and gets CloudFormation's rollback instead of the message above.
The deploy still fails; it just fails later and less helpfully.

The working shape has real-AWS coverage in the
[`data-analytics`](https://github.com/go-to-k/cdkd/tree/main/tests/integration/data-analytics/)
integ fixture.

## Glue parameter preservation

The user-facing summary is
[Glue table / database: AWS-managed `Parameters` survive an update](supported-resources-type-notes.md#glue-table-database-aws-managed-parameters-survive-an-update).

Glue's `UpdateTable` / `UpdateDatabase` replace `TableInput` / `DatabaseInput`
**wholesale** — whatever the payload omits is erased. `Parameters` is a
general-purpose bag that AWS itself writes into, so entries with no template
representation used to disappear on the first unrelated edit. For an Iceberg
table
that was not cosmetic: a deploy changing only `TableInput.Description` cleared
`table_type` and `metadata_location`, silently degrading the table to a plain
external table pointing at Iceberg data files, with the deploy reporting
success. The same exposure covered a crawler's `classification`, `EXTERNAL`,
`comment`, and Lake Formation markers.

The same exposure is also closed one level down, for the
`StorageDescriptor` subtree: a Glue
crawler authors `Columns`, `InputFormat` / `OutputFormat`, `SerdeInfo` (and
its `Parameters` bag) and `StorageDescriptor.Parameters`, and Glue re-derives
an Iceberg table's catalog `Columns` from table metadata — all of which an
unrelated update used to wipe (`Columns` -> `[]`, `SerdeInfo` gone; probed
live 2026-08-10). The preservation rule is the same
"present in neither template side" test, applied per SD *member* (with the
two nested `Parameters` bags merged per key — including when a whole bag is
removed from the template, which keeps the top-level `Parameters` semantics:
your keys are removed, AWS-authored keys survive). `SerdeInfo` is structural, not
a bag: removing the whole block from the template removes it on AWS, since a
partial serde carrying only crawler-authored entries would be incoherent. A
template that never declared `StorageDescriptor` at all carries the whole
live block forward. Scope is
deliberately the `StorageDescriptor` subtree only — the crawler also authors
`PartitionKeys` / `Owner`, which remain template-authoritative for now.

cdkd now reads the live table / database (`glue:GetTable` /
`glue:GetDatabase`) immediately before the update and merges those
AWS-authored entries back into the payload. Four consequences worth knowing
(they apply to the `StorageDescriptor` members the same way):

- **Your removals still work.** A parameter you delete from your template is
  still deleted on AWS. The merge only restores keys present in *neither* the
  new template nor the last-deployed one — i.e. keys you never authored.
  A key present in the previously deployed template and absent now is read as
  a deliberate removal, exactly as before.
- **A parameter added OUTSIDE your template is now permanent and invisible.**
  This is the deliberate price of the fix, and it is worth stating plainly.
  cdkd cannot tell an entry AWS wrote from one a human added in the console or
  via `aws glue update-table` — neither appears on either template side, so
  both are preserved on every subsequent deploy. It will also not be reported:
  `cdkd drift` compares against the state baseline, and after a deploy the
  merged value is captured into that baseline, so the key stops looking like
  drift. To remove such an entry, delete it directly
  (`aws glue update-table` / the console) — or declare it in your template
  first, deploy, then delete it from the template, which makes it a normal
  user-authored removal the merge will honor.
  `cdkd drift --revert` is unaffected and still clears console-side additions:
  that path passes the AWS-current snapshot as the previous side, so every
  live key counts as previously-known and none is added back.
- **The deploy identity needs `glue:GetTable` / `glue:GetDatabase`.** If the
  read fails for any reason other than "not found", the update is refused with
  an error naming the missing action rather than proceeding — silently
  skipping the merge would reinstate the erasure this read exists to prevent.
- **Concurrent writers are detected on tables, not on databases.** Reading the
  parameters and writing them back opens a window: an Apache Iceberg commit
  from Spark / Athena / EMR landing in between would be undone by writing back
  the `metadata_location` cdkd read, pinning the table to an older snapshot.
  cdkd therefore sends `UpdateTable`'s `VersionId` precondition on **every**
  table update, so a concurrent commit fails the deploy loudly (with an error
  naming the cause) instead of silently rolling the table back. Re-running the
  deploy picks up the current values. It cannot fail spuriously: the version is
  read milliseconds before the write, so it is stale only when somebody else
  genuinely wrote in between — including under `cdkd drift --revert`, where
  stopping is the right outcome rather than clobbering a change the revert
  never saw. `UpdateDatabase` has no `VersionId` equivalent in the AWS API, so
  the database merge keeps this exposure; in practice nothing commits to a Glue
  *database* out of band the way an engine commits to a table.

Real-AWS coverage: the [`data-analytics`](https://github.com/go-to-k/cdkd/tree/main/tests/integration/data-analytics/)
fixture's UPDATE phase re-asserts both Iceberg markers after an unrelated
`Description` edit (having first pinned that the update was in-place, via an
unchanged `Table.CreateTime`), asserts a user-removed parameter on the sibling
plain table is still gone, and runs the same removal-plus-preservation pair
against the database. For the `StorageDescriptor` subtree it injects crawler-equivalent
out-of-band members (`StorageDescriptor.Parameters` and
`SerdeInfo.Parameters` entries) via a raw `UpdateTable`, asserts they survive
the unrelated Phase-2 deploy, and that template-declared SD members
(`SerializationLibrary`, `Columns`) stay template-authored. It also pins the concurrency guard's *premise*: AWS
documents `VersionId` only as "the version ID at which to update the table
contents", so the fixture advances a table's version out of band and requires
AWS to refuse a replay of the stale one. If AWS ever starts ignoring it, that
assertion fails and the guard is removed rather than left in place as a
placebo.
