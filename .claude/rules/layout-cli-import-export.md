---
description: cdkd import / export layout (modes, CFn migration, identifier resolution, YAML codec)
paths:
  - 'src/cli/commands/import.ts'
  - 'src/cli/commands/export.ts'
  - 'src/cli/yaml-cfn.ts'
---

# cdkd import / cdkd export

Rest of the CLI: [layout-cli.md](layout-cli.md). Index: [code-layout.md](code-layout.md). Per-type `provider.import` coverage is single-sourced in [docs/import.md](../../docs/import.md).

## `cdkd import`

- **Three modes.** AUTO (no flags) resolves each resource from its physical-name property, then a same-named CloudFormation stack. SELECTIVE, the default whenever a `--resource` / `--resource-mapping` flag is given, imports only listed resources and marks the rest `out of scope`. HYBRID is `--auto` plus overrides.
- **There is deliberately NO `aws:cdk:path` tag lookup**: AWS reserves the `aws:` prefix, so that tag can never exist. The CloudFormation fallback is best-effort, flat, and skipped in selective mode.
- **`--force` does not mean what upstream's does**: it is required only where the import would LOSE data — an auto rebuild over existing state, or a selective override of a resource already in state. Selective mode is otherwise a non-destructive merge.
- **Per-resource SDK calls, not a changeset, so import is NOT atomic.** State is written only after a final confirmation, and a partial import is backed out with `cdkd state orphan`.
- **The `attributes` bag is redacted by `resolveImportedProperties`, ABOVE the observed-baseline refusal, and never DROPS a key** ([#2847](https://github.com/go-to-k/cdkd/issues/2847)).
- **`--migrate-from-cloudformation [name]`** (cdkd-specific, defaulting to the cdkd stack name):
  - BEFORE the import loop one `DescribeStackResources` merges into the overrides, user entries winning; it then forces `selectiveMode = false` whatever the override count, or every other resource is orphaned by the later `DeleteStack`.
  - AFTER the state write, retirement injects `DeletionPolicy` + `UpdateReplacePolicy: Retain`, then runs `UpdateStack` and `DeleteStack` — inside the command's lock scope, and ONLY when state was actually written. Incompatible with `--dry-run`.
  - Nested stacks are RECURSIVE ([#464](https://github.com/go-to-k/cdkd/issues/464)): one v6-keyed child state file carrying `parentStack` / `parentLogicalId` / `parentRegion`, `Retain` on every leaf of both templates, one parent-side `DeleteStack` cascade. The parent's nested row records the SYNTHESIZED cdkd-local ARN, not the real child stack ARN.

## `cdkd export`

- Ends in an IMPORT changeset and DELETES cdkd state, all-or-nothing; `buildImportPlan` and its `blocked` hard-fail run BEFORE `acquireLock`.
- **Blocked**: properties holding the mask `***`; a RESOLVED import identifier that would be the mask, checked at the identifier choke point and NOT as a whole-bag `attributes` test (`CloudControlProvider.import` masks writable keys by design); a never-importable type (`Custom::*`, `AWS::CloudFormation::CustomResource`); a resource absent from state ([#2274](https://github.com/go-to-k/cdkd/issues/2274)).
- Identifiers come from `DescribeType`. A `COMPOSITE_PHYSICAL_ID_IDENTIFIERS` type resolves from state `attributes` BEFORE the field-count branch with an EMPTY `propertiesOverlay`, an unrecorded value BLOCKING; `COMPOSITE_ID_SPLITTERS` entries shape-bind BOTH segments; a live backfill must match EXACTLY ONCE ([#1659](https://github.com/go-to-k/cdkd/issues/1659)).
- The import-support pre-flight blocks every offender in one pass, but its verdict needs TWO agreeing fields (no `read` handler AND `NON_PROVISIONABLE`), so a partial response resolves `unknown` and defers to AWS. It runs AFTER the `IMPORT_UNSUPPORTED_RECREATABLE_TYPES` branch, and `--skip-import-support-preflight` bypasses it. **A read handler is necessary but not sufficient**: `CFN_IMPORT_REFUSED_DESPITE_REGISTRY` — a dated, MEASURED map consulted right after the heuristic — blocks a type CloudFormation refuses for IMPORT although the registry declares one ([#3414](https://github.com/go-to-k/cdkd/issues/3414): `AWS::AppSync::GraphQLApi`).
- `AWS::AppSync::GraphQLApi` is the one `COMPOSITE_PHYSICAL_ID_IDENTIFIERS` member whose cdkd physicalId is NOT composite: AWS moved the identifier from `ApiId` to `Arn`, cdkd stores the bare `apiId`, and the entry resolves from the recorded `Arn` attribute. It declares `physicalIdIsIdentifierFor: ['ApiId']`, so a registry still answering the OLD single field takes the plain single-key path instead of refusing by name — the physicalId IS that value — with an ARN-shaped (migrated) physicalId excluded from the bypass. `AWS::AppSync::ApiKey` sits in `COMPOSITE_ID_SPLITTERS` and decodes THREE shapes (cdkd's `<apiId>|<apiKeyId>`, the key ARN a migration records, and a bare `<apiKeyId>` from a pre-flip Cloud Control record, recovering `ApiId` from properties).
- `overlayResourceIdentifierOnProperties` classifies the template's current value ([#1787](https://github.com/go-to-k/cdkd/issues/1787)): an ABSENT key and a top-level INTRINSIC are LEFT ALONE; any LITERAL is OVERWRITTEN, the recorded physicalId being the authority; a list is REFUSED.
- Nested export submits **one IMPORT changeset per cdkd stack, leaf-first**, while parameter resolution is a ROOT-FIRST pre-pass through the deploy engine's resolver. A parent adopts its child with `Retain` + `ResourceIdentifier: { StackId }` + a post-IMPORT `TemplateURL` ([design](../../docs/design/464-nested-stacks-export-import.md)).
- **Context guard**: refuses when `-c` overrides are supplied, since they are not persisted and a later `cdk deploy` would synthesize a different template; `--accept-transient-context` opts in.
- **src/cli/yaml-cfn.ts** - the CFn-aware YAML codec: every shorthand tag parses to its long form so consumers read ONE representation, and re-emits as shorthand.
