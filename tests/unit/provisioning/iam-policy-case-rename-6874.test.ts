/**
 * go-to-k/cdkd#6874 follow-up: an `AWS::IAM::Policy` renamed only in case
 * (`CasePol` -> `casepol`). IAM holds one inline policy per name ignoring
 * case and a put alone keeps the first spelling; CloudFormation updates in
 * place by deleting the old spelling and then putting the new one on each
 * principal (CloudTrail of a CFn A/B, us-east-1 2026-11-23; back the same
 * way). cdkd now does the same on every principal that held the old
 * spelling, and puts it back if the new put fails.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

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
    child: vi.fn(function (this: unknown) { return this; }),
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

import { IAMPolicyProvider } from '../../../src/provisioning/providers/iam-policy-provider.js';

const TYPE = 'AWS::IAM::Policy';
const DOC_A = { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: 's3:GetObject', Resource: '*' }] };
const DOC_B = { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: 's3:PutObject', Resource: '*' }] };

type Cmd = { constructor: { name: string }; input: Record<string, unknown> };
let calls: Array<{ op: string; input: Record<string, unknown> }>;

const ops = (): string[] =>
  calls
    .filter((c) => /^(Put|Delete)(Role|Group|User)Policy$/.test(c.op))
    .map(
      (c) =>
        `${c.op} ${String(c.input['RoleName'] ?? c.input['GroupName'] ?? c.input['UserName'])} ${String(c.input['PolicyName'])}`
    );

beforeEach(() => {
  vi.clearAllMocks();
  mockSend.mockReset();
  calls = [];
  mockSend.mockImplementation(async (command: Cmd) => {
    calls.push({ op: command.constructor.name.replace(/Command$/, ''), input: command.input });
    return {};
  });
});

describe('AWS::IAM::Policy case-only PolicyName rename (go-to-k/cdkd#6874)', () => {
  it('each retained role, group and user: delete the old spelling, then put the new one with the new document', async () => {
    await new IAMPolicyProvider().update(
      'P',
      'CasePol',
      TYPE,
      { PolicyName: 'casepol', PolicyDocument: DOC_B, Roles: ['r'], Groups: ['g'], Users: ['u'] },
      { PolicyName: 'CasePol', PolicyDocument: DOC_A, Roles: ['r'], Groups: ['g'], Users: ['u'] }
    );
    expect(ops()).toEqual([
      'DeleteRolePolicy r CasePol',
      'PutRolePolicy r casepol',
      'DeleteGroupPolicy g CasePol',
      'PutGroupPolicy g casepol',
      'DeleteUserPolicy u CasePol',
      'PutUserPolicy u casepol',
    ]);
    const put = calls.find((c) => c.op === 'PutRolePolicy')!;
    expect(JSON.parse(String(put.input['PolicyDocument']))).toEqual(DOC_B);
  });

  it('the rollback replay (the recorded bag as the desired side) does the same backward', async () => {
    await new IAMPolicyProvider().update(
      'P',
      'casepol',
      TYPE,
      { PolicyName: 'CasePol', PolicyDocument: DOC_A, Roles: ['r'] },
      { PolicyName: 'casepol', PolicyDocument: DOC_B, Roles: ['r'] }
    );
    expect(ops()).toEqual(['DeleteRolePolicy r casepol', 'PutRolePolicy r CasePol']);
  });

  it('a principal respelled in case too is still the one that held the old spelling', async () => {
    await new IAMPolicyProvider().update(
      'P',
      'CasePol',
      TYPE,
      { PolicyName: 'casepol', PolicyDocument: DOC_B, Roles: ['my-role'] },
      { PolicyName: 'CasePol', PolicyDocument: DOC_A, Roles: ['My-Role'] }
    );
    expect(ops()).toEqual(['DeleteRolePolicy my-role CasePol', 'PutRolePolicy my-role casepol']);
  });

  it('a rename beyond case is unchanged: put the new name, then remove the old one', async () => {
    await new IAMPolicyProvider().update(
      'P',
      'CasePol',
      TYPE,
      { PolicyName: 'CasePol2', PolicyDocument: DOC_B, Roles: ['r'] },
      { PolicyName: 'CasePol', PolicyDocument: DOC_A, Roles: ['r'] }
    );
    expect(ops()).toEqual(['PutRolePolicy r CasePol2', 'DeleteRolePolicy r CasePol']);
  });

  it('an unchanged name sends only the put', async () => {
    await new IAMPolicyProvider().update(
      'P',
      'CasePol',
      TYPE,
      { PolicyName: 'CasePol', PolicyDocument: DOC_B, Roles: ['r'] },
      { PolicyName: 'CasePol', PolicyDocument: DOC_A, Roles: ['r'] }
    );
    expect(ops()).toEqual(['PutRolePolicy r CasePol']);
  });

  it('a failed put of the new spelling puts the old one back with the recorded document, then fails', async () => {
    mockSend.mockImplementation(async (command: Cmd) => {
      calls.push({ op: command.constructor.name.replace(/Command$/, ''), input: command.input });
      if (command.constructor.name === 'PutRolePolicyCommand' && command.input['PolicyName'] === 'casepol') {
        throw new Error('MalformedPolicyDocument');
      }
      return {};
    });
    await expect(
      new IAMPolicyProvider().update(
        'P',
        'CasePol',
        TYPE,
        { PolicyName: 'casepol', PolicyDocument: DOC_B, Roles: ['r'] },
        { PolicyName: 'CasePol', PolicyDocument: DOC_A, Roles: ['r'] }
      )
    ).rejects.toThrow(/MalformedPolicyDocument/);
    expect(ops()).toEqual([
      'DeleteRolePolicy r CasePol',
      'PutRolePolicy r casepol',
      'PutRolePolicy r CasePol',
    ]);
    const restore = calls.filter((c) => c.op === 'PutRolePolicy').at(-1)!;
    expect(JSON.parse(String(restore.input['PolicyDocument']))).toEqual(DOC_A);
  });

  it.each([
    ['a {{resolve:}} reference', '{{resolve:secretsmanager:vpce:SecretString:id}}'],
    ['the mask', '***'],
  ])('a recorded document holding %s is not put back after a failed put (warned instead)', async (_what, secret) => {
    mockSend.mockImplementation(async (command: Cmd) => {
      calls.push({ op: command.constructor.name.replace(/Command$/, ''), input: command.input });
      if (command.constructor.name === 'PutRolePolicyCommand' && command.input['PolicyName'] === 'casepol') {
        throw new Error('Throttling');
      }
      return {};
    });
    const recorded = {
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Action: 's3:*',
          Resource: '*',
          Condition: { StringNotEquals: { 'aws:SourceVpce': secret } },
        },
      ],
    };
    await expect(
      new IAMPolicyProvider().update(
        'P',
        'CasePol',
        TYPE,
        { PolicyName: 'casepol', PolicyDocument: DOC_B, Roles: ['r'] },
        { PolicyName: 'CasePol', PolicyDocument: recorded, Roles: ['r'] }
      )
    ).rejects.toThrow(/Throttling/);
    expect(ops()).toEqual(['DeleteRolePolicy r CasePol', 'PutRolePolicy r casepol']);
  });

  it('an old spelling already gone (NoSuchEntity) still gets the new one put', async () => {
    const { NoSuchEntityException } = await import('@aws-sdk/client-iam');
    mockSend.mockImplementation(async (command: Cmd) => {
      calls.push({ op: command.constructor.name.replace(/Command$/, ''), input: command.input });
      if (command.constructor.name === 'DeleteRolePolicyCommand') {
        throw new NoSuchEntityException({ $metadata: {}, message: 'gone' });
      }
      return {};
    });
    await new IAMPolicyProvider().update(
      'P',
      'CasePol',
      TYPE,
      { PolicyName: 'casepol', PolicyDocument: DOC_B, Roles: ['r'] },
      { PolicyName: 'CasePol', PolicyDocument: DOC_A, Roles: ['r'] }
    );
    expect(ops()).toEqual(['DeleteRolePolicy r CasePol', 'PutRolePolicy r casepol']);
  });
});
