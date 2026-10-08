import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Issue [#3361](https://github.com/go-to-k/cdkd/issues/3361), the two
 * `scrub.ts` handlers on the nested-stack PARENT-ROW repair
 * (go-to-k/cdkd#3961): its lock release, and the `scrubCommand` catch that
 * reports a failed repair and moves on. Both stringified the caught value with
 * a bare `String()`, which throws for a null-prototype object.
 *
 * A separate file from `scrub-string-outthrow-3361.test.ts` because the repair
 * needs the REAL resolver -- the child's needles are recorded inside it -- and
 * that file doubles it. The harness is `scrub-nested-child.test.ts`'s, cut
 * down to the one app shape the repair runs on.
 */

const { secretValues, FakeSecretsManagerClient, FakeStsClient } = vi.hoisted(() => {
  const secretValues = new Map<string, string>();
  class FakeSecretsManagerClient {
    readonly config = { region: (): Promise<string> => Promise.resolve('us-east-1') };
    send(command: { input?: { SecretId?: string } }): Promise<unknown> {
      const value = secretValues.get(command.input?.SecretId ?? '');
      if (value === undefined) {
        return Promise.reject(
          Object.assign(new Error("Secrets Manager can't find the specified secret."), {
            name: 'ResourceNotFoundException',
          })
        );
      }
      return Promise.resolve({ SecretString: value });
    }
    destroy(): void {}
  }
  class FakeStsClient {
    readonly config = { region: (): Promise<string> => Promise.resolve('us-east-1') };
    send(): Promise<unknown> {
      return Promise.resolve({ Account: '111122223333', Arn: 'arn:aws:iam::111122223333:root' });
    }
    destroy(): void {}
  }
  return { secretValues, FakeSecretsManagerClient, FakeStsClient };
});

vi.mock('@aws-sdk/client-secrets-manager', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  SecretsManagerClient: FakeSecretsManagerClient,
}));
vi.mock('@aws-sdk/client-sts', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  STSClient: FakeStsClient,
}));

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

const synthStacks = vi.hoisted(() => [] as unknown[]);
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

/** The state bucket: `<stack>|<region>` -> the stored record. */
const stateStore = vi.hoisted(() => new Map<string, unknown>());
const stateBackend = vi.hoisted(() => ({
  prefix: 'cdkd',
  getState: vi.fn(),
  saveState: vi.fn(),
  purgeNoncurrentVersions: vi.fn(),
  getRawObject: vi.fn(),
  listStacks: vi.fn(),
}));
vi.mock('../../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn().mockImplementation(() => stateBackend),
}));
const releaseLock = vi.hoisted(() => vi.fn());
vi.mock('../../../../src/state/lock-manager.js', () => ({
  LockManager: vi.fn().mockImplementation(() => ({
    acquireLockWithRetry: vi.fn().mockResolvedValue(undefined),
    releaseLock,
  })),
}));
vi.mock('../../../../src/state/export-index-store.js', () => ({
  ExportIndexStore: vi.fn().mockImplementation(() => ({
    readPersistedEntries: vi.fn().mockResolvedValue(undefined),
    patchEntry: vi.fn().mockResolvedValue(true),
  })),
}));

import { resetAwsClients } from '../../../../src/utils/aws-clients.js';
import { resetAccountInfoCache } from '../../../../src/deployment/intrinsic-function-resolver.js';
import { clearRecordedSecretExpressions } from '../../../../src/deployment/secret-redaction.js';
import { scrubCommand } from '../../../../src/cli/commands/scrub.js';
import type { StackState } from '../../../../src/types/state.js';
import type { CloudFormationTemplate } from '../../../../src/types/resource.js';

/** What `describeAwsFailure(x).detail` renders for a value `String()` cannot convert. */
const PLACEHOLDER = 'a value that could not be converted to text';
const unconvertible = (): unknown => Object.create(null) as unknown;

const REGION = 'us-east-1';
const API_KEY = 'nested-child-api-key-3361';
const API_EXPR = '{{resolve:secretsmanager:app/api:SecretString:key}}';
const PARENT = 'ParentStack';
const CHILD = `${PARENT}~ChildStack`;

let assemblyDir: string;

function record(
  stackName: string,
  resources: StackState['resources'],
  outputs: Record<string, unknown> = {}
): StackState {
  return { version: 10, region: REGION, stackName, resources, outputs, lastModified: 0 } as StackState;
}

/**
 * A parent whose nested row's `Outputs.ApiOut` attribute holds the CHILD's
 * own secret in plaintext, beside a clean child: the shape only the parent-row
 * repair rewrites.
 */
function seedApp(): void {
  const childTemplate: CloudFormationTemplate = {
    Resources: { Topic: { Type: 'AWS::SNS::Topic', Properties: { TopicName: 'child-topic' } } },
    Outputs: { ApiOut: { Value: API_EXPR } },
  } as CloudFormationTemplate;
  const childPath = path.join(assemblyDir, 'ChildStack.nested.template.json');
  fs.writeFileSync(childPath, JSON.stringify(childTemplate));
  synthStacks.push({
    stackName: PARENT,
    displayName: PARENT,
    artifactId: PARENT,
    dependencyNames: [],
    region: REGION,
    template: {
      Resources: {
        ChildStack: {
          Type: 'AWS::CloudFormation::Stack',
          Properties: { TemplateURL: 'https://example.invalid/child.json', Parameters: {} },
          Metadata: { 'aws:asset:path': path.basename(childPath) },
        },
      },
    },
    nestedTemplates: { ChildStack: childPath },
  });
  stateStore.set(
    `${PARENT}|${REGION}`,
    record(PARENT, {
      ChildStack: {
        physicalId: `arn:cdkd-local:${REGION}:111122223333:nested-stack/${PARENT}/ChildStack`,
        resourceType: 'AWS::CloudFormation::Stack',
        properties: { TemplateURL: 'https://example.invalid/child.json', Parameters: {} },
        attributes: { 'Outputs.ApiOut': API_KEY },
      },
    })
  );
  stateStore.set(
    `${CHILD}|${REGION}`,
    record(
      CHILD,
      {
        Topic: {
          physicalId: 'child-topic',
          resourceType: 'AWS::SNS::Topic',
          properties: { TopicName: 'child-topic' },
          attributes: {},
        },
      },
      { ApiOut: API_EXPR }
    )
  );
}

const parentAttributes = (): unknown =>
  (stateStore.get(`${PARENT}|${REGION}`) as StackState).resources['ChildStack']!.attributes;

async function run(): Promise<unknown> {
  try {
    await scrubCommand([PARENT], {
      output: 'cdk.out',
      statePrefix: 'cdkd',
      verbose: false,
    } as never);
    return undefined;
  } catch (err) {
    return err;
  }
}

beforeEach(() => {
  assemblyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdkd-scrub-nested-3361-'));
  stateStore.clear();
  secretValues.clear();
  secretValues.set('app/api', JSON.stringify({ key: API_KEY }));
  logLines.length = 0;
  synthStacks.length = 0;
  process.env['AWS_REGION'] = REGION;
  resetAwsClients();
  resetAccountInfoCache();
  clearRecordedSecretExpressions();
  stateBackend.getState.mockReset().mockImplementation((stack: string, region: string) => {
    const state = stateStore.get(`${stack}|${region}`);
    return Promise.resolve(
      state === undefined ? null : { state: structuredClone(state), etag: `etag-${stack}` }
    );
  });
  stateBackend.saveState
    .mockReset()
    .mockImplementation((stack: string, region: string, state: StackState) => {
      stateStore.set(`${stack}|${region}`, structuredClone(state));
      return Promise.resolve('etag-next');
    });
  stateBackend.listStacks.mockReset().mockResolvedValue([]);
  stateBackend.purgeNoncurrentVersions.mockReset().mockResolvedValue(undefined);
  stateBackend.getRawObject.mockReset().mockResolvedValue(null);
  releaseLock.mockReset().mockResolvedValue(undefined);
  seedApp();
});

afterEach(() => {
  fs.rmSync(assemblyDir, { recursive: true, force: true });
  resetAwsClients();
  clearRecordedSecretExpressions();
  delete process.env['AWS_REGION'];
});

describe('cdkd scrub - the nested parent-row repair (#3361)', () => {
  it('the parent re-lock release rejecting unconvertibly still keeps the repair, and warns', async () => {
    // The release `.catch` sits in the repair's `finally`: its throw replaced
    // the repair's result, so a parent row that WAS rewritten was reported as
    // a failed repair and the run exited non-zero.
    let parentReleases = 0;
    releaseLock.mockImplementation((stack: string) =>
      stack === PARENT && ++parentReleases === 2
        ? Promise.reject(unconvertible())
        : Promise.resolve(undefined)
    );

    const err = await run();

    expect(err).toBeUndefined();
    expect(parentReleases).toBe(2);
    expect(parentAttributes()).toEqual({ 'Outputs.ApiOut': API_EXPR });
    const warned = logLines.filter((l) => l.includes(`Failed to release lock for ${PARENT}`));
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain(PLACEHOLDER);
  });

  it('a parent re-read rejecting unconvertibly is reported as the repair failure, and the run finishes', async () => {
    // The repair re-reads the parent; the `scrubCommand` catch around it
    // records the failure and moves on. Its renderer threw instead, which
    // ended the run from inside the loop.
    let parentReads = 0;
    const base = stateBackend.getState.getMockImplementation()!;
    stateBackend.getState.mockImplementation((stack: string, region: string) =>
      stack === PARENT && ++parentReads > 1 ? Promise.reject(unconvertible()) : base(stack, region)
    );

    const err = await run();

    expect(err).not.toBeInstanceOf(TypeError);
    expect((err as { exitCode?: number }).exitCode).toBe(2);
    expect(parentAttributes()).toEqual({ 'Outputs.ApiOut': API_KEY });
    const failed = logLines.filter((l) => l.includes('nested-stack output attributes for'));
    expect(failed).toHaveLength(1);
    expect(failed[0]).toContain(`failed: ${PLACEHOLDER}`);
  });
});
