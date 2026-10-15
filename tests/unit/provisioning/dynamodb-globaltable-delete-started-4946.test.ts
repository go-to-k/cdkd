import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import {
  DescribeTableCommand,
  DeleteTableCommand,
  UpdateTableCommand,
  ResourceNotFoundException,
} from '@aws-sdk/client-dynamodb';
import {
  DeleteScalingPolicyCommand,
  DeregisterScalableTargetCommand,
} from '@aws-sdk/client-application-auto-scaling';

const { mockSend, mockAutoScalingSend } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  mockAutoScalingSend: vi.fn(),
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    dynamoDB: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('@aws-sdk/client-dynamodb', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-dynamodb')>(
    '@aws-sdk/client-dynamodb'
  );
  return {
    ...actual,
    DynamoDBClient: vi.fn().mockImplementation((cfg: { region?: string } | undefined) => ({
      send: mockSend,
      config: { region: () => Promise.resolve(cfg?.region ?? 'us-east-1') },
    })),
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  const logger: Record<string, unknown> = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  logger['child'] = () => logger;
  return { getLogger: () => logger };
});

vi.mock('@aws-sdk/client-application-auto-scaling', async () => {
  const actual = await vi.importActual<
    typeof import('@aws-sdk/client-application-auto-scaling')
  >('@aws-sdk/client-application-auto-scaling');
  return {
    ...actual,
    ApplicationAutoScalingClient: vi.fn().mockImplementation(() => ({
      send: mockAutoScalingSend,
    })),
  };
});

import {
  DynamoDBGlobalTableProvider,
  autoScalingRetryDelays,
  deleteTableRetryDelays,
} from '../../../src/provisioning/providers/dynamodb-globaltable-provider.js';
import { isDeleteStarted } from '../../../src/provisioning/delete-started.js';
import { replacedDeleteFailureVerdict } from '../../../src/deployment/rollback-executor/replaced-survivor.js';

const TYPE = 'AWS::DynamoDB::GlobalTable';
const TABLE = 'orders';

function accessDenied(op: string): Error {
  return Object.assign(new Error(`User is not authorized to perform: dynamodb:${op}`), {
    name: 'AccessDeniedException',
  });
}

interface Script {
  /** Replica regions besides the local us-east-1. */
  remote?: string[];
  /** What the pre-delete DescribeTable answers instead of the table. */
  describe?: 'denied' | 'gone';
  /** Whether the remote replica removal (UpdateTable ReplicaUpdates) is refused. */
  replicaRemovalDenied?: boolean;
}

/** Answer a GlobalTable delete per `s`; DeleteTable is always refused. */
function script(s: Script): void {
  const remote = new Set(s.remote ?? []);
  mockSend.mockImplementation((cmd: unknown) => {
    if (cmd instanceof DescribeTableCommand) {
      if (s.describe === 'denied') return Promise.reject(accessDenied('DescribeTable'));
      if (s.describe === 'gone') {
        return Promise.reject(new ResourceNotFoundException({ message: 'gone', $metadata: {} }));
      }
      return Promise.resolve({
        Table: {
          TableName: TABLE,
          TableStatus: 'ACTIVE',
          GlobalSecondaryIndexes: [],
          Replicas: [
            { RegionName: 'us-east-1', ReplicaStatus: 'ACTIVE' },
            ...[...remote].map((RegionName) => ({ RegionName, ReplicaStatus: 'ACTIVE' })),
          ],
        },
      });
    }
    if (cmd instanceof UpdateTableCommand) {
      const removed = cmd.input.ReplicaUpdates?.[0]?.Delete?.RegionName;
      if (removed !== undefined) {
        if (s.replicaRemovalDenied === true) return Promise.reject(accessDenied('UpdateTable'));
        remote.delete(removed);
      }
      return Promise.resolve({});
    }
    if (cmd instanceof DeleteTableCommand) return Promise.reject(accessDenied('DeleteTable'));
    return Promise.reject(new Error(`unexpected command ${String(cmd)}`));
  });
}

function sent(command: abstract new (...args: never[]) => unknown): unknown[] {
  return mockSend.mock.calls.filter((c) => c[0] instanceof command).map((c) => c[0]);
}

function autoScalingTeardowns(): number {
  return mockAutoScalingSend.mock.calls.filter(
    (c) => c[0] instanceof DeleteScalingPolicyCommand || c[0] instanceof DeregisterScalableTargetCommand
  ).length;
}

async function deleteError(): Promise<unknown> {
  return new DynamoDBGlobalTableProvider().delete('Table', TABLE, TYPE, {}, {
    expectedRegion: 'us-east-1',
  }).then(
    () => {
      throw new Error('delete resolved');
    },
    (error: unknown) => error
  );
}

describe('DynamoDBGlobalTableProvider.delete marks a refusal after a teardown (go-to-k/cdkd#4946)', () => {
  beforeEach(() => {
    mockSend.mockReset();
    mockAutoScalingSend.mockReset();
    mockAutoScalingSend.mockResolvedValue({ ScalableTargets: [], ScalingPolicies: [] });
    autoScalingRetryDelays.sleep = () => Promise.resolve();
    deleteTableRetryDelays.sleep = () => Promise.resolve();
  });

  afterEach(() => {
    delete autoScalingRetryDelays.sleep;
    delete deleteTableRetryDelays.sleep;
  });

  it('marks a refused DeleteTable once the local autoscaling teardown removed a policy and target', async () => {
    script({});

    const err = await deleteError();

    expect(autoScalingTeardowns()).toBeGreaterThan(0);
    expect(sent(DeleteTableCommand)).toHaveLength(1);
    expect(isDeleteStarted(err)).toBe(true);
    expect(replacedDeleteFailureVerdict(err)).toBe('unconfirmed');
  });

  it('marks a refused DeleteTable once a remote replica was removed', async () => {
    script({ remote: ['us-west-2'] });

    const err = await deleteError();

    const removals = sent(UpdateTableCommand).filter(
      (c) => (c as UpdateTableCommand).input.ReplicaUpdates !== undefined
    );
    expect(removals).toHaveLength(1);
    expect(sent(DeleteTableCommand)).toHaveLength(1);
    expect(isDeleteStarted(err)).toBe(true);
    expect(replacedDeleteFailureVerdict(err)).toBe('unconfirmed');
  });

  it('marks a refused replica removal once that replica\'s autoscaling teardown removed its target', async () => {
    script({ remote: ['us-west-2'], replicaRemovalDenied: true });

    const err = await deleteError();

    expect(sent(DeleteTableCommand)).toHaveLength(0);
    expect(isDeleteStarted(err)).toBe(true);
    expect(replacedDeleteFailureVerdict(err)).toBe('unconfirmed');
  });

  const named = (name: string): Error =>
    Object.assign(new Error(`${name} from application-autoscaling`), {
      name,
      $metadata: { httpStatusCode: 400 },
    });

  it('leaves a refused DeleteTable unmarked when the teardown found nothing to remove (kept)', async () => {
    mockAutoScalingSend.mockRejectedValue(named('ObjectNotFoundException'));
    script({});

    const err = await deleteError();

    expect(autoScalingTeardowns()).toBeGreaterThan(0);
    expect(sent(DeleteTableCommand)).toHaveLength(1);
    expect(isDeleteStarted(err)).toBe(false);
    expect(replacedDeleteFailureVerdict(err)).toBe('kept');
  });

  it('leaves it unmarked when AWS refused the teardown by name (kept)', async () => {
    mockAutoScalingSend.mockRejectedValue(named('AccessDeniedException'));
    script({});

    const err = await deleteError();

    expect(sent(DeleteTableCommand)).toHaveLength(1);
    expect(isDeleteStarted(err)).toBe(false);
    expect(replacedDeleteFailureVerdict(err)).toBe('kept');
  });

  it('marks it when a swallowed teardown failure may have landed (unconfirmed)', async () => {
    mockAutoScalingSend.mockRejectedValue(named('InternalServiceException'));
    script({});

    const err = await deleteError();

    expect(sent(DeleteTableCommand)).toHaveLength(1);
    expect(isDeleteStarted(err)).toBe(true);
    expect(replacedDeleteFailureVerdict(err)).toBe('unconfirmed');
  });

  it('marks a refused DeleteTable once a replica removal was accepted, with nothing for the teardown to remove', async () => {
    mockAutoScalingSend.mockRejectedValue(named('ObjectNotFoundException'));
    script({ remote: ['us-west-2'] });

    const err = await deleteError();

    expect(sent(DeleteTableCommand)).toHaveLength(1);
    expect(isDeleteStarted(err)).toBe(true);
    expect(replacedDeleteFailureVerdict(err)).toBe('unconfirmed');
  });

  it('leaves a refused replica removal unmarked when its teardown found nothing (kept)', async () => {
    mockAutoScalingSend.mockRejectedValue(named('ObjectNotFoundException'));
    script({ remote: ['us-west-2'], replicaRemovalDenied: true });

    const err = await deleteError();

    expect(sent(DeleteTableCommand)).toHaveLength(0);
    expect(isDeleteStarted(err)).toBe(false);
    expect(replacedDeleteFailureVerdict(err)).toBe('kept');
  });

  it('leaves a refused pre-delete DescribeTable (before any teardown) unmarked (kept)', async () => {
    script({ describe: 'denied' });

    const err = await deleteError();

    expect(autoScalingTeardowns()).toBe(0);
    expect(sent(DeleteTableCommand)).toHaveLength(0);
    expect(isDeleteStarted(err)).toBe(false);
    expect(replacedDeleteFailureVerdict(err)).toBe('kept');
  });

  it('leaves a refused DeleteTable unmarked when the describe found no table, so nothing was torn down (kept)', async () => {
    script({ describe: 'gone' });

    const err = await deleteError();

    expect(autoScalingTeardowns()).toBe(0);
    expect(sent(DeleteTableCommand)).toHaveLength(1);
    expect(isDeleteStarted(err)).toBe(false);
    expect(replacedDeleteFailureVerdict(err)).toBe('kept');
  });
});
