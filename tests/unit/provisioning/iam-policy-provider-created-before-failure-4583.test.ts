import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { NoSuchEntityException } from '@aws-sdk/client-iam';

// go-to-k/cdkd#4583: a create whose later Put*Policy fails detaches the policy
// from exactly the principals whose put returned, and marks nothing: delete()
// walks every recorded principal, so a mark would let --revert-failed remove a
// same-named inline policy from a principal this create never reached.

const { mockSend, childLogger } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  childLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  },
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    iam: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  childLogger.child.mockReturnValue(childLogger);
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

import { IAMPolicyProvider } from '../../../src/provisioning/providers/iam-policy-provider.js';
import { createdBeforeFailure } from '../../../src/provisioning/auxiliary-failure.js';
import { createSecretMasker } from '../../../src/deployment/secret-redaction.js';

const TYPE = 'AWS::IAM::Policy';
const POLICY_NAME = 'my-policy';
const DOC = { Version: '2012-10-17', Statement: [] };
const PROPS = {
  PolicyName: POLICY_NAME,
  PolicyDocument: DOC,
  Roles: ['role-a', 'role-b'],
  Users: ['user-a'],
};

const noSuchEntity = (what: string): NoSuchEntityException =>
  new NoSuchEntityException({ message: `${what} cannot be found`, $metadata: {} });

const accessDenied = (): Error =>
  Object.assign(new Error('User is not authorized to perform iam:PutRolePolicy'), {
    name: 'AccessDenied',
    $metadata: { httpStatusCode: 403 },
  });

async function createError(
  props: Record<string, unknown> = PROPS,
  maskSecrets?: (text: string) => string
): Promise<unknown> {
  return new IAMPolicyProvider()
    .create('Pol', TYPE, props, maskSecrets ? { maskSecrets } : undefined)
    .then(
      () => {
        throw new Error('expected create to fail');
      },
      (e: unknown) => e
    );
}

/** Every command sent, as `<CommandName> <input>` pairs. */
function sent(): Array<[string, unknown]> {
  return mockSend.mock.calls.map(([command]) => {
    const c = command as { constructor: { name: string }; input: unknown };
    return [c.constructor.name, c.input];
  });
}

function deletesSent(): Array<[string, unknown]> {
  return sent().filter(([name]) => name.startsWith('Delete'));
}

describe('IAMPolicyProvider create detaches a partially attached policy (#4583)', () => {
  beforeEach(() => {
    mockSend.mockReset();
    childLogger.warn.mockReset();
  });

  it('detaches from the principal whose put returned and never from one the create did not reach', async () => {
    mockSend.mockResolvedValueOnce({}); // PutRolePolicy role-a
    mockSend.mockRejectedValueOnce(accessDenied()); // PutRolePolicy role-b
    mockSend.mockResolvedValueOnce({}); // DeleteRolePolicy role-a

    const error = await createError();

    expect((error as Error).message).toContain('not authorized');
    expect(deletesSent()).toEqual([
      ['DeleteRolePolicyCommand', { RoleName: 'role-a', PolicyName: POLICY_NAME }],
    ]);
    // role-b's put failed and user-a's was never sent: neither is touched.
    expect(sent().some(([, input]) => JSON.stringify(input).includes('role-b'))).toBe(true);
    expect(deletesSent().some(([, input]) => /role-b|user-a/.test(JSON.stringify(input)))).toBe(
      false
    );
    expect(childLogger.warn).not.toHaveBeenCalled();
    expect(createdBeforeFailure(error, 'Pol', TYPE)).toBeUndefined();
  });

  it('detaches from every role whose put returned when the first user put fails', async () => {
    mockSend.mockResolvedValueOnce({}); // role-a
    mockSend.mockResolvedValueOnce({}); // role-b
    mockSend.mockRejectedValueOnce(new Error('LimitExceeded: inline policy size')); // user-a
    mockSend.mockResolvedValue({}); // the deletes

    const error = await createError();

    expect(deletesSent()).toEqual([
      ['DeleteRolePolicyCommand', { RoleName: 'role-a', PolicyName: POLICY_NAME }],
      ['DeleteRolePolicyCommand', { RoleName: 'role-b', PolicyName: POLICY_NAME }],
    ]);
    expect(createdBeforeFailure(error, 'Pol', TYPE)).toBeUndefined();
  });

  it('treats a principal that no longer holds the policy (NoSuchEntity) as clean', async () => {
    mockSend.mockResolvedValueOnce({}); // role-a
    mockSend.mockRejectedValueOnce(accessDenied()); // role-b
    mockSend.mockRejectedValueOnce(noSuchEntity('role-a')); // DeleteRolePolicy role-a

    const error = await createError();

    expect(deletesSent()).toHaveLength(1);
    expect(childLogger.warn).not.toHaveBeenCalled();
    expect(createdBeforeFailure(error, 'Pol', TYPE)).toBeUndefined();
  });

  it('warns with a pasteable command and marks nothing when the detach fails', async () => {
    mockSend.mockResolvedValueOnce({}); // role-a
    mockSend.mockRejectedValueOnce(accessDenied()); // role-b
    mockSend.mockRejectedValueOnce(new Error('Throttling: rate exceeded')); // DeleteRolePolicy role-a

    const error = await createError();

    expect((error as Error).message).toContain('not authorized');
    expect(deletesSent()).toHaveLength(1);
    expect(childLogger.warn).toHaveBeenCalledTimes(1);
    const warning = String(childLogger.warn.mock.calls[0]![0]);
    expect(warning).toContain('Throttling: rate exceeded');
    expect(warning).toContain(
      'aws iam delete-role-policy --role-name role-a --policy-name my-policy'
    );
    expect(warning).not.toContain('role-b');
    expect(createdBeforeFailure(error, 'Pol', TYPE)).toBeUndefined();
  });

  it('masks a secret principal name in the cleanup warning and withholds its command', async () => {
    mockSend.mockResolvedValueOnce({}); // role-a
    mockSend.mockRejectedValueOnce(accessDenied()); // role-b
    mockSend.mockRejectedValueOnce(new Error('Throttling: rate exceeded'));

    await createError(PROPS, (text) => text.replaceAll('role-a', '***'));

    const warning = String(childLogger.warn.mock.calls[0]![0]);
    expect(warning).not.toContain('role-a');
    expect(warning).not.toContain('aws iam delete-role-policy');
  });

  it('masks a SHORT secret-derived role name (below the substring floor) in the cleanup warning', async () => {
    // 'qz7' is shorter than the base masker's substring floor, so a mask of the
    // finished line leaves it in place; only a mask of the raw value catches it.
    const maskSecrets = createSecretMasker(new Map([['qz7', '{{resolve:secretsmanager:n}}']]));
    expect(maskSecrets('role qz7 (x)')).toContain('qz7');
    mockSend.mockResolvedValueOnce({}); // PutRolePolicy qz7
    mockSend.mockRejectedValueOnce(accessDenied()); // PutRolePolicy role-b
    mockSend.mockRejectedValueOnce(new Error('Throttling: rate exceeded')); // DeleteRolePolicy qz7

    await createError({ ...PROPS, Roles: ['qz7', 'role-b'] }, maskSecrets);

    expect(deletesSent()).toEqual([
      ['DeleteRolePolicyCommand', { RoleName: 'qz7', PolicyName: POLICY_NAME }],
    ]);
    expect(childLogger.warn).toHaveBeenCalledTimes(1);
    expect(String(childLogger.warn.mock.calls[0]![0])).not.toContain('qz7');
  });

  it("masks a SHORT secret-derived role name quoted inside AWS's own detach error text", async () => {
    const maskSecrets = createSecretMasker(new Map([['qz7', '{{resolve:secretsmanager:n}}']]));
    mockSend.mockResolvedValueOnce({}); // PutRolePolicy qz7
    mockSend.mockRejectedValueOnce(accessDenied()); // PutRolePolicy role-b
    mockSend.mockRejectedValueOnce(
      Object.assign(
        new Error(
          'User: arn:aws:iam::123456789012:user/dev is not authorized to perform: ' +
            'iam:DeleteRolePolicy on resource: role qz7 because no identity-based policy allows it'
        ),
        { name: 'AccessDenied' }
      )
    ); // DeleteRolePolicy qz7

    await createError({ ...PROPS, Roles: ['qz7', 'role-b'] }, maskSecrets);

    expect(childLogger.warn).toHaveBeenCalledTimes(1);
    const warning = String(childLogger.warn.mock.calls[0]![0]);
    expect(warning).toContain('not authorized');
    expect(warning).not.toContain('qz7');
  });

  it("masks a SHORT secret-derived role name quoted inside AWS's put error in the thrown message", async () => {
    const maskSecrets = createSecretMasker(new Map([['qz7', '{{resolve:secretsmanager:n}}']]));
    mockSend.mockRejectedValueOnce(
      Object.assign(
        new Error(
          'User: arn:aws:iam::123456789012:user/dev is not authorized to perform: ' +
            'iam:PutRolePolicy on resource: role qz7'
        ),
        { name: 'AccessDenied' }
      )
    ); // PutRolePolicy qz7

    const error = (await createError({ ...PROPS, Roles: ['qz7'] }, maskSecrets)) as Error;

    expect(error.message).toContain('not authorized');
    expect(error.message).not.toContain('qz7');
  });

  it('detaches only the groups whose put returned (groups only)', async () => {
    mockSend.mockResolvedValueOnce({}); // PutGroupPolicy g1
    mockSend.mockRejectedValueOnce(accessDenied()); // PutGroupPolicy g2
    mockSend.mockResolvedValueOnce({}); // DeleteGroupPolicy g1

    const error = await createError({
      PolicyName: POLICY_NAME,
      PolicyDocument: DOC,
      Groups: ['g1', 'g2', 'g3'],
    });

    expect(deletesSent()).toEqual([
      ['DeleteGroupPolicyCommand', { GroupName: 'g1', PolicyName: POLICY_NAME }],
    ]);
    expect(createdBeforeFailure(error, 'Pol', TYPE)).toBeUndefined();
  });

  it('detaches only the users whose put returned (users only)', async () => {
    mockSend.mockResolvedValueOnce({}); // PutUserPolicy u1
    mockSend.mockRejectedValueOnce(accessDenied()); // PutUserPolicy u2
    mockSend.mockResolvedValueOnce({}); // DeleteUserPolicy u1

    const error = await createError({
      PolicyName: POLICY_NAME,
      PolicyDocument: DOC,
      Users: ['u1', 'u2', 'u3'],
    });

    expect(deletesSent()).toEqual([
      ['DeleteUserPolicyCommand', { UserName: 'u1', PolicyName: POLICY_NAME }],
    ]);
    expect(createdBeforeFailure(error, 'Pol', TYPE)).toBeUndefined();
  });

  it('sends no delete when the first Put*Policy fails (nothing was attached)', async () => {
    mockSend.mockRejectedValueOnce(new Error('MalformedPolicyDocument: bad statement'));
    const error = await createError();
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(createdBeforeFailure(error, 'Pol', TYPE)).toBeUndefined();
  });

  it('leaves no mark on the pre-flight no-target refusal', async () => {
    const error = await createError({ PolicyName: POLICY_NAME, PolicyDocument: {} });
    expect(mockSend).not.toHaveBeenCalled();
    expect(createdBeforeFailure(error, 'Pol', TYPE)).toBeUndefined();
  });
});
