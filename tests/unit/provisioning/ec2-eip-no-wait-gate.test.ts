import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { AllocateAddressCommand, AssociateAddressCommand } from '@aws-sdk/client-ec2';

// Gating the EC2 Instance `running` wait on --no-wait (issue #1277) broke a
// second site the same way it broke the instance-profile association (issue
// #1279): `createEip` associated the address on the premise that "the EIP
// depends on the instance in the DAG, so it is already running by now". The
// DAG edge only guarantees the instance was CREATED. Under --no-wait it is
// still `pending`, and AssociateAddress rejects that with
// IncorrectInstanceState -- which is NOT in the retryable-error table, so the
// deploy engine's outer withRetry does not absorb it. The create throws and
// the stack rolls back.
//
// No integ covers this (the ec2-instance fixture runs the default path, and
// no fixture pairs an Instance with an EIP under --no-wait), so these cases
// are the only guard.
//
// The warning is asserted by CONTENT, not just by "a warn happened": under
// --no-wait it is the user's entire remedy for an unassociated address, so a
// silently emptied message would be as bad as no message at all. That is why
// the logger double is hoisted here rather than sealed inside the vi.mock
// factory the way the sibling instance-profile suite does it.
const { mockSend, warnMock } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  warnMock: vi.fn(),
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    ec2: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: warnMock,
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: vi.fn(),
      info: vi.fn(),
      warn: warnMock,
      error: vi.fn(),
    }),
  };
});

import { EC2Provider } from '../../../src/provisioning/providers/ec2-provider.js';

const ALLOCATION_ID = 'eipalloc-0abc123';
const INSTANCE_ID = 'i-1234567890abcdef0';

function mockAllocateOk() {
  mockSend.mockImplementation((command: unknown) => {
    if (command instanceof AllocateAddressCommand) {
      return Promise.resolve({ AllocationId: ALLOCATION_ID, PublicIp: '54.0.0.9' });
    }
    return Promise.resolve({});
  });
}

const associateCalls = () =>
  mockSend.mock.calls.filter((c) => c[0] instanceof AssociateAddressCommand);

describe('EC2 EIP association under --no-wait', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env['CDKD_NO_WAIT'];
    mockAllocateOk();
  });

  afterEach(() => {
    delete process.env['CDKD_NO_WAIT'];
  });

  it('skips AssociateAddress under --no-wait, because the instance may still be pending', async () => {
    process.env['CDKD_NO_WAIT'] = 'true';
    const provider = new EC2Provider();

    const result = await provider.create('Eip', 'AWS::EC2::EIP', { InstanceId: INSTANCE_ID });

    // The allocation itself must still happen -- --no-wait skips waiting, not
    // the resource. Only the association, which requires a running instance,
    // is deferred to the user.
    expect(result.attributes?.['AllocationId']).toBe(ALLOCATION_ID);
    expect(associateCalls()).toHaveLength(0);
  });

  it('names both the allocation and the instance in the skip warning, with runnable repair commands', async () => {
    process.env['CDKD_NO_WAIT'] = 'true';
    const provider = new EC2Provider();

    await provider.create('Eip', 'AWS::EC2::EIP', { InstanceId: INSTANCE_ID });

    const warning = warnMock.mock.calls.map((c) => String(c[0])).find((m) => m.includes('EIP'));
    expect(warning).toBeDefined();
    // Identifiers, so the user knows WHICH address and WHICH instance.
    expect(warning).toContain(ALLOCATION_ID);
    expect(warning).toContain(INSTANCE_ID);
    // The repair itself, copy-pasteable. A warning that only says "not
    // associated" leaves the user to reconstruct this from the API docs.
    expect(warning).toContain(
      `aws ec2 associate-address --allocation-id ${ALLOCATION_ID} --instance-id ${INSTANCE_ID}`
    );
  });

  it('still associates on the default path, so the non---no-wait behavior is unchanged', async () => {
    const provider = new EC2Provider();

    await provider.create('Eip', 'AWS::EC2::EIP', { InstanceId: INSTANCE_ID });

    const calls = associateCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0].input).toMatchObject({
      AllocationId: ALLOCATION_ID,
      InstanceId: INSTANCE_ID,
    });
    expect(warnMock).not.toHaveBeenCalled();
  });

  it('does not warn when the template has no InstanceId, since there is nothing to associate', async () => {
    process.env['CDKD_NO_WAIT'] = 'true';
    const provider = new EC2Provider();

    await provider.create('Eip', 'AWS::EC2::EIP', {});

    expect(associateCalls()).toHaveLength(0);
    expect(warnMock).not.toHaveBeenCalled();
  });
});
