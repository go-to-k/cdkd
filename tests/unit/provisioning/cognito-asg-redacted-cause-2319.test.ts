import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// go-to-k/cdkd#2319: a THROWN provider failure is persisted to
// `deployments/{runId}.jsonl`, and AWS words an access denial with the
// caller's account id, assumed-role ARN and session name. The Cognito User
// Pool and Auto Scaling group create / update / delete wraps name an
// AWS-authored failure by its class plus the `--verbose` pointer, keep the AWS
// error as `cause` (stamped so the retry classifiers still read its wording),
// and send AWS's text to debug through the operation's masker.

const mockCognitoSend = vi.hoisted(() => vi.fn());
const mockAsgSend = vi.hoisted(() => vi.fn());
const mockEc2Send = vi.hoisted(() => vi.fn());
const childLogger = vi.hoisted(() => {
  const logger: Record<string, unknown> = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  logger['child'] = () => logger;
  return logger as {
    debug: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
});

vi.mock('@aws-sdk/client-cognito-identity-provider', async () => {
  const actual = await vi.importActual('@aws-sdk/client-cognito-identity-provider');
  return {
    ...actual,
    CognitoIdentityProviderClient: vi.fn().mockImplementation(() => ({
      send: mockCognitoSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('@aws-sdk/client-auto-scaling', async () => {
  const actual = await vi.importActual('@aws-sdk/client-auto-scaling');
  return {
    ...actual,
    AutoScalingClient: vi.fn().mockImplementation(() => ({
      send: mockAsgSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('@aws-sdk/client-ec2', async () => {
  const actual = await vi.importActual('@aws-sdk/client-ec2');
  return {
    ...actual,
    EC2Client: vi.fn().mockImplementation(() => ({
      send: mockEc2Send,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('../../../src/utils/logger.js', () => ({ getLogger: () => childLogger }));

import { CognitoUserPoolProvider } from '../../../src/provisioning/providers/cognito-provider.js';
import { ASGProvider } from '../../../src/provisioning/providers/asg-provider.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';
import { extractDeploymentEventError } from '../../../src/types/deployment-events.js';
import {
  hasRedactedCause,
  isMarkedNonRetryable,
  isNameCollisionErrorFrom,
  isRetryableTransientError,
  retryClassificationText,
} from '../../../src/deployment/retryable-errors.js';
import { VERBOSE_POINTER } from '../../../src/utils/aws-failure-text.js';
import { createdBeforeFailure } from '../../../src/provisioning/auxiliary-failure.js';

const CALLER_ACCOUNT = '111122223333';
const CALLER_ROLE = 'deployer-role-2319';
const POOL_ID = 'us-east-1_abc123';
const POOL_TYPE = 'AWS::Cognito::UserPool';
const ASG_TYPE = 'AWS::AutoScaling::AutoScalingGroup';
const ASG_PROPS = { AutoScalingGroupName: 'my-asg', MinSize: '0', MaxSize: '1' };

/** An AWS access denial as the SDK throws it, naming the caller. */
function accessDenied(name: string, action: string): Error {
  return Object.assign(
    new Error(
      `User: arn:aws:sts::${CALLER_ACCOUNT}:assumed-role/${CALLER_ROLE}/cdkd-session is not ` +
        `authorized to perform: ${action} because no identity-based policy allows the ${action} action`
    ),
    { name, $fault: 'client', $metadata: { httpStatusCode: 400 } }
  );
}

/** Masks the caller's role name, standing in for the deploy's secret masker. */
const mask = (text: string): string => text.split(CALLER_ROLE).join('***');

const debugged = (): string[] => childLogger.debug.mock.calls.map((c) => c.map(String).join(' '));
const warned = (): string[] => childLogger.warn.mock.calls.map((c) => c.map(String).join(' '));

async function thrown(run: Promise<unknown>): Promise<Error> {
  return run.then(
    () => expect.fail('expected the operation to fail'),
    (e: unknown) => e as Error
  );
}

/** Assertions every redacted wrap owes, whichever AWS call failed. */
function expectRedacted(error: Error, prefix: string, cause: Error): void {
  expect(error).toBeInstanceOf(ProvisioningError);
  expect(error.message).toBe(`${prefix}: ${cause.name}. ${VERBOSE_POINTER}`);
  const persisted = JSON.stringify(extractDeploymentEventError(error));
  expect(persisted).not.toContain(CALLER_ACCOUNT);
  expect(persisted).not.toContain(CALLER_ROLE);
  // The AWS error stays the cause, and the stamp lets the chain-reading retry
  // classifiers see its wording (IAM propagation reads as retryable).
  expect(error.cause).toBe(cause);
  expect(hasRedactedCause(error)).toBe(true);
  expect(retryClassificationText(error)).toContain('not authorized to perform');
  expect(isRetryableTransientError(error, retryClassificationText(error))).toBe(true);
  // AWS's text reaches debug, through the operation's masker.
  const lines = debugged().filter((l) => l.includes(prefix));
  expect(lines.some((l) => l.includes('is not authorized to perform'))).toBe(true);
  expect(lines.some((l) => l.includes(CALLER_ROLE))).toBe(false);
  expect(lines.some((l) => l.includes('assumed-role/***'))).toBe(true);
}

beforeEach(() => {
  mockCognitoSend.mockReset();
  mockAsgSend.mockReset();
  mockEc2Send.mockReset();
  mockEc2Send.mockResolvedValue({ Reservations: [] });
  childLogger.debug.mockReset();
  childLogger.warn.mockReset();
  childLogger.error.mockReset();
});

describe('CognitoUserPoolProvider thrown errors keep the caller identity out (go-to-k/cdkd#2319)', () => {
  it('reduces a denied CreateUserPool to the class', async () => {
    const denial = accessDenied('AccessDeniedException', 'cognito-idp:CreateUserPool');
    mockCognitoSend.mockRejectedValue(denial);

    const error = await thrown(
      new CognitoUserPoolProvider().create('Pool', POOL_TYPE, {}, { maskSecrets: mask })
    );

    expectRedacted(error, 'Failed to create Cognito User Pool Pool', denial);
  });

  it('reduces a denied UpdateUserPool to the class', async () => {
    const denial = accessDenied('AccessDeniedException', 'cognito-idp:UpdateUserPool');
    mockCognitoSend.mockImplementation(async (command: { constructor: { name: string } }) => {
      if (command.constructor.name === 'UpdateUserPoolCommand') throw denial;
      return { UserPool: { Id: POOL_ID } };
    });

    const error = await thrown(
      new CognitoUserPoolProvider().update(
        'Pool',
        POOL_ID,
        POOL_TYPE,
        { AutoVerifiedAttributes: ['email'] },
        {},
        { maskSecrets: mask }
      )
    );

    expectRedacted(error, 'Failed to update Cognito User Pool Pool', denial);
  });

  it('reduces a denied DeleteUserPool to the class', async () => {
    const denial = accessDenied('AccessDeniedException', 'cognito-idp:DeleteUserPool');
    mockCognitoSend.mockRejectedValue(denial);

    const error = await thrown(
      new CognitoUserPoolProvider().delete('Pool', POOL_ID, POOL_TYPE, undefined, {
        maskSecrets: mask,
      })
    );

    expectRedacted(error, 'Failed to delete Cognito User Pool Pool', denial);
  });

  it('names a denied rollback delete by its class at warn, with AWS text at masked debug', async () => {
    const mfaDenial = accessDenied('AccessDeniedException', 'cognito-idp:SetUserPoolMfaConfig');
    const rollbackDenial = accessDenied('AccessDeniedException', 'cognito-idp:DeleteUserPool');
    mockCognitoSend.mockImplementation(async (command: { constructor: { name: string } }) => {
      switch (command.constructor.name) {
        case 'CreateUserPoolCommand':
          return { UserPool: { Id: POOL_ID } };
        case 'SetUserPoolMfaConfigCommand':
          throw mfaDenial;
        case 'DeleteUserPoolCommand':
          throw rollbackDenial;
        default:
          return {};
      }
    });

    const error = await thrown(
      new CognitoUserPoolProvider().create(
        'Pool',
        POOL_TYPE,
        { MfaConfiguration: 'OPTIONAL', EnabledMfas: ['SOFTWARE_TOKEN_MFA'] },
        { maskSecrets: mask }
      )
    );

    expect(error.message).toBe(
      `Failed to create Cognito User Pool Pool: AccessDeniedException. ${VERBOSE_POINTER}`
    );
    expect(error.cause).toBe(mfaDenial);
    expect(hasRedactedCause(error)).toBe(true);
    // The pool was left behind: terminal (go-to-k/cdkd#4945), and named.
    expect(isMarkedNonRetryable(error)).toBe(true);
    expect(createdBeforeFailure(error, 'Pool', POOL_TYPE)).toBe(POOL_ID);
    const rollbackWarn = warned().filter((l) => l.includes('Failed to roll back'));
    expect(rollbackWarn).toEqual([
      `Failed to roll back partially-created Cognito User Pool ${POOL_ID}: AccessDeniedException. ${VERBOSE_POINTER}`,
    ]);
    const rollbackDebug = debugged().filter((l) => l.includes('Rollback of partially-created'));
    expect(rollbackDebug).toHaveLength(1);
    expect(rollbackDebug[0]).toContain('assumed-role/***');
    expect(rollbackDebug[0]).not.toContain(CALLER_ROLE);
  });

  it('restates a name collision on a redacted create', async () => {
    mockCognitoSend.mockRejectedValue(
      Object.assign(new Error('A user pool with this name already exists'), {
        name: 'InvalidParameterException',
        $fault: 'client',
        $metadata: { httpStatusCode: 400 },
      })
    );

    const error = await thrown(new CognitoUserPoolProvider().create('Pool', POOL_TYPE, {}));

    expect(error.message).toBe(
      `Failed to create Cognito User Pool Pool: InvalidParameterException. ${VERBOSE_POINTER} AWS reports that it already exists.`
    );
  });

  it("keeps a cdkd-authored failure's own text", async () => {
    mockCognitoSend.mockResolvedValue({ UserPool: {} });

    const error = await thrown(new CognitoUserPoolProvider().create('Pool', POOL_TYPE, {}));

    expect(error.message).toBe(
      'Failed to create Cognito User Pool Pool: CreateUserPool did not return UserPool.Id'
    );
    expect(hasRedactedCause(error)).toBe(false);
  });

  it('withholds a non-Error throw, unstamped', async () => {
    mockCognitoSend.mockRejectedValue(`denied for ${CALLER_ROLE}`);

    const error = await thrown(new CognitoUserPoolProvider().create('Pool', POOL_TYPE, {}));

    expect(error.message).toBe(
      `Failed to create Cognito User Pool Pool: a non-Error value of type string. ${VERBOSE_POINTER}`
    );
    expect(hasRedactedCause(error)).toBe(false);
  });
});

describe('ASGProvider thrown errors keep the caller identity out (go-to-k/cdkd#2319)', () => {
  it('reduces a denied CreateAutoScalingGroup to the class', async () => {
    const denial = accessDenied('AccessDenied', 'autoscaling:CreateAutoScalingGroup');
    mockAsgSend.mockRejectedValue(denial);

    const error = await thrown(
      new ASGProvider().create('MyAsg', ASG_TYPE, ASG_PROPS, { maskSecrets: mask })
    );

    expectRedacted(error, 'Failed to create AutoScalingGroup MyAsg', denial);
  });

  it('names a retire failure by its class in the survivor note, with AWS text at masked debug', async () => {
    const wiring = accessDenied('AccessDenied', 'autoscaling:EnableMetricsCollection');
    const retire = accessDenied('AccessDenied', 'autoscaling:DeleteAutoScalingGroup');
    mockAsgSend.mockImplementation(async (command: { constructor: { name: string } }) => {
      switch (command.constructor.name) {
        case 'EnableMetricsCollectionCommand':
          throw wiring;
        case 'DeleteAutoScalingGroupCommand':
          throw retire;
        case 'DescribeAutoScalingGroupsCommand':
          return { AutoScalingGroups: [] };
        default:
          return {};
      }
    });

    const error = await thrown(
      new ASGProvider().create(
        'MyAsg',
        ASG_TYPE,
        { ...ASG_PROPS, MetricsCollection: [{ Granularity: '1Minute' }] },
        { maskSecrets: mask }
      )
    );

    expect(error.message.startsWith(
      `Failed to create AutoScalingGroup MyAsg: AccessDenied. ${VERBOSE_POINTER} The group was created, and cdkd could not delete it (AccessDenied. ${VERBOSE_POINTER});`
    )).toBe(true);
    const persisted = JSON.stringify(extractDeploymentEventError(error));
    expect(persisted).not.toContain(CALLER_ACCOUNT);
    expect(persisted).not.toContain(CALLER_ROLE);
    expect(error.cause).toBe(wiring);
    expect(hasRedactedCause(error)).toBe(true);
    expect(isMarkedNonRetryable(error)).toBe(true);
    expect(createdBeforeFailure(error, 'MyAsg', ASG_TYPE)).toBe('my-asg');
    const retireDebug = debugged().filter((l) => l.includes('did not finish'));
    expect(retireDebug).toHaveLength(1);
    expect(retireDebug[0]).toContain('autoscaling:DeleteAutoScalingGroup');
    expect(retireDebug[0]).toContain('assumed-role/***');
    expect(retireDebug[0]).not.toContain(CALLER_ROLE);
  });

  it('reduces a denied UpdateAutoScalingGroup to the class', async () => {
    const denial = accessDenied('AccessDenied', 'autoscaling:UpdateAutoScalingGroup');
    mockAsgSend.mockImplementation(async (command: { constructor: { name: string } }) => {
      if (command.constructor.name === 'UpdateAutoScalingGroupCommand') throw denial;
      return { AutoScalingGroups: [{ AutoScalingGroupName: 'my-asg' }] };
    });

    const error = await thrown(
      new ASGProvider().update(
        'MyAsg',
        'my-asg',
        ASG_TYPE,
        { ...ASG_PROPS, MaxSize: '2' },
        ASG_PROPS,
        { maskSecrets: mask }
      )
    );

    expectRedacted(error, 'Failed to update AutoScalingGroup MyAsg', denial);
  });

  it('reduces a denied DeleteAutoScalingGroup to the class', async () => {
    const denial = accessDenied('AccessDenied', 'autoscaling:DeleteAutoScalingGroup');
    mockAsgSend.mockRejectedValue(denial);

    const error = await thrown(
      new ASGProvider().delete('MyAsg', 'my-asg', ASG_TYPE, undefined, { maskSecrets: mask })
    );

    expectRedacted(error, 'Failed to delete AutoScalingGroup MyAsg', denial);
  });

  it('restates a name collision, so the collision classifier still reads it', async () => {
    const collision = Object.assign(
      new Error('AutoScalingGroup by this name already exists - A group with the name my-asg already exists'),
      { name: 'AlreadyExists', $fault: 'client', $metadata: { httpStatusCode: 400 } }
    );
    mockAsgSend.mockRejectedValue(collision);

    const error = await thrown(new ASGProvider().create('MyAsg', ASG_TYPE, ASG_PROPS));

    expect(error.message).toBe(
      `Failed to create AutoScalingGroup MyAsg: AlreadyExists. ${VERBOSE_POINTER} AWS reports that it already exists.`
    );
    expect(isNameCollisionErrorFrom(error, 'MyAsg')).toBe(true);
  });

  it('keeps a secret AWS quotes out of the thrown message and masked on debug', async () => {
    const SECRET = 'S3CR3T-VALUE';
    const secretMask = (text: string): string => text.split(SECRET).join('***');
    mockAsgSend.mockRejectedValue(
      Object.assign(new Error(`value ${SECRET} is not valid`), {
        name: 'ValidationError',
        $fault: 'client',
        $metadata: { httpStatusCode: 400 },
      })
    );

    const error = await thrown(
      new ASGProvider().create('MyAsg', ASG_TYPE, ASG_PROPS, { maskSecrets: secretMask })
    );

    expect(error.message).toBe(
      `Failed to create AutoScalingGroup MyAsg: ValidationError. ${VERBOSE_POINTER}`
    );
    const lines = debugged().filter((l) => l.includes('Failed to create AutoScalingGroup MyAsg'));
    expect(lines).toEqual(['Failed to create AutoScalingGroup MyAsg: value *** is not valid']);
  });

  it("keeps a transport failure's own text on delete", async () => {
    mockAsgSend.mockRejectedValue(
      Object.assign(new Error('socket hang up'), { name: 'TimeoutError', code: 'ECONNRESET' })
    );

    const error = await thrown(new ASGProvider().delete('MyAsg', 'my-asg', ASG_TYPE));

    expect(error.message).toBe('Failed to delete AutoScalingGroup MyAsg: socket hang up');
    expect(hasRedactedCause(error)).toBe(false);
  });
});

describe('the arms a redaction leaves alone (go-to-k/cdkd#2319)', () => {
  const awsShaped = (name: string, message: string): Error =>
    Object.assign(new Error(message), {
      name,
      $fault: 'client',
      $metadata: { httpStatusCode: 400 },
    });

  it('withholds a non-Error ASG throw, unstamped', async () => {
    mockAsgSend.mockRejectedValue(`denied for ${CALLER_ROLE}`);

    const error = await thrown(new ASGProvider().delete('MyAsg', 'my-asg', ASG_TYPE));

    expect(error.message).toBe(
      `Failed to delete AutoScalingGroup MyAsg: a non-Error value of type string. ${VERBOSE_POINTER}`
    );
    expect(hasRedactedCause(error)).toBe(false);
  });

  it("masks a transport failure's text on the ASG delete", async () => {
    const SECRET = 'S3CR3T-GROUP';
    mockAsgSend.mockRejectedValue(
      Object.assign(new Error(`socket hang up near ${SECRET}`), { name: 'TimeoutError' })
    );

    const error = await thrown(
      new ASGProvider().delete('MyAsg', 'my-asg', ASG_TYPE, undefined, {
        maskSecrets: (t: string) => t.split(SECRET).join('***'),
      })
    );

    expect(error.message).toBe('Failed to delete AutoScalingGroup MyAsg: socket hang up near ***');
    // The mask changed the text, so the classifiers read the unmasked cause.
    expect(hasRedactedCause(error)).toBe(true);
  });

  it('does not restate a collision from a create-time wiring call (auxiliary)', async () => {
    mockAsgSend.mockImplementation(async (command: { constructor: { name: string } }) => {
      switch (command.constructor.name) {
        case 'EnableMetricsCollectionCommand':
          throw awsShaped('AlreadyExists', 'The resource already exists');
        case 'DescribeAutoScalingGroupsCommand':
          return { AutoScalingGroups: [] };
        default:
          return {};
      }
    });

    const error = await thrown(
      new ASGProvider().create('MyAsg', ASG_TYPE, {
        ...ASG_PROPS,
        MetricsCollection: [{ Granularity: '1Minute' }],
      })
    );

    expect(error.message).toBe(`Failed to create AutoScalingGroup MyAsg: AlreadyExists. ${VERBOSE_POINTER}`);
    expect(isNameCollisionErrorFrom(error, 'MyAsg')).toBe(false);
  });

  it("keeps a cdkd-authored retire failure's text in the survivor note, with no debug line", async () => {
    mockAsgSend.mockImplementation(async (command: { constructor: { name: string } }) => {
      switch (command.constructor.name) {
        case 'EnableMetricsCollectionCommand':
          throw awsShaped('ValidationError', 'wiring refused');
        case 'DeleteAutoScalingGroupCommand':
          throw Object.assign(new Error('socket hang up'), { name: 'TimeoutError' });
        case 'DescribeAutoScalingGroupsCommand':
          return { AutoScalingGroups: [] };
        default:
          return {};
      }
    });

    const error = await thrown(
      new ASGProvider().create('MyAsg', ASG_TYPE, {
        ...ASG_PROPS,
        MetricsCollection: [{ Granularity: '1Minute' }],
      })
    );

    expect(error.message).toContain('cdkd could not delete it (socket hang up);');
    expect(debugged().filter((l) => l.includes('did not finish'))).toHaveLength(0);
  });

  it('does not restate a collision from the post-create MFA call (auxiliary)', async () => {
    mockCognitoSend.mockImplementation(async (command: { constructor: { name: string } }) => {
      switch (command.constructor.name) {
        case 'CreateUserPoolCommand':
          return { UserPool: { Id: POOL_ID } };
        case 'SetUserPoolMfaConfigCommand':
          throw awsShaped('InvalidParameterException', 'The configuration already exists');
        default:
          return {};
      }
    });

    const error = await thrown(
      new CognitoUserPoolProvider().create('Pool', POOL_TYPE, {
        MfaConfiguration: 'OPTIONAL',
        EnabledMfas: ['SOFTWARE_TOKEN_MFA'],
      })
    );

    expect(error.message).toBe(
      `Failed to create Cognito User Pool Pool: InvalidParameterException. ${VERBOSE_POINTER}`
    );
    expect(isNameCollisionErrorFrom(error, 'Pool')).toBe(false);
  });

  it('withholds a non-Error retire failure in the survivor note', async () => {
    mockAsgSend.mockImplementation(async (command: { constructor: { name: string } }) => {
      switch (command.constructor.name) {
        case 'EnableMetricsCollectionCommand':
          throw awsShaped('ValidationError', 'wiring refused');
        case 'DeleteAutoScalingGroupCommand':
          throw `denied for ${CALLER_ROLE}`;
        case 'DescribeAutoScalingGroupsCommand':
          return { AutoScalingGroups: [] };
        default:
          return {};
      }
    });

    const error = await thrown(
      new ASGProvider().create('MyAsg', ASG_TYPE, {
        ...ASG_PROPS,
        MetricsCollection: [{ Granularity: '1Minute' }],
      })
    );

    expect(error.message).toContain(
      `cdkd could not delete it (a non-Error value of type string. ${VERBOSE_POINTER});`
    );
    expect(error.message).not.toContain(CALLER_ROLE);
  });

  it("masks a transport failure's text on the Cognito create, as the ASG wrap does", async () => {
    const SECRET = 'S3CR3T-POOL';
    mockCognitoSend.mockRejectedValue(
      Object.assign(new Error(`socket hang up near ${SECRET}`), { name: 'TimeoutError' })
    );

    const error = await thrown(
      new CognitoUserPoolProvider().create('Pool', POOL_TYPE, {}, {
        maskSecrets: (t: string) => t.split(SECRET).join('***'),
      })
    );

    expect(error.message).toBe('Failed to create Cognito User Pool Pool: socket hang up near ***');
    // The mask changed the text, so the classifiers read the unmasked cause.
    expect(hasRedactedCause(error)).toBe(true);
  });

  it("keeps a transport rollback failure's text at warn, with no debug line", async () => {
    mockCognitoSend.mockImplementation(async (command: { constructor: { name: string } }) => {
      switch (command.constructor.name) {
        case 'CreateUserPoolCommand':
          return { UserPool: { Id: POOL_ID } };
        case 'SetUserPoolMfaConfigCommand':
          throw awsShaped('InvalidParameterException', 'mfa refused');
        case 'DeleteUserPoolCommand':
          throw Object.assign(new Error('socket hang up'), { name: 'TimeoutError' });
        default:
          return {};
      }
    });

    await thrown(
      new CognitoUserPoolProvider().create('Pool', POOL_TYPE, {
        MfaConfiguration: 'OPTIONAL',
        EnabledMfas: ['SOFTWARE_TOKEN_MFA'],
      })
    );

    expect(warned().filter((l) => l.includes('Failed to roll back'))).toEqual([
      `Failed to roll back partially-created Cognito User Pool ${POOL_ID}: socket hang up`,
    ]);
    expect(debugged().filter((l) => l.includes('Rollback of partially-created'))).toHaveLength(0);
  });
});

/**
 * Putting the error CLASS into the top-level message must not move a
 * name-collision verdict either way: `ALREADY_EXISTS_CODE` matches a
 * `*AlreadyExists(Exception|Fault)` token, and a create-first replacement
 * refuses (NAMED_REPLACEMENT_COLLISION) on a `true`. Each case builds the
 * PRE-change wrap (`<prefix>: <AWS message>`, same `cause`) beside the wrap the
 * provider throws now, asserts the two verdicts agree, and pins the value.
 */
describe('name-collision verdicts are unchanged by the class-only wrap (go-to-k/cdkd#2319)', () => {
  const aws = (name: string, message: string): Error =>
    Object.assign(new Error(message), {
      name,
      $fault: 'client',
      $metadata: { httpStatusCode: 400 },
    });
  const ASG_EXISTS = 'AutoScalingGroup by this name already exists - A group with the name my-asg already exists';

  function preChange(error: Error, logicalId: string): Error {
    const cause = error.cause as Error;
    const prefix = error.message.slice(0, error.message.indexOf(': '));
    return new ProvisioningError(`${prefix}: ${cause.message}`, 'T', logicalId, undefined, cause);
  }

  function expectVerdict(error: Error, logicalId: string, expected: boolean): void {
    expect(error.cause).toBeInstanceOf(Error);
    expect(isNameCollisionErrorFrom(preChange(error, logicalId), logicalId)).toBe(expected);
    expect(isNameCollisionErrorFrom(error, logicalId)).toBe(expected);
  }

  type Op = 'create' | 'update' | 'delete';
  const runAsg = (op: Op): Promise<unknown> => {
    const p = new ASGProvider();
    if (op === 'create') return p.create('MyAsg', ASG_TYPE, ASG_PROPS);
    if (op === 'update')
      return p.update('MyAsg', 'my-asg', ASG_TYPE, { ...ASG_PROPS, MaxSize: '2' }, ASG_PROPS);
    return p.delete('MyAsg', 'my-asg', ASG_TYPE);
  };
  const asgCommand: Record<Op, string> = {
    create: 'CreateAutoScalingGroupCommand',
    update: 'UpdateAutoScalingGroupCommand',
    delete: 'DeleteAutoScalingGroupCommand',
  };

  it.each([
    ['create', 'AlreadyExistsFault', ASG_EXISTS, true],
    ['create', 'AlreadyExists', ASG_EXISTS, true],
    // The class token alone, with prose that does not say so: still no collision.
    ['create', 'AlreadyExistsFault', 'The group name is in use', false],
    ['create', 'LimitExceededFault', 'You have reached the limit of groups', false],
    ['create', 'ValidationError', 'Max bound, 2, must be greater than or equal to min bound, 3', false],
    ['update', 'AlreadyExistsFault', ASG_EXISTS, true],
    ['update', 'ResourceContentionFault', 'You already have a pending update', false],
    ['delete', 'ResourceInUseFault', 'You cannot delete an AutoScalingGroup while there are instances', false],
    ['delete', 'ScalingActivityInProgressFault', 'Scaling activities in progress', false],
  ] as const)('ASG %s %s', async (op, name, message, expected) => {
    mockAsgSend.mockImplementation(async (command: { constructor: { name: string } }) => {
      if (command.constructor.name === asgCommand[op]) throw aws(name, message);
      return { AutoScalingGroups: [{ AutoScalingGroupName: 'my-asg' }] };
    });

    expectVerdict(await thrown(runAsg(op)), 'MyAsg', expected);
  });

  it('ASG create: an AlreadyExistsFault from a wiring call stays no collision', async () => {
    mockAsgSend.mockImplementation(async (command: { constructor: { name: string } }) => {
      if (command.constructor.name === 'EnableMetricsCollectionCommand') {
        throw aws('AlreadyExistsFault', ASG_EXISTS);
      }
      return { AutoScalingGroups: [] };
    });

    const error = await thrown(
      new ASGProvider().create('MyAsg', ASG_TYPE, {
        ...ASG_PROPS,
        MetricsCollection: [{ Granularity: '1Minute' }],
      })
    );
    expectVerdict(error, 'MyAsg', false);
  });

  const runPool = (op: Op): Promise<unknown> => {
    const p = new CognitoUserPoolProvider();
    if (op === 'create') return p.create('Pool', POOL_TYPE, {});
    if (op === 'update')
      return p.update('Pool', POOL_ID, POOL_TYPE, { AutoVerifiedAttributes: ['email'] }, {});
    return p.delete('Pool', POOL_ID, POOL_TYPE);
  };
  const poolCommand: Record<Op, string> = {
    create: 'CreateUserPoolCommand',
    update: 'UpdateUserPoolCommand',
    delete: 'DeleteUserPoolCommand',
  };

  it.each([
    ['create', 'UsernameExistsException', 'User account already exists', true],
    ['create', 'AliasExistsException', 'An account with the given email already exists.', true],
    ['create', 'GroupExistsException', 'A group with the name already exists', true],
    ['create', 'InvalidParameterException', 'Invalid SMS configuration', false],
    ['create', 'LimitExceededException', 'User pool limit exceeded', false],
    ['create', 'UserPoolTaggingException', 'Tag key must not already exist on the pool', false],
    ['update', 'InvalidParameterException', 'The custom domain already exists', true],
    ['update', 'ConcurrentModificationException', 'Please retry', false],
    ['delete', 'InvalidParameterException', 'User pool cannot be deleted. It has a domain configured', false],
  ] as const)('Cognito %s %s', async (op, name, message, expected) => {
    mockCognitoSend.mockImplementation(async (command: { constructor: { name: string } }) => {
      if (command.constructor.name === poolCommand[op]) throw aws(name, message);
      return { UserPool: { Id: POOL_ID } };
    });

    expectVerdict(await thrown(runPool(op)), 'Pool', expected);
  });

  it('Cognito create: an "already exists" from the post-create MFA call stays no collision', async () => {
    mockCognitoSend.mockImplementation(async (command: { constructor: { name: string } }) => {
      if (command.constructor.name === 'CreateUserPoolCommand') return { UserPool: { Id: POOL_ID } };
      if (command.constructor.name === 'SetUserPoolMfaConfigCommand') {
        throw aws('InvalidParameterException', 'The configuration already exists');
      }
      return {};
    });

    const error = await thrown(
      new CognitoUserPoolProvider().create('Pool', POOL_TYPE, {
        MfaConfiguration: 'OPTIONAL',
        EnabledMfas: ['SOFTWARE_TOKEN_MFA'],
      })
    );
    expectVerdict(error, 'Pool', false);
  });
});
