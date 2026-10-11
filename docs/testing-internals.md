---
title: Testing internals
description: "Contributor reference for individual integration fixtures: what each one asserts and why it is built the way it is."
unlisted: true
---

# Testing internals

[Testing](testing.md) covers how to run and write tests. This page records what
specific integration fixtures assert and why they are shaped the way they are.
Read the section for a fixture before you change it, or before you copy its
approach into a new one.

## `CDKD_TEST_REMOVAL`: choosing what to retain

The two conventions on the Testing page (assert the baseline is live, keep a
sibling that is not removed) need care in practice.

The two conventions above are the ones worth copying, but they are NOT
universal in the tree — `cloudfront-function-url` deliberately removes the only
value it sets, so it satisfies the baseline-live convention without a retained
sibling. Copy the retained sibling whenever the property is a COLLECTION (a tag
list, an attribute map), where "cleared everything" and "cleared the right
entry" are different outcomes.

`alb` is the fixture that shows both shapes side by side, and how one turns
into the other. Its Listener arm drops the only `ListenerAttributes` entry it
sets (no sibling needed), while its `LoadBalancerAttributes` arm — added by
issue [#1609](https://github.com/go-to-k/cdkd/issues/1609) item 1 — retains
two keys and drops only `idle_timeout.timeout_seconds`.

**A retained sibling only works when its templated value DIFFERS from AWS's
default**, and getting that wrong is easy enough that this fixture shipped it
in review. The first version retained `deletion_protection.enabled: 'false'` —
but `false` IS the AWS default, so a bug that reset every attribute on the
load balancer would produce a byte-identical readback and the assertion could
not tell an over-broad reset from a correct one. The sibling that does the job
is `routing.http2.enabled: 'false'` (AWS defaults it to `true`), asserted at
baseline and again after the removal deploy. Ask of any retained sibling: *if
the provider cleared EVERYTHING, would this assertion still pass?* If yes, it
is decoration.

`deletion_protection.enabled` stays in every phase for the other half of the
job — it pins a CDK-L2 trap. The L2
`ApplicationLoadBalancer` emits its own `deletion_protection.enabled` entry, so
the first version of that fixture — which simply omitted the property override
in the removal phase — let the L2 default reappear, turning the phase into a
value CHANGE plus an unintended second removal instead of the clean single-key
removal it read as. Restating the sibling in EVERY phase is what keeps the
removal single-key. Synthesize both phases and diff the rendered list before
running; `cdk synth` exiting 0 in each phase proves nothing about the delta
between them.

**The toggle also serves the INVERSE assertion, where retention is the correct
outcome.** Everything above describes the #1160 class, in which a removed
property must be RESET to its default and the removal phase asserts it is gone.
`nlb-source-nat` (issue
[#1619](https://github.com/go-to-k/cdkd/issues/1619)) uses the same toggle to
assert the opposite, and it is not a violation of the convention: its two
NLB flags have no API of their own and ride on `SetSubnets` /
`SetSecurityGroups`, so what is under test is what **AWS** does when the Set*
call omits the member. AWS retains, so cdkd correctly sends nothing and the
removal phase asserts the live value SURVIVED.

Two conventions carry over unchanged, and one is added:

- baseline-live still applies, with a twist that matters more here — the
  templated value must be AWS's NON-default (`on` for source-NAT; `off` for the
  enforce flag, which AWS defaults to `on`), or "retained" and "reset to
  default" produce an identical readback and the assertion proves nothing. This
  is the same trap as the retained-sibling rule above, one level over.
- a retained sibling is not applicable — each flag is scalar, not a collection.
- **new: prove the Set\* call actually FIRED.** A retention assertion is
  vacuous if no call was issued, since the value would be untouched either way.
  So each flag is dropped in the SAME deploy that changes its companion
  property (a third subnet / a second security group), and the phase asserts
  that companion change landed before asserting the flag survived.

## Rollback fixtures

### `rollback-failure-injection`

For the richer, multi-resource rollback regression net (VPC + Subnets +
SecurityGroup + IAM Role + Lambda-in-VPC + SSM Parameter, with a
self-contained env-gated failing SQS Queue), see
`tests/integration/rollback-failure-injection/` (scenario tag
`rollback-failure-injection`). It asserts the completed siblings are rolled
back with no orphan VPC/SG/ENI/Role/Lambda/SSM and that the #808 events
captured `RESOURCE_FAILED` + `ROLLBACK_*` + `RUN_FINISHED result=FAILED`.

### `rollback-sqs-cooldown`

For the `cdkd rollback` command's harder paths, see
`tests/integration/rollback-sqs-cooldown/` (scenario tags
`rollback-reverse-replacement-name-cooldown` +
`failed-only-journal-retention-cycle`, issue #1218): the reverse-replacement
re-create retrying through the SQS ~60s `QueueDeletedRecently` same-name
cooldown (issue #1206), and the failed-only journal retention cycle after a
clean automatic rollback — retained `auto-rollback-clean` journal, the
next-deploy `--revert-failed` note, `cdkd rollback --force --revert-failed`
consuming it, and the NO-CHANGE fix-forward deploy clearing the journal
(issues #1208 / #1198 / PR #1212).

### `rollback-replay-effective-props`

For the rollback arm that re-creates a REPLACED resource, see
`tests/integration/rollback-replay-effective-props/` (scenario tag
`rollback-replay-effective-properties`, issue #1682). It is deliberately a
different branch from `rollback-failure-injection`, which rolls back CREATEs
(a delete): here the resource was replaced before the failure, so rollback
re-creates the OLD one from `previousState.properties` — a cdkd STATE record,
which can carry a malformed block an older binary wrote and which the provider
WARNS about and SUBSTITUTES rather than refusing (the #1544 `replayWarn`
downgrade). The fixture deploys an `AWS::EC2::Route`, injects a second
destination key into the state record, flips the create-only destination with
a failure wired AFTER the route, and asserts the post-rollback record kept the
SUBSTITUTED bag and that two consecutive `cdkd drift` runs converge. The
vehicle is a route rather than the `AWS::S3::Bucket` the issue names because a
bucket's reverse-replacement re-create has to re-acquire a just-deleted
GLOBALLY unique name, which would make the fixture flaky for a reason
unrelated to what it tests.

### `type-change-replacement`

For a replacement that changes the resource's `Type` on an existing logical id,
see `tests/integration/type-change-replacement/` (scenario tag
`resource-type-change-replacement`). Three rows change type in one deploy: a
stateful `AWS::SSM::Parameter` becoming a topic (refused without
`--force-stateful-recreation`), a parameter becoming a log group of the SAME
name (two types, one physical id), and a topic becoming a log group with an
identical property bag. The fixture asserts every old physical name gone and
every new one read back from AWS, then drives the same change through the
automatic rollback and through `cdkd rollback` from a `--no-rollback` journal,
each of which has to re-create every OLD type through its own provider.

### `rollback-explicit-name-rewrite`

For the name a reverse-replacement asks AWS for, see
`tests/integration/rollback-explicit-name-rewrite/` (scenario tag
`rollback-reverse-replacement-explicit-name-rewrite`, issue #4018). Its subject
is an explicitly named IAM Role, a type whose provider rewrites even a declared
name under the user-supplied-name prefix setting. The fixture reads the setting
each failing deploy recorded in its journal segment, plants a squatter on the
name the re-create will send and asserts `cdkd rollback` refuses it, naming
that name and deleting nothing (issue #4010), then removes the squatter and
asserts the role comes back under exactly its old name. An in-place change of
the role's description is then failed and rolled back, and the role must keep
its name and `RoleId`. A second cycle deploys
with `--prefix-user-supplied-names` and rolls back without it: the recorded
setting must win, so the role comes back prefixed. A third cycle flips the
setting between deploys (issue #4024): the prefixed role is replaced by a
failing deploy WITHOUT the flag, and both `cdkd rollback` and the automatic
rollback must bring it back under its original prefixed name, never the bare
one the failed deploy's setting derives.

### `rollback-replacement-retain`

For the rollback arm that must NOT delete the resource a replacement created,
see `tests/integration/rollback-replacement-retain/` (scenario tag
`rollback-replacement-updatereplacepolicy-retain`, issue #2598). Three
`AWS::SSM::Parameter` subjects are replaced in one failing deploy, one per row
of the behaviour the A/B measured: `UpdateReplacePolicy: Retain` (the new copy
must SURVIVE), no policy (must be GONE), and `DeletionPolicy: Retain` alone
(must also be GONE — the row that refutes "`DeletionPolicy` governs it"). The
three polarities are what make the fixture a discrimination rather than a
blanket refusal: it cannot be satisfied by a cdkd that simply stopped deleting
on this path. It asserts survival by AWS name, that state names only the
re-adopted old copies, and that the durable `ROLLBACK_RESOURCE_SUCCEEDED` event
carries `physicalId` / `reason` / `provisionedBy` for the survivor and carries
none of them for the controls. The subject is a parameter rather than a queue
because a parameter name is released instantly, so the controls' re-create of
the old name is deterministic.

### `rollback-cross-region-secret`

For the rollback arm whose replayed value is a SECRET the deploy resolved in
another region, see `tests/integration/rollback-cross-region-secret/` (scenario
tags `dynamic-reference-resolution` + `getstackoutput-cross-region`, issue
#2057). A producer stack in `us-west-2` exports an output carrying a
`{{resolve:ssm:...}}` SecureString reference; a consumer in `us-east-1` reads it
via `Fn::GetStackOutput`, so the consumer's state persists the PRODUCER's
region-less spelling of that expression while `outputReads[].sourceRegion`
records where it came from. A failing `--no-rollback` deploy then forces
`cdkd rollback --force`, which must exit 2 with
`ROLLBACK_SECRET_REGION_AMBIGUOUS` rather than re-resolving the reference
locally. The discriminator is that the SAME parameter NAME is seeded in BOTH
regions with DIFFERENT values, both asserted to really be `SecureString` first:
without that the run cannot tell a correct resolution from a wrong one, and the
assertion the fixture exists for is that the live parameter still holds the
PRODUCER region's value. `SecureString` rather than a Secrets Manager secret
because a bare parameter NAME is region-less -- which is precisely the arm under
test -- and because there is no deletion cooldown to collide on across repeated
runs. (An SSM reference CAN name a full ARN: `resolveSSMReference` joins its
colon-split tail back together, so an ARN reaches `GetParameter` intact. That
form takes the `named-region` arm and is covered by the unit tests, not here.)

The same fixture also carries the `cdkd drift` half of that defect (issue
[#2108](https://github.com/go-to-k/cdkd/issues/2108)), as phases 2b / 2b2 / 2c on
the CLEAN v1 deploy rather than on the journal -- which is what makes #2108 the
wider of the two: it is reachable from an ORDINARY drift run instead of only
after a failed deploy. Phase 2b asserts `cdkd drift --json` reports `SecretEcho`
in its `notCompared` roll-up and carries `referencesUnresolved`, because a
comparison the region refusal SKIPPED carries no marker otherwise and a CI
consumer would read the skip as a clean bill of health; it also asserts the
EXIT CODE is `2`, which is the marker such a consumer actually reads (pre-#2108
this population exited `1`, because it reported phantom drift). That assertion
is on the REFUSAL population specifically: the exit code is scoped to the causes
a re-run CAN CLEAR -- since issues
[#2151](https://github.com/go-to-k/cdkd/issues/2151) /
[#1945](https://github.com/go-to-k/cdkd/issues/1945) that is a refusal OR a read
that failed, but never everything cdkd did not compare -- so the phase
also asserts the run's own output says `refused to resolve` -- without that, an
exit `2` could have come from the broader `notCompared` bucket, which is
deliberately kept out of the exit code (a stack whose only uncompared property
holds a surviving `{{resolve:...}}` token cdkd resolves for nobody is reported
and still exits `0`; since issue #2482 that is no longer `ssm-secure`, which is
resolved like `ssm` — the unit suite covers that half with a synthetic
spelling, since this fixture has no such resource).

Phases 2b2 / 2c then tamper the live parameter and revert it, and the shape of
that tamper is the load-bearing part. `SecretEcho`'s only secret-bearing
property is `Value`, whose state side is the `{{resolve:ssm:...}}` token the
comparator SKIPS, so tampering `Value` alone leaves the resource `notCompared` and
`runRevert` returns early with "nothing to revert" -- the phase issued live
writes and exercised no revert code at all. It therefore tampers a SECOND,
ordinary property on the same resource (`Description`), and 2b2 asserts the
resource is now reported drifted on `Description` (and NOT on `Value`), still
flagged `referencesUnresolved`, exiting `1` -- drift outranks the refusal in the
exit code. Phase 2c then runs `cdkd drift --revert -y` and asserts the run
reached the per-resource refusal branch: the log carries `refused to re-resolve`
(a string only the revert path produces -- detection says `refused to resolve`),
the run exits `2`, and NEITHER property was written, since the refusal abandons
the whole resource before `provider.update`.

The live-value check that used to be phase 2c's headline is kept, but as a
safety net rather than a discriminator, and its own comment records the
measurement: run against real AWS with the region routing mutated back to
pre-fix behaviour, the revert exited 2 instead of writing, so "the live value is
not the consumer region's secret" is a confluence point a correct refusal and an
unrelated revert failure both produce. The phase then restores both tampered
properties, so the rollback arms below start from the state phase 2 left
behind.

Phase 2d is the `cdkd scrub` arm for issue
[#2109](https://github.com/go-to-k/cdkd/issues/2109), and why it needed a new
resource is worth recording, because the obvious hosts cannot discriminate it.
`cdkd scrub` builds its plaintext -> expression needle map by resolving the
TEMPLATE, so it classifies only a reference that appears there as a LITERAL
`{{resolve:...}}`. Neither stack put the literal and the evidence in one place:
the producer's template carries the literal but records no cross-stack read, so
the classifier answers `local`; the consumer records
`outputReads[].sourceRegion = us-west-2` but its leaf is an `Fn::GetStackOutput`
intrinsic with no literal at all. `tests/integration/dynamic-ref-cross-region/`
has the two-region seeding and no cross-stack machinery whatsoever. An arm on any
of those would have passed with the fix reverted.

`LocalSecretEcho` closes it -- a region-LESS literal reference in the CONSUMER,
the stack that carries the foreign evidence. Phase 2d asserts `cdkd scrub` exits
NON-ZERO with the region-ambiguity refusal naming both the reference and the
producer region (a non-zero exit alone is a confluence point any scrub failure
produces), and that `state.json` is byte-identical afterwards, since a refusal
must leave the document alone. It then scrubs the PRODUCER as the negative
control: the same region-less literal with no foreign read on record must
classify `local` and scrub normally. That control is what stops the positive
assertions from being satisfied by a refusal that fires on everything.

## `sns-subscription-update`

`SNSSubscriptionProvider.update` had NO real-AWS coverage before issue
[#1967](https://github.com/go-to-k/cdkd/issues/1967) -- every existing SNS
fixture either uses the L1 `CfnTopic.subscription` inline list (a different
provider) or an L2 `addSubscription`, whose logical id embeds the target's node
path so a target change is a create+delete pair rather than an update.

The fixture flips `RawMessageDelivery` on an L1 `CfnSubscription`, which is the
only shape that reaches the method: `TopicArn` / `Protocol` / `Endpoint` are all
createOnly, so changing any of them routes to replacement and executes zero
lines of `update()`. Phase 2 asserts the topic ends with exactly ONE
subscription, that the `SubscriptionArn` CHANGED (a fresh `Subscribe` mints a new
GUID, which is what proves the internal delete-then-create ran), and that cdkd
recorded the new ARN. Phase 3 rewrites the state physicalId to a malformed ARN so
`Unsubscribe` throws, and asserts cdkd ABORTS instead of creating -- the
discriminator is that SNS's own `already exists with different attributes` is
ABSENT from the output, which is the real-AWS spelling of "`create()` was never
called".

## `drift-revert`

End-to-end real-AWS test for `cdkd drift` + `cdkd drift --revert`.
Deploys an S3 Bucket (with tags) + SNS Topic (with DisplayName), mutates
them out-of-band via direct AWS SDK calls (`PutBucketTagging`,
`SetTopicAttributes`), and asserts that `cdkd drift` exits with code 1
(drift detected) and that `cdkd drift --revert -y` exits with code 0
(revert succeeded). Run via:

```bash
bash tests/integration/drift-revert/verify.sh
```

The script auto-resolves the AWS account ID, picks the cdkd state
bucket as `cdkd-state-${accountId}`, builds cdkd from the repo root,
and finishes with `cdkd destroy --force`. Catches AWS-shape divergences
and timing flakiness that the per-provider mocked round-trip unit tests
miss.

## `intrinsics-torture`

A real-AWS regression net for cdkd's hand-rolled intrinsic-function resolver
(`src/deployment/intrinsic-function-resolver.ts` and `intrinsic-resolver/*.ts`) that goes beyond the basic
`intrinsic-functions` fixture (Ref / GetAtt / Join / Sub). Each harder
intrinsic — `Fn::Cidr`, `Fn::FindInMap`, `Fn::GetAZs` + `Fn::Select`,
`Fn::Base64`, nested `Fn::Split`/`Fn::Select`/`Fn::Join`, deeply-nested
two-arg `Fn::Sub`, and ALL pseudo-parameters — computes an `AWS::SSM::Parameter`
Value that `verify.sh` reads back from AWS and asserts against an
independently-computed expected value, so a wrong resolution pinpoints the
offending intrinsic.

## `docker-image-asset`

**Tested features** (requires a running Docker daemon — the `verify.sh`
SKIPs gracefully when `docker info` fails):

- cdkd's deploy-time Docker ASSET pipeline (`DockerAssetPublisher`):
  `docker build` of the local Dockerfile, ECR auth, `docker push` to the
  CDK-managed container-assets repo during `cdkd deploy`
- `lambda.DockerImageFunction` (`PackageType=Image`) pointing at the pushed
  ECR image; the `verify.sh` invokes the function to prove the pushed image
  actually runs, then destroys and asserts the pushed image is gone from ECR
- Distinct from the `local-invoke-container` family (which only exercises the
  LOCAL emulation build path and never touches AWS)

## `iam-propagation-stress`

**Tested behavior** — a race detector for IAM-propagation bugs on cdkd's fast
SDK path. cdkd creates an IAM role and has a service assume it within ~1s,
before IAM finishes propagating; CloudFormation tolerates this via deployment
latency, cdkd does not. The race is handled narrowly today (RDS #794, ECS
CapacityProvider #805, Custom Resource #756) but many consumers are
unprotected:

- Four brand-new IAM roles, each consumed IMMEDIATELY by a DIFFERENT service
  in ONE deploy: Lambda exec role -> `CreateFunction`; SFN role ->
  `CreateStateMachine`; EventBridge target role -> `PutTargets`; fresh
  principal -> `AWS::SQS::QueuePolicy` + `AWS::SNS::TopicPolicy`.
- **The pass condition is: deploy SUCCEEDS.** A failure is a real cdkd finding
  (an unprotected consumer racing IAM propagation); `verify.sh` prints which
  resource failed + the error for triage, then still cleans up.
- On success it asserts each role consumer works (invoke the Lambda, run an
  SFN execution to `SUCCEEDED`, confirm the rule's SFN target + role, confirm
  the queue/topic resource policies), then destroys clean.

## `custom-resource-provider`

- CDK Provider framework with isCompleteHandler/onEventHandler
- Async pattern detection and polling
- Pre-signed URL for cfn-response (2hr validity)
- A delete handler that RETURNS `Status: FAILED` (env-gated by
  `CDKD_TEST_UPDATE=cr-delete-fails`, issue
  [#2054](https://github.com/go-to-k/cdkd/issues/2054)): the destroy must exit 2,
  report the row as skipped, KEEP the state record and leave the handler's
  resource live -- a handler that says it did not delete must never be recorded
  as deleted. The arm cleans that resource up out of band, since cdkd
  deliberately will not.
- The synthetic `StackId` handed to the handler carries the REAL account and
  region (issue [#1866](https://github.com/go-to-k/cdkd/issues/1866)); the arm
  asserts the exact ARN and explicitly rejects the pre-fix fabricated pair.

This fixture runs through its own `verify.sh` (it was a `standard`-flow test
before the go-to-k/cdkd#2054 arm landed), so drive it with `/run-integ
custom-resource-provider` rather than by hand.

## Coverage matrices: what CI enforces

Each matrix is regenerated by a task and committed. The `check-build-test` job
in `.github/workflows/ci.yml` reruns the task and fails on a non-empty
`git diff`, so a stale file cannot reach `main`.

### Integration coverage

This regenerates both `docs/integ-coverage.md` (human-readable report) and
`docs/_generated/integ-coverage.json` (machine-readable matrix). Run it after
adding a new provider or new integ fixture; the file is checked into the repo so
reviewers can see coverage shifts in the PR diff. **CI hard-fails when the
committed snapshot is stale**: the `check-build-test` job in
`.github/workflows/ci.yml` runs `vp run integ-coverage` and fails on a non-empty
`git diff` of these two files, so a forgotten regeneration cannot reach main.

A new `registry.register('AWS::Foo::Bar', ...)` is expected to arrive with a
matching integ fixture — the matrix recognises one by the literal type id, by a
`Cfn<Type>(` L1 class, or by a sidecar entry in
`.claude/integ-coverage-allowlist.json`. The sidecar is JSON: `{"AWS::Foo::Bar":
"rationale"}`, kept outside `src/provisioning/register-providers.ts` so an
allow-list edit is not a change to provider registration. Nothing blocks the
commit; the regenerated matrix is where a missing fixture shows up in the PR
diff.

### CLI flag coverage

**The coverage numbers are a visibility report, NOT a CI gate.** Many cdkd flags
(`--dry-run`, `--verbose`, `--profile`, etc.) are tested adequately at the
unit-test level rather than via an integ shell invocation — surfacing those as
"uncovered" would produce >50% false-positive noise. The "no integ verify.sh
mention" section is a question for the reviewer ("does THIS flag warrant a
real-AWS test?"), not an answer.

**CI hard-fails on staleness** (issue #1071): the `check-build-test` job in
`.github/workflows/ci.yml` runs `vp run cli-flag-coverage` and fails on a
non-empty `git diff` of the regenerated `docs/cli-flag-coverage.md` /
`docs/_generated/cli-flag-coverage.json`, so a forgotten regeneration cannot
reach main. Same staleness shape as the integ-coverage / scenario-coverage
matrices — it guards freshness of the generated file, not coverage %.

### Scenario coverage

Empty `[]` means "intentionally no canonical scenario applies" (per-service
smoke tests). Absent file means "not yet annotated" — surfaced in the
un-annotated section of the report. The canonical taxonomy is defined as
`KNOWN_SCENARIOS` in
[scripts/build-scenario-coverage-matrix.ts](https://github.com/go-to-k/cdkd/blob/main/scripts/build-scenario-coverage-matrix.ts);
a sidecar tag outside the taxonomy is hard-rejected at parse time, so typos
surface immediately.

**Visibility-only, NOT a CI gate** on per-fixture coverage. Same rationale as
the CLI-flag matrix: many fixtures legitimately exercise no canonical scenario,
and forcing per-commit annotation would add friction without proportional value.
The intended consumer is the contributor reviewing "does THIS real-AWS pattern
have an integ backstop?" — an orphan scenario in the matrix IS the value signal.
**CI hard-fails on staleness**: the `check-build-test` job in
`.github/workflows/ci.yml` runs `vp run scenario-coverage` and fails on a
non-empty `git diff` of the regenerated `docs/scenario-coverage.md` /
`docs/_generated/scenario-coverage.json`, so a forgotten regeneration or a
typo'd tag cannot reach main.

Adding a new scenario: (1) add an entry to `KNOWN_SCENARIOS` with a one-line
description in
[scripts/build-scenario-coverage-matrix.ts](https://github.com/go-to-k/cdkd/blob/main/scripts/build-scenario-coverage-matrix.ts);
(2) tag existing fixtures that exercise it (or write a new one); (3) `vp run
scenario-coverage` to regenerate.

### Integ-run ledger

Unlike the three matrices above it is not derived from the tree — it is
accumulated run history, so it cannot simply be regenerated. What IS enforced is
its **shape**: exactly one row per test, rows sorted by test name. `vp run
integ-ledger-normalize` rewrites the file into that shape (keeping the newest
`last_run_iso` per test), and `--check` reports violations without writing.

**CI hard-fails on a non-normalized file** (issue
[#1112](https://github.com/go-to-k/cdkd/issues/1112)): the `check-build-test`
job runs the task and fails on a non-empty `git diff`, same shape as the
staleness gates above.

The sort order is load-bearing, not cosmetic. The pre-fix write path dropped the
test's old row and appended a new one; under rebase that append was replayed
against a base that already contained the row, so git took both sides and the
row silently duplicated — 10 tests on `main` were affected before this landed. A
deterministic whole-file rewrite makes a replayed commit reproduce the file
byte-for-byte instead, so the duplication cannot be created in the first place.
Never hand-edit the file; record the run, then run the task.

## Related

- [Testing](testing.md)
- [Integration fixture conventions](integ-fixture-conventions.md)
