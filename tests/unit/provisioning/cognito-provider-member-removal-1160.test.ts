import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// go-to-k/cdkd#1160: what a removed UpdateUserPool member does. A CloudFormation
// A/B (us-east-1, 2026-10-27) kept AccountRecoverySetting, SmsConfiguration,
// UserPoolTier and DeletionProtection, and turned MFA OFF when MfaConfiguration
// and EnabledMfas were removed.

const mockSend = vi.fn();

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

const { childLogger } = vi.hoisted(() => ({
  childLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  },
}));
childLogger.child.mockReturnValue(childLogger);

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    child: () => childLogger,
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { CognitoUserPoolProvider } from '../../../src/provisioning/providers/cognito-provider.js';

const POOL_ID = 'us-east-1_abc123';
const POOL_ARN = `arn:aws:cognito-idp:us-east-1:123456789012:userpool/${POOL_ID}`;

interface SentCommand {
  constructor: { name: string };
  input: Record<string, unknown>;
}

function sent(name: string): SentCommand[] {
  return mockSend.mock.calls
    .map((c) => c[0] as SentCommand)
    .filter((cmd) => cmd.constructor.name === name);
}

function warnings(): string[] {
  return childLogger.warn.mock.calls.map((c) => String(c[0]));
}

const SMS = { SnsCallerArn: 'arn:aws:iam::123456789012:role/sms', ExternalId: 'x' };
const RECOVERY = { RecoveryMechanisms: [{ Name: 'admin_only', Priority: 1 }] };

describe('CognitoUserPoolProvider.update — removed members (#1160)', () => {
  let provider: CognitoUserPoolProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    childLogger.child.mockReturnValue(childLogger);
    mockSend.mockImplementation(async (cmd: SentCommand) =>
      cmd.constructor.name === 'DescribeUserPoolCommand' ? { UserPool: { Arn: POOL_ARN } } : {}
    );
    provider = new CognitoUserPoolProvider();
  });

  const update = (desired: Record<string, unknown>, previous: Record<string, unknown>) =>
    provider.update('MyUserPool', POOL_ID, 'AWS::Cognito::UserPool', desired, previous);

  describe('kept members: warn, send nothing', () => {
    const cases: Array<[string, unknown]> = [
      ['AccountRecoverySetting', RECOVERY],
      ['SmsConfiguration', SMS],
      ['UserPoolTier', 'PLUS'],
      ['DeletionProtection', 'ACTIVE'],
    ];

    it.each(cases)('removing %s warns and sends no reset', async (member, value) => {
      await update({}, { [member]: value });

      expect(sent('UpdateUserPoolCommand')[0]!.input).not.toHaveProperty(member);
      const hits = warnings().filter((w) => w.includes(`no longer declares ${member},`));
      expect(hits).toHaveLength(1);
      expect(hits[0]).toContain(`keeps its current ${member}`);
      expect(hits[0]).toContain('CloudFormation keeps it');
    });

    it.each(cases)('keeping %s declared does not warn', async (member, value) => {
      await update({ [member]: value }, { [member]: value });

      expect(warnings().filter((w) => w.includes('no longer declares'))).toHaveLength(0);
    });

    it.each(cases)('a %s that was never declared does not warn', async (member) => {
      await update({}, {});

      expect(warnings().filter((w) => w.includes(`declares ${member}`))).toHaveLength(0);
    });

    it('does not warn when the previous value is what AWS reports for an unset member', async () => {
      await update(
        {},
        {
          AccountRecoverySetting: {},
          SmsConfiguration: {},
          UserPoolTier: 'ESSENTIALS',
          DeletionProtection: 'INACTIVE',
        }
      );

      expect(warnings().filter((w) => w.includes('no longer declares'))).toHaveLength(0);
    });

    it('does not call a desired AccountRecoverySetting {} a removal, since it is sent', async () => {
      await update({ AccountRecoverySetting: {} }, { AccountRecoverySetting: RECOVERY });

      expect(sent('UpdateUserPoolCommand')[0]!.input['AccountRecoverySetting']).toEqual({});
      expect(warnings().filter((w) => w.includes('no longer declares'))).toHaveLength(0);
    });

    it('warns when the desired side holds only the empty placeholder cdkd does not send', async () => {
      await update({ SmsConfiguration: {} }, { SmsConfiguration: SMS });

      expect(sent('UpdateUserPoolCommand')[0]!.input).not.toHaveProperty('SmsConfiguration');
      expect(warnings().filter((w) => w.includes('no longer declares SmsConfiguration,'))).toHaveLength(1);
    });
  });

  describe('MfaConfiguration removal: turn MFA OFF', () => {
    it.each([
      ['OPTIONAL with EnabledMfas', { MfaConfiguration: 'OPTIONAL', EnabledMfas: ['SOFTWARE_TOKEN_MFA'] }, 'OPTIONAL'],
      ['ON', { MfaConfiguration: 'ON', EnabledMfas: ['SOFTWARE_TOKEN_MFA'] }, 'ON'],
      ['EnabledMfas alone (resolved OPTIONAL)', { EnabledMfas: ['SOFTWARE_TOKEN_MFA'] }, 'OPTIONAL'],
    ])('previous %s -> SetUserPoolMfaConfig OFF with no factor block', async (_, previous, was) => {
      await update({}, previous);

      const mfa = sent('SetUserPoolMfaConfigCommand');
      expect(mfa).toHaveLength(1);
      expect(mfa[0]!.input).toEqual({ UserPoolId: POOL_ID, MfaConfiguration: 'OFF' });
      const order = mockSend.mock.calls.map((c) => (c[0] as SentCommand).constructor.name);
      expect(order.indexOf('SetUserPoolMfaConfigCommand')).toBeGreaterThan(
        order.indexOf('UpdateUserPoolCommand')
      );
      const hit = warnings().filter((w) => w.includes('cdkd turned MFA OFF'));
      expect(hit).toHaveLength(1);
      expect(hit[0]).toContain(`it was ${was}`);
    });

    it('turns MFA off only after the tag removal, so a failed untag leaves MFA on', async () => {
      mockSend.mockImplementation(async (cmd: SentCommand) => {
        if (cmd.constructor.name === 'DescribeUserPoolCommand') return { UserPool: { Arn: POOL_ARN } };
        if (cmd.constructor.name === 'UntagResourceCommand') {
          throw Object.assign(new Error('denied'), { name: 'AccessDeniedException' });
        }
        return {};
      });

      await expect(
        update({}, { MfaConfiguration: 'ON', EnabledMfas: ['SOFTWARE_TOKEN_MFA'], UserPoolTags: { a: 'b' } })
      ).rejects.toThrow('Failed to update Cognito User Pool MyUserPool');
      expect(sent('SetUserPoolMfaConfigCommand')).toHaveLength(0);
    });

    it('sends nothing extra when the previous side was OFF or undeclared', async () => {
      await update({}, { MfaConfiguration: 'OFF' });
      await update({}, {});
      await update({}, { MfaConfiguration: 'OFF', EnabledMfas: ['SOFTWARE_TOKEN_MFA'] });

      expect(sent('SetUserPoolMfaConfigCommand')).toHaveLength(0);
      expect(warnings().filter((w) => w.includes('turned MFA OFF'))).toHaveLength(0);
    });

    it('leaves a still-declared MfaConfiguration to the usual path', async () => {
      await update({ MfaConfiguration: 'ON' }, { MfaConfiguration: 'ON' });

      expect(sent('SetUserPoolMfaConfigCommand')).toHaveLength(0);
      expect(sent('UpdateUserPoolCommand')[0]!.input['MfaConfiguration']).toBe('ON');
    });

    it('leaves a removed MfaConfiguration beside a still-declared factor to the usual path', async () => {
      await update(
        { EnabledMfas: ['SOFTWARE_TOKEN_MFA'] },
        { MfaConfiguration: 'ON', EnabledMfas: ['SOFTWARE_TOKEN_MFA'] }
      );

      const mfa = sent('SetUserPoolMfaConfigCommand');
      expect(mfa).toHaveLength(1);
      expect(mfa[0]!.input['SoftwareTokenMfaConfiguration']).toEqual({ Enabled: true });
      expect(warnings().filter((w) => w.includes('cdkd turned MFA OFF'))).toHaveLength(0);
    });

    it('does not turn MFA off when the desired MfaConfiguration is present but blank', async () => {
      // A blank value is the shape guard's business (warned elsewhere), not a removal.
      await update({ MfaConfiguration: '  ' }, { MfaConfiguration: 'ON' });

      expect(warnings().filter((w) => w.includes('cdkd turned MFA OFF'))).toHaveLength(0);
    });
  });
});
