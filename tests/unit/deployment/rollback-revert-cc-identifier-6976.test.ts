import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  replayRollback,
  type CompletedOperation,
  type RollbackExecutorContext,
} from '../../../src/deployment/rollback-executor.js';
import type { ResourceState } from '../../../src/types/state.js';

/**
 * go-to-k/cdkd#6976: an in-place UPDATE revert routed to Cloud Control over a
 * record its SDK provider still owns is addressed by the Cloud Control
 * identifier; a record already owned by Cloud Control, or an SDK-routed revert,
 * keeps the recorded physical id.
 */

const { getPrimaryIdentifierFields } = vi.hoisted(() => ({
  getPrimaryIdentifierFields: vi.fn(),
}));

vi.mock('../../../src/provisioning/cc-import-identifier.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/provisioning/cc-import-identifier.js')>();
  return { ...actual, getPrimaryIdentifierFields };
});

vi.mock('../../../src/deployment/retry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/deployment/retry.js')>();
  return { ...actual, withRetry: vi.fn((fn: () => Promise<unknown>) => fn()) };
});

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({ secretsManager: { send: vi.fn() }, ssm: { send: vi.fn() } }),
  setAwsClients: vi.fn(),
  AwsClients: vi.fn(),
}));

const DEPLOYMENT = 'AWS::ApiGateway::Deployment';

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  setLevel: vi.fn(),
  child: () => logger,
} as unknown as RollbackExecutorContext['logger'];

function res(
  provisionedBy: 'sdk' | 'cc-api',
  physicalId: string,
  description: string
): ResourceState {
  return {
    physicalId,
    resourceType: DEPLOYMENT,
    properties: { RestApiId: 'r1', Description: description },
    attributes: {},
    dependencies: [],
    provisionedBy,
  };
}

function ctxWith(
  update: ReturnType<typeof vi.fn>,
  route: 'sdk' | 'cc-api'
): RollbackExecutorContext {
  return {
    region: 'us-east-1',
    logger,
    providerRegistry: {
      getProviderFor: () => ({
        provider: { update, create: vi.fn(), delete: vi.fn() },
        provisionedBy: route,
      }),
    } as unknown as RollbackExecutorContext['providerRegistry'],
    recordEvent: () => {},
  };
}

function completed(physicalId: string): CompletedOperation {
  return {
    logicalId: 'Dep',
    changeType: 'UPDATE',
    resourceType: DEPLOYMENT,
    physicalId,
    previousState: res('sdk', physicalId, 'old'),
    properties: { RestApiId: 'r1', Description: 'new' },
    oldResourceRetained: false,
  };
}

describe('rollback revert Cloud Control identifier (go-to-k/cdkd#6976)', () => {
  beforeEach(() => {
    getPrimaryIdentifierFields.mockReset();
    getPrimaryIdentifierFields.mockImplementation(async (type: string) =>
      type === DEPLOYMENT ? ['DeploymentId', 'RestApiId'] : undefined
    );
  });

  it('addresses an SDK-recorded resource by the Cloud Control identifier when the revert routes to cc-api', async () => {
    const update = vi.fn().mockResolvedValue({ physicalId: 'dep1' });
    await replayRollback(
      [completed('dep1')],
      { Dep: res('sdk', 'dep1', 'new') },
      'S',
      ctxWith(update, 'cc-api')
    );
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0]![1]).toBe('dep1|r1');
  });

  it('keeps the physical id of a record already owned by cc-api', async () => {
    const update = vi.fn().mockResolvedValue({ physicalId: 'dep1|r1' });
    await replayRollback(
      [completed('dep1|r1')],
      { Dep: res('cc-api', 'dep1|r1', 'new') },
      'S',
      ctxWith(update, 'cc-api')
    );
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0]![1]).toBe('dep1|r1');
    expect(getPrimaryIdentifierFields).not.toHaveBeenCalled();
  });

  it('keeps the physical id when the revert routes to the SDK provider', async () => {
    const update = vi.fn().mockResolvedValue({ physicalId: 'dep1' });
    await replayRollback(
      [completed('dep1')],
      { Dep: res('sdk', 'dep1', 'new') },
      'S',
      ctxWith(update, 'sdk')
    );
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0]![1]).toBe('dep1');
  });
});
