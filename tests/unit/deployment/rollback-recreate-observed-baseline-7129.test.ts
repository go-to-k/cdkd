/**
 * go-to-k/cdkd#7129: a resource the rollback RE-CREATES (a reversed
 * replacement, and the failed-op re-create of a delete-first link) gets a
 * fresh drift baseline read back from AWS, as a deploy's CREATE captures one.
 * Without it the re-created record had no `observedProperties`, so drift fell
 * back to the template's spelling (`TTL: "300"`) against AWS's (`300`).
 *
 * Drives the REAL `replayRollback` / `replayFailedOperations` with a stub
 * provider.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

vi.mock('../../../src/deployment/retry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/deployment/retry.js')>();
  return { ...actual, withRetry: vi.fn((fn: () => Promise<unknown>) => fn()) };
});

const SECRET = 'hunter2-plaintext-7129';
const SECRET_EXPR = '{{resolve:secretsmanager:s7129:SecretString}}';
const smSend = vi.fn(async () => ({ SecretString: SECRET }));
vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({ secretsManager: { send: smSend } }),
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
import { RESOURCE_NOT_FOUND } from '../../../src/types/resource.js';
import type { ResourceState } from '../../../src/types/state.js';

const RECORD = 'AWS::Route53::RecordSet';
/** v1 as CDK synthesizes it: `TTL` is a string. */
const V1 = {
  HostedZoneId: 'Z1',
  Name: 'www.example.internal.',
  Type: 'CNAME',
  TTL: '300',
  ResourceRecords: ['example.com'],
};
/** What the readback of the re-created record answers. */
const LIVE = { ...V1, TTL: 300 };

const debugs: string[] = [];
const logger = {
  debug: vi.fn((m: string) => debugs.push(m)),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  setLevel: vi.fn(),
  child: () => logger,
} as unknown as RollbackExecutorContext['logger'];

function rec(
  physicalId: string,
  properties: Record<string, unknown>,
  extra: Partial<ResourceState> = {}
): ResourceState {
  return {
    physicalId,
    resourceType: RECORD,
    properties,
    attributes: {},
    dependencies: [],
    provisionedBy: 'sdk',
    ...extra,
  };
}

interface Stub {
  create: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  readCurrentState?: ReturnType<typeof vi.fn>;
}

function stub(readCurrentState: Stub['readCurrentState'], createExtra = {}): Stub {
  return {
    create: vi.fn(async () => ({ physicalId: 'Z1|www-recreated', attributes: {}, ...createExtra })),
    delete: vi.fn(async () => undefined),
    ...(readCurrentState !== undefined && { readCurrentState }),
  };
}

function ctxWith(s: Stub, extra: Partial<RollbackExecutorContext> = {}): RollbackExecutorContext {
  return {
    ...extra,
    region: 'us-east-1',
    logger,
    providerRegistry: {
      getProviderFor: () => ({ provider: s, provisionedBy: 'sdk' }),
    } as unknown as RollbackExecutorContext['providerRegistry'],
    recordEvent: () => {},
  };
}

/** The deploy renamed `www` -> `www2`; the old record carried a baseline. */
function completed(oldDeletedBeforeCreate: boolean, prev: ResourceState): CompletedOperation {
  return {
    logicalId: 'Cname',
    changeType: 'UPDATE',
    resourceType: RECORD,
    provisionedBy: 'sdk',
    physicalId: 'Z1|www2',
    previousState: prev,
    oldResourceRetained: false,
    oldDeletedBeforeCreate,
  };
}

/** Run the completed-op reverse replacement, returning the restored record. */
async function reverse(
  oldDeletedBeforeCreate: boolean,
  s: Stub,
  prevExtra: Partial<ResourceState> = {},
  ctxExtra: Partial<RollbackExecutorContext> = {},
  prevProps: Record<string, unknown> = V1
): Promise<ResourceState | undefined> {
  const prev = rec('Z1|www', prevProps, { observedProperties: { ...LIVE, TTL: 299 }, ...prevExtra });
  const state: Record<string, ResourceState> = {
    Cname: rec('Z1|www2', { ...V1, Name: 'www2.example.internal.', TTL: '60' }, {
      observedProperties: { ...LIVE, Name: 'www2.example.internal.', TTL: 60 },
    }),
  };
  const result = await replayRollback(
    [completed(oldDeletedBeforeCreate, prev)],
    state,
    'S',
    ctxWith(s, ctxExtra)
  );
  expect(result.failures).toBe(0);
  expect(s.create).toHaveBeenCalledTimes(1);
  return state['Cname'];
}

beforeEach(() => {
  vi.clearAllMocks();
  debugs.length = 0;
});

describe.each([true, false])(
  'a reversed replacement (oldDeletedBeforeCreate=%s) records the re-created baseline (go-to-k/cdkd#7129)',
  (deletedFirst) => {
    it('reads the re-created resource back and records it as its baseline', async () => {
      const readCurrentState = vi.fn().mockResolvedValue(LIVE);
      const record = await reverse(deletedFirst, stub(readCurrentState));
      expect(record?.physicalId).toBe('Z1|www-recreated');
      expect(record?.properties).toEqual(V1);
      expect(record?.observedProperties).toEqual(LIVE);
      expect(readCurrentState).toHaveBeenCalledTimes(1);
      const [physicalId, logicalId, type, desired, context] = readCurrentState.mock.calls[0]!;
      expect([physicalId, logicalId, type]).toEqual(['Z1|www-recreated', 'Cname', RECORD]);
      expect(desired).toEqual(V1);
      expect(context).toMatchObject({ afterOwnWrite: true });
    });

    it('persists a resolved secret the readback echoes as its reference, never the plaintext', async () => {
      const withSecret = { ...V1, Comment: SECRET_EXPR };
      const readCurrentState = vi.fn().mockResolvedValue({ ...LIVE, Comment: SECRET });
      const s = stub(readCurrentState);
      const record = await reverse(deletedFirst, s, {}, {}, withSecret);
      // The re-create really sent the plaintext, so the readback is a real echo.
      expect((s.create.mock.calls[0] as unknown[])[2]).toMatchObject({ Comment: SECRET });
      expect(record?.observedProperties).toEqual({ ...LIVE, Comment: SECRET_EXPR });
      expect(JSON.stringify(record)).not.toContain(SECRET);
    });

    it('a failed readback keeps no baseline, never the deleted copy one, and the rollback succeeds', async () => {
      const readCurrentState = vi.fn().mockRejectedValue(new Error('Throttling: slow down'));
      const record = await reverse(deletedFirst, stub(readCurrentState));
      expect(record?.physicalId).toBe('Z1|www-recreated');
      expect(record?.observedProperties).toBeUndefined();
      expect(debugs.join('\n')).toContain('the re-created record has no drift baseline');
    });

    it('a readback reporting the resource gone records no baseline', async () => {
      const readCurrentState = vi.fn().mockResolvedValue(RESOURCE_NOT_FOUND);
      const record = await reverse(deletedFirst, stub(readCurrentState));
      expect(record?.observedProperties).toBeUndefined();
    });

    it('--no-capture-observed-state takes no readback', async () => {
      const readCurrentState = vi.fn().mockResolvedValue(LIVE);
      const record = await reverse(deletedFirst, stub(readCurrentState), {}, {
        captureObservedState: false,
      });
      expect(readCurrentState).not.toHaveBeenCalled();
      expect(record?.observedProperties).toBeUndefined();
    });

    it('a refused import baseline stays refused', async () => {
      const readCurrentState = vi.fn().mockResolvedValue(LIVE);
      const record = await reverse(deletedFirst, stub(readCurrentState), {
        observedProperties: undefined,
        observedBaselineRefused: true,
      });
      expect(readCurrentState).not.toHaveBeenCalled();
      expect(record?.observedProperties).toBeUndefined();
    });

    it('a create declaring NoEcho attributes takes no readback', async () => {
      const readCurrentState = vi.fn().mockResolvedValue(LIVE);
      const record = await reverse(
        deletedFirst,
        stub(readCurrentState, { attributes: { Secret: 'x' }, noEchoAttributes: true })
      );
      expect(readCurrentState).not.toHaveBeenCalled();
      expect(record?.observedProperties).toBeUndefined();
    });
  }
);

describe('a re-create that returned the LIVE new resource (go-to-k/cdkd#7129, #6731)', () => {
  it('takes no readback: a baseline read from it would hide what the rollback did not re-apply', async () => {
    const readCurrentState = vi.fn().mockResolvedValue(LIVE);
    const s = stub(readCurrentState, { physicalId: 'Z1|www2' });
    const record = await reverse(false, s);
    expect(record?.physicalId).toBe('Z1|www2');
    expect(readCurrentState).not.toHaveBeenCalled();
    // The live record's own baseline is kept (#6731), never a new readback.
    expect(record?.observedProperties).toEqual({ ...LIVE, Name: 'www2.example.internal.', TTL: 60 });
  });
});

describe('the failed-op re-create of a delete-first link records its baseline (go-to-k/cdkd#7129)', () => {
  const LINK = 'AWS::EC2::SubnetRouteTableAssociation';
  const LINK_PROPS = { SubnetId: 'subnet-1', RouteTableId: 'rtb-1' };

  async function recreate(
    s: Stub,
    ctxExtra: Partial<RollbackExecutorContext> = {},
    prevExtra: Partial<ResourceState> = {}
  ) {
    const prev: ResourceState = {
      physicalId: 'rtbassoc-old',
      resourceType: LINK,
      properties: LINK_PROPS,
      attributes: {},
      dependencies: [],
      observedProperties: { ...LINK_PROPS, Stale: true },
      ...prevExtra,
    };
    const op: FailedOperation = {
      logicalId: 'Link',
      changeType: 'UPDATE',
      resourceType: LINK,
      physicalId: 'rtbassoc-old',
      previousState: prev,
      attemptedProperties: { ...LINK_PROPS, RouteTableId: 'rtb-2' },
      oldDeletedBeforeCreate: true,
    };
    const state: Record<string, ResourceState> = { Link: { ...prev } };
    const result = await replayFailedOperations([op], state, 'S', ctxWith(s, ctxExtra));
    expect(result.failures).toBe(0);
    expect(s.create).toHaveBeenCalledTimes(1);
    return state['Link'];
  }

  it('reads the re-created link back and records it as its baseline', async () => {
    const readCurrentState = vi.fn().mockResolvedValue(LINK_PROPS);
    const record = await recreate(stub(readCurrentState));
    expect(record?.physicalId).toBe('Z1|www-recreated');
    expect(record?.observedProperties).toEqual(LINK_PROPS);
    expect(readCurrentState).toHaveBeenCalledTimes(1);
    expect(readCurrentState.mock.calls[0]![0]).toBe('Z1|www-recreated');
    expect(readCurrentState.mock.calls[0]![4]).toMatchObject({ afterOwnWrite: true });
  });

  it('a failed readback keeps no baseline, never the deleted copy one', async () => {
    const readCurrentState = vi.fn().mockRejectedValue(new Error('Throttling'));
    const record = await recreate(stub(readCurrentState));
    expect(record?.observedProperties).toBeUndefined();
  });

  it('--no-capture-observed-state takes no readback', async () => {
    const readCurrentState = vi.fn().mockResolvedValue(LINK_PROPS);
    const record = await recreate(stub(readCurrentState), { captureObservedState: false });
    expect(readCurrentState).not.toHaveBeenCalled();
    expect(record?.observedProperties).toBeUndefined();
  });

  it('a refused import baseline stays refused', async () => {
    const readCurrentState = vi.fn().mockResolvedValue(LINK_PROPS);
    const record = await recreate(stub(readCurrentState), {}, {
      observedProperties: undefined,
      observedBaselineRefused: true,
    });
    expect(readCurrentState).not.toHaveBeenCalled();
    expect(record?.observedProperties).toBeUndefined();
  });

  it('a create declaring NoEcho attributes takes no readback', async () => {
    const readCurrentState = vi.fn().mockResolvedValue(LINK_PROPS);
    const record = await recreate(
      stub(readCurrentState, { attributes: { Secret: 'x' }, noEchoAttributes: true })
    );
    expect(readCurrentState).not.toHaveBeenCalled();
    expect(record?.observedProperties).toBeUndefined();
  });
});
