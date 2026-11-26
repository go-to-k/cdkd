/**
 * go-to-k/cdkd#7050, the nested-stack half: a row's `Parameters` leaf holding
 * a sub-floor secret beside a parameter whose value holds the same text. The
 * engine's sequence (resolve, the parameter recorder, persist) for the
 * parent's record, then the child resource reading the parameter through a
 * `{Ref}`, persisted by the child engine's walk. Harness shared with
 * `nested-stack-refused-frame-carry.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import {
  inheritNestedStackParameterAssociations,
  MIN_NEEDLE_LENGTH,
  recordIntrinsicLeafResolution,
  recordNestedStackParameterExpressions,
  recordResolvedPair,
  type IntrinsicLeafResolution,
  type RecordedSecretValues,
} from '../../../src/deployment/secret-redaction.js';
import { redactSecretsForState } from '../../../src/deployment/secret-redaction/redact-state.js';
import { TEMPLATE_DERIVED_RULES } from '../../../src/deployment/secret-redaction/rules.js';

/** The sub-floor secret every reference below resolves to. */
const PIN = 'q7';

const SECRET_ID = 'cdkd-refused-frame-carry-probe';

/**
 * How many times `/app/flip` (unclassifiable first, then public) and
 * `/app/flop` (public first, then unclassifiable) have been read.
 */
const flipReads = vi.hoisted(() => ({ count: 0, flop: 0 }));

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
        const name = command.input?.Name;
        // SecureStrings holding the pin under several names, so two leaves can
        // share a value through different tokens.
        if (name === '/app/pin' || name === '/app/dev' || name === '/app/a' || name === '/app/b') {
          return { Parameter: { Value: 'q7', Type: 'SecureString' } };
        }
        if (name === '/other') return { Parameter: { Value: 'q7', Type: 'SecureString' } };
        // A parameter NAMED by an inherited secret (the #4130 review's M0): its
        // name reaches the token only after that secret is substituted in.
        if (name === '/app/pinname-long') return { Parameter: { Value: 'q7', Type: 'SecureString' } };
        // A secret whose value occurs in its own token's text (the #4130
        // review's M2): `in` inside `{{resolve:ssm:/app/kin}}`.
        if (name === '/app/kin') return { Parameter: { Value: 'in', Type: 'SecureString' } };
        // A SecureString whose value is itself reference text (issue #3306's
        // two-stage shape): the object's final pass resolves it again.
        if (name === '/app/ref') {
          return { Parameter: { Value: '{{resolve:ssm:/app/pin}}', Type: 'SecureString' } };
        }
        // A PUBLIC parameter holding the same two characters.
        if (name === '/app/prod') return { Parameter: { Value: 'q7', Type: 'String' } };
        // No `Type` first (unclassifiable: secret for that read, never cached),
        // then a definitive public answer with the same value.
        if (name === '/app/flip') {
          flipReads.count += 1;
          return flipReads.count === 1
            ? { Parameter: { Value: 'q7' } }
            : { Parameter: { Value: 'q7', Type: 'String' } };
        }
        if (name === '/app/flop') {
          flipReads.flop += 1;
          return flipReads.flop === 1
            ? { Parameter: { Value: 'q7', Type: 'String' } }
            : { Parameter: { Value: 'q7' } };
        }
        const notFound = new Error(`ParameterNotFound: ${String(name)}`);
        notFound.name = 'ParameterNotFound';
        throw notFound;
      }),
    },
    secretsManager: {
      send: vi.fn(async (command: { input?: { SecretId?: string } }) => {
        if (command.input?.SecretId === SECRET_ID) return { SecretString: JSON.stringify({ pin: 'q7' }) };
        const notFound = new Error("Secrets Manager can't find the specified secret.");
        notFound.name = 'ResourceNotFoundException';
        throw notFound;
      }),
    },
  }),
}));

const { IntrinsicFunctionResolver, resetAccountInfoCache } = await import(
  '../../../src/deployment/intrinsic-function-resolver.js'
);

const NESTED = 'AWS::CloudFormation::Stack';
const TEMPLATE_URL = 'https://s3.amazonaws.com/bucket/child.json';

beforeEach(() => {
  logSpies.debug.mockClear();
  logSpies.info.mockClear();
  logSpies.warn.mockClear();
  logSpies.error.mockClear();
  flipReads.count = 0;
  flipReads.flop = 0;
  resetAccountInfoCache();
});

/**
 * A template declaring `values`' keys as String parameters, the values bound,
 * and two conditions.
 */
function contextFor(
  values: Record<string, string>,
  bag: RecordedSecretValues,
  inheritedSecrets?: RecordedSecretValues
) {
  return {
    template: {
      Parameters: Object.fromEntries(Object.keys(values).map((k) => [k, { Type: 'String' }])),
      Resources: {},
    } as CloudFormationTemplate,
    resources: {},
    parameters: values,
    // For the `Fn::If` cases (issue #3306); no other case names a condition.
    conditions: { On: true, Off: false },
    recordedSecretValues: bag,
    ...(inheritedSecrets ? { inheritedSecrets } : {}),
  };
}

/**
 * One `AWS::CloudFormation::Stack` row through the engine's sequence: resolve
 * `parameters` into a fresh bag, run the carry over the same source object,
 * and persist the row. `inheritedSecrets` makes it a nested engine's row.
 */
async function deployRow(
  parameters: Record<string, unknown>,
  bound: Record<string, string> = {},
  inheritedSecrets?: RecordedSecretValues,
  // A resolver and a bag to reuse, and resolutions of the same row source to
  // run into that bag first (the cache and conflict cases).
  reuse: {
    resolver?: InstanceType<typeof IntrinsicFunctionResolver>;
    earlier?: ReadonlyArray<InstanceType<typeof IntrinsicFunctionResolver>>;
  } = {}
) {
  const bag: RecordedSecretValues = new Map();
  if (inheritedSecrets) inheritNestedStackParameterAssociations(bag, inheritedSecrets);
  const source = { TemplateURL: TEMPLATE_URL, Parameters: parameters };
  for (const earlier of reuse.earlier ?? []) {
    await earlier.resolve(source, contextFor(bound, bag, inheritedSecrets) as never);
  }
  const resolver = reuse.resolver ?? new IntrinsicFunctionResolver('us-east-1');
  const resolved = (await resolver.resolve(source, contextFor(bound, bag, inheritedSecrets) as never)) as {
    Parameters: Record<string, unknown>;
  };
  recordNestedStackParameterExpressions(bag, NESTED, resolved, source);
  const record = redactSecretsForState(structuredClone(resolved), bag, source, TEMPLATE_DERIVED_RULES, true) as {
    Parameters: Record<string, unknown>;
  };
  return { bag, resolved, record };
}

/** A child resource consuming `name` through `{ Ref }`, persisted by the child engine's walk. */
async function childPersist(parentRowBag: RecordedSecretValues, name: string, value: string): Promise<unknown> {
  const bag: RecordedSecretValues = new Map();
  inheritNestedStackParameterAssociations(bag, parentRowBag);
  const source = { Value: { Ref: name } };
  const resolver = new IntrinsicFunctionResolver('us-east-1');
  const resolved = (await resolver.resolve(
    source,
    contextFor({ [name]: value }, bag, parentRowBag) as never
  )) as Record<string, unknown>;
  const record = redactSecretsForState(structuredClone(resolved), bag, source, TEMPLATE_DERIVED_RULES, true) as {
    Value: unknown;
  };
  return record.Value;
}


/** No plaintext of the sub-floor secret outside a `{{resolve:...}}` token. */
function exposed(value: unknown): boolean {
  return String(value).split(/\{\{resolve:[^}]+\}\}/).join('\u0000').includes(PIN);
}

describe('a nested stack row: a sub-floor secret beside a parameter holding its text (#7050)', () => {
  const TOKEN = '{{resolve:ssm:/app/pin}}';
  for (const [label, source] of [
    ['a Join of a parameter, text and the reference', { 'Fn::Join': ['', [{ Ref: 'Sep' }, '/', TOKEN]] }],
    ['a Join of the reference, text and a parameter', { 'Fn::Join': ['', [TOKEN, '/', { Ref: 'Sep' }]] }],
    ['a Sub variable map', { 'Fn::Sub': ['${S}/${T}', { S: { Ref: 'Sep' }, T: TOKEN }] }],
  ] as const) {
    it(`${label}: neither the parent record nor the child holds the secret`, async () => {
      const { bag, resolved, record } = await deployRow({ X: source }, { Sep: PIN });
      expect(resolved.Parameters['X']).toContain(PIN);
      expect(exposed(record.Parameters['X'])).toBe(false);
      const child = await childPersist(bag, 'X', String(resolved.Parameters['X']));
      expect(exposed(child)).toBe(false);
    });
  }

  it('a row value masked because two references share its text masks the child read too (security review)', async () => {
    const { bag, resolved, record } = await deployRow(
      {
        X: { 'Fn::Join': ['', [{ Ref: 'Sep' }, '/', '{{resolve:ssm-secure:/app/a}}']] },
        Y: '{{resolve:ssm-secure:/app/b}}',
      },
      { Sep: PIN }
    );
    expect(record.Parameters['X']).toBe('***');
    const child = await childPersist(bag, 'X', String(resolved.Parameters['X']));
    expect(child).toBe('***');
    // ...and a child leaf EMBEDDING it.
    const embedding = new Map() as RecordedSecretValues;
    inheritNestedStackParameterAssociations(embedding, bag);
    const source = { Value: { 'Fn::Join': ['', ['a-', { Ref: 'X' }]] } };
    const childResolved = (await new IntrinsicFunctionResolver('us-east-1').resolve(
      source,
      contextFor({ X: String(resolved.Parameters['X']) }, embedding, bag) as never
    )) as Record<string, unknown>;
    const persisted = redactSecretsForState(structuredClone(childResolved), embedding, source, TEMPLATE_DERIVED_RULES, true) as { Value: unknown };
    expect(exposed(persisted.Value)).toBe(false);
  });

  // #7059: the child reads a parameter holding a sub-floor secret's text.
  async function childLeaf(bag: RecordedSecretValues, value: string, node: unknown): Promise<unknown> {
    const child = new Map() as RecordedSecretValues;
    inheritNestedStackParameterAssociations(child, bag);
    const source = { Value: node };
    const resolved = (await new IntrinsicFunctionResolver('us-east-1').resolve(
      source,
      contextFor({ X: value }, child, bag) as never
    )) as Record<string, unknown>;
    return (
      redactSecretsForState(structuredClone(resolved), child, source, TEMPLATE_DERIVED_RULES, true) as {
        Value: unknown;
      }
    ).Value;
  }

  it('#7059: a child SPLITTING the parameter never keeps the sub-floor secret', async () => {
    const { bag, resolved } = await deployRow({
      X: { 'Fn::Join': ['', ['{{resolve:ssm-secure:/app/a}}', '/tail']] },
    });
    const value = String(resolved.Parameters['X']);
    expect(value).toBe(`${PIN}/tail`);
    const piece = await childLeaf(bag, value, { 'Fn::Select': [0, { 'Fn::Split': ['/', { Ref: 'X' }] }] });
    expect(exposed(piece)).toBe(false);
    const joined = await childLeaf(bag, value, { 'Fn::Join': ['', ['a-', { Ref: 'X' }]] });
    expect(exposed(joined)).toBe(false);
  });

  it('#7059: a row value under 4 characters is never kept by the child', async () => {
    const { bag, resolved } = await deployRow({
      X: { 'Fn::Join': ['', ['{{resolve:ssm:/app/kin}}', 'x']] },
    });
    const value = String(resolved.Parameters['X']);
    expect(value).toBe('inx');
    for (const node of [
      { Ref: 'X' },
      { 'Fn::Join': ['', ['a-', { Ref: 'X' }]] },
      { 'Fn::Select': [0, { 'Fn::Split': ['x', { Ref: 'X' }] }] },
    ]) {
      const out = String(await childLeaf(bag, value, node));
      expect(out.split(/\{\{resolve:[^}]+\}\}/).join('|')).not.toContain('in');
    }
  });
});

vi.mock('@aws-sdk/client-cloudformation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-cloudformation')>();
  return { ...actual, CloudFormationClient: vi.fn(() => ({ send: () => Promise.reject(new Error('DescribeType unavailable')) })) };
});
vi.mock('p-limit', () => ({ default: vi.fn(() => <T>(fn: () => T) => fn()) }));
// The passed-secret value MACs (#7050): a local HMAC double of KMS, so the
// MACs are real keyed MACs of what the engine asks for.
const kms = vi.hoisted(() => ({
  calls: 0,
  keyArn: 'arn:aws:kms:us-east-1:123456789012:key/11111111-2222-3333-4444-555555555555',
  fail: false,
}));
vi.mock('@aws-sdk/client-kms', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  const { createHmac } = await import('node:crypto');
  class FakeKMSClient {
    async send(command: { input: { Message: Uint8Array } }): Promise<unknown> {
      kms.calls++;
      if (kms.fail) throw Object.assign(new Error('denied'), { name: 'AccessDeniedException' });
      return {
        KeyId: kms.keyArn,
        Mac: new Uint8Array(createHmac('sha256', 'local-hmac-key-7050').update(command.input.Message).digest()),
      };
    }
    destroy(): void {}
  }
  return { ...actual, KMSClient: FakeKMSClient };
});
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import {
  maskedPropertyFingerprint,
  movedMaskedProperties,
} from '../../../src/deployment/masked-property-fingerprints.js';
import type { ResourceChange, StackState } from '../../../src/types/state.js';
interface Run { calls: string[]; persisted: StackState['resources'][string] | undefined; thrown: unknown; diff: Map<string, ResourceChange> | undefined; sent?: Array<{ props: unknown; previous: unknown }>; }
class CapturingDiffCalculator extends DiffCalculator {
  last: Map<string, ResourceChange> | undefined;
  override async calculateDiff(
    ...args: Parameters<DiffCalculator['calculateDiff']>
  ): ReturnType<DiffCalculator['calculateDiff']> {
    // A copy of what the PLAN saw: provisioning later edits the rows in place.
    const result = await super.calculateDiff(...args);
    this.last = new Map([...result].map(([id, c]) => [id, structuredClone(c)]));
    return result;
  }
}

async function deploy(
  resources: StackState['resources'],
  templateResources: Record<string, unknown>,
  opts: Record<string, unknown> = { dryRun: false },
  declared: Record<string, unknown> = { X: { Type: 'String' } }
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
  const sent: Array<{ props: unknown; previous: unknown }> = [];
  const provider = {
    create: vi.fn(async (id: string) => {
      calls.push('create:' + id);
      return { physicalId: 'new', attributes: {} };
    }),
    update: vi.fn(async (id: string, _pid: string, _type: string, props: unknown, previous: unknown) => {
      calls.push('update:' + id);
      sent.push({ props, previous });
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
  await engine.deploy('s', { Parameters: declared, Resources: templateResources } as never).catch((e: unknown) => {
    thrown = e;
  });
  const saved = saveState.mock.calls
    .flat()
    .filter(
      (a): a is StackState => typeof a === 'object' && a !== null && 'resources' in (a as object)
    );
  return { calls, persisted: saved[saved.length - 1]?.resources['Db'], thrown, diff: diffCalculator.last, sent };
}

/** The stateful preflight's refusal of a replacement over `key`: nothing sent. */
function expectRefusedOver(run: { calls: string[]; thrown: unknown }, key: string): void {
  expect(run.calls).toEqual([]);
  const cause = (run.thrown as { cause?: Error } | undefined)?.cause?.message ?? '';
  expect(cause).toContain(`requires replacement (immutable property changed: ${key}) but it is a stateful resource`);
}

// go-to-k/cdkd#7050 review: a child whose read of a row parameter is MASKED
// must not plan that mask as a change on an unchanged redeploy, nor refuse or
// replace the (stateful) resource over it, nor hand the provider `***`.
describe('a masked child read redeploys without a phantom change (#7050, #7059)', () => {
  for (const [label, row, node] of [
    ['sub-floor Ref', { 'Fn::Join': ['', ['{{resolve:ssm:/app/kin}}', 'x']] }, { Ref: 'X' }],
    ['sub-floor Join', { 'Fn::Join': ['', ['{{resolve:ssm-secure:/app/a}}', '/tail']] }, { 'Fn::Join': ['', ['a-', { Ref: 'X' }]] }],
    ['sub-floor Select', { 'Fn::Join': ['', ['{{resolve:ssm-secure:/app/a}}', '/tail']] }, { 'Fn::Select': [0, { 'Fn::Split': ['/', { Ref: 'X' }] }] }],
    ['masked row, whole read', 'M', { Ref: 'X' }],
    ['masked row, embedding read', 'M', { 'Fn::Join': ['', ['a-', { Ref: 'X' }]] }],
    ['public separator beside a secret', 'S', { Ref: 'X' }],
    ['a public row holding an unrelated secret\'s text, whole read', 'C', { Ref: 'X' }],
    ['a public row holding an unrelated secret\'s text, embedding read', 'C', { 'Fn::Join': ['', ['a-', { Ref: 'X' }]] }],
  ] as const) {
    // A parameter the parent passed as SECRET is kept as written by the input
    // walk: its value MACs (#7050) prove it unchanged, and a value that
    // really moved is never hidden.
    for (const passed of ['secret', 'clean'] as const) it(`${label} (passed as ${passed})`, async () => {
      kms.fail = false;
      const { bag, resolved } = row === 'M'
        ? await deployRow({ X: { 'Fn::Join': ['', [{ Ref: 'Sep' }, '/', '{{resolve:ssm-secure:/app/a}}']] }, Y: '{{resolve:ssm-secure:/app/b}}' }, { Sep: PIN })
        : row === 'C'
          ? await deployRow({ X: { 'Fn::Join': ['', [{ Ref: 'Sep' }, '-tail']] }, Y: '{{resolve:ssm-secure:/app/pin}}' }, { Sep: 'aq7x' })
          : row === 'S'
            ? await deployRow({ X: { 'Fn::Join': ['', [{ Ref: 'Sep' }, '/', '{{resolve:ssm:/app/pin}}']] } }, { Sep: PIN })
            : await deployRow({ X: row as never });
      const value = String(resolved.Parameters['X']);
      const tpl = (n: number) => ({
        Db: { Type: 'AWS::RDS::DBInstance', Properties: { Engine: 'mysql', DBName: node, BackupRetentionPeriod: n } },
      });
      // The options a real child deploy carries (#7050 review).
      const opts = {
        dryRun: false,
        parameters: { X: value },
        inheritedSecrets: bag,
        parentStackInfo: { parentStack: 'Parent', parentLogicalId: 'Child', parentRegion: 'us-east-1' },
        passedParameterClasses: new Map([['X', passed]]),
      };
      const created = await deploy({}, tpl(1), opts);
      expect(created.thrown).toBeUndefined();
      const moved = await deploy({ Db: structuredClone(created.persisted!) }, tpl(1), {
        ...opts,
        parameters: { X: `moved-${value}` },
      });
      expect((moved.diff?.get('Db')?.propertyChanges ?? []).map((pc) => pc.path)).toContain('DBName');
      // A create-only change on a stateful type: refused out loud, nothing sent.
      expectRefusedOver(moved, 'DBName');
      // A secret-bearing value (the masked rows) is in neither the plan nor
      // the record (its MAC member included), nor any log line.
      if (row === 'M' || row === 'S') {
        const logged = JSON.stringify(Object.values(logSpies).map((spy) => spy.mock.calls));
        for (const text of [JSON.stringify(moved.diff?.get('Db')), JSON.stringify(created.persisted), logged]) {
          expect(text).not.toContain(value);
          expect(text).not.toContain(`moved-${value}`);
        }
      }
      const same = await deploy({ Db: structuredClone(created.persisted!) }, tpl(1), opts);
      expect(same.thrown).toBeUndefined();
      expect(same.diff?.get('Db')?.changeType).toBe('NO_CHANGE');
      expect(same.calls).toEqual([]);
      const next = await deploy({ Db: structuredClone(created.persisted!) }, tpl(7), opts);
      expect(next.thrown).toBeUndefined();
      expect((next.diff?.get('Db')?.propertyChanges ?? []).map((pc) => pc.path)).toEqual(['BackupRetentionPeriod']);
      expect(next.calls).toEqual(['update:Db']);
      expect(JSON.stringify(next.sent)).not.toContain('***');
    });
  }
});

// #7050: a passed-secret parameter's value is compared only through its keyed
// MACs. Without that proof (an older record, a malformed member, no KMS this
// run) the masked key is a VISIBLE change on the plan and the deploy acts on
// it: nothing is hidden behind the mask.
describe('a masked child read with no passed-secret MAC proof is a visible change (#7050)', () => {
  const masked = async () => {
    const { bag, resolved } = await deployRow(
      { X: { 'Fn::Join': ['', [{ Ref: 'Sep' }, '/', '{{resolve:ssm-secure:/app/a}}']] }, Y: '{{resolve:ssm-secure:/app/b}}' },
      { Sep: PIN }
    );
    return {
      dryRun: false,
      parameters: { X: String(resolved.Parameters['X']) },
      inheritedSecrets: bag,
      parentStackInfo: { parentStack: 'Parent', parentLogicalId: 'Child', parentRegion: 'us-east-1' },
      passedParameterClasses: new Map([['X', 'secret' as const]]),
    };
  };
  const tpl = { Db: { Type: 'AWS::RDS::DBInstance', Properties: { Engine: 'mysql', DBName: { Ref: 'X' }, BackupRetentionPeriod: 1 } } };

  it('the record stamps keyed MACs, never the value', async () => {
    kms.fail = false;
    const opts = await masked();
    const created = await deploy({}, tpl, opts);
    const member = (created.persisted?.noEchoValueMacs?.['DBName'] as Record<string, unknown> | undefined)?.['cdkd:passed'] as
      | { fingerprint: string; macs: Record<string, string> }
      | undefined;
    expect(member?.fingerprint).toBe(created.persisted?.maskedPropertyInputFingerprints?.['DBName']);
    expect(Object.keys(member?.macs ?? {})).toEqual(['X']);
    expect(member?.macs['X']).toMatch(/^kms-hmac-sha256:arn:aws:kms:[^:]+:\d+:key\/[0-9a-f-]+:[A-Za-z0-9+/]+=*$/);
  });

  type Member = { fingerprint: string; macs: Record<string, string> };
  const passedOf = (record: unknown): unknown =>
    ((record as { noEchoValueMacs?: Record<string, Record<string, unknown>> } | undefined)?.noEchoValueMacs?.[
      'DBName'
    ] ?? {})['cdkd:passed'];
  /** The warnings naming `Db` and `DBName` since the last clear, and every log line as text. */
  const warnings = () => {
    const lines = logSpies.warn.mock.calls.map((call) => String(call[0]));
    logSpies.warn.mockClear();
    return lines.filter((line) => line.includes('Db') && line.includes('DBName'));
  };
  const logged = () => JSON.stringify(Object.values(logSpies).map((spy) => spy.mock.calls));
  const oldRecord = (record: StackState['resources'][string]) => {
    const copy = structuredClone(record) as unknown as Record<string, unknown>;
    delete copy['noEchoValueMacs'];
    return copy as never;
  };

  // #7050 review (B1): a record written before the passed-secret MACs has
  // none. Its masked key is compared by its input fingerprint this once, the
  // MAC is stamped by the same deploy, and it is compared from then on.
  it('an older record with no MAC: unmoved once with a warning, the MAC stamped, then compared', async () => {
    kms.fail = false;
    const opts = await masked();
    const created = await deploy({}, tpl, opts);
    const stamped = passedOf(created.persisted) as Member;
    expect(stamped.fingerprint).toBe(created.persisted?.maskedPropertyInputFingerprints?.['DBName']);
    logSpies.warn.mockClear();
    const same = await deploy({ Db: oldRecord(created.persisted!) }, tpl, opts);
    expect(same.thrown).toBeUndefined();
    expect(same.diff?.get('Db')?.changeType).toBe('NO_CHANGE');
    expect(same.calls).toEqual([]);
    // The same deploy's save stamps the MAC: the one a create would have.
    expect(passedOf(same.persisted)).toEqual(stamped);
    const warned = warnings();
    expect(warned).toHaveLength(1);
    expect(warned[0]).toMatch(/not compared on this deploy/);
    expect(warned[0]).toMatch(/This deploy records one, and the key is compared from the next deploy on/);
    expect(logged()).not.toContain(opts.parameters.X);
    // The next deploy compares the stamped MAC: no change, no warning.
    const next = await deploy({ Db: structuredClone(same.persisted!) }, tpl, opts);
    expect(next.thrown).toBeUndefined();
    expect(next.diff?.get('Db')?.changeType).toBe('NO_CHANGE');
    expect(warnings()).toEqual([]);
    // And a value that moved after the stamp is planned: the backfill never fires again.
    const moved = await deploy({ Db: structuredClone(same.persisted!) }, tpl, {
      ...opts,
      parameters: { X: `moved-${opts.parameters.X}` },
    });
    expect((moved.diff?.get('Db')?.propertyChanges ?? []).map((pc) => pc.path)).toContain('DBName');
    expectRefusedOver(moved, 'DBName');
    expect(warnings()).toEqual([]);
  });

  // A dry run writes nothing: it backfills nothing and never says it does.
  it('an older record with no MAC under --dry-run: unmoved, warned, nothing recorded', async () => {
    kms.fail = false;
    const opts = await masked();
    const created = await deploy({}, tpl, opts);
    logSpies.warn.mockClear();
    const dry = await deploy({ Db: oldRecord(created.persisted!) }, tpl, { ...opts, dryRun: true });
    expect(dry.thrown).toBeUndefined();
    expect(dry.diff?.get('Db')?.changeType).toBe('NO_CHANGE');
    expect(dry.calls).toEqual([]);
    if (dry.persisted !== undefined) expect(passedOf(dry.persisted)).toBeUndefined();
    const warned = warnings();
    expect(warned).toHaveLength(1);
    expect(warned[0]).toMatch(/A deploy that can make one/);
    expect(warned[0]).not.toMatch(/This deploy records one/);
  });

  it('an older record with no MAC whose other input moved plans the change', async () => {
    kms.fail = false;
    const opts = await masked();
    const joined = {
      Db: { Type: 'AWS::RDS::DBInstance', Properties: { Engine: 'mysql', DBName: { 'Fn::Join': ['-', [{ Ref: 'X' }, { Ref: 'Y' }]] }, BackupRetentionPeriod: 1 } },
    };
    const declared = { X: { Type: 'String' }, Y: { Type: 'String' } };
    // `Y` passed clean, so it is hashed: its move is a proven one.
    const classes = new Map([['X', 'secret' as const], ['Y', 'clean' as const]]);
    const created = await deploy({}, joined, { ...opts, parameters: { ...opts.parameters, Y: 'one' }, passedParameterClasses: classes }, declared);
    expect(created.thrown).toBeUndefined();
    expect(created.persisted?.maskedPropertyInputFingerprints?.['DBName']).toBeDefined();
    logSpies.warn.mockClear();
    const moved = await deploy({ Db: oldRecord(created.persisted!) }, joined, { ...opts, parameters: { ...opts.parameters, Y: 'two' }, passedParameterClasses: classes }, declared);
    expect((moved.diff?.get('Db')?.propertyChanges ?? []).map((pc) => pc.path)).toContain('DBName');
    expectRefusedOver(moved, 'DBName');
    expect(warnings()).toEqual([]);
  });

  it('an older record with no MAC and no KMS: never refused, warned on every deploy, never stamped', async () => {
    kms.fail = false;
    const opts = await masked();
    const created = await deploy({}, tpl, opts);
    let record = oldRecord(created.persisted!);
    logSpies.warn.mockClear();
    try {
      kms.fail = true;
      for (const round of [1, 2]) {
        const same = await deploy({ Db: structuredClone(record) }, tpl, opts);
        expect(same.thrown, `round ${round}`).toBeUndefined();
        expect(same.diff?.get('Db')?.changeType).toBe('NO_CHANGE');
        expect(same.calls).toEqual([]);
        expect(passedOf(same.persisted)).toBeUndefined();
        const warned = warnings();
        expect(warned).toHaveLength(1);
        expect(warned[0]).toMatch(/cannot be compared without the NoEcho value MAC key/);
        if (same.persisted !== undefined) record = same.persisted as never;
      }
    } finally {
      kms.fail = false;
    }
    expect(logged()).not.toContain(opts.parameters.X);
  });

  // #7050 review: a key SENT in a run with no KMS, its input fingerprint moved
  // too, has no member that describes what was sent. Carrying the old one
  // (bound to the old fingerprint) would read unusable on every deploy; the
  // save leaves none, and the next run with the MACs backfills it once.
  it('a key sent with no KMS after its input moved drops the stale member; the next KMS run backfills it once', async () => {
    kms.fail = false;
    const opts = await masked();
    const joined = (y: string) => ({
      Db: { Type: 'AWS::SSM::Parameter', Properties: { Type: 'String', Value: { 'Fn::Join': ['-', [{ Ref: 'X' }, { Ref: 'Y' }]] } } },
      _y: y,
    });
    const declared = { X: { Type: 'String' }, Y: { Type: 'String' } };
    const classes = new Map([['X', 'secret' as const], ['Y', 'clean' as const]]);
    const run = (resources: StackState['resources'], y: string) => {
      const { _y, ...tpl } = joined(y);
      return deploy(resources, tpl, { ...opts, parameters: { ...opts.parameters, Y: _y }, passedParameterClasses: classes }, declared);
    };
    const valueMember = (record: unknown) =>
      ((record as { noEchoValueMacs?: Record<string, Record<string, unknown>> } | undefined)?.noEchoValueMacs?.['Value'] ?? {})['cdkd:passed'] as
        | Member
        | undefined;
    const created = await run({}, 'one');
    expect(created.thrown).toBeUndefined();
    expect(valueMember(created.persisted)?.fingerprint).toBe(created.persisted?.maskedPropertyInputFingerprints?.['Value']);
    let sent: Run;
    try {
      kms.fail = true;
      sent = await run({ Db: structuredClone(created.persisted!) }, 'two');
    } finally {
      kms.fail = false;
    }
    expect(sent.thrown).toBeUndefined();
    expect(sent.calls).toEqual(['update:Db']);
    const moved = sent.persisted?.maskedPropertyInputFingerprints?.['Value'];
    expect(moved).toBeDefined();
    expect(moved).not.toBe(created.persisted?.maskedPropertyInputFingerprints?.['Value']);
    // No member bound to the old fingerprint is carried.
    expect(valueMember(sent.persisted)).toBeUndefined();
    logSpies.warn.mockClear();
    const backfilled = await run({ Db: structuredClone(sent.persisted!) }, 'two');
    expect(backfilled.thrown).toBeUndefined();
    expect(backfilled.diff?.get('Db')?.changeType).toBe('NO_CHANGE');
    expect(backfilled.calls).toEqual([]);
    expect(valueMember(backfilled.persisted)?.fingerprint).toBe(moved);
    const backfillWarnings = logSpies.warn.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.includes('Db') && line.includes('Value'));
    expect(backfillWarnings).toHaveLength(1);
    expect(backfillWarnings[0]).toMatch(/This deploy records one/);
    // From then on compared: a passed-secret value that moved is planned.
    const next = await deploy(
      { Db: structuredClone(backfilled.persisted!) },
      (({ _y, ...tpl }) => tpl)(joined('two')),
      { ...opts, parameters: { X: `moved-${opts.parameters.X}`, Y: 'two' }, passedParameterClasses: classes },
      declared
    );
    expect((next.diff?.get('Db')?.propertyChanges ?? []).map((pc) => pc.path)).toContain('Value');
    expect(next.calls).toEqual(['update:Db']);
    expect(logged()).not.toContain(opts.parameters.X);
  });

  it('a record whose MAC an update with no KMS rewrote keeps it: the next deploy compares it, never backfills', async () => {
    kms.fail = false;
    const opts = await masked();
    const created = await deploy({}, tpl, opts);
    const stamped = passedOf(created.persisted);
    expect(stamped).toBeDefined();
    const bumped = { Db: { ...tpl.Db, Properties: { ...tpl.Db.Properties, BackupRetentionPeriod: 7 } } };
    let updated: Run;
    try {
      kms.fail = true;
      updated = await deploy({ Db: structuredClone(created.persisted!) }, bumped, opts);
    } finally {
      kms.fail = false;
    }
    expect(updated.thrown).toBeUndefined();
    expect(updated.calls).toEqual(['update:Db']);
    expect(passedOf(updated.persisted)).toEqual(stamped);
    logSpies.warn.mockClear();
    const next = await deploy({ Db: structuredClone(updated.persisted!) }, bumped, opts);
    expect(next.diff?.get('Db')?.changeType).toBe('NO_CHANGE');
    expect(warnings()).toEqual([]);
  });

  // A member that exists but proves nothing (malformed, under another key, no
  // KMS this run) is never backfilled; nor is it a move: a move of a stateful
  // create-only key is refused, and only a send would stamp a new one.
  for (const [label, edit, pattern] of [
    ['a malformed MAC member', (r: Record<string, unknown>) => {
      (r['noEchoValueMacs'] as Record<string, Record<string, unknown>>)['DBName']!['cdkd:passed'] = { fingerprint: 'x', macs: 'y' };
    }, /unusable/],
    ['a MAC under another key', (r: Record<string, unknown>) => {
      const member = (r['noEchoValueMacs'] as Record<string, Record<string, { macs: Record<string, string> }>>)['DBName']!['cdkd:passed']!;
      member.macs['X'] = member.macs['X']!.replace(/key\/[0-9a-f-]+:/, 'key/99999999-0000-0000-0000-000000000000:');
    }, /unusable/],
    ['a dropped MAC member', (r: Record<string, unknown>) => {
      (r['noEchoValueMacs'] as Record<string, Record<string, unknown>>)['DBName']!['cdkd:passed'] = { fingerprint: 'cdkd:dropped' };
    }, /unusable/],
    ['no KMS this run', () => {
      kms.fail = true;
    }, /cannot be compared without the NoEcho value MAC key/],
  ] as const) {
    it(`${label}: never refused nor backfilled, warned on every deploy`, async () => {
      kms.fail = false;
      const opts = await masked();
      const created = await deploy({}, tpl, opts);
      const record = structuredClone(created.persisted!) as unknown as Record<string, unknown>;
      edit(record);
      const before = structuredClone(passedOf(record));
      logSpies.warn.mockClear();
      try {
        for (const round of [1, 2]) {
          const same = await deploy({ Db: structuredClone(record) as never }, tpl, opts);
          expect(same.thrown, `round ${round}`).toBeUndefined();
          expect(same.diff?.get('Db')?.changeType).toBe('NO_CHANGE');
          expect(same.calls).toEqual([]);
          if (same.persisted !== undefined) expect(passedOf(same.persisted)).toEqual(before);
          const warned = warnings();
          expect(warned).toHaveLength(1);
          expect(warned[0]).toMatch(pattern);
        }
      } finally {
        kms.fail = false;
      }
      expect(logged()).not.toContain(opts.parameters.X);
    });
  }
});

// #7050 review: the engine reads the same verdicts through
// `movedMaskedProperties`, with no plan beside it. No usable passed-secret MAC
// is unmoved only while the recorded input fingerprint equals today's.
describe('movedMaskedProperties: a passed-secret key with no usable MAC (#7050 review)', () => {
  const props = { Value: { Ref: 'P' } };
  const TEXT = maskedPropertyFingerprint(props.Value);
  const input = (half: string) => `inputs-sha256:${half}+${TEXT}`;
  const record = (recorded?: string) => ({
    properties: { Value: '***' },
    maskedPropertyFingerprints: { Value: TEXT },
    ...(recorded !== undefined && { maskedPropertyInputFingerprints: { Value: recorded } }),
  });
  const fingerprinter = (now: string | undefined, verdict: string) =>
    Object.assign(async () => now, { passedSecretVerdict: async () => verdict });

  for (const verdict of ['absent', 'unavailable', 'unusable'] as const) {
    it(`${verdict}: unmoved and reported with equal inputs, moved otherwise`, async () => {
      const reported: Array<[string, string]> = [];
      const onUnverified = (key: string, v: string) => void reported.push([key, v]);
      expect(await movedMaskedProperties(record(input('aa')), props, fingerprinter(input('aa'), verdict), undefined, onUnverified)).toEqual([]);
      expect(reported).toEqual([['Value', verdict]]);
      expect(await movedMaskedProperties(record(input('aa')), props, fingerprinter(input('bb'), verdict), undefined, onUnverified)).toEqual(['Value']);
      expect(await movedMaskedProperties(record(input('aa')), props, fingerprinter(undefined, verdict), undefined, onUnverified)).toEqual(['Value']);
      expect(reported).toHaveLength(1);
      // No input fingerprint recorded: unmoved, reported, and re-baselined to
      // today's (a move would be refused on every deploy of a stateful
      // create-only key, and only a send stamps); compared from then on.
      const rebaselined: Array<[string, string]> = [];
      const onRebaseline = (key: string, f: string) => void rebaselined.push([key, f]);
      expect(await movedMaskedProperties(record(), props, fingerprinter(input('aa'), verdict), onRebaseline, onUnverified)).toEqual([]);
      expect(rebaselined).toEqual([['Value', input('aa')]]);
      expect(reported).toEqual([['Value', verdict], ['Value', verdict]]);
      // With an input unknown today there is nothing to re-baseline to.
      expect(await movedMaskedProperties(record(), props, fingerprinter(undefined, verdict), onRebaseline, onUnverified)).toEqual(['Value']);
      expect(rebaselined).toHaveLength(1);
    });
  }
  it('changed: moved even with equal inputs', async () => {
    expect(await movedMaskedProperties(record(input('aa')), props, fingerprinter(input('aa'), 'changed'))).toEqual(['Value']);
  });
  // #7050 review: `'none'` (another input unproven) proves nothing either way:
  // a move only where the hashed inputs differ, never one on every deploy.
  it('none: unmoved and reported unless the hashed inputs differ; rebaselined when unrecorded', async () => {
    const reported: Array<[string, string]> = [];
    const rebaselined: Array<[string, string]> = [];
    const onUnverified = (key: string, v: string) => void reported.push([key, v]);
    const onRebaseline = (key: string, f: string) => void rebaselined.push([key, f]);
    const run = (recorded: string | undefined, now: string | undefined) =>
      movedMaskedProperties(record(recorded), props, fingerprinter(now, 'none'), onRebaseline, onUnverified);
    expect(await run(input('aa'), input('bb'))).toEqual(['Value']);
    expect(reported).toEqual([]);
    expect(await run(input('aa'), input('aa'))).toEqual([]);
    expect(await run(input('aa'), undefined)).toEqual([]);
    expect(await run(undefined, undefined)).toEqual([]);
    expect(rebaselined).toEqual([]);
    expect(await run(undefined, input('cc'))).toEqual([]);
    expect(rebaselined).toEqual([['Value', input('cc')]]);
    expect(reported).toEqual(Array.from({ length: 4 }, () => ['Value', 'none']));
  });
});
