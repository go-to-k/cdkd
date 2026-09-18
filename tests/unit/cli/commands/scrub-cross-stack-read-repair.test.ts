import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

/**
 * `cdkd scrub` must REPAIR a cross-stack read name an older binary persisted in
 * plaintext (issue [#3337](https://github.com/go-to-k/cdkd/issues/3337)).
 *
 * go-to-k/cdkd#3289 closed the WRITE side: `imports[].exportName`,
 * `outputReads[].sourceStack` and `outputReads[].outputName` are redacted at the
 * persist choke point, so a name an `Fn::Sub` assembled around a resolved
 * `{{resolve:...}}` no longer reaches `state.json` in plaintext. It did NOT
 * close the repair side — both lists rode `scrubStack`'s `...carriedState`
 * spread untouched, so a record already on disk kept its plaintext and
 * `cdkd scrub --fail` reported it clean.
 *
 * SCOPE IS **NEVER-AGAIN**, and that is narrower than "everything written
 * before the fix". Of the four across-deploy cases the #3289 design doc
 * enumerates, SAME-VALUE self-repairs on the next deploy and DUPLICATE is
 * closed by the union normalizer. **ROTATED is NOT closed by this walk and no
 * case here claims it is**: scrub derives its needles by re-resolving the LIVE
 * template, so it holds the CURRENT secret value, while a rotated record holds
 * a value nothing in the run knows. The `rotated` case below pins that as the
 * declared residual rather than leaving it to be discovered as a silent miss.
 *
 * WHY THE FIELD SET IS THREE AND NOT SIX. `sourceRegion` is an AWS region, and
 * `imports[].sourceStack` is stored VERBATIM forever because
 * `scanActiveConsumers` matches destroy-time refusals on it — redacting it
 * would drop a destroy-blocking record. The write side leaves both alone for
 * the same reason, and the two sides must agree on the set or a scrub would
 * undo a deploy's deliberate decision. The `leaves the two verbatim fields
 * alone` case is what keeps them agreeing.
 */

interface FakeClientConfig {
  region?: string;
}

interface FakeSend {
  ctorRegion: string | undefined;
  command: string;
  input: unknown;
}

const { secretResponses, secretSends, ssmSends, cfnSends, makeFakeClientClass } = vi.hoisted(() => {
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

  return {
    secretResponses,
    secretSends: [] as FakeSend[],
    ssmSends: [] as FakeSend[],
    cfnSends: [] as FakeSend[],
    makeFakeClientClass,
  };
});

vi.mock('@aws-sdk/client-ssm', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return { ...actual, SSMClient: makeFakeClientClass(ssmSends, 'ssm') };
});

vi.mock('@aws-sdk/client-secrets-manager', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return {
    ...actual,
    SecretsManagerClient: makeFakeClientClass(secretSends, 'secretsmanager'),
  };
});

vi.mock('@aws-sdk/client-cloudformation', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return { ...actual, CloudFormationClient: makeFakeClientClass(cfnSends, 'cloudformation') };
});

vi.mock('@aws-sdk/client-sts', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return { ...actual, STSClient: makeFakeClientClass([], 'sts') };
});

const logLines: string[] = [];
vi.mock('../../../../src/utils/logger.js', () => {
  const push =
    (level: string) =>
    (...args: unknown[]): void => void logLines.push(`${level} ${args.map(String).join(' ')}`);
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

import { AwsClients, setAwsClients, resetAwsClients } from '../../../../src/utils/aws-clients.js';
import { resetAccountInfoCache } from '../../../../src/deployment/intrinsic-function-resolver.js';
import { clearRecordedSecretExpressions } from '../../../../src/deployment/secret-redaction.js';
import { scrubStack } from '../../../../src/cli/commands/scrub.js';
import type { StackState } from '../../../../src/types/state.js';
import type { CloudFormationTemplate } from '../../../../src/types/resource.js';

const REGION = 'us-east-1';
const STACK = 'Consumer';
const SECRET_ID = 'prod/db';
const SECRET_EXPR = `{{resolve:secretsmanager:${SECRET_ID}:SecretString:password}}`;
/** The value the LIVE template resolves to — i.e. what this run learns. */
const PLAINTEXT = 'live-db-password-3337';
/** A value the reference used to resolve to, before a rotation. */
const ROTATED_AWAY = 'old-db-password-3337';

const logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

let stateBackend: {
  getState: ReturnType<typeof vi.fn>;
  saveState: ReturnType<typeof vi.fn>;
  listStacks: ReturnType<typeof vi.fn>;
};
let lockManager: {
  acquireLockWithRetry: ReturnType<typeof vi.fn>;
  releaseLock: ReturnType<typeof vi.fn>;
};
let savedRegion: string | undefined;
let state: StackState;

/**
 * The resource property is the expression itself, so re-resolving today's
 * template records `PLAINTEXT -> SECRET_EXPR` as a needle. That is the ONLY
 * thing this run learns, which is exactly why ROTATED cannot be repaired.
 */
function makeState(extra: Partial<StackState>): StackState {
  return {
    version: 10,
    region: REGION,
    stackName: STACK,
    resources: {
      Db: {
        physicalId: 'db-1',
        resourceType: 'AWS::RDS::DBInstance',
        properties: { MasterUserPassword: SECRET_EXPR },
      },
    },
    outputs: {},
    lastModified: 0,
    ...extra,
  };
}

function makeStackInfo(): unknown {
  return {
    stackName: STACK,
    dependencyNames: [],
    template: {
      Resources: {
        Db: {
          Type: 'AWS::RDS::DBInstance',
          Properties: { MasterUserPassword: SECRET_EXPR },
        },
      },
    } as CloudFormationTemplate,
  };
}

beforeEach(() => {
  savedRegion = process.env['AWS_REGION'];
  process.env['AWS_REGION'] = REGION;
  secretResponses.clear();
  secretSends.length = 0;
  ssmSends.length = 0;
  cfnSends.length = 0;
  logLines.length = 0;
  resetAccountInfoCache();
  clearRecordedSecretExpressions();
  setAwsClients(new AwsClients({ region: REGION }));
  // The expression selects `:SecretString:password`, so the secret must be a
  // JSON document with that key -- a bare string resolves to nothing, records
  // no needle, and every case below then passes vacuously over an unscrubbed
  // record.
  secretResponses.set('secretsmanager|GetSecretValueCommand', {
    SecretString: JSON.stringify({ password: PLAINTEXT }),
  });
  stateBackend = {
    getState: vi.fn().mockImplementation(() => Promise.resolve({ state, etag: 'c-1' })),
    saveState: vi.fn().mockResolvedValue('etag-2'),
    listStacks: vi.fn().mockResolvedValue([]),
  };
  lockManager = {
    acquireLockWithRetry: vi.fn().mockResolvedValue(undefined),
    releaseLock: vi.fn().mockResolvedValue(undefined),
  };
});

afterEach(() => {
  resetAwsClients();
  clearRecordedSecretExpressions();
  if (savedRegion === undefined) delete process.env['AWS_REGION'];
  else process.env['AWS_REGION'] = savedRegion;
});

async function scrub(opts?: { dryRun?: boolean }): Promise<{ recordsChanged: number }> {
  return (await scrubStack(makeStackInfo() as never, REGION, stateBackend as never, lockManager as never, {
    dryRun: opts?.dryRun ?? false,
    logger: logger as never,
  })) as { recordsChanged: number };
}

function savedState(): StackState {
  expect(stateBackend.saveState).toHaveBeenCalledTimes(1);
  return stateBackend.saveState.mock.calls[0]![2] as StackState;
}

describe('cdkd scrub repairs cross-stack read names (issue #3337)', () => {
  it('rewrites a plaintext imports[].exportName back to its expression', async () => {
    state = makeState({
      imports: [
        { sourceStack: 'Producer', sourceRegion: REGION, exportName: `prod-${PLAINTEXT}-export` },
      ],
    });

    const res = await scrub();

    expect(savedState().imports).toEqual([
      { sourceStack: 'Producer', sourceRegion: REGION, exportName: `prod-${SECRET_EXPR}-export` },
    ]);
    // Counted, so `--fail` sees it. Before this walk the record was carried
    // untouched and the run reported clean.
    expect(res.recordsChanged).toBeGreaterThan(0);
  });

  it('rewrites both template-derived outputReads fields', async () => {
    state = makeState({
      outputReads: [
        {
          sourceStack: `stack-${PLAINTEXT}`,
          sourceRegion: REGION,
          outputName: `out-${PLAINTEXT}`,
        },
      ],
    });

    await scrub();

    expect(savedState().outputReads).toEqual([
      {
        sourceStack: `stack-${SECRET_EXPR}`,
        sourceRegion: REGION,
        outputName: `out-${SECRET_EXPR}`,
      },
    ]);
  });

  /**
   * THE FIELD SET MUST MATCH THE WRITE SIDE. `sourceRegion` is an AWS region and
   * `imports[].sourceStack` is the literal key `scanActiveConsumers` matches a
   * destroy-time refusal on, so redacting either drops a destroy-blocking
   * record. A scrub that "improved" on the write side here would silently undo
   * a deliberate decision.
   */
  it('leaves sourceRegion and imports[].sourceStack verbatim even when they carry the plaintext', async () => {
    state = makeState({
      imports: [
        {
          sourceStack: `producer-${PLAINTEXT}`,
          sourceRegion: REGION,
          exportName: `e-${PLAINTEXT}`,
        },
      ],
    });

    await scrub();

    const [entry] = savedState().imports!;
    expect(entry!.sourceStack).toBe(`producer-${PLAINTEXT}`);
    expect(entry!.sourceRegion).toBe(REGION);
    expect(entry!.exportName).toBe(`e-${SECRET_EXPR}`);
  });

  /**
   * THE DECLARED RESIDUAL. A rotated record holds a plaintext this run cannot
   * know: scrub's needles come from re-resolving the live template, which
   * returns the CURRENT value. The record is left untouched rather than
   * mangled, and this case exists so the limit is asserted rather than
   * discovered.
   */
  it('does NOT repair a ROTATED record — its plaintext is a value this run never sees', async () => {
    // A repairable leaf ELSEWHERE forces a save, so "the rotated name survived"
    // is observed on a record this run actually WROTE. Without it the run
    // changes nothing, `scrubStack` never saves, and the case would pass
    // whether or not the walk ran at all.
    state = makeState({
      resources: {
        Db: {
          physicalId: 'db-1',
          resourceType: 'AWS::RDS::DBInstance',
          properties: { MasterUserPassword: PLAINTEXT },
        },
      },
      imports: [
        { sourceStack: 'Producer', sourceRegion: REGION, exportName: `e-${ROTATED_AWAY}-x` },
      ],
    });

    await scrub();

    const [entry] = savedState().imports!;
    expect(entry!.exportName).toBe(`e-${ROTATED_AWAY}-x`);
    expect(entry!.exportName).toContain(ROTATED_AWAY);
  });

  /** A name carrying no secret is persisted verbatim — the control. */
  it('leaves a name that carries no secret alone', async () => {
    // Same reason as the ROTATED case: a repairable leaf elsewhere makes the
    // save happen, so the names are asserted on a written record.
    const imports = [
      { sourceStack: 'Producer', sourceRegion: REGION, exportName: 'Producer:PublicBucketName' },
    ];
    const outputReads = [{ sourceStack: 'Other', sourceRegion: REGION, outputName: 'BucketArn' }];
    state = makeState({
      resources: {
        Db: {
          physicalId: 'db-1',
          resourceType: 'AWS::RDS::DBInstance',
          properties: { MasterUserPassword: PLAINTEXT },
        },
      },
      imports,
      outputReads,
    });

    await scrub();

    expect(savedState().imports).toEqual(imports);
    expect(savedState().outputReads).toEqual(outputReads);
  });

  /**
   * A state file that records no cross-stack reads must not GAIN the keys by
   * being scrubbed — both are optional in the schema, and materialising `[]`
   * is a write this command never intended. The `orphans` spread beside it
   * makes the same decision for the same reason.
   */
  it('does not add imports / outputReads keys to a record that had none', async () => {
    state = makeState({
      resources: {
        Db: {
          physicalId: 'db-1',
          resourceType: 'AWS::RDS::DBInstance',
          properties: { MasterUserPassword: PLAINTEXT },
        },
      },
    });

    await scrub();

    const saved = savedState();
    expect('imports' in saved).toBe(false);
    expect('outputReads' in saved).toBe(false);
  });

  it('writes nothing under --dry-run', async () => {
    state = makeState({
      imports: [
        { sourceStack: 'Producer', sourceRegion: REGION, exportName: `e-${PLAINTEXT}` },
      ],
    });

    const res = await scrub({ dryRun: true });

    expect(stateBackend.saveState).not.toHaveBeenCalled();
    // Still COUNTED, so `--dry-run --fail` reddens on a record a real run would
    // repair — which is what makes it usable as a standing CI gate.
    expect(res.recordsChanged).toBeGreaterThan(0);
  });
});
