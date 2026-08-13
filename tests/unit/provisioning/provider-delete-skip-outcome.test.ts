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
 * Three assertions per arm carry the weight:
 *  - the `noSend()` beside each skip — a `'skipped'` outcome claims cdkd did
 *    NOT address the resource, and for all eight of these that means no AWS
 *    call at all;
 *  - the INVERTED CONTROL below it — a guard that fired unconditionally would
 *    satisfy every skip assertion, so each arm also gets a well-formed input
 *    that must reach the real delete;
 *  - for the two arms that have a SECOND addressable source (Lambda permission
 *    -> the function ARN in the physicalId; IAM policy -> `PolicyName` in
 *    properties), a pair proving the fallback really deletes AND that the
 *    precedence between the sources is the deployed one first. A false skip is
 *    expensive — it preserves the state record and makes destroy exit 2 on
 *    every re-run — so those two must be exhausted before a skip is reported.
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

  // `warnContains` is deliberately ARM-SPECIFIC rather than the shared
  // "LEFT IN PLACE" every message happens to contain: a copy-pasted remediation
  // pointing at the wrong resource would satisfy a shared literal and tell the
  // user to go fix something unrelated.
  const cases: Array<{
    name: string;
    reason: string;
    warnContains: string;
    run: () => Promise<unknown>;
  }> = [
    {
      name: 'AWS::Lambda::LayerVersion — malformed LayerVersionArn',
      reason: LAYER_ARN_SKIP_REASON,
      warnContains: 'the layer version is LEFT IN PLACE',
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
      warnContains: 'Could not parse version number',
      run: () =>
        new LambdaLayerVersionProvider().delete(
          'MyLayer',
          'arn:aws:lambda:us-east-1:111122223333:layer:my-layer:latest',
          'AWS::Lambda::LayerVersion'
        ),
    },
    {
      name: 'AWS::Lambda::Permission — FunctionName absent from BOTH sources',
      reason: PERMISSION_FUNCTION_NAME_SKIP_REASON,
      warnContains: "LEFT IN PLACE on the function's resource policy",
      // No FunctionName in properties AND a physicalId whose leading segment is
      // not a function ARN — the only shape with no addressable route left.
      run: () =>
        new LambdaPermissionProvider().delete(
          'MyPerm',
          'not-an-arn|AllowInvoke',
          'AWS::Lambda::Permission',
          {}
        ),
    },
    {
      name: 'Custom::Thing — no properties in state',
      reason: CR_NO_PROPERTIES_SKIP_REASON,
      warnContains: 'No properties available for custom resource',
      run: () => new CustomResourceProvider().delete('MyCr', 'cr-physical-id', 'Custom::Thing'),
    },
    {
      name: 'Custom::Thing — no ServiceToken in state',
      reason: CR_NO_SERVICE_TOKEN_SKIP_REASON,
      warnContains: 'no handler to send the Delete request to',
      run: () =>
        new CustomResourceProvider().delete('MyCr', 'cr-physical-id', 'Custom::Thing', {
          SomeProp: 'value',
        }),
    },
    {
      name: 'AWS::IAM::Policy — leading-colon physicalId, no PolicyName property',
      reason: POLICY_NAME_SKIP_REASON,
      warnContains: 'LEFT ATTACHED to its roles / groups / users',
      run: () =>
        new IAMPolicyProvider().delete('MyPolicy', ':my-role', 'AWS::IAM::Policy', {
          Roles: ['my-role'],
        }),
    },
    {
      // The OTHER spelling the source comment names (`physicalId: ''`), which
      // takes the non-`includes(':')` branch and so is a genuinely different
      // path to the same guard.
      name: 'AWS::IAM::Policy — EMPTY physicalId, no PolicyName property',
      reason: POLICY_NAME_SKIP_REASON,
      warnContains: 'LEFT ATTACHED to its roles / groups / users',
      run: () =>
        new IAMPolicyProvider().delete('MyPolicy', '', 'AWS::IAM::Policy', {
          Roles: ['my-role'],
        }),
    },
    {
      name: 'AWS::IAM::UserToGroupAddition — no properties in state',
      reason: MEMBERSHIP_NO_PROPERTIES_SKIP_REASON,
      warnContains: 'No properties for UserToGroupAddition',
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
      warnContains: 'Missing GroupName or Users',
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

  it.each(cases)('$name carries the deploy-side caveat (issue #1762)', async ({ run }) => {
    await run();

    // "Repair state.json and re-run" is only true on DESTROY, where the skip
    // KEEPS the record. These same arms are reached from deploy-engine.ts and
    // rollback-executor.ts, which DROP it — so a remedy naming only state.json
    // is impossible on the path the user may actually be on. This is the
    // caveat `compositeIdFormatMessage` already carries for the composite-id
    // family; pinning it here stops the eight from drifting apart from it.
    expect(warnText()).toContain('https://github.com/go-to-k/cdkd/issues/1762');
  });

  // The four arms whose resource has an IN-STACK parent that would remove it
  // anyway. "LEFT IN PLACE" is FALSE for them when the parent is part of the
  // same destroy — deleting the function drops its whole resource policy,
  // deleting the role drops its inline policies, and deleteGroup /
  // deleteUser remove exactly these memberships — so AWS ends clean while
  // cdkd keeps the record and exits 2 on every re-run. The warning has to say
  // so, and name the command that clears the record.
  const parentQualifiedCases: Array<{ name: string; run: () => Promise<unknown> }> = [
    {
      name: 'AWS::Lambda::Permission',
      run: () =>
        new LambdaPermissionProvider().delete(
          'MyPerm',
          'not-an-arn|AllowInvoke',
          'AWS::Lambda::Permission',
          {}
        ),
    },
    {
      name: 'AWS::IAM::Policy',
      run: () =>
        new IAMPolicyProvider().delete('MyPolicy', ':my-role', 'AWS::IAM::Policy', {
          Roles: ['my-role'],
        }),
    },
    {
      name: 'AWS::IAM::UserToGroupAddition — no properties',
      run: () =>
        new IAMUserGroupProvider().delete(
          'MyAddition',
          'MyAddition',
          'AWS::IAM::UserToGroupAddition'
        ),
    },
    {
      name: 'AWS::IAM::UserToGroupAddition — missing fields',
      run: () =>
        new IAMUserGroupProvider().delete(
          'MyAddition',
          'MyAddition',
          'AWS::IAM::UserToGroupAddition',
          { GroupName: 'my-group' }
        ),
    },
  ];

  it.each(parentQualifiedCases)(
    '$name qualifies LEFT IN PLACE with the in-stack parent and names state orphan',
    async ({ run }) => {
      await run();

      const text = warnText();
      expect(text).toContain('UNLESS');
      expect(text).toContain('part of this stack');
      expect(text).toContain('cdkd state orphan');
    }
  );

  it('the arms with NO in-stack parent do NOT carry the qualifier', async () => {
    // A Lambda layer version and a Custom Resource's external side effects are
    // not removed by anything else in the destroy, so "LEFT IN PLACE" is
    // unconditional there. Pinned so the qualifier is not copy-pasted onto an
    // arm where it would be a false reassurance.
    await new LambdaLayerVersionProvider().delete(
      'MyLayer',
      'arn:aws:lambda:us-east-1:layer:1',
      'AWS::Lambda::LayerVersion'
    );
    await new CustomResourceProvider().delete('MyCr', 'cr-physical-id', 'Custom::Thing');

    const text = warnText();
    expect(text).toContain('LEFT IN PLACE');
    expect(text).not.toContain('part of this stack');
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

  it('AWS::IAM::Policy: an EMPTY physicalId still deletes when properties name the policy', async () => {
    // Same guard, the other physicalId spelling — the `''` branch that does not
    // go through `includes(':')`.
    send.mockResolvedValue({});

    await expect(
      new IAMPolicyProvider().delete('MyPolicy', '', 'AWS::IAM::Policy', {
        PolicyName: 'MyPolicy',
        Roles: ['my-role'],
      })
    ).resolves.toBeUndefined();

    expect(send).toHaveBeenCalledTimes(1);
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

/**
 * Code-axis review of #1770: two of the eight arms were skipping although an
 * addressable route was IN HAND. A false skip is expensive now — it preserves
 * the state record, prints a warning, and makes `cdkd destroy` exit 2 — and it
 * repeats on every re-run, so the destroy can never go green. Both arms now
 * exhaust their second source before reporting a skip.
 *
 * Each pair below fences BOTH halves: the fallback really deletes, and the
 * precedence between the two sources is the deployed one first.
 */
describe('a second addressable source is exhausted before skipping (issue #1770 review)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('AWS::Lambda::Permission: falls back to the function ARN in the physicalId', async () => {
    // The `<functionArn>|<statementId>` shape the provider already relies on
    // for the statementId (CC-API records, and pre-v7 records routed to the SDK
    // provider). Lambda's FunctionName parameter accepts a full ARN, so this is
    // a real delete rather than a guess.
    send.mockResolvedValue({});

    await expect(
      new LambdaPermissionProvider().delete(
        'MyPerm',
        `${LAMBDA_ARN}|AllowInvoke`,
        'AWS::Lambda::Permission',
        {}
      )
    ).resolves.toBeUndefined();

    expect(send).toHaveBeenCalledTimes(1);
    const input = send.mock.calls[0]![0].input as Record<string, unknown>;
    expect(input['FunctionName']).toBe(LAMBDA_ARN);
    expect(input['StatementId']).toBe('AllowInvoke');
  });

  it('AWS::Lambda::Permission: properties WIN over the physicalId ARN', async () => {
    send.mockResolvedValue({});

    await expect(
      new LambdaPermissionProvider().delete(
        'MyPerm',
        `${LAMBDA_ARN}|AllowInvoke`,
        'AWS::Lambda::Permission',
        { FunctionName: 'explicit-name' }
      )
    ).resolves.toBeUndefined();

    const input = send.mock.calls[0]![0].input as Record<string, unknown>;
    expect(input['FunctionName']).toBe('explicit-name');
  });

  it('AWS::Lambda::Permission: a NON-Lambda ARN is not used as a function name', async () => {
    // The fallback is gated on `:function:` so an unrelated ARN — or a
    // statementId that merely happens to contain "|" — is never sent to
    // RemovePermission as a function name. Skipping is correct here.
    const result = await new LambdaPermissionProvider().delete(
      'MyPerm',
      'arn:aws:sns:us-east-1:111122223333:my-topic|AllowInvoke',
      'AWS::Lambda::Permission',
      {}
    );

    expect(result).toEqual({
      outcome: 'skipped',
      reason: PERMISSION_FUNCTION_NAME_SKIP_REASON,
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('AWS::IAM::Policy: falls back to properties.PolicyName', async () => {
    // `create()` uses `properties['PolicyName']` verbatim as the real AWS name
    // when the template sets it, and PolicyName is in `handledProperties`, so a
    // record whose physicalId lost the name may still carry it.
    send.mockResolvedValue({});

    await expect(
      new IAMPolicyProvider().delete('MyPolicy', ':my-role', 'AWS::IAM::Policy', {
        PolicyName: 'MyPolicy',
        Roles: ['my-role'],
      })
    ).resolves.toBeUndefined();

    expect(send).toHaveBeenCalledTimes(1);
    const input = send.mock.calls[0]![0].input as Record<string, unknown>;
    expect(input['PolicyName']).toBe('MyPolicy');
    expect(input['RoleName']).toBe('my-role');
  });

  it('AWS::IAM::Policy: the physicalId WINS over properties.PolicyName', async () => {
    // The physicalId is what was actually DEPLOYED. If a template edit changed
    // PolicyName without a replacement having landed, preferring properties
    // would send a DeleteRolePolicy for a name AWS never had.
    send.mockResolvedValue({});

    await expect(
      new IAMPolicyProvider().delete('MyPolicy', 'deployed-name', 'AWS::IAM::Policy', {
        PolicyName: 'template-name',
        Roles: ['my-role'],
      })
    ).resolves.toBeUndefined();

    const input = send.mock.calls[0]![0].input as Record<string, unknown>;
    expect(input['PolicyName']).toBe('deployed-name');
  });

  it('AWS::IAM::Policy: an EMPTY-STRING PolicyName property is not a usable name', async () => {
    const result = await new IAMPolicyProvider().delete('MyPolicy', '', 'AWS::IAM::Policy', {
      PolicyName: '',
      Roles: ['my-role'],
    });

    expect(result).toEqual({ outcome: 'skipped', reason: POLICY_NAME_SKIP_REASON });
    expect(send).not.toHaveBeenCalled();
  });

  // A NON-STRING fallback is the case an emptiness test cannot see: `''` is
  // falsy and the `||` chain rejects it anyway, but a number or an unresolved
  // intrinsic is TRUTHY and would be handed to DeleteRolePolicy verbatim. The
  // `typeof` half of the guard is what refuses it, so both shapes are pinned.
  it.each([
    { name: 'a number', policyName: 42 },
    { name: 'an unresolved intrinsic', policyName: { Ref: 'SomeParam' } },
    { name: 'an array', policyName: ['MyPolicy'] },
  ])(
    'AWS::IAM::Policy: $name PolicyName property is not a usable name',
    async ({ policyName }) => {
      const result = await new IAMPolicyProvider().delete('MyPolicy', '', 'AWS::IAM::Policy', {
        PolicyName: policyName,
        Roles: ['my-role'],
      });

      expect(result).toEqual({ outcome: 'skipped', reason: POLICY_NAME_SKIP_REASON });
      expect(send).not.toHaveBeenCalled();
    }
  );
});
