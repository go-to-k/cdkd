# PR 2: DELETE region verification

**Status**: planned
**Branch**: `feat/delete-region-check`
**Depends on**: none
**Breaking change**: no
**Parallel with**: PR 1, 3, 6, 7

## Goal

Stop treating "resource not found in the AWS client's region" as idempotent
delete success. Before treating a `*NotFound` error as success, verify that
the region the provider is operating against actually matches the region
recorded in the stack's state. If it does not, surface the error.

## Background

In the silent-failure incident, the Lambda function actually existed in
`us-west-2`, but the cdkd client was operating against `us-east-1`. The
provider received `ResourceNotFoundException` and treated it as idempotent
"already gone" success, removing the resource from state. The actual Lambda
remained orphaned in `us-west-2` until manual cleanup.

The current `CLAUDE.md` rule:

> DELETE idempotency (not-found / No policy found treated as success)

is correct in spirit — duplicate-delete must be safe — but it must not
mask region mismatches.

## Scope

### In scope

- Add a region-mismatch check before any provider's `delete` returns
  "success" on a `NotFound` error.
- Log a clear `ProvisioningError` when client region != state region.
- Apply consistently across:
  - All SDK providers (`src/provisioning/providers/*.ts`).
  - The Cloud Control fallback provider (`src/provisioning/cloud-control-provider.ts`).

### Out of scope

- Detecting orphans in *other* regions (this would require a global scan
  per resource type and is impractical).
- Changing how successful deletes are reported.

## Design

The provider's `delete` already receives the `physicalId`. To verify the
region, the provider needs:

- The region of the AWS client it is using (already known).
- The region that the resource is *expected* to live in.

The expected region comes from the stack state's `region` field. Plumb that
through the provider call so each provider can compare:

```typescript
interface ResourceProvider {
  delete(
    physicalId: string,
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context: { expectedRegion?: string },   // NEW
  ): Promise<void>;
}
```

In each provider's `delete` method:

```typescript
try {
  await client.send(new DeleteFooCommand({ ... }));
} catch (err) {
  if (isNotFound(err)) {
    if (context.expectedRegion && context.expectedRegion !== client.config.region) {
      throw new ProvisioningError(
        `Refusing to treat NotFound as idempotent: client region ` +
        `${client.config.region} does not match state region ${context.expectedRegion}.`,
      );
    }
    // genuine idempotent success
    return;
  }
  throw err;
}
```

`client.config.region` resolution: SDK v3 clients expose `await
client.config.region()` (a Provider returning a Promise<string>). The
helper resolves once at provider construction time and caches.

## Implementation steps

1. Extend the `ResourceProvider` interface in
   `src/provisioning/types.ts` to include the `context` parameter on
   `delete` (with `expectedRegion` optional for backwards-compat with any
   external implementations during the transition).
2. Update `DeployEngine` and the destroy command to pass
   `expectedRegion: state.region` when invoking provider deletes.
3. For each SDK provider in `src/provisioning/providers/`:
   - Wrap the existing `NotFound` handling in a region-mismatch check.
   - Emit a `ProvisioningError` with a clear message when the check fails.
4. Update `cloud-control-provider.ts` similarly.
5. Add a shared helper `assertRegionMatch(clientRegion, expectedRegion)` to
   avoid copy-paste, in `src/provisioning/region-check.ts`.
6. Add unit tests using mocked providers with deliberate region mismatch.
7. Update `docs/provider-development.md` and `CLAUDE.md` to document the
   new contract.

## Tests

### Unit (Vitest)

- `tests/unit/provisioning/region-check.test.ts` — the helper itself.
- For each provider's existing test file, add cases:
  - delete with matching region + NotFound → success (existing behavior
    preserved).
  - delete with mismatched region + NotFound → throws
    `ProvisioningError` containing both regions.
  - delete with no `expectedRegion` (fallback) → existing idempotent
    behavior.

### Integration

- Reproduce the silent-failure scenario locally with mocked AWS where
  possible. A real-AWS reproduction is impractical without two real regions
  and live resources, but the unit-level coverage is sufficient given the
  tightness of the check.

## Compatibility verification (Pre-merge checklist)

This PR is **not** a breaking change for users. Internally it is a small
behavioral change to providers; external provider implementations (none
exist today) would need to accept the new context parameter. The check
runs after build and lint as usual.

- [ ] `pnpm run build`
- [ ] `pnpm test` — all existing provider tests still pass.
- [ ] `pnpm run typecheck`
- [ ] `pnpm run lint`
- [ ] Manually grep for any provider implementation that has not been
      updated — every `ResourceProvider` in
      `src/provisioning/providers/` should accept `context`.
- [ ] Run `tests/integration/basic` deploy + destroy end-to-end to confirm
      no regression on the happy path.

## Documentation updates

- `docs/provider-development.md` — Provider contract: explain the
  `context.expectedRegion` parameter and the region-mismatch check.
- `CLAUDE.md` — Provider Pattern section: amend `delete` signature.
  Important Implementation Details: clarify "DELETE idempotency" no
  longer masks region mismatch.

## References

- Silent-failure incident: a Lambda in `us-west-2` returned NotFound
  against a `us-east-1` client and was wrongly removed from state. See
  the `cdkd destroy` log included in the rollout discussion.
- Affected providers: `src/provisioning/providers/lambda-function-provider.ts`
  and every other SDK provider.

## Follow-ups discovered during implementation

(To be filled in as work progresses.)
