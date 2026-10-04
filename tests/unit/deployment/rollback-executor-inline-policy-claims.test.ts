/**
 * go-to-k/cdkd#4225: a rollback hands an `AWS::IAM::Policy` revert / delete,
 * and an `AWS::IAM::Role` / `Group` / `User` revert, a LIVE predicate that
 * says whether ANOTHER revert of the same replay has already put an inline
 * policy name back on a principal — the rollback twin of the deploy's
 * go-to-k/cdkd#4156 predicate.
 *
 * The replay runs against a fake IAM that holds one role's inline policies,
 * each with the document of whoever put it last. Its providers act the way
 * the real ones do: an `AWS::IAM::Policy` rename is journaled with a NEW
 * physical id (its name), so the rollback reverses it as a replacement
 * (re-create the old copy, delete the new one); a policy update removes the
 * names it no longer puts; a role update removes the `Policies` entries it
 * dropped. Each removal asks `inlinePolicyClaimed` first, INSIDE the call.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  replayRollback,
  replayFailedOperations,
  type CompletedOperation,
  type FailedOperation,
  type RollbackExecutorContext,
} from '../../../src/deployment/rollback-executor.js';
import { RollbackInlinePolicyWriters } from '../../../src/deployment/inline-policy-claims.js';
import type { InlinePolicyClaimed } from '../../../src/types/resource.js';
import type { ResourceState } from '../../../src/types/state.js';

vi.mock('../../../src/deployment/retry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/deployment/retry.js')>();
  return { ...actual, withRetry: vi.fn((fn: () => Promise<unknown>) => fn()) };
});

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({}),
  setAwsClients: vi.fn(),
  AwsClients: vi.fn(),
}));

const POLICY = 'AWS::IAM::Policy';
const ROLE = 'AWS::IAM::Role';
const ROLE_PHYS = 'role-phys';

/** The role's inline policies: name -> the document of whoever put it last. */
let held: Map<string, string>;
const put = (name: string, doc: string): void => void held.set(name, doc);
const remove = (name: string): void => void held.delete(name);
const asked = (ctx: unknown): InlinePolicyClaimed | undefined =>
  (ctx as { inlinePolicyClaimed?: InlinePolicyClaimed } | undefined)?.inlinePolicyClaimed;

type PolicyProps = { PolicyName: string; PolicyDocument: string; Roles: string[] };
type RoleProps = { Policies: Array<{ PolicyName: string; PolicyDocument: string }> };

const policyProvider = {
  create: vi.fn(async (_l: string, _t: string, props: PolicyProps) => {
    // A put-back of a group / user policy lists its principal there instead.
    const p = props as PolicyProps & { Groups?: string[]; Users?: string[] };
    for (const _r of p.Roles ?? p.Groups ?? p.Users ?? []) put(props.PolicyName, props.PolicyDocument);
    return { physicalId: props.PolicyName, attributes: {} };
  }),
  update: vi.fn(
    async (_l: string, _p: string, _t: string, props: PolicyProps, prev: PolicyProps, ctx: unknown) => {
      for (const _r of props.Roles) put(props.PolicyName, props.PolicyDocument);
      for (const r of prev.Roles) {
        const stays = props.Roles.includes(r);
        if (stays && prev.PolicyName === props.PolicyName) continue;
        if (asked(ctx)?.('role', r, prev.PolicyName) === true) continue;
        remove(prev.PolicyName);
      }
      return { physicalId: props.PolicyName, wasReplaced: false };
    }
  ),
  delete: vi.fn(async (_l: string, physicalId: string, _t: string, props: PolicyProps, ctx: unknown) => {
    for (const r of props.Roles) {
      if (asked(ctx)?.('role', r, physicalId) === true) continue;
      remove(physicalId);
    }
  }),
};

const roleProvider = {
  create: vi.fn(),
  update: vi.fn(
    async (_l: string, physicalId: string, _t: string, props: RoleProps, prev: RoleProps, ctx: unknown) => {
      for (const p of props.Policies) put(p.PolicyName, p.PolicyDocument);
      for (const p of prev.Policies) {
        if (props.Policies.some((q) => q.PolicyName === p.PolicyName)) continue;
        if (asked(ctx)?.('role', physicalId, p.PolicyName) === true) continue;
        remove(p.PolicyName);
      }
      return { physicalId, wasReplaced: false };
    }
  ),
  delete: vi.fn(),
};

const silentLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  setLevel: vi.fn(),
  child: () => silentLogger,
} as unknown as RollbackExecutorContext['logger'];

const ctx: RollbackExecutorContext = {
  region: 'us-east-1',
  logger: silentLogger,
  providerRegistry: {
    getProviderFor: ({ resourceType }: { resourceType: string }) => ({
      provider: resourceType === ROLE ? roleProvider : policyProvider,
      provisionedBy: 'sdk',
    }),
  } as unknown as RollbackExecutorContext['providerRegistry'],
};

const policyRecord = (name: string, doc: string, roles = [ROLE_PHYS]): ResourceState => ({
  physicalId: name,
  resourceType: POLICY,
  properties: { PolicyName: name, PolicyDocument: doc, Roles: roles },
  attributes: {},
  provisionedBy: 'sdk',
});
const roleRecord = (policies: RoleProps['Policies']): ResourceState => ({
  physicalId: ROLE_PHYS,
  resourceType: ROLE,
  properties: { Policies: policies },
  attributes: {},
  provisionedBy: 'sdk',
});

/** A completed UPDATE of `logicalId` from `before` to `after` (records). */
const updateOp = (logicalId: string, before: ResourceState, after: ResourceState): CompletedOperation => ({
  logicalId,
  changeType: 'UPDATE',
  resourceType: after.resourceType,
  physicalId: after.physicalId,
  properties: after.properties,
  previousState: before,
  previousResourceType: before.resourceType,
  oldResourceRetained: false,
  provisionedBy: 'sdk',
});
const createOp = (logicalId: string, after: ResourceState): CompletedOperation => ({
  logicalId,
  changeType: 'CREATE',
  resourceType: after.resourceType,
  physicalId: after.physicalId,
  properties: after.properties,
  provisionedBy: 'sdk',
});

const holding = (): Record<string, string> => Object.fromEntries([...held].sort());

describe('a rollback keeps an inline policy name another revert of it has put back (go-to-k/cdkd#4225)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    held = new Map();
  });

  it('a reverted SWAP of two policies\' names leaves each name with its first owner', async () => {
    // Deploy: A renamed x -> y, then B renamed y -> x (B depends on A).
    const state: Record<string, ResourceState> = {
      A: policyRecord('y', 'docA'),
      B: policyRecord('x', 'docB'),
    };
    put('y', 'docA');
    put('x', 'docB');
    const ops = [
      updateOp('A', policyRecord('x', 'docA'), policyRecord('y', 'docA')),
      updateOp('B', policyRecord('y', 'docB'), policyRecord('x', 'docB')),
    ];

    const result = await replayRollback(ops, state, 'S', ctx);

    expect(result.failures).toBe(0);
    // B reverses first (re-create y, delete x), then A (re-create x, delete
    // y). Before the fix A's delete of `y` removed the name B had just put
    // back, and the role ended up with `x` alone.
    expect(holding()).toEqual({ x: 'docA', y: 'docB' });
    // The second delete was asked about `y` and told it is claimed.
    const lastDelete = policyProvider.delete.mock.calls.at(-1)!;
    expect(lastDelete[1]).toBe('y');
    expect(asked(lastDelete[4])?.('role', ROLE_PHYS, 'y')).toBe(true);
  });

  it('a reverted hand-off to the role\'s own Policies keeps the name the policy put back', async () => {
    // Deploy: the role took `to-role` into its Policies, then T renamed
    // `to-role` -> `moved` (T names the role, so the role updated first).
    const state: Record<string, ResourceState> = {
      R: roleRecord([{ PolicyName: 'to-role', PolicyDocument: 'docRole' }]),
      T: policyRecord('moved', 'docT'),
    };
    put('to-role', 'docRole');
    put('moved', 'docT');
    const ops = [
      updateOp('R', roleRecord([]), state['R']!),
      updateOp('T', policyRecord('to-role', 'docT'), policyRecord('moved', 'docT')),
    ];

    const result = await replayRollback(ops, state, 'S', ctx);

    expect(result.failures).toBe(0);
    // T reverses first (re-create `to-role` with T's document, delete
    // `moved`); then the role's revert drops `to-role` from its Policies.
    // Before the fix it removed the name T had just put back.
    expect(holding()).toEqual({ 'to-role': 'docT' });
    expect(roleProvider.update).toHaveBeenCalledTimes(1);
    expect(asked(roleProvider.update.mock.calls[0]![5])?.('role', ROLE_PHYS, 'to-role')).toBe(true);
  });

  it('an in-place policy revert asks before detaching a name a re-create put back', async () => {
    // Deploy: P (name `n`) went Roles [] -> [role], putting `n`; then Q
    // renamed `n` -> `m` and kept `n`, P's. Rollback: Q first re-creates `n`
    // (Q's document) and deletes `m`; then P's in-place revert detaches `n`
    // from the role, which Q's re-create now holds.
    const pAfter = policyRecord('n', 'docP');
    const state: Record<string, ResourceState> = {
      P: pAfter,
      Q: policyRecord('m', 'docQ'),
    };
    put('n', 'docP');
    put('m', 'docQ');
    const ops = [
      updateOp('P', policyRecord('n', 'docP', []), pAfter),
      updateOp('Q', policyRecord('n', 'docQ'), policyRecord('m', 'docQ')),
    ];

    await replayRollback(ops, state, 'S', ctx);

    expect(policyProvider.update).toHaveBeenCalledTimes(1);
    expect(holding()).toEqual({ n: 'docQ' });
  });

  it('a completed in-place revert claims for a later CREATE-rollback delete', async () => {
    // Deploy: P went Roles [role] -> [] while New (name `n`) was created on
    // the role. Rollback: P's revert re-attaches `n` first (UPDATE ops run
    // before CREATE deletions), then New's delete must leave `n` to P.
    const state: Record<string, ResourceState> = {
      P: policyRecord('n', 'docP', []),
      New: policyRecord('n', 'docNew'),
    };
    put('n', 'docNew');
    const ops = [
      createOp('New', state['New']!),
      updateOp('P', policyRecord('n', 'docP'), state['P']!),
    ];

    await replayRollback(ops, state, 'S', ctx);

    expect(policyProvider.update).toHaveBeenCalledTimes(1);
    expect(policyProvider.delete).toHaveBeenCalledTimes(1);
    expect(asked(policyProvider.delete.mock.calls[0]![4])?.('role', ROLE_PHYS, 'n')).toBe(true);
    expect(holding()).toEqual({ n: 'docP' });
  });

  it('a role revert that changed its own Policies claims for a later CREATE-rollback delete', async () => {
    // Deploy: the role dropped `n` from its Policies while New (name `n`) was
    // created on it. Rollback: the role's revert puts `n` back first, then
    // New's delete must leave it to the role.
    const state: Record<string, ResourceState> = {
      R: roleRecord([]),
      New: policyRecord('n', 'docNew'),
    };
    put('n', 'docNew');
    const ops = [
      updateOp('R', roleRecord([{ PolicyName: 'n', PolicyDocument: 'docRole' }]), state['R']!),
      createOp('New', state['New']!),
    ];

    await replayRollback(ops, state, 'S', ctx);

    expect(roleProvider.update).toHaveBeenCalledTimes(1);
    expect(asked(policyProvider.delete.mock.calls[0]![4])?.('role', ROLE_PHYS, 'n')).toBe(true);
    expect(holding()).toEqual({ n: 'docRole' });
  });

  it('CONTROL: a role revert that left its Policies alone claims nothing', async () => {
    // The role's revert changed something else; its `Policies` were equal on
    // both records, so this revert is not known to have put `n`.
    const policies = [{ PolicyName: 'n', PolicyDocument: 'docRole' }];
    const after: ResourceState = { ...roleRecord(policies), properties: { Policies: policies, Path: '/b/' } };
    const before: ResourceState = { ...roleRecord(policies), properties: { Policies: policies, Path: '/a/' } };
    const state: Record<string, ResourceState> = { R: after, New: policyRecord('n', 'docNew') };
    put('n', 'docNew');

    await replayRollback([updateOp('R', before, after), createOp('New', state['New']!)], state, 'S', ctx);

    expect(roleProvider.update).toHaveBeenCalledTimes(1);
    expect(asked(policyProvider.delete.mock.calls[0]![4])?.('role', ROLE_PHYS, 'n')).toBe(false);
  });

  it('a re-adopt\'s delete of the new copy keeps a name another reversal put back', async () => {
    // A was REPLACED x -> y with UpdateReplacePolicy: Retain, so its rollback
    // re-adopts the retained `x` and deletes the new `y`. B's rename y -> x
    // reversed first and re-created `y`, which A's delete must leave.
    // go-to-k/cdkd#4408: B's reversal deleted `x`, which B's new copy had
    // overwritten, and the re-adopt writes nothing; the end of the replay
    // puts A's recorded document back under `x`.
    const state: Record<string, ResourceState> = {
      A: policyRecord('y', 'docA'),
      B: policyRecord('x', 'docB'),
    };
    put('x', 'docB');
    put('y', 'docA');
    const ops = [
      { ...updateOp('A', policyRecord('x', 'docA'), policyRecord('y', 'docA')), oldResourceRetained: true },
      updateOp('B', policyRecord('y', 'docB'), policyRecord('x', 'docB')),
    ];

    await replayRollback(ops, state, 'S', ctx);

    const readoptDelete = policyProvider.delete.mock.calls.find((c) => c[0] === 'A')!;
    expect(readoptDelete[1]).toBe('y');
    expect(asked(readoptDelete[4])?.('role', ROLE_PHYS, 'y')).toBe(true);
    expect(held.get('y')).toBe('docB');
    expect(held.get('x')).toBe('docA');
  });

  it('a revert routed through Cloud Control under an sdk record is no writer', async () => {
    // The journaled op says the update went through Cloud Control while the
    // previous record (which the revert writes back) says `sdk`: the write
    // took the Cloud Control route, which is not known to re-put every entry.
    const state: Record<string, ResourceState> = {
      P: policyRecord('n', 'docP', []),
      New: policyRecord('n', 'docNew'),
    };
    put('n', 'docNew');
    const routed: RollbackExecutorContext = {
      ...ctx,
      providerRegistry: {
        getProviderFor: ({ provisionedBy }: { provisionedBy?: string }) => ({
          provider: policyProvider,
          provisionedBy: provisionedBy === 'cc-api' ? 'cc-api' : 'sdk',
        }),
      } as unknown as RollbackExecutorContext['providerRegistry'],
    };
    const ops = [
      createOp('New', state['New']!),
      { ...updateOp('P', policyRecord('n', 'docP'), state['P']!), provisionedBy: 'cc-api' as const },
    ];

    await replayRollback(ops, state, 'S', routed);

    expect(policyProvider.update).toHaveBeenCalledTimes(1);
    expect(state['P']!.provisionedBy).toBe('sdk');
    expect(asked(policyProvider.delete.mock.calls[0]![4])?.('role', ROLE_PHYS, 'n')).toBe(false);
  });

  it('a re-create and a --revert-failed revert routed through Cloud Control are no writers', async () => {
    // The registry routes every write through Cloud Control while each record
    // says `sdk` (a provider-less route, say): neither write may claim.
    const ccCtx: RollbackExecutorContext = {
      ...ctx,
      providerRegistry: {
        getProviderFor: ({ resourceType }: { resourceType: string }) => ({
          provider: resourceType === ROLE ? roleProvider : policyProvider,
          provisionedBy: 'cc-api',
        }),
      } as unknown as RollbackExecutorContext['providerRegistry'],
    };
    const before = roleRecord([{ PolicyName: 'n', PolicyDocument: 'docRole' }]);
    const state: Record<string, ResourceState> = {
      R: before,
      Q: policyRecord('m', 'docQ'),
      New: policyRecord('n', 'docNew'),
      New2: policyRecord('q', 'docNew2'),
    };
    const writers = new RollbackInlinePolicyWriters();
    const failed = [
      {
        logicalId: 'R',
        changeType: 'UPDATE',
        resourceType: ROLE,
        physicalId: ROLE_PHYS,
        attemptedProperties: { Policies: [] },
        previousState: before,
        provisionedBy: 'sdk',
      },
    ] as FailedOperation[];

    await replayFailedOperations(failed, state, 'S', ccCtx, { inlinePolicyWriters: writers });
    await replayRollback(
      [
        updateOp('Q', policyRecord('q', 'docQ'), policyRecord('m', 'docQ')),
        createOp('New', state['New']!),
        createOp('New2', state['New2']!),
      ],
      state,
      'S',
      ccCtx,
      { inlinePolicyWriters: writers }
    );

    const deleteOf = (lid: string) => policyProvider.delete.mock.calls.find((c) => c[0] === lid)!;
    expect(asked(deleteOf('New')[4])?.('role', ROLE_PHYS, 'n')).toBe(false);
    expect(asked(deleteOf('New2')[4])?.('role', ROLE_PHYS, 'q')).toBe(false);
  });

  it('CONTROL: with no other writer, a CREATE-rollback delete still removes its name', async () => {
    const state: Record<string, ResourceState> = { New: policyRecord('n', 'docNew') };
    put('n', 'docNew');

    await replayRollback([createOp('New', state['New']!)], state, 'S', ctx);

    expect(asked(policyProvider.delete.mock.calls[0]![4])?.('role', ROLE_PHYS, 'n')).toBe(false);
    expect(holding()).toEqual({});
  });

  it('a PARTIAL revert is no completed writer', async () => {
    const state: Record<string, ResourceState> = {
      P: policyRecord('n', 'docP', []),
      New: policyRecord('n', 'docNew'),
    };
    put('n', 'docNew');
    policyProvider.update.mockImplementationOnce(async (_l, _p, _t, props: PolicyProps) => {
      put(props.PolicyName, props.PolicyDocument);
      return {
        physicalId: props.PolicyName,
        wasReplaced: false,
        outcome: 'partial',
        reason: 'left something',
      } as never;
    });

    await replayRollback(
      [createOp('New', state['New']!), updateOp('P', policyRecord('n', 'docP'), state['P']!)],
      state,
      'S',
      ctx
    );

    expect(policyProvider.update).toHaveBeenCalledTimes(1);
    expect(asked(policyProvider.delete.mock.calls[0]![4])?.('role', ROLE_PHYS, 'n')).toBe(false);
  });

  it('a PARTIAL --revert-failed revert is no completed writer', async () => {
    // P's failed update detached `n` (Roles [role] -> []); its force-revert
    // re-attaches `n` but comes back partial, so New's later delete must not
    // be told `n` is claimed.
    const state: Record<string, ResourceState> = {
      P: policyRecord('n', 'docP', []),
      New: policyRecord('n', 'docNew'),
    };
    put('n', 'docNew');
    policyProvider.update.mockImplementationOnce(async (_l, _p, _t, props: PolicyProps) => {
      put(props.PolicyName, props.PolicyDocument);
      return {
        physicalId: props.PolicyName,
        wasReplaced: false,
        outcome: 'partial',
        reason: 'left something',
      } as never;
    });
    const writers = new RollbackInlinePolicyWriters();
    const failed = [
      {
        logicalId: 'P',
        changeType: 'UPDATE',
        resourceType: POLICY,
        physicalId: 'n',
        attemptedProperties: policyRecord('n', 'docP', []).properties,
        previousState: policyRecord('n', 'docP'),
        provisionedBy: 'sdk',
      },
    ] as FailedOperation[];

    await replayFailedOperations(failed, state, 'S', ctx, { inlinePolicyWriters: writers });
    await replayRollback([createOp('New', state['New']!)], state, 'S', ctx, {
      inlinePolicyWriters: writers,
    });

    expect(policyProvider.update).toHaveBeenCalledTimes(1);
    expect(asked(policyProvider.delete.mock.calls[0]![4])?.('role', ROLE_PHYS, 'n')).toBe(false);
  });

  it('a non-IAM type is handed no predicate', async () => {
    const other = { update: vi.fn().mockResolvedValue({ physicalId: 'q', wasReplaced: false }) };
    const qctx: RollbackExecutorContext = {
      ...ctx,
      providerRegistry: {
        getProviderFor: () => ({ provider: other, provisionedBy: 'sdk' }),
      } as unknown as RollbackExecutorContext['providerRegistry'],
    };
    const before: ResourceState = { physicalId: 'q', resourceType: 'AWS::SQS::Queue', properties: { A: 1 } };
    const after: ResourceState = { ...before, properties: { A: 2 } };

    await replayRollback([updateOp('Q', before, after)], { Q: after }, 'S', qctx);

    expect(other.update).toHaveBeenCalledTimes(1);
    expect(Object.keys(other.update.mock.calls[0]![5] as object)).not.toContain('inlinePolicyClaimed');
  });

  it('a failed-op revert and the completed replay share ONE record when the caller passes it', async () => {
    // --revert-failed: A's rename x -> y FAILED after putting `y`; B's rename
    // y -> x completed. The failed op reverts first (put `x`, remove `y`),
    // then B reverses (re-create `y`, delete `x`), which must leave `x` to A.
    const state: Record<string, ResourceState> = {
      A: policyRecord('x', 'docA'),
      B: policyRecord('x', 'docB'),
    };
    put('x', 'docB');
    put('y', 'docA');
    const failed: FailedOperation[] = [
      {
        logicalId: 'A',
        changeType: 'UPDATE',
        resourceType: POLICY,
        physicalId: 'x',
        attemptedProperties: policyRecord('y', 'docA').properties,
        previousState: policyRecord('x', 'docA'),
        provisionedBy: 'sdk',
      } as FailedOperation,
    ];
    const writers = new RollbackInlinePolicyWriters();

    await replayFailedOperations(failed, state, 'S', ctx, { inlinePolicyWriters: writers });
    await replayRollback(
      [updateOp('B', policyRecord('y', 'docB'), policyRecord('x', 'docB'))],
      state,
      'S',
      ctx,
      { inlinePolicyWriters: writers }
    );

    expect(holding()).toEqual({ x: 'docA', y: 'docB' });
  });

  it('--revert-failed asks the shared record on both of its IAM arms', async () => {
    // An earlier replay over the same bag (a newer segment) re-created Q's
    // `n` on the role. The failed CREATE of New (name `n`) is deleted, and
    // the failed rename of P `p -> n` is force-reverted with the attempted
    // bag as its previous side: neither may remove Q's `n`.
    const q = policyRecord('n', 'docQ');
    const pPrev = policyRecord('p', 'docP');
    const state: Record<string, ResourceState> = {
      Q: q,
      New: policyRecord('n', 'docNew'),
      P: pPrev,
    };
    put('n', 'docQ');
    const writers = new RollbackInlinePolicyWriters();
    writers.record('Q', 'create', q, false, 'sdk');
    const failed = [
      {
        logicalId: 'New',
        changeType: 'CREATE',
        resourceType: POLICY,
        physicalId: 'n',
        attemptedProperties: policyRecord('n', 'docNew').properties,
        provisionedBy: 'sdk',
      },
      {
        logicalId: 'P',
        changeType: 'UPDATE',
        resourceType: POLICY,
        physicalId: 'p',
        attemptedProperties: policyRecord('n', 'docP').properties,
        previousState: pPrev,
        provisionedBy: 'sdk',
      },
    ] as FailedOperation[];

    await replayFailedOperations(failed, state, 'S', ctx, { inlinePolicyWriters: writers });

    expect(asked(policyProvider.delete.mock.calls[0]![4])?.('role', ROLE_PHYS, 'n')).toBe(true);
    expect(asked(policyProvider.update.mock.calls[0]![5])?.('role', ROLE_PHYS, 'n')).toBe(true);
    expect(holding()).toEqual({ n: 'docQ', p: 'docP' });
  });

  it('a force-reverted failed role update that changed its Policies is a writer', async () => {
    // The role's failed update attempted to drop `n`; its force-revert puts
    // `n` back, so a later delete of New (name `n`) must leave it.
    const before = roleRecord([{ PolicyName: 'n', PolicyDocument: 'docRole' }]);
    const state: Record<string, ResourceState> = { R: before, New: policyRecord('n', 'docNew') };
    put('n', 'docNew');
    const writers = new RollbackInlinePolicyWriters();
    const failed = [
      {
        logicalId: 'R',
        changeType: 'UPDATE',
        resourceType: ROLE,
        physicalId: ROLE_PHYS,
        attemptedProperties: { Policies: [] },
        previousState: before,
        provisionedBy: 'sdk',
      },
    ] as FailedOperation[];

    await replayFailedOperations(failed, state, 'S', ctx, { inlinePolicyWriters: writers });
    await replayRollback([createOp('New', state['New']!)], state, 'S', ctx, {
      inlinePolicyWriters: writers,
    });

    expect(roleProvider.update).toHaveBeenCalledTimes(1);
    expect(asked(policyProvider.delete.mock.calls[0]![4])?.('role', ROLE_PHYS, 'n')).toBe(true);
  });

  it('a force-reverted failed role update with no attempted bag compares against the live record', async () => {
    // No `attemptedProperties` journaled: the previous side is the current
    // record, whose Policies lack `n`, so the revert put `n` and claims it.
    const before = roleRecord([{ PolicyName: 'n', PolicyDocument: 'docRole' }]);
    const state: Record<string, ResourceState> = { R: roleRecord([]), New: policyRecord('n', 'docNew') };
    put('n', 'docNew');
    const writers = new RollbackInlinePolicyWriters();
    const failed = [
      {
        logicalId: 'R',
        changeType: 'UPDATE',
        resourceType: ROLE,
        physicalId: ROLE_PHYS,
        previousState: before,
        provisionedBy: 'sdk',
      },
    ] as FailedOperation[];

    await replayFailedOperations(failed, state, 'S', ctx, { inlinePolicyWriters: writers });
    await replayRollback([createOp('New', state['New']!)], state, 'S', ctx, {
      inlinePolicyWriters: writers,
    });

    expect(roleProvider.update).toHaveBeenCalledTimes(1);
    expect(asked(policyProvider.delete.mock.calls[0]![4])?.('role', ROLE_PHYS, 'n')).toBe(true);
  });

  it('CONTROL: with no attempted bag and the live record\'s Policies unchanged, the revert claims nothing', async () => {
    // The live record already declares `n`: the force-revert changed only
    // `Path`, so it is not known to have put `n`. Comparing against the
    // absent attempted bag instead would read the Policies as changed.
    const policies = [{ PolicyName: 'n', PolicyDocument: 'docRole' }];
    const before: ResourceState = { ...roleRecord(policies), properties: { Policies: policies, Path: '/a/' } };
    const live: ResourceState = { ...roleRecord(policies), properties: { Policies: policies, Path: '/b/' } };
    const state: Record<string, ResourceState> = { R: live, New: policyRecord('n', 'docNew') };
    put('n', 'docNew');
    const writers = new RollbackInlinePolicyWriters();
    const failed = [
      {
        logicalId: 'R',
        changeType: 'UPDATE',
        resourceType: ROLE,
        physicalId: ROLE_PHYS,
        previousState: before,
        provisionedBy: 'sdk',
      },
    ] as FailedOperation[];

    await replayFailedOperations(failed, state, 'S', ctx, { inlinePolicyWriters: writers });
    await replayRollback([createOp('New', state['New']!)], state, 'S', ctx, {
      inlinePolicyWriters: writers,
    });

    expect(roleProvider.update).toHaveBeenCalledTimes(1);
    expect(asked(policyProvider.delete.mock.calls[0]![4])?.('role', ROLE_PHYS, 'n')).toBe(false);
  });

  it('CONTROL: separate calls with no shared record do not see each other\'s writes', async () => {
    // The second call's delete of `x` is not told A's revert put it back. A's
    // record still holds `x`, so the end of that replay puts A's document
    // back (go-to-k/cdkd#4408): the shared record keeps the name, and the
    // put-back repairs a removal it could not prevent.
    const state: Record<string, ResourceState> = {
      A: policyRecord('x', 'docA'),
      B: policyRecord('x', 'docB'),
    };
    put('x', 'docB');
    put('y', 'docA');
    const failed = [
      {
        logicalId: 'A',
        changeType: 'UPDATE',
        resourceType: POLICY,
        physicalId: 'x',
        attemptedProperties: policyRecord('y', 'docA').properties,
        previousState: policyRecord('x', 'docA'),
        provisionedBy: 'sdk',
      } as FailedOperation,
    ];

    await replayFailedOperations(failed, state, 'S', ctx);
    await replayRollback(
      [updateOp('B', policyRecord('y', 'docB'), policyRecord('x', 'docB'))],
      state,
      'S',
      ctx
    );

    const deleteOfX = policyProvider.delete.mock.calls.find((c) => c[1] === 'x')!;
    expect(asked(deleteOfX[4])?.('role', ROLE_PHYS, 'x')).toBe(false);
    expect(policyProvider.create.mock.calls.filter((c) => c[0] === 'A')).toHaveLength(1);
    expect(holding()).toEqual({ x: 'docA', y: 'docB' });
  });
});

describe('RollbackInlinePolicyWriters (go-to-k/cdkd#4225)', () => {
  const ask = (
    writers: RollbackInlinePolicyWriters,
    state: Record<string, ResourceState>,
    asker = 'Self',
    askerType = POLICY
  ): boolean => writers.claimedFor(askerType, asker, state)!('role', ROLE_PHYS, 'n');

  it('hands a predicate to AWS::IAM::Policy and the three principal types only', () => {
    const writers = new RollbackInlinePolicyWriters();
    for (const t of [POLICY, ROLE, 'AWS::IAM::Group', 'AWS::IAM::User']) {
      expect(writers.claimedFor(t, 'X', {}), t).toBeTypeOf('function');
    }
    for (const t of ['AWS::IAM::ManagedPolicy', 'AWS::SQS::Queue', 'constructor', 'toString']) {
      expect(writers.claimedFor(t, 'X', {}), t).toBeUndefined();
    }
  });

  it('a writer counts only while its record is still the live one', () => {
    const writers = new RollbackInlinePolicyWriters();
    const record = policyRecord('n', 'docP');
    const state: Record<string, ResourceState> = { P: record };
    writers.record('P', 'create', record, false, 'sdk');
    expect(ask(writers, state)).toBe(true);
    // An equal copy is not the record the write produced.
    state['P'] = { ...record };
    expect(ask(writers, state)).toBe(false);
    delete state['P'];
    expect(ask(writers, state)).toBe(false);
  });

  it('reads the state bag live, at each call', () => {
    const writers = new RollbackInlinePolicyWriters();
    const state: Record<string, ResourceState> = {};
    const predicate = writers.claimedFor(POLICY, 'Self', state)!;
    const record = policyRecord('n', 'docP');
    state['P'] = record;
    writers.record('P', 'create', record, false, 'sdk');
    expect(predicate('role', ROLE_PHYS, 'n')).toBe(true);
  });

  it('never claims for the asker itself', () => {
    const writers = new RollbackInlinePolicyWriters();
    const record = policyRecord('n', 'docP');
    writers.record('P', 'create', record, false, 'sdk');
    expect(ask(writers, { P: record }, 'P')).toBe(false);
  });

  it('a principal revert claims its Policies only when its records differed there', () => {
    const writers = new RollbackInlinePolicyWriters();
    const record = roleRecord([{ PolicyName: 'n', PolicyDocument: 'docRole' }]);
    writers.record('R', 'update', record, false, 'sdk');
    expect(ask(writers, { R: record })).toBe(false);
    writers.record('R', 'update', record, true, 'sdk');
    expect(ask(writers, { R: record })).toBe(true);
    // A principal re-created by a reverse replacement put every entry.
    writers.record('R', 'create', record, false, 'sdk');
    expect(ask(writers, { R: record })).toBe(true);
  });

  it('a write routed through Cloud Control is not recorded, and voids an earlier entry', () => {
    const writers = new RollbackInlinePolicyWriters();
    const record = policyRecord('n', 'docP');
    writers.record('P', 'create', record, false, 'sdk');
    expect(ask(writers, { P: record })).toBe(true);
    writers.record('P', 'update', record, false, 'cc-api');
    expect(ask(writers, { P: record })).toBe(false);
  });

  it('a Cloud Control writer claims nothing', () => {
    const writers = new RollbackInlinePolicyWriters();
    const record = { ...policyRecord('n', 'docP'), provisionedBy: 'cc-api' as const };
    writers.record('P', 'create', record, false, 'sdk');
    expect(ask(writers, { P: record })).toBe(false);
  });
});

describe('a rollback puts back an inline policy its removal took from a record that still holds it (go-to-k/cdkd#4408)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    held = new Map();
  });

  const warned = (): string =>
    (silentLogger.warn as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0])).join('\n');

  it('a rolled-back CREATE that took an old policy\'s name leaves the old document under it', async () => {
    // Deploy: Old (name `n`) is dropped, New takes `n` on the same role. New's
    // create put its document under `n`; a later failure stopped the deploy
    // before Old's DELETE. The rollback deletes New, which removes `n`.
    const state: Record<string, ResourceState> = {
      Old: policyRecord('n', 'docOld'),
      New: policyRecord('n', 'docNew'),
    };
    put('n', 'docNew');

    const result = await replayRollback([createOp('New', state['New']!)], state, 'S', ctx);

    expect(result.failures).toBe(0);
    expect(result.warnings).toBe(0);
    expect(state['New']).toBeUndefined();
    // Before the fix the role ended up without `n` while Old's record lists it.
    expect(holding()).toEqual({ n: 'docOld' });
    expect(policyProvider.create).toHaveBeenCalledTimes(1);
    expect(policyProvider.create.mock.calls[0]!.slice(0, 3)).toEqual([
      'Old',
      POLICY,
      { PolicyName: 'n', PolicyDocument: 'docOld', Roles: [ROLE_PHYS] },
    ]);
    expect((silentLogger.info as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])).toContain(
      '  Rollback: put back the inline policy Old records on its role'
    );
  });

  it('puts back the role\'s own Policies entry of that name, with the role\'s document', async () => {
    const docRole = { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: 's3:GetObject' }] };
    const state: Record<string, ResourceState> = {
      R: { ...roleRecord([]), properties: { Policies: [{ PolicyName: 'N', PolicyDocument: docRole }] } },
      New: policyRecord('n', 'docNew'),
    };
    put('n', 'docNew');

    await replayRollback([createOp('New', state['New']!)], state, 'S', ctx);

    expect(policyProvider.create).toHaveBeenCalledTimes(1);
    // The holder's spellings, its document as recorded (the provider
    // serializes it as the role provider does).
    expect(policyProvider.create.mock.calls[0]![2]).toEqual({
      PolicyName: 'N',
      PolicyDocument: docRole,
      Roles: [ROLE_PHYS],
    });
  });

  it('a PARTIAL swap reversed without --revert-failed puts the sibling\'s name back', async () => {
    // Deploy: A renamed x -> y, overwriting B's `y`; B's rename y -> x then
    // failed, so only A's op is replayed. A's reversal re-creates `x` and
    // deletes its copy `y`, which B's record still lists.
    const state: Record<string, ResourceState> = {
      A: policyRecord('y', 'docA'),
      B: policyRecord('y', 'docB'),
    };
    put('y', 'docA');

    const result = await replayRollback(
      [updateOp('A', policyRecord('x', 'docA'), policyRecord('y', 'docA'))],
      state,
      'S',
      ctx
    );

    expect(result.failures).toBe(0);
    expect(holding()).toEqual({ x: 'docA', y: 'docB' });
  });

  it('a --revert-failed delete of a failed CREATE puts the old document back too', async () => {
    const state: Record<string, ResourceState> = {
      Old: policyRecord('n', 'docOld'),
      New: policyRecord('n', 'docNew'),
    };
    put('n', 'docNew');
    const failed = [
      {
        logicalId: 'New',
        changeType: 'CREATE',
        resourceType: POLICY,
        physicalId: 'n',
        attemptedProperties: state['New']!.properties,
        provisionedBy: 'sdk',
      },
    ] as FailedOperation[];

    const writers = new RollbackInlinePolicyWriters();

    const result = await replayFailedOperations(failed, state, 'S', ctx, { inlinePolicyWriters: writers });

    expect(result.failures).toBe(0);
    // Nothing is put back before the segment's completed-op replay, whose
    // records may still change; a failed-only segment's runs with no ops.
    expect(holding()).toEqual({});
    await replayRollback([], state, 'S', ctx, { inlinePolicyWriters: writers });
    expect(holding()).toEqual({ n: 'docOld' });
  });

  it('a delete that fails part-way does not put back the grant it revoked from its own record', async () => {
    // New (Roles r1, r2) is deleted: r1 is detached, r2 refuses, so New's
    // record stays. New is the remover of `n` on r1; it must not count as
    // the record holding it there (security review of the go-to-k/cdkd#4408 fix).
    const state: Record<string, ResourceState> = { New: policyRecord('n', 'BROAD', ['r1', 'r2']) };
    put('n', 'BROAD');
    policyProvider.delete.mockImplementationOnce(async (_l, physicalId, _t, props: PolicyProps, c) => {
      expect(asked(c)?.('role', props.Roles[0]!, physicalId)).toBe(false);
      remove(physicalId);
      throw new Error('AccessDenied on r2');
    });

    const result = await replayRollback([createOp('New', state['New']!)], state, 'S', ctx);

    expect(result.failures).toBe(1);
    expect(state['New']).toBeDefined();
    expect(policyProvider.create).not.toHaveBeenCalled();
    expect(holding()).toEqual({});
  });

  it('CONTROL: a part-way failed delete still puts back ANOTHER record\'s document', async () => {
    const state: Record<string, ResourceState> = {
      Old: policyRecord('n', 'docOld', ['r1']),
      New: policyRecord('n', 'docNew', ['r1', 'r2']),
    };
    put('n', 'docNew');
    policyProvider.delete.mockImplementationOnce(async (_l, physicalId, _t, props: PolicyProps, c) => {
      asked(c)?.('role', props.Roles[0]!, physicalId);
      remove(physicalId);
      throw new Error('AccessDenied on r2');
    });

    await replayRollback([createOp('New', state['New']!)], state, 'S', ctx);

    expect(policyProvider.create).toHaveBeenCalledTimes(1);
    expect(policyProvider.create.mock.calls[0]![0]).toBe('Old');
    expect(holding()).toEqual({ n: 'docOld' });
  });

  it('a holder whose own record changed since it removed the name holds it again', async () => {
    // A remover is excluded only while its record is the one it had: a
    // later replay that re-adopts it under the removed name makes it a holder.
    const writers = new RollbackInlinePolicyWriters();
    const before = policyRecord('m', 'docA');
    writers.claimedFor(POLICY, 'A', { A: before })!('role', ROLE_PHYS, 'n');
    expect(writers.takeHeldRemovals({ A: before })).toEqual([]);
    const after = policyRecord('n', 'docA');
    expect(writers.takeHeldRemovals({ A: after })).toHaveLength(1);
  });

  it('a holder another record may shadow under a redacted name is not put back, and it warns', async () => {
    const state: Record<string, ResourceState> = {
      Old: policyRecord('n', 'docOld'),
      R: roleRecord([{ PolicyName: '{{resolve:secretsmanager:s}}', PolicyDocument: 'docR' }]),
      New: policyRecord('n', 'docNew'),
    };
    put('n', 'docNew');

    const result = await replayRollback([createOp('New', state['New']!)], state, 'S', ctx);

    expect(policyProvider.create).not.toHaveBeenCalled();
    expect(result.warnings).toBe(1);
    expect(warned()).toContain('recorded by Old, and R may record it too under a redacted name');
  });

  it('a policy record listing the principal under a redacted entry shadows it too', async () => {
    const state: Record<string, ResourceState> = {
      Old: policyRecord('n', 'docOld'),
      Other: policyRecord('n', 'docOther', ['***']),
      New: policyRecord('n', 'docNew'),
    };
    put('n', 'docNew');

    const result = await replayRollback([createOp('New', state['New']!)], state, 'S', ctx);

    expect(policyProvider.create).not.toHaveBeenCalled();
    expect(result.warnings).toBe(1);
  });

  it.each([
    ['AWS::IAM::Group', 'group', 'Groups'],
    ['AWS::IAM::User', 'user', 'Users'],
  ] as const)('a %s holder is put back under its own list key', async (type, kind, field) => {
    // The remover is a principal revert of that kind dropping `n`; the
    // holder is a policy listing the same principal under `field`.
    const principalBefore: ResourceState = {
      physicalId: 'p-phys',
      resourceType: type,
      properties: { Policies: [{ PolicyName: 'n', PolicyDocument: 'docMine' }] },
      provisionedBy: 'sdk',
    };
    const principalAfter: ResourceState = { ...principalBefore, properties: { Policies: [] } };
    const holder: ResourceState = {
      physicalId: 'n',
      resourceType: POLICY,
      properties: { PolicyName: 'n', PolicyDocument: 'docHolder', [field]: ['p-phys'] },
      provisionedBy: 'sdk',
    };
    const writers = new RollbackInlinePolicyWriters();
    // The principal's revert (back to `principalAfter`) asked about `n`.
    writers.claimedFor(type, 'P', { P: principalBefore, H: holder })!(kind, 'p-phys', 'n');

    const result = await replayRollback([], { P: principalAfter, H: holder }, 'S', ctx, {
      inlinePolicyWriters: writers,
    });

    expect(result.warnings).toBe(0);
    expect(policyProvider.create).toHaveBeenCalledTimes(1);
    expect(policyProvider.create.mock.calls[0]![2]).toEqual({
      PolicyName: 'n',
      PolicyDocument: 'docHolder',
      [field]: ['p-phys'],
    });
    expect((silentLogger.info as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])).toContain(
      `  Rollback: put back the inline policy H records on its ${kind}`
    );
  });

  it('an interrupted replay still puts back what its completed ops removed', async () => {
    const state: Record<string, ResourceState> = {
      Old: policyRecord('n', 'docOld'),
      New: policyRecord('n', 'docNew'),
      Later: policyRecord('q', 'docLater'),
    };
    put('n', 'docNew');
    put('q', 'docLater');
    let ops = 0;
    policyProvider.delete.mockImplementationOnce(async (_l, physicalId, _t, props: PolicyProps, c) => {
      ops++;
      asked(c)?.('role', props.Roles[0]!, physicalId);
      remove(physicalId);
    });

    const result = await replayRollback(
      [createOp('New', state['New']!), createOp('Later', state['Later']!)],
      state,
      'S',
      ctx,
      { isInterrupted: () => ops > 0 }
    );

    expect(result.interrupted).toBe(true);
    expect(state['Later']).toBeDefined();
    expect(holding()).toEqual({ n: 'docOld', q: 'docLater' });
  });

  it('a Cloud Control record holds the name too: the put-back writes what it records', async () => {
    const state: Record<string, ResourceState> = {
      Old: { ...policyRecord('n', 'docOld'), provisionedBy: 'cc-api' },
      New: policyRecord('n', 'docNew'),
    };
    put('n', 'docNew');

    await replayRollback([createOp('New', state['New']!)], state, 'S', ctx);

    expect(holding()).toEqual({ n: 'docOld' });
  });

  it('a removal no record holds yet is put back by a later replay over the same bag', async () => {
    // Newest segment: New's CREATE took `n`; nothing records `n` once it is
    // deleted. Older segment: Old's replacement n -> m kept the old copy
    // (Retain), so its re-adopt points Old back at `n` and writes nothing.
    const state: Record<string, ResourceState> = {
      Old: policyRecord('m', 'docOld'),
      New: policyRecord('n', 'docNew'),
    };
    put('n', 'docNew');
    put('m', 'docOld');
    const writers = new RollbackInlinePolicyWriters();

    await replayRollback([createOp('New', state['New']!)], state, 'S', ctx, { inlinePolicyWriters: writers });
    expect(holding()).toEqual({ m: 'docOld' });
    await replayRollback(
      [{ ...updateOp('Old', policyRecord('n', 'docOld'), state['Old']!), oldResourceRetained: true }],
      state,
      'S',
      ctx,
      { inlinePolicyWriters: writers }
    );

    expect(holding()).toEqual({ n: 'docOld' });
  });

  it('CONTROL: without the shared record, the later replay knows of no removal', async () => {
    const state: Record<string, ResourceState> = {
      Old: policyRecord('m', 'docOld'),
      New: policyRecord('n', 'docNew'),
    };
    put('n', 'docNew');
    put('m', 'docOld');

    await replayRollback([createOp('New', state['New']!)], state, 'S', ctx);
    await replayRollback(
      [{ ...updateOp('Old', policyRecord('n', 'docOld'), state['Old']!), oldResourceRetained: true }],
      state,
      'S',
      ctx
    );

    expect(policyProvider.create).not.toHaveBeenCalled();
    expect(holding()).toEqual({});
  });

  it('CONTROL: a name no record holds stays removed', async () => {
    const state: Record<string, ResourceState> = { New: policyRecord('n', 'docNew') };
    put('n', 'docNew');

    const result = await replayRollback([createOp('New', state['New']!)], state, 'S', ctx);

    expect(policyProvider.create).not.toHaveBeenCalled();
    expect(result.warnings).toBe(0);
    expect(holding()).toEqual({});
  });

  it('CONTROL: a name a completed revert kept is not removed, so nothing is put back', async () => {
    // P's revert re-attaches `n`; New's delete is told it is claimed.
    const state: Record<string, ResourceState> = {
      P: policyRecord('n', 'docP', []),
      New: policyRecord('n', 'docNew'),
    };
    put('n', 'docNew');

    await replayRollback(
      [createOp('New', state['New']!), updateOp('P', policyRecord('n', 'docP'), state['P']!)],
      state,
      'S',
      ctx
    );

    expect(policyProvider.create).not.toHaveBeenCalled();
    expect(holding()).toEqual({ n: 'docP' });
  });

  it('two records holding the name with different documents: neither is put back, and it warns', async () => {
    const state: Record<string, ResourceState> = {
      Old: policyRecord('n', 'docOld'),
      R: roleRecord([{ PolicyName: 'n', PolicyDocument: 'docRole' }]),
      New: policyRecord('n', 'docNew'),
    };
    put('n', 'docNew');

    const result = await replayRollback([createOp('New', state['New']!)], state, 'S', ctx);

    expect(policyProvider.create).not.toHaveBeenCalled();
    expect(holding()).toEqual({});
    expect(result.warnings).toBe(1);
    expect(warned()).toContain('recorded by Old, R with different documents');
    expect(warned()).toContain("'cdkd drift <stack> --revert'");
  });

  it('CONTROL: two records holding the name with the SAME document put it back once', async () => {
    const state: Record<string, ResourceState> = {
      Old: policyRecord('n', 'docOld'),
      R: roleRecord([{ PolicyName: 'n', PolicyDocument: 'docOld' }]),
      New: policyRecord('n', 'docNew'),
    };
    put('n', 'docNew');

    const result = await replayRollback([createOp('New', state['New']!)], state, 'S', ctx);

    expect(policyProvider.create).toHaveBeenCalledTimes(1);
    expect(result.warnings).toBe(0);
    expect(holding()).toEqual({ n: 'docOld' });
  });

  it.each([
    ['a secret reference', { Statement: [{ Resource: '{{resolve:secretsmanager:arn:aws:secretsmanager:us-east-1:111122223333:secret:s}}' }] }],
    ['the mask', { Statement: [{ Resource: '***' }] }],
    ['no document', undefined],
    ['an empty string', ''],
  ])('a recorded document holding %s is not put back, and it warns', async (_label, document) => {
    const state: Record<string, ResourceState> = {
      Old: { ...policyRecord('n', 'docOld'), properties: { PolicyName: 'n', PolicyDocument: document, Roles: [ROLE_PHYS] } },
      New: policyRecord('n', 'docNew'),
    };
    put('n', 'docNew');

    const result = await replayRollback([createOp('New', state['New']!)], state, 'S', ctx);

    expect(policyProvider.create).not.toHaveBeenCalled();
    expect(holding()).toEqual({});
    expect(result.warnings).toBe(1);
    expect(warned()).toContain('recorded document is absent or redacted');
  });

  it('a failed put warns and fails nothing', async () => {
    const state: Record<string, ResourceState> = {
      Old: policyRecord('n', 'docOld'),
      New: policyRecord('n', 'docNew'),
    };
    put('n', 'docNew');
    policyProvider.create.mockRejectedValueOnce(new Error('AccessDenied: iam:PutRolePolicy'));

    const result = await replayRollback([createOp('New', state['New']!)], state, 'S', ctx);

    expect(result.failures).toBe(0);
    expect(result.warnings).toBe(1);
    expect(state['New']).toBeUndefined();
    expect(warned()).toContain('could not put back the inline policy Old records on its role');
    expect(warned()).toContain('AccessDenied: iam:PutRolePolicy');
  });

  it('a put-back the registry would not route to the SDK provider is not sent', async () => {
    const ccCtx: RollbackExecutorContext = {
      ...ctx,
      providerRegistry: {
        getProviderFor: ({ resourceType }: { resourceType: string }) => ({
          provider: resourceType === ROLE ? roleProvider : policyProvider,
          provisionedBy: 'cc-api',
        }),
      } as unknown as RollbackExecutorContext['providerRegistry'],
    };
    const state: Record<string, ResourceState> = {
      Old: policyRecord('n', 'docOld'),
      New: policyRecord('n', 'docNew'),
    };
    put('n', 'docNew');

    const result = await replayRollback([createOp('New', state['New']!)], state, 'S', ccCtx);

    expect(policyProvider.create).not.toHaveBeenCalled();
    expect(result.warnings).toBe(1);
  });

  it('the put-back logs logical ids, never a policy or principal name', async () => {
    const state: Record<string, ResourceState> = {
      Old: policyRecord('secret-derived-name', 'docOld'),
      New: policyRecord('secret-derived-name', 'docNew'),
    };
    put('secret-derived-name', 'docNew');
    policyProvider.create.mockRejectedValueOnce(new Error('denied'));

    await replayRollback([createOp('New', state['New']!)], state, 'S', ctx);

    expect(warned()).not.toContain('secret-derived-name');
    expect(policyProvider.create).toHaveBeenCalledTimes(1);
  });
});

describe('RollbackInlinePolicyWriters.takeHeldRemovals (go-to-k/cdkd#4408)', () => {
  const remove = (writers: RollbackInlinePolicyWriters, principal: string, policyName: string): boolean =>
    writers.claimedFor(POLICY, 'Remover', {})!('role', principal, policyName);

  it('hands out a removal once, and only while a record holds its name there', () => {
    const writers = new RollbackInlinePolicyWriters();
    expect(remove(writers, ROLE_PHYS, 'n')).toBe(false);
    expect(writers.takeHeldRemovals({})).toEqual([]);
    const state = { Old: policyRecord('N', 'docOld', ['ROLE-PHYS']) };
    expect(writers.takeHeldRemovals(state)).toEqual([
      {
        kind: 'role',
        holders: [{ logicalId: 'Old', principal: 'ROLE-PHYS', policyName: 'N', document: 'docOld' }],
        unreadable: [],
      },
    ]);
    expect(writers.takeHeldRemovals(state)).toEqual([]);
  });

  it('notes nothing for a claimed name, or a value outside IAM\'s name charset', () => {
    const writers = new RollbackInlinePolicyWriters();
    const p = policyRecord('n', 'docP');
    writers.record('P', 'create', p, false, 'sdk');
    expect(writers.claimedFor(POLICY, 'Remover', { P: p })!('role', ROLE_PHYS, 'n')).toBe(true);
    expect(remove(writers, '***', 'n')).toBe(false);
    expect(remove(writers, ROLE_PHYS, '{{resolve:secretsmanager:s}}')).toBe(false);
    const state = {
      P: p,
      Masked: { ...policyRecord('n', 'd'), properties: { PolicyDocument: 'd', Roles: ['***'] } },
    };
    expect(writers.takeHeldRemovals(state)).toEqual([]);
  });

  it('a record of another kind, principal or name holds nothing', () => {
    const writers = new RollbackInlinePolicyWriters();
    remove(writers, ROLE_PHYS, 'n');
    const state: Record<string, ResourceState> = {
      OtherName: policyRecord('m', 'd'),
      OtherRole: policyRecord('n', 'd', ['other-role']),
      AsGroup: { ...policyRecord('n', 'd', []), properties: { PolicyDocument: 'd', Groups: [ROLE_PHYS] } },
      GroupNamedLikeRole: {
        physicalId: ROLE_PHYS,
        resourceType: 'AWS::IAM::Group',
        properties: { Policies: [{ PolicyName: 'n', PolicyDocument: 'd' }] },
      },
      Managed: { physicalId: 'n', resourceType: 'AWS::IAM::ManagedPolicy', properties: { Roles: [ROLE_PHYS] } },
    };
    expect(writers.takeHeldRemovals(state)).toEqual([]);
  });
});
