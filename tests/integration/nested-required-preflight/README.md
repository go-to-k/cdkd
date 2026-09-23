# Nested required pre-flight

Integ probe for issue #1802: cdkd's deploy pre-flight refuses a PRESENT nested
property block that omits a member CloudFormation requires, before any AWS call.

## Configuration

One stack, two `AWS::SQS::Queue` resources:

- **Queue**: tag `owner=cdkd`. With `CDKD_TEST_PARTIAL=true` the tag loses its
  `Value`, which pre-flight must refuse.
- **GuardedQueue**: its partial tag sits in the unused arm of an `Fn::If`, so
  pre-flight must let it through (the fail-safe direction).

## Run

```bash
STATE_BUCKET=<bucket> ./verify.sh
```

Phases: refusal on a fresh stack (nothing created, no state) -> clean deploy ->
refusal on the deployed stack (live tag intact) -> destroy.
