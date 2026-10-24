import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const stubLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: () => stubLogger,
};
vi.mock('../../../src/utils/live-renderer.js', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    getLiveRenderer: () => ({
      addTask: vi.fn(),
      updateTaskLabel: vi.fn(),
      removeTask: vi.fn(),
      completeTask: vi.fn(),
      failTask: vi.fn(),
      startTask: vi.fn(),
    }),
  };
});
vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => stubLogger,
  Logger: class {},
  LogLevel: { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 },
}));
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { provisionResource } from '../../../src/deployment/deploy-engine/provision.js';
import type { ResourceProvider } from '../../../src/types/resource.js';
import type { ResourceChange, ResourceState as StateRecord } from '../../../src/types/state.js';
import { InterruptedWaitError } from '../../../src/provisioning/interrupt-watch.js';
import { markWaitAbandoned } from '../../../src/provisioning/wait-abandoned.js';
import { hasRedactedCause } from '../../../src/deployment/retryable-errors.js';
import { extractDeploymentEventError } from '../../../src/types/deployment-events.js';
import { awsSdkError } from '../_aws-sdk-error.js';

/**
 * A failed UPDATE that this deploy auto-routed from the SDK provider to Cloud
 * Control names the move and both ways through (issue
 * [#4904](https://github.com/go-to-k/cdkd/issues/4904)); every other failed
 * update keeps its message unchanged.
 */
const STACK = 'MyStack';
const LOGICAL_ID = 'MyTopic';
const TYPE = 'AWS::SNS::Topic';
const RECORDED_PROPS = { TopicName: 't' };
const DESIRED_PROPS = { TopicName: 't', ArchivePolicy: { MessageRetentionPeriod: 7 } };
const AWS_TEXT = 'UPDATE failed for MyTopic: Identifier t is invalid';

describe('auto-routed SDK-to-Cloud Control update failure (#4904)', () => {
  let updateError: Error;
  let getProviderFor: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    updateError = new Error(AWS_TEXT);
  });

  function makeEngine(decision: Record<string, unknown>, options: Record<string, unknown> = {}) {
    const provider = {
      create: vi.fn(),
      update: vi.fn().mockImplementation(() => Promise.reject(updateError)),
      delete: vi.fn(),
      getAttribute: vi.fn(),
      disableOuterRetry: true,
    } as unknown as ResourceProvider;
    getProviderFor = vi.fn().mockReturnValue({ provider, ...decision });
    const registry = {
      getProvider: vi.fn().mockReturnValue(provider),
      getProviderFor,
      getRegisteredTypes: vi.fn().mockReturnValue([]),
      validateResourceTypes: vi.fn(),
      validateResourceProperties: vi.fn(),
      ccRouteUnavailableReason: vi.fn().mockReturnValue(undefined),
    };
    return new DeployEngine(
      { getState: vi.fn(), saveState: vi.fn().mockResolvedValue('etag') } as unknown as never,
      {
        acquireLockWithRetry: vi.fn().mockResolvedValue(true),
        releaseLock: vi.fn().mockResolvedValue(undefined),
      } as unknown as never,
      {
        buildGraph: vi.fn().mockReturnValue({}),
        getExecutionLevels: vi.fn().mockReturnValue([]),
        getDirectDependencies: vi.fn().mockReturnValue([]),
      } as unknown as never,
      {
        calculateDiff: vi.fn().mockResolvedValue(new Map()),
        hasChanges: vi.fn().mockReturnValue(false),
        filterByType: vi.fn().mockReturnValue([]),
      } as unknown as never,
      registry as unknown as never,
      options,
      'us-east-1'
    );
  }

  async function runUpdate(
    engine: InstanceType<typeof DeployEngine>,
    recordedBy: 'sdk' | 'cc-api' | undefined
  ): Promise<unknown> {
    const change = {
      logicalId: LOGICAL_ID,
      changeType: 'UPDATE',
      resourceType: TYPE,
      currentProperties: RECORDED_PROPS,
      desiredProperties: DESIRED_PROPS,
      propertyChanges: [
        {
          path: 'ArchivePolicy',
          oldValue: undefined,
          newValue: DESIRED_PROPS.ArchivePolicy,
          requiresReplacement: false,
        },
      ],
    } as unknown as ResourceChange;
    const record = {
      physicalId: 'arn:aws:sns:us-east-1:1:t',
      resourceType: TYPE,
      properties: RECORDED_PROPS,
      attributes: {},
      dependencies: [],
      ...(recordedBy !== undefined && { provisionedBy: recordedBy }),
    } as unknown as StateRecord;
    return provisionResource(
      engine,
      LOGICAL_ID,
      change,
      { [LOGICAL_ID]: record },
      STACK,
      {
        Resources: { [LOGICAL_ID]: { Type: TYPE, Properties: DESIRED_PROPS } },
      }
    ).then(
      () => undefined,
      // The engine wraps the provider error as `Failed to update resource <id>`
      // and renders it as `Caused by:`; the cause is the object the note lands on.
      (e: unknown) => (e as { cause?: unknown }).cause
    );
  }

  const AUTO_ROUTED = { provisionedBy: 'cc-api', ccRouteReason: { properties: ['ArchivePolicy'] } };

  it.each([['sdk' as const], [undefined]])(
    'names the move and both flags when the record says %s',
    async (recordedBy) => {
      const thrown = await runUpdate(makeEngine(AUTO_ROUTED), recordedBy);
      // Same object: the class, cause chain and marks downstream read survive.
      expect(thrown).toBe(updateError);
      const message = (thrown as Error).message;
      expect(message.startsWith(AWS_TEXT)).toBe(true);
      expect(message).toContain('moved the resource from its SDK provider to Cloud Control API');
      expect(message).toContain('--recreate-via-cc-api MyTopic');
      expect(message).toContain('--prefer-sdk-route AWS::SNS::Topic:ArchivePolicy');
    }
  );

  // go-to-k/cdkd#2319: the event recorder reduces AWS's own error to its
  // class, so a remedy appended to it would never reach the persisted row.
  it('wraps an AWS-authored update error, keeping the remedy beside its class', async () => {
    stubLogger.debug.mockClear();
    updateError = awsSdkError(
      'User: arn:aws:sts::123456789012:assumed-role/Deployer/s is denied sns:SetTopicAttributes',
      'AccessDeniedException'
    );

    const thrown = (await runUpdate(makeEngine(AUTO_ROUTED), 'sdk')) as Error;

    expect(thrown).not.toBe(updateError);
    expect(thrown.cause).toBe(updateError);
    expect(hasRedactedCause(thrown)).toBe(true);
    expect(
      thrown.message.startsWith(
        "AccessDeniedException. Re-run with --verbose for AWS's own message."
      )
    ).toBe(true);
    expect(thrown.message).toContain('--recreate-via-cc-api MyTopic');
    expect(thrown.message).not.toContain('123456789012');
    expect(extractDeploymentEventError(thrown).message).toContain(
      '--prefer-sdk-route AWS::SNS::Topic:ArchivePolicy'
    );
    const debugLine = stubLogger.debug.mock.calls
      .map(([m]) => String(m))
      .find((m) => m.includes('Deployer'));
    expect(debugLine).toContain('MyTopic: the update failed:');
    expect(extractDeploymentEventError(thrown).name).toBe('AccessDeniedException');
  });

  it('keeps the remedy in the recorded message for a credential resolution failure', async () => {
    updateError = Object.assign(new Error('Could not load credentials from profile arn:aws:iam::123456789012:role/x'), {
      name: 'CredentialsProviderError',
    });

    const thrown = (await runUpdate(makeEngine(AUTO_ROUTED), 'sdk')) as Error;

    expect(thrown.cause).toBe(updateError);
    const recorded = extractDeploymentEventError(thrown);
    expect(recorded.message).toContain('--prefer-sdk-route AWS::SNS::Topic:ArchivePolicy');
    expect(recorded.message).toMatch(/^CredentialsProviderError\. Re-run with --verbose/);
    expect(recorded.message).not.toContain('123456789012');
  });

  it('drops --recreate-via-cc-api inside a nested child engine', async () => {
    const engine = makeEngine(AUTO_ROUTED, {
      parentStackInfo: { parentStack: 'Parent', parentLogicalId: 'Child', parentRegion: 'us-east-1' },
    });
    const message = ((await runUpdate(engine, 'sdk')) as Error).message;
    expect(message).toContain('nested stack');
    expect(message).not.toContain('--recreate-via-cc-api MyTopic');
    expect(message).toContain('--prefer-sdk-route AWS::SNS::Topic:ArchivePolicy');
  });

  it('leaves the message alone for a resource already on Cloud Control', async () => {
    const thrown = await runUpdate(makeEngine(AUTO_ROUTED), 'cc-api');
    expect((thrown as Error).message).toBe(AWS_TEXT);
  });

  it('leaves the message alone when the update stayed on the SDK provider', async () => {
    const thrown = await runUpdate(makeEngine({ provisionedBy: 'sdk' }), 'sdk');
    expect((thrown as Error).message).toBe(AWS_TEXT);
  });

  it('leaves the message alone on a Cloud Control route with no auto-route reason', async () => {
    const thrown = await runUpdate(makeEngine({ provisionedBy: 'cc-api' }), 'sdk');
    expect((thrown as Error).message).toBe(AWS_TEXT);
  });

  it('leaves an interrupt alone: the user stopped it, nothing failed', async () => {
    updateError = new InterruptedWaitError('Cloud Control update');
    const before = updateError.message;
    const thrown = await runUpdate(makeEngine(AUTO_ROUTED), 'sdk');
    expect((thrown as Error).message).toBe(before);
  });

  it('leaves an abandoned wait alone: the update may still be running', async () => {
    updateError = markWaitAbandoned(new Error('Cloud Control wait abandoned'));
    const thrown = await runUpdate(makeEngine(AUTO_ROUTED), 'sdk');
    expect((thrown as Error).message).toBe('Cloud Control wait abandoned');
  });
});
