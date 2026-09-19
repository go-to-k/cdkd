---
description: 'The refusal class that propagates out of Fn::Sub and its throw sites'
paths:
  - 'src/deployment/intrinsic-function-resolver.ts'
  - 'src/utils/error-handler.ts'
  - 'src/deployment/secret-region-classification.ts'
  - 'src/cli/commands/scrub.ts'
  - 'src/cli/commands/drift.ts'
---

# Intrinsic-resolution refusals

Issue [#1740](https://github.com/go-to-k/cdkd/issues/1740). Per-site reasons:
`IntrinsicResolutionRefusalError`'s JSDoc in `error-handler.ts`.

- Warn-and-keep-the-raw-`${...}` answers an unknown `Fn::Sub` variable, and must
  NEVER answer a deliberate refusal: that ships a literal
  `${Resource.Attribute}` to AWS under a green deploy.
- Refusals throw `IntrinsicResolutionRefusalError` and the `Fn::Sub` catch
  RE-RAISES it. Refusing arms: `guardedPhysicalIdFallback`'s `*Arn` / `*Url`
  shape hard-fail, `--strict-getatt`, `rejectPlaceholderArnAttribute`, the
  fabricated-account guard, a declared resource, and an unbound declared
  parameter with no `Default`. An UNDECLARED head still warns, as does a bound
  or defaulted parameter. `resolveSplit`'s two refusals and
  `refuseCoercedInheritedSecret` use the class too: a refusal is a property of
  the THROW, not of the catch that inspects it.
- **`cdkd scrub` needs a distinction the base class cannot make.** A PERMANENT
  refusal is an unremediable FINDING (the rest of the stack is still scrubbed,
  exit non-zero); a USER-FIXABLE one must REFUSE the stack, since a re-run after
  the fix scrubs it. Exactly one site is permanent — `resolveGetStackOutput`'s
  cross-account refusal, which throws `CrossAccountSecretRefusalError`. Scrub
  matches THAT subclass: matching the base class downgrades the fixable siblings
  and prints `No plaintext secrets found` over surviving plaintext.
  `MalformedProducerRecordRefusalError` (another stack's damaged record) becomes
  a finding. `cdkd drift` branches on the BASE class.
- **All but the time-dependent sites `markNonRetryable` at the `throw`** — they
  decide from inputs a retry cannot change, yet interpolate template text a
  substring-matching classifier reads as transient. The CLASS stays UNMARKED:
  the fabricated-account arm and `refuseUnservedAttribute` ARE time-dependent.
- **Where the intrinsic SITS decides what the user sees.** In a resource
  property it fails the resource; in a stack Output `deploy` catches it
  per-output and exits 0; in `Conditions`, the class-agnostic
  `evaluateConditions` downgrades it to `false`.
