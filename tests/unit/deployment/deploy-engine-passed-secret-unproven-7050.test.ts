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
import {
  maskUnmovedRedactionMasks,
  reportUnverifiedPassedSecrets,
} from '../../../src/analyzer/diff-calculator/redaction-masks.js';
import { withPassedSecretBackfill } from '../../../src/deployment/noecho-value-macs.js';
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
  opts: Record<string, unknown>,
  declared: Record<string, unknown> = { X: { Type: 'String' }, Y: { Type: 'String' }, Z: { Type: 'String' } }
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
      Parameters: declared,
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

/** The stateful preflight's refusal of a replacement over `key`: nothing sent. */
function expectRefusedOver(run: { calls: string[]; thrown: unknown }, key: string): void {
  expect(run.calls).toEqual([]);
  const cause = (run.thrown as { cause?: Error } | undefined)?.cause?.message ?? '';
  expect(cause).toContain(`requires replacement (immutable property changed: ${key}) but it is a stateful resource`);
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
    // A proven create-only change on a stateful type: refused out loud.
    expectRefusedOver(renamed, 'MasterUsername');
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
    expectRefusedOver(run, 'DBName');
  });
});

// #7050 review (B1): a plain `NoEcho` parameter read is proven by its `NoEcho`
// value MAC, which masks the plan's side already: an unchanged redeploy warns
// of nothing, and a changed value is still planned and sent.
describe('a NoEcho parameter read is proven by its value MAC, never warned unprovable (#7050 review)', () => {
  const declared = { P: { Type: 'String', NoEcho: true } };
  for (const [label, read] of [
    ['a whole read', { Ref: 'P' }],
    ['an embedding read', { 'Fn::Join': ['', ['pw-', { Ref: 'P' }]] }],
  ] as const) {
    it(label, async () => {
      const tpl = {
        Db: { Type: 'AWS::RDS::DBInstance', Properties: { Engine: 'mysql', MasterUserPassword: read, BackupRetentionPeriod: 1 } },
      };
      const opts = (p: string) => ({ dryRun: false, parameters: { P: p } });
      const created = await deploy({}, tpl, opts('hunter22-pw'), declared);
      expect(created.thrown).toBeUndefined();
      expect(created.persisted?.properties['MasterUserPassword']).toBe('***');
      for (const round of [1, 2]) {
        logSpies.warn.mockClear();
        const same = await deploy({ Db: structuredClone(created.persisted!) }, tpl, opts('hunter22-pw'), declared);
        expect(same.thrown, `round ${round}`).toBeUndefined();
        // Only the `NoEcho` promotion (#4043), which the engine settles with
        // the MAC in hand: nothing sent.
        expect((same.diff?.get('Db')?.propertyChanges ?? []).map((pc) => [pc.path, pc.noEchoPromoted === true])).toEqual([
          ['MasterUserPassword', true],
        ]);
        expect(same.calls).toEqual([]);
        expect(logSpies.warn.mock.calls.map((call) => String(call[0])).filter((line) => line.includes('MasterUserPassword'))).toEqual([]);
      }
      const changed = await deploy({ Db: structuredClone(created.persisted!) }, tpl, opts('hunter33-pw'), declared);
      expect(changed.thrown).toBeUndefined();
      expect(changed.calls).toEqual(['update:Db']);
      expect(JSON.stringify(changed.sent)).toContain('hunter33-pw');
      expect(JSON.stringify(changed.persisted)).not.toContain('hunter33-pw');
    });
  }
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
  // The plan's value of an unprovable key holds a mask of its own (a masked
  // parameter it read); `plan-value` is one the plan holds in the clear.
  const run = async (
    recorded: string | undefined,
    now: string | undefined,
    concrete: boolean,
    verdict?: string,
    planned = '***-plan'
  ) => {
    const reported: string[] = [];
    const out = await maskUnmovedRedactionMasks(
      record(recorded),
      raw,
      { DBName: '***' },
      { DBName: planned },
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
  // A plan value with no mask of its own (a `NoEcho` source's: a parameter,
  // one whose `NoEcho` was removed, a recovered masked output) is compared as
  // is: the engine settles it by readback (deploy-engine-noecho-v11,
  // deploy-engine-replacement-ceiling).
  it('unprovable with a plan value in the clear: compared as is, not reported', async () => {
    expect(await run(input('aa'), input('aa'), false, undefined, 'plan-value')).toEqual({ masked: false, reported: [] });
    expect(await run(undefined, input('aa'), true, undefined, 'plan-value')).toEqual({ masked: false, reported: [] });
  });
  // As `movedMaskedProperties` reads it: unmoved with equal inputs or none
  // recorded (re-baselined there); an input unknown today is compared.
  it('no usable passed-secret MAC: masked while the engine side reads it unmoved', async () => {
    for (const verdict of ['absent', 'unavailable', 'unusable']) {
      expect(await run(input('aa'), input('aa'), false, verdict)).toEqual({ masked: true, reported: [] });
      expect(await run(undefined, input('aa'), false, verdict)).toEqual({ masked: true, reported: [] });
      expect(await run(input('aa'), undefined, false, verdict)).toEqual({ masked: false, reported: [] });
    }
  });
});

// #7050 review: each backfill guard, on its own. A member is stamped only
// while bound to the record's input fingerprint (or the one this plan
// re-baselines), only by a run that writes, and only onto a key holding none.
describe('the passed-secret backfill guards (#7050 review)', () => {
  const TEXT = maskedPropertyFingerprint({ Ref: 'X' });
  const input = (half: string) => `inputs-sha256:${half}+${TEXT}`;
  const record = (recorded: string | undefined, member?: unknown) =>
    ({
      physicalId: 'p',
      resourceType: 'AWS::RDS::DBInstance',
      attributes: {},
      dependencies: [],
      properties: { DBName: '***' },
      maskedPropertyFingerprints: { DBName: TEXT },
      ...(recorded !== undefined && { maskedPropertyInputFingerprints: { DBName: recorded } }),
      ...(member !== undefined && { noEchoValueMacs: { DBName: { 'cdkd:passed': member } } }),
    }) as never;
  const member = (fingerprint: string) => ({ fingerprint, macs: { X: 'kms-hmac-sha256:arn:aws:kms:us-east-1:123456789012:key/k:AAAA' } });
  const report = async (
    recorded: string | undefined,
    today: string,
    backfills: Map<string, Record<string, unknown>> | undefined,
    rebaselined?: Map<string, string>
  ) => {
    const warned: string[] = [];
    await reportUnverifiedPassedSecrets({
      logicalId: 'Db',
      record: record(recorded),
      unverified: [['DBName', 'absent']],
      fingerprinter: { passedSecretMember: async () => member(today) },
      backfills: backfills as never,
      ...(rebaselined !== undefined && { rebaselined }),
      warn: (message) => void warned.push(message),
    });
    return warned;
  };

  it('a member bound to another input fingerprint is never stamped, and said so', async () => {
    const backfills = new Map<string, Record<string, unknown>>();
    const warned = await report(input('aa'), input('bb'), backfills);
    expect(backfills.size).toBe(0);
    expect(warned).toHaveLength(1);
    expect(warned[0]).toMatch(/nor an input fingerprint one could be bound to/);
    expect(warned[0]).not.toMatch(/NoEcho value MAC key/);
  });
  it('a member bound to the recorded, or the re-baselined, fingerprint is stamped', async () => {
    const backfills = new Map<string, Record<string, unknown>>();
    expect(await report(input('aa'), input('aa'), backfills)).toEqual([expect.stringMatching(/This deploy records one/)]);
    expect(backfills.get('Db')).toEqual({ DBName: member(input('aa')) });
    const rebaselined = new Map<string, Record<string, unknown>>();
    await report(undefined, input('cc'), rebaselined, new Map([['DBName', input('cc')]]));
    expect(rebaselined.get('Db')).toEqual({ DBName: member(input('cc')) });
  });
  it('a run that writes nothing (a dry run) stamps nothing and says no deploy recorded one', async () => {
    const warned = await report(input('aa'), input('aa'), undefined);
    expect(warned).toHaveLength(1);
    expect(warned[0]).toMatch(/A deploy that can make one/);
    expect(warned[0]).not.toMatch(/This deploy records one/);
  });
  it('withPassedSecretBackfill stamps only a key holding no member', () => {
    const stamped = withPassedSecretBackfill(record(input('aa')), { DBName: member(input('aa')) });
    expect((stamped as { noEchoValueMacs?: unknown }).noEchoValueMacs).toEqual({ DBName: { 'cdkd:passed': member(input('aa')) } });
    for (const held of [{ fingerprint: 'cdkd:dropped' }, member(input('zz'))]) {
      const before = record(input('aa'), held);
      expect(withPassedSecretBackfill(before, { DBName: member(input('aa')) })).toBe(before);
    }
    // Nor one whose bound fingerprint is not the record's.
    const other = record(input('aa'));
    expect(withPassedSecretBackfill(other, { DBName: member(input('bb')) })).toBe(other);
  });
});
