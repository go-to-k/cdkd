/**
 * A deploy's automatic rollback masks a physical name derived from a secret
 * on a journaled failed-CREATE orphan's delete (go-to-k/cdkd#3869), as
 * `cdkd destroy` and `cdkd rollback` do: the orphan replay runs under a
 * printing bag judged from the journal entries, and the rollback context's
 * events are masked by the bags bound where each is recorded. The replay's
 * op masker, and the engine's per-resource event mask, hold no name the
 * orphan READ from a state record (an access key's `UserName`).
 */
import { describe, it, expect, vi } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { markCreatedBeforeFailure } from '../../../src/provisioning/auxiliary-failure.js';
import { currentLogLineMasker } from '../../../src/utils/log-line-masker.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceChange, StackState } from '../../../src/types/state.js';

vi.mock('../../../src/utils/aws-clients.js', async (importOriginal) =>
  (await import('./_inert-cloudformation-client.js')).withInertCloudFormationClient(importOriginal)
);
vi.mock('../../../src/utils/logger.js', () => {
  const l = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), setLevel: vi.fn(), child: () => l };
  return { getLogger: () => l };
});
vi.mock('../../../src/deployment/intrinsic-function-resolver.js', () => ({
  IntrinsicFunctionResolver: vi.fn().mockImplementation(() => ({
    getPhysicalIdFallbackCount: vi.fn().mockReturnValue(0),
    resetPhysicalIdFallbackCount: vi.fn(),
    resolve: vi.fn().mockImplementation((props: unknown) => Promise.resolve(props)),
    resolveParameters: vi.fn().mockReturnValue({}),
    evaluateConditions: vi.fn().mockResolvedValue({}),
  })),
}));
vi.mock('../../../src/provisioning/cloud-control-provider.js', () => ({
  CloudControlProvider: { isSupportedResourceType: vi.fn(() => true) },
}));

const REF = '{{resolve:secretsmanager:team:SecretString:user::}}';
const USER = 'team-secret-user';
const STACK = 'orphan-mask-test';

async function autoRollback(userName: string) {
  const lines: string[] = [];
  const events: Array<{ eventType: string; logicalId?: string; error?: { message?: string } }> = [];
  const provider = {
    create: vi.fn((logicalId: string) =>
      Promise.reject(
        markCreatedBeforeFailure(new Error('follow-up rejected'), logicalId, 'AWS::IAM::AccessKey', 'AKIAEXAMPLEKEY')
      )
    ),
    update: vi.fn(),
    delete: vi.fn((logicalId: string, physicalId: string) => {
      const line = `Deleting access key ${logicalId} ${physicalId} of user ${USER}`;
      lines.push(currentLogLineMasker()?.(line) ?? line);
      return Promise.reject(new Error(`AccessDenied on user ${USER}`));
    }),
  };
  const current: StackState = {
    version: 8,
    stackName: STACK,
    region: 'us-east-1',
    resources: {
      User: {
        physicalId: USER,
        resourceType: 'AWS::IAM::User',
        properties: { UserName: userName },
        attributes: {},
        dependencies: [],
        provisionedBy: 'sdk',
      },
    },
    outputs: {},
    lastModified: 1,
  };
  const change = {
    logicalId: 'Key',
    changeType: 'CREATE',
    resourceType: 'AWS::IAM::AccessKey',
    desiredProperties: { UserName: USER },
    propertyChanges: [],
  } as unknown as ResourceChange;
  const engine = new DeployEngine(
    {
      getState: vi.fn().mockResolvedValue({ state: current, etag: 'e0' }),
      saveState: vi.fn().mockResolvedValue('etag-1'),
      listStacks: vi.fn().mockResolvedValue([]),
      appendRollbackJournalSegment: vi.fn().mockResolvedValue(undefined),
      deleteRollbackJournal: vi.fn().mockResolvedValue(undefined),
      loadRollbackJournal: vi.fn().mockResolvedValue(null),
      markRollbackJournalSuperseded: vi.fn().mockResolvedValue(undefined),
      popRollbackJournalSegment: vi.fn().mockResolvedValue(0),
      reduceRollbackJournalToFailedOperations: vi.fn().mockResolvedValue(1),
      dropRollbackJournalFailedOperations: vi.fn().mockResolvedValue(1),
    } as never,
    {
      acquireLockWithRetry: vi.fn().mockResolvedValue(true),
      releaseLock: vi.fn().mockResolvedValue(undefined),
    } as never,
    {
      buildGraph: vi.fn().mockReturnValue({}),
      getExecutionLevels: vi.fn().mockReturnValue([['Key']]),
      getDirectDependencies: vi.fn(() => []),
    } as never,
    {
      calculateDiff: vi.fn().mockResolvedValue(new Map([['Key', change]])),
      hasChanges: vi.fn().mockReturnValue(true),
      filterByType: vi.fn((changes: Map<string, ResourceChange>, type: string) =>
        [...changes.values()].filter((c) => c.changeType === type)
      ),
    } as never,
    {
      getProvider: vi.fn().mockReturnValue(provider),
      getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'sdk' }),
      getRegisteredTypes: vi.fn().mockReturnValue([]),
      getCloudControlProvider: vi.fn(),
      validateResourceTypes: vi.fn(),
      validateResourceProperties: vi.fn(),
    } as never,
    {
      concurrency: 4,
      noRollback: false,
      roleArn: 'arn:aws:iam::1:role/r',
      eventRecorder: { record: (e: (typeof events)[number]) => void events.push(e), runId: 'r1' } as never,
    },
    'us-east-1'
  );
  const template: CloudFormationTemplate = {
    Resources: {
      User: { Type: 'AWS::IAM::User', Properties: { UserName: userName } },
      Key: { Type: 'AWS::IAM::AccessKey', Properties: { UserName: USER } },
    },
  };
  await engine.deploy(STACK, template).catch(() => undefined);
  return { lines, events, provider };
}

describe("a deploy's automatic rollback masks a name a journaled orphan read (go-to-k/cdkd#3869)", () => {
  it.each([
    ['a secret-named user in state', REF, false],
    ['negative control, an ordinary user name', 'plain-user-name', true],
  ])('on its delete line and its ROLLBACK_RESOURCE_FAILED event: %s', async (_l, userName, shown) => {
    const { lines, events } = await autoRollback(userName);
    // Premise: the rollback replayed the proven orphan, which logged and
    // failed quoting AWS's text.
    expect(lines).toEqual([expect.stringContaining('Deleting access key Key AKIAEXAMPLEKEY of user ')]);
    const failed = events.filter((e) => e.eventType === 'ROLLBACK_RESOURCE_FAILED');
    expect(failed).toHaveLength(1);
    expect(failed[0]!.error?.message).toContain('AccessDenied on user ');
    expect(lines[0]!.includes(USER)).toBe(shown);
    expect(failed[0]!.error!.message!.includes(USER)).toBe(shown);
  });
});
