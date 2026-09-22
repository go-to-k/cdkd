---
description: cdkd state subcommands and the per-resource cdkd orphan
paths:
  - 'src/cli/commands/state.ts'
  - 'src/cli/commands/state-list-tree.ts'
  - 'src/cli/commands/orphan.ts'
  - 'src/cli/cdk-path.ts'
  - 'src/analyzer/orphan-rewriter.ts'
---

# `cdkd state` and `cdkd orphan`

## `state` — reads the S3 state bucket, no CDK app

- **`info`** — the ONLY on-demand printer of the bucket name; routine output
  omits it because it carries the AWS account id.
- **`list`** (`ls`) — one row per `(stackName, region)`. `--tree` reads v6
  `parentStack` / `parentRegion` (flat default preserved for scripts that grep
  it; a parentless child surfaces at root). `renderTreeMode` does the S3
  fan-out: one `getState` per ref THAT CARRIES A REGION.
- **`resources` / `show`** — `show --show-nested --json` emits
  `{state, lock, children}`, `children` ALWAYS present even on leaves; without
  it the `{state, lock}` shape is verbatim.
- **`orphan <stack>...`** — drops the state record; deletes no AWS resource.
- **`destroy <stack>...`** — deletes AWS resources AND the record; shares
  `destroy-runner.ts` with `cdkd destroy`. The only way to destroy a
  nested-stack CHILD, which `cdkd destroy` refuses with
  `NestedStackChildDirectDestroyError`.
- **`migrate`** — legacy `cdkd-state-{accountId}-{region}` to
  `cdkd-state-{accountId}`. Refuses while any stack holds a live lock, verifies
  object-count parity before any source cleanup, keeps the source unless
  `--remove-legacy`.

## `cdkd orphan <constructPath>...`

Per-resource and synth-driven: drops resources from state by construct path
(PREFIX-matched), substituting each `Fn::GetAtt` via a live
`provider.getAttribute()` and rewriting every sibling `Ref` / `Fn::GetAtt` /
`Fn::Sub` / `dependencies` reference. `orphan-rewriter.ts` rewrites ONLY orphan
references, leaving every other intrinsic alone.

- The `aws:cdk:path` index (`src/cli/cdk-path.ts`, shared with `cdkd import`)
  excludes `AWS::CDK::Metadata`, so `CDKMetadata/Default` is never orphanable.
- Unresolvable references hard-fail; `--force` falls back to
  `state.attributes`.
- WRITE-CAPABLE, so it refuses a record it could not read —
  `refuseMalformedState`, `refuseMalformedOutputs` and
  `refuseMalformedResourcePropertiesForOrphan` (SCOPED to records the save
  keeps):
  [state-malformed-properties-orphan.md](state-malformed-properties-orphan.md).
- Whole-stack `cdkd orphan <stack>` hard-fails, redirecting to
  `cdkd state orphan`.
- Every assembly-derived value it renders — `stackName` / `displayName`, a
  template logical id, an `aws:cdk:path` — goes through a display helper, in
  thrown messages AND in the default-verbosity `logger.info` lines
  ([#3479](https://github.com/go-to-k/cdkd/issues/3479)). `displaySafe` by
  default, including where the prose already supplies the quotes;
  `displayIdent` (capped at `STACK_REF_MAX_CODE_POINTS`) for the two UNQUOTED
  `Available: ...` lists, where `displaySafe`'s trim would render a planted
  entry byte-identical to the genuine one the message says is missing. The
  operator's own `<constructPath>` argv is deliberately NOT sanitized.
