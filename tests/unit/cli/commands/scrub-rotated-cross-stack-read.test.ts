import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

/**
 * `cdkd scrub --fail` must not report a stack clean when a stored cross-stack
 * read NAME still holds a secret's value from before a ROTATION (issue
 * [#3382](https://github.com/go-to-k/cdkd/issues/3382)).
 *
 * The repair walk (go-to-k/cdkd#3337) cannot rewrite such a name: scrub's
 * needles are the secret's CURRENT value. So the verdict is taken from today's
 * template: a stored entry that no read this run performed reproduces, and
 * whose name fits the shape of a secret-bearing read of the same producer, is a
 * finding. The false-positive shape the issue names — an ORDINARY import from
 * the same producer as a secret-bearing one — must stay green, and the control
 * below gives it a name that FITS the secret-bearing shape, so only the
 * "reproduced by this run" conjunct keeps it green.
 *
 * Real resolver, fake leaf SDK clients (the choice
 * `scrub-cross-stack-read-repair.test.ts` makes): the subject is which reads the
 * resolver actually performs and records.
 */

interface FakeClientConfig {
  region?: string;
}

interface FakeSend {
  ctorRegion: string | undefined;
  command: string;
  input: unknown;
}

const { secretResponses, secretSends, makeFakeClientClass } = vi.hoisted(() => {
  const secretResponses = new Map<string, unknown>();
  const makeFakeClientClass = (sends: FakeSend[], serviceLabel: string): unknown =>
    class {
      readonly ctorConfig: FakeClientConfig;
      constructor(ctorConfig: FakeClientConfig = {}) {
        this.ctorConfig = ctorConfig;
      }
      async send(command: { input?: unknown; constructor: { name: string } }): Promise<unknown> {
        const name = command.constructor.name;
        sends.push({ ctorRegion: this.ctorConfig.region, command: name, input: command.input });
        const response = secretResponses.get(`${serviceLabel}|${name}`);
        if (response === undefined) {
          throw new Error(`no ${serviceLabel} response primed for ${name}`);
        }
        if (response instanceof Error) throw response;
        return response;
      }
      destroy(): void {}
    };
  return { secretResponses, secretSends: [] as FakeSend[], makeFakeClientClass };
});

vi.mock('@aws-sdk/client-ssm', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return { ...actual, SSMClient: makeFakeClientClass([], 'ssm') };
});
vi.mock('@aws-sdk/client-secrets-manager', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return { ...actual, SecretsManagerClient: makeFakeClientClass(secretSends, 'secretsmanager') };
});
vi.mock('@aws-sdk/client-cloudformation', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return { ...actual, CloudFormationClient: makeFakeClientClass([], 'cloudformation') };
});
vi.mock('@aws-sdk/client-sts', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return { ...actual, STSClient: makeFakeClientClass([], 'sts') };
});

const logLines: string[] = [];
vi.mock('../../../../src/utils/logger.js', () => {
  const push =
    (level: string) =>
    (...args: unknown[]): void =>
      void logLines.push(`${level} ${args.map(String).join(' ')}`);
  const fake = {
    debug: push('debug'),
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    setLevel: (): void => {},
    child: (): unknown => fake,
  };
  return { getLogger: () => fake };
});

// --- scrubCommand seams: everything but the resolver and scrub itself -------
const synthStacks = vi.hoisted(() => [] as unknown[]);
const backendHolder = vi.hoisted(() => ({ backend: undefined as unknown }));
vi.mock('../../../../src/synthesis/synthesizer.js', () => ({
  Synthesizer: vi.fn().mockImplementation(() => ({
    synthesize: vi.fn().mockImplementation(() => Promise.resolve({ stacks: synthStacks })),
    expandMacrosForStacks: vi.fn().mockResolvedValue(undefined),
  })),
  synthesisStatusMessage: () => 'synthesizing',
}));
vi.mock('../../../../src/cli/config-loader.js', () => ({
  resolveApp: () => 'node app.js',
  resolveStateBucketWithDefault: () => Promise.resolve('cdkd-state-bucket'),
}));
vi.mock('../../../../src/utils/role-arn.js', () => ({ applyRoleArnIfSet: vi.fn() }));
vi.mock('../../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn().mockImplementation(() => backendHolder.backend),
}));
vi.mock('../../../../src/state/export-index-store.js', () => ({
  // No exports index object in the region: the index step contributes nothing.
  ExportIndexStore: vi.fn().mockImplementation(() => ({
    readPersistedEntries: vi.fn().mockResolvedValue(undefined),
    patchEntry: vi.fn().mockResolvedValue(true),
  })),
}));
vi.mock('../../../../src/state/lock-manager.js', () => ({
  LockManager: vi.fn().mockImplementation(() => ({
    acquireLockWithRetry: vi.fn().mockResolvedValue(undefined),
    releaseLock: vi.fn().mockResolvedValue(undefined),
  })),
}));

import { AwsClients, setAwsClients, resetAwsClients } from '../../../../src/utils/aws-clients.js';
import { resetAccountInfoCache } from '../../../../src/deployment/intrinsic-function-resolver.js';
import { clearRecordedSecretExpressions } from '../../../../src/deployment/secret-redaction.js';
import {
  scrubStack,
  scrubCommand,
  findUnrepairedCrossStackReadNames,
  type ScrubOptions,
} from '../../../../src/cli/commands/scrub.js';
import type { StackState } from '../../../../src/types/state.js';
import type { CloudFormationTemplate } from '../../../../src/types/resource.js';

const REGION = 'us-east-1';
const CONSUMER = 'Consumer';
const PRODUCER = 'Producer';
const SECRET_EXPR = '{{resolve:secretsmanager:prod/db:SecretString:password}}';
/** The secret's CURRENT value — the only one this run learns. */
const LIVE = 'live-db-password-3382';
/** The value the secret held before it was rotated. */
const OLD = 'old-db-password-3382';

const secretImport = { 'Fn::ImportValue': { 'Fn::Join': ['', ['e-', SECRET_EXPR, '-x']] } };
const liveExportName = `e-${LIVE}-x`;
const redactedExportName = `e-${SECRET_EXPR}-x`;

let consumerState: StackState;
let producerOutputs: Record<string, unknown>;
let stateBackend: {
  getState: ReturnType<typeof vi.fn>;
  saveState: ReturnType<typeof vi.fn>;
  listStacks: ReturnType<typeof vi.fn>;
};
const lockManager = {
  acquireLockWithRetry: vi.fn().mockResolvedValue(undefined),
  releaseLock: vi.fn().mockResolvedValue(undefined),
};
let savedRegion: string | undefined;

function makeConsumerState(extra: Partial<StackState>): StackState {
  return {
    version: 10,
    region: REGION,
    stackName: CONSUMER,
    resources: {
      Db: {
        physicalId: 'db-1',
        resourceType: 'AWS::RDS::DBInstance',
        properties: { DBSubnetGroupName: 'subnet-group-1', Port: 'port-1' },
      },
    },
    outputs: {},
    lastModified: 0,
    ...extra,
  };
}

function consumerStackInfo(properties: Record<string, unknown>): {
  stackName: string;
  dependencyNames: string[];
  template: CloudFormationTemplate;
} {
  return {
    stackName: CONSUMER,
    dependencyNames: [],
    template: {
      Resources: { Db: { Type: 'AWS::RDS::DBInstance', Properties: properties } },
    } as CloudFormationTemplate,
  };
}

beforeEach(() => {
  savedRegion = process.env['AWS_REGION'];
  process.env['AWS_REGION'] = REGION;
  secretResponses.clear();
  secretSends.length = 0;
  logLines.length = 0;
  synthStacks.length = 0;
  resetAccountInfoCache();
  clearRecordedSecretExpressions();
  setAwsClients(new AwsClients({ region: REGION }));
  secretResponses.set('secretsmanager|GetSecretValueCommand', {
    SecretString: JSON.stringify({ password: LIVE }),
  });
  producerOutputs = { [liveExportName]: 'subnet-group-1' };
  stateBackend = {
    getState: vi.fn().mockImplementation((stackName: string) => {
      if (stackName !== CONSUMER) {
        return Promise.resolve({
          state: {
            version: 8,
            region: REGION,
            stackName,
            resources: {},
            outputs: producerOutputs,
            lastModified: 0,
          },
          etag: 'p-1',
        });
      }
      return Promise.resolve({ state: consumerState, etag: 'c-1' });
    }),
    saveState: vi.fn().mockResolvedValue('etag-2'),
    listStacks: vi.fn().mockResolvedValue([{ stackName: PRODUCER, region: REGION }]),
  };
  backendHolder.backend = stateBackend;
});

afterEach(() => {
  resetAwsClients();
  clearRecordedSecretExpressions();
  if (savedRegion === undefined) delete process.env['AWS_REGION'];
  else process.env['AWS_REGION'] = savedRegion;
});

async function scrub(
  properties: Record<string, unknown>
): Promise<{ recordsChanged: number; unrepairedReadNames: number }> {
  return await scrubStack(
    consumerStackInfo(properties) as never,
    REGION,
    stateBackend as never,
    lockManager as never,
    { dryRun: false, logger: { debug() {}, info() {}, warn: (m: string) => logLines.push(`warn ${m}`), error() {} } as never }
  );
}

describe('cdkd scrub reports a ROTATED cross-stack read name (issue #3382)', () => {
  it('flags a stored imports[].exportName holding the secret value from before a rotation', async () => {
    consumerState = makeConsumerState({
      imports: [{ sourceStack: PRODUCER, sourceRegion: REGION, exportName: `e-${OLD}-x` }],
    });

    const res = await scrub({ DBSubnetGroupName: secretImport });

    // The read really happened and recorded the CURRENT secret: without it the
    // case would pass for want of a secret-bearing read, not by the verdict.
    expect(secretSends.map((s) => s.command)).toEqual(['GetSecretValueCommand']);
    // Nothing is rewritten — the value is one this run never learned.
    expect(res.recordsChanged).toBe(0);
    expect(res.unrepairedReadNames).toBe(1);
    const warned = logLines.filter((l) => l.startsWith('warn')).join('\n');
    expect(warned).toContain('state.imports[0]');
    expect(warned).toContain('ROTATED');
    // The stored name is never printed: no needle this run holds can mask it.
    expect(logLines.join('\n')).not.toContain(OLD);
  });

  it('flags the stale entry beside its redacted twin, and only the stale one', async () => {
    consumerState = makeConsumerState({
      imports: [
        { sourceStack: PRODUCER, sourceRegion: REGION, exportName: redactedExportName },
        { sourceStack: PRODUCER, sourceRegion: REGION, exportName: `e-${OLD}-x` },
      ],
    });

    const res = await scrub({ DBSubnetGroupName: secretImport });

    expect(res.unrepairedReadNames).toBe(1);
    expect(logLines.join('\n')).toContain('state.imports[1]');
    expect(logLines.join('\n')).not.toContain('state.imports[0]');
  });

  /**
   * THE FALSE-POSITIVE SHAPE the issue measured against the sibling-coordinate
   * detector: an ordinary import from the producer that also publishes a
   * secret-bearing one. `Producer:BucketName` FITS the secret-bearing read's
   * shape (`Producer:<token>`), so only "this run reproduced it" keeps it green.
   */
  it('keeps an ordinary import from the same producer green, even when it fits the secret-bearing shape', async () => {
    producerOutputs = { [`Producer:${LIVE}`]: 'subnet-group-1', 'Producer:BucketName': 'port-1' };
    consumerState = makeConsumerState({
      imports: [
        { sourceStack: PRODUCER, sourceRegion: REGION, exportName: `Producer:${SECRET_EXPR}` },
        { sourceStack: PRODUCER, sourceRegion: REGION, exportName: 'Producer:BucketName' },
      ],
    });

    const res = await scrub({
      DBSubnetGroupName: { 'Fn::ImportValue': { 'Fn::Join': ['', ['Producer:', SECRET_EXPR]] } },
      Port: { 'Fn::ImportValue': 'Producer:BucketName' },
    });

    expect(res.unrepairedReadNames).toBe(0);
    expect(logLines.join('\n')).not.toContain('ROTATED');
  });

  it('does not flag an entry holding the CURRENT value — the repair walk rewrites it', async () => {
    consumerState = makeConsumerState({
      imports: [{ sourceStack: PRODUCER, sourceRegion: REGION, exportName: liveExportName }],
    });

    const res = await scrub({ DBSubnetGroupName: secretImport });

    expect(res.recordsChanged).toBe(1);
    expect(res.unrepairedReadNames).toBe(0);
    const saved = stateBackend.saveState.mock.calls[0]![2] as StackState;
    expect(saved.imports).toEqual([
      { sourceStack: PRODUCER, sourceRegion: REGION, exportName: redactedExportName },
    ]);
  });

  it('does not flag a stale entry from a DIFFERENT producer', async () => {
    consumerState = makeConsumerState({
      imports: [{ sourceStack: 'Other', sourceRegion: REGION, exportName: `e-${OLD}-x` }],
    });

    const res = await scrub({ DBSubnetGroupName: secretImport });

    expect(res.unrepairedReadNames).toBe(0);
  });

  /**
   * A condition-suppressed output published nothing, so the deploy may never
   * have performed its read: it must not be the secret-bearing read a stored
   * entry is flagged against.
   */
  it('does not flag against a read in a condition-suppressed output', async () => {
    consumerState = makeConsumerState({
      imports: [{ sourceStack: PRODUCER, sourceRegion: REGION, exportName: `e-${OLD}-x` }],
    });
    const info = consumerStackInfo({ DBSubnetGroupName: 'subnet-group-1' });
    info.template.Conditions = { Off: { 'Fn::Equals': ['a', 'b'] } };
    info.template.Outputs = { Suppressed: { Condition: 'Off', Value: secretImport } };

    const res = await scrubStack(info as never, REGION, stateBackend as never, lockManager as never, {
      dryRun: false,
      logger: { debug() {}, info() {}, warn() {}, error() {} } as never,
    });

    // The read DID run (the needle is recorded), so a zero here is the
    // position rule, not a read that never happened.
    expect(secretSends.map((s) => s.command)).toContain('GetSecretValueCommand');
    expect(res.unrepairedReadNames).toBe(0);
  });

  /**
   * The deploy RECORDS a cross-stack read made while evaluating a condition,
   * and scrub's pre-pass does not walk conditions. Unless the condition pass's
   * reads count as reproducing, an ordinary import read only there is flagged
   * on every run and no deploy clears it.
   */
  it('keeps an ordinary import read only by a CONDITION green', async () => {
    producerOutputs = { [`Producer:${LIVE}`]: 'subnet-group-1', 'Producer:Flag': 'yes' };
    consumerState = makeConsumerState({
      imports: [
        { sourceStack: PRODUCER, sourceRegion: REGION, exportName: `Producer:${SECRET_EXPR}` },
        { sourceStack: PRODUCER, sourceRegion: REGION, exportName: 'Producer:Flag' },
      ],
    });
    const info = consumerStackInfo({
      DBSubnetGroupName: { 'Fn::ImportValue': { 'Fn::Join': ['', ['Producer:', SECRET_EXPR]] } },
    });
    info.template.Conditions = {
      On: { 'Fn::Equals': [{ 'Fn::ImportValue': 'Producer:Flag' }, 'yes'] },
    };

    const res = await scrubStack(info as never, REGION, stateBackend as never, lockManager as never, {
      dryRun: false,
      logger: { debug() {}, info() {}, warn() {}, error() {} } as never,
    });

    expect(res.unrepairedReadNames).toBe(0);
  });

  it('never flags against a secret-bearing read that sits only inside a CONDITION', async () => {
    producerOutputs = { [liveExportName]: 'yes' };
    consumerState = makeConsumerState({
      imports: [{ sourceStack: PRODUCER, sourceRegion: REGION, exportName: `e-${OLD}-x` }],
    });
    const info = consumerStackInfo({ DBSubnetGroupName: 'subnet-group-1' });
    info.template.Conditions = { On: { 'Fn::Equals': [secretImport, 'yes'] } };

    const res = await scrubStack(info as never, REGION, stateBackend as never, lockManager as never, {
      dryRun: false,
      logger: { debug() {}, info() {}, warn() {}, error() {} } as never,
    });

    // The condition's read DID run: the zero is the position rule.
    expect(secretSends.map((s) => s.command)).toContain('GetSecretValueCommand');
    expect(res.unrepairedReadNames).toBe(0);
  });

  /**
   * A name built from TWO secrets, one of them rotated: the walk repairs the
   * current one, so the stored field carries a token AND the old value.
   */
  it('flags a two-secret name whose OTHER secret rotated, after the walk repairs the current one', async () => {
    const secondExpr = '{{resolve:secretsmanager:prod/api:SecretString:key}}';
    secretResponses.set('secretsmanager|GetSecretValueCommand', {
      SecretString: JSON.stringify({ password: LIVE, key: 'live-api-key-3382' }),
    });
    producerOutputs = { [`e-${LIVE}-live-api-key-3382`]: 'subnet-group-1' };
    consumerState = makeConsumerState({
      imports: [
        { sourceStack: PRODUCER, sourceRegion: REGION, exportName: `e-${LIVE}-${OLD}` },
      ],
    });

    const res = await scrub({
      DBSubnetGroupName: {
        'Fn::ImportValue': { 'Fn::Join': ['', ['e-', SECRET_EXPR, '-', secondExpr]] },
      },
    });

    // The current half IS repaired...
    const saved = stateBackend.saveState.mock.calls[0]![2] as StackState;
    expect(saved.imports![0]!.exportName).toBe(`e-${SECRET_EXPR}-${OLD}`);
    // ...and the old half is still reported, not called clean.
    expect(res.unrepairedReadNames).toBe(1);
    expect(logLines.join('\n')).not.toContain(OLD);
  });

  /**
   * `outputReads[].sourceStack` is template-derived, so it can be the field
   * holding the old value; the warning must leave it out.
   */
  it('flags an outputReads[].sourceStack holding the pre-rotation value, without printing it', async () => {
    producerOutputs = { Db: 'subnet-group-1' };
    consumerState = makeConsumerState({
      outputReads: [{ sourceStack: `p-${OLD}`, sourceRegion: REGION, outputName: 'Db' }],
    });

    const res = await scrub({
      DBSubnetGroupName: {
        'Fn::GetStackOutput': {
          StackName: { 'Fn::Join': ['', ['p-', SECRET_EXPR]] },
          OutputName: 'Db',
        },
      },
    });

    expect(res.unrepairedReadNames).toBe(1);
    const all = logLines.join('\n');
    expect(all).toContain('state.outputReads[0]');
    expect(all).not.toContain(OLD);
  });

  it('flags a stored outputReads[].outputName holding the pre-rotation value', async () => {
    producerOutputs = { [`out-${LIVE}`]: 'subnet-group-1' };
    consumerState = makeConsumerState({
      outputReads: [{ sourceStack: PRODUCER, sourceRegion: REGION, outputName: `out-${OLD}` }],
    });

    const res = await scrub({
      DBSubnetGroupName: {
        'Fn::GetStackOutput': {
          StackName: PRODUCER,
          OutputName: { 'Fn::Join': ['', ['out-', SECRET_EXPR]] },
        },
      },
    });

    expect(res.recordsChanged).toBe(0);
    expect(res.unrepairedReadNames).toBe(1);
    const all = logLines.join('\n');
    expect(all).toContain('state.outputReads[0]');
    expect(all).not.toContain(OLD);
  });
});

describe('findUnrepairedCrossStackReadNames — each conjunct (issue #3382)', () => {
  const identity = (s: string): string => s.split(LIVE).join(SECRET_EXPR);
  const performedImport = (exportName: string, canRefuse = true) => ({
    imports: [{ entry: { sourceStack: PRODUCER, sourceRegion: REGION, exportName }, canRefuse }],
    outputReads: [],
  });
  const stored = (exportName: string, sourceRegion = REGION) => ({
    imports: [{ sourceStack: PRODUCER, sourceRegion, exportName }],
  });

  it('flags the rotated shape', () => {
    expect(
      findUnrepairedCrossStackReadNames(stored(`e-${OLD}-x`), performedImport(liveExportName), identity)
    ).toHaveLength(1);
  });

  it('matches the region canonically and refuses a different one', () => {
    expect(
      findUnrepairedCrossStackReadNames(
        stored(`e-${OLD}-x`, 'US-EAST-1'),
        performedImport(liveExportName),
        identity
      )
    ).toHaveLength(1);
    expect(
      findUnrepairedCrossStackReadNames(
        stored(`e-${OLD}-x`, 'eu-west-1'),
        performedImport(liveExportName),
        identity
      )
    ).toHaveLength(0);
  });

  it('never flags against a read from a position that cannot refuse', () => {
    expect(
      findUnrepairedCrossStackReadNames(
        stored(`e-${OLD}-x`),
        performedImport(liveExportName, false),
        identity
      )
    ).toHaveLength(0);
  });

  it('does not flag a name that does not fit the shape', () => {
    for (const name of ['Producer:OldBucket', 'e--x', `f-${OLD}-x`, `e-${OLD}-y`]) {
      expect(
        findUnrepairedCrossStackReadNames(stored(name), performedImport(liveExportName), identity),
        name
      ).toHaveLength(0);
    }
  });

  it('does not flag a stored name that already carries a reference', () => {
    expect(
      findUnrepairedCrossStackReadNames(
        stored(`e-{{resolve:ssm:/other}}-x`),
        performedImport(liveExportName),
        identity
      )
    ).toHaveLength(0);
  });

  it('does not flag against a read whose name carries no secret', () => {
    expect(
      findUnrepairedCrossStackReadNames(stored(`e-${OLD}-x`), performedImport('e-plain-x'), identity)
    ).toHaveLength(0);
  });

  it('outputReads: a token-free field must be EQUAL, and one field must be a wildcard fit', () => {
    const performed = {
      imports: [],
      outputReads: [
        {
          entry: { sourceStack: PRODUCER, sourceRegion: REGION, outputName: `out-${LIVE}` },
          canRefuse: true,
        },
      ],
    };
    const storedRead = (sourceStack: string, outputName: string) => ({
      outputReads: [{ sourceStack, sourceRegion: REGION, outputName }],
    });
    expect(
      findUnrepairedCrossStackReadNames(storedRead(PRODUCER, `out-${OLD}`), performed, identity)
    ).toHaveLength(1);
    expect(
      findUnrepairedCrossStackReadNames(storedRead('Elsewhere', `out-${OLD}`), performed, identity)
    ).toHaveLength(0);
  });

  it('outputReads: a field already repaired to today\'s spelling counts as equal, not as a mismatch', () => {
    const performed = {
      imports: [],
      outputReads: [
        {
          entry: { sourceStack: `p-${LIVE}`, sourceRegion: REGION, outputName: `out-${LIVE}` },
          canRefuse: true,
        },
      ],
    };
    expect(
      findUnrepairedCrossStackReadNames(
        {
          outputReads: [
            { sourceStack: `p-${SECRET_EXPR}`, sourceRegion: REGION, outputName: `out-${OLD}` },
          ],
        },
        performed,
        identity
      )
    ).toHaveLength(1);
  });

  it('outputReads: a field holding a DIFFERENT whole token is a different reference, not a fit', () => {
    const performed = {
      imports: [],
      outputReads: [
        {
          entry: { sourceStack: `p-${LIVE}`, sourceRegion: REGION, outputName: `out-${LIVE}` },
          canRefuse: true,
        },
      ],
    };
    expect(
      findUnrepairedCrossStackReadNames(
        {
          outputReads: [
            {
              sourceStack: 'p-{{resolve:ssm:/other}}',
              sourceRegion: REGION,
              outputName: `out-${OLD}`,
            },
          ],
        },
        performed,
        identity
      )
    ).toHaveLength(0);
  });

  /**
   * A name made only of today's literal parts and WHOLE tokens holds no text,
   * even when a token contains the literal separator: the greedy split would
   * otherwise cut through it and read half a token as text.
   */
  it('does not read half of a hyphenated token as text in a two-token name', () => {
    const second = 'live-api-key-3382';
    const performed = {
      imports: [
        {
          entry: {
            sourceStack: PRODUCER,
            sourceRegion: REGION,
            exportName: `e-${LIVE}-${second}`,
          },
          canRefuse: true,
        },
      ],
      outputReads: [],
    };
    const redact = (s: string): string =>
      s
        .split(LIVE)
        .join(SECRET_EXPR)
        .split(second)
        .join('{{resolve:secretsmanager:prod-api:SecretString:key}}');
    expect(
      findUnrepairedCrossStackReadNames(
        stored(`e-${SECRET_EXPR}-{{resolve:secretsmanager:old-api-name:SecretString:key}}`),
        performed,
        redact
      )
    ).toHaveLength(0);
  });

  it('outputReads: an ordinary read this run reproduced stays green though it fits the shape', () => {
    const performed = {
      imports: [],
      outputReads: [
        {
          entry: { sourceStack: PRODUCER, sourceRegion: REGION, outputName: `out-${LIVE}` },
          canRefuse: true,
        },
        {
          entry: { sourceStack: PRODUCER, sourceRegion: REGION, outputName: 'out-bucket' },
          canRefuse: true,
        },
      ],
    };
    expect(
      findUnrepairedCrossStackReadNames(
        { outputReads: [{ sourceStack: PRODUCER, sourceRegion: REGION, outputName: 'out-bucket' }] },
        performed,
        identity
      )
    ).toHaveLength(0);
  });
});

describe('cdkd scrub --fail over a ROTATED cross-stack read name (issue #3382)', () => {
  function commandOptions(overrides: Partial<ScrubOptions> = {}): ScrubOptions {
    return { output: 'cdk.out', statePrefix: 'cdkd', verbose: false, all: true, ...overrides };
  }

  it('a real run with --fail exits 1 when the rotated name is the ONLY leak', async () => {
    synthStacks.push(consumerStackInfo({ DBSubnetGroupName: secretImport }));
    consumerState = makeConsumerState({
      imports: [{ sourceStack: PRODUCER, sourceRegion: REGION, exportName: `e-${OLD}-x` }],
    });

    const err = await scrubCommand([], commandOptions({ fail: true })).catch((e: unknown) => e);

    expect((err as { code?: string } | undefined)?.code).toBe('SCRUB_NEEDED');
    const info = logLines.filter((l) => l.startsWith('info')).join('\n');
    expect(info).not.toContain('No plaintext secrets found');
    expect(info).toContain('could NOT repair');
    expect(stateBackend.saveState).not.toHaveBeenCalled();
    expect(logLines.join('\n')).not.toContain(OLD);
    // The per-stack count line, not only the run-level note.
    const warn = logLines.filter((l) => l.startsWith('warn')).join('\n');
    expect(warn).toContain(`cross-stack read name(s) in ${CONSUMER}`);
  });

  /**
   * A repairable leak BESIDE the rotated name lands on the OTHER two summary
   * arms (`Done: scrubbed` / `Plan: N stack(s) hold plaintext`), which must
   * carry the note too.
   */
  it.each([false, true])(
    'carries the note on the summary when a repairable leak is also present (dryRun=%s)',
    async (dryRun) => {
      synthStacks.push(
        consumerStackInfo({ DBSubnetGroupName: secretImport, Port: SECRET_EXPR })
      );
      consumerState = makeConsumerState({
        resources: {
          Db: {
            physicalId: 'db-1',
            resourceType: 'AWS::RDS::DBInstance',
            properties: { DBSubnetGroupName: 'subnet-group-1', Port: LIVE },
          },
        },
        imports: [{ sourceStack: PRODUCER, sourceRegion: REGION, exportName: `e-${OLD}-x` }],
      });

      const err = await scrubCommand([], commandOptions({ dryRun, fail: true })).catch(
        (e: unknown) => e
      );

      expect((err as { code?: string } | undefined)?.code).toBe('SCRUB_NEEDED');
      const info = logLines.filter((l) => l.startsWith('info')).join('\n');
      // The OTHER arm was reached -- otherwise this repeats the cases above.
      expect(info).toMatch(dryRun ? /Plan: 1 stack\(s\) hold plaintext/ : /Done: scrubbed 1/);
      expect(info).toContain('could NOT repair');
      expect(logLines.join('\n')).not.toContain(OLD);
    }
  );

  it('--dry-run --fail exits 1 too', async () => {
    synthStacks.push(consumerStackInfo({ DBSubnetGroupName: secretImport }));
    consumerState = makeConsumerState({
      imports: [{ sourceStack: PRODUCER, sourceRegion: REGION, exportName: `e-${OLD}-x` }],
    });

    const err = await scrubCommand([], commandOptions({ dryRun: true, fail: true })).catch(
      (e: unknown) => e
    );

    expect((err as { code?: string } | undefined)?.code).toBe('SCRUB_NEEDED');
    // The CI gate's own output carries the note, not only the warning.
    const info = logLines.filter((l) => l.startsWith('info')).join('\n');
    expect(info).toContain('could NOT repair');
    expect(info).not.toContain('No plaintext secrets found');
  });

  it('the ordinary-import control stays GREEN under --fail', async () => {
    producerOutputs = { [`Producer:${LIVE}`]: 'subnet-group-1', 'Producer:BucketName': 'port-1' };
    synthStacks.push(
      consumerStackInfo({
        DBSubnetGroupName: { 'Fn::ImportValue': { 'Fn::Join': ['', ['Producer:', SECRET_EXPR]] } },
        Port: { 'Fn::ImportValue': 'Producer:BucketName' },
      })
    );
    consumerState = makeConsumerState({
      imports: [
        { sourceStack: PRODUCER, sourceRegion: REGION, exportName: `Producer:${SECRET_EXPR}` },
        { sourceStack: PRODUCER, sourceRegion: REGION, exportName: 'Producer:BucketName' },
      ],
    });

    await expect(scrubCommand([], commandOptions({ fail: true }))).resolves.toBeUndefined();
    expect(logLines.join('\n')).toContain('No plaintext secrets found in any target stack state');
  });
});
