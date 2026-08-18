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
   (`cdkd-dynref-region-a` / `cdkd-dynref-region-b`), as ordinary `String`
   parameters — public test data, nothing to mask.
2. Seeds a SECOND shared name as a `SecureString` in both regions, again with
   different values, and asserts the type really is `SecureString` before
   proceeding (a parameter that came back `String` would make the secret arm
   vacuous). Created out of band because CloudFormation cannot create one.
3. Deploys TWO stacks in ONE cdkd process, one per region, each declaring
   THREE SSM parameters: the `String` echo, the `SecureString` echo, and a
   THIRD that repeats the `SecureString` reference EMBEDDED in a longer string
   and `DependsOn` the second — so it always resolves on a cache HIT.
4. Asserts each region's echo parameters carry ITS OWN region's values — for
   both arms — with a dedicated failure message for the leak shape (region B
   holding region A's value / secret).
5. Asserts, for the two `SecureString` arms, that each stack's `state.json`
   holds the unresolved `{{resolve:ssm:...}}` expression and NEITHER region's
   plaintext — and it is the EMBEDDED one that makes this discriminating. A
   leaf whose whole value is the template's token is repositioned from the
   template SOURCE by `redactSecretsForState`, so the bare arm comes out
   redacted even if the pass recorded nothing; an embedded occurrence has no
   such fallback, so only the cache-hit arm re-recording the secret (using the
   verdict carried on the cache entry) keeps its plaintext out of state. A
   `String` arm can show none of this, because a public value is never
   redacted.
6. Destroys both stacks, asserts all six echo parameters and both state
   records are gone (tri-state gone probes), then deletes the seeded
   parameters.

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
  (`cdkd scrub` installs one client set from the CLI region and then resolves
  stacks in several regions, which leaves a region-B `SecureString` in
  plaintext in `state.json`). That is the ambient-client half of #1933, filed
  as issue [#1957](https://github.com/go-to-k/cdkd/issues/1957) — the
  instance-scoped cache removes the CACHE as a cross-region carrier, but it
  cannot make an ambient client point at the right region, so #1933's own
  title (one region's secret resolved into another's resource) stays reachable
  until #1957 lands.
- The CROSS-STACK half of #1933 in ONE region (a second stack's secrets map
  coming back empty so `cdkd scrub --all` reports it clean). The
  `SecureString` arm here covers the redaction path across two REGIONS;
  the same-region two-stack shape is `tests/integration/secrets-dynamic-ref`'s
  territory and is covered by unit tests today
  (`tests/unit/deployment/dynamic-references.test.ts`).
