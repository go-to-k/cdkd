/**
 * The `CloudControlProvider` class keeps one delegator per method whose body
 * moved into `src/provisioning/cloud-control/` (go-to-k/cdkd#5835): each is
 * `return f.call(this, <its own parameters>)`. A delegator that swaps two
 * same-typed arguments, or drops one, still type-checks.
 *
 * Mutation probes found these hand-offs unpinned by every other suite: the
 * argument reaches only an error's fields, a request, or a helper. Each case
 * here calls the method through the instance, as the class's own code does,
 * and asserts where that argument lands.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

const { mockCloudControlSend, ccRegion, mockS3Send, ec2Region } = vi.hoisted(() => ({
  mockCloudControlSend: vi.fn(),
  ccRegion: vi.fn(),
  mockS3Send: vi.fn(),
  ec2Region: vi.fn(),
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    cloudControl: { send: mockCloudControlSend, config: { region: ccRegion } },
    s3: { send: mockS3Send },
    ec2: { send: vi.fn(), config: { region: ec2Region } },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => {
    const child = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn(() => child),
    };
    return { child: () => child, debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  },
}));

import { CloudControlProvider } from '../../../src/provisioning/cloud-control-provider.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';
import type { DeleteContext } from '../../../src/provisioning/region-check.js';
import type { CreateContext } from '../../../src/types/resource.js';

/** The class's own members, reached the way its moved bodies reach them. */
interface Members {
  sdkDeleteDelegateInCcRegion(t: string, l: string, p: string): Promise<unknown>;
  ec2ClientInCcRegion(t: string, l: string, p: string): Promise<unknown>;
  confirmDeleteTargetIdentity(
    l: string,
    t: string,
    p: string,
    context?: DeleteContext
  ): Promise<unknown>;
  getResourceState(t: string, p: string): Promise<unknown>;
  resumeCreatedResource(
    l: string,
    t: string,
    id: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<unknown>;
  handleError(e: unknown, op: string, t: string, l: string, p?: string): never;
  maskDeployedNonAttributeKeys(...args: unknown[]): Promise<Record<string, unknown>>;
}

const LOGICAL = 'MyLogical';
const PHYSICAL = 'my-physical-id';

async function rejection(promise: Promise<unknown>): Promise<ProvisioningError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e
  );
  expect(error).toBeInstanceOf(ProvisioningError);
  return error as ProvisioningError;
}

function sentInput(): Record<string, unknown> {
  const call = mockCloudControlSend.mock.calls[0];
  return (call?.[0] as { input: Record<string, unknown> }).input;
}

describe('CloudControlProvider delegators hand each argument to its body (#5835)', () => {
  let provider: CloudControlProvider;
  let members: Members;

  beforeEach(() => {
    vi.clearAllMocks();
    ccRegion.mockResolvedValue('us-east-1');
    ec2Region.mockResolvedValue('us-east-1');
    provider = new CloudControlProvider();
    members = provider as unknown as Members;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sdkDeleteDelegateInCcRegion: the refusal names the logical and physical ids in place', async () => {
    ccRegion.mockResolvedValue('');
    const error = await rejection(
      members.sdkDeleteDelegateInCcRegion('AWS::RDS::DBCluster', LOGICAL, PHYSICAL)
    );
    expect(error.logicalId).toBe(LOGICAL);
    expect(error.physicalId).toBe(PHYSICAL);
    expect(error.message).toContain(`Refusing to delete ${LOGICAL} (AWS::RDS::DBCluster, ${PHYSICAL})`);
  });

  it('ec2ClientInCcRegion: the refusal names the logical and physical ids in place', async () => {
    ec2Region.mockResolvedValue('eu-west-1');
    const error = await rejection(
      members.ec2ClientInCcRegion('AWS::EC2::Volume', LOGICAL, PHYSICAL)
    );
    expect(error.logicalId).toBe(LOGICAL);
    expect(error.physicalId).toBe(PHYSICAL);
    expect(error.message).toContain(`Refusing to delete ${LOGICAL} (AWS::EC2::Volume, ${PHYSICAL})`);
  });

  it("confirmDeleteTargetIdentity: compares against the context's recorded region", async () => {
    // The client is in us-east-1 and the bucket in eu-west-1; the state
    // records eu-west-1. Only the recorded region confirms the target, so a
    // dropped `context` falls back to the client and refuses.
    mockS3Send.mockResolvedValue({ LocationConstraint: 'eu-west-1' });
    await expect(
      members.confirmDeleteTargetIdentity(LOGICAL, 'AWS::S3::Bucket', PHYSICAL, {
        expectedRegion: 'eu-west-1',
      })
    ).resolves.toBeUndefined();
    const probe = mockS3Send.mock.calls[0]?.[0] as { input: { Bucket: string } };
    expect(probe.input.Bucket).toBe(PHYSICAL);
  });

  it('getResourceState: sends the type and the identifier in place', async () => {
    mockCloudControlSend.mockResolvedValue({ ResourceDescription: { Properties: '{"A":1}' } });
    await members.getResourceState('AWS::Logs::LogGroup', PHYSICAL);
    expect(sentInput()).toMatchObject({ TypeName: 'AWS::Logs::LogGroup', Identifier: PHYSICAL });
  });

  it('readCurrentState: reads the physical id, not the logical id', async () => {
    mockCloudControlSend.mockResolvedValue({ ResourceDescription: { Properties: '{"A":1}' } });
    await provider.readCurrentState(PHYSICAL, LOGICAL, 'AWS::Logs::LogGroup');
    expect(sentInput()).toMatchObject({ TypeName: 'AWS::Logs::LogGroup', Identifier: PHYSICAL });
  });

  it("resumeCreatedResource: forwards the desired properties and the context's masker", async () => {
    mockCloudControlSend.mockResolvedValue({ ResourceDescription: { Properties: '{"A":1}' } });
    const spy = vi.spyOn(members, 'maskDeployedNonAttributeKeys');
    const properties = { LogGroupName: 'from-template' };
    await members.resumeCreatedResource(LOGICAL, 'AWS::Logs::LogGroup', PHYSICAL, properties, {
      maskSecrets: (text: string) => text.replaceAll('s3cret', '***'),
    });
    expect(spy).toHaveBeenCalledTimes(1);
    const args = spy.mock.calls[0]!;
    expect(args[5]).toEqual(properties);
    expect((args[6] as (t: string) => string)('a s3cret b')).toBe('a *** b');
  });

  it('handleError: the wrapped error carries the physical id and the cause', () => {
    const cause = new Error('boom');
    let thrown: unknown;
    try {
      members.handleError(cause, 'DELETE', 'AWS::Logs::LogGroup', LOGICAL, PHYSICAL);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ProvisioningError);
    expect((thrown as ProvisioningError).physicalId).toBe(PHYSICAL);
    expect((thrown as ProvisioningError).logicalId).toBe(LOGICAL);
    expect((thrown as Error).cause).toBe(cause);
  });
});
