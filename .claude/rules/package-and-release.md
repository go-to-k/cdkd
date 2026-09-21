---
description: Dependency invariants, the Node.js version floors, and the batched release-please flow
paths:
  - 'package.json'
  - 'release-please-config.json'
  - '.release-please-manifest.json'
  - '.github/workflows/release.yml'
---

# Dependencies, Node versions, releases

## `aws-cdk-lib` and `constructs` are dev-only, deliberately

**Do not restore the `peerDependencies` block, and do not lower either floor**
(`aws-cdk-lib` `^2.260.0` is the highest GHSA floor it must clear; `constructs`
`^10.5.0` matches aws-cdk-lib's own peer floor). cdkd is a CLI, not a library,
and must not constrain a user's CDK version: nothing it ships imports either
package — the user's CDK app runs as a SUBPROCESS and resolves `aws-cdk-lib`
from the USER's project, and cdkd only reads the Cloud Assembly JSON. They stay
dev deps because the unit suite reads `aws-cdk-lib/region-info` as the fact
table cdkd's own S3-endpoint and region tables are compared against.

Removing the peers changed nothing in a user's installed tree, because
`cdk-local` (a runtime dependency) declares the SAME non-optional peers — the
forced install goes away only when cdk-local's do. Per-file evidence:
[#2861](https://github.com/go-to-k/cdkd/issues/2861).

## Other dependencies worth knowing

- `cdk-local` — the local-emulation engine. `src/cli/commands/local-state-source.ts`
  is a shim injecting the S3-backed `--from-state` factory through cdk-local's
  `extraStateProviders` hook.
- `yaml` — the CFn-aware codec behind `cdkd export` / `import
  --migrate-from-cloudformation`, preserving `!Ref` / `!GetAtt` / `!Sub`
  shorthand on round-trip (`src/cli/yaml-cfn.ts`).
- `adm-zip` — the `AWS::CodeCommit::Repository` `Code` seed, and AWS's public
  CloudFormation schema bundle in `scripts/refresh-cfn-schemas.mjs --from-zip`
  (build-time only, never bundled by `vp pack`).
- `typescript-v6` — an npm alias of typescript@6, giving the codegen scripts the
  stable compiler API that TS7 ships only under `typescript/unstable/*`.
- `marked` — used by a few unit tests to read a document's RENDERED anchors
  rather than pattern-matching its source. Never bundled.

## Node.js versions

Three different numbers, each with its own reason to exist:

| Where | Value | Meaning |
| --- | --- | --- |
| `package.json` `engines` | Node.js >= 22.12.0 | the floor for USERS of cdkd |
| `.node-version` | 24.15.0 | local dev and CI, managed by Vite+ / mise |
| `vp pack` `target` | node22 | the runtime cdkd SHIPS to users |

The floor is restated in several prose files and
`tests/unit/scripts/node-floor-sync.test.ts` keeps them in one value — change it
there and everywhere that test names, in the same commit.

Node 24 strips type annotations, so `node scripts/foo.ts` runs a `.ts` file
directly. Use it for ad-hoc scripts under `scripts/`; register a longer-lived
one as a Vite+ task in `vite.config.ts`, which is how every cdkd task is
invoked (`vp run <task>`) — there is no `package.json` `scripts` block.

## Releases are batched

release-please runs as a GitHub Action. Pushes to `main` create or update one
standing `chore(release): <ver>` PR; merging THAT PR cuts the tag, the GitHub
release and the npm publish. An ordinary `feat:` / `fix:` merge publishes
nothing, so do not wait for a version bump after a merge, and **never merge the
release PR unless the maintainer asked for a release** — that standing rule is
the real protection, not a gate. The maintainer merges it through the web UI.

cdkd stays at major version 0: `bump-minor-pre-major: true` maps breaking
changes to MINOR bumps, and the publish job in `.github/workflows/release.yml`
hard-fails on any tag whose major is not 0.

### A standing release PR goes STALE silently, and stays mergeable

release-please does not rebuild a release PR whose computed release is
unchanged — it logs `PR #N remained the same` and leaves the branch on the base
it was cut from. So anything that later lands on `main` in a file release-please
OWNS (`CHANGELOG.md`, `package.json`'s version, `.release-please-manifest.json`)
is missing from that branch, and merging the PR takes the branch's stale copy
and reverts it. GitHub reports MERGEABLE throughout.

**After any PR that edits one of those three files, check whether a release PR
is open and recreate it**: close it, delete its branch, and re-run the release
workflow (`workflow_dispatch` exists for exactly this). release-please
recomputes the identical release from current `main`.
