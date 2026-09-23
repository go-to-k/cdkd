import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { CreateRoleCommand, PutRolePermissionsBoundaryCommand } from '@aws-sdk/client-iam';

const mockSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    iam: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

const { IAMRoleProvider } = await import('../../../src/provisioning/providers/iam-role-provider.js');
const { withForcedPermissionsBoundary } = await import(
  '../../../src/provisioning/forced-permissions-boundary.js'
);

const FORCED = 'arn:aws:iam::123456789012:policy/forced';
const DECLARED = 'arn:aws:iam::123456789012:policy/declared';

const assumeRole = {
  Version: '2012-10-17',
  Statement: [
    { Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' }, Action: 'sts:AssumeRole' },
  ],
};

function createdRole() {
  return { Role: { Arn: 'arn:aws:iam::123456789012:role/r', RoleId: 'AROA1' } };
}

describe('IAMRoleProvider with --permissions-boundary', () => {
  beforeEach(() => {
    mockSend.mockReset();
  });

  it('sends the forced boundary when the template declared none', async () => {
    mockSend.mockResolvedValue(createdRole());
    const provider = new IAMRoleProvider();

    await withForcedPermissionsBoundary(FORCED, () =>
      provider.create('Role', 'AWS::IAM::Role', { AssumeRolePolicyDocument: assumeRole })
    );

    const create = mockSend.mock.calls
      .map(([c]) => c)
      .find((c) => c instanceof CreateRoleCommand) as CreateRoleCommand;
    expect(create.input.PermissionsBoundary).toBe(FORCED);
  });

  it('overrides a boundary the template declared', async () => {
    mockSend.mockResolvedValue(createdRole());
    const provider = new IAMRoleProvider();

    await withForcedPermissionsBoundary(FORCED, () =>
      provider.create('Role', 'AWS::IAM::Role', {
        AssumeRolePolicyDocument: assumeRole,
        PermissionsBoundary: DECLARED,
      })
    );

    const create = mockSend.mock.calls
      .map(([c]) => c)
      .find((c) => c instanceof CreateRoleCommand) as CreateRoleCommand;
    expect(create.input.PermissionsBoundary).toBe(FORCED);
  });

  it('records the SENT boundary in effectiveProperties, not the declared one', async () => {
    mockSend.mockResolvedValue(createdRole());
    const provider = new IAMRoleProvider();

    const result = await withForcedPermissionsBoundary(FORCED, () =>
      provider.create('Role', 'AWS::IAM::Role', {
        AssumeRolePolicyDocument: assumeRole,
        PermissionsBoundary: DECLARED,
      })
    );

    expect(result.effectiveProperties?.['PermissionsBoundary']).toBe(FORCED);
  });

  it('records NO effectiveProperties when the template already agreed', async () => {
    mockSend.mockResolvedValue(createdRole());
    const provider = new IAMRoleProvider();

    const result = await withForcedPermissionsBoundary(FORCED, () =>
      provider.create('Role', 'AWS::IAM::Role', {
        AssumeRolePolicyDocument: assumeRole,
        PermissionsBoundary: FORCED,
      })
    );

    expect(result.effectiveProperties).toBeUndefined();
  });

  it('honors the template when no scope is active', async () => {
    mockSend.mockResolvedValue(createdRole());
    const provider = new IAMRoleProvider();

    await provider.create('Role', 'AWS::IAM::Role', {
      AssumeRolePolicyDocument: assumeRole,
      PermissionsBoundary: DECLARED,
    });

    const create = mockSend.mock.calls
      .map(([c]) => c)
      .find((c) => c instanceof CreateRoleCommand) as CreateRoleCommand;
    expect(create.input.PermissionsBoundary).toBe(DECLARED);
  });

  it('attaches the boundary on an IN-PLACE update when the recorded state had none', async () => {
    mockSend.mockResolvedValue({ Role: { Arn: 'arn', RoleId: 'AROA1' } });
    const provider = new IAMRoleProvider();

    // `RoleName` must match `physicalId`, or the immutable-name check routes
    // this to REPLACEMENT and the in-place boundary block is never reached.
    // The replacement path attaches the boundary through `create()` instead.
    await withForcedPermissionsBoundary(FORCED, () =>
      provider.update(
        'Role',
        'role-name',
        'AWS::IAM::Role',
        { RoleName: 'role-name', AssumeRolePolicyDocument: assumeRole },
        { RoleName: 'role-name', AssumeRolePolicyDocument: assumeRole }
      )
    );

    const put = mockSend.mock.calls
      .map(([c]) => c)
      .find((c) => c instanceof PutRolePermissionsBoundaryCommand) as
      | PutRolePermissionsBoundaryCommand
      | undefined;
    expect(put?.input.PermissionsBoundary).toBe(FORCED);
  });
});

describe('IAMRoleProvider.canonicalizeDesiredProperties', () => {
  it('folds the forced value so the diff does not see the template value as a change', () => {
    const provider = new IAMRoleProvider();
    withForcedPermissionsBoundary(FORCED, () => {
      expect(
        provider.canonicalizeDesiredProperties?.('AWS::IAM::Role', {
          PermissionsBoundary: DECLARED,
        })
      ).toEqual({ PermissionsBoundary: FORCED });
    });
  });

  it('is identity with no scope active', () => {
    const provider = new IAMRoleProvider();
    const input = { PermissionsBoundary: DECLARED };
    expect(provider.canonicalizeDesiredProperties?.('AWS::IAM::Role', input)).toBe(input);
  });
});
