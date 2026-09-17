---
description: cdkd state (info / list / resources / show / orphan / destroy / migrate) and the per-resource cdkd orphan counterpart
paths:
  - 'src/cli/commands/state.ts'
  - 'src/cli/commands/state-list-tree.ts'
  - 'src/cli/commands/orphan.ts'
  - 'src/cli/cdk-path.ts'
  - 'src/analyzer/orphan-rewriter.ts'
---

# Key Files and Directories - `cdkd state` and `cdkd orphan`

Split out of [layout-cli.md](layout-cli.md) under issue [#3245](https://github.com/go-to-k/cdkd/issues/3245), which globs all of `src/cli/**`. The two entries below were a 5,543 B and an 838 B line there, the first of them one of the seven lines over the 4,000 B ratchet.

Index of every area: [code-layout.md](code-layout.md).

## The `state` parent command

`state` inspects and manipulates cdkd's S3 state bucket. None of it needs the CDK app — see the top-level-vs-`state` split in [layout-cli.md](layout-cli.md).

### `state info`

Prints bucket name, region (auto-detected via `GetBucketLocation`), the source that resolved the bucket (`cli-flag` / `env` / `cdk.json` / `default` / `default-legacy`), the schema version, and a stack count. `--json` for tooling.

It is also the explicit on-demand answer for the bucket name: that banner is no longer printed in routine command output, because it includes the AWS account id and would leak via screenshots or public CI logs. `--verbose` surfaces it in debug logs instead.

### `state list` (alias `ls`)

Lists deployed stacks, one row per `(stackName, region)` pair under the region-prefixed key layout.

`--tree` (issue [#555](https://github.com/go-to-k/cdkd/issues/555) A3) loads each state record to read the v6 `parentStack` / `parentRegion` fields and renders a `tree(1)`-style parent → child hierarchy via [src/cli/commands/state-list-tree.ts](../../src/cli/commands/state-list-tree.ts). The flat default is preserved for backward compatibility with scripts that grep the existing one-row-per-stack output, and `--tree --json` emits the nested JSON shape for tooling. Orphan children whose parent record is missing surface at root level rather than vanishing.

### `state resources` / `state show`

Both accept `--stack-region <region>` to disambiguate when the same stackName has state in multiple regions.

`state show <stack> --show-nested` (issue [#555](https://github.com/go-to-k/cdkd/issues/555) A4) reuses `buildCdkdStateStackTree` (from `src/cli/commands/export.ts`) to recursively walk every `AWS::CloudFormation::Stack` row in the target's state and append each child's full state block after the parent's — DFS order, flat at column 0 with `Nested stack: <name>` headers. `--show-nested --json` emits the recursive `{state, lock, children: [...]}` shape, with `children` always present even on leaves so consumers see a stable key set.

Default (no `--show-nested`) preserves the existing single-stack `{state, lock}` JSON shape verbatim, for backward compatibility with tooling consumers.

### `state orphan <stack>...`

Removes cdkd's state record for every region by default, or scopes to one with `--stack-region <region>`. Does NOT delete AWS resources; the name mirrors aws-cdk-cli's `cdk orphan`.

### `state destroy <stack>...`

Deletes AWS resources AND the state record without requiring the CDK app — the CDK-app-free counterpart to `cdkd destroy`. The per-stack destroy logic is hoisted into `src/cli/commands/destroy-runner.ts` and shared by both.

As of [#555](https://github.com/go-to-k/cdkd/issues/555) A2 it is ALSO the documented escape hatch for directly destroying a nested-stack child. `cdkd destroy <child>` is refused with `NestedStackChildDirectDestroyError`, matching CFn's "you can't directly destroy a nested stack" semantic: the parent's `AWS::CloudFormation::Stack` row would otherwise point at gone-from-AWS resources and the parent's next deploy would try to recreate them. `cdkd state destroy <child>` intentionally bypasses that guard, for users who accept leaving the parent's reference dangling.

### `state migrate`

Copies all state from the legacy region-suffixed default bucket (`cdkd-state-{accountId}-{region}`) to the region-free default (`cdkd-state-{accountId}`). Refuses to run while any stack holds an active lock, and verifies object-count parity before any source cleanup. The source bucket is kept by default and deleted only with `--remove-legacy`.

## `cdkd orphan <constructPath>...` — the per-resource counterpart

Synth-driven, and **per-resource** rather than whole-stack (mirrors upstream `cdk orphan --unstable=orphan`). It removes specific resources from a stack's state file by construct path (`MyStack/MyTable`), live-fetching every `Fn::GetAtt` it has to substitute via the resource's `provider.getAttribute()` (cached per `(orphan, attr)`), and rewriting every sibling `Ref` / `Fn::GetAtt` / `Fn::Sub` / `dependencies` reference so the next deploy neither re-creates the orphan nor fails on a stale reference.

Path matching is **prefix-based**, matching upstream: the input matches every resource whose `aws:cdk:path` is exactly the input OR starts with `<input>/`. So an L2 path like `MyStack/MyConstruct/MyBucket` resolves to the synthesized L1 child `MyStack/MyConstruct/MyBucket/Resource`, and an L2 wrapper containing several CFn resources orphans every child under it.

The `aws:cdk:path` index in `src/cli/cdk-path.ts` excludes `AWS::CDK::Metadata` resources, so the synthesized `<Stack>/CDKMetadata/Default` sentinel is never offered as an "available path" and cannot be orphaned.

Unresolvable references hard-fail with a one-shot list of every site. `--force` falls back to the orphan's `state.attributes` cache, logging a per-case warning, before leaving the original intrinsic untouched if the cache also lacks the attr. `--dry-run` prints the rewrite audit table without acquiring a lock or saving state.

It is WRITE-CAPABLE, so it refuses a record it could not read rather than repairing one — three containers, three calls at the load: `refuseMalformedState` (the root bag), `refuseMalformedOutputs`, and, since issue [#3318](https://github.com/go-to-k/cdkd/issues/3318), `refuseMalformedResourcePropertiesForOrphan` for the per-ENTRY `properties` map the rewrite used to carry into the save untouched. The last one is SCOPED to the records the save keeps, which leaves `cdkd orphan <the damaged resource>` working as a way out — but only while the CDK app still declares it, since the orphan set comes from the synthesized `aws:cdk:path` index; the refusal therefore leads with hand repair and `cdkd state orphan <stack>`, which need no app. Reasoning in [state-malformed-properties-orphan.md](state-malformed-properties-orphan.md), which loads with this file.

The implementation lives in `src/analyzer/orphan-rewriter.ts` — the recursion structure mirrors `IntrinsicFunctionResolver` but in the inverse direction: only orphan references are substituted, every other intrinsic is left alone — and in `src/cli/cdk-path.ts`, the shared `aws:cdk:path` index also used by `cdkd import`.

The pre-PR `cdkd orphan <stack>` whole-stack behavior is gone: the command hard-fails with a redirect message pointing at `cdkd state orphan <stack>` instead of silently routing.

## `src/cli/commands/state-list-tree.ts`

Pure-functional helpers backing `cdkd state list --tree` (issue [#555](https://github.com/go-to-k/cdkd/issues/555) A3). Owns:

- `buildStackTree` — flat `(stackName, region, parentStack, parentRegion)` list → parent → child tree, with orphan-child, parent-loop and over-depth root promotion;
- `renderStackTreeAscii` — `tree(1)`-style box-drawing `├── ` / `└── ` / `│   ` prefixes;
- `stackTreeToJson` — nested shape for `--tree --json`, with explicit `null` for absent parent fields.

Kept separate from `state.ts` so the tree-construction logic stays unit-testable without mocking `S3StateBackend`. The S3 read fan-out — one `getState` per ref THAT CARRIES A REGION, a legacy region-less one is not read — happens in `state.ts`'s `renderTreeMode` wrapper; the helper itself is sync.
