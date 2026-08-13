import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

/**
 * Issue #1778 class 1: `CloudControlProvider` runs ANOTHER provider's delete in
 * two places and used to discard the `ResourceDeleteResult` at both.
 *
 * 1. The `--remove-protection` ASG DELEGATION (`new ASGProvider().delete(...)`)
 *    — a skip inside the delegate surfaced to the destroy runner as a plain
 *    successful delete, the exact mis-report issue #1752 exists to prevent, one
 *    level up. The contract chosen is PROPAGATE (matching
 *    `NestedStackProvider.delete`); this suite pins it in both directions.
 * 2. `cleanupFailedCreateRemnant`'s SELF-cleanup of a failed-create remnant —
 *    the result cannot reach the destroy runner's counters (it is a CREATE
 *    path), but a skip means the remnant's NAME is still taken, so the debug
 *    line asserting the remnant was removed had to stop being emitted for it.
 *
 * Both are LATENT today, so the skip is constructed by mocking the delegate /
 * the provider's own delete.
 */

const mockCloudControlSend = vi.hoisted(() => vi.fn());
const mockAsgDelete = vi.hoisted(() => vi.fn());
const warnSpy = vi.hoisted(() => vi.fn());
const debugSpy = vi.hoisted(() => vi.fn());

vi.mock('../../../src/provisioning/providers/asg-provider.js', () => ({
  ASGProvider: vi.fn().mockImplementation(() => ({ delete: mockAsgDelete })),
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    cloudControl: {
      send: mockCloudControlSend,
      config: { region: () => Promise.resolve('us-east-1') },
    },
    ec2: { send: vi.fn(), config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const child = {
    debug: debugSpy,
    info: vi.fn(),
    warn: warnSpy,
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => child,
      debug: debugSpy,
      info: vi.fn(),
      warn: warnSpy,
      error: vi.fn(),
    }),
  };
});

import { CloudControlProvider } from '../../../src/provisioning/cloud-control-provider.js';

const ASG_TYPE = 'AWS::AutoScaling::AutoScalingGroup';
const ASG_NAME = 'my-asg';
const SKIP_REASON = 'ASG could not be addressed — no delete issued';

function warnings(): string[] {
  return warnSpy.mock.calls.map((call) => String(call[0]));
}

function debugLines(): string[] {
  return debugSpy.mock.calls.map((call) => String(call[0]));
}

describe('CloudControlProvider delegates the protected-ASG delete and PROPAGATES its outcome (issue #1778)', () => {
  let provider: CloudControlProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockCloudControlSend.mockReset();
    mockAsgDelete.mockReset();
    provider = new CloudControlProvider();
  });

  it("returns the delegate's 'skipped' outcome instead of a bare void", async () => {
    mockAsgDelete.mockResolvedValue({ outcome: 'skipped', reason: SKIP_REASON });

    const result = await provider.delete('MyAsg', ASG_NAME, ASG_TYPE, undefined, {
      removeProtection: true,
    });

    expect(result).toEqual({ outcome: 'skipped', reason: SKIP_REASON });
    expect(mockAsgDelete).toHaveBeenCalledTimes(1);
    // The delegation must not ALSO issue a Cloud Control DeleteResource.
    expect(mockCloudControlSend).not.toHaveBeenCalled();
  });

  it('INVERTED CONTROL — a delegate that deletes normally reports no skip', async () => {
    mockAsgDelete.mockResolvedValue(undefined);

    const result = await provider.delete('MyAsg', ASG_NAME, ASG_TYPE, undefined, {
      removeProtection: true,
    });

    expect(result).toBeUndefined();
    expect(mockAsgDelete).toHaveBeenCalledTimes(1);
    expect(mockCloudControlSend).not.toHaveBeenCalled();
  });

  it("propagates an explicit 'deleted' outcome verbatim", async () => {
    mockAsgDelete.mockResolvedValue({ outcome: 'deleted' });

    const result = await provider.delete('MyAsg', ASG_NAME, ASG_TYPE, undefined, {
      removeProtection: true,
    });

    expect(result).toEqual({ outcome: 'deleted' });
  });

  it('forwards logicalId / physicalId / type / properties / context to the delegate', async () => {
    mockAsgDelete.mockResolvedValue(undefined);
    const properties = { AutoScalingGroupName: ASG_NAME };

    await provider.delete('MyAsg', ASG_NAME, ASG_TYPE, properties, {
      removeProtection: true,
      expectedRegion: 'us-east-1',
    });

    expect(mockAsgDelete).toHaveBeenCalledWith('MyAsg', ASG_NAME, ASG_TYPE, properties, {
      removeProtection: true,
      expectedRegion: 'us-east-1',
    });
  });
});

describe('CloudControlProvider failed-create remnant cleanup reports a skipped self-delete (issue #1778)', () => {
  const RESOURCE_TYPE = 'AWS::Synthetics::Canary';
  const REMNANT = 'my-canary';

  let provider: CloudControlProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockCloudControlSend.mockReset();
    mockAsgDelete.mockReset();
    provider = new CloudControlProvider();
  });

  /**
   * Drive `create()` to the failed-async-CREATE arm that runs
   * `cleanupFailedCreateRemnant`: the CreateResource returns a token, the
   * status poll reports FAILED carrying the materialized identifier.
   */
  async function runFailedCreate(): Promise<unknown> {
    mockCloudControlSend.mockImplementation((cmd: { constructor: { name: string } }) => {
      const name = cmd.constructor.name;
      if (name === 'CreateResourceCommand') {
        return Promise.resolve({ ProgressEvent: { RequestToken: 'tok-1' } });
      }
      if (name === 'GetResourceRequestStatusCommand') {
        return Promise.resolve({
          ProgressEvent: {
            OperationStatus: 'FAILED',
            StatusMessage: 'Resource stabilization failed',
            ErrorCode: 'GeneralServiceException',
            TypeName: RESOURCE_TYPE,
            Identifier: REMNANT,
          },
        });
      }
      return Promise.resolve({});
    });

    return provider.create('MyCanary', RESOURCE_TYPE, { Name: REMNANT }).then(
      () => undefined,
      (err: unknown) => err
    );
  }

  it('warns that the remnant is still there instead of claiming it was removed', async () => {
    const deleteSpy = vi
      .spyOn(provider, 'delete')
      .mockResolvedValue({ outcome: 'skipped', reason: SKIP_REASON });

    const error = await runFailedCreate();

    // The original create error still surfaces — cleanup never masks it.
    expect(error).toBeInstanceOf(Error);
    expect(deleteSpy).toHaveBeenCalledTimes(1);

    const skipWarnings = warnings().filter((m) => m.includes('Skipped deleting the remnant'));
    expect(skipWarnings).toHaveLength(1);
    expect(skipWarnings[0]).toContain(REMNANT);
    expect(skipWarnings[0]).toContain(SKIP_REASON);
    expect(skipWarnings[0]).toContain('AlreadyExists');

    // The "removed" claim must NOT be emitted for a skip.
    expect(debugLines().some((m) => m.includes('Removed failed-create remnant'))).toBe(false);
  });

  it('INVERTED CONTROL — a successful remnant delete still logs the removal and warns nothing', async () => {
    const deleteSpy = vi.spyOn(provider, 'delete').mockResolvedValue(undefined);

    const error = await runFailedCreate();

    expect(error).toBeInstanceOf(Error);
    expect(deleteSpy).toHaveBeenCalledTimes(1);
    expect(debugLines().some((m) => m.includes('Removed failed-create remnant'))).toBe(true);
    expect(warnings().filter((m) => m.includes('Skipped deleting the remnant'))).toHaveLength(0);
  });
});
