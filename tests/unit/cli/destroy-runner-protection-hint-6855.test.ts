import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { ResourceState, StackState } from '../../../src/types/state.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import type { LockManager } from '../../../src/state/lock-manager.js';
import type { ProviderRegistry } from '../../../src/provisioning/provider-registry.js';
import type { AwsClients } from '../../../src/utils/aws-clients.js';

// go-to-k/cdkd#6855: a delete AWS refused for the resource's deletion
// protection printed only AWS's error code. The runner now prints a cdkd line
// naming the protection and --remove-protection under the failure.

const errorSpy = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: errorSpy,
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }),
}));
vi.mock('../../../src/provisioning/register-providers.js', () => ({
  loadProviderClasses: vi.fn(async () => ({})),
  registerAllProviders: vi.fn(),
}));
vi.mock('../../../src/provisioning/provider-registry.js', () => ({
  ProviderRegistry: vi.fn(),
}));
vi.mock('../../../src/utils/aws-clients.js', () => ({
  AwsClients: vi.fn(),
  setAwsClients: vi.fn(),
  getAwsClients: vi.fn(),
}));
vi.mock('../../../src/utils/live-renderer.js', () => ({
  getLiveRenderer: () => ({
    start: vi.fn(),
    stop: vi.fn(),
    addTask: vi.fn(),
    removeTask: vi.fn(),
    updateTaskLabel: vi.fn(),
    printAbove: (write: () => void) => write(),
  }),
}));

import { runDestroyForStack } from '../../../src/cli/commands/destroy-runner.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';

const REGION = 'us-east-1';
const HINT = 'Re-run the destroy with --remove-protection';

function poolState(): StackState {
  const pool: ResourceState = {
    physicalId: 'us-east-1_abc',
    resourceType: 'AWS::Cognito::UserPool',
    properties: {},
    attributes: {},
    dependencies: [],
  };
  return {
    version: 8,
    stackName: 'TestStack',
    region: REGION,
    resources: { Pool: pool },
    outputs: {},
    lastModified: 1,
  };
}

/** The provider's throw: cdkd's wrapper around the SDK error, as `cause`. */
function providerError(awsMessage: string): ProvisioningError {
  const aws = new Error(awsMessage);
  aws.name = 'InvalidParameterException';
  (aws as Error & { $metadata: unknown }).$metadata = { httpStatusCode: 400 };
  return new ProvisioningError(
    "Failed to delete Cognito User Pool Pool: InvalidParameterException. Re-run with --verbose for AWS's own message.",
    'AWS::Cognito::UserPool',
    'Pool',
    'us-east-1_abc',
    aws
  );
}

describe('runDestroyForStack names deletion protection on a refused delete (#6855)', () => {
  const providerDelete = vi.fn();

  function ctx(removeProtection?: boolean) {
    const state = poolState();
    return {
      stateBackend: {
        saveState: vi.fn().mockResolvedValue('"etag"'),
        deleteState: vi.fn().mockResolvedValue(undefined),
        getState: vi.fn(async () => ({ state, etag: 'e' })),
        listStacks: vi.fn().mockResolvedValue([]),
      } as unknown as S3StateBackend,
      lockManager: {
        acquireLock: vi.fn().mockResolvedValue(true),
        releaseLock: vi.fn(),
      } as unknown as LockManager,
      providerRegistry: {
        getProviderFor: () => ({ provider: { delete: providerDelete, disableOuterRetry: true } }),
      } as unknown as ProviderRegistry,
      baseAwsClients: {} as AwsClients,
      baseRegion: REGION,
      stateBucket: 'test-bucket',
      skipConfirmation: true,
      ...(removeProtection !== undefined && { removeProtection }),
      state,
    };
  }

  const errorText = (): string => errorSpy.mock.calls.map((c) => c.map(String).join(' ')).join('\n');

  beforeEach(() => {
    errorSpy.mockReset();
    providerDelete.mockReset();
  });

  it('prints the hint under the failure line when AWS refused for deletion protection', async () => {
    providerDelete.mockRejectedValue(
      providerError('The user pool cannot be deleted because deletion protection is activated.')
    );
    const c = ctx();
    const result = await runDestroyForStack('TestStack', c.state, c);
    expect(result.errorCount).toBe(1);
    expect(errorText()).toContain('Failed to delete Pool');
    expect(errorText()).toContain(HINT);
  });

  it('prints no hint when --remove-protection was passed', async () => {
    providerDelete.mockRejectedValue(
      providerError('The user pool cannot be deleted because deletion protection is activated.')
    );
    const c = ctx(true);
    await runDestroyForStack('TestStack', c.state, c);
    expect(errorText()).toContain('Failed to delete Pool');
    expect(errorText()).not.toContain(HINT);
  });

  it('prints no hint for a refusal with another cause', async () => {
    providerDelete.mockRejectedValue(providerError('The user pool has a domain configured.'));
    const c = ctx();
    await runDestroyForStack('TestStack', c.state, c);
    expect(errorText()).toContain('Failed to delete Pool');
    expect(errorText()).not.toContain(HINT);
  });
});
