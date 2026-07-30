import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const mockCloudControlSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    cloudControl: {
      send: mockCloudControlSend,
      config: { region: () => Promise.resolve('us-east-1') },
    },
    ec2: { send: vi.fn(), config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('../../../src/deployment/intrinsic-function-resolver.js', () => ({
  getAccountInfo: () =>
    Promise.resolve({ partition: 'aws', region: 'us-east-1', accountId: '123456789012' }),
}));

const mockWarn = vi.fn();
vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => {
    const child = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: mockWarn,
      error: vi.fn(),
      child: vi.fn(() => child),
    };
    return { child: () => child, debug: vi.fn(), info: vi.fn(), warn: mockWarn, error: vi.fn() };
  },
}));

import { CloudControlProvider } from '../../../src/provisioning/cloud-control-provider.js';
import { ccProtectionProperty } from '../../../src/provisioning/cc-protection-properties.js';

const CLUSTER_ID = 'abc123xyz';
const DSQL = 'AWS::DSQL::Cluster';

// Wires the cloudControl mock: UpdateResource / DeleteResource each return a
// token, GetResourceRequestStatus reports SUCCESS. `updateRejects` makes the
// UpdateResource send itself reject (the protection-flip failure path).
function wireCloudControl(options: { updateRejects?: boolean } = {}): void {
  mockCloudControlSend.mockImplementation((cmd: { constructor: { name: string } }) => {
    const name = cmd.constructor.name;
    if (name === 'UpdateResourceCommand') {
      if (options.updateRejects) {
        return Promise.reject(new Error('AccessDeniedException: not authorized'));
      }
      return Promise.resolve({ ProgressEvent: { RequestToken: 'tok-update' } });
    }
    if (name === 'DeleteResourceCommand') {
      return Promise.resolve({ ProgressEvent: { RequestToken: 'tok-delete' } });
    }
    if (name === 'GetResourceRequestStatusCommand') {
      return Promise.resolve({ ProgressEvent: { OperationStatus: 'SUCCESS' } });
    }
    return Promise.resolve({});
  });
}

const callNames = (): string[] =>
  mockCloudControlSend.mock.calls.map((c) => c[0]?.constructor?.name as string);
const callsOf = (cmdName: string) =>
  mockCloudControlSend.mock.calls.filter((c) => c[0]?.constructor?.name === cmdName);

describe('ccProtectionProperty registry', () => {
  it('returns DeletionProtectionEnabled for AWS::DSQL::Cluster', () => {
    expect(ccProtectionProperty(DSQL)).toBe('DeletionProtectionEnabled');
  });

  it('returns undefined for types without a registered protection property', () => {
    expect(ccProtectionProperty('AWS::SQS::Queue')).toBeUndefined();
    expect(ccProtectionProperty('AWS::EC2::Instance')).toBeUndefined();
    expect(ccProtectionProperty('AWS::AutoScaling::AutoScalingGroup')).toBeUndefined();
  });
});

describe('CloudControlProvider delete: --remove-protection generic CC protection flip', () => {
  let provider: CloudControlProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new CloudControlProvider();
    (provider as unknown as { sleep: (ms: number) => Promise<void> }).sleep = vi.fn(() =>
      Promise.resolve()
    );
  });

  it('patches the protection property off (waited) BEFORE DeleteResource for a registered type', async () => {
    wireCloudControl();

    await provider.delete('Cluster', CLUSTER_ID, DSQL, undefined, { removeProtection: true });

    const updates = callsOf('UpdateResourceCommand');
    expect(updates).toHaveLength(1);
    expect(updates[0]![0].input).toEqual({
      TypeName: DSQL,
      Identifier: CLUSTER_ID,
      PatchDocument: JSON.stringify([
        { op: 'add', path: '/DeletionProtectionEnabled', value: false },
      ]),
    });
    expect(callsOf('DeleteResourceCommand')).toHaveLength(1);

    // The flip (and its status wait) must complete before the delete starts.
    const names = callNames();
    expect(names.indexOf('UpdateResourceCommand')).toBeLessThan(
      names.indexOf('DeleteResourceCommand')
    );
    const statusBeforeDelete = names
      .slice(0, names.indexOf('DeleteResourceCommand'))
      .filter((n) => n === 'GetResourceRequestStatusCommand');
    expect(statusBeforeDelete.length).toBeGreaterThanOrEqual(1);
  });

  it('does NOT patch when removeProtection is not set (protected delete fails fast)', async () => {
    wireCloudControl();

    await provider.delete('Cluster', CLUSTER_ID, DSQL, undefined, { removeProtection: false });

    expect(callsOf('UpdateResourceCommand')).toHaveLength(0);
    expect(callsOf('DeleteResourceCommand')).toHaveLength(1);
  });

  it('does NOT patch unregistered types even with removeProtection', async () => {
    wireCloudControl();

    await provider.delete('Queue', 'my-queue', 'AWS::SQS::Queue', undefined, {
      removeProtection: true,
    });

    expect(callsOf('UpdateResourceCommand')).toHaveLength(0);
    expect(callsOf('DeleteResourceCommand')).toHaveLength(1);
  });

  it('a flip response without a request token warns and still proceeds to DeleteResource', async () => {
    mockCloudControlSend.mockImplementation((cmd: { constructor: { name: string } }) => {
      const name = cmd.constructor.name;
      if (name === 'UpdateResourceCommand') {
        return Promise.resolve({ ProgressEvent: {} });
      }
      if (name === 'DeleteResourceCommand') {
        return Promise.resolve({ ProgressEvent: { RequestToken: 'tok-delete' } });
      }
      if (name === 'GetResourceRequestStatusCommand') {
        return Promise.resolve({ ProgressEvent: { OperationStatus: 'SUCCESS' } });
      }
      return Promise.resolve({});
    });

    await provider.delete('Cluster', CLUSTER_ID, DSQL, undefined, { removeProtection: true });

    expect(callsOf('DeleteResourceCommand')).toHaveLength(1);
    expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining('no request token received'));
  });

  it('a failed protection flip warns and still proceeds to DeleteResource', async () => {
    wireCloudControl({ updateRejects: true });

    await provider.delete('Cluster', CLUSTER_ID, DSQL, undefined, { removeProtection: true });

    expect(callsOf('UpdateResourceCommand')).toHaveLength(1);
    expect(callsOf('DeleteResourceCommand')).toHaveLength(1);
    expect(mockWarn).toHaveBeenCalledWith(
      expect.stringContaining('Could not disable DeletionProtectionEnabled')
    );
  });
});
