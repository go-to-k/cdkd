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
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
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
  opts: Record<string, unknown> = { dryRun: false }
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
  await engine.deploy('s', { Parameters: { X: { Type: 'String' } }, Resources: templateResources } as never).catch((e: unknown) => {
    thrown = e;
  });
  const saved = saveState.mock.calls
    .flat()
    .filter(
      (a): a is StackState => typeof a === 'object' && a !== null && 'resources' in (a as object)
    );
  return { calls, persisted: saved[saved.length - 1]?.resources['Db'], thrown, diff: diffCalculator.last, sent };
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
    // walk, so only the moved arm is asserted for it: a value that really
    // moved is never hidden (#7050 final review).
    for (const passed of ['secret', 'clean'] as const) it(`${label} (passed as ${passed})`, async () => {
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
      if (passed === 'secret') return;
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
