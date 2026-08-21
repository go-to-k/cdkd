# dynamic-ref-cross-region

Integration fixture for the REGION half of issues
[#1933](https://github.com/go-to-k/cdkd/issues/1933) and
[#1957](https://github.com/go-to-k/cdkd/issues/1957): a `{{resolve:ssm:...}}`
dynamic reference must resolve against the region of the stack that declares
it, even when another stack in another region spells the identical expression
in the same cdkd process.

The two issues are different halves of that sentence. #1933 was the resolved-value
CACHE carrying one region's value to another stack; #1957 was the LOOKUP itself
reaching for the process-global AWS client singleton instead of the resolver's
own region. This fixture covers both, in two different phases — see
"What the fixture does" below.

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
3. Seeds a THIRD shared name whose TYPE differs by region: a plain `String` in
   region A and a `SecureString` in region B, asserting both types. This is the
   #1957 arm — secret-ness is decided by the parameter's TYPE (issue #1901), so
   a lookup answered by the wrong region misclassifies as well as mis-resolves,
   and a misclassified value is persisted in PLAINTEXT.
4. Deploys THREE stacks in ONE cdkd process — one per region, plus the
   region-A-only `CdkdDynamicRefAssembledSecretStack` that step 8 scrubs. The
   two regional ones each declare FOUR SSM parameters: the `String` echo, the `SecureString` echo, a THIRD
   that repeats the `SecureString` reference EMBEDDED in a longer string and
   `DependsOn` the second — so it always resolves on a cache HIT — and the
   mixed-type echo.
5. Asserts each region's echo parameters carry ITS OWN region's values — for
   every arm — with a dedicated failure message for the leak shape (region B
   holding region A's value / secret).
6. Asserts, for the two `SecureString` arms, that each stack's `state.json`
   holds the unresolved `{{resolve:ssm:...}}` expression and NEITHER region's
   plaintext — and it is the EMBEDDED one that makes this discriminating. A
   leaf whose whole value is the template's token is repositioned from the
   template SOURCE by `redactSecretsForState`, so the bare arm comes out
   redacted even if the pass recorded nothing; an embedded occurrence has no
   such fallback, so only the cache-hit arm re-recording the secret (using the
   verdict carried on the cache entry) keeps its plaintext out of state. A
   `String` arm can show none of this, because a public value is never
   redacted.
7. Runs `cdkd scrub --all` from region A against state seeded to look like a
   pre-GHSA-p5qg-v9gv-hc7w binary wrote it, and asserts region B's record comes
   back holding the EXPRESSION rather than the plaintext. This is the #1957
   discriminator — see "Why `cdkd scrub` and not a concurrent deploy" below.
8. Scrubs a THIRD stack, `CdkdDynamicRefAssembledSecretStack`, whose single
   parameter carries an `Fn::Sub`-ASSEMBLED reference to region B's
   `SecureString` ARN and no region-less reference at all, with `outputReads`
   seeded to put region B on record as a foreign producer. `cdkd scrub` must
   REWRITE that record rather than refusing it — the issue
   [#2157](https://github.com/go-to-k/cdkd/issues/2157) arm. It needs its own
   stack because scrub's pre-pass refuses over the whole leaf set: every leaf on
   the two stacks above spells its reference region-LESSLY, so once foreign
   evidence is on record those classify `ambiguous` and refuse before the
   assembled leaf is reached, and the arm would silently measure the wrong
   refusal in both polarities.
9. Destroys all three stacks, asserts all nine echo parameters and all three
   state records are gone (tri-state gone probes), then deletes the seeded
   parameters.

Pre-fix for #1933, step 5 fails on the second stack. Pre-fix for #1957, step 7
leaves region B's plaintext in `state.json`. Pre-fix for #2157, step 8 exits 2
with `SCRUB_SECRET_REFERENCE_UNCLASSIFIABLE` and the seeded plaintext survives —
unbypassably, since scrub has no flag that overrides a refusal.

## Run

```bash
/run-integ dynamic-ref-cross-region
```

`STATE_BUCKET` is required; `AWS_REGION` (default `us-east-1`) selects region
A and `SECOND_REGION` (default `us-west-2`) region B.

## Why `--stack-concurrency 1`, and why `cdkd scrub` rather than a concurrent deploy

The deploy in this fixture is serial and **must stay serial**. That is a safety
requirement rather than a leftover from #1933.

cdkd installs the per-stack region-pinned AWS clients into a process-global
singleton (`setAwsClients` in `src/cli/commands/deploy.ts`) and re-points
`process.env.AWS_REGION` alongside it, which `deploy.ts` itself notes "races
under `--stack-concurrency > 1` with multi-region stacks". #1957 fixed the
RESOLVER's use of that singleton — every dynamic-reference lookup is now bound
to its own resolver's region — but it deliberately did not touch the
PROVISIONING side, where 42 provider files read `getAwsClients()` and
`SSMParameterProvider` captures its client in the CONSTRUCTOR, a few lines after
the `setAwsClients` call. A lost race there does not merely resolve the wrong
value: it CREATES this fixture's echo parameters in the wrong region, where the
script's region-keyed cleanup will not find them. That is a billed orphan
produced by a run whose purpose is to prove correctness, so the concurrent
deploy arm stays unbuilt until the provisioning half is fixed too — filed as
issue [#1981](https://github.com/go-to-k/cdkd/issues/1981).

`cdkd scrub` reaches the SAME defect without any of that risk, and more
strictly. It installs its clients ONCE from the CLI region
(`src/cli/commands/scrub.ts:126`) and then resolves stacks in several regions,
so the wrong-region read is structural rather than timing-dependent — a
deterministic discriminator, not a probabilistic one — and the command writes no
AWS resources at all, so a failure cannot orphan anything. What it catches is
also the worse outcome of the two: a DISCLOSURE (a region-B `SecureString` left
in plaintext in `state.json`) rather than a wrong value.

Scrub is run against state deliberately seeded to hold the plaintext, because a
correct deploy never leaves one — against freshly-deployed state a fixed and a
broken binary both find nothing to do, and the arm would pass vacuously. The
seed writes region B's current value exactly where a pre-GHSA-p5qg-v9gv-hc7w
binary would have left it, and the script fails loudly if the seed did not land.

If you build the concurrent arm later, note that varying which stack goes first
means changing the DECLARATION order in `bin/app.ts`, not the argv order:
`matchStacks` (`src/cli/stack-matcher.ts`) walks the cloud assembly's own order
and ignores the order the names were typed, so `cdkd deploy B A` deploys in
exactly the same order as `cdkd deploy A B`. And run it repeatedly — a race that
interleaves harmlessly once proves nothing.

## What this fixture does NOT cover

- The concurrent (`--stack-concurrency > 1`) multi-region DEPLOY, for the
  provisioning-race reason above (issue
  [#1981](https://github.com/go-to-k/cdkd/issues/1981)). #1957's own "default
  concurrency" acceptance criterion therefore cannot be met by a deploy-shaped
  arm today; the scrub phase covers the same wrong-region read on the path where
  it is reachable safely.
- The CROSS-STACK half of #1933 in ONE region (a second stack's secrets map
  coming back empty so `cdkd scrub --all` reports it clean). The
  `SecureString` arm here covers the redaction path across two REGIONS;
  the same-region two-stack shape is `tests/integration/secrets-dynamic-ref`'s
  territory and is covered by unit tests today
  (`tests/unit/deployment/dynamic-references.test.ts`).
