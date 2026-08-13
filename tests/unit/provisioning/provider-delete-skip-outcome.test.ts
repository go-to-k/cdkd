import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

/**
 * Issue #1770: the eight warn-and-continue DELETE arms OUTSIDE the
 * malformed-composite-physicalId family (Lambda layer / permission, Custom
 * Resource, IAM policy / user-group) used to `return;`. The destroy runner's
 * only signal is the return value, so a bare `return` was indistinguishable
 * from a completed delete — it printed `✓ <id> (<type>) deleted`, counted the
 * resource toward `N deleted`, dropped its state record, and exited 0 while the
 * AWS resource stayed alive.
 *
 * These are the same class the five composite-id arms were (issue #1752);
 * `tests/unit/provisioning/composite-id-delete-skip-outcome.test.ts` is the
 * shape this file mirrors.
 *
 * Two assertions per arm carry the weight:
 *  - the `noSend()` beside each skip — a `'skipped'` outcome claims cdkd did
 *    NOT address the resource, and for all eight of these that means no AWS
 *    call at all;
 *  - the INVERTED CONTROL below it — a guard that fired unconditionally would
 *    satisfy every skip assertion, so each arm also gets a well-formed input
 *    that must reach the real delete.
 */

const warnSpy = vi.hoisted(() => vi.fn());
const send = vi.hoisted(() => vi.fn());

const stubClient = vi.hoisted(
  () => () => ({ send, config: { region: () => Promise.resolve('us-east-1') } })
);

vi.mock('@aws-sdk/client-lambda', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@aws-sdk/client-lambda');
  return { ...actual, LambdaClient: vi.fn().mockImplementation(stubClient) };
});
vi.mock('@aws-sdk/client-iam', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@aws-sdk/client-iam');
  return { ...actual, IAMClient: vi.fn().mockImplementation(stubClient) };
});

vi.mock('../../../src/utils/logger.js', () => {
  const child = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: warnSpy,
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => child,
      debug: vi.fn(),
      info: vi.fn(),
      warn: warnSpy,
      error: vi.fn(),
    }),
  };
});

import {
  LambdaLayerVersionProvider,
  LAYER_ARN_SKIP_REASON,
  LAYER_VERSION_SKIP_REASON,
} from '../../../src/provisioning/providers/lambda-layer-provider.js';
import {
  LambdaPermissionProvider,
  PERMISSION_FUNCTION_NAME_SKIP_REASON,
} from '../../../src/provisioning/providers/lambda-permission-provider.js';
import {
  CustomResourceProvider,
  CR_NO_PROPERTIES_SKIP_REASON,
  CR_NO_SERVICE_TOKEN_SKIP_REASON,
} from '../../../src/provisioning/providers/custom-resource-provider.js';
import {
  IAMPolicyProvider,
  POLICY_NAME_SKIP_REASON,
} from '../../../src/provisioning/providers/iam-policy-provider.js';
import {
  IAMUserGroupProvider,
  MEMBERSHIP_NO_PROPERTIES_SKIP_REASON,
  MEMBERSHIP_MISSING_FIELDS_SKIP_REASON,
} from '../../../src/provisioning/providers/iam-user-group-provider.js';

const LAMBDA_ARN = 'arn:aws:lambda:us-east-1:111122223333:function:my-handler';

describe('non-composite-id DELETE skip arms report outcome: skipped (issue #1770)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const noSend = () => expect(send).not.toHaveBeenCalled();
  const warnText = () => warnSpy.mock.calls.map((c) => String(c[0])).join('\n');

  const cases: Array<{
    name: string;
    reason: string;
    warnContains: string;
    run: () => Promise<unknown>;
  }> = [
    {
      name: 'AWS::Lambda::LayerVersion — malformed LayerVersionArn',
      reason: LAYER_ARN_SKIP_REASON,
      warnContains: 'LEFT IN PLACE',
      run: () =>
        new LambdaLayerVersionProvider().delete(
          'MyLayer',
          'arn:aws:lambda:us-east-1:layer:1',
          'AWS::Lambda::LayerVersion'
        ),
    },
    {
      name: 'AWS::Lambda::LayerVersion — unparsable version segment',
      reason: LAYER_VERSION_SKIP_REASON,
      warnContains: 'LEFT IN PLACE',
      run: () =>
        new LambdaLayerVersionProvider().delete(
          'MyLayer',
          'arn:aws:lambda:us-east-1:111122223333:layer:my-layer:latest',
          'AWS::Lambda::LayerVersion'
        ),
    },
    {
      name: 'AWS::Lambda::Permission — FunctionName missing from state',
      reason: PERMISSION_FUNCTION_NAME_SKIP_REASON,
      warnContains: 'LEFT IN PLACE',
      run: () =>
        new LambdaPermissionProvider().delete(
          'MyPerm',
          `${LAMBDA_ARN}|AllowInvoke`,
          'AWS::Lambda::Permission',
          {}
        ),
    },
    {
      name: 'Custom::Thing — no properties in state',
      reason: CR_NO_PROPERTIES_SKIP_REASON,
      warnContains: 'LEFT IN PLACE',
      run: () => new CustomResourceProvider().delete('MyCr', 'cr-physical-id', 'Custom::Thing'),
    },
    {
      name: 'Custom::Thing — no ServiceToken in state',
      reason: CR_NO_SERVICE_TOKEN_SKIP_REASON,
      warnContains: 'LEFT IN PLACE',
      run: () =>
        new CustomResourceProvider().delete('MyCr', 'cr-physical-id', 'Custom::Thing', {
          SomeProp: 'value',
        }),
    },
    {
      name: 'AWS::IAM::Policy — empty policy name in physicalId',
      reason: POLICY_NAME_SKIP_REASON,
      warnContains: 'LEFT ATTACHED',
      run: () =>
        new IAMPolicyProvider().delete('MyPolicy', ':my-role', 'AWS::IAM::Policy', {
          Roles: ['my-role'],
        }),
    },
    {
      name: 'AWS::IAM::UserToGroupAddition — no properties in state',
      reason: MEMBERSHIP_NO_PROPERTIES_SKIP_REASON,
      warnContains: 'LEFT IN PLACE',
      run: () =>
        new IAMUserGroupProvider().delete(
          'MyAddition',
          'MyAddition',
          'AWS::IAM::UserToGroupAddition'
        ),
    },
    {
      name: 'AWS::IAM::UserToGroupAddition — GroupName/Users missing from state',
      reason: MEMBERSHIP_MISSING_FIELDS_SKIP_REASON,
      warnContains: 'LEFT IN PLACE',
      run: () =>
        new IAMUserGroupProvider().delete(
          'MyAddition',
          'MyAddition',
          'AWS::IAM::UserToGroupAddition',
          { GroupName: 'my-group' }
        ),
    },
  ];

  it.each(cases)('$name reports the skip and issues no AWS call', async ({ reason, run }) => {
    const result = await run();

    expect(result).toEqual({ outcome: 'skipped', reason });
    // A `'skipped'` outcome asserts nothing was attempted — pin it.
    noSend();
  });

  it.each(cases)('$name still warns with the full remediation text', async ({
    warnContains,
    run,
  }) => {
    await run();

    // The short `reason` is the status-line form; the operator-facing sentence
    // saying the resource survived, and how to repair it, still goes out.
    expect(warnText()).toContain(warnContains);
  });

  it('every reason names the state record rather than an AWS failure', () => {
    // The wording is user-facing on the destroy status line, and a reason that
    // read like an AWS error would send the user to the wrong place: for all
    // eight arms the repair is in state.json, not in AWS.
    const reasons = [
      LAYER_ARN_SKIP_REASON,
      LAYER_VERSION_SKIP_REASON,
      PERMISSION_FUNCTION_NAME_SKIP_REASON,
      CR_NO_PROPERTIES_SKIP_REASON,
      CR_NO_SERVICE_TOKEN_SKIP_REASON,
      POLICY_NAME_SKIP_REASON,
      MEMBERSHIP_NO_PROPERTIES_SKIP_REASON,
      MEMBERSHIP_MISSING_FIELDS_SKIP_REASON,
    ];
    for (const reason of reasons) {
      expect(reason.length).toBeLessThanOrEqual(64);
      expect(reason).toMatch(/state|physicalId/);
      // Each says what did NOT happen, so the line is actionable on its own.
      expect(reason).toMatch(/no delete issued|not invoked|not removed/);
    }
    // Distinct wording per arm — a shared literal would make the destroy line
    // unable to say WHICH half of the record is broken.
    expect(new Set(reasons).size).toBe(reasons.length);
  });
});

describe('inverted controls: a well-formed input still runs the real delete (issue #1770)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('AWS::Lambda::LayerVersion: a well-formed version ARN deletes', async () => {
    // Passes BOTH layer guards: 8+ ARN segments (arm 1) and a numeric trailing
    // version (arm 2).
    send.mockResolvedValue({});

    await expect(
      new LambdaLayerVersionProvider().delete(
        'MyLayer',
        'arn:aws:lambda:us-east-1:111122223333:layer:my-layer:3',
        'AWS::Lambda::LayerVersion'
      )
    ).resolves.toBeUndefined();

    expect(send).toHaveBeenCalledTimes(1);
    const input = send.mock.calls[0]![0].input as Record<string, unknown>;
    expect(input['LayerName']).toBe('my-layer');
    expect(input['VersionNumber']).toBe(3);
  });

  it('AWS::Lambda::Permission: a FunctionName in state removes the statement', async () => {
    send.mockResolvedValue({});

    await expect(
      new LambdaPermissionProvider().delete(
        'MyPerm',
        `${LAMBDA_ARN}|AllowInvoke`,
        'AWS::Lambda::Permission',
        { FunctionName: 'my-handler' }
      )
    ).resolves.toBeUndefined();

    expect(send).toHaveBeenCalledTimes(1);
    const input = send.mock.calls[0]![0].input as Record<string, unknown>;
    expect(input['FunctionName']).toBe('my-handler');
    expect(input['StatementId']).toBe('AllowInvoke');
  });

  it('Custom::Thing: a ServiceToken in state reaches AWS and does NOT report a skip', async () => {
    // The first AWS call on the well-formed path is the backing-Lambda
    // pre-check (issue #804). Answering it `ResourceNotFoundException` takes
    // the "already deleted" arm — which is deliberately still a `deleted`
    // (the handler can never run again, so the resource IS gone), and is the
    // out-of-scope half of issue #1770. Reaching it at all proves the two
    // skip guards above did not fire.
    const notFound = Object.assign(new Error('not found'), {
      name: 'ResourceNotFoundException',
    });
    send.mockRejectedValueOnce(notFound);

    await expect(
      new CustomResourceProvider().delete('MyCr', 'cr-physical-id', 'Custom::Thing', {
        ServiceToken: LAMBDA_ARN,
      })
    ).resolves.toBeUndefined();

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0].input as Record<string, unknown>).toEqual({
      FunctionName: LAMBDA_ARN,
    });
  });

  it('AWS::IAM::Policy: a non-empty policy name deletes the inline policy', async () => {
    send.mockResolvedValue({});

    await expect(
      new IAMPolicyProvider().delete('MyPolicy', 'my-policy', 'AWS::IAM::Policy', {
        Roles: ['my-role'],
      })
    ).resolves.toBeUndefined();

    expect(send).toHaveBeenCalledTimes(1);
    const input = send.mock.calls[0]![0].input as Record<string, unknown>;
    expect(input['RoleName']).toBe('my-role');
    expect(input['PolicyName']).toBe('my-policy');
  });

  it('AWS::IAM::UserToGroupAddition: GroupName + Users removes the membership', async () => {
    send.mockResolvedValue({});

    await expect(
      new IAMUserGroupProvider().delete(
        'MyAddition',
        'MyAddition',
        'AWS::IAM::UserToGroupAddition',
        { GroupName: 'my-group', Users: ['alice'] }
      )
    ).resolves.toBeUndefined();

    expect(send).toHaveBeenCalledTimes(1);
    const input = send.mock.calls[0]![0].input as Record<string, unknown>;
    expect(input['GroupName']).toBe('my-group');
    expect(input['UserName']).toBe('alice');
  });

  it('AWS::IAM::UserToGroupAddition: an EMPTY Users array is a delete, not a skip', async () => {
    // The judgment call recorded in `deleteUserToGroupAddition`: `Users: []` is
    // a VALID membership list with nothing to detach, so it falls through the
    // `!users` guard (an array is truthy) and reports `deleted`. Only a record
    // MISSING the required field is a skip. Pinned because collapsing the two
    // would turn a legitimate no-op destroy into a non-zero exit.
    await expect(
      new IAMUserGroupProvider().delete(
        'MyAddition',
        'MyAddition',
        'AWS::IAM::UserToGroupAddition',
        { GroupName: 'my-group', Users: [] }
      )
    ).resolves.toBeUndefined();

    expect(send).not.toHaveBeenCalled();
  });
});
