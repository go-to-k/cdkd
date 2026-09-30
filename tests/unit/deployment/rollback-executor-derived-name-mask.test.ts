import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

/**
 * Issue #4037: a rollback renders physical ids at a dozen sites, and a
 * physical id can spell a secret-derived NAME in a way the literal masker
 * (`maskSecretsInText`, which matches a plaintext exactly) misses:
 *
 * - a `SENT_NAME_REWRITTEN` provider (IAM, ELBv2) sends `alice@example.com` as
 *   `MyStack-alice-example-com` (stack prefix, `[^A-Za-z0-9-]` -> `-`);
 * - a record whose name is still a `{{resolve:...}}` reference (the NEW
 *   resource's, or any record on an arm that resolves nothing) has no
 *   plaintext in the op's bag at all.
 *
 * Every case drives the REAL `replayRollback` / `replayFailedOperations` with a
 * stub provider (so no provider masks anything on the executor's behalf) and
 * asserts on what the executor itself logs and records. The secret contains
 * `@` and `.`, so every derived spelling differs from the plaintext.
 */

// The real `withRetry`, with instant sleeps: the retry lines are production's.
vi.mock('../../../src/deployment/retry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/deployment/retry.js')>();
  return {
    ...actual,
    withRetry: (
      fn: Parameters<typeof actual.withRetry>[0],
      logicalId: string,
      opts: Parameters<typeof actual.withRetry>[2] = {}
    ) => actual.withRetry(fn, logicalId, { ...opts, sleep: async () => {} }),
  };
});

const SECRET_NAME = 'alice@example.com';
const SECRET_EXPR = '{{resolve:secretsmanager:role-name:SecretString:name::}}';
/** A second secret, never resolved by these ops: only its reference is recorded. */
const OTHER_EXPR = '{{resolve:secretsmanager:other-name:SecretString:name::}}';
/** A secret with a whitespace RUN, which `collisionText` collapses. */
const SPACED_NAME = 'alice  spaced  secret';
const SPACED_EXPR = '{{resolve:secretsmanager:spaced-name:SecretString:name::}}';
/** A secret CONTAINING the derived name `KEPT` (issue #4193). */
const LONGER_SECRET = 'MyStack-alice-example-com owner hunter2x';
const LONGER_EXPR = '{{resolve:secretsmanager:longer-name:SecretString:name::}}';
/** A secret INSIDE the derived name `KEPT` (issue #4193). */
const INNER_EXPR = '{{resolve:secretsmanager:inner-name:SecretString:name::}}';
/** A secret whose fetch fails, with an error quoting the role (issue #4193). */
const UNREADABLE_EXPR = '{{resolve:secretsmanager:unreadable:SecretString:name::}}';
const smSend = vi.fn(async (cmd?: { input?: { SecretId?: string } }) => {
  const id = cmd?.input?.SecretId;
  if (id === 'unreadable') {
    throw new Error('Secret for role MyStack-alice-example-com is unreadable');
  }
  return {
    SecretString: JSON.stringify({
      name:
        id === 'spaced-name'
          ? SPACED_NAME
          : id === 'longer-name'
            ? LONGER_SECRET
            : id === 'inner-name'
              ? 'alice'
              : SECRET_NAME,
    }),
  };
});
vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({ secretsManager: { send: smSend }, ssm: { send: vi.fn() } }),
  setAwsClients: vi.fn(),
  AwsClients: vi.fn(),
}));

import {
  replayFailedOperations,
  replayRollback,
  type CompletedOperation,
  type FailedOperation,
  type RollbackExecutorContext,
} from '../../../src/deployment/rollback-executor.js';
import { resetAccountInfoCache } from '../../../src/deployment/intrinsic-function-resolver.js';
import { finalSnapshotDelays } from '../../../src/provisioning/final-snapshot.js';
import { withSkipPrefix, withStackName } from '../../../src/provisioning/resource-name.js';
import type { DeploymentEvent } from '../../../src/types/deployment-events.js';
import type { ResourceState } from '../../../src/types/state.js';
import { awsSdkError } from '../_aws-sdk-error.js';
import { PASTE_PAYLOADS, spansThatRun, withPasteDir } from '../utils/paste-harness.js';

const STACK = 'MyStack';
const ROLE = 'AWS::IAM::Role';
/** The spelling the provider derives with the stack-name prefix KEPT. */
const KEPT = 'MyStack-alice-example-com';
/** ... and with it SKIPPED. */
const SKIPPED = 'alice-example-com';
const TRUST = { Version: '2012-10-17', Statement: [] };

/** Every spelling of the secret a line must not carry. */
function leaks(text: string): boolean {
  return /alice|example/i.test(text);
}

function makeCtx(provider: Record<string, unknown>): {
  ctx: RollbackExecutorContext;
  lines: string[];
  events: Array<Omit<DeploymentEvent, 'timestamp'>>;
} {
  const lines: string[] = [];
  const events: Array<Omit<DeploymentEvent, 'timestamp'>> = [];
  const push = (m: string): void => {
    lines.push(m);
  };
  const logger = {
    debug: push,
    info: push,
    warn: push,
    error: push,
    setLevel: vi.fn(),
    child: () => logger,
  } as unknown as RollbackExecutorContext['logger'];
  return {
    lines,
    events,
    ctx: {
      region: 'us-east-1',
      logger,
      providerRegistry: {
        getProviderFor: () => ({ provider, provisionedBy: 'sdk' }),
      } as unknown as RollbackExecutorContext['providerRegistry'],
      recordEvent: (e) => events.push(e),
    },
  };
}

function role(physicalId: string, name: unknown, extra: Partial<ResourceState> = {}): ResourceState {
  return {
    physicalId,
    resourceType: ROLE,
    properties: { RoleName: name, AssumeRolePolicyDocument: TRUST },
    attributes: {},
    dependencies: [],
    provisionedBy: 'sdk',
    ...extra,
  };
}

/** A replacement of role `oldId` by `newId`, the old one named `oldName`. */
function replacement(
  oldId: string,
  oldName: unknown,
  newId: string,
  newName: unknown,
  extra: { current?: Partial<ResourceState>; op?: Partial<CompletedOperation> } = {}
): { op: CompletedOperation; state: Record<string, ResourceState> } {
  return {
    op: {
      logicalId: 'R',
      changeType: 'UPDATE',
      resourceType: ROLE,
      physicalId: newId,
      provisionedBy: 'sdk',
      previousState: role(oldId, oldName),
      ...extra.op,
    },
    state: { R: role(newId, newName, extra.current) },
  };
}

/** The replay in the scope a segment recorded with the prefix KEPT gets. */
function replayKept<T>(fn: () => Promise<T>): Promise<T> {
  return withSkipPrefix(false, () => withStackName(STACK, fn));
}

beforeEach(() => {
  smSend.mockClear();
  resetAccountInfoCache();
});

describe('a secret-derived physical id never reaches the rollback log (#4037)', () => {
  it('the "replacement reversed (old resource re-created as ...)" line', async () => {
    const create = vi.fn(async () => ({ physicalId: KEPT, attributes: {} }));
    const del = vi.fn(async () => undefined);
    const { ctx, lines } = makeCtx({ create, delete: del });
    const { op, state } = replacement(KEPT, SECRET_EXPR, 'plain-new', 'plain-new');

    const result = await replayKept(() => replayRollback([op], state, STACK, ctx));

    // Non-vacuity: the secret was resolved, the old id came back, the new one went.
    expect(smSend).toHaveBeenCalled();
    expect(result.failures).toBe(0);
    expect(state['R']?.physicalId).toBe(KEPT);
    expect(del).toHaveBeenCalledWith('R', 'plain-new', ROLE, expect.anything(), expect.anything());
    const reversed = lines.find((l) => l.includes('replacement reversed'));
    expect(reversed).toBe('  Rollback: R replacement reversed (old resource re-created as ***)');
    for (const line of lines) expect(leaks(line), line).toBe(false);
  });

  it('NEGATIVE CONTROL: a plain name is rendered as it is (the mask is not blanket)', async () => {
    const create = vi.fn(async () => ({ physicalId: 'MyStack-a', attributes: {} }));
    const { ctx, lines } = makeCtx({ create, delete: vi.fn(async () => undefined) });
    const { op, state } = replacement('MyStack-a', 'a', 'plain-new', 'plain-new');

    await replayKept(() => replayRollback([op], state, STACK, ctx));

    expect(lines).toContain('  Rollback: R replacement reversed (old resource re-created as MyStack-a)');
  });

  it('the collision arm: "deleting the new resource (...) first" names neither role', async () => {
    // IAM names compare case-insensitively, so the new role (a case variant of
    // the old name) holds it, and the proof lets the new one be deleted first.
    const newId = KEPT.toLowerCase();
    const create = vi
      .fn()
      .mockRejectedValueOnce(
        awsSdkError(`Role with name ${KEPT} already exists.`, 'EntityAlreadyExistsException')
      )
      .mockResolvedValueOnce({ physicalId: KEPT, attributes: {} });
    const del = vi.fn(async () => undefined);
    const { ctx, lines } = makeCtx({ create, delete: del });
    const { op, state } = replacement(KEPT, SECRET_EXPR, newId, SECRET_EXPR);

    const result = await replayKept(() => replayRollback([op], state, STACK, ctx));

    expect(result.failures).toBe(0);
    expect(create).toHaveBeenCalledTimes(2);
    expect(del).toHaveBeenCalledWith('R', newId, ROLE, expect.anything(), expect.anything());
    expect(lines).toContain(
      '  Rollback: re-create collided with the new resource\'s name — deleting the new resource (***) first...'
    );
    for (const line of lines) expect(leaks(line), line).toBe(false);
  });

  it('the Retain re-adopt arm, which resolves nothing: its line, its warning and its event', async () => {
    // The NEW role's name came from ANOTHER secret, which this op never
    // resolves: only its reference is on record.
    const del = vi.fn(async () => undefined);
    const { ctx, lines, events } = makeCtx({ delete: del });
    const { op, state } = replacement(KEPT, SECRET_EXPR, SKIPPED, OTHER_EXPR, {
      op: { oldResourceRetained: true },
      current: { updateReplacePolicy: 'Retain' },
    });

    const result = await replayKept(() => replayRollback([op], state, STACK, ctx));

    expect(smSend).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
    expect(state['R']?.physicalId).toBe(KEPT);
    expect(result.warnings).toBe(1);
    expect(lines).toContain(
      '  Rollback: Reversing replacement of R (AWS::IAM::Role) — deleting the new resource and ' +
        're-adopting the retained old one (***)'
    );
    const survivor = lines.find((l) => l.includes('is RETAINED by this rollback'));
    expect(survivor).toContain("replacement's new physical resource (***)");
    expect(survivor).toContain('State is restored to the old resource (***).');
    for (const line of lines) expect(leaks(line), line).toBe(false);
    const succeeded = events.find((e) => e.eventType === 'ROLLBACK_RESOURCE_SUCCEEDED');
    expect(succeeded?.reason).toBeDefined();
    expect(leaks(succeeded!.reason!)).toBe(false);
    // The FIELD stays exact: it is the cleanup datum, beside the record
    // `state.json` itself holds in the same bucket.
    expect(succeeded?.physicalId).toBe(SKIPPED);
  });

  it('a non-rewriting type: the new copy of a bucket named by an unresolved secret', async () => {
    const BUCKET = 'AWS::S3::Bucket';
    const bucket = (physicalId: string, name: string, extra: Partial<ResourceState> = {}) => ({
      physicalId,
      resourceType: BUCKET,
      properties: { BucketName: name },
      attributes: {},
      dependencies: [],
      ...extra,
    });
    const { ctx, lines, events } = makeCtx({ delete: vi.fn(async () => undefined) });
    const op: CompletedOperation = {
      logicalId: 'B',
      changeType: 'UPDATE',
      resourceType: BUCKET,
      physicalId: 'bob-private-bucket',
      oldResourceRetained: true,
      previousState: bucket('old-public-bucket', 'old-public-bucket'),
    };
    const state = {
      B: bucket('bob-private-bucket', OTHER_EXPR, { updateReplacePolicy: 'Retain' }),
    };

    await replayKept(() => replayRollback([op], state, STACK, ctx));

    const survivor = lines.find((l) => l.includes('is RETAINED by this rollback'));
    expect(survivor).toContain("replacement's new physical resource (***)");
    // The old bucket's plain name is not a secret and stays readable.
    expect(survivor).toContain('State is restored to the old resource (old-public-bucket).');
    for (const text of [...lines, ...events.map((e) => e.reason ?? '')]) {
      expect(text).not.toContain('bob-private');
    }
  });

  it('the id a re-create returned, spelled by the provider its own way', async () => {
    // Neither the plaintext nor a rewriting type's derivation: only the id the
    // create RETURNED, joined to the masker once it exists, can catch it.
    const BUCKET = 'AWS::S3::Bucket';
    const bucket = (physicalId: string, name: string): ResourceState => ({
      physicalId,
      resourceType: BUCKET,
      properties: { BucketName: name },
      attributes: {},
      dependencies: [],
    });
    const create = vi.fn(async () => ({ physicalId: 'alice-at-example-dot-com', attributes: {} }));
    const { ctx, lines } = makeCtx({ create, delete: vi.fn(async () => undefined) });
    const op: CompletedOperation = {
      logicalId: 'B',
      changeType: 'UPDATE',
      resourceType: BUCKET,
      physicalId: 'plain-new',
      previousState: bucket('old-id', SECRET_EXPR),
    };

    await replayKept(() => replayRollback([op], { B: bucket('plain-new', 'plain-new') }, STACK, ctx));

    expect(create).toHaveBeenCalled();
    expect(lines).toContain('  Rollback: B replacement reversed (old resource re-created as ***)');
    for (const line of lines) expect(leaks(line), line).toBe(false);
  });

  it('a managed policy: the re-created ARN carries the derived name inside it', async () => {
    const POLICY = 'AWS::IAM::ManagedPolicy';
    const arn = `arn:aws:iam::123456789012:policy/${KEPT}`;
    const policy = (physicalId: string, name: string): ResourceState => ({
      physicalId,
      resourceType: POLICY,
      properties: { ManagedPolicyName: name, PolicyDocument: TRUST },
      attributes: {},
      dependencies: [],
      provisionedBy: 'sdk',
    });
    const create = vi.fn(async () => ({ physicalId: arn, attributes: {} }));
    const { ctx, lines } = makeCtx({ create, delete: vi.fn(async () => undefined) });
    const op: CompletedOperation = {
      logicalId: 'P',
      changeType: 'UPDATE',
      resourceType: POLICY,
      physicalId: 'arn:aws:iam::123456789012:policy/plain-new',
      provisionedBy: 'sdk',
      previousState: policy(arn, SECRET_EXPR),
    };

    await replayKept(() =>
      replayRollback([op], { P: policy(op.physicalId!, 'plain-new') }, STACK, ctx)
    );

    expect(create).toHaveBeenCalled();
    expect(lines.some((l) => l.includes('replacement reversed (old resource re-created as ***)'))).toBe(
      true
    );
    for (const line of lines) expect(leaks(line), line).toBe(false);
  });

  it('the per-op "Rollback failed for" line and the durable event', async () => {
    // The OTHER setting's spelling: no physical id is it, so only the names
    // derived from the RESOLVED old name can catch it.
    const denied = new Error(
      `User is not authorized to perform: iam:CreateRole on resource: ` +
        `arn:aws:iam::123456789012:role/${SKIPPED}`
    );
    const create = vi.fn().mockRejectedValue(denied);
    const { ctx, lines, events } = makeCtx({ create, delete: vi.fn() });
    const { op, state } = replacement(KEPT, SECRET_EXPR, 'plain-new', 'plain-new');

    const result = await replayKept(() => replayRollback([op], state, STACK, ctx));

    expect(result.failures).toBe(1);
    const failed = lines.find((l) => l.includes('Rollback failed for R'));
    expect(failed).toContain('on resource: arn:aws:iam::123456789012:role/***');
    for (const line of lines) expect(leaks(line), line).toBe(false);
    const event = events.find((e) => e.eventType === 'ROLLBACK_RESOURCE_FAILED');
    expect(event?.error?.message).toContain('role/***');
    expect(leaks(event!.error!.message)).toBe(false);
  });

  it('does not split a longer resolved secret that contains the derived name (#4193)', async () => {
    // The derived name is a needle, and the op also resolved a secret that
    // CONTAINS it. The op's masker must hide that secret whole, not cut it at
    // the needle and print its remainder.
    const create = vi
      .fn()
      .mockRejectedValue(new Error(`Description '${LONGER_SECRET}' is invalid.`));
    const { ctx, lines, events } = makeCtx({ create, delete: vi.fn() });
    const { op, state } = replacement(KEPT, SECRET_EXPR, 'plain-new', 'plain-new', {
      op: {
        previousState: role(KEPT, SECRET_EXPR, {
          properties: {
            RoleName: SECRET_EXPR,
            AssumeRolePolicyDocument: TRUST,
            Description: LONGER_EXPR,
          },
        }),
      },
    });

    const result = await replayKept(() => replayRollback([op], state, STACK, ctx));

    expect(result.failures).toBe(1);
    // The derived name occurs in the text but only INSIDE the longer secret,
    // so the op's masker withholds the whole failure detail (over-masking).
    const failed = lines.find((l) => l.includes('Rollback failed for R'));
    expect(failed).toBe('  Rollback failed for R (UPDATE): ***');
    for (const line of lines) expect(line).not.toContain('hunter2x');
    const event = events.find((e) => e.eventType === 'ROLLBACK_RESOURCE_FAILED');
    expect(event?.error?.message).toContain('***');
    expect(event?.error?.message).not.toContain('hunter2x');
  });

  it('masks a derived name whose inside a secret resolved AFTER the needles were added rewrites (#4193)', async () => {
    // The in-place revert adds the record's ids as needles first, then resolves
    // the desired side (recording `alice`, which is INSIDE the id), then fails
    // resolving the live side with an error quoting the id. The shared catch
    // masks with needles built BEFORE `alice` was recorded, so each needle must
    // be rendered against the bag as it is when the line is masked.
    const update = vi.fn();
    const { ctx, lines, events } = makeCtx({ update });
    const op: CompletedOperation = {
      logicalId: 'R',
      changeType: 'UPDATE',
      resourceType: ROLE,
      physicalId: KEPT,
      provisionedBy: 'sdk',
      previousState: role(KEPT, SECRET_EXPR, {
        properties: { RoleName: SECRET_EXPR, Description: INNER_EXPR, Path: '/' },
      }),
    };
    const state = {
      R: role(KEPT, SECRET_EXPR, {
        properties: { RoleName: SECRET_EXPR, Description: UNREADABLE_EXPR, Path: '/' },
      }),
    };

    const result = await replayKept(() => replayRollback([op], state, STACK, ctx));

    // Non-vacuity: the live side's fetch failed, so no update ran.
    expect(result.failures).toBe(1);
    expect(update).not.toHaveBeenCalled();
    expect(smSend.mock.calls.some((c) => c[0]?.input?.SecretId === 'unreadable')).toBe(true);
    const failed = lines.find((l) => l.includes('Rollback failed for R'));
    expect(failed).toContain('Secret for role *** is unreadable');
    for (const line of lines) expect(leaks(line), line).toBe(false);
    const event = events.find((e) => e.eventType === 'ROLLBACK_RESOURCE_FAILED');
    expect(leaks(event!.error!.message)).toBe(false);
  });

  // The two in-place arms resolve BOTH sides, and each side's name derives
  // spellings of its own: one case per side holding the secret, the other a
  // plain name, so neither side's masks stand in for the other's.
  const sides = [
    ['the previous state', SECRET_EXPR, 'renamed'],
    ['the live record', 'renamed', SECRET_EXPR],
  ] as const;

  it.each(sides)(
    'the in-place revert, the secret on %s: the retry lines (debug and the give-up summary)',
    async (_label, prevName, currentName) => {
      const busy = (): Error =>
        // The id's spelling AND the other setting's, which no id carries.
        Object.assign(new Error(`Role ${KEPT} (${SKIPPED}) is being modified, try again`), {
          name: 'InternalFailure',
          $metadata: { httpStatusCode: 500, requestId: 'req-1' },
        });
      const update = vi.fn().mockRejectedValue(busy());
      const { ctx, lines } = makeCtx({ update });
      const op: CompletedOperation = {
        logicalId: 'R',
        changeType: 'UPDATE',
        resourceType: ROLE,
        physicalId: KEPT,
        provisionedBy: 'sdk',
        previousState: role(KEPT, prevName, {
          properties: { RoleName: prevName, Path: '/' },
        }),
      };
      const state = { R: role(KEPT, currentName) };

      await replayKept(() => replayRollback([op], state, STACK, ctx));

      expect(smSend).toHaveBeenCalled();
      expect(update.mock.calls.length).toBeGreaterThan(1);
      expect(lines.some((l) => l.includes('Retrying R in'))).toBe(true);
      expect(lines.some((l) => l.includes('gave up after'))).toBe(true);
      expect(lines.some((l) => l.includes('Role *** (***) is being modified'))).toBe(true);
      for (const line of lines) expect(leaks(line), line).toBe(false);
    }
  );

  it.each(sides)(
    '--revert-failed, the secret on %s: its failure line and its durable event',
    async (_label, prevName, attemptedName) => {
      // The role is `KEPT`; the message quotes the other setting's spelling.
      const update = vi
        .fn()
        .mockRejectedValue(new Error(`Role ${SKIPPED} cannot be updated: validation failed`));
      const { ctx, lines, events } = makeCtx({ update });
      const op = {
        logicalId: 'R',
        changeType: 'UPDATE',
        resourceType: ROLE,
        physicalId: KEPT,
        provisionedBy: 'sdk',
        previousState: role(KEPT, prevName, { properties: { RoleName: prevName, Path: '/' } }),
        attemptedProperties: { RoleName: attemptedName },
      } as FailedOperation;
      const state = { R: role(KEPT, 'renamed') };

      const result = await withSkipPrefix(true, () =>
        withStackName(STACK, () => replayFailedOperations([op], state, STACK, ctx))
      );

      expect(result.failures).toBe(1);
      expect(
        lines.some((l) => l.includes('Rollback failed for failed-op R') && l.includes('Role ***'))
      ).toBe(true);
      for (const line of lines) expect(leaks(line), line).toBe(false);
      const event = events.find((e) => e.eventType === 'ROLLBACK_RESOURCE_FAILED');
      expect(leaks(event!.error!.message)).toBe(false);
    }
  );

  it('--revert-failed of a partial CREATE, which resolves nothing: the skipped delete names no role', async () => {
    const del = vi.fn(async () => ({ outcome: 'skipped' as const, reason: 'the handler declined' }));
    const { ctx, lines, events } = makeCtx({ delete: del });
    const op = {
      logicalId: 'R',
      changeType: 'CREATE',
      resourceType: ROLE,
      physicalId: KEPT,
      provisionedBy: 'sdk',
      attemptedProperties: { RoleName: SECRET_EXPR },
    } as FailedOperation;
    const state = { R: role(KEPT, SECRET_EXPR) };

    const result = await replayKept(() => replayFailedOperations([op], state, STACK, ctx));

    expect(smSend).not.toHaveBeenCalled();
    expect(del).toHaveBeenCalled();
    expect(result.failures).toBe(1);
    const failed = lines.find((l) => l.includes('Rollback failed for failed-op R'));
    expect(failed).toContain('***');
    for (const line of lines) expect(leaks(line), line).toBe(false);
    const event = events.find((e) => e.eventType === 'ROLLBACK_RESOURCE_FAILED');
    expect(leaks(event!.error!.message)).toBe(false);
  });

  it.each([
    ['DeletionPolicy: Retain', {}, { deletionPolicy: 'Retain' as const }],
    ['--orphan', { orphanLogicalIds: new Set(['R']) }, {}],
  ])(
    'a rolled-back CREATE left in AWS (%s): the event reason names no role, its field stays exact',
    async (_label, options, extra) => {
      const { ctx, lines, events } = makeCtx({ delete: vi.fn() });
      const op: CompletedOperation = {
        logicalId: 'R',
        changeType: 'CREATE',
        resourceType: ROLE,
        physicalId: KEPT,
        provisionedBy: 'sdk',
        properties: { RoleName: SECRET_EXPR },
      };
      const state = { R: role(KEPT, SECRET_EXPR, extra) };

      await replayKept(() => replayRollback([op], state, STACK, ctx, options));

      const succeeded = events.find((e) => e.eventType === 'ROLLBACK_RESOURCE_SUCCEEDED');
      expect(succeeded?.reason).toContain('in AWS as ***');
      expect(leaks(succeeded!.reason!)).toBe(false);
      expect(succeeded?.physicalId).toBe(KEPT);
      for (const line of lines) expect(leaks(line), line).toBe(false);
    }
  );

  it('the unproven-holder refusal: neither the old id nor the quoted collision', async () => {
    // The new role `plain-new` cannot hold the old name, so nothing is deleted.
    const create = vi
      .fn()
      .mockRejectedValue(
        awsSdkError(`Role with name ${KEPT} already exists.`, 'EntityAlreadyExistsException')
      );
    const del = vi.fn();
    const { ctx, lines, events } = makeCtx({ create, delete: del });
    const { op, state } = replacement(KEPT, SECRET_EXPR, 'plain-new', 'plain-new');

    const result = await replayKept(() => replayRollback([op], state, STACK, ctx));

    expect(result.failures).toBe(1);
    expect(del).not.toHaveBeenCalled();
    const failed = lines.find((l) => l.includes('Cannot reverse the replacement of R'));
    // `safe()` quotes a value that is not a plain identifier, the mask included.
    expect(failed).toContain('the re-create of the old resource ("***") collided');
    expect(failed).toContain('Role with name *** already exists.');
    for (const line of lines) expect(leaks(line), line).toBe(false);
    for (const e of events) expect(leaks(e.error?.message ?? '')).toBe(false);
  });

  it('the Retain-pinned collision refusal: both ids', async () => {
    const newId = KEPT.toLowerCase();
    const create = vi
      .fn()
      .mockRejectedValue(
        awsSdkError(`Role with name ${KEPT} already exists.`, 'EntityAlreadyExistsException')
      );
    const { ctx, lines } = makeCtx({ create, delete: vi.fn() });
    const { op, state } = replacement(KEPT, SECRET_EXPR, newId, SECRET_EXPR, {
      current: { updateReplacePolicy: 'Retain' },
    });

    const result = await replayKept(() => replayRollback([op], state, STACK, ctx));

    expect(result.failures).toBe(1);
    const failed = lines.find((l) => l.includes('UpdateReplacePolicy: Retain pins'));
    expect(failed).toContain(
      'the re-create of the old resource ("***") collided with the name still held by the new one ("***")'
    );
    for (const line of lines) expect(leaks(line), line).toBe(false);
  });

  it('the re-create that fails after the new role was deleted first', async () => {
    const newId = KEPT.toLowerCase();
    const create = vi
      .fn()
      .mockRejectedValueOnce(
        awsSdkError(`Role with name ${KEPT} already exists.`, 'EntityAlreadyExistsException')
      )
      .mockRejectedValue(new Error('Rate exceeded for this account'));
    const { ctx, lines } = makeCtx({ create, delete: vi.fn(async () => undefined) });
    const { op, state } = replacement(KEPT, SECRET_EXPR, newId, SECRET_EXPR);

    const result = await replayKept(() => replayRollback([op], state, STACK, ctx));

    expect(result.failures).toBe(1);
    const failed = lines.find((l) => l.includes('after the new resource'));
    expect(failed).toContain('Failed to re-create the old R after the new resource (***) was already deleted');
    for (const line of lines) expect(leaks(line), line).toBe(false);
  });

  it('the new role that cannot be deleted after the re-create: its warning and its event', async () => {
    // The new role's name came from another secret this op never resolves.
    const create = vi.fn(async () => ({ physicalId: KEPT, attributes: {} }));
    const del = vi.fn().mockRejectedValue(new Error(`Cannot delete entity ${SKIPPED}, it is in use`));
    const { ctx, lines, events } = makeCtx({ create, delete: del });
    const { op, state } = replacement(KEPT, SECRET_EXPR, SKIPPED, OTHER_EXPR);

    const result = await replayKept(() => replayRollback([op], state, STACK, ctx));

    expect(result.warnings).toBe(1);
    const warned = lines.find((l) => l.includes('deleting the new resource (***) failed'));
    expect(warned).toContain('Cannot delete entity ***, it is in use');
    for (const line of lines) expect(leaks(line), line).toBe(false);
    const succeeded = events.find((e) => e.eventType === 'ROLLBACK_RESOURCE_SUCCEEDED');
    expect(succeeded?.reason).toBeDefined();
    expect(leaks(succeeded!.reason!)).toBe(false);
    expect(succeeded?.physicalId).toBe(SKIPPED);
  });

  it('the name-idempotent create that returned the live role', async () => {
    const create = vi.fn(async () => ({ physicalId: KEPT, attributes: {} }));
    const del = vi.fn();
    const { ctx, lines } = makeCtx({ create, delete: del });
    const { op, state } = replacement(`${KEPT}-old`, SECRET_EXPR, KEPT, SECRET_EXPR);

    const result = await replayKept(() => replayRollback([op], state, STACK, ctx));

    expect(del).not.toHaveBeenCalled();
    expect(result.warnings).toBe(1);
    expect(lines.some((l) => l.includes('the re-create returned the LIVE new resource (***)'))).toBe(
      true
    );
    expect(lines).toContain(
      '  Rollback: R adopted the live resource (***) — replacement NOT fully reversed (name-idempotent Create API)'
    );
    for (const line of lines) expect(leaks(line), line).toBe(false);
  });

  // Review round of #4099: the sites and shapes the first round left unpinned.

  it('the create-first path with a Retain-pinned new copy: the survivor warning', async () => {
    const create = vi.fn(async () => ({ physicalId: KEPT, attributes: {} }));
    const del = vi.fn();
    const { ctx, lines, events } = makeCtx({ create, delete: del });
    const { op, state } = replacement(KEPT, SECRET_EXPR, SKIPPED, OTHER_EXPR, {
      current: { updateReplacePolicy: 'Retain' },
    });

    const result = await replayKept(() => replayRollback([op], state, STACK, ctx));

    expect(create).toHaveBeenCalledTimes(1);
    expect(del).not.toHaveBeenCalled();
    expect(result.warnings).toBe(1);
    const survivor = lines.find((l) => l.includes('is RETAINED by this rollback'));
    expect(survivor).toContain("replacement's new physical resource (***)");
    expect(survivor).toContain('State records the re-created old resource (***).');
    for (const line of lines) expect(leaks(line), line).toBe(false);
    const succeeded = events.find((e) => e.eventType === 'ROLLBACK_RESOURCE_SUCCEEDED');
    expect(succeeded?.reason).toBeDefined();
    expect(leaks(succeeded!.reason!)).toBe(false);
  });

  it('the retry after deleting the new role first: its retry lines', async () => {
    const newId = KEPT.toLowerCase();
    const create = vi
      .fn()
      .mockRejectedValueOnce(
        awsSdkError(`Role with name ${KEPT} already exists.`, 'EntityAlreadyExistsException')
      )
      // The name is released late: the retry loop's line quotes the OTHER
      // setting's spelling, which no id carries.
      .mockRejectedValueOnce(
        awsSdkError(`Role with name ${SKIPPED} already exists.`, 'EntityAlreadyExistsException')
      )
      .mockResolvedValueOnce({ physicalId: KEPT, attributes: {} });
    const { ctx, lines } = makeCtx({ create, delete: vi.fn(async () => undefined) });
    const { op, state } = replacement(KEPT, SECRET_EXPR, newId, SECRET_EXPR);

    const result = await replayKept(() => replayRollback([op], state, STACK, ctx));

    expect(result.failures).toBe(0);
    expect(create).toHaveBeenCalledTimes(3);
    expect(lines.some((l) => l.includes('Retrying R in') && l.includes('Role with name ***'))).toBe(
      true
    );
    for (const line of lines) expect(leaks(line), line).toBe(false);
  });

  it('--revert-failed: its retry lines', async () => {
    const update = vi.fn().mockRejectedValue(
      Object.assign(new Error(`Role ${SKIPPED} is being modified, try again`), {
        name: 'InternalFailure',
        $metadata: { httpStatusCode: 500, requestId: 'req-1' },
      })
    );
    const { ctx, lines } = makeCtx({ update });
    const op = {
      logicalId: 'R',
      changeType: 'UPDATE',
      resourceType: ROLE,
      physicalId: KEPT,
      provisionedBy: 'sdk',
      previousState: role(KEPT, SECRET_EXPR, { properties: { RoleName: SECRET_EXPR, Path: '/' } }),
      attemptedProperties: { RoleName: 'renamed' },
    } as FailedOperation;

    await withSkipPrefix(true, () =>
      withStackName(STACK, () =>
        replayFailedOperations([op], { R: role(KEPT, 'renamed') }, STACK, ctx)
      )
    );

    expect(update.mock.calls.length).toBeGreaterThan(1);
    expect(lines.some((l) => l.includes('Retrying R in') && l.includes('Role ***'))).toBe(true);
    for (const line of lines) expect(leaks(line), line).toBe(false);
  });

  it.each(['revert', '--revert-failed'] as const)(
    'the %s arm: a partial update names no role in its warning or its event',
    async (arm) => {
      const update = vi.fn(async () => ({
        outcome: 'partial' as const,
        reason: `the old role ${SKIPPED} survives`,
      }));
      const { ctx, lines, events } = makeCtx({ update });
      const previousState = role(KEPT, SECRET_EXPR, {
        properties: { RoleName: SECRET_EXPR, Path: '/' },
      });
      const state = { R: role(KEPT, 'renamed') };
      const base = { logicalId: 'R', resourceType: ROLE, physicalId: KEPT, provisionedBy: 'sdk' };
      await replayKept(() =>
        arm === 'revert'
          ? replayRollback(
              [{ ...base, changeType: 'UPDATE', previousState } as CompletedOperation],
              state,
              STACK,
              ctx
            )
          : replayFailedOperations(
              [
                {
                  ...base,
                  changeType: 'UPDATE',
                  previousState,
                  attemptedProperties: { RoleName: 'renamed' },
                } as FailedOperation,
              ],
              state,
              STACK,
              ctx
            )
      );

      expect(update).toHaveBeenCalledTimes(1);
      expect(lines.some((l) => l.includes('the old role *** survives'))).toBe(true);
      for (const line of lines) expect(leaks(line), line).toBe(false);
      const succeeded = events.find((e) => e.eventType === 'ROLLBACK_RESOURCE_SUCCEEDED');
      expect(succeeded?.reason).toContain('the old role *** survives');
    }
  );

  it('a record whose physical id is not a string still completes (the mask is total)', async () => {
    const { ctx, lines } = makeCtx({ delete: vi.fn() });
    const { op, state } = replacement(KEPT, SECRET_EXPR, SKIPPED, OTHER_EXPR, {
      op: { oldResourceRetained: true, physicalId: undefined },
      current: { updateReplacePolicy: 'Retain', physicalId: 7 as unknown as string },
    });

    const result = await replayKept(() => replayRollback([op], state, STACK, ctx));

    expect(result.failures).toBe(0);
    expect(lines).toContain('  Rollback: R restored to the retained old resource');
  });

  it('a name recorded as the whole mask (a NoEcho value): its id is withheld too', async () => {
    const { ctx, lines } = makeCtx({ delete: vi.fn() });
    // The OLD role has a plain name that starts with the stack name: the mask
    // must not "derive" `MyStack` from `***` and cut it (#4099 review).
    const { op, state } = replacement('MyStack-OtherRole', 'OtherRole', SKIPPED, '***', {
      op: { oldResourceRetained: true },
      current: { updateReplacePolicy: 'Retain' },
    });

    await replayKept(() => replayRollback([op], state, STACK, ctx));

    const survivor = lines.find((l) => l.includes('is RETAINED by this rollback'));
    expect(survivor).toContain("replacement's new physical resource (***)");
    expect(survivor).toContain('State is restored to the old resource (MyStack-OtherRole).');
    expect(
      lines.some((l) => l.includes('re-adopting the retained old one (MyStack-OtherRole)'))
    ).toBe(true);
    for (const line of lines) expect(leaks(line), line).toBe(false);
  });

  it('a type neither name table knows: a Redshift cluster named by an unresolved secret', async () => {
    const CLUSTER = 'AWS::Redshift::Cluster';
    const cluster = (physicalId: string, name: string, extra: Partial<ResourceState> = {}) => ({
      physicalId,
      resourceType: CLUSTER,
      properties: { ClusterIdentifier: name, NodeType: 'ra3.xlplus' },
      attributes: {},
      dependencies: [],
      ...extra,
    });
    const { ctx, lines, events } = makeCtx({ delete: vi.fn() });
    const op: CompletedOperation = {
      logicalId: 'C',
      changeType: 'UPDATE',
      resourceType: CLUSTER,
      physicalId: 'bob-private-x',
      oldResourceRetained: true,
      previousState: cluster('old-public-cluster', 'old-public-cluster'),
    };
    const state = {
      C: cluster('bob-private-x', OTHER_EXPR, { updateReplacePolicy: 'Retain' }),
    };

    await replayKept(() => replayRollback([op], state, STACK, ctx));

    const survivor = lines.find((l) => l.includes('is RETAINED by this rollback'));
    expect(survivor).toContain("replacement's new physical resource (***)");
    for (const text of [...lines, ...events.map((e) => e.reason ?? '')]) {
      expect(text).not.toContain('bob-private');
    }
  });

  it('a DeletionPolicy: Snapshot rollback: the snapshot lines name neither the cluster nor its snapshot', async () => {
    // Mixed case, so the snapshot identifier (lowercased) is a spelling the
    // id alone does not match.
    const clusterId = 'Bob-Private-Cluster';
    const sleep = vi.spyOn(finalSnapshotDelays, 'sleep').mockResolvedValue(undefined);
    let describes = 0;
    const redshiftSend = vi.fn(async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      switch (command.constructor.name) {
        case 'DescribeClusterSnapshotsCommand':
          return command.input['SnapshotIdentifier'] === undefined
            ? { Snapshots: [] }
            : { Snapshots: [{ Status: 'available' }] };
        case 'DescribeClustersCommand':
          // Busy once, so the settle wait's DEBUG line (which names the
          // cluster) fires through the helper's debug sink too.
          return { Clusters: [{ ClusterStatus: ++describes === 1 ? 'modifying' : 'available' }] };
        default:
          return {};
      }
    });
    const del = vi.fn(async () => undefined);
    const { ctx, lines } = makeCtx({ delete: del });
    ctx.finalSnapshotClients = {
      ec2: {},
      redshift: { send: redshiftSend },
      elastiCache: {},
    } as unknown as NonNullable<RollbackExecutorContext['finalSnapshotClients']>;
    const op: CompletedOperation = {
      logicalId: 'C',
      changeType: 'CREATE',
      resourceType: 'AWS::Redshift::Cluster',
      physicalId: clusterId,
      provisionedBy: 'sdk',
      properties: { ClusterIdentifier: OTHER_EXPR },
    };
    const state = {
      C: {
        physicalId: clusterId,
        resourceType: 'AWS::Redshift::Cluster',
        properties: { ClusterIdentifier: OTHER_EXPR },
        attributes: {},
        dependencies: [],
        provisionedBy: 'sdk' as const,
        deletionPolicy: 'Snapshot' as const,
      },
    };

    const result = await replayKept(() => replayRollback([op], state, STACK, ctx));
    sleep.mockRestore();

    expect(result.failures).toBe(0);
    expect(del).toHaveBeenCalled();
    const snapshotLines = lines.filter((l) => l.includes('final snapshot'));
    expect(snapshotLines.length).toBeGreaterThan(0);
    expect(lines.some((l) => l.includes('Waiting for Redshift cluster *** to settle'))).toBe(true);
    for (const line of lines) expect(line.toLowerCase(), line).not.toContain('bob-private');
  });

  it("a refusal keeps its pasteable --orphan line whole, whatever the id's needles cut", async () => {
    // A secret-derived old id (`Role`) that happens to occur in the logical id.
    const create = vi
      .fn()
      .mockRejectedValue(
        awsSdkError('Role with name Role already exists.', 'EntityAlreadyExistsException')
      );
    const { ctx, lines, events } = makeCtx({ create, delete: vi.fn() });
    const op: CompletedOperation = {
      logicalId: 'MyRole',
      changeType: 'UPDATE',
      resourceType: ROLE,
      physicalId: 'plain-new',
      provisionedBy: 'sdk',
      previousState: role('Role', SECRET_EXPR),
    };

    const result = await replayKept(() =>
      replayRollback([op], { MyRole: role('plain-new', 'plain-new') }, STACK, ctx)
    );

    expect(result.failures).toBe(1);
    const failed = lines.find((l) => l.includes('Cannot reverse the replacement'));
    expect(failed).toMatch(/\nTo orphan it: cdkd rollback --orphan MyRole$/);
    expect(failed).toContain('Rollback failed for MyRole (UPDATE)');
    // The DURABLE copy too: the event leaves the refusal as it was built.
    const event = events.find((e) => e.eventType === 'ROLLBACK_RESOURCE_FAILED');
    expect(event?.error?.message).toMatch(/\nTo orphan it: cdkd rollback --orphan MyRole$/);
  });

  // Re-review of #4099: a name key spelled `...Id` (ElastiCache), which is also
  // a pre-delete snapshot type, and the re-run command inside a refusal.
  const RG = 'AWS::ElastiCache::ReplicationGroup';
  const replicationGroup = (
    physicalId: string,
    name: string,
    extra: Partial<ResourceState> = {}
  ): ResourceState => ({
    physicalId,
    resourceType: RG,
    properties: { ReplicationGroupId: name, ReplicationGroupDescription: 'd' },
    attributes: {},
    dependencies: [],
    provisionedBy: 'sdk',
    ...extra,
  });

  it('an ElastiCache replication group named by an unresolved secret: the re-adopt lines', async () => {
    const { ctx, lines, events } = makeCtx({ delete: vi.fn() });
    const op: CompletedOperation = {
      logicalId: 'G',
      changeType: 'UPDATE',
      resourceType: RG,
      physicalId: 'bob-private-x',
      oldResourceRetained: true,
      previousState: replicationGroup('old-public-group', 'old-public-group'),
    };
    const state = {
      G: replicationGroup('bob-private-x', OTHER_EXPR, { updateReplacePolicy: 'Retain' }),
    };

    await replayKept(() => replayRollback([op], state, STACK, ctx));

    const survivor = lines.find((l) => l.includes('is RETAINED by this rollback'));
    expect(survivor).toContain("replacement's new physical resource (***)");
    expect(survivor).toContain('State is restored to the old resource (old-public-group).');
    for (const text of [...lines, ...events.map((e) => e.reason ?? '')]) {
      expect(text).not.toContain('bob-private');
    }
  });

  it('an ElastiCache replication group under DeletionPolicy: Snapshot: the snapshot lines', async () => {
    // Mixed case AND past ElastiCache's 50-character snapshot-name budget, so
    // the snapshot prefix is cut shorter than the lowercased id: this case pins
    // the snapshot-prefix spelling on its own (the lowercased spelling is
    // pinned by the Redshift error cases below).
    const groupId = 'Bob-Private-Group-With-A-Long-Name-To-Cut';
    const sleep = vi.spyOn(finalSnapshotDelays, 'sleep').mockResolvedValue(undefined);
    const elastiCacheSend = vi.fn(
      async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
        switch (command.constructor.name) {
          case 'DescribeReplicationGroupsCommand':
            return { ReplicationGroups: [{ ClusterEnabled: true }] };
          case 'DescribeSnapshotsCommand':
            return command.input['SnapshotName'] === undefined
              ? { Snapshots: [] }
              : { Snapshots: [{ SnapshotStatus: 'available' }] };
          default:
            return {};
        }
      }
    );
    const del = vi.fn(async () => undefined);
    const { ctx, lines } = makeCtx({ delete: del });
    ctx.finalSnapshotClients = {
      ec2: {},
      redshift: {},
      elastiCache: { send: elastiCacheSend },
    } as unknown as NonNullable<RollbackExecutorContext['finalSnapshotClients']>;
    const op: CompletedOperation = {
      logicalId: 'G',
      changeType: 'CREATE',
      resourceType: RG,
      physicalId: groupId,
      provisionedBy: 'sdk',
      properties: { ReplicationGroupId: OTHER_EXPR },
    };
    const state = { G: replicationGroup(groupId, OTHER_EXPR, { deletionPolicy: 'Snapshot' }) };

    const result = await replayKept(() => replayRollback([op], state, STACK, ctx));
    sleep.mockRestore();

    expect(result.failures).toBe(0);
    expect(elastiCacheSend).toHaveBeenCalled();
    expect(del).toHaveBeenCalled();
    expect(lines.filter((l) => l.includes('final snapshot')).length).toBeGreaterThan(0);
    for (const line of lines) expect(line.toLowerCase(), line).not.toContain('bob-private');
  });

  it.each([
    ['the unproven-holder refusal', false, 'then re-run cdkd rollback, which proceeds'],
    ['the Retain-pinned refusal', true, 'then re-run cdkd rollback — the journal is kept'],
  ])('%s keeps its re-run command whole, whatever the id needles cut', async (_label, pinned, rerun) => {
    // A queue: its URL names the plaintext it was created with, so the new one
    // PROVABLY holds the name on the pinned arm. The old id (`back`) is a
    // secret-derived id that occurs inside `cdkd rollback`.
    const QUEUE = 'AWS::SQS::Queue';
    const url = 'https://sqs.us-east-1.amazonaws.com/123456789012/';
    const queue = (physicalId: string, name: string, extra: Partial<ResourceState> = {}) => ({
      physicalId,
      resourceType: QUEUE,
      properties: { QueueName: name },
      attributes: {},
      dependencies: [],
      provisionedBy: 'sdk' as const,
      ...extra,
    });
    const create = vi
      .fn()
      .mockRejectedValue(awsSdkError('Queue back already exists.', 'QueueAlreadyExists'));
    const { ctx, lines } = makeCtx({ create, delete: vi.fn() });
    const newId = pinned ? `${url}${SECRET_NAME}` : `${url}plain-new`;
    const op: CompletedOperation = {
      logicalId: 'MyQueue',
      changeType: 'UPDATE',
      resourceType: QUEUE,
      physicalId: newId,
      provisionedBy: 'sdk',
      previousState: queue('back', SECRET_EXPR),
    };
    const current = pinned
      ? queue(newId, SECRET_EXPR, { updateReplacePolicy: 'Retain' })
      : queue(newId, 'plain-new');

    await replayKept(() => replayRollback([op], { MyQueue: current }, STACK, ctx));

    const failed = lines.find((l) => l.includes('Cannot reverse the replacement'));
    expect(failed).toContain(pinned ? 'UpdateReplacePolicy: Retain pins' : 'collided: ');
    expect(failed).toContain(rerun);
    expect(failed).toMatch(/\nTo orphan it: cdkd rollback --orphan MyQueue$/);
    expect(failed).toContain('Queue *** already exists.');
  });

  it('a short id adds no lowercased needle: `R` does not eat every `r`', async () => {
    const { ctx, events } = makeCtx({ delete: vi.fn() });
    const { op, state } = replacement('R', SECRET_EXPR, 'plain-new', 'plain-new', {
      op: { oldResourceRetained: true },
      current: { updateReplacePolicy: 'Retain' },
    });

    await replayKept(() => replayRollback([op], state, STACK, ctx));

    // The event reason goes through the op's mask WHOLE: `R` itself is masked
    // wherever it occurs (no floor on an id), but a lowercased `r` would cut
    // `tracked`, `longer` and the rest of the prose too.
    const succeeded = events.find((e) => e.eventType === 'ROLLBACK_RESOURCE_SUCCEEDED');
    expect(succeeded?.reason).toContain('it is live, still billing, and no longer tracked by cdkd');
  });

  it.each([
    ['AWS::ElastiCache::User', 'UserId'],
    ['AWS::ElastiCache::UserGroup', 'UserGroupId'],
    ['AWS::SES::EmailIdentity', 'EmailIdentity'],
    ['AWS::Cognito::UserPoolDomain', 'Domain'],
    // A type no table lists, whose name key is spelled `...Name`.
    ['AWS::Example::Widget', 'WidgetName'],
  ])('%s named (%s) by an unresolved secret: the re-adopt survivor names no id', async (type, key) => {
    const record = (physicalId: string, name: string, extra: Partial<ResourceState> = {}) => ({
      physicalId,
      resourceType: type,
      properties: { [key]: name },
      attributes: {},
      dependencies: [],
      provisionedBy: 'sdk' as const,
      ...extra,
    });
    const { ctx, lines, events } = makeCtx({ delete: vi.fn() });
    const op: CompletedOperation = {
      logicalId: 'X',
      changeType: 'UPDATE',
      resourceType: type,
      physicalId: 'bob@private.example',
      oldResourceRetained: true,
      previousState: record('old-public', 'old-public'),
    };

    await replayKept(() =>
      replayRollback(
        [op],
        { X: record('bob@private.example', OTHER_EXPR, { updateReplacePolicy: 'Retain' }) },
        STACK,
        ctx
      )
    );

    const survivor = lines.find((l) => l.includes('is RETAINED by this rollback'));
    expect(survivor).toContain("replacement's new physical resource (***)");
    for (const text of [...lines, ...events.map((e) => e.reason ?? '')]) {
      expect(text).not.toContain('bob@private');
    }
  });

  it.each([
    ['a long mixed-case id', 'Bob-Private-Cluster'],
    // The floor's boundary: four characters still add the lowercased needle.
    ['a four-character id', 'BobX'],
  ])('%s: an AWS message quoting it lowercased is masked', async (_label, clusterId) => {
    // (The floor's other side is the three-character case after this block.)
    const CLUSTER = 'AWS::Redshift::Cluster';
    const del = vi
      .fn()
      .mockRejectedValue(new Error(`Cluster ${clusterId.toLowerCase()} is not in available state`));
    const { ctx, lines, events } = makeCtx({ delete: del });
    const op: CompletedOperation = {
      logicalId: 'C',
      changeType: 'CREATE',
      resourceType: CLUSTER,
      physicalId: clusterId,
      provisionedBy: 'sdk',
      properties: { ClusterIdentifier: OTHER_EXPR },
    };
    const state = {
      C: {
        physicalId: clusterId,
        resourceType: CLUSTER,
        properties: { ClusterIdentifier: OTHER_EXPR },
        attributes: {},
        dependencies: [],
        provisionedBy: 'sdk' as const,
        deletionPolicy: 'Delete' as const,
      },
    };

    const result = await replayKept(() => replayRollback([op], state, STACK, ctx));

    expect(result.failures).toBe(1);
    const failed = lines.find((l) => l.includes('Rollback failed for C'));
    expect(failed).toContain('Cluster *** is not in available state');
    const event = events.find((e) => e.eventType === 'ROLLBACK_RESOURCE_FAILED');
    expect(event?.error?.message).toContain('Cluster *** is not in available state');
  });

  it('a planted journal whose type is a prototype key completes without a throw', async () => {
    const { ctx } = makeCtx({ delete: vi.fn(async () => undefined) });
    const op: CompletedOperation = {
      logicalId: 'P',
      changeType: 'CREATE',
      resourceType: 'constructor',
      physicalId: 'p-1',
      provisionedBy: 'sdk',
      properties: { Name: 'x' },
    };
    const state = {
      P: {
        physicalId: 'p-1',
        resourceType: 'constructor',
        properties: { Name: 'x' },
        attributes: {},
        dependencies: [],
        provisionedBy: 'sdk' as const,
      },
    };

    const result = await replayKept(() => replayRollback([op], state, STACK, ctx));

    expect(result.failures).toBe(0);
  });

  it('a three-character id adds no lowercased needle (the floor, accepted as a bound)', async () => {
    // Below the literal mask's substring floor a DERIVED spelling is not a
    // needle, so `bob` in unrelated text survives; the id `Bob` itself is
    // still masked. The exposure is at most three characters (#4099 review).
    const CLUSTER = 'AWS::Redshift::Cluster';
    const del = vi.fn().mockRejectedValue(new Error('Cluster Bob (bob) is not in available state'));
    const { ctx, lines } = makeCtx({ delete: del });
    const record = {
      physicalId: 'Bob',
      resourceType: CLUSTER,
      properties: { ClusterIdentifier: OTHER_EXPR },
      attributes: {},
      dependencies: [],
      provisionedBy: 'sdk' as const,
      deletionPolicy: 'Delete' as const,
    };
    const op: CompletedOperation = {
      logicalId: 'C',
      changeType: 'CREATE',
      resourceType: CLUSTER,
      physicalId: 'Bob',
      provisionedBy: 'sdk',
      properties: { ClusterIdentifier: OTHER_EXPR },
    };

    await replayKept(() => replayRollback([op], { C: record }, STACK, ctx));

    expect(lines.find((l) => l.includes('Rollback failed for C'))).toContain(
      'Cluster *** (bob) is not in available state'
    );
  });

  // Orchestrator review of #4099.

  it.each([
    [
      'AWS::ECS::TaskDefinition',
      { Family: OTHER_EXPR },
      'arn:aws:ecs:us-east-1:123456789012:task-definition/bob-private-fam:1',
    ],
    [
      'AWS::Cognito::UserPoolUser',
      { UserPoolId: 'us-east-1_x', Username: OTHER_EXPR },
      'us-east-1_x|bob-private-user',
    ],
  ])('%s: a skipped CREATE-rollback delete names no id', async (type, properties, id) => {
    const del = vi.fn(async () => ({ outcome: 'skipped' as const, reason: 'not confirmed' }));
    const { ctx, lines, events } = makeCtx({ delete: del });
    const op: CompletedOperation = {
      logicalId: 'X',
      changeType: 'CREATE',
      resourceType: type,
      physicalId: id,
      provisionedBy: 'sdk',
      properties,
    };
    const state = {
      X: { physicalId: id, resourceType: type, properties, attributes: {}, dependencies: [], provisionedBy: 'sdk' as const },
    };

    const result = await replayKept(() => replayRollback([op], state, STACK, ctx));

    expect(result.failures).toBe(1);
    expect(lines.some((l) => l.includes('Rollback failed for X'))).toBe(true);
    const event = events.find((e) => e.eventType === 'ROLLBACK_RESOURCE_FAILED');
    for (const text of [...lines, event?.error?.message ?? '']) {
      expect(text).not.toContain('bob-private');
    }
  });

  it("a CREATE op's own bag names the secret while the state record does not", async () => {
    const del = vi.fn().mockRejectedValue(new Error(`Role ${KEPT} cannot be deleted`));
    const { ctx, lines, events } = makeCtx({ delete: del });
    const op: CompletedOperation = {
      logicalId: 'R',
      changeType: 'CREATE',
      resourceType: ROLE,
      physicalId: KEPT,
      provisionedBy: 'sdk',
      properties: { RoleName: SECRET_EXPR },
    };

    const result = await replayKept(() =>
      replayRollback([op], { R: role(KEPT, 'plain') }, STACK, ctx)
    );

    expect(result.failures).toBe(1);
    expect(lines.some((l) => l.includes('Role *** cannot be deleted'))).toBe(true);
    for (const line of lines) expect(leaks(line), line).toBe(false);
    const event = events.find((e) => e.eventType === 'ROLLBACK_RESOURCE_FAILED');
    expect(leaks(event!.error!.message)).toBe(false);
  });

  it("--revert-failed of a partial CREATE: its attempted bag names the secret, the state record does not", async () => {
    const del = vi.fn().mockRejectedValue(new Error(`Role ${KEPT} cannot be deleted`));
    const { ctx, lines, events } = makeCtx({ delete: del });
    const op = {
      logicalId: 'R',
      changeType: 'CREATE',
      resourceType: ROLE,
      physicalId: KEPT,
      provisionedBy: 'sdk',
      attemptedProperties: { RoleName: SECRET_EXPR },
    } as FailedOperation;

    const result = await replayKept(() =>
      replayFailedOperations([op], { R: role(KEPT, 'plain') }, STACK, ctx)
    );

    expect(result.failures).toBe(1);
    expect(lines.some((l) => l.includes('Role *** cannot be deleted'))).toBe(true);
    for (const line of lines) expect(leaks(line), line).toBe(false);
    const event = events.find((e) => e.eventType === 'ROLLBACK_RESOURCE_FAILED');
    expect(leaks(event!.error!.message)).toBe(false);
  });

  it('the unproven-holder refusal masks a spaced secret BEFORE collapsing the AWS text', async () => {
    // `collisionText` collapses the whitespace run, after which the plaintext
    // no longer occurs and the outer mask cannot find it.
    const create = vi
      .fn()
      .mockRejectedValue(
        awsSdkError(`Role with name ${SPACED_NAME} already exists.`, 'EntityAlreadyExistsException')
      );
    const { ctx, lines } = makeCtx({ create, delete: vi.fn() });
    const { op, state } = replacement('old-plain', SPACED_EXPR, 'plain-new', 'plain-new');

    const result = await replayKept(() => replayRollback([op], state, STACK, ctx));

    expect(result.failures).toBe(1);
    const failed = lines.find((l) => l.includes('Cannot reverse the replacement'));
    expect(failed).toContain('Underlying collision: Role with name *** already exists.');
    for (const line of lines) expect(line).not.toMatch(/spaced|alice/);
  });

  it.each([
    [
      'AWS::ECS::TaskDefinition',
      { Family: OTHER_EXPR },
      'arn:aws:ecs:us-east-1:123456789012:task-definition/bob-private-fam:1',
      // The name part alone, revision included and stripped.
      'TaskDefinition bob-private-fam:1 is INACTIVE (family bob-private-fam)',
      'TaskDefinition *** is INACTIVE (family ***)',
    ],
    [
      'AWS::Cognito::UserPoolUser',
      { UserPoolId: 'us-east-1_x', Username: OTHER_EXPR },
      'us-east-1_x|bob-private-user',
      // The AWS-generated pool id stays readable.
      'User bob-private-user does not exist in us-east-1_x',
      'User *** does not exist in us-east-1_x',
    ],
    [
      'AWS::SNS::Topic',
      { TopicName: OTHER_EXPR },
      'arn:aws:sns:us-east-1:123456789012:bob-private-topic',
      'Topic bob-private-topic has subscriptions pending',
      'Topic *** has subscriptions pending',
    ],
    [
      'AWS::StepFunctions::StateMachine',
      { StateMachineName: OTHER_EXPR },
      'arn:aws:states:us-east-1:123456789012:stateMachine:bob-private-machine',
      'State machine bob-private-machine has running executions',
      'State machine *** has running executions',
    ],
    [
      // A version suffix after the name: the last NON-NUMERIC segment.
      'AWS::Lambda::Function',
      { FunctionName: OTHER_EXPR },
      'arn:aws:lambda:us-east-1:123456789012:function:bob-private-fn:3',
      'Function bob-private-fn is in use by an event source mapping',
      'Function *** is in use by an event source mapping',
    ],
    [
      // #4135: the name sits before the hash, not last.
      'AWS::ElasticLoadBalancingV2::LoadBalancer',
      { Name: OTHER_EXPR },
      'arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/bob-private-lb/50dc6c495c0c9188',
      'Load balancer bob-private-lb is busy',
      'Load balancer *** is busy',
    ],
    [
      'AWS::ElasticLoadBalancingV2::TargetGroup',
      { Name: OTHER_EXPR },
      'arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/bob-private-tg/73e2d6bc24d8a067',
      'Target group bob-private-tg is in use by a listener',
      'Target group *** is in use by a listener',
    ],
    [
      // #4135: the function name before an alias qualifier. The alias is a
      // needle too (#4141 review: it may be the secret-derived name), so its
      // word is over-masked.
      'AWS::Lambda::Alias',
      { FunctionName: OTHER_EXPR, Name: 'production' },
      'arn:aws:lambda:us-east-1:123456789012:function:bob-private-fn:production',
      'Alias production of bob-private-fn is busy',
      'Alias *** of *** is busy',
    ],
    [
      // #4141 review: the ALIAS name is the secret-derived one.
      'AWS::Lambda::Alias',
      { FunctionName: 'plainfn', Name: OTHER_EXPR },
      'arn:aws:lambda:us-east-1:123456789012:function:plainfn:bob-private-alias',
      // The function's segment is taken too: it may be the name (over-masks).
      'alias bob-private-alias of plainfn not found',
      'alias *** of *** not found',
    ],
    [
      // The layer name before its version: a Lambda ARN other than a function's.
      'AWS::Lambda::LayerVersion',
      { LayerName: OTHER_EXPR },
      'arn:aws:lambda:us-east-1:123456789012:layer:bob-private-layer:3',
      'Layer version bob-private-layer:3 is in use',
      'Layer version ***:3 is in use',
    ],
    [
      // #4138: the name before a UUID.
      'AWS::MSK::Cluster',
      { ClusterName: OTHER_EXPR },
      'arn:aws:kafka:us-east-1:123456789012:cluster/bob-private-msk/0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0-2',
      'Cluster bob-private-msk is busy',
      'Cluster *** is busy',
    ],
    [
      // #4138: the name before a 32-hex id.
      'AWS::AppRunner::Service',
      { ServiceName: OTHER_EXPR },
      'arn:aws:apprunner:us-east-1:123456789012:service/bob-private-svc/8fe1e10304f84fd2b0df550fe98a71fa',
      'Service bob-private-svc is OPERATION_IN_PROGRESS',
      'Service *** is OPERATION_IN_PROGRESS',
    ],
    [
      // #4138: the name mid-path, between the cluster and a UUID.
      'AWS::EKS::Nodegroup',
      { ClusterName: 'plain-cluster', NodegroupName: OTHER_EXPR },
      'arn:aws:eks:us-east-1:123456789012:nodegroup/plain-cluster/bob-private-ng/4ac4bf66-2bd0-6ab1-4b92-bfa7f2d1c4a2',
      // The leading resource-type word stays readable.
      'Nodegroup bob-private-ng is DELETING; list the nodegroup again later',
      'Nodegroup *** is DELETING; list the nodegroup again later',
    ],
    [
      // #4138: a Cloud Control composite with the name FIRST; the upper-case
      // scope word stays readable.
      'AWS::WAFv2::WebACL',
      { Name: OTHER_EXPR, Scope: 'REGIONAL' },
      'bob-private-acl|a1b2c3d4-e5f6-7890-abcd-ef1234567890|REGIONAL',
      'WebACL bob-private-acl is associated with a REGIONAL resource',
      'WebACL *** is associated with a REGIONAL resource',
    ],
    // #4141 review: a secret-derived name is often a generated-looking token,
    // so no shape exclusion may skip it.
    [
      'AWS::SNS::Topic',
      { TopicName: OTHER_EXPR },
      'arn:aws:sns:us-east-1:123456789012:deadbeefcafebabe1234',
      'Topic deadbeefcafebabe1234 not found',
      'Topic *** not found',
    ],
    [
      'AWS::ECS::TaskDefinition',
      { Family: OTHER_EXPR },
      'arn:aws:ecs:us-east-1:123456789012:task-definition/deadbeefcafebabe1234:1',
      'family deadbeefcafebabe1234 is INACTIVE',
      'family *** is INACTIVE',
    ],
    [
      'AWS::Cognito::UserPoolUser',
      { UserPoolId: 'us-east-1_x', Username: OTHER_EXPR },
      'us-east-1_x|0f8fad5b-d9cb-469f-a165-70867728950e',
      'User 0f8fad5b-d9cb-469f-a165-70867728950e does not exist',
      'User *** does not exist',
    ],
    [
      // A UUID-shaped name beside an ordinary segment: no shape exclusion may
      // leave only the cluster name.
      'AWS::EKS::Nodegroup',
      { ClusterName: 'plain-cluster', NodegroupName: OTHER_EXPR },
      'arn:aws:eks:us-east-1:123456789012:nodegroup/plain-cluster/7c9e6679-7425-40de-944b-e07fc1f90ae7/4ac4bf66-2bd0-6ab1-4b92-bfa7f2d1c4a2',
      'Nodegroup 7c9e6679-7425-40de-944b-e07fc1f90ae7 is DELETING',
      'Nodegroup *** is DELETING',
    ],
    [
      // #4141 review: exclusions are POSITIONAL, so a scope-word or pool-id
      // shaped name elsewhere is still a needle.
      'AWS::EKS::Nodegroup',
      { ClusterName: 'c1-plain', NodegroupName: OTHER_EXPR },
      'arn:aws:eks:us-east-1:123456789012:nodegroup/c1-plain/us-east-1_Abc123/4ac4bf66-2bd0-6ab1-4b92-bfa7f2d1c4a2',
      'Nodegroup us-east-1_Abc123 is busy',
      'Nodegroup *** is busy',
    ],
    [
      'AWS::WAFv2::WebACL',
      { Name: OTHER_EXPR, Scope: 'REGIONAL' },
      'CLOUDFRONT|a1b2c3d4-e5f6-7890-abcd-ef1234567890|REGIONAL',
      'WebACL CLOUDFRONT is busy in REGIONAL scope',
      'WebACL *** is busy in REGIONAL scope',
    ],
    [
      // A pool-id-shaped Username in the Username position is still taken.
      'AWS::Cognito::UserPoolUser',
      { UserPoolId: 'us-east-1_x', Username: OTHER_EXPR },
      'us-east-1_x|eu-west-1_Secret9',
      'User eu-west-1_Secret9 does not exist',
      'User *** does not exist',
    ],
    [
      // A numeric name mid-path is kept: only a TRAILING number is a revision.
      'AWS::MSK::Cluster',
      { ClusterName: OTHER_EXPR },
      'arn:aws:kafka:us-east-1:123456789012:cluster/12345678/0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0-2',
      'Cluster 12345678 is busy',
      'Cluster *** is busy',
    ],
    [
      'AWS::SecretsManager::Secret',
      { Name: OTHER_EXPR },
      'arn:aws:secretsmanager:us-east-1:123456789012:secret:bob-private-secret-AbC123',
      'Secret bob-private-secret is scheduled for deletion',
      'Secret *** is scheduled for deletion',
    ],
  ])(
    '%s: an AWS message quoting only the name part of the id is masked',
    async (type, properties, id, message, masked) => {
      const del = vi.fn().mockRejectedValue(new Error(message));
      const { ctx, lines, events } = makeCtx({ delete: del });
      const op: CompletedOperation = {
        logicalId: 'X',
        changeType: 'CREATE',
        resourceType: type,
        physicalId: id,
        provisionedBy: 'sdk',
        properties,
      };
      const state = {
        X: { physicalId: id, resourceType: type, properties, attributes: {}, dependencies: [], provisionedBy: 'sdk' as const },
      };

      await replayKept(() => replayRollback([op], state, STACK, ctx));

      expect(lines.find((l) => l.includes('Rollback failed for X'))).toContain(masked);
      const event = events.find((e) => e.eventType === 'ROLLBACK_RESOURCE_FAILED');
      for (const text of [...lines, event?.error?.message ?? '']) {
        expect(text).not.toContain('bob-private');
      }
    }
  );
});

describe('the live-resource warning names no shell-active value (go-to-k/cdkd#4205)', () => {
  it('holes a payload stack name or region in `Inspect it with:`, and no pasted span runs', async () => {
    // The warning carries `resource's` and `'cdkd deploy'` on the line above
    // its command, so a shell-quoted payload ran once the two lines were
    // pasted as one block. The stack name comes from the journal key, the
    // region from the rollback context.
    const messages: Array<[string, string]> = [];
    for (const { label, value } of PASTE_PAYLOADS) {
      for (const [stack, region, expected] of [
        [value, 'us-east-1', "cdkd drift '<stack>' --stack-region us-east-1"],
        [STACK, value, `cdkd drift ${STACK} --stack-region '<region>'`],
      ] as const) {
        const create = vi.fn(async () => ({ physicalId: 'live-role', attributes: {} }));
        const { ctx, lines } = makeCtx({ create, delete: vi.fn() });
        const { op, state } = replacement('old-role', 'same-name', 'live-role', 'same-name');
        await withSkipPrefix(false, () =>
          withStackName(stack, () => replayRollback([op], state, stack, { ...ctx, region }))
        );
        const message = lines.find((l) => l.includes('the re-create returned the LIVE new'));
        expect(message, label).toBeDefined();
        expect(message!.split('\n').at(-1), label).toBe(`Inspect it with: ${expected}`);
        messages.push([`${label} ${stack === STACK ? 'region' : 'stack'}`, message!]);
      }
    }
    withPasteDir((dir) => {
      for (const [label, message] of messages) expect(spansThatRun(message, dir), label).toEqual([]);
    });
  }, 120_000);
});
