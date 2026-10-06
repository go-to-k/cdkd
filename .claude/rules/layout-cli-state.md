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

- **`info`** — the ONLY on-demand printer of the bucket name (holds the
  account id).
- **`list`** (`ls`) — one row per `(stackName, region)`. `--tree` reads v6
  `parentStack` / `parentRegion` (flat default kept for scripts; a parentless
  child surfaces at root). `renderTreeMode` does the S3
  fan-out: one `getState` per ref THAT CARRIES A REGION.
- **`resources` / `show`** — `show --show-nested --json` emits
  `{state, lock, children}`, `children` ALWAYS present even on leaves.
- **`orphan <stack>...`** — drops the state record; deletes no AWS resource.
  `--resource` drops entries via `cdkd orphan`'s write path (refusals,
  rewriter, lock `--force` never passes); refuses a target with a child record
  (#4602).
- **`destroy <stack>...`** — deletes AWS resources AND the record (shares
  `destroy-runner.ts` with `cdkd destroy`). The only way to destroy a
  nested-stack CHILD, which `cdkd destroy` refuses with
  `NestedStackChildDirectDestroyError`.
- **`migrate`** — legacy `cdkd-state-{accountId}-{region}` to
  `cdkd-state-{accountId}`. Refuses while any stack holds a live lock, verifies
  object-count parity before any source cleanup, keeps the source unless
  `--remove-legacy`.

## `cdkd orphan <constructPath>...`

Synth-driven: drops resources by construct path (PREFIX-matched) and
rewrites every sibling `Ref` / `Fn::GetAtt` / `Fn::Sub` / `dependencies`
reference to them, no other intrinsic. A `Fn::GetAtt` takes the RECORDED
attribute over the live `getAttribute()` answer (read by NAME), and only once
that read answered, so it prints nothing the live path could not ([#4186](https://github.com/go-to-k/cdkd/issues/4186)).

- The `aws:cdk:path` index (`src/cli/cdk-path.ts`, shared with `cdkd import`)
  excludes `AWS::CDK::Metadata`, so `CDKMetadata/Default` is never orphanable.
- The stack is the LONGEST display-path prefix ending at a `/`, never the first
  segment: a Stage stack's path is hierarchical
  ([#3943](https://github.com/go-to-k/cdkd/issues/3943)). `stackForConstructPath`
  in `cdk-path.ts` is the one copy; the `cdkd local` resolvers use it too.
- Unresolvable references hard-fail; `--force` falls back to
  `state.attributes`, never what `servableRecordedAttribute` won't serve.
- WRITE-CAPABLE, so it refuses a record it could not read — the root, `outputs`,
  and the `...ForOrphan` refusals over what the save keeps, each passed the
  LISTED `recordRegion`:
  [state-malformed-properties-orphan.md](state-malformed-properties-orphan.md).
- Whole-stack `cdkd orphan <stack>` hard-fails (use `cdkd state orphan`).
- Every assembly-derived value it renders — `stackName` / `displayName`, a
  template logical id, an `aws:cdk:path` — goes through a display helper, in
  thrown messages AND in the default-verbosity `logger.info` lines
  ([#3479](https://github.com/go-to-k/cdkd/issues/3479)). `displaySafe` by
  default, including where the prose already supplies the quotes;
  `displayIdent` (capped at `STACK_REF_MAX_CODE_POINTS`) for every UNQUOTED
  IDENTITY list — each `Available: ...` and the `missing` half beside one —
  where `displaySafe`'s trim would render a planted entry identical to the
  genuine one. A region rendered outside those lists takes `asciiOnly`.
  The operator's own `<constructPath>` argv is deliberately NOT sanitized for
  DISPLAY; where one goes into a PASTEABLE command it is `isPasteableIdent`'s
  class ([pasteable-ident.md](pasteable-ident.md)), not this one.
