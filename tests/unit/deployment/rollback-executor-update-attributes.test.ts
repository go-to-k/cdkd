/**
 * The rollback executor records the attributes a replayed `update()` returned
 * (go-to-k/cdkd#4434).
 *
 * Both UPDATE arms — `revert` (`replayRollback`) and `--revert-failed`'s
 * `revert-failed-update` (`replayFailedOperations`) — rebuilt the record with
 * `recordAfterRollbackUpdate(prev, result)`, which kept `prev.attributes` and
 * dropped the result's. An `update()` that re-creates under the same physical
 * id returns new ones: `AWS::EC2::SecurityGroupIngress` revokes and
 * re-authorizes, so AWS mints a new `sgr-` rule id, and the rollback left the
 * REVOKED one in state for `cdkd export` and a later `Fn::GetAtt <rule>.Id`.
 *
 * Pinned per arm: the returned id lands; a provider returning no attributes
 * keeps the restored record's; an in-place update merges key-wise; a
 * `wasReplaced` one replaces the set wholesale (a key only the removed rule
 * had must not survive).
 *
 * The SECURITY half: once the record takes returned attributes, a provider's
 * `NoEcho` declaration (a custom resource's response, a nested stack's masked
 * outputs) must reach the redaction as needles, as the deploy engine
 * registers them — on both UPDATE arms and on the reverse-replacement
 * replay-CREATE arm, which already recorded its create's attributes and had
 * the same gap.
 */

import { describe, it, expect, vi } from 'vite-plus/test';
import {
  replayRollback,
  replayFailedOperations,
  type CompletedOperation,
  type FailedOperation,
  type RollbackExecutorContext,
} from '../../../src/deployment/rollback-executor.js';
import { recordAfterRollbackUpdate } from '../../../src/deployment/rollback-executor/replay-retry.js';
import {
  SECRET_MASK,
  recordNoEchoAttributeValues,
  type RecordedSecretValues,
} from '../../../src/deployment/secret-redaction.js';
import type { ResourceState } from '../../../src/types/state.js';
import type { ResourceCreateResult, ResourceUpdateResult } from '../../../src/types/resource.js';

vi.mock('../../../src/deployment/retry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/deployment/retry.js')>();
  return { ...actual, withRetry: vi.fn((fn: () => Promise<unknown>) => fn()) };
});

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({}),
  setAwsClients: vi.fn(),
  AwsClients: vi.fn(),
}));

const INGRESS = 'AWS::EC2::SecurityGroupIngress';
const CUSTOM = 'Custom::Secretive';
const SERVICE_TOKEN = 'arn:aws:lambda:us-east-1:123456789012:function:handler';
const HANDLER_SECRET = 'handler-generated-secret-value';

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
    resourceType: INGRESS,
    properties: {},
    attributes: {},
    dependencies: [],
    ...overrides,
  };
}

function makeCtx(provider: { update?: unknown; create?: unknown; delete?: unknown }) {
  const ctx: RollbackExecutorContext = {
    region: 'us-east-1',
    logger: silentLogger,
    providerRegistry: {
      getProviderFor: () => ({ provider, provisionedBy: 'sdk' }),
    } as unknown as RollbackExecutorContext['providerRegistry'],
  };
  return ctx;
}

type Arm = 'revert' | 'revert-failed';

/**
 * Run one UPDATE arm over a resource whose previous properties DIFFER from the
 * live ones (else the arm short-circuits and never calls `update()`), and
 * return the record it wrote.
 */
async function runArm(
  arm: Arm,
  result: ResourceUpdateResult,
  {
    type = INGRESS,
    prevAttributes = { Id: 'sgr-revoked' },
    prevProperties = { Description: 'old' },
    liveProperties = { Description: 'new' },
  }: {
    type?: string;
    prevAttributes?: Record<string, unknown>;
    prevProperties?: Record<string, unknown>;
    liveProperties?: Record<string, unknown>;
  } = {}
): Promise<{ record: ResourceState | undefined; update: ReturnType<typeof vi.fn> }> {
  const update = vi.fn().mockResolvedValue(result);
  const ctx = makeCtx({ update });
  const op = {
    logicalId: 'R',
    changeType: 'UPDATE',
    resourceType: type,
    physicalId: 'phys',
    previousState: res({
      resourceType: type,
      properties: prevProperties,
      attributes: prevAttributes,
    }),
  };
  const state: Record<string, ResourceState> = {
    R: res({ resourceType: type, properties: liveProperties, attributes: { Id: 'sgr-forward' } }),
  };
  const outcome =
    arm === 'revert'
      ? await replayRollback([op as unknown as CompletedOperation], state, 'S', ctx)
      : await replayFailedOperations([op as unknown as FailedOperation], state, 'S', ctx);
  expect(outcome.failures).toBe(0);
  return { record: state['R'], update };
}

describe.each<Arm>(['revert', 'revert-failed'])(
  'rollback %s arm records the attributes update() returned (#4434)',
  (arm) => {
    it('a re-created rule: the NEW sgr- id is recorded, not the revoked one', async () => {
      const { record, update } = await runArm(arm, {
        physicalId: 'phys',
        wasReplaced: true,
        attributes: { Id: 'sgr-fresh' },
      });
      expect(update).toHaveBeenCalledOnce();
      // THE DISCRIMINATOR: before the fix this was `sgr-revoked`.
      expect(record?.attributes).toEqual({ Id: 'sgr-fresh' });
    });

    it('wasReplaced: the returned set REPLACES the restored one (no key survives from the removed resource)', async () => {
      const { record } = await runArm(
        arm,
        { physicalId: 'phys', wasReplaced: true, attributes: {} },
        { prevAttributes: { Id: 'sgr-revoked', Extra: 'old-only' } }
      );
      expect(record?.attributes).toEqual({});
    });

    it('in place: merged key-wise, the returned value winning', async () => {
      const { record } = await runArm(
        arm,
        { physicalId: 'phys', wasReplaced: false, attributes: { Id: 'sgr-fresh' } },
        { prevAttributes: { Id: 'sgr-revoked', Kept: 'still-valid' } }
      );
      expect(record?.attributes).toEqual({ Id: 'sgr-fresh', Kept: 'still-valid' });
    });

    it('no attributes returned: the restored record keeps its own', async () => {
      const { record } = await runArm(
        arm,
        { physicalId: 'phys', wasReplaced: false },
        { prevAttributes: { Id: 'sgr-kept', Other: 'x' } }
      );
      expect(record?.attributes).toEqual({ Id: 'sgr-kept', Other: 'x' });
    });

    it('update() resolving undefined: no crash, the restored record is kept', async () => {
      const { record, update } = await runArm(
        arm,
        undefined as unknown as ResourceUpdateResult,
        { prevAttributes: { Id: 'sgr-kept' } }
      );
      expect(update).toHaveBeenCalledOnce();
      expect(record?.attributes).toEqual({ Id: 'sgr-kept' });
      expect(record?.properties).toEqual({ Description: 'old' });
      expect(record?.physicalId).toBe('phys');
    });

    it('wasReplaced under a NEW physical id: the record takes that id', async () => {
      const { record } = await runArm(arm, {
        physicalId: 'phys-replaced',
        wasReplaced: true,
        attributes: { Id: 'sgr-fresh' },
      });
      expect(record?.physicalId).toBe('phys-replaced');
      expect(record?.attributes).toEqual({ Id: 'sgr-fresh' });
    });

    it('NoEcho: a custom resource answering NoEcho persists the mask, not its Data', async () => {
      const { record } = await runArm(
        arm,
        {
          physicalId: 'phys',
          wasReplaced: false,
          // The handler echoes its own ServiceToken into Data too, the shape the
          // CDK Provider samples encourage: that leaf is the resource's own
          // input and must NOT be masked back at it (go-to-k/cdkd#3938).
          attributes: { Password: HANDLER_SECRET, Token: SERVICE_TOKEN },
          noEchoAttributes: true,
        },
        {
          type: CUSTOM,
          prevAttributes: { Password: SECRET_MASK },
          prevProperties: { ServiceToken: SERVICE_TOKEN, Length: '32' },
          // A DIFFERENT live token, so an exclusion built from the wrong bag
          // (the live side, not the restored one the update sends) is visible.
          liveProperties: { ServiceToken: `${SERVICE_TOKEN}-forward`, Length: '16' },
        }
      );
      expect(JSON.stringify(record)).not.toContain(HANDLER_SECRET);
      expect(record?.attributes).toEqual({ Password: SECRET_MASK, Token: SERVICE_TOKEN });
      expect(record?.properties['ServiceToken']).toBe(SERVICE_TOKEN);
    });

    it('NoEcho per attribute name: only the declared output is masked', async () => {
      const { record } = await runArm(
        arm,
        {
          physicalId: 'phys',
          wasReplaced: false,
          attributes: { 'Outputs.Secret': HANDLER_SECRET, 'Outputs.Plain': 'plain-output-value' },
          noEchoAttributeNames: ['Outputs.Secret'],
        },
        { type: 'AWS::CloudFormation::Stack', prevAttributes: {} }
      );
      expect(record?.attributes).toEqual({
        'Outputs.Secret': SECRET_MASK,
        'Outputs.Plain': 'plain-output-value',
      });
    });

    it('control: the same result WITHOUT a NoEcho declaration is recorded as returned', async () => {
      const { record } = await runArm(
        arm,
        { physicalId: 'phys', wasReplaced: false, attributes: { Password: HANDLER_SECRET } },
        { type: CUSTOM, prevAttributes: {} }
      );
      expect(record?.attributes).toEqual({ Password: HANDLER_SECRET });
    });
  }
);

describe('reverse-replacement replay-CREATE registers the create result NoEcho (#4434)', () => {
  function reverseReplacementOp(): CompletedOperation {
    return {
      logicalId: 'R',
      changeType: 'UPDATE',
      resourceType: CUSTOM,
      physicalId: 'new-phys',
      previousState: res({
        physicalId: 'old-phys',
        resourceType: CUSTOM,
        properties: { ServiceToken: SERVICE_TOKEN },
      }),
    };
  }

  async function run(createResult: ResourceCreateResult): Promise<ResourceState | undefined> {
    const create = vi.fn().mockResolvedValue(createResult);
    const del = vi.fn().mockResolvedValue(undefined);
    const ctx = makeCtx({ create, delete: del });
    const state: Record<string, ResourceState> = {
      R: res({ physicalId: 'new-phys', resourceType: CUSTOM }),
    };
    const outcome = await replayRollback([reverseReplacementOp()], state, 'S', ctx);
    expect(outcome.failures).toBe(0);
    expect(create).toHaveBeenCalledOnce();
    return state['R'];
  }

  it('a NoEcho create persists the mask', async () => {
    const record = await run({
      physicalId: 'old-phys-recreated',
      // The ServiceToken echo pins the own-property exclusion on THIS arm too.
      attributes: { Password: HANDLER_SECRET, Token: SERVICE_TOKEN },
      noEchoAttributes: true,
    });
    expect(record?.physicalId).toBe('old-phys-recreated');
    expect(JSON.stringify(record)).not.toContain(HANDLER_SECRET);
    expect(record?.attributes).toEqual({ Password: SECRET_MASK, Token: SERVICE_TOKEN });
    expect(record?.properties['ServiceToken']).toBe(SERVICE_TOKEN);
  });

  it('control: without the declaration the attributes are recorded as returned', async () => {
    const record = await run({
      physicalId: 'old-phys-recreated',
      attributes: { Password: HANDLER_SECRET },
    });
    expect(record?.attributes).toEqual({ Password: HANDLER_SECRET });
  });
});

describe('recordNoEchoAttributeValues', () => {
  it('a declared name the bag only INHERITS (a prototype key) registers nothing', () => {
    const secrets: RecordedSecretValues = new Map();
    expect(
      recordNoEchoAttributeValues({ attributes: {}, noEchoAttributeNames: ['toString'] }, secrets)
    ).toBeUndefined();
    expect(secrets.size).toBe(0);
  });

  it('a declared name the bag owns registers its value and is returned', () => {
    const secrets: RecordedSecretValues = new Map();
    const declared = recordNoEchoAttributeValues(
      { attributes: { Secret: HANDLER_SECRET }, noEchoAttributeNames: ['Secret', 'Absent'] },
      secrets
    );
    expect(declared).toEqual(new Set(['Secret']));
    expect(secrets.get(HANDLER_SECRET)).toBe(SECRET_MASK);
  });
});

describe('recordAfterRollbackUpdate', () => {
  const restored = res({ attributes: { Id: 'sgr-old' }, properties: { A: 1 } });

  it('returns the restored record BY IDENTITY when the provider reported nothing', () => {
    expect(recordAfterRollbackUpdate(restored, undefined)).toBe(restored);
    expect(recordAfterRollbackUpdate(restored, { physicalId: 'phys', wasReplaced: false })).toBe(
      restored
    );
  });

  it('copies the returned attributes rather than aliasing the provider object', () => {
    const returned = { Id: 'sgr-new' };
    const record = recordAfterRollbackUpdate(restored, {
      physicalId: 'phys',
      wasReplaced: true,
      attributes: returned,
    });
    expect(record.attributes).toEqual({ Id: 'sgr-new' });
    expect(record.attributes).not.toBe(returned);
    // The restored record is not mutated.
    expect(restored.attributes).toEqual({ Id: 'sgr-old' });
  });

  it('a restored record with NO attributes still takes the in-place set', () => {
    const { attributes: _none, ...bare } = restored;
    const record = recordAfterRollbackUpdate(bare as ResourceState, {
      physicalId: 'phys',
      wasReplaced: false,
      attributes: { Id: 'sgr-new' },
    });
    expect(record.attributes).toEqual({ Id: 'sgr-new' });
  });

  it('in place: merges into a COPY, never into the restored record', () => {
    const own = res({ attributes: { Id: 'sgr-old', Kept: 'k' } });
    const record = recordAfterRollbackUpdate(own, {
      physicalId: 'phys',
      wasReplaced: false,
      attributes: { Id: 'sgr-new' },
    });
    expect(record.attributes).toEqual({ Id: 'sgr-new', Kept: 'k' });
    expect(record.attributes).not.toBe(own.attributes);
    expect(own.attributes).toEqual({ Id: 'sgr-old', Kept: 'k' });
  });

  it('wasReplaced under the SAME id with effectiveProperties but NO attributes: the restored attributes stand', () => {
    const record = recordAfterRollbackUpdate(restored, {
      physicalId: 'phys',
      wasReplaced: true,
      effectiveProperties: { A: 2 },
    });
    expect(record.properties).toEqual({ A: 2 });
    expect(record.attributes).toEqual({ Id: 'sgr-old' });
  });

  it('wasReplaced under a NEW id with NO attributes: the removed resource attributes are dropped', () => {
    const record = recordAfterRollbackUpdate(restored, {
      physicalId: 'phys-new',
      wasReplaced: true,
    });
    expect(record.physicalId).toBe('phys-new');
    expect(record).not.toHaveProperty('attributes');
    // The restored record itself is untouched.
    expect(restored.attributes).toEqual({ Id: 'sgr-old' });
  });

  it('physical id: a wasReplaced answer takes a non-empty returned id, anything else keeps the restored one', () => {
    expect(
      recordAfterRollbackUpdate(restored, { physicalId: 'phys-new', wasReplaced: true }).physicalId
    ).toBe('phys-new');
    // An in-place answer naming another id is not evidence of a replacement.
    expect(
      recordAfterRollbackUpdate(restored, {
        physicalId: 'phys-new',
        wasReplaced: false,
        attributes: {},
      }).physicalId
    ).toBe('phys');
    // An empty id is no id.
    expect(
      recordAfterRollbackUpdate(restored, { physicalId: '', wasReplaced: true }).physicalId
    ).toBe('phys');
  });
});
