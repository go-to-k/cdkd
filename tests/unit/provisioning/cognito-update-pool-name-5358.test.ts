/**
 * Issue #5358: `CognitoUserPoolProvider.update()` never sent `PoolName`, so a
 * renamed `UserPoolName` deployed "successfully" while AWS kept the old name;
 * and a change to `UsernameAttributes` / `AliasAttributes` /
 * `UsernameConfiguration` — none of which `UpdateUserPool` has a member for —
 * was dropped the same way. CloudFormation renames in place and REFUSES the
 * other three ("Updates are not allowed for property"), measured on throwaway
 * stacks; these cases pin cdkd to the same outcomes.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const { mockSend, mockWarn } = vi.hoisted(() => ({ mockSend: vi.fn(), mockWarn: vi.fn() }));

vi.mock('@aws-sdk/client-cognito-identity-provider', async () => {
  const actual = await vi.importActual('@aws-sdk/client-cognito-identity-provider');
  return {
    ...actual,
    CognitoIdentityProviderClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: mockWarn,
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: vi.fn(),
      info: vi.fn(),
      warn: mockWarn,
      error: vi.fn(),
    }),
  };
});

import {
  DescribeUserPoolCommand,
  UpdateUserPoolCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import {
  CognitoUserPoolProvider,
  createTimeOnlyChanges,
} from '../../../src/provisioning/providers/cognito-provider.js';
import { buildRevertNewProperties } from '../../../src/cli/commands/drift.js';
import { ResourceUpdateNotSupportedError } from '../../../src/utils/error-handler.js';

const TYPE = 'AWS::Cognito::UserPool';
const POOL_ID = 'us-east-1_ABCdef123';

function updateInputs(): Array<Record<string, unknown>> {
  return mockSend.mock.calls
    .map(([cmd]) => cmd)
    .filter((cmd) => cmd instanceof UpdateUserPoolCommand)
    .map((cmd) => (cmd as UpdateUserPoolCommand).input as unknown as Record<string, unknown>);
}

async function refusal(
  desired: Record<string, unknown>,
  previous: Record<string, unknown>
): Promise<Error> {
  const provider = new CognitoUserPoolProvider();
  try {
    await provider.update('Pool', POOL_ID, TYPE, desired, previous);
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected update() to refuse, but it resolved');
}

beforeEach(() => {
  mockSend.mockReset();
  mockWarn.mockReset();
  mockSend.mockResolvedValue({ UserPool: { Arn: 'arn:aws:cognito-idp:us-east-1:1:userpool/x' } });
});

describe('CognitoUserPoolProvider.update — PoolName (issue #5358)', () => {
  it('sends the renamed UserPoolName as PoolName', async () => {
    const provider = new CognitoUserPoolProvider();
    await provider.update(
      'Pool',
      POOL_ID,
      TYPE,
      { UserPoolName: 'renamed-pool' },
      { UserPoolName: 'old-pool' }
    );
    const inputs = updateInputs();
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({ UserPoolId: POOL_ID, PoolName: 'renamed-pool' });
  });

  it('sends no PoolName when the template drops UserPoolName (the pool keeps its live name)', async () => {
    const provider = new CognitoUserPoolProvider();
    await provider.update('Pool', POOL_ID, TYPE, { AutoVerifiedAttributes: ['email'] }, {
      UserPoolName: 'old-pool',
    });
    const inputs = updateInputs();
    expect(inputs).toHaveLength(1);
    expect('PoolName' in inputs[0]!).toBe(false);
  });
});

describe('CognitoUserPoolProvider.update — create-time-only properties (issue #5358)', () => {
  const refusedCases: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
    ['UsernameAttributes', { UsernameAttributes: ['phone_number'] }, { UsernameAttributes: ['email'] }],
    ['UsernameAttributes', {}, { UsernameAttributes: ['email'] }],
    ['AliasAttributes', { AliasAttributes: ['email', 'preferred_username'] }, { AliasAttributes: ['email'] }],
    [
      'UsernameConfiguration',
      { UsernameConfiguration: { CaseSensitive: true } },
      { UsernameConfiguration: { CaseSensitive: false } },
    ],
    ['UsernameConfiguration', {}, { UsernameConfiguration: { CaseSensitive: false } }],
  ];

  it.each(refusedCases)(
    'refuses a change to %s before any AWS call (%j <- %j)',
    async (name, desired, previous) => {
      const error = await refusal(
        { UserPoolName: 'pool', ...desired },
        { UserPoolName: 'pool', ...previous }
      );
      expect(error).toBeInstanceOf(ResourceUpdateNotSupportedError);
      expect(error.message).toContain(`${name} cannot be changed on an existing user pool`);
      expect(error.message).toContain(`Nothing was applied to user pool ${POOL_ID}`);
      expect(error.message).toContain('--replace --force-stateful-recreation');
      expect(mockSend).not.toHaveBeenCalled();
    }
  );

  it('names every changed property in one refusal', async () => {
    const error = await refusal(
      { UsernameAttributes: ['phone_number'], UsernameConfiguration: { CaseSensitive: true } },
      { UsernameAttributes: ['email'], UsernameConfiguration: { CaseSensitive: false } }
    );
    expect(error.message).toContain('UsernameAttributes, UsernameConfiguration cannot be changed');
  });

  it('gives the protected-pool remedy when the recorded pool holds DeletionProtection ACTIVE', async () => {
    const error = await refusal(
      { UsernameAttributes: ['phone_number'], DeletionProtection: 'INACTIVE' },
      { UsernameAttributes: ['email'], DeletionProtection: 'ACTIVE' }
    );
    expect(error.message).toContain('--deletion-protection INACTIVE');
    expect(error.message).toContain(POOL_ID);
  });

  it.each([
    ['a rollback revert', { replayingState: true }],
    ['drift --revert', { desiredFromAwsReadback: true }],
  ])(
    'on %s: warns instead of refusing, updates the rest, and records the value the pool keeps',
    async (_label, context) => {
      const provider = new CognitoUserPoolProvider();
      const result = await provider.update(
        'Pool',
        POOL_ID,
        TYPE,
        {
          UserPoolName: 'pool',
          UsernameAttributes: ['email'],
          UsernameConfiguration: { CaseSensitive: true },
          AutoVerifiedAttributes: ['email'],
        },
        { UserPoolName: 'pool', UsernameAttributes: ['phone_number'] },
        context
      );
      expect(updateInputs()).toHaveLength(1);
      expect(mockWarn).toHaveBeenCalledWith(
        expect.stringContaining(
          'UsernameAttributes, UsernameConfiguration cannot be changed in place'
        )
      );
      // The previous side's value where it has one; the key dropped where it
      // has none. Everything else is the desired bag.
      expect(result.effectiveProperties).toEqual({
        UserPoolName: 'pool',
        UsernameAttributes: ['phone_number'],
        AutoVerifiedAttributes: ['email'],
      });
    }
  );

  it('records no effectiveProperties on an ordinary update with nothing to keep', async () => {
    const provider = new CognitoUserPoolProvider();
    const result = await provider.update(
      'Pool',
      POOL_ID,
      TYPE,
      { UserPoolName: 'renamed', UsernameAttributes: ['email'] },
      { UserPoolName: 'pool', UsernameAttributes: ['email'] }
    );
    expect(result.effectiveProperties).toBeUndefined();
  });

  it.each([
    ['absent vs empty list', {}, { UsernameAttributes: [], AliasAttributes: [] }],
    ['absent vs empty UsernameConfiguration', { UsernameConfiguration: {} }, {}],
    ['reordered list', { UsernameAttributes: ['phone_number', 'email'] }, { UsernameAttributes: ['email', 'phone_number'] }],
    [
      'boolean vs string CaseSensitive',
      { UsernameConfiguration: { CaseSensitive: false } },
      { UsernameConfiguration: { CaseSensitive: 'false' } },
    ],
  ])('treats %s as unchanged', (_label, desired, previous) => {
    expect(createTimeOnlyChanges(desired, previous)).toEqual([]);
  });

  // Measured 2026-10-26: DescribeUserPool on a pool created WITHOUT
  // UsernameConfiguration returns none at all (no CaseSensitive default), so
  // readCurrentState emits the `{}` placeholder. Either readback is safe on
  // `drift --revert`: the revert bag starts from the live readback and only
  // drifted top-level keys are overlaid, so an undrifted UsernameConfiguration
  // compares live against live and is never kept, warned or recorded.
  it.each([
    ['as measured (no UsernameConfiguration)', undefined],
    ['with a CaseSensitive default', { CaseSensitive: true }],
  ])(
    'drift --revert of an unrelated drift on a pool created without UsernameConfiguration, readback %s, leaves it alone',
    async (_label, usernameConfiguration) => {
      mockSend.mockImplementation(async (cmd: unknown) =>
        cmd instanceof DescribeUserPoolCommand
          ? {
              UserPool: {
                Id: POOL_ID,
                Name: 'pool',
                UsernameAttributes: ['email'],
                AutoVerifiedAttributes: [],
                ...(usernameConfiguration && { UsernameConfiguration: usernameConfiguration }),
              },
            }
          : { UserPool: { Arn: 'arn:aws:cognito-idp:us-east-1:1:userpool/x' } }
      );
      const provider = new CognitoUserPoolProvider();
      const live = (await provider.readCurrentState(POOL_ID, 'Pool', TYPE)) as Record<
        string,
        unknown
      >;
      const stateBag = {
        UserPoolName: 'pool',
        UsernameAttributes: ['email'],
        AutoVerifiedAttributes: ['email'],
      };
      const revertBag = buildRevertNewProperties(
        [{ path: 'AutoVerifiedAttributes', stateValue: ['email'], awsValue: [] }],
        stateBag,
        live
      );

      const result = await provider.update('Pool', POOL_ID, TYPE, revertBag, live, {
        desiredFromAwsReadback: true,
      });
      expect(mockWarn).not.toHaveBeenCalled();
      expect(result.effectiveProperties).toBeUndefined();
      expect(updateInputs()).toHaveLength(1);
      expect(updateInputs()[0]).toMatchObject({ AutoVerifiedAttributes: ['email'] });
    }
  );

  it('lets an unchanged create-time-only value through to UpdateUserPool', async () => {
    const provider = new CognitoUserPoolProvider();
    await provider.update(
      'Pool',
      POOL_ID,
      TYPE,
      { UserPoolName: 'pool', UsernameAttributes: ['email'], AutoVerifiedAttributes: ['email'] },
      { UserPoolName: 'pool', UsernameAttributes: ['email'] }
    );
    const inputs = updateInputs();
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({ AutoVerifiedAttributes: ['email'] });
    expect('UsernameAttributes' in inputs[0]!).toBe(false);
  });
});
