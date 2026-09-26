/**
 * The reverse-replacement replay-CREATE fills a `FALLBACK_NAME_RULES` name when
 * it is routed to Cloud Control (issue
 * https://github.com/go-to-k/cdkd/issues/3199).
 *
 * The bag handed to the replay `create()` is `previousState.properties` — the
 * RECORDED bag, which `propertiesToRecord` fills from the template's resolved
 * properties and which therefore never carries a name cdkd GENERATED. That is
 * the same invariant the deploy engine's Cloud Control UPDATE path relies on.
 * A Cloud Control CREATE is the one place the name IS required, and
 * `preparePropertiesForCcApi` fills it at all three of the engine's create
 * sites — these two replay sites were the FOURTH and filled nothing. The
 * consequence splits by type: for a type whose name is optional AWS minted a
 * random one, and for `AWS::Lambda::CapacityProvider`, whose Cloud Control
 * handler fails without a name, the replay failed outright — which on the
 * delete-new-first arm leaves the resource absent from AWS AND from state.
 *
 * Both arms are pinned, and so are the three ways the fill must NOT fire (an
 * SDK route, a type with no rule, a previousState that already names the
 * resource). Two further cases pin the properties that make the fill CORRECT
 * rather than merely present: the replayed name is byte-identical to what the
 * forward create would have minted for the same stack + logical id, and the
 * generated name does not leak into the rebuilt STATE RECORD — writing it there
 * would break the invariant quoted above.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  replayRollback,
  type CompletedOperation,
  type RollbackExecutorContext,
} from '../../../src/deployment/rollback-executor.js';
import type { ResourceState } from '../../../src/types/state.js';
import {
  applyDefaultNameForFallback,
  withStackName,
} from '../../../src/provisioning/resource-name.js';
import { awsSdkError } from '../_aws-sdk-error.js';

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({}),
  setAwsClients: vi.fn(),
  AwsClients: vi.fn(),
}));

/** `isNameCollisionError` signature — the delete-new-first trigger. */
const COLLISION_MESSAGE = "Resource of type 'AWS::SQS::Queue' already exists.";

/** The stack name the rollback entry points bind (see the parity case below). */
const STACK = 'MyStack';
/** A type WITH a `FALLBACK_NAME_RULES` entry, whose name property is `QueueName`. */
const NAMED_TYPE = 'AWS::SQS::Queue';
/** A type with NO entry in that table. */
const UNRULED_TYPE = 'AWS::EC2::VPC';

const silentLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  setLevel: vi.fn(),
  child: () => silentLogger,
} as unknown as RollbackExecutorContext['logger'];

function res(overrides: Partial<ResourceState> = {}): ResourceState {
  return {
    physicalId: 'phys',
    resourceType: NAMED_TYPE,
    properties: {},
    attributes: {},
    dependencies: [],
    ...overrides,
  };
}

/**
 * A reverse-replacement op: the state record's physicalId differs from the
 * journaled previousState's, which is what `classifyRollbackOp` keys on.
 */
function reverseReplacementOp(
  resourceType = NAMED_TYPE,
  prevProperties: Record<string, unknown> = {}
): CompletedOperation {
  return {
    logicalId: 'Q',
    changeType: 'UPDATE',
    resourceType,
    physicalId: 'new-q',
    previousState: res({ physicalId: 'old-q', resourceType, properties: prevProperties }),
  };
}

/**
 * `provisionedBy` is returned by the REGISTRY here, not read off the state
 * record, because that is what the fix gates on — a pre-v7 record carries no
 * hint and the registry still routes a type with no SDK provider to Cloud
 * Control, so the routing DECISION is the only reading that matches what the
 * create will actually call.
 */
function makeCtx(
  provider: { delete?: unknown; create?: unknown },
  provisionedBy: 'sdk' | 'cc-api' = 'cc-api'
): { ctx: RollbackExecutorContext; routingInputs: Record<string, unknown>[] } {
  // The lookups are RECORDED, not just answered. The stub returns one decision
  // for every call, and the re-create and the new resource's DELETE are two
  // separate lookups on two different `provisionedBy` values — so without
  // pinning the argument, an edit that read the DELETE-side routing for the
  // create would be invisible here.
  const routingInputs: Record<string, unknown>[] = [];
  const ctx: RollbackExecutorContext = {
    region: 'us-east-1',
    logger: silentLogger,
    providerRegistry: {
      getProviderFor: (input: Record<string, unknown>) => {
        routingInputs.push(input);
        return { provider, provisionedBy };
      },
    } as unknown as RollbackExecutorContext['providerRegistry'],
  };
  return { ctx, routingInputs };
}

/** Captures the property bag each `create()` call received. */
function capturingCreate(physicalId = 'old-q') {
  const bags: Record<string, unknown>[] = [];
  const create = vi.fn(async (_id: string, _type: string, props: Record<string, unknown>) => {
    bags.push(props);
    return { physicalId, attributes: {} };
  });
  return { create, bags };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('the Cloud Control replay-CREATE receives a generated name (#3199)', () => {
  it('create-first arm: a recorded bag naming nothing gets the generated name', async () => {
    const { create, bags } = capturingCreate();
    const del = vi.fn().mockResolvedValue(undefined);
    const { ctx } = makeCtx({ create, delete: del });
    const state: Record<string, ResourceState> = { Q: res({ physicalId: 'new-q' }) };

    const result = await withStackName(STACK, () =>
      replayRollback([reverseReplacementOp()], state, STACK, ctx)
    );

    expect(result.failures).toBe(0);
    // THE DISCRIMINATOR: before the fix this bag was `{}`.
    expect(bags[0]).toEqual({ QueueName: `${STACK}-Q` });
    expect(state['Q']?.physicalId).toBe('old-q');
  });

  it('delete-new-first arm: the post-delete re-create gets it too', async () => {
    // The arm that matters most: here the new resource is ALREADY deleted and
    // the state entry already dropped, so a failing re-create leaves the
    // resource absent from both AWS and state.
    const bags: Record<string, unknown>[] = [];
    let seen = 0;
    const create = vi.fn(async (_id: string, _type: string, props: Record<string, unknown>) => {
      bags.push(props);
      if (seen++ === 0) throw awsSdkError(COLLISION_MESSAGE);
      return { physicalId: 'old-q', attributes: {} };
    });
    const del = vi.fn().mockResolvedValue(undefined);
    const { ctx } = makeCtx({ create, delete: del });
    const state: Record<string, ResourceState> = { Q: res({ physicalId: 'new-q' }) };

    const result = await withStackName(STACK, () =>
      replayRollback([reverseReplacementOp()], state, STACK, ctx)
    );

    expect(result.failures).toBe(0);
    expect(create).toHaveBeenCalledTimes(2);
    // BOTH creates carry it — the collision arm re-enters through the same
    // helper, so a fix applied to only one site reds exactly this line.
    expect(bags).toEqual([{ QueueName: `${STACK}-Q` }, { QueueName: `${STACK}-Q` }]);
    expect(state['Q']?.physicalId).toBe('old-q');
  });
});

describe('the fill must NOT fire (#3199)', () => {
  it('an SDK-routed replay is left alone — its provider mints the name itself', async () => {
    // The recorded hint says `cc-api` while the REGISTRY routes to SDK — the
    // `sdkMigration` direction (`provider-registry.ts`'s sticky rule has an
    // `sdk-coverage` exemption that returns an SDK provider for a `cc-api`
    // record). Without the disagreeing hint this case passes for the wrong
    // reason: both readings would say "not cc-api", so swapping the gate to
    // `prev.provisionedBy` leaves it green and only the two positive cases
    // catch the swap. With it, this case is the one that pins WHICH of the two
    // the gate reads on the SDK side.
    const { create, bags } = capturingCreate();
    const del = vi.fn().mockResolvedValue(undefined);
    const { ctx } = makeCtx({ create, delete: del }, 'sdk');
    const op = reverseReplacementOp();
    op.previousState!.provisionedBy = 'cc-api';
    const state: Record<string, ResourceState> = { Q: res({ physicalId: 'new-q' }) };

    const result = await withStackName(STACK, () => replayRollback([op], state, STACK, ctx));

    expect(result.failures).toBe(0);
    expect(bags[0]).toEqual({});
  });

  it('a type with no FALLBACK_NAME_RULES entry gets nothing, even on Cloud Control', async () => {
    const { create, bags } = capturingCreate();
    const del = vi.fn().mockResolvedValue(undefined);
    const { ctx } = makeCtx({ create, delete: del });
    const state: Record<string, ResourceState> = {
      Q: res({ physicalId: 'new-q', resourceType: UNRULED_TYPE }),
    };

    const result = await withStackName(STACK, () =>
      replayRollback([reverseReplacementOp(UNRULED_TYPE)], state, STACK, ctx)
    );

    expect(result.failures).toBe(0);
    expect(bags[0]).toEqual({});
  });

  it('a recorded bag that already names the resource keeps ITS name', async () => {
    // The reverse edit of the reachable shape: removing an explicit name from
    // the template. `prev.properties` still holds it, and overwriting it would
    // re-create the resource under a name the user never chose.
    const { create, bags } = capturingCreate();
    const del = vi.fn().mockResolvedValue(undefined);
    const { ctx } = makeCtx({ create, delete: del });
    const state: Record<string, ResourceState> = { Q: res({ physicalId: 'new-q' }) };

    const result = await withStackName(STACK, () =>
      replayRollback(
        [reverseReplacementOp(NAMED_TYPE, { QueueName: 'user-chosen' })],
        state,
        STACK,
        ctx
      )
    );

    expect(result.failures).toBe(0);
    expect(bags[0]).toEqual({ QueueName: 'user-chosen' });
  });
});

describe('the properties that make the fill CORRECT, not merely present (#3199)', () => {
  it('the replayed name is byte-identical to what the forward create would mint', async () => {
    // Not a restatement of the first case's literal. Both rollback entry points
    // bind `withStackName` (`cli/commands/rollback.ts` for the standalone
    // command, `deploy-engine.ts` around `doDeploy` for the in-process one), so
    // the replay resolves the SAME AsyncLocalStorage-scoped stack name the
    // forward create did. Were that scope absent, the fill would mint an
    // UNPREFIXED name and re-create the resource under a name that never
    // existed — this compares against the real generator rather than a literal
    // so a change to the naming pipeline moves both sides together.
    const { create, bags } = capturingCreate();
    const del = vi.fn().mockResolvedValue(undefined);
    const { ctx } = makeCtx({ create, delete: del });
    const state: Record<string, ResourceState> = { Q: res({ physicalId: 'new-q' }) };

    const forward = withStackName(STACK, () => applyDefaultNameForFallback('Q', NAMED_TYPE, {}));

    await withStackName(STACK, () => replayRollback([reverseReplacementOp()], state, STACK, ctx));

    expect(bags[0]).toEqual(forward);
    // And the prefix is genuinely present, so a regression that dropped the
    // `withStackName` scope on BOTH sides cannot satisfy the equality above.
    expect(bags[0]?.['QueueName']).toBe(`${STACK}-Q`);
  });

  it('the re-create is routed by the OLD record, not by the new resource', async () => {
    // The stub answers every lookup identically, so the two cases above cannot
    // tell which lookup fed the gate. The reverse-replacement arm makes TWO
    // routing calls on DIFFERENT inputs — the re-create on `prev.provisionedBy`
    // and the new resource's delete on the CURRENT record's — and the fill must
    // key on the first. Pin the argument so an edit that swapped them is not
    // invisible.
    const { create } = capturingCreate();
    const del = vi.fn().mockResolvedValue(undefined);
    const { ctx, routingInputs } = makeCtx({ create, delete: del });
    const op = reverseReplacementOp();
    op.previousState!.provisionedBy = 'cc-api';
    const state: Record<string, ResourceState> = {
      Q: res({ physicalId: 'new-q', provisionedBy: 'sdk' }),
    };

    const result = await withStackName(STACK, () => replayRollback([op], state, STACK, ctx));

    expect(result.failures).toBe(0);
    expect(routingInputs[0]).toEqual({
      resourceType: NAMED_TYPE,
      provisionedBy: 'cc-api',
    });
  });

  it('the generated name does NOT leak into the rebuilt state record', async () => {
    // The invariant the whole update path rests on: the recorded bag holds the
    // template's resolved properties and never a generated name.
    //
    // What this pins is the record rebuild's INDEPENDENCE from the bag handed
    // to `create()` — the rebuild reads `prevRecord.properties` (or the
    // provider's `effectiveProperties`, issue #1682), never
    // `resolvedPrevProps`. Rewiring it to record what cdkd actually created
    // with is the realistic future mistake, and it reds exactly this case
    // (measured).
    //
    // Stated because the obvious reading is wrong: this case does NOT fence
    // filling `resolvedPrevProps` itself. Measured — that mutation leaves this
    // assertion green, precisely because the rebuild never reads that variable;
    // what catches it is the SDK-route case above, which the unconditional fill
    // also breaks.
    const { create } = capturingCreate();
    const del = vi.fn().mockResolvedValue(undefined);
    const { ctx } = makeCtx({ create, delete: del });
    const state: Record<string, ResourceState> = { Q: res({ physicalId: 'new-q' }) };

    const result = await withStackName(STACK, () =>
      replayRollback([reverseReplacementOp()], state, STACK, ctx)
    );

    // SCOPE, stated because the assertion below cannot see it: this holds
    // because the stub create reports no `effectiveProperties`. The rebuild
    // honours one when present (#1682), so a CC-routed provider that echoed the
    // bag back WOULD put the generated name into the record. No such provider
    // exists — every `cc-api` route returns `CloudControlProvider`, which never
    // reports one — so the guarantee rests on that routing fact, not on this
    // case.
    expect(result.failures).toBe(0);
    expect(state['Q']?.properties).toEqual({});
    expect(state['Q']?.properties).not.toHaveProperty('QueueName');
  });
});
