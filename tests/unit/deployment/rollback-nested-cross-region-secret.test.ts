import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

/**
 * A nested child's rollback replay classifies a PARENT-supplied secret
 * reference with the parent's producer regions (go-to-k/cdkd#4174).
 *
 * A child receives a parent's cross-region value only as a Parameter, and
 * records the parent's region-less `{{resolve:...}}` spelling
 * (`inheritedSecrets`). The child's own `imports` / `outputReads` never name
 * the parent's producer region, so a child replay classifying against them
 * alone answered `local` and resolved the reference against a same-named
 * secret in the stack's region — writing the WRONG secret to a live resource.
 *
 * Driven end to end: the PARENT replay (real executor) reverts its nested row
 * through the real `NestedStackProvider`, which replays the child's journal
 * (real `revertNestedChildFromJournal`, real executor again). Only the leaf
 * `SecretsManagerClient` is faked, with its constructor region as the
 * discriminator, so "which region answered" is observable.
 */

interface FakeSend {
  ctorRegion: string | undefined;
  command: string;
}

const { responses, secretSends, makeFakeClientClass } = vi.hoisted(() => {
  const responses = new Map<string, unknown>();
  const makeFakeClientClass = (sends: FakeSend[]): unknown =>
    class {
      readonly ctorRegion: string | undefined;
      readonly config: { region: () => Promise<string> };
      constructor(ctorConfig: { region?: string } = {}) {
        this.ctorRegion = ctorConfig.region;
        this.config = { region: () => Promise.resolve(ctorConfig.region ?? '') };
      }
      async send(command: { constructor: { name: string } }): Promise<unknown> {
        const name = command.constructor.name;
        sends.push({ ctorRegion: this.ctorRegion, command: name });
        const response = responses.get(`${String(this.ctorRegion)}|${name}`);
        if (response === undefined) {
          throw new Error(`no response primed for ${String(this.ctorRegion)}|${name}`);
        }
        return response;
      }
      destroy(): void {}
    };
  return { responses, secretSends: [] as FakeSend[], makeFakeClientClass };
});

vi.mock('@aws-sdk/client-secrets-manager', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return { ...actual, SecretsManagerClient: makeFakeClientClass(secretSends) };
});

vi.mock('@aws-sdk/client-sts', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return { ...actual, STSClient: makeFakeClientClass([]) };
});

vi.mock('../../../src/deployment/retry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/deployment/retry.js')>();
  return { ...actual, withRetry: vi.fn((fn: () => Promise<unknown>) => fn()) };
});

/** Every line either logger writes: the child replay logs through the provider's. */
const logLines = vi.hoisted(() => [] as string[]);

vi.mock('../../../src/utils/logger.js', () => {
  const push = (...a: unknown[]): void => void logLines.push(a.map(String).join(' '));
  const l = { debug: push, info: push, warn: push, error: push, setLevel: vi.fn(), child: () => l };
  return { getLogger: () => l };
});

import { AwsClients, setAwsClients, resetAwsClients } from '../../../src/utils/aws-clients.js';
import { resetAccountInfoCache } from '../../../src/deployment/intrinsic-function-resolver.js';
import {
  replayRollback,
  type CompletedOperation,
  type RollbackExecutorContext,
} from '../../../src/deployment/rollback-executor.js';
import { withNestedRevertRun } from '../../../src/deployment/nested-child-journal.js';
import { withNestedStackContext } from '../../../src/provisioning/nested-stack-context.js';
import { NestedStackProvider } from '../../../src/provisioning/providers/nested-stack-provider.js';
import type { ResourceState, StackState } from '../../../src/types/state.js';

const REGION = 'ap-northeast-1';
const PRODUCER_REGION = 'eu-west-1';
const SECRET_NAME = 'prod/db/cred';
/** The parent's region-less spelling, as the child records it. */
const NAME_EXPR = `{{resolve:secretsmanager:${SECRET_NAME}:SecretString:password}}`;
const LOCAL_PASSWORD = 'tokyo-password-4174';
const PRODUCER_PASSWORD = 'ireland-password-4174';
const IDP_TYPE = 'AWS::Cognito::UserPoolIdentityProvider';
const STACK_TYPE = 'AWS::CloudFormation::Stack';
const CHILD = 'Parent~Child';
const RUN = 'run-4174';

const logger = {
  debug: (...a: unknown[]): void => void logLines.push(a.map(String).join(' ')),
  info: (...a: unknown[]): void => void logLines.push(a.map(String).join(' ')),
  warn: (...a: unknown[]): void => void logLines.push(a.map(String).join(' ')),
  error: (...a: unknown[]): void => void logLines.push(a.map(String).join(' ')),
  setLevel: (): void => {},
  child: (): unknown => logger,
} as unknown as RollbackExecutorContext['logger'];

function res(type: string, properties: Record<string, unknown>): ResourceState {
  return { physicalId: 'phys', resourceType: type, properties, attributes: {}, dependencies: [] };
}

function harness(parentEvidence: {
  importedProducerRegions?: string[];
  producerRegionsIncomplete?: boolean;
}) {
  const idpUpdate = vi.fn().mockResolvedValue({ physicalId: 'phys' });
  const nested = new NestedStackProvider();
  const childState: StackState = {
    version: 10,
    stackName: CHILD,
    region: REGION,
    parentStack: 'Parent',
    resources: {
      Idp: res(IDP_TYPE, { ProviderDetails: { client_id: 'pub-CHANGED', client_secret: NAME_EXPR } }),
    },
    outputs: {},
    lastModified: 0,
  } as StackState;
  const childOp: CompletedOperation = {
    logicalId: 'Idp',
    changeType: 'UPDATE',
    resourceType: IDP_TYPE,
    physicalId: 'phys',
    previousState: res(IDP_TYPE, {
      ProviderDetails: { client_id: 'pub', client_secret: NAME_EXPR },
    }),
  };
  const stateBackend = {
    getState: vi.fn(async () => ({ state: childState, etag: 'e1' })),
    loadRollbackJournal: vi.fn(async () => ({
      segments: [
        {
          runId: RUN,
          timestamp: 0,
          reason: 'nested-pending-parent',
          initialDeploy: false,
          operations: [childOp],
          previousCrossStackReads: {},
        },
      ],
    })),
    saveState: vi.fn(async () => 'e2'),
  };
  const providerRegistry = {
    getProviderFor: ({ resourceType }: { resourceType: string }) => ({
      provider: resourceType === STACK_TYPE ? nested : { update: idpUpdate },
    }),
  };
  const nestedCtx = {
    stateBackend,
    lockManager: {
      acquireLockWithRetry: vi.fn(async () => true),
      releaseLock: vi.fn(async () => undefined),
    },
    providerRegistry,
    parentStackName: 'Parent',
    parentRegion: REGION,
    accountId: '111122223333',
    awsClients: {},
    stateBucket: 'b',
  };
  const parentCtx: RollbackExecutorContext = {
    region: REGION,
    logger,
    providerRegistry: providerRegistry as unknown as RollbackExecutorContext['providerRegistry'],
    recordEvent: () => {},
    ...parentEvidence,
  };
  const rowOp: CompletedOperation = {
    logicalId: 'Child',
    changeType: 'UPDATE',
    resourceType: STACK_TYPE,
    physicalId: 'phys',
    previousState: res(STACK_TYPE, { TemplateURL: 'before' }),
  };
  const run = () =>
    withNestedStackContext(nestedCtx as never, () =>
      withNestedRevertRun(RUN, () =>
        replayRollback(
          [rowOp],
          { Child: res(STACK_TYPE, { TemplateURL: 'after' }) },
          'Parent',
          parentCtx
        )
      )
    );
  return { run, idpUpdate };
}

let savedRegion: string | undefined;

beforeEach(() => {
  savedRegion = process.env['AWS_REGION'];
  delete process.env['AWS_REGION'];
  responses.clear();
  secretSends.length = 0;
  logLines.length = 0;
  resetAccountInfoCache();
  setAwsClients(new AwsClients({ region: REGION }));
  responses.set(`${REGION}|GetSecretValueCommand`, {
    SecretString: JSON.stringify({ password: LOCAL_PASSWORD }),
  });
  responses.set(`${PRODUCER_REGION}|GetSecretValueCommand`, {
    SecretString: JSON.stringify({ password: PRODUCER_PASSWORD }),
  });
});

afterEach(() => {
  resetAwsClients();
  if (savedRegion === undefined) delete process.env['AWS_REGION'];
  else process.env['AWS_REGION'] = savedRegion;
});

describe("a nested child's rollback replay inherits the parent's producer regions (#4174)", () => {
  it("REFUSES a parent-supplied region-less reference when the PARENT reads across a region, though the child's own reads do not", async () => {
    const h = harness({ importedProducerRegions: [PRODUCER_REGION] });

    const result = await h.run();

    // THE discriminator: before the fix the child classified `local`, asked the
    // stack's own region and wrote the Tokyo password to the live resource.
    expect(h.idpUpdate).not.toHaveBeenCalled();
    expect(secretSends).toHaveLength(0);
    expect(result.failures).toBe(1);
    const refusal = logLines.find((l) => l.includes('Rollback failed for Idp'));
    expect(refusal).toContain(SECRET_NAME);
    expect(refusal).toContain(PRODUCER_REGION);
    expect(logLines.join('\n')).not.toContain(LOCAL_PASSWORD);
    expect(logLines.join('\n')).not.toContain(PRODUCER_PASSWORD);
  });

  it('REFUSES it when the parent replay has only INCOMPLETE evidence (the parent is itself an orphaned child)', async () => {
    const h = harness({ importedProducerRegions: [], producerRegionsIncomplete: true });

    const result = await h.run();

    expect(h.idpUpdate).not.toHaveBeenCalled();
    expect(secretSends).toHaveLength(0);
    expect(result.failures).toBe(1);
    const refusal = logLines.find((l) => l.includes('Rollback failed for Idp'));
    expect(refusal).toContain("cross-region reads its parent made are not known");
    expect(logLines.join('\n')).not.toContain(LOCAL_PASSWORD);
  });

  it('CONTROL: a parent with no foreign producer region resolves it in the stack region, as before', async () => {
    const h = harness({ importedProducerRegions: [REGION] });

    const result = await h.run();

    expect(result.failures).toBe(0);
    expect(secretSends.map((s) => s.ctorRegion)).toEqual([REGION]);
    const desired = h.idpUpdate.mock.calls[0]![3] as { ProviderDetails: { client_secret: string } };
    expect(desired.ProviderDetails.client_secret).toBe(LOCAL_PASSWORD);
  });
});
