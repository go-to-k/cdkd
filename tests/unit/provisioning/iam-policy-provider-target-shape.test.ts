/**
 * `IAMPolicyProvider.create` / `update` / `readCurrentState` read `Roles` /
 * `Groups` / `Users` through the shared reader and refuse a list that is not a
 * list of IAM names BEFORE any call (go-to-k/cdkd#3878). Each used to cast and
 * iterate the value, so a string addressed one-letter principals: a GRANT on
 * the put paths (a rollback replays `update()` with a recorded bag as the
 * desired side), a detach on update, a read of another principal's policy on
 * drift. The delete arm is pinned in `provider-delete-skip-outcome.test.ts`.
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

import { IAMPolicyProvider } from '../../../src/provisioning/providers/iam-policy-provider.js';

const TYPE = 'AWS::IAM::Policy';
const DOC = { Version: '2012-10-17', Statement: [] };

const MALFORMED: Array<[string, Record<string, unknown>]> = [
  ['a string', { Roles: 'AdminRole' }],
  ['an object beside a valid list', { Roles: ['r1'], Groups: {} }],
  ['a non-string entry', { Users: ['u1', 7] }],
  ['a name outside IAM\'s character set', { Roles: ['arn:aws:iam::1:role/x'] }],
];

/** The command names sent, in order. */
const sent = (): string[] =>
  mockSend.mock.calls.map((c) => (c[0] as { constructor: { name: string } }).constructor.name);

beforeEach(() => {
  mockSend.mockReset();
  mockSend.mockResolvedValue({});
});

describe('IAMPolicyProvider.create refuses a malformed principal list', () => {
  it.each(MALFORMED)('%s: throws with no AWS call', async (_what, lists) => {
    await expect(
      new IAMPolicyProvider().create('P', TYPE, { PolicyName: 'pol', PolicyDocument: DOC, ...lists })
    ).rejects.toThrow(/is not a list of IAM names — no inline policy was attached/);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('attaches to exactly the listed principals, with a null list read as absent', async () => {
    await new IAMPolicyProvider().create('P', TYPE, {
      PolicyName: 'pol',
      PolicyDocument: DOC,
      Roles: ['r1'],
      Groups: null,
      Users: ['u1'],
    });
    expect(sent()).toEqual(['PutRolePolicyCommand', 'PutUserPolicyCommand']);
  });
});

describe('IAMPolicyProvider.update refuses a malformed principal list on EITHER side', () => {
  const valid = { PolicyName: 'pol', PolicyDocument: DOC, Roles: ['r1'] };

  it.each(MALFORMED)('%s on the RECORDED side: throws with no AWS call', async (_what, lists) => {
    await expect(
      new IAMPolicyProvider().update('P', 'pol', TYPE, valid, { ...valid, ...lists })
    ).rejects.toThrow(
      /recorded \w+ of IAM policy P is not a list of IAM names .*\. Repair the recorded \w+ in state\.json/
    );
    expect(mockSend).not.toHaveBeenCalled();
  });

  it.each(MALFORMED)('%s on the DESIRED side: throws with no AWS call', async (_what, lists) => {
    // The rollback revert arm replays update() with a RECORDED bag here, so a
    // string would otherwise drive `PutRolePolicy` to one-letter roles.
    await expect(
      new IAMPolicyProvider().update('P', 'pol', TYPE, { ...valid, ...lists }, valid)
    ).rejects.toThrow(/desired \w+ of IAM policy P is not a list of IAM names/);
    // The repair hint is for a RECORDED value only; a template fixes this one.
    await expect(
      new IAMPolicyProvider().update('P', 'pol', TYPE, { ...valid, ...lists }, valid)
    ).rejects.not.toThrow(/Repair the recorded/);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('still moves the policy between valid lists', async () => {
    await new IAMPolicyProvider().update(
      'P',
      'pol',
      TYPE,
      { ...valid, Roles: ['r2'] },
      { ...valid, Roles: ['r1'] }
    );
    const inputs = mockSend.mock.calls.map((c) => (c[0] as { input: Record<string, unknown> }).input);
    expect(inputs).toEqual([
      expect.objectContaining({ RoleName: 'r2', PolicyName: 'pol' }),
      { RoleName: 'r1', PolicyName: 'pol' },
    ]);
  });
});

describe('IAMPolicyProvider.readCurrentState reads a malformed list as drift unknown', () => {
  it.each(MALFORMED)('%s: returns undefined with no AWS call', async (_what, lists) => {
    await expect(
      new IAMPolicyProvider().readCurrentState('pol', 'P', TYPE, {
        PolicyName: 'pol',
        PolicyDocument: DOC,
        ...lists,
      })
    ).resolves.toBeUndefined();
    expect(mockSend).not.toHaveBeenCalled();
  });
});
