/**
 * go-to-k/cdkd#7050 (security review of PR #7060): a nested row parameter the
 * parent marked `sub-floor` (its value holds a recorded secret's text under
 * the value scan's floor) with NO certified spelling must be read by the child
 * only as `***`. Before the fix `redactInheritedParameterValue` fell back to
 * the value scan, which leaves the sub-floor text in the literal
 * (`xq7:{{BIG}}`), and the re-read "certified" its pieces (`xq7`), so a
 * `{Ref}`, a `Select` over a `Split`, a `Split` and a `Join` over a `Split`
 * all persisted the pin.
 *
 * Three ways a parameter reaches the child with no certified spelling: the
 * parent's template text holds the pin (the recorder refuses that spelling),
 * the spelling was withdrawn (`rendered.set(name, null)`), and a STATE-derived
 * recorder (the rollback replays), which never derives one.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import {
  inheritNestedStackParameterAssociations,
  recordNestedStackParameterExpressions,
  type RecordedSecretValues,
} from '../../../src/deployment/secret-redaction.js';
import { redactSecretsForState } from '../../../src/deployment/secret-redaction/redact-state.js';
import { TEMPLATE_DERIVED_RULES } from '../../../src/deployment/secret-redaction/rules.js';
import { attributionRefusedParameters } from '../../../src/deployment/secret-redaction/nested-stack/parameter-tables.js';
import {
  persistedInheritedParameterValue,
  withdrawRenderedParameterSpelling,
} from '../../../src/deployment/secret-redaction/nested-stack/inherited-parameters.js';
import { redactParametersForDiff } from '../../../src/deployment/deploy-engine/masking.js';

/** The sub-floor secret, and a secret above the floor. */
const PIN = 'q7';
const BIG = 'b1g-s3cret-v4lue-7050';
const PIN_TOKEN = '{{resolve:ssm-secure:/app/pin}}';
const BIG_TOKEN = '{{resolve:ssm-secure:/app/big}}';

vi.mock('../../../src/utils/logger.js', () => {
  const fns = { setLevel: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => fns };
  return { getLogger: () => fns };
});

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sts: { send: vi.fn().mockResolvedValue({ Account: '123456789012' }) },
    ssm: {
      send: vi.fn(async (command: { input?: { Name?: string } }) => {
        const name = command.input?.Name;
        if (name === '/app/pin') return { Parameter: { Value: 'q7', Type: 'SecureString' } };
        if (name === '/app/big') return { Parameter: { Value: 'b1g-s3cret-v4lue-7050', Type: 'SecureString' } };
        const notFound = new Error(`ParameterNotFound: ${String(name)}`);
        notFound.name = 'ParameterNotFound';
        throw notFound;
      }),
    },
  }),
}));
vi.mock('@aws-sdk/client-cloudformation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-cloudformation')>();
  return { ...actual, CloudFormationClient: vi.fn(() => ({ send: () => Promise.reject(new Error('DescribeType unavailable')) })) };
});
vi.mock('../../../src/deployment/retry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/deployment/retry.js')>();
  return { ...actual, withRetry: vi.fn((fn: () => Promise<unknown>) => fn()) };
});
vi.mock('p-limit', () => ({ default: vi.fn(() => <T>(fn: () => T) => fn()) }));
vi.mock('@aws-sdk/client-kms', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  const { createHmac } = await import('node:crypto');
  class FakeKMSClient {
    async send(command: { input: { Message: Uint8Array } }): Promise<unknown> {
      return {
        KeyId: 'arn:aws:kms:us-east-1:123456789012:key/11111111-2222-3333-4444-555555555555',
        Mac: new Uint8Array(createHmac('sha256', 'local-hmac-key-7050').update(command.input.Message).digest()),
      };
    }
    destroy(): void {}
  }
  return { ...actual, KMSClient: FakeKMSClient };
});

const { IntrinsicFunctionResolver, resetAccountInfoCache } = await import(
  '../../../src/deployment/intrinsic-function-resolver.js'
);
const { DeployEngine } = await import('../../../src/deployment/deploy-engine.js');
const { DiffCalculator } = await import('../../../src/analyzer/diff-calculator.js');
const { replayRollback } = await import('../../../src/deployment/rollback-executor.js');
const { getCurrentResourceSecrets } = await import('../../../src/deployment/resource-secrets-scope.js');

beforeEach(() => resetAccountInfoCache());

const NESTED = 'AWS::CloudFormation::Stack';
const TEMPLATE_URL = 'https://s3.amazonaws.com/bucket/child.json';
/** The parent's spelling of `X`: its TEXT holds the pin, beside the big secret. */
const ROW_SOURCE = { 'Fn::Join': [':', [`x${PIN}`, BIG_TOKEN]] };
const VALUE = `x${PIN}:${BIG}`;

function contextFor(values: Record<string, unknown>, bag: RecordedSecretValues, inheritedSecrets?: RecordedSecretValues) {
  return {
    template: {
      Parameters: Object.fromEntries(Object.keys(values).map((k) => [k, { Type: 'String' }])),
      Resources: {},
    } as CloudFormationTemplate,
    resources: {},
    parameters: values,
    conditions: {},
    recordedSecretValues: bag,
    ...(inheritedSecrets ? { inheritedSecrets } : {}),
  };
}

type Route = 'template text' | 'withdrawn spelling' | 'state-derived recorder';

/**
 * The parent row's pass: `X` from {@link ROW_SOURCE} beside `Y`, the pin's own
 * reference, so the pin is a recorded secret of the row's bag.
 */
async function parentRow(route: Route): Promise<RecordedSecretValues> {
  const bag: RecordedSecretValues = new Map();
  const source = { TemplateURL: TEMPLATE_URL, Parameters: { X: ROW_SOURCE, Y: PIN_TOKEN } };
  const resolved = (await new IntrinsicFunctionResolver('us-east-1').resolve(source, contextFor({}, bag) as never)) as {
    Parameters: Record<string, unknown>;
  };
  expect(resolved.Parameters['X']).toBe(VALUE);
  if (route === 'state-derived recorder') {
    // The rollback replays' call: the source is the row's STATE record.
    recordNestedStackParameterExpressions(bag, NESTED, resolved, source, 'state-derived');
  } else {
    recordNestedStackParameterExpressions(bag, NESTED, resolved, source);
    if (route === 'withdrawn spelling') withdrawRenderedParameterSpelling(bag, 'X');
  }
  // Premise: the parent marked `X` `sub-floor`.
  expect(attributionRefusedParameters.get(bag)?.get('X')).toBe('sub-floor');
  return bag;
}

/** No text of the pin outside a `{{resolve:...}}` token. */
function exposed(value: unknown): boolean {
  return JSON.stringify(value).split(/\{\{resolve:[^}]+\}\}/).join('\u0000').includes(PIN);
}

const SHAPES: Record<string, unknown> = {
  Ref: { Ref: 'X' },
  'Select[0] over Split': { 'Fn::Select': [0, { 'Fn::Split': [':', { Ref: 'X' }] }] },
  'Select[1] over Split': { 'Fn::Select': [1, { 'Fn::Split': [':', { Ref: 'X' }] }] },
  Split: { 'Fn::Split': [':', { Ref: 'X' }] },
  'Join over Split': { 'Fn::Join': ['-', { 'Fn::Split': [':', { Ref: 'X' }] }] },
};

/** The child resource reading `node`, persisted twice (the save's re-redaction), and its diff-side value. */
async function childReadOf(parent: RecordedSecretValues, node: unknown) {
  const child: RecordedSecretValues = new Map();
  inheritNestedStackParameterAssociations(child, parent);
  const source = { Value: node };
  const resolved = (await new IntrinsicFunctionResolver('us-east-1').resolve(
    source,
    contextFor({ X: VALUE }, child, parent) as never
  )) as Record<string, unknown>;
  const once = redactSecretsForState(structuredClone(resolved), child, source, TEMPLATE_DERIVED_RULES, true);
  const record = redactSecretsForState(structuredClone(once), child, source, TEMPLATE_DERIVED_RULES, true) as {
    Value: unknown;
  };
  const diffParameters = redactParametersForDiff({ options: { inheritedSecrets: parent } } as never, { X: VALUE });
  // Best-effort, as the deploy's diff pass resolves (`deploy-flow/diff.ts`):
  // a `Select` past the masked list's end keeps the raw intrinsic there.
  let desired: unknown;
  try {
    desired = await new IntrinsicFunctionResolver('us-east-1').resolve(node, {
      ...contextFor(diffParameters, new Map(), parent),
      skipDynamicReferences: true,
    } as never);
  } catch {
    desired = node;
  }
  return { record, resolved, desired, child };
}

describe('a sub-floor-marked parameter with no certified spelling is masked in the child (go-to-k/cdkd#7050)', () => {
  for (const route of ['template text', 'withdrawn spelling', 'state-derived recorder'] as const) {
    describe(route, () => {
      it('the persist side binds the parameter as ***; the diff side keeps the scan', async () => {
        const parent = await parentRow(route);
        expect(persistedInheritedParameterValue(parent, 'X', VALUE)).toBe('***');
        // The diff side's binding is unchanged: a masked leaf is compared by
        // its fingerprints, and an embedding read a placeholder arm keeps as
        // resolved must compare equal (the redeploy below).
        expect(redactParametersForDiff({ options: { inheritedSecrets: parent } } as never, { X: VALUE })).toEqual({
          X: `x${PIN}:${BIG_TOKEN}`,
        });
      });
      for (const [shape, node] of Object.entries(SHAPES)) {
        it(`${shape}: persisted ***, and no pin text anywhere in the record or the bag`, async () => {
          const parent = await parentRow(route);
          const { record, resolved, child } = await childReadOf(parent, node);
          // Premise: the real value holds the pin (the big secret, for the
          // piece after it).
          expect(exposed(resolved)).toBe(shape !== 'Select[1] over Split');
          expect(JSON.stringify(record)).not.toContain(BIG);
          expect(record.Value).toBe('***');
          // The WHOLE record, and the child's bag of expressions.
          expect(exposed(record)).toBe(false);
          expect(exposed([...child.values()])).toBe(false);
        });
      }
    });
  }
});

// The control: where the parent's spelling places the pin by its own token,
// the parameter has a CERTIFIED spelling, and every read persists it, as the
// #4913 re-read does.
describe('a sub-floor-marked parameter WITH a certified spelling keeps it in the child (go-to-k/cdkd#7050)', () => {
  const CERTIFIED: Record<string, unknown> = {
    Ref: `x${PIN_TOKEN}:${BIG_TOKEN}`,
    'Select[0] over Split': `x${PIN_TOKEN}`,
    'Select[1] over Split': BIG_TOKEN,
    'Join over Split': `x${PIN_TOKEN}-${BIG_TOKEN}`,
  };
  async function certifiedRow(): Promise<RecordedSecretValues> {
    const bag: RecordedSecretValues = new Map();
    const source = {
      TemplateURL: TEMPLATE_URL,
      Parameters: { X: { 'Fn::Join': ['', ['x', PIN_TOKEN, ':', BIG_TOKEN]] }, Y: PIN_TOKEN },
    };
    const resolved = (await new IntrinsicFunctionResolver('us-east-1').resolve(source, contextFor({}, bag) as never)) as {
      Parameters: Record<string, unknown>;
    };
    expect(resolved.Parameters['X']).toBe(VALUE);
    recordNestedStackParameterExpressions(bag, NESTED, resolved, source);
    expect(attributionRefusedParameters.get(bag)?.get('X')).toBe('sub-floor');
    return bag;
  }
  for (const [shape, spelling] of Object.entries(CERTIFIED)) {
    it(`${shape}: persists the certified spelling, as the diff side holds it`, async () => {
      const { record, desired } = await childReadOf(await certifiedRow(), SHAPES[shape]);
      expect(record.Value).toBe(spelling);
      expect(desired).toBe(spelling);
      expect(exposed(record)).toBe(false);
    });
  }
});

// The redeploy: a child resource reading the parameter plans NO_CHANGE.
class CapturingDiffCalculator extends DiffCalculator {
  last: Map<string, { changeType: string }> | undefined;
  override async calculateDiff(
    ...args: Parameters<InstanceType<typeof DiffCalculator>['calculateDiff']>
  ): ReturnType<InstanceType<typeof DiffCalculator>['calculateDiff']> {
    const result = await super.calculateDiff(...args);
    this.last = new Map([...result].map(([id, c]) => [id, structuredClone(c)]));
    return result;
  }
}

async function deployChild(
  resources: Record<string, unknown>,
  node: unknown,
  parent: RecordedSecretValues,
  passed: 'secret' | 'clean'
) {
  const state = { version: 11, stackName: 's', region: 'us-east-1', resources, outputs: {}, lastModified: 0 };
  const calls: string[] = [];
  const provider = {
    create: vi.fn(async (id: string) => {
      calls.push('create:' + id);
      return { physicalId: 'new', attributes: {} };
    }),
    update: vi.fn(async (id: string) => {
      calls.push('update:' + id);
      return { physicalId: 'new', attributes: {} };
    }),
    delete: vi.fn(),
    getAttribute: vi.fn(),
    readCurrentState: vi.fn().mockResolvedValue(undefined),
  };
  const saveState = vi.fn().mockResolvedValue('etag');
  const diffCalculator = new CapturingDiffCalculator();
  const engine = new DeployEngine(
    {
      getState: vi.fn().mockResolvedValue({ state, etag: 'e0' }),
      saveState,
      loadRollbackJournal: vi.fn().mockResolvedValue(null),
      purgeRollbackJournalVersions: vi.fn().mockResolvedValue(undefined),
      rollbackJournalReadAbsent: vi.fn().mockReturnValue(false),
      warmConnections: vi.fn().mockResolvedValue(undefined),
      appendRollbackJournalSegment: vi.fn(),
      popRollbackJournalSegment: vi.fn(),
      deleteRollbackJournal: vi.fn(),
    } as never,
    { acquireLockWithRetry: vi.fn().mockResolvedValue(true), releaseLock: vi.fn() } as never,
    {
      buildGraph: vi.fn().mockReturnValue({}),
      getExecutionLevels: vi.fn().mockReturnValue([['Q']]),
      getDirectDependencies: vi.fn().mockReturnValue([]),
    } as never,
    diffCalculator,
    {
      getProvider: vi.fn().mockReturnValue(provider),
      getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'sdk' }),
      getRegisteredTypes: vi.fn().mockReturnValue([]),
      validateResourceTypes: vi.fn(),
      validateResourceProperties: vi.fn(),
    } as never,
    {
      dryRun: false,
      parameters: { X: VALUE },
      inheritedSecrets: parent,
      parentStackInfo: { parentStack: 'Parent', parentLogicalId: 'Child', parentRegion: 'us-east-1' },
      passedParameterClasses: new Map([['X', passed]]),
    } as never,
    'us-east-1'
  );
  let thrown: unknown;
  await engine
    .deploy('s', {
      Parameters: { X: { Type: 'String' } },
      Resources: { Q: { Type: 'AWS::SQS::Queue', Properties: { QueueName: 'q', Value: node } } },
    } as never)
    .catch((e: unknown) => {
      thrown = e;
    });
  const saved = saveState.mock.calls
    .flat()
    .filter((a): a is { resources: Record<string, unknown> } => typeof a === 'object' && a !== null && 'resources' in a);
  return { calls, thrown, persisted: saved[saved.length - 1]?.resources['Q'], diff: diffCalculator.last };
}

describe('a child reading a sub-floor-marked parameter redeploys with NO_CHANGE (go-to-k/cdkd#7050)', () => {
  for (const [shape, node] of Object.entries(SHAPES)) {
    for (const passed of ['secret', 'clean'] as const) it(`${shape} (passed as ${passed})`, async () => {
      const parent = await parentRow('state-derived recorder');
      const created = await deployChild({}, node, parent, passed);
      expect(created.thrown).toBeUndefined();
      expect(exposed(created.persisted)).toBe(false);
      const same = await deployChild({ Q: structuredClone(created.persisted) }, node, parent, passed);
      expect(same.thrown).toBeUndefined();
      expect(same.diff?.get('Q')?.changeType).toBe('NO_CHANGE');
      expect(same.calls).toEqual([]);
    });
  }
});

// The rollback replays record the row from its STATE record
// (`replay-revert.ts`), never deriving a substitution spelling. The record's
// own spelling of `X` holds the pin in its literal text.
describe("a rollback replay's revert of the row hands the child no pin text (go-to-k/cdkd#7050)", () => {
  it('every child read shape under the bag the revert binds persists ***', async () => {
    const ID = 'arn:cdkd-local:us-east-1:123456789012:nested-stack/Parent/Child';
    const row = (properties: Record<string, unknown>) => ({
      physicalId: ID,
      resourceType: NESTED,
      properties,
      attributes: {},
      dependencies: [],
    });
    const restored = { TemplateURL: TEMPLATE_URL, Parameters: { X: `x${PIN}:${BIG_TOKEN}`, Y: PIN_TOKEN } };
    const forward = { TemplateURL: TEMPLATE_URL, Parameters: { X: 'moved', Y: PIN_TOKEN } };
    let bound: RecordedSecretValues | undefined;
    let sent: unknown;
    const update = vi.fn(async (_id: string, physicalId: string, _type: string, props: unknown) => {
      bound = getCurrentResourceSecrets();
      sent = props;
      return { physicalId, attributes: {} };
    });
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), setLevel: vi.fn() };
    const result = await replayRollback(
      [
        {
          logicalId: 'Child',
          changeType: 'UPDATE',
          resourceType: NESTED,
          physicalId: ID,
          properties: forward,
          previousState: row(restored),
        },
      ] as never,
      { Child: row(forward) } as never,
      'Parent',
      {
        region: 'us-east-1',
        logger,
        providerRegistry: {
          getProviderFor: () => ({ provider: { create: vi.fn(), update, delete: vi.fn() } }),
        },
        recordEvent: () => undefined,
      } as never,
      { isInterrupted: () => false }
    );
    expect(result.failures).toBe(0);
    expect((sent as { Parameters: Record<string, unknown> }).Parameters['X']).toBe(VALUE);
    expect(attributionRefusedParameters.get(bound!)?.get('X')).toBe('sub-floor');
    for (const [shape, node] of Object.entries(SHAPES)) {
      const { record, child } = await childReadOf(bound!, node);
      expect([shape, record.Value]).toEqual([shape, '***']);
      expect(exposed(record)).toBe(false);
      expect(exposed([...child.values()])).toBe(false);
    }
  });
});
