/**
 * go-to-k/cdkd#7050 review: a nested child's masked create-only key on a
 * stateful type that reads a parameter the parent passed as `secret` beside
 * an input the walk cannot prove (a parameter passed with class `unknown`).
 * Its passed-secret value MACs cannot be bound to a proven input fingerprint,
 * so they prove nothing either way. An unchanged redeploy must not read the
 * key as a move (a stateful replacement refused on every deploy); a proven
 * input that moved is still planned; no plaintext is anywhere.
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

/** The sub-floor secret the parent's row references resolve to. */
const SECRET = 'q7';

const logSpies = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));
vi.mock('../../../src/utils/logger.js', () => {
  const fns = {
    setLevel: vi.fn(),
    debug: logSpies.debug,
    info: logSpies.info,
    warn: logSpies.warn,
    error: logSpies.error,
    child: () => fns,
  };
  return { getLogger: () => fns };
});

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sts: { send: vi.fn().mockResolvedValue({ Account: '123456789012' }) },
    ssm: {
      send: vi.fn(async (command: { input?: { Name?: string } }) => {
        if (command.input?.Name === '/app/a' || command.input?.Name === '/app/b') {
          return { Parameter: { Value: 'q7', Type: 'SecureString' } };
        }
        const notFound = new Error(`ParameterNotFound: ${String(command.input?.Name)}`);
        notFound.name = 'ParameterNotFound';
        throw notFound;
      }),
    },
    secretsManager: { send: vi.fn().mockRejectedValue(new Error('unused')) },
  }),
}));
vi.mock('@aws-sdk/client-cloudformation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-cloudformation')>();
  return {
    ...actual,
    CloudFormationClient: vi.fn(() => ({
      send: () => Promise.reject(new Error('DescribeType unavailable')),
    })),
  };
});
vi.mock('p-limit', () => ({ default: vi.fn(() => <T>(fn: () => T) => fn()) }));
// The passed-secret value MACs: a local HMAC double of KMS.
vi.mock('@aws-sdk/client-kms', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  const { createHmac } = await import('node:crypto');
  class FakeKMSClient {
    async send(command: { input: { Message: Uint8Array } }): Promise<unknown> {
      return {
        KeyId: 'arn:aws:kms:us-east-1:123456789012:key/11111111-2222-3333-4444-555555555555',
        Mac: new Uint8Array(
          createHmac('sha256', 'local-hmac-key-7050').update(command.input.Message).digest()
        ),
      };
    }
    destroy(): void {}
  }
  return { ...actual, KMSClient: FakeKMSClient };
});

const { IntrinsicFunctionResolver, resetAccountInfoCache } = await import(
  '../../../src/deployment/intrinsic-function-resolver.js'
);
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import type { ResourceChange, StackState } from '../../../src/types/state.js';
import { maskUnmovedRedactionMasks } from '../../../src/analyzer/diff-calculator/redaction-masks.js';
import { maskedPropertyFingerprint } from '../../../src/deployment/masked-property-fingerprints.js';

beforeEach(() => {
  for (const spy of Object.values(logSpies)) spy.mockClear();
  resetAccountInfoCache();
});

/**
 * The parent's `AWS::CloudFormation::Stack` row: `X` joins a sub-floor secret
 * (`Sep`, whose text `W`'s reference also resolves to) with a reference, so
 * the parent masks it and the child's read of it is masked whole.
 */
async function parentRow(): Promise<{ bag: RecordedSecretValues; value: string }> {
  const bag: RecordedSecretValues = new Map();
  const source = {
    TemplateURL: 'https://s3.amazonaws.com/bucket/child.json',
    Parameters: {
      X: { 'Fn::Join': ['', [{ Ref: 'Sep' }, '/', '{{resolve:ssm-secure:/app/a}}']] },
      W: '{{resolve:ssm-secure:/app/b}}',
    },
  };
  const context = {
    template: { Parameters: { Sep: { Type: 'String' } }, Resources: {} } as CloudFormationTemplate,
    resources: {},
    parameters: { Sep: SECRET },
    conditions: {},
    recordedSecretValues: bag,
  };
  const resolved = (await new IntrinsicFunctionResolver('us-east-1').resolve(
    source,
    context as never
  )) as { Parameters: Record<string, unknown> };
  recordNestedStackParameterExpressions(bag, 'AWS::CloudFormation::Stack', resolved, source);
  redactSecretsForState(structuredClone(resolved), bag, source, TEMPLATE_DERIVED_RULES, true);
  return { bag, value: String(resolved.Parameters['X']) };
}

class CapturingDiffCalculator extends DiffCalculator {
  last: Map<string, ResourceChange> | undefined;
  override async calculateDiff(
    ...args: Parameters<DiffCalculator['calculateDiff']>
  ): ReturnType<DiffCalculator['calculateDiff']> {
    const result = await super.calculateDiff(...args);
    this.last = new Map([...result].map(([id, c]) => [id, structuredClone(c)]));
    return result;
  }
}

interface Run {
  calls: string[];
  persisted: StackState['resources'][string] | undefined;
  thrown: unknown;
  diff: Map<string, ResourceChange> | undefined;
  sent: unknown[];
}

async function deploy(
  resources: StackState['resources'],
  templateResources: Record<string, unknown>,
  opts: Record<string, unknown>
): Promise<Run> {
  const state = {
    version: 11,
    stackName: 's',
    region: 'us-east-1',
    resources,
    outputs: {},
    lastModified: 0,
  } as StackState;
  const calls: string[] = [];
  const sent: unknown[] = [];
  const provider = {
    create: vi.fn(async (id: string, _type: string, props: unknown) => {
      calls.push('create:' + id);
      sent.push(props);
      return { physicalId: 'new', attributes: {} };
    }),
    update: vi.fn(async (id: string, _pid: string, _type: string, props: unknown) => {
      calls.push('update:' + id);
      sent.push(props);
      return { physicalId: resources[id]!.physicalId, attributes: {} };
    }),
    delete: vi.fn(async (id: string) => {
      calls.push('delete:' + id);
    }),
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
      getExecutionLevels: vi.fn().mockReturnValue([['Db']]),
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
    opts as never,
    'us-east-1'
  );
  let thrown: unknown;
  await engine
    .deploy('s', {
      Parameters: { X: { Type: 'String' }, Y: { Type: 'String' }, Z: { Type: 'String' } },
      Resources: templateResources,
    } as never)
    .catch((e: unknown) => {
      thrown = e;
    });
  const saved = saveState.mock.calls
    .flat()
    .filter(
      (a): a is StackState => typeof a === 'object' && a !== null && 'resources' in (a as object)
    );
  return {
    calls,
    persisted: saved[saved.length - 1]?.resources['Db'],
    thrown,
    diff: diffCalculator.last,
    sent,
  };
}

const logged = () => JSON.stringify(Object.values(logSpies).map((spy) => spy.mock.calls));

// `X` passed as `secret` (its MACs cannot bind: the passed-secret verdict is
// `'none'`), or as `clean` (no MAC at all: the key is simply unprovable).
for (const passed of ['secret', 'clean'] as const)
describe(`a masked key beside an unproven input, X passed as ${passed} (#7050 review)`, () => {
  // DBName (create-only on a stateful type) reads the passed secret `X` and a
  // parameter `Y` the parent passed with class `unknown`: the walk keeps `Y`
  // as written, so no input fingerprint of DBName is proven.
  const tpl = (retention: number) => ({
    Db: {
      Type: 'AWS::RDS::DBInstance',
      Properties: {
        Engine: 'mysql',
        DBName: { 'Fn::Join': ['-', [{ Ref: 'X' }, { Ref: 'Y' }]] },
        // A proven input of another key.
        MasterUsername: { Ref: 'Z' },
        BackupRetentionPeriod: retention,
      },
    },
  });
  const options = async (z = 'admin') => {
    const { bag, value } = await parentRow();
    return {
      value,
      opts: {
        dryRun: false,
        parameters: { X: value, Y: 'opaque', Z: z },
        inheritedSecrets: bag,
        parentStackInfo: {
          parentStack: 'Parent',
          parentLogicalId: 'Child',
          parentRegion: 'us-east-1',
        },
        passedParameterClasses: new Map([
          ['X', passed],
          ['Y', 'unknown'],
          ['Z', 'clean'],
        ]),
      },
    };
  };

  it('an unchanged redeploy is no refusal and no change, warned by resource and key', async () => {
    const { value, opts } = await options();
    const created = await deploy({}, tpl(1), opts);
    expect(created.thrown).toBeUndefined();
    expect(created.persisted?.properties['DBName']).toContain('***');
    for (const round of [1, 2]) {
      logSpies.warn.mockClear();
      const same = await deploy({ Db: structuredClone(created.persisted!) }, tpl(1), opts);
      const outcome = {
        thrown:
          same.thrown === undefined
            ? undefined
            : `${String((same.thrown as Error).message)} / ${String(
                ((same.thrown as { cause?: Error }).cause?.message ?? '').slice(0, 120)
              )}`,
        changeType: same.diff?.get('Db')?.changeType,
        paths: (same.diff?.get('Db')?.propertyChanges ?? []).map((pc) => pc.path),
        calls: same.calls,
      };
      // MEASURE line (#7050 review repro).
      console.log(`MEASURE round ${round}: ${JSON.stringify(outcome)}`);
      expect(outcome.thrown, `round ${round}`).toBeUndefined();
      expect(outcome.changeType).toBe('NO_CHANGE');
      expect(same.calls).toEqual([]);
      const warned = logSpies.warn.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.includes('Db') && line.includes('DBName'));
      expect(warned).toHaveLength(1);
      expect(warned[0]).toMatch(/cannot be proven unchanged/);
    }
    expect(logged()).not.toContain(value);
    expect(JSON.stringify(created.persisted)).not.toContain(value);
  });

  it('a proven input that moved is still planned and sent', async () => {
    const { value, opts } = await options();
    const created = await deploy({}, tpl(1), opts);
    const moved = await deploy({ Db: structuredClone(created.persisted!) }, tpl(7), opts);
    expect(moved.thrown).toBeUndefined();
    expect((moved.diff?.get('Db')?.propertyChanges ?? []).map((pc) => pc.path)).toEqual([
      'BackupRetentionPeriod',
    ]);
    expect(moved.calls).toEqual(['update:Db']);
    expect(JSON.stringify(moved.sent)).not.toContain('***');
    const renamed = await deploy(
      { Db: structuredClone(created.persisted!) },
      tpl(1),
      (await options('root')).opts
    );
    expect((renamed.diff?.get('Db')?.propertyChanges ?? []).map((pc) => pc.path)).toContain(
      'MasterUsername'
    );
    expect(renamed.calls.length > 0 || renamed.thrown !== undefined).toBe(true);
    for (const run of [moved, renamed]) {
      expect(JSON.stringify(run.diff?.get('Db'))).not.toContain(value);
      expect(JSON.stringify(run.persisted)).not.toContain(value);
    }
    expect(logged()).not.toContain(value);
  });

  it('a template edit of the masked key itself is still planned', async () => {
    const { opts } = await options();
    const created = await deploy({}, tpl(1), opts);
    const edited = tpl(1);
    edited.Db.Properties.DBName = { 'Fn::Join': ['_', [{ Ref: 'X' }, { Ref: 'Y' }]] };
    const run = await deploy({ Db: structuredClone(created.persisted!) }, edited, opts);
    expect((run.diff?.get('Db')?.propertyChanges ?? []).map((pc) => pc.path)).toContain('DBName');
    expect(run.calls.length > 0 || run.thrown !== undefined).toBe(true);
  });
});

// The plan's side alone: an unprovable key compares masked and is reported;
// a hashed input or a passed-secret MAC that moved is never masked.
describe('maskUnmovedRedactionMasks: unprovable keys (#7050 review)', () => {
  const raw = { DBName: { Ref: 'X' } };
  const TEXT = maskedPropertyFingerprint(raw.DBName);
  const input = (half: string) => `inputs-sha256:${half}+${TEXT}`;
  const record = (recorded?: string) =>
    ({
      properties: { DBName: '***' },
      maskedPropertyFingerprints: { DBName: TEXT },
      ...(recorded !== undefined && { maskedPropertyInputFingerprints: { DBName: recorded } }),
    }) as never;
  const fingerprinter = (now: string | undefined, concrete: boolean, verdict?: string) =>
    Object.assign(async () => now, {
      concrete: async () => concrete,
      ...(verdict !== undefined && { passedSecretVerdict: async () => verdict }),
    });
  const run = async (
    recorded: string | undefined,
    now: string | undefined,
    concrete: boolean,
    verdict?: string
  ) => {
    const reported: string[] = [];
    const out = await maskUnmovedRedactionMasks(
      record(recorded),
      raw,
      { DBName: '***' },
      { DBName: 'plan-value' },
      fingerprinter(now, concrete, verdict),
      undefined,
      (key) => void reported.push(key)
    );
    return { masked: out['DBName'] === '***', reported };
  };

  it('a hashed input that moved is compared as is', async () => {
    expect(await run(input('aa'), input('bb'), false)).toEqual({ masked: false, reported: [] });
    expect(await run(input('aa'), input('bb'), true)).toEqual({ masked: false, reported: [] });
    expect(await run(input('aa'), input('bb'), false, 'none')).toEqual({ masked: false, reported: [] });
  });
  it('a passed-secret MAC that moved is compared as is', async () => {
    expect(await run(input('aa'), input('aa'), false, 'changed')).toEqual({ masked: false, reported: [] });
  });
  it('proven unmoved: masked silently', async () => {
    expect(await run(input('aa'), input('aa'), true)).toEqual({ masked: true, reported: [] });
    expect(await run(input('aa'), input('aa'), false, 'confirmed')).toEqual({ masked: true, reported: [] });
  });
  it('unprovable: masked and reported (an unproven passed secret is reported by the engine side)', async () => {
    expect(await run(input('aa'), input('aa'), false)).toEqual({ masked: true, reported: ['DBName'] });
    expect(await run(undefined, undefined, false)).toEqual({ masked: true, reported: ['DBName'] });
    expect(await run(undefined, input('aa'), true)).toEqual({ masked: true, reported: ['DBName'] });
    expect(await run(undefined, undefined, false, 'none')).toEqual({ masked: true, reported: [] });
  });
  it('no usable passed-secret MAC keeps its earlier reading', async () => {
    expect(await run(input('aa'), input('aa'), false, 'absent')).toEqual({ masked: true, reported: [] });
    expect(await run(undefined, input('aa'), false, 'absent')).toEqual({ masked: false, reported: [] });
  });
});
