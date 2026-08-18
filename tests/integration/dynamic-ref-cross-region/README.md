# dynamic-ref-cross-region

Integration fixture for the REGION half of issue
[#1933](https://github.com/go-to-k/cdkd/issues/1933): a `{{resolve:ssm:...}}`
dynamic reference must resolve against the region of the stack that declares
it, even when another stack in another region spells the identical expression
in the same cdkd process.

## Background

Secrets Manager secrets and SSM parameters are REGIONAL — the same NAME in
`us-east-1` and `ap-northeast-1` is two independent values, routinely two
different credentials. cdkd resolves `{{resolve:...}}` expressions itself
(`resolveDynamicReferences` in `src/deployment/intrinsic-function-resolver.ts`)
and caches the resolved value so a second reference costs no extra API call.

That cache used to be a MODULE-GLOBAL map keyed by the expression string
alone, with no region component and no reset between stacks, so the first
region to resolve an expression won it for the whole process: every later
stack in every other region silently reused that value. The fix moved the
cache onto the resolver INSTANCE — one resolver per stack, each constructed
with its own region — so a region boundary is now also a cache boundary.

## What the fixture does

1. Seeds the SAME SSM parameter name in TWO regions with DIFFERENT values
   (`cdkd-dynref-region-a` / `cdkd-dynref-region-b`). Both are ordinary
   `String` parameters — public test data, nothing to mask.
2. Deploys TWO stacks in ONE cdkd process, one per region, each declaring an
   SSM parameter whose `Value` is the identical literal
   `{{resolve:ssm:<shared name>}}` expression.
3. Asserts each region's echo parameter carries ITS OWN region's value, with a
   dedicated failure message for the leak shape (region B holding region A's
   value).
4. Destroys both stacks, asserts both echo parameters and both state records
   are gone (tri-state gone probes), then deletes the seeded parameters.

Pre-fix, step 3 fails on the second stack.

## Run

```bash
/run-integ dynamic-ref-cross-region
```

`STATE_BUCKET` is required; `AWS_REGION` (default `us-east-1`) selects region
A and `SECOND_REGION` (default `us-west-2`) region B.

## Why `--stack-concurrency 1`

cdkd installs the per-stack region-pinned AWS clients into a process-global
singleton (`setAwsClients` in `src/cli/commands/deploy.ts`), which
`deploy.ts` itself notes "races under `--stack-concurrency > 1` with
multi-region stacks". The dynamic-reference lookups go through that same
ambient singleton, so with the default concurrency of 4 the two stacks race
for it and the result is timing-dependent regardless of the cache fix. Serial
deploy is the mode this fixture pins.

## What this fixture does NOT cover

- The concurrent (`--stack-concurrency > 1`) multi-region case, and more
  generally any caller that does NOT re-pin the ambient clients per stack
  (`cdkd drift --all` builds one client set from the CLI region and loops over
  stacks in several regions). That is the ambient-client half of #1933,
  tracked as issue [#1934](https://github.com/go-to-k/cdkd/issues/1934) — the
  instance-scoped cache removes the CACHE as a cross-region carrier, but it
  cannot make an ambient client point at the right region.
- The CROSS-STACK half of #1933 (a second stack's secrets map coming back
  empty so `cdkd scrub --all` reports it clean). That half needs a
  `SecureString` / Secrets Manager reference shared by two stacks in ONE
  region; `tests/integration/secrets-dynamic-ref` is the nearest existing
  shape. Covered by unit tests today
  (`tests/unit/deployment/dynamic-references.test.ts`).
