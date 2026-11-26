/**
 * go-to-k/cdkd#7050 through the real DeployEngine, DiffCalculator and
 * resolver: each shape the parent review probed. Deployed, deployed again
 * unchanged (the plan must show NO_CHANGE: a masked leaf never reads as a
 * change), then deployed with another property changed in place (it must be
 * updated in place, never refused as a stateful replacement). Every saved
 * state is scanned whole for any secret's plaintext outside a reference.
 */
import { describe, it, expect, vi, afterEach } from 'vite-plus/test';
import { getLogger } from '../../../src/utils/logger.js';
import { renderChangeLines } from '../../../src/cli/commands/diff-recursive/render.js';

vi.mock('../../../src/utils/logger.js', () => {
  const fns = {
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => fns,
  };
  return { getLogger: () => fns };
});
vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sts: { send: vi.fn().mockResolvedValue({ Account: '123456789012' }) },
    secretsManager: {
      send: vi.fn().mockResolvedValue({ SecretString: JSON.stringify({ username: 'pg', other: 'x9', long: 'postgres' }), VersionId: 'a1b2c3d4-0000-4000-8000-000000000002' }),
      config: { region: () => Promise.resolve('us-east-1') },
    },
    ssm: {
      send: vi.fn(async () => ({
        Parameter: { Value: PUBLIC_SSM.value, Type: 'String', Version: PUBLIC_SSM.version },
      })),
      config: { region: () => Promise.resolve('us-east-1') },
    },
  }),
}));
vi.mock('@aws-sdk/client-cloudformation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-cloudformation')>();
  return {
    ...actual,
    CloudFormationClient: vi.fn(() => ({
      send: () => Promise.reject(new Error('DescribeType unavailable in this test')),
    })),
  };
});
vi.mock('@aws-sdk/client-secrets-manager', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  class FakeSecretsManagerClient {
    readonly config = { region: () => Promise.resolve('us-east-1') };
    constructor(_config?: unknown) {}
    async send(): Promise<unknown> {
      return { SecretString: JSON.stringify({ username: 'pg', other: 'x9', long: 'postgres' }), VersionId: 'a1b2c3d4-0000-4000-8000-000000000002' };
    }
    destroy(): void {}
  }
  return { ...actual, SecretsManagerClient: FakeSecretsManagerClient };
});
vi.mock('@aws-sdk/client-ssm', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  class FakeSSMClient {
    readonly config = { region: () => Promise.resolve('us-east-1') };
    constructor(_config?: unknown) {}
    async send(): Promise<unknown> {
      return {
        Parameter: { Value: PUBLIC_SSM.value, Type: 'String', Version: PUBLIC_SSM.version },
      };
    }
    destroy(): void {}
  }
  return { ...actual, SSMClient: FakeSSMClient };
});
vi.mock('p-limit', () => ({ default: vi.fn(() => <T>(fn: () => T) => fn()) }));

import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import type { ResourceChange, StackState } from '../../../src/types/state.js';

const READBACK: { dbName?: string } = {};
// The value a public `{{resolve:ssm:/pub}}` reads.
const PUBLIC_SSM = { value: 'pub-v1', version: 1 };
const USERNAME = '{{resolve:secretsmanager:db-secret:SecretString:username::}}';

interface Run {
  calls: string[];
  persisted: StackState['resources'][string] | undefined;
  thrown: unknown;
  diff: Map<string, ResourceChange> | undefined;
  sent?: Array<{ props: unknown; previous: unknown }>;
  all?: StackState['resources'];
}

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
  levels: string[][] = [['Db']]
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
      return { physicalId: id === 'Db' ? 'new' : 'arn:' + id.toLowerCase(), attributes: {} };
    }),
    update: vi.fn(async (id: string, _pid: string, _type: string, props: unknown, previous: unknown) => {
      calls.push('update:' + id);
      if (id === 'Db') sent.push({ props, previous });
      return { physicalId: resources[id]!.physicalId, attributes: {} };
    }),
    delete: vi.fn(async (id: string) => {
      calls.push('delete:' + id);
    }),
    getAttribute: vi.fn(),
    // What AWS reports back for `DBName` (`undefined`: nothing readable).
    readCurrentState: vi.fn(async () =>
      READBACK.dbName === undefined ? undefined : { DBName: READBACK.dbName }
    ),
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
      getExecutionLevels: vi.fn().mockReturnValue(levels),
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
    { dryRun: false },
    'us-east-1'
  );
  let thrown: unknown;
  await engine.deploy('s', { Parameters: { Suffix: { Type: 'String', Default: SUFFIX.v, ...(SUFFIX.noEcho === true && { NoEcho: true }) } }, Resources: templateResources } as never).catch((e: unknown) => {
    thrown = e;
  });
  const saved = saveState.mock.calls
    .flat()
    .filter(
      (a): a is StackState => typeof a === 'object' && a !== null && 'resources' in (a as object)
    );
  const all = saved[saved.length - 1]?.resources;
  return { calls, persisted: all?.['Db'], thrown, diff: diffCalculator.last, sent, all };
}

const OTHER = '{{resolve:secretsmanager:db-secret:SecretString:other::}}';
const LONG = '{{resolve:secretsmanager:db-secret:SecretString:long::}}';
const SUFFIX: { v: string; noEcho?: boolean } = { v: 'x9' };
const tpl = (
  dbName: unknown,
  backup: number,
  extra: Record<string, unknown> = {}
): Record<string, unknown> => ({
  Db: {
    Type: 'AWS::RDS::DBInstance',
    Properties: {
      Engine: 'mysql',
      MasterUsername: USERNAME,
      MasterUserPassword: OTHER,
      ...(dbName !== undefined && { DBName: dbName }),
      BackupRetentionPeriod: backup,
      ...extra,
    },
  },
});
const show = (label: string, r: Run): void => {
  const c = r.diff?.get('Db');
  // eslint-disable-next-line no-console
  console.log(
    `PROBE ${label}: persisted DBName=${JSON.stringify(r.persisted?.properties['DBName'])} calls=${JSON.stringify(r.calls)} thrown=${r.thrown === undefined ? 'none' : String((r.thrown as Error).message).slice(0, 300)} changeType=${c?.changeType} rows=${JSON.stringify((c?.propertyChanges ?? []).map((p) => [p.path, p.requiresReplacement, p.oldValue, p.newValue]))}`
  );
};

const SECRETS = ['pg', 'x9', 'postgres'];
function exposes(state: unknown): string | undefined {
  const text = JSON.stringify(state).split(/\{\{resolve:[^}]+\}\}/).join('\u0000');
  return SECRETS.find((secret) => text.includes(secret));
}

describe('a secret beside a value-bearing part never leaks or reads as a change (#7050)', () => {
  for (const [label, suffix, dbName] of [
    ['own text equal (Suffix pg)', 'pg', { 'Fn::Join': ['_', [USERNAME, { Ref: 'Suffix' }]] }],
    ['another secret equal (Suffix x9)', 'x9', { 'Fn::Join': ['_', [USERNAME, { Ref: 'Suffix' }]] }],
    ['another secret inside (Suffix ax9b)', 'ax9b', { 'Fn::Join': ['_', [USERNAME, { Ref: 'Suffix' }]] }],
    ['own text inside (Suffix apgb)', 'apgb', { 'Fn::Join': ['_', [USERNAME, { Ref: 'Suffix' }]] }],
    ['an Fn::Sub variable map', 'pg', { 'Fn::Sub': ['${U}_${Suffix}', { U: USERNAME }] }],
    ['a 4+ character secret equal (Suffix postgres)', 'postgres', { 'Fn::Join': ['_', [LONG, { Ref: 'Suffix' }]] }],
    ['an Fn::Select-lent reference beside its text', 'pg', { 'Fn::Join': ['', ['tt:', { 'Fn::Select': [0, [USERNAME]] }, { Ref: 'Suffix' }]] }],
    ['an Fn::Select-lent reference alone', 'zz', { 'Fn::Join': ['', ['tt:', { 'Fn::Select': [0, [USERNAME]] }]] }],
    ['a LIST leaf: Fn::Split over the secret beside the text (Suffix pg)', 'pg', { 'Fn::Split': [',', { 'Fn::Join': ['', [USERNAME, { Ref: 'Suffix' }]] }] }],
    ['a LIST leaf: Fn::Split over the secret inside the text (Suffix apgb)', 'apgb', { 'Fn::Split': [',', { 'Fn::Join': ['', [USERNAME, { Ref: 'Suffix' }]] }] }],
    ['a LIST leaf: Fn::Split by the delimiter, the public piece equal (Suffix pg)', 'pg', { 'Fn::Split': ['_', { 'Fn::Join': ['_', [USERNAME, { Ref: 'Suffix' }]] }] }],
  ] as const) {
    it(label, async () => {
      SUFFIX.v = suffix;
      const log = getLogger() as unknown as Record<string, ReturnType<typeof vi.fn>>;
      for (const level of ['debug', 'info', 'warn', 'error']) log[level]!.mockClear();
      const created = await deploy({}, tpl(dbName, 1));
      expect(created.thrown).toBeUndefined();
      expect(created.persisted).toBeDefined();
      expect(exposes(created.persisted)).toBeUndefined();
      const same = await deploy({ Db: structuredClone(created.persisted!) }, tpl(dbName, 1));
      expect(same.thrown).toBeUndefined();
      expect(same.diff?.get('Db')?.changeType).toBe('NO_CHANGE');
      expect(same.calls).toEqual([]);
      const next = await deploy({ Db: structuredClone(created.persisted!) }, tpl(dbName, 7));
      expect(next.thrown).toBeUndefined();
      expect((next.diff?.get('Db')?.propertyChanges ?? []).map((pc) => pc.path)).toEqual([
        'BackupRetentionPeriod',
      ]);
      expect(next.calls).toEqual(['update:Db']);
      // The update arm never hands the provider the mask, on either side.
      expect(JSON.stringify(next.sent)).not.toContain('***');
      expect(exposes(next.persisted)).toBeUndefined();
      // Nor does any line logged across the three deploys.
      const lines = ['debug', 'info', 'warn', 'error'].flatMap((level) => log[level]!.mock.calls);
      // A secret the public Suffix parameter itself spells is logged as that
      // parameter's value, which is public; every other secret must not be.
      // Matched as a whole word, so fixed log text ("upgrade") is not a hit;
      // the state scans above are by plain substring.
      const hidden = SECRETS.filter((secret) => !suffix.includes(secret));
      const spelled = (line: unknown): boolean =>
        hidden.some((secret) =>
          new RegExp(`(^|[^a-z0-9])${secret}([^a-z0-9]|$)`).test(
            JSON.stringify(line).split(/\{\{resolve:[^}]+\}\}/).join(' ')
          )
        );
      expect(lines.filter(spelled)).toEqual([]);
      // A REAL change behind the masked leaf still plans: the fingerprints
      // only hide a mask whose inputs did not move.
      if (JSON.stringify(dbName).includes('Suffix')) {
        SUFFIX.v = 'qq';
        const moved = await deploy({ Db: structuredClone(created.persisted!) }, tpl(dbName, 1));
        expect((moved.diff?.get('Db')?.propertyChanges ?? []).map((pc) => pc.path)).toContain('DBName');
        expect(JSON.stringify(moved.sent ?? [])).not.toContain('***');
        SUFFIX.v = suffix;
      }
      // Nor the diff display of either redeploy.
      const display: string[] = [];
      for (const plan of [same.diff, next.diff]) renderChangeLines(plan!, (line) => display.push(line));
      expect(display.length).toBeGreaterThan(0);
      expect(display.filter(spelled)).toEqual([]);
    });
  }
});

// #7050 review: a top-level key whose template spells a `{{resolve:...}}`
// beside a TAINTED input (a `Ref` to a resource whose properties hold a
// secret reference) is unprovable, and the plan's value holds the reference
// text unresolved, no `***`: it is still the redaction's blind spot, so it
// compares masked and warned of, never as an UPDATE (a replacement here).
describe('an unprovable redaction mask beside a tainted Ref reads unchanged (#7050 review)', () => {
  const OTHER_TOPIC = {
    Other: {
      Type: 'AWS::SNS::Topic',
      Properties: { DisplayName: { 'Fn::Join': ['', ['t-', OTHER]] } },
    },
  };
  for (const [label, dbName] of [
    ['Fn::Select-lent reference + Ref: Other', { 'Fn::Join': ['', ['tt:', { 'Fn::Select': [0, [USERNAME]] }, { Ref: 'Other' }]] }],
    ['Fn::Select-lent reference + Ref: Suffix + Ref: Other', { 'Fn::Join': ['', ['tt:', { 'Fn::Select': [0, [USERNAME]] }, { Ref: 'Suffix' }, { Ref: 'Other' }]] }],
  ] as const) {
    it(label, async () => {
      SUFFIX.v = 'pg';
      const log = getLogger() as unknown as Record<string, ReturnType<typeof vi.fn>>;
      const template = (backup: number): Record<string, unknown> => ({ ...OTHER_TOPIC, ...tpl(dbName, backup) });
      const levels = [['Other'], ['Db']];
      // The topic first (a Ref to a resource this same deploy creates does
      // not resolve under this harness's flat dependency mock).
      const topic = await deploy({}, OTHER_TOPIC, [['Other']]);
      expect(topic.thrown).toBeUndefined();
      expect(topic.all?.['Other']?.physicalId).toBe('arn:other');
      const created = await deploy(structuredClone(topic.all!), template(1), levels);
      expect(created.thrown).toBeUndefined();
      expect(created.persisted?.properties['DBName']).toBe('***');
      expect(exposes(created.all)).toBeUndefined();
      for (const level of ['debug', 'info', 'warn', 'error']) log[level]!.mockClear();
      const same = await deploy(structuredClone(created.all!), template(1), levels);
      show(label, same);
      expect(same.thrown).toBeUndefined();
      expect(same.diff?.get('Db')?.changeType).toBe('NO_CHANGE');
      expect(same.diff?.get('Db')?.propertyChanges ?? []).toEqual([]);
      expect(same.calls).toEqual([]);
      const warned = log['warn']!.mock.calls.map((c) => String(c[0]));
      expect(warned.filter((w) => w.includes('Db') && w.includes('DBName'))).toHaveLength(1);
      // A real change elsewhere is still planned, in place.
      const next = await deploy(structuredClone(created.all!), template(7), levels);
      expect(next.thrown).toBeUndefined();
      expect((next.diff?.get('Db')?.propertyChanges ?? []).map((pc) => pc.path)).toEqual([
        'BackupRetentionPeriod',
      ]);
      expect(next.calls).toEqual(['update:Db']);
      expect(JSON.stringify(next.sent)).not.toContain('***');
      SUFFIX.v = 'x9';
    });
  }
});

// #7050 review: a record leaf masked for a `NoEcho` parameter whose `NoEcho`
// is then removed (a STALE `NoEcho` leaf). Its input fingerprint proves
// nothing either way (it hashed the parameter as written), so the deploy's
// readback decides it: never re-baselined unsent (a later deploy would read a
// changed value unchanged for good), never refused forever on an unchanged
// value. Three deploys in a row, each from the record the previous one saved.
describe('a NoEcho leaf whose NoEcho is removed is decided by the readback (#7050 review)', () => {
  const dbName = { 'Fn::Join': ['_', [USERNAME, { Ref: 'Suffix' }]] };
  type Readback = 'none' | 'today' | 'old';
  for (const [older, changed, readback] of [
    [true, false, 'none'],
    [true, true, 'none'],
    [true, false, 'today'],
    [true, true, 'today'],
    [true, true, 'old'],
    [false, false, 'none'],
    [false, false, 'today'],
    [false, true, 'old'],
    [false, true, 'none'],
    [false, true, 'today'],
    [false, false, 'old'],
  ] as Array<[boolean, boolean, Readback]>) {
    const label = `${older ? 'an older record (no input fingerprint)' : 'a fingerprinted record'}, value ${changed ? 'changed' : 'unchanged'}, AWS reporting ${readback === 'none' ? 'nothing' : readback === 'today' ? "today's value" : 'the old value'}`;
    it(label, async () => {
      const log = getLogger() as unknown as Record<string, ReturnType<typeof vi.fn>>;
      SUFFIX.v = 'noecho-old-value';
      SUFFIX.noEcho = true;
      try {
        const created = await deploy({}, tpl(dbName, 1));
        expect(created.thrown).toBeUndefined();
        let record = structuredClone(created.persisted!) as unknown as Record<string, unknown>;
        expect((record['properties'] as Record<string, unknown>)['DBName']).toBe('***');
        if (older) delete record['maskedPropertyInputFingerprints'];
        SUFFIX.noEcho = false;
        if (changed) SUFFIX.v = 'noecho-new-value';
        READBACK.dbName =
          readback === 'none' ? undefined : `pg_${readback === 'today' ? SUFFIX.v : 'noecho-old-value'}`;
        for (const run of [1, 2, 3]) {
          log['warn']!.mockClear();
          const r = await deploy({ Db: record as never }, tpl(dbName, 1));
          const plan = r.diff?.get('Db');
          expect(r.calls).toEqual([]);
          if (r.persisted !== undefined) expect(exposes(r.persisted)).toBeUndefined();
          // An unchanged value read back as the old one is today's value too.
          if (readback === 'today' || (readback === 'old' && !changed)) {
            // AWS holds today's value: settled on #1, unmarked, then NO_CHANGE.
            expect(r.thrown).toBeUndefined();
            if (run === 1) {
              expect((plan?.propertyChanges ?? []).map((pc) => pc.path)).toEqual(['DBName']);
              expect(r.persisted?.properties['DBName']).toBe(`${USERNAME}_${SUFFIX.v}`);
              expect(r.persisted?.noEchoLeaves).toBeUndefined();
            } else {
              expect(plan?.changeType).toBe('NO_CHANGE');
            }
          } else {
            // Nothing confirms it (no readback, or another value from a
            // provider not known to report it exactly: never replaced on a
            // readback's word): planned on every deploy, and warned of, so
            // it is never hidden; no refusal of an unchanged value.
            expect(r.thrown).toBeUndefined();
            expect((plan?.propertyChanges ?? []).map((pc) => pc.path)).toEqual(['DBName']);
            const warned = log['warn']!.mock.calls.map((c) => String(c[0]));
            expect(
              warned.filter(
                (w) =>
                  w.includes('Db.DBName') &&
                  w.includes(readback === 'old' ? '(differs' : '(not-readable)') &&
                  w.includes('not applied')
              )
            ).toHaveLength(1);
            // ...and never re-baselined to the value it never sent.
            if (older) expect(r.persisted?.maskedPropertyInputFingerprints?.['DBName']).toBeUndefined();
          }
          if (r.persisted !== undefined) record = structuredClone(r.persisted) as unknown as Record<string, unknown>;
        }
      } finally {
        SUFFIX.v = 'x9';
        SUFFIX.noEcho = false;
        READBACK.dbName = undefined;
      }
    });
  }
});

// #7050 review (round 2): what the stale-leaf rule must NOT swallow. Only the
// input fingerprint's non-proof is dropped; a template edit, a moved public
// `ssm` value and an updatable key each keep their own path.
describe('a stale NoEcho leaf drops only its input-fingerprint non-proof (#7050 review)', () => {
  const joined = (delimiter: string, parts: unknown[] = [USERNAME, { Ref: 'Suffix' }]): unknown => ({
    'Fn::Join': [delimiter, parts],
  });
  /** Deploy with `Suffix` NoEcho, then drop its NoEcho: the record to start from. */
  async function staleRecord(template: Record<string, unknown>): Promise<Record<string, unknown>> {
    SUFFIX.v = 'noecho-old-value';
    SUFFIX.noEcho = true;
    const created = await deploy({}, template);
    expect(created.thrown).toBeUndefined();
    SUFFIX.noEcho = false;
    return structuredClone(created.persisted!) as unknown as Record<string, unknown>;
  }
  /** Every message on the thrown error's `cause` chain. */
  const refusal = (thrown: unknown): string => {
    const messages: string[] = [];
    for (let e = thrown as { message?: unknown; cause?: unknown } | undefined; e; e = e.cause as never)
      messages.push(String(e.message));
    return messages.join(' | ');
  };
  afterEach(() => {
    SUFFIX.v = 'x9';
    SUFFIX.noEcho = false;
    READBACK.dbName = undefined;
    PUBLIC_SSM.value = 'pub-v1';
    PUBLIC_SSM.version = 1;
  });

  it('an UPDATABLE key holding a stale leaf is sent once, then settles', async () => {
    const template = tpl(undefined, 1, { PreferredMaintenanceWindow: joined('_') });
    const record = await staleRecord(template);
    expect((record['properties'] as Record<string, unknown>)['PreferredMaintenanceWindow']).toBe('***');
    SUFFIX.v = 'noecho-new-value';
    const first = await deploy({ Db: record as never }, template);
    expect(first.thrown).toBeUndefined();
    expect((first.diff?.get('Db')?.propertyChanges ?? []).map((pc) => pc.path)).toEqual([
      'PreferredMaintenanceWindow',
    ]);
    expect(first.calls).toEqual(['update:Db']);
    const sent = first.sent![0]!.props as Record<string, unknown>;
    expect(sent['PreferredMaintenanceWindow']).toBe('pg_noecho-new-value');
    expect(exposes(first.persisted)).toBeUndefined();
    const second = await deploy({ Db: structuredClone(first.persisted!) }, template);
    expect(second.thrown).toBeUndefined();
    expect(second.diff?.get('Db')?.changeType).toBe('NO_CHANGE');
    expect(second.calls).toEqual([]);
  });

  it('a TEXT change on a create-only stateful key beside a stale leaf is refused, as on base', async () => {
    const record = await staleRecord(tpl(joined('_'), 1));
    // AWS reports the old value: without the text change this would warn
    // "not applied"; the template edit itself must still read as a change.
    READBACK.dbName = 'pg_noecho-old-value';
    const edited = await deploy({ Db: record as never }, tpl(joined('-'), 1));
    expect((edited.diff?.get('Db')?.propertyChanges ?? []).map((pc) => pc.path)).toEqual(['DBName']);
    expect(edited.calls).toEqual([]);
    expect(refusal(edited.thrown)).toMatch(/force-stateful-recreation/);
  });

  it('a stale leaf beside a masked leaf whose public ssm value moved is planned and refused, never skipped', async () => {
    const dbName = joined('_', [USERNAME, '{{resolve:ssm:/pub}}', { Ref: 'Suffix' }]);
    const record = await staleRecord(tpl(dbName, 1));
    expect((record['properties'] as Record<string, unknown>)['DBName']).toBe('***');
    // AWS reports the old value; the public value moved in this deploy.
    READBACK.dbName = 'pg_pub-v1_noecho-old-value';
    PUBLIC_SSM.value = 'pub-v2';
    PUBLIC_SSM.version = 2;
    const moved = await deploy({ Db: record as never }, tpl(dbName, 1));
    expect((moved.diff?.get('Db')?.propertyChanges ?? []).map((pc) => pc.path)).toEqual(['DBName']);
    expect(moved.calls).toEqual([]);
    expect(refusal(moved.thrown)).toMatch(/force-stateful-recreation/);
  });
});
