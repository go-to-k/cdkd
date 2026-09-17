---
description: how cdkd decides that a create failed because the NAME is taken - the two predicates, why one reads the error rather than the message, and the rule for admitting an exception name
paths:
  - 'src/deployment/retryable-errors.ts'
  - 'src/deployment/deploy-engine.ts'
  - 'src/deployment/rollback-executor.ts'
---

# Name-collision classification

Sibling rule on this same file: [cloud-control-wait.md](cloud-control-wait.md)
— why a Cloud Control poll failure must NEVER be answered by a new entry in the
pattern table below (issue
[#3236](https://github.com/go-to-k/cdkd/issues/3236)). Indexed from here rather
than from `layout-deployment.md` because that file is loaded by
`secret-redaction.ts`, which had 33 bytes of payload headroom.

Pointed at from [layout-deployment.md](layout-deployment.md). Split out under
issue [#3208](https://github.com/go-to-k/cdkd/issues/3208) for the reason
[delete-outcome.md](delete-outcome.md) and
[rollback-replay-create.md](rollback-replay-create.md) were: that file's
`src/deployment/**` glob loads it into every session touching any file in the
directory, and this entry took `secret-redaction.ts`'s payload over its
102,000 B cap. The `paths:` glob here is the three files that actually consult
these predicates.

**Everything below governs a DESTRUCTIVE decision.** Both consumers react to a
positive verdict by DELETING something: the deploy engine's `--replace`
delete-first fallback removes the live old resource, and the rollback
executor's reverse-replacement arm removes the live new one. A false positive
is not a wasted retry, it is a deleted resource.

## `isNameCollisionError(message)` — issue [#1207](https://github.com/go-to-k/cdkd/issues/1207)

Shared by the deploy engine's replacement create-first detection / `--replace`
delete-first retry and the rollback executor's reverse-replacement path. NOT in
the transient table — a collision is only retryable where the old name holder
was just deleted.

Accepts BOTH spellings: Lambda raises the SINGULAR `Function already exist:`,
so a plural-only pattern left every `AWS::Lambda::Function` off the collision
path (#1625). A lookbehind refuses negated / modal forms ("does NOT already
exist", "MUST already exist") — the modal one is the biter, since a create
rejected for a missing PREREQUISITE would otherwise be reported as a collision
pointing at `--replace`, and following that advice deletes the live old
resource before the re-create fails again for the same reason.

## `isNameCollisionErrorFrom(error, logicalId)` — issue [#3208](https://github.com/go-to-k/cdkd/issues/3208)

What the four sites HOLDING the error now call (two of them DELETE on a true verdict). The string form stays,
unchanged, for callers that genuinely have only text; this is strictly
additive, so nothing that matched before stops matching.

It walks the bounded `cause` chain (the file's shared `MAX_CAUSE_CHAIN_DEPTH`)
for the NAME. **Two properties of that walk are load-bearing, and a future lane
must not relax either.**

**1. The message is read at depth 0 ONLY, and only off a real `Error`.** That
combination makes the MESSAGE READ identical to the call sites' pre-#3208
`err instanceof Error ? err.message : String(err)`. Scoped deliberately: the
PREDICATE as a whole is not byte-identical, because the anchor below can return
`false` where the old message-only test returned `true`. That direction is
fail-safe — the op fails with both resources intact — and is the anchor's whole
point, but do not read this as "nothing changed". Reading prose down
the chain is a far larger widening than the NAME fix needs, and it is the read
this area already refuses to make unconditionally — `retryClassificationText`
gates the identical chain-text read behind an explicit marker, for a merely
RETRY decision. Here the verdict is a DELETE.

The `instanceof Error` half is not decoration: review caught a revision reading
`.message` off ANY object, which would have made a thrown
`{ message: 'X already exists' }` start matching where it used to stringify to
`[object Object]` and not match — a widening in the DELETE direction, under a
comment claiming byte-identical behaviour. Do not "simplify" it back.

**2. The walk is ANCHORED on `logicalId`, checked FIRST at every depth** —
ahead of both reads, the same ordering and the same reason as
`isUpdateUnsupportedError`. A link naming another resource returns `false`
immediately. Ordering the anchor after a read would leave the immunity
incidental, resting on whichever wrapper happens to quote no AWS text.

It is a GENERAL fence, not a fix for one measured chain. An earlier revision of
this file justified it with a specific nested-stack path — a child's
`ProvisioningError` reaching the parent's chain — and that was measured FALSE:
`NestedStackProvider` throws a fresh `Error` with no `cause` (zero `cause:` in
that file), so a child provider error does not reach the parent's chain today.
Recorded because a future lane that checks the old justification, finds it
false, and deletes the anchor would be acting on the wrong premise.

**Residual, and it is WORSE here than in the sibling**: the anchor compares
logical IDS, so a CHILD resource whose logical id EQUALS the parent
`AWS::CloudFormation::Stack`'s passes at every link, and that child's rejection
classifies the parent. Reachable via CDK's `overrideLogicalId`. For
`isUpdateUnsupportedError` that costs a replacement; here it costs the
`--replace` delete-first destroying the live child stack. One operator authors
both templates, so it is self-inflicted rather than a trust boundary — but the
anchor is not total.

Both are pinned in `tests/unit/deployment/retryable-errors.test.ts` (the depth-0
gating and the anchor each have a case that reds when it is removed, measured)
and from the rollback side in
`tests/unit/deployment/rollback-executor-name-collision-route.test.ts`.

**ELBv2 is why it exists.** Measured live (us-east-1, 2026-09-16), a duplicate
target-group name answers:

```
name    = DuplicateTargetGroupNameException
message = A target group with the same name 'x' exists, but with different settings
cause   = none
```

No `already exist`, no code in the text — so the message predicate cannot see
it, and the NAME that does say it is dropped by the provider's
`Failed to create X: ${err.message}` wrap. BOTH recovery paths therefore went
inert for those types, and a create-only change to a cdkd-named target group
was undeployable with or without `--replace` (the deploy died at the forward
replacement reporting `No completed operations to roll back`). The cause walk
is what reaches the SDK error at all; providers are required to thread the
caught value as `cause`, enforced by `scripts/check-provider-error-cause.ts`.

## The rule for admitting a name to `NAME_COLLISION_ERROR_NAMES`

**The list is the NARROW exception to this area's refusal to classify by name,
not a reversal of it.** That refusal is load-bearing: Lambda's
`ResourceConflictException` ALSO means "the function is in a PENDING state", so
crediting that name would delete a live function under `--replace`.

A name is admissible only when the service declares it for the duplicate-name
condition **and nothing else** — no second reading to be wrong about. Two ELBv2
siblings fail that test and are pinned as excluded:
`DuplicateListenerException` reports a listener already bound to that PORT,
which is not a name, and `DuplicateTagKeysException` reports repeated keys
WITHIN one request, which is not an existence condition at all. Crediting
either would hand a destructive path a "collision" no delete can clear.

The set is COMPLETE rather than illustrative: `Duplicate*NameException` over
every installed `@aws-sdk/client-*` model yields exactly three, all ELBv2.

**Do not widen the prose matcher to a bare `exists` instead.** It is
substring-matched against every service's text, and the direction of a false
positive is a DELETE. That option was considered and rejected.

Real-AWS net: `tests/integration/elbv2-same-name-replacement/`, measured
FAILING on a pre-fix binary and passing with the fix — so it discriminates
rather than merely passing.
