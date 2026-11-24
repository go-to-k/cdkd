/**
 * go-to-k/cdkd#6655 (D1): an IAM role / managed policy delete addresses the
 * resource BY NAME (an ARN built from the name, for a policy). With the
 * AWS-minted id recorded (`RoleId` / `PolicyId`), the read the delete already
 * makes (`GetRole` / `GetPolicy`) must answer with that id, or the delete is
 * refused before ANY write: the name was taken again by another resource.
 *
 * Every case drives the provider's real `delete()` against a mocked IAM
 * client and reads the commands it sent.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { NoSuchEntityException } from '@aws-sdk/client-iam';

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

import { IAMRoleProvider } from '../../../src/provisioning/providers/iam-role-provider.js';
import { IAMManagedPolicyProvider } from '../../../src/provisioning/providers/iam-managed-policy-provider.js';
import {
  isMarkedNonRetryable,
  isRetryableTransientError,
} from '../../../src/deployment/retryable-errors.js';
import {
  RECORDED_IDENTITY_REREAD_DELAY_MS,
  RecordedIdentityMismatchError,
} from '../../../src/provisioning/recorded-identity.js';
import type { DeleteContext } from '../../../src/provisioning/region-check.js';
import { isMarkedNotGone } from '../../../src/provisioning/not-gone.js';
import { getLogger } from '../../../src/utils/logger.js';

type Handler = (input: Record<string, unknown>) => unknown;

let sent: string[];

function drive(handlers: Record<string, Handler>): void {
  mockSend.mockImplementation(
    async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      const name = command.constructor.name;
      sent.push(name);
      const handler = handlers[name];
      return handler ? handler(command.input) : {};
    }
  );
}

/** Settle `promise`, advancing past the mismatch re-read's wait. */
async function settled(promise: Promise<unknown>): Promise<{ error?: Error }> {
  const outcome = promise.then(
    () => ({}),
    (error: unknown) => ({ error: error as Error })
  );
  await vi.advanceTimersByTimeAsync(RECORDED_IDENTITY_REREAD_DELAY_MS);
  return outcome;
}

async function thrownBy(promise: Promise<unknown>): Promise<Error> {
  const { error } = await settled(promise);
  if (error === undefined) throw new Error('expected the delete to throw');
  return error;
}

function throttled(): Error {
  return Object.assign(new Error('Rate exceeded'), {
    name: 'Throttling',
    $metadata: { httpStatusCode: 400 },
  });
}

const RECORDED = 'role-id-recorded';
const SUCCESSOR = 'role-id-successor';
const POLICY_RECORDED = 'policy-id-recorded';
const POLICY_SUCCESSOR = 'policy-id-successor';
const POLICY_ARN = 'arn:aws:iam::123456789012:policy/my-policy';

/** Every IAM command that changes something: none may be sent on a refusal. */
const WRITES = /^(Delete|Detach|Remove)/;

beforeEach(() => {
  vi.clearAllMocks();
  mockSend.mockReset();
  sent = [];
  vi.useFakeTimers({ toFake: ['setTimeout'] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('AWS::IAM::Role delete compares the recorded RoleId (go-to-k/cdkd#6655)', () => {
  const del = (context?: DeleteContext) =>
    new IAMRoleProvider().delete('R', 'my-role', 'AWS::IAM::Role', undefined, context);
  const roleWith = (roleId: string | undefined): Record<string, Handler> => ({
    GetRoleCommand: () => ({ Role: { RoleName: 'my-role', RoleId: roleId } }),
    ListAttachedRolePoliciesCommand: () => ({
      AttachedPolicies: [{ PolicyArn: 'arn:aws:iam::123456789012:policy/P' }],
    }),
    ListRolePoliciesCommand: () => ({ PolicyNames: ['inline'] }),
    ListInstanceProfilesForRoleCommand: () => ({ InstanceProfiles: [] }),
  });

  it('the live role carries the recorded RoleId: deleted as before', async () => {
    drive(roleWith(RECORDED));
    await del({ recordedAttributes: { RoleId: RECORDED } });
    expect(sent.at(-1)).toBe('DeleteRoleCommand');
  });

  it('another RoleId under the name: refused, non-retryable, nothing written', async () => {
    drive(roleWith(SUCCESSOR));
    const error = await thrownBy(del({ recordedAttributes: { RoleId: RECORDED } }));
    expect(error).toBeInstanceOf(RecordedIdentityMismatchError);
    expect(isMarkedNonRetryable(error)).toBe(true);
    // The read, and the one re-read after the wait.
    expect(sent).toEqual(['GetRoleCommand', 'GetRoleCommand']);
    expect(sent.some((name) => WRITES.test(name))).toBe(false);
    expect(error.message).toContain('RoleId differs');
    expect(error.message).toContain('kept the record');
    expect(error.message).toContain('cdkd state orphan');
    expect(error.message).toContain('--resource R');
    expect(error.message).not.toContain(RECORDED);
    expect(error.message).not.toContain(SUCCESSOR);
    // None of the already-deleted classifiers' needles.
    expect(error.message).not.toMatch(/does not exist|not found|NoSuchEntity/i);
  });

  it('a stack destroy names the whole-stack orphan form', async () => {
    drive(roleWith(SUCCESSOR));
    const error = await thrownBy(
      del({ recordedAttributes: { RoleId: RECORDED }, stackDestroy: true })
    );
    expect(error.message).toContain('which drops every record');
  });

  it('a first read still answering the previous holder: the re-read decides, and it is deleted', async () => {
    let reads = 0;
    drive({
      ...roleWith(RECORDED),
      GetRoleCommand: () => ({
        Role: { RoleName: 'my-role', RoleId: ++reads === 1 ? SUCCESSOR : RECORDED },
      }),
    });
    const { error } = await settled(del({ recordedAttributes: { RoleId: RECORDED } }));
    expect(error).toBeUndefined();
    expect(sent.slice(0, 2)).toEqual(['GetRoleCommand', 'GetRoleCommand']);
    expect(sent.at(-1)).toBe('DeleteRoleCommand');
  });

  it('the role gone by the re-read: the idempotent arm', async () => {
    let reads = 0;
    drive({
      ...roleWith(SUCCESSOR),
      GetRoleCommand: () => {
        if (++reads === 1) return { Role: { RoleName: 'my-role', RoleId: SUCCESSOR } };
        throw new NoSuchEntityException({ $metadata: {}, message: 'gone' });
      },
    });
    const { error } = await settled(
      del({ recordedAttributes: { RoleId: RECORDED }, expectedRegion: 'us-east-1' })
    );
    expect(error).toBeUndefined();
    expect(sent).toEqual(['GetRoleCommand', 'GetRoleCommand']);
  });

  it('no RoleId recorded (a legacy record): the by-name delete as before', async () => {
    drive(roleWith(SUCCESSOR));
    await del({ recordedAttributes: { Arn: 'arn:aws:iam::123456789012:role/my-role' } });
    expect(sent.at(-1)).toBe('DeleteRoleCommand');
    sent = [];
    drive(roleWith(SUCCESSOR));
    await del();
    expect(sent.at(-1)).toBe('DeleteRoleCommand');
  });

  it('a masked recorded RoleId is no id: the by-name delete as before', async () => {
    drive(roleWith(SUCCESSOR));
    await del({ recordedAttributes: { RoleId: '***' } });
    expect(sent.at(-1)).toBe('DeleteRoleCommand');
    // A mask inside the value too, as the rollback's survivor check reads it.
    sent = [];
    drive(roleWith(SUCCESSOR));
    await del({ recordedAttributes: { RoleId: 'role-id-***-x' } });
    expect(sent).toEqual([
      'GetRoleCommand',
      'ListAttachedRolePoliciesCommand',
      'DetachRolePolicyCommand',
      'ListRolePoliciesCommand',
      'DeleteRolePolicyCommand',
      // No instance-profile listing: outside a delete-first, a profile is
      // read only after DeleteRole refuses (go-to-k/cdkd#6770).
      'DeleteRoleCommand',
    ]);
  });

  it('GetRole throttled: thrown for the retry classifier, never a by-name delete', async () => {
    drive({ ...roleWith(RECORDED), GetRoleCommand: () => Promise.reject(throttled()) });
    for (let attempt = 0; attempt < 3; attempt++) {
      const error = await thrownBy(del({ recordedAttributes: { RoleId: RECORDED } }));
      expect(isMarkedNonRetryable(error)).toBe(false);
      expect(isRetryableTransientError(error, error.message)).toBe(true);
    }
    expect(sent).toEqual(['GetRoleCommand', 'GetRoleCommand', 'GetRoleCommand']);
  });

  it('GetRole answering without a RoleId while one is recorded: thrown, nothing written', async () => {
    drive(roleWith(undefined));
    const error = await thrownBy(del({ recordedAttributes: { RoleId: RECORDED } }));
    expect(error).not.toBeInstanceOf(RecordedIdentityMismatchError);
    expect(error.message).toContain('without its RoleId');
    expect(isMarkedNotGone(error)).toBe(true);
    expect(sent).toEqual(['GetRoleCommand']);
  });

  it('the role is gone: the idempotent arm as before', async () => {
    drive({
      GetRoleCommand: () =>
        Promise.reject(new NoSuchEntityException({ $metadata: {}, message: 'gone' })),
    });
    await del({ recordedAttributes: { RoleId: RECORDED }, expectedRegion: 'us-east-1' });
    expect(sent).toEqual(['GetRoleCommand']);
  });
});

describe('AWS::IAM::ManagedPolicy delete compares the recorded PolicyId (go-to-k/cdkd#6655)', () => {
  const del = (context?: DeleteContext) =>
    new IAMManagedPolicyProvider().delete(
      'P',
      POLICY_ARN,
      'AWS::IAM::ManagedPolicy',
      undefined,
      context
    );
  const policyWith = (policyId: string | undefined): Record<string, Handler> => ({
    GetPolicyCommand: () => ({ Policy: { Arn: POLICY_ARN, PolicyId: policyId } }),
    ListEntitiesForPolicyCommand: () => ({
      PolicyGroups: [],
      PolicyRoles: [{ RoleName: 'r' }],
      PolicyUsers: [],
    }),
    ListPolicyVersionsCommand: () => ({ Versions: [] }),
  });

  it('the live policy carries the recorded PolicyId: deleted as before', async () => {
    drive(policyWith(POLICY_RECORDED));
    await del({ recordedAttributes: { PolicyId: POLICY_RECORDED } });
    expect(sent.at(-1)).toBe('DeletePolicyCommand');
  });

  it('another PolicyId under the ARN: refused, non-retryable, nothing written', async () => {
    drive(policyWith(POLICY_SUCCESSOR));
    const error = await thrownBy(del({ recordedAttributes: { PolicyId: POLICY_RECORDED } }));
    expect(error).toBeInstanceOf(RecordedIdentityMismatchError);
    expect(isMarkedNonRetryable(error)).toBe(true);
    expect(sent).toEqual(['GetPolicyCommand', 'GetPolicyCommand']);
    expect(error.message).toContain('PolicyId differs');
    expect(error.message).toContain('cdkd state orphan');
    expect(error.message).not.toContain(POLICY_RECORDED);
    expect(error.message).not.toContain(POLICY_SUCCESSOR);
    expect(error.message).not.toContain(POLICY_ARN);
  });

  it('no PolicyId recorded (a legacy record): the by-ARN delete as before', async () => {
    drive(policyWith(POLICY_SUCCESSOR));
    await del({ recordedAttributes: { PolicyArn: POLICY_ARN } });
    expect(sent.at(-1)).toBe('DeletePolicyCommand');
  });

  it('GetPolicy throttled: thrown for the retry classifier, never a by-ARN delete', async () => {
    drive({ ...policyWith(POLICY_RECORDED), GetPolicyCommand: () => Promise.reject(throttled()) });
    const error = await thrownBy(del({ recordedAttributes: { PolicyId: POLICY_RECORDED } }));
    expect(isMarkedNonRetryable(error)).toBe(false);
    expect(isRetryableTransientError(error, error.message)).toBe(true);
    expect(sent).toEqual(['GetPolicyCommand']);
  });

  it('GetPolicy answering without a PolicyId while one is recorded: thrown, nothing written', async () => {
    drive(policyWith(undefined));
    const error = await thrownBy(del({ recordedAttributes: { PolicyId: POLICY_RECORDED } }));
    expect(error.message).toContain('without its PolicyId');
    expect(sent).toEqual(['GetPolicyCommand']);
  });
});

describe('the update() replacement delete compares the old record id (go-to-k/cdkd#6655)', () => {
  const warns = () =>
    (getLogger().child('x').warn as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .flat()
      .map(String)
      .join('\n');

  it('a role whose old name another role took: no delete sent, the reason names the attribute', async () => {
    drive({
      CreateRoleCommand: (input) => ({
        Role: {
          RoleName: input['RoleName'],
          Arn: `arn:aws:iam::123456789012:role/${String(input['RoleName'])}`,
          RoleId: 'role-id-new',
        },
      }),
      GetRoleCommand: (input) =>
        input['RoleName'] === 'old-role'
          ? { Role: { RoleName: 'old-role', RoleId: SUCCESSOR } }
          : {
              Role: {
                RoleName: input['RoleName'],
                Arn: `arn:aws:iam::123456789012:role/${String(input['RoleName'])}`,
                RoleId: 'role-id-new',
              },
            },
    });
    const DOC = { Version: '2012-10-17', Statement: [] };
    const { error } = await settled(
      new IAMRoleProvider()
        .update(
          'R',
          'old-role',
          'AWS::IAM::Role',
          { RoleName: 'new-role', AssumeRolePolicyDocument: DOC },
          { RoleName: 'old-role', AssumeRolePolicyDocument: DOC },
          { recordedAttributes: { RoleId: RECORDED } }
        )
        .then((result) => {
          expect(result.wasReplaced).toBe(true);
          expect(result.outcome).toBe('partial');
          expect(result.reason).toContain('its RoleId differs from the recorded one');
          expect(result.reason).not.toContain(RECORDED);
          expect(result.reason).not.toContain(SUCCESSOR);
          expect(result.reason).not.toContain('cdkd state orphan');
        })
    );
    expect(error).toBeUndefined();
    expect(sent).toContain('CreateRoleCommand');
    expect(sent.some((name) => /^(Delete|Detach|Remove)/.test(name))).toBe(false);
    expect(warns()).toContain('its RoleId differs from the recorded one');
    expect(warns()).not.toContain('manual cleanup');
    expect(warns()).not.toContain(SUCCESSOR);
  });

  it('a managed policy whose old ARN another policy took: no delete sent, the reason names the attribute', async () => {
    const OLD_ARN = 'arn:aws:iam::123456789012:policy/old-policy';
    drive({
      CreatePolicyCommand: (input) => ({
        Policy: {
          PolicyName: input['PolicyName'],
          Arn: `arn:aws:iam::123456789012:policy/${String(input['PolicyName'])}`,
          PolicyId: 'policy-id-new',
        },
      }),
      GetPolicyCommand: (input) =>
        input['PolicyArn'] === OLD_ARN
          ? { Policy: { Arn: OLD_ARN, PolicyId: POLICY_SUCCESSOR } }
          : { Policy: { Arn: input['PolicyArn'], PolicyId: 'policy-id-new' } },
      ListEntitiesForPolicyCommand: () => ({ PolicyGroups: [], PolicyRoles: [], PolicyUsers: [] }),
      ListPolicyVersionsCommand: () => ({ Versions: [] }),
    });
    const DOC = { Version: '2012-10-17', Statement: [] };
    const { error } = await settled(
      new IAMManagedPolicyProvider()
        .update(
          'P',
          OLD_ARN,
          'AWS::IAM::ManagedPolicy',
          { ManagedPolicyName: 'new-policy', PolicyDocument: DOC },
          { ManagedPolicyName: 'old-policy', PolicyDocument: DOC },
          { recordedAttributes: { PolicyId: POLICY_RECORDED } }
        )
        .then((result) => {
          expect(result.outcome).toBe('partial');
          expect(result.reason).toContain('its PolicyId differs from the recorded one');
          expect(result.reason).not.toContain(POLICY_SUCCESSOR);
          expect(result.reason).not.toContain(POLICY_RECORDED);
          expect(result.reason).not.toContain('cdkd state orphan');
        })
    );
    expect(error).toBeUndefined();
    expect(sent).toContain('CreatePolicyCommand');
    expect(sent.some((name) => /^(Delete|Detach)/.test(name))).toBe(false);
    expect(warns()).not.toContain('manual cleanup');
  });
});

describe('a managed policy gone by the re-read (go-to-k/cdkd#6655)', () => {
  it('takes the gone arm: nothing deleted, no throw', async () => {
    let reads = 0;
    drive({
      GetPolicyCommand: () => {
        if (++reads === 1) return { Policy: { Arn: POLICY_ARN, PolicyId: POLICY_SUCCESSOR } };
        throw new NoSuchEntityException({ $metadata: {}, message: 'gone' });
      },
    });
    const { error } = await settled(
      new IAMManagedPolicyProvider().delete(
        'P',
        POLICY_ARN,
        'AWS::IAM::ManagedPolicy',
        undefined,
        { recordedAttributes: { PolicyId: POLICY_RECORDED }, expectedRegion: 'us-east-1' }
      )
    );
    expect(error).toBeUndefined();
    expect(sent).toEqual(['GetPolicyCommand', 'GetPolicyCommand']);
  });
});
