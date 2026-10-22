import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

/**
 * The IAM role / IAM managed policy / Budgets / Lambda network connector wraps
 * must not write the CALLER'S IDENTITY into a persisted store
 * (go-to-k/cdkd#2319).
 *
 * A thrown `ProvisioningError` message is captured into
 * `deployments/{runId}.jsonl`, and so is the `'partial'` reason a replacement
 * returns when the OLD resource cannot be deleted (a `RESOURCE_SKIPPED`
 * event). IAM words an access denial as `User: arn:aws:sts::<account>:
 * assumed-role/<role>/<session> is not authorized to perform: ...`. Each AWS
 * fixture here carries that wording and the smithy service markers
 * `describeAwsFailure` keys on. Both polarities: an AWS-authored failure is
 * named by its class with `cause` kept (so the retry classifiers still read
 * it), and a cdkd-authored or transport failure keeps its own text.
 */

const { mockSend, debugSpy, fakeClient } = vi.hoisted(() => {
  const send = vi.fn();
  const client = () => ({
    send: (command: unknown) => send(command),
    config: {
      region: () => Promise.resolve('us-east-1'),
      retryStrategy: () => Promise.resolve(undefined),
    },
    middlewareStack: { add: vi.fn(), addRelativeTo: vi.fn() },
  });
  return { mockSend: send, debugSpy: vi.fn(), fakeClient: client };
});

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    iam: fakeClient(),
    sts: fakeClient(),
    lambda: fakeClient(),
    lambdaCore: fakeClient(),
  }),
}));
vi.mock('@aws-sdk/client-budgets', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@aws-sdk/client-budgets')>()),
  BudgetsClient: vi.fn().mockImplementation(fakeClient),
}));
vi.mock('../../../src/provisioning/providers/lambda-web-function-arns.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  sleep: () => Promise.resolve(),
}));
vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: debugSpy,
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: debugSpy,
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

import { IAMRoleProvider } from '../../../src/provisioning/providers/iam-role-provider.js';
import { IAMManagedPolicyProvider } from '../../../src/provisioning/providers/iam-managed-policy-provider.js';
import { BudgetsBudgetProvider } from '../../../src/provisioning/providers/budgets-budget-provider.js';
import { LambdaNetworkConnectorProvider } from '../../../src/provisioning/providers/lambda-network-connector-provider.js';
import { resetIdempotencyTokensForTests } from '../../../src/provisioning/providers/idempotency-token.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';
import {
  hasRedactedCause,
  isMarkedNonRetryable,
  isNameCollisionErrorFrom,
  isRetryableTransientError,
  retryClassificationText,
} from '../../../src/deployment/retryable-errors.js';
import { VERBOSE_POINTER } from '../../../src/utils/aws-failure-text.js';

const CALLER_ACCOUNT = '210987654321';
const CALLER_ROLE = 'cdkd-deploy-role';
const CALLER_SESSION = 'cdkd-session-8f21';
const CALLER_ARN = `arn:aws:sts::${CALLER_ACCOUNT}:assumed-role/${CALLER_ROLE}/${CALLER_SESSION}`;

/** An access denial as IAM / Budgets / Lambda word it, AWS-authored. */
function accessDenied(name: string, action: string): Error {
  return Object.assign(
    new Error(
      `User: ${CALLER_ARN} is not authorized to perform: ${action} on resource: ` +
        `arn:aws:${action.split(':')[0]}::${CALLER_ACCOUNT}:x because no ` +
        `identity-based policy allows the ${action} action`
    ),
    { name, $fault: 'client', $metadata: { httpStatusCode: 403 } }
  );
}

function awsError(name: string, message: string, status = 400): Error {
  return Object.assign(new Error(message), {
    name,
    $fault: 'client',
    $metadata: { httpStatusCode: status },
  });
}

const commandName = (command: unknown): string =>
  (command as { constructor: { name: string } }).constructor.name;

const STS = { GetCallerIdentityCommand: { Account: '111122223333' } };

/** Fail `failing` with `error`; every other command answers `answers[name]` or `{}`. */
function failOn(failing: string, error: unknown, answers: Record<string, unknown> = {}): void {
  mockSend.mockImplementation(async (command: unknown) => {
    const name = commandName(command);
    if (name === failing) throw error;
    return answers[name] ?? {};
  });
}

async function thrown(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected the operation to throw');
}

const debugged = (): string => debugSpy.mock.calls.map((args) => String(args[0])).join('\n');

const SECRET = 'iam-budget-connector-secret';
const MASK = (text: string): string => text.split(SECRET).join('***');

const ROLE = 'AWS::IAM::Role';
const TRUST = {
  Version: '2012-10-17',
  Statement: [
    { Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' }, Action: 'sts:AssumeRole' },
  ],
};
const ROLE_PROPS = { RoleName: 'my-role', AssumeRolePolicyDocument: TRUST };
const POLICY = 'AWS::IAM::ManagedPolicy';
const POLICY_ARN = 'arn:aws:iam::111122223333:policy/my-policy';
const POLICY_DOC = {
  Version: '2012-10-17',
  Statement: [{ Effect: 'Allow', Action: 's3:GetObject', Resource: '*' }],
};
const BUDGET = 'AWS::Budgets::Budget';
const budgetProps = (): Record<string, unknown> => ({
  Budget: {
    BudgetName: 'team-budget',
    BudgetType: 'COST',
    TimeUnit: 'MONTHLY',
    BudgetLimit: { Amount: 10, Unit: 'USD' },
  },
});
const NC = 'AWS::Lambda::NetworkConnector';
const NC_ARN = 'arn:aws:lambda:us-east-1:111122223333:network-connector:nc-1';
const NC_PROPS = {
  Name: 'egress',
  OperatorRole: 'arn:aws:iam::111122223333:role/op',
  Configuration: {
    VpcEgressConfiguration: {
      SubnetIds: ['subnet-a'],
      SecurityGroupIds: ['sg-1'],
      NetworkProtocol: 'IPv4',
      AssociatedComputeResourceTypes: ['WebFunction'],
    },
  },
};
const NC_ACTIVE = { Arn: NC_ARN, State: 'ACTIVE', LatestVersion: 1 };

type Site = {
  site: string;
  command: string;
  /** The error class the denial carries, the service's own. */
  name: string;
  action: string;
  prefix: string;
  answers?: Record<string, unknown>;
  /**
   * `false` where the provider threads no masker today (the network connector
   * reads no `maskSecrets`); this PR does not add one.
   */
  masks?: false;
  /** Runs the operation with `mask` threaded as the operation's `maskSecrets`. */
  run: (mask?: (text: string) => string) => Promise<unknown>;
};

function sites(): Site[] {
  const ctx = (mask?: (text: string) => string) => (mask ? { maskSecrets: mask } : undefined);
  return [
    {
      site: 'IAM role create',
      command: 'CreateRoleCommand',
      name: 'AccessDenied',
      action: 'iam:CreateRole',
      prefix: 'Failed to create IAM role Res: ',
      run: (mask) => new IAMRoleProvider().create('Res', ROLE, ROLE_PROPS, ctx(mask)),
    },
    {
      site: 'IAM role update',
      command: 'UpdateRoleCommand',
      name: 'AccessDenied',
      action: 'iam:UpdateRole',
      prefix: 'Failed to update IAM role Res: ',
      answers: { GetRoleCommand: { Role: { RoleName: 'my-role', Arn: 'arn', RoleId: 'AROA1' } } },
      run: (mask) =>
        new IAMRoleProvider().update(
          'Res',
          'my-role',
          ROLE,
          { ...ROLE_PROPS, Description: 'new' },
          { ...ROLE_PROPS, Description: 'old' },
          ctx(mask)
        ),
    },
    {
      site: 'IAM role update reading a secret-derived Path',
      command: 'GetRoleCommand',
      name: 'AccessDenied',
      action: 'iam:GetRole',
      prefix: 'Failed to read the path of IAM role Res: ',
      run: (mask) =>
        new IAMRoleProvider().update(
          'Res',
          'my-role',
          ROLE,
          { ...ROLE_PROPS, Path: '/team/' },
          { ...ROLE_PROPS, Path: '{{resolve:secretsmanager:role-path:SecretString}}' },
          ctx(mask)
        ),
    },
    {
      site: 'IAM role delete',
      command: 'DeleteRoleCommand',
      name: 'AccessDenied',
      action: 'iam:DeleteRole',
      prefix: 'Failed to delete IAM role Res: ',
      answers: { GetRoleCommand: { Role: { RoleName: 'my-role' } } },
      run: (mask) => new IAMRoleProvider().delete('Res', 'my-role', ROLE, undefined, ctx(mask)),
    },
    {
      site: 'IAM managed policy create',
      command: 'CreatePolicyCommand',
      name: 'AccessDenied',
      action: 'iam:CreatePolicy',
      prefix: 'Failed to create IAM managed policy Res: ',
      run: (mask) =>
        new IAMManagedPolicyProvider().create(
          'Res',
          POLICY,
          { ManagedPolicyName: 'my-policy', PolicyDocument: POLICY_DOC },
          ctx(mask)
        ),
    },
    {
      site: 'IAM managed policy update',
      command: 'CreatePolicyVersionCommand',
      name: 'AccessDenied',
      action: 'iam:CreatePolicyVersion',
      prefix: 'Failed to update IAM managed policy Res: ',
      answers: {
        ListPolicyVersionsCommand: {
          Versions: [{ VersionId: 'v1', IsDefaultVersion: true, CreateDate: new Date(2024, 0, 1) }],
          IsTruncated: false,
        },
      },
      run: (mask) =>
        new IAMManagedPolicyProvider().update(
          'Res',
          POLICY_ARN,
          POLICY,
          {
            ManagedPolicyName: 'my-policy',
            PolicyDocument: { ...POLICY_DOC, Statement: [...POLICY_DOC.Statement, { Sid: 'new' }] },
          },
          { ManagedPolicyName: 'my-policy', PolicyDocument: POLICY_DOC },
          ctx(mask)
        ),
    },
    {
      site: 'IAM managed policy delete',
      command: 'DeletePolicyCommand',
      name: 'AccessDenied',
      action: 'iam:DeletePolicy',
      prefix: 'Failed to delete IAM managed policy Res: ',
      answers: { GetPolicyCommand: { Policy: { Arn: POLICY_ARN } } },
      run: (mask) =>
        new IAMManagedPolicyProvider().delete('Res', POLICY_ARN, POLICY, undefined, ctx(mask)),
    },
    {
      site: 'budget create',
      command: 'CreateBudgetCommand',
      name: 'AccessDeniedException',
      action: 'budgets:ModifyBudget',
      prefix: 'Failed to create budget Res: ',
      answers: STS,
      run: (mask) => new BudgetsBudgetProvider().create('Res', BUDGET, budgetProps(), ctx(mask)),
    },
    {
      site: 'budget update',
      command: 'UpdateBudgetCommand',
      name: 'AccessDeniedException',
      action: 'budgets:ModifyBudget',
      prefix: 'Failed to update budget Res: ',
      answers: STS,
      run: (mask) =>
        new BudgetsBudgetProvider().update(
          'Res',
          'team-budget',
          BUDGET,
          budgetProps(),
          budgetProps(),
          ctx(mask)
        ),
    },
    {
      site: 'budget update adding notifications beside an unreadable recorded list',
      command: 'CreateNotificationCommand',
      name: 'AccessDeniedException',
      action: 'budgets:ModifyBudget',
      prefix: 'Failed to update budget Res: adding 1 desired notification(s) ',
      answers: STS,
      run: (mask) =>
        new BudgetsBudgetProvider().update(
          'Res',
          'team-budget',
          BUDGET,
          {
            ...budgetProps(),
            NotificationsWithSubscribers: [
              {
                Notification: {
                  NotificationType: 'ACTUAL',
                  ComparisonOperator: 'GREATER_THAN',
                  Threshold: 90,
                },
                Subscribers: [{ SubscriptionType: 'EMAIL', Address: 'ops@example.com' }],
              },
            ],
          },
          { ...budgetProps(), NotificationsWithSubscribers: {} },
          ctx(mask)
        ),
    },
    {
      site: 'budget delete',
      command: 'DeleteBudgetCommand',
      name: 'AccessDeniedException',
      action: 'budgets:ModifyBudget',
      prefix: 'Failed to delete budget Res: ',
      answers: STS,
      run: (mask) =>
        new BudgetsBudgetProvider().delete('Res', 'team-budget', BUDGET, undefined, ctx(mask)),
    },
    {
      site: 'network connector create',
      masks: false,
      command: 'CreateNetworkConnectorCommand',
      name: 'AccessDeniedException',
      action: 'lambda:CreateNetworkConnector',
      prefix: 'Failed to create Lambda network connector Res: ',
      run: (mask) => new LambdaNetworkConnectorProvider().create('Res', NC, NC_PROPS, ctx(mask)),
    },
    {
      site: 'network connector update',
      masks: false,
      command: 'UpdateNetworkConnectorCommand',
      name: 'AccessDeniedException',
      action: 'lambda:UpdateNetworkConnector',
      prefix: 'Failed to update Lambda network connector Res: ',
      run: (mask) =>
        new LambdaNetworkConnectorProvider().update(
          'Res',
          NC_ARN,
          NC,
          { ...NC_PROPS, OperatorRole: 'arn:aws:iam::111122223333:role/op2' },
          NC_PROPS,
          ctx(mask)
        ),
    },
    {
      site: 'network connector delete',
      masks: false,
      command: 'DeleteNetworkConnectorCommand',
      name: 'AccessDeniedException',
      action: 'lambda:DeleteNetworkConnector',
      prefix: 'Failed to delete Lambda network connector Res: ',
      run: (mask) =>
        new LambdaNetworkConnectorProvider().delete('Res', NC_ARN, NC, undefined, ctx(mask)),
    },
  ];
}

describe('IAM / Budgets / network connector thrown wraps keep the caller identity out (go-to-k/cdkd#2319)', () => {
  beforeEach(() => {
    mockSend.mockReset();
    debugSpy.mockReset();
    resetIdempotencyTokensForTests();
  });

  describe.each(sites())('$site', ({ command, name, action, prefix, answers, masks, run }) => {
    it('names an AWS-authored failure by its class, keeps cause, and stays retryable', async () => {
      const original = accessDenied(name, action);
      failOn(command, original, answers);
      const failure = await thrown(run());

      // Non-vacuity: the rejection came from the site's own command.
      expect(mockSend.mock.calls.some(([c]) => commandName(c) === command)).toBe(true);
      expect(failure).toBeInstanceOf(ProvisioningError);
      expect(failure.message).toContain(prefix);
      expect(failure.message).toContain(`${name}. ${VERBOSE_POINTER}`);
      expect(failure.message).not.toContain(CALLER_ACCOUNT);
      expect(failure.message).not.toContain(CALLER_ROLE);
      expect(failure.message).not.toContain(CALLER_SESSION);
      expect(failure.cause).toBe(original);

      // The withheld `not authorized to perform` still reaches the classifier.
      expect(isRetryableTransientError(failure, failure.message)).toBe(false);
      expect(hasRedactedCause(failure)).toBe(true);
      expect(retryClassificationText(failure)).toContain('not authorized to perform');
      expect(isRetryableTransientError(failure, retryClassificationText(failure))).toBe(true);

      // AWS's own text is not discarded: it is logged at debug.
      expect(debugged()).toContain(CALLER_ARN);
    });

    it.skipIf(masks === false)("masks AWS's text on the debug line through the operation's masker", async () => {
      failOn(command, awsError('ValidationException', `Invalid value '${SECRET}'`), answers);
      const failure = await thrown(run(MASK));

      expect(mockSend.mock.calls.some(([c]) => commandName(c) === command)).toBe(true);
      expect(failure.message).toContain(`ValidationException. ${VERBOSE_POINTER}`);
      expect(failure.message).not.toContain(SECRET);
      expect(debugged()).toContain("Invalid value '***'");
      expect(debugged()).not.toContain(SECRET);
    });

    it('keeps a non-Error throw as masked text, unstamped', async () => {
      failOn(command, `socket hang up ${SECRET}`, answers);
      const failure = await thrown(run(masks === false ? undefined : MASK));

      expect(mockSend.mock.calls.some(([c]) => commandName(c) === command)).toBe(true);
      expect(failure.message).toContain(prefix);
      expect(failure.message).toContain('socket hang up');
      if (masks !== false) expect(failure.message).not.toContain(SECRET);
      expect(failure.message).not.toContain(VERBOSE_POINTER);
      expect(hasRedactedCause(failure)).toBe(false);
    });

    it('keeps a cdkd-authored or transport failure verbatim, unstamped', async () => {
      const original = new Error('connect ECONNREFUSED 10.0.0.1:443');
      failOn(command, original, answers);
      const failure = await thrown(run());

      expect(mockSend.mock.calls.some(([c]) => commandName(c) === command)).toBe(true);
      expect(failure.message).toContain(prefix);
      expect(failure.message).toContain('connect ECONNREFUSED 10.0.0.1:443');
      expect(failure.message).not.toContain(VERBOSE_POINTER);
      expect(hasRedactedCause(failure)).toBe(false);
      expect(failure.cause).toBe(original);
    });
  });

  it('the budget Arn read names an AWS-authored failure by its class', async () => {
    const original = accessDenied('AccessDeniedException', 'budgets:ViewBudget');
    failOn('DescribeBudgetCommand', original, STS);
    const failure = await thrown(
      new BudgetsBudgetProvider().getAttribute('team-budget', BUDGET, 'Arn', 'Res')
    );

    expect(failure.message).toBe(
      `Failed to resolve Arn for budget team-budget: AccessDeniedException. ${VERBOSE_POINTER}`
    );
    expect(failure.cause).toBe(original);
    expect(hasRedactedCause(failure)).toBe(true);
    expect(debugged()).toContain(CALLER_ARN);
  });

  it('an "already exists" is still a name collision once the text is withheld', async () => {
    failOn(
      'CreateRoleCommand',
      awsError('EntityAlreadyExists', 'Role with name my-role already exists.', 409)
    );
    const failure = await thrown(new IAMRoleProvider().create('Res', ROLE, ROLE_PROPS));

    expect(failure.message).toContain(`EntityAlreadyExists. ${VERBOSE_POINTER}`);
    expect(failure.message).toContain('AWS reports that it already exists.');
    expect(isNameCollisionErrorFrom(failure, 'Res')).toBe(true);
  });

  it("a delete-time NoSuchEntity keeps the class the engine's not-found matchers read", async () => {
    failOn(
      'DeleteRoleCommand',
      awsError('NoSuchEntity', 'The role with name my-role cannot be found.', 404),
      { GetRoleCommand: { Role: { RoleName: 'my-role' } } }
    );
    const failure = await thrown(new IAMRoleProvider().delete('Res', 'my-role', ROLE));

    expect(failure.message).toBe(
      `Failed to delete IAM role Res: NoSuchEntity. ${VERBOSE_POINTER}`
    );
  });

  describe("a replacement's 'partial' reason (persisted as a RESOURCE_SKIPPED event)", () => {
    it('IAM role: the old role the rename could not delete is named by the class only', async () => {
      mockSend.mockImplementation(async (command: unknown) => {
        const n = commandName(command);
        if (n === 'CreateRoleCommand') return { Role: { Arn: 'arn:new', RoleId: 'AROA2' } };
        if (n === 'GetRoleCommand') return { Role: { RoleName: 'old-role' } };
        if (n === 'DeleteRoleCommand') throw accessDenied('AccessDenied', 'iam:DeleteRole');
        return {};
      });
      const result = await new IAMRoleProvider().update(
        'Res',
        'old-role',
        ROLE,
        { ...ROLE_PROPS, RoleName: 'new-role' },
        { ...ROLE_PROPS, RoleName: 'old-role' }
      );

      expect(result).toMatchObject({ wasReplaced: true, outcome: 'partial' });
      const reason = (result as { reason: string }).reason;
      expect(reason).toContain('old role old-role could not be deleted');
      expect(reason).toContain(`AccessDenied. ${VERBOSE_POINTER}`);
      expect(reason).not.toContain(CALLER_ACCOUNT);
      expect(reason).not.toContain(CALLER_ROLE);
      expect(reason).not.toContain(CALLER_SESSION);
    });

    it('IAM managed policy: the old policy the rename could not delete is named by the class only', async () => {
      mockSend.mockImplementation(async (command: unknown) => {
        const n = commandName(command);
        if (n === 'CreatePolicyCommand') {
          return { Policy: { Arn: 'arn:aws:iam::111122223333:policy/new-policy' } };
        }
        if (n === 'GetPolicyCommand') return { Policy: { Arn: POLICY_ARN } };
        if (n === 'DeletePolicyCommand') throw accessDenied('AccessDenied', 'iam:DeletePolicy');
        return {};
      });
      const result = await new IAMManagedPolicyProvider().update(
        'Res',
        POLICY_ARN,
        POLICY,
        { ManagedPolicyName: 'new-policy', PolicyDocument: POLICY_DOC },
        { ManagedPolicyName: 'my-policy', PolicyDocument: POLICY_DOC }
      );

      expect(result).toMatchObject({ wasReplaced: true, outcome: 'partial' });
      const reason = (result as { reason: string }).reason;
      expect(reason).toContain('could not be deleted');
      expect(reason).toContain(`AccessDenied. ${VERBOSE_POINTER}`);
      expect(reason).not.toContain(CALLER_ACCOUNT);
      expect(reason).not.toContain(CALLER_ROLE);
      expect(reason).not.toContain(CALLER_SESSION);
    });
  });

  describe("the network connector's AWS status reason", () => {
    it('a create that ends FAILED names the reason code, not AWS text, and stays non-retryable', async () => {
      const reason = `Role ${CALLER_ARN} cannot be assumed`;
      mockSend.mockImplementation(async (command: unknown) => {
        const n = commandName(command);
        if (n === 'CreateNetworkConnectorCommand') return { Arn: NC_ARN };
        if (n === 'GetNetworkConnectorCommand') {
          return { State: 'FAILED', StateReason: reason, StateReasonCode: 'InvalidOperatorRole' };
        }
        return {};
      });
      const failure = await thrown(new LambdaNetworkConnectorProvider().create('Res', NC, NC_PROPS));

      expect(failure.message).toBe(
        `Failed to create Lambda network connector Res: Lambda network connector Res entered ` +
          `FAILED: InvalidOperatorRole. ${VERBOSE_POINTER}`
      );
      expect(isMarkedNonRetryable(failure)).toBe(true);
      expect(hasRedactedCause(failure)).toBe(true);
      expect(retryClassificationText(failure)).toContain(reason);
      expect(debugged()).toContain(reason);
    });

    it('a failed update with no reason text keeps the code as the whole reason', async () => {
      mockSend.mockImplementation(async (command: unknown) => {
        const n = commandName(command);
        if (n === 'GetNetworkConnectorCommand') {
          return { ...NC_ACTIVE, LastUpdateStatus: 'Failed', LastUpdateStatusReasonCode: 'SubnetGone' };
        }
        return {};
      });
      const failure = await thrown(
        new LambdaNetworkConnectorProvider().update(
          'Res',
          NC_ARN,
          NC,
          { ...NC_PROPS, OperatorRole: 'arn:aws:iam::111122223333:role/op2' },
          NC_PROPS
        )
      );

      expect(failure.message).toBe(
        'Failed to update Lambda network connector Res: Lambda network connector Res update ' +
          'failed: SubnetGone'
      );
      expect(hasRedactedCause(failure)).toBe(false);
    });

    it('a delete that ends DELETE_FAILED with neither reason nor code says so', async () => {
      mockSend.mockImplementation(async (command: unknown) => {
        const n = commandName(command);
        if (n === 'GetNetworkConnectorCommand') return { State: 'DELETE_FAILED' };
        return {};
      });
      const failure = await thrown(
        new LambdaNetworkConnectorProvider().delete('Res', NC_ARN, NC)
      );

      expect(failure.message).toBe(
        'Failed to delete Lambda network connector Res: Lambda network connector Res entered ' +
          'DELETE_FAILED: no reason given'
      );
    });

    it.each([
      {
        arm: 'an update that ends Failed',
        state: { ...NC_ACTIVE, LastUpdateStatus: 'Failed', LastUpdateStatusReason: `bad sg; ${CALLER_ARN}` },
        tail: 'update failed: ',
        reason: `bad sg; ${CALLER_ARN}`,
        run: () =>
          new LambdaNetworkConnectorProvider().update(
            'Res',
            NC_ARN,
            NC,
            { ...NC_PROPS, OperatorRole: 'arn:aws:iam::111122223333:role/op2' },
            NC_PROPS
          ),
      },
      {
        arm: 'an update that meets DELETING',
        state: { ...NC_ACTIVE, State: 'DELETING', StateReason: `gone; ${CALLER_ARN}` },
        tail: 'entered DELETING: ',
        reason: `gone; ${CALLER_ARN}`,
        run: () =>
          new LambdaNetworkConnectorProvider().update(
            'Res',
            NC_ARN,
            NC,
            { ...NC_PROPS, OperatorRole: 'arn:aws:iam::111122223333:role/op2' },
            NC_PROPS
          ),
      },
      {
        arm: 'a delete that ends DELETE_FAILED',
        state: { State: 'DELETE_FAILED', StateReason: `in use; ${CALLER_ARN}` },
        tail: 'entered DELETE_FAILED: ',
        reason: `in use; ${CALLER_ARN}`,
        run: () => new LambdaNetworkConnectorProvider().delete('Res', NC_ARN, NC),
      },
    ])('$arm withholds the reason text and keeps it on a stamped cause', async ({ state, tail, reason, run }) => {
      mockSend.mockImplementation(async (command: unknown) => {
        if (commandName(command) === 'GetNetworkConnectorCommand') return state;
        return {};
      });
      const failure = await thrown(run());

      expect(failure.message).toContain(`${tail}${VERBOSE_POINTER}`);
      expect(failure.message).not.toContain(CALLER_ACCOUNT);
      expect(hasRedactedCause(failure)).toBe(true);
      expect(retryClassificationText(failure)).toContain(reason);
      expect(debugged()).toContain(reason);
    });
  });

  it("flattens a multi-line connector status reason to one debug line", async () => {
    mockSend.mockImplementation(async (command: unknown) => {
      const n = commandName(command);
      if (n === 'CreateNetworkConnectorCommand') return { Arn: NC_ARN };
      if (n === 'GetNetworkConnectorCommand') {
        return { State: 'FAILED', StateReason: 'role denied\nforged row', StateReasonCode: 'X' };
      }
      return {};
    });
    await thrown(new LambdaNetworkConnectorProvider().create('Res', NC, NC_PROPS));

    const line = debugSpy.mock.calls
      .map((args) => String(args[0]))
      .find((l) => l.includes('entered FAILED: role'));
    expect(line).toBeDefined();
    expect(line).not.toContain('\n');
    expect(line).toContain('forged row');
  });

  describe('a taken name is still a collision at every create', () => {
    it.each([
      {
        site: 'IAM managed policy',
        command: 'CreatePolicyCommand',
        error: () =>
          awsError('EntityAlreadyExists', 'A policy called my-policy already exists.', 409),
        run: () =>
          new IAMManagedPolicyProvider().create('Res', POLICY, {
            ManagedPolicyName: 'my-policy',
            PolicyDocument: POLICY_DOC,
          }),
      },
      {
        site: 'budget',
        command: 'CreateBudgetCommand',
        error: () =>
          awsError('DuplicateRecordException', 'Error creating budget: the budget already exists.'),
        run: () => new BudgetsBudgetProvider().create('Res', BUDGET, budgetProps()),
      },
      {
        site: 'network connector',
        command: 'CreateNetworkConnectorCommand',
        error: () => awsError('ResourceConflictException', 'Network connector egress already exists.', 409),
        run: () => new LambdaNetworkConnectorProvider().create('Res', NC, NC_PROPS),
      },
    ])('$site', async ({ command, error, run }) => {
      failOn(command, error(), STS);
      const failure = await thrown(run());

      expect(mockSend.mock.calls.some(([c]) => commandName(c) === command)).toBe(true);
      expect(failure.message).toContain(VERBOSE_POINTER);
      expect(failure.message).toContain('AWS reports that it already exists.');
      expect(isNameCollisionErrorFrom(failure, 'Res')).toBe(true);
    });
  });

  describe('masking of the redacted line itself', () => {
    it('masks a secret in the error class on the thrown summary', async () => {
      failOn('CreateRoleCommand', awsError(`Bad${SECRET}`, 'refused'));
      const failure = await thrown(
        new IAMRoleProvider().create('Res', ROLE, ROLE_PROPS, { maskSecrets: MASK })
      );

      expect(failure.message).toContain(`Bad***. ${VERBOSE_POINTER}`);
      expect(failure.message).not.toContain(SECRET);
    });

    it("masks cdkd's own prefix on the debug line, not only AWS's text", async () => {
      failOn('DeleteBudgetCommand', awsError('ValidationException', 'refused'), STS);
      await thrown(
        new BudgetsBudgetProvider().delete(`Res-${SECRET}`, 'team-budget', BUDGET, undefined, {
          maskSecrets: MASK,
        })
      );

      const lines = debugSpy.mock.calls
        .map((args) => String(args[0]))
        .filter((line) => line.startsWith('Failed to delete budget'));
      expect(lines).toEqual(['Failed to delete budget Res-***: refused']);
    });
  });
});
