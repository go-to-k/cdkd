/**
 * go-to-k/cdkd#6616: an `AWS::IAM::Policy` attached to several principals holds
 * one copy of its document per principal, and `readCurrentState` read only the
 * FIRST. An out-of-band edit of any other copy (a widened `Action`) read clean,
 * so `cdkd drift` missed it and `--revert` left it. Every recorded target is
 * read now, except on the deploy's own post-write capture (`afterOwnWrite`).
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  GetRolePolicyCommand,
  GetGroupPolicyCommand,
  GetUserPolicyCommand,
  NoSuchEntityException,
} from '@aws-sdk/client-iam';

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
import { DriftReadRefusedError, RESOURCE_NOT_FOUND } from '../../../src/types/resource.js';
import { buildReadCurrentStateContext } from '../../../src/deployment/read-current-state-context.js';

describe('buildReadCurrentStateContext carries the read resource\'s own drift baseline (#6616)', () => {
  const entry = (extra: Record<string, unknown>) => ({
    resourceType: TYPE,
    physicalId: 'pol',
    properties: { PolicyDocument: {} },
    ...extra,
  });

  it('sets driftBaseline from its observedProperties, the own record, never a sibling\'s', () => {
    const ctx = buildReadCurrentStateContext(
      {
        resources: {
          P: entry({ observedProperties: { PolicyDocument: { a: 1 } } }),
          Other: entry({ observedProperties: { PolicyDocument: { b: 2 } } }),
        },
      } as never,
      'P'
    );
    expect(ctx.driftBaseline).toEqual({ PolicyDocument: { a: 1 } });
  });

  it('omits it when the own record has none, or a value that is not an object', () => {
    for (const observedProperties of [undefined, null, 'x', ['y']]) {
      const ctx = buildReadCurrentStateContext(
        { resources: { P: entry({ observedProperties }) } } as never,
        'P'
      );
      expect('driftBaseline' in ctx).toBe(false);
    }
  });
});

const TYPE = 'AWS::IAM::Policy';
const RECORDED = {
  Version: '2012-10-17',
  Statement: [{ Effect: 'Allow', Action: 's3:GetObject', Resource: '*' }],
};
const WIDENED = {
  Version: '2012-10-17',
  Statement: [{ Effect: 'Allow', Action: '*', Resource: '*' }],
};

const notFound = (): NoSuchEntityException =>
  new NoSuchEntityException({ message: 'The policy was not found.', $metadata: {} });

/** Live copies keyed `role:R1` / `group:G1` / `user:U1`; a missing key is NoSuchEntity. */
function liveCopies(copies: Record<string, unknown>): void {
  mockSend.mockImplementation((command: unknown) => {
    let key: string;
    if (command instanceof GetRolePolicyCommand) key = `role:${command.input.RoleName}`;
    else if (command instanceof GetGroupPolicyCommand) key = `group:${command.input.GroupName}`;
    else if (command instanceof GetUserPolicyCommand) key = `user:${command.input.UserName}`;
    else throw new Error('unexpected command');
    if (!(key in copies)) return Promise.reject(notFound());
    return Promise.resolve({ PolicyDocument: encodeURIComponent(JSON.stringify(copies[key])) });
  });
}

const calledKeys = (): string[] =>
  mockSend.mock.calls.map(([c]: unknown[]) =>
    c instanceof GetRolePolicyCommand
      ? `role:${c.input.RoleName}`
      : c instanceof GetGroupPolicyCommand
        ? `group:${c.input.GroupName}`
        : `user:${(c as GetUserPolicyCommand).input.UserName}`
  );

describe('IAMPolicyProvider.readCurrentState reads every recorded target (#6616)', () => {
  let provider: IAMPolicyProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new IAMPolicyProvider();
  });

  it('a single-target policy makes the one call it always did', async () => {
    liveCopies({ 'role:R1': RECORDED });
    const result = await provider.readCurrentState('pol', 'P', TYPE, {
      PolicyName: 'pol',
      PolicyDocument: RECORDED,
      Roles: ['R1'],
    });
    expect(calledKeys()).toEqual(['role:R1']);
    expect(result).toEqual({ PolicyName: 'pol', PolicyDocument: RECORDED, Roles: ['R1'] });
  });

  it('two roles, clean: both read, the recorded document and both roles reported', async () => {
    liveCopies({ 'role:R1': RECORDED, 'role:R2': RECORDED });
    const result = await provider.readCurrentState('pol', 'P', TYPE, {
      PolicyDocument: RECORDED,
      Roles: ['R1', 'R2'],
    });
    expect(calledKeys()).toEqual(['role:R1', 'role:R2']);
    expect(result).toEqual({ PolicyName: 'pol', PolicyDocument: RECORDED, Roles: ['R1', 'R2'] });
  });

  it('two roles, the SECOND edited out of band: the edited document is reported', async () => {
    liveCopies({ 'role:R1': RECORDED, 'role:R2': WIDENED });
    const result = await provider.readCurrentState('pol', 'P', TYPE, {
      PolicyDocument: RECORDED,
      Roles: ['R1', 'R2'],
    });
    expect(result).toMatchObject({ PolicyDocument: WIDENED, Roles: ['R1', 'R2'] });
  });

  it('two roles, the FIRST edited out of band: the edited document is reported', async () => {
    liveCopies({ 'role:R1': WIDENED, 'role:R2': RECORDED });
    const result = await provider.readCurrentState('pol', 'P', TYPE, {
      PolicyDocument: RECORDED,
      Roles: ['R1', 'R2'],
    });
    expect(result).toMatchObject({ PolicyDocument: WIDENED });
  });

  it('a recorded document held as a JSON string still picks the edited copy', async () => {
    liveCopies({ 'role:R1': RECORDED, 'role:R2': WIDENED });
    const result = await provider.readCurrentState('pol', 'P', TYPE, {
      PolicyDocument: JSON.stringify(RECORDED),
      Roles: ['R1', 'R2'],
    });
    expect(result).toMatchObject({ PolicyDocument: WIDENED });
  });

  it('three targets across a role, a group and a user, the user edited: reported', async () => {
    liveCopies({ 'role:R1': RECORDED, 'group:G1': RECORDED, 'user:U1': WIDENED });
    const result = await provider.readCurrentState('pol', 'P', TYPE, {
      PolicyDocument: RECORDED,
      Roles: ['R1'],
      Groups: ['G1'],
      Users: ['U1'],
    });
    expect(calledKeys()).toEqual(['role:R1', 'group:G1', 'user:U1']);
    expect(result).toEqual({
      PolicyName: 'pol',
      PolicyDocument: WIDENED,
      Roles: ['R1'],
      Groups: ['G1'],
      Users: ['U1'],
    });
  });

  it('three roles, the third edited: reported', async () => {
    liveCopies({ 'role:R1': RECORDED, 'role:R2': RECORDED, 'role:R3': WIDENED });
    const result = await provider.readCurrentState('pol', 'P', TYPE, {
      PolicyDocument: RECORDED,
      Roles: ['R1', 'R2', 'R3'],
    });
    expect(calledKeys()).toEqual(['role:R1', 'role:R2', 'role:R3']);
    expect(result).toMatchObject({ PolicyDocument: WIDENED });
  });

  it('three targets, clean: the recorded document and every target are reported', async () => {
    liveCopies({ 'group:G1': RECORDED, 'group:G2': RECORDED, 'user:U1': RECORDED });
    const result = await provider.readCurrentState('pol', 'P', TYPE, {
      PolicyDocument: RECORDED,
      Groups: ['G1', 'G2'],
      Users: ['U1'],
    });
    expect(result).toEqual({
      PolicyName: 'pol',
      PolicyDocument: RECORDED,
      Groups: ['G1', 'G2'],
      Users: ['U1'],
    });
  });

  it('a non-first target that lacks the policy drops out of its list (drift on Roles)', async () => {
    liveCopies({ 'role:R1': RECORDED });
    const result = await provider.readCurrentState('pol', 'P', TYPE, {
      PolicyDocument: RECORDED,
      Roles: ['R1', 'R2'],
    });
    expect(result).toEqual({ PolicyName: 'pol', PolicyDocument: RECORDED, Roles: ['R1'] });
  });

  it('a FIRST target that lacks the policy no longer reads the whole policy as gone', async () => {
    liveCopies({ 'user:U1': RECORDED });
    const result = await provider.readCurrentState('pol', 'P', TYPE, {
      PolicyDocument: RECORDED,
      Roles: ['R1'],
      Users: ['U1'],
    });
    expect(result).toEqual({
      PolicyName: 'pol',
      PolicyDocument: RECORDED,
      Roles: [],
      Users: ['U1'],
    });
  });

  it('every target lacking the policy is RESOURCE_NOT_FOUND', async () => {
    liveCopies({});
    const result = await provider.readCurrentState('pol', 'P', TYPE, {
      PolicyDocument: RECORDED,
      Roles: ['R1', 'R2'],
      Groups: ['G1'],
    });
    expect(result).toBe(RESOURCE_NOT_FOUND);
    expect(mockSend).toHaveBeenCalledTimes(3);
  });

  it('an error other than NoSuchEntity on any target propagates', async () => {
    mockSend.mockImplementation((command: unknown) =>
      command instanceof GetRolePolicyCommand && command.input.RoleName === 'R2'
        ? Promise.reject(new Error('AccessDenied'))
        : Promise.resolve({ PolicyDocument: encodeURIComponent(JSON.stringify(RECORDED)) })
    );
    await expect(
      provider.readCurrentState('pol', 'P', TYPE, {
        PolicyDocument: RECORDED,
        Roles: ['R1', 'R2'],
      })
    ).rejects.toThrow('AccessDenied');
  });

  it("the deploy's own post-write capture reads the first target only", async () => {
    liveCopies({ 'role:R1': RECORDED, 'role:R2': WIDENED });
    const result = await provider.readCurrentState(
      'pol',
      'P',
      TYPE,
      { PolicyDocument: RECORDED, Roles: ['R1', 'R2'] },
      { afterOwnWrite: true }
    );
    expect(calledKeys()).toEqual(['role:R1']);
    expect(result).toEqual({ PolicyName: 'pol', PolicyDocument: RECORDED, Roles: ['R1', 'R2'] });
  });

  it('compares the copies against the drift baseline, not the template, when one is recorded', async () => {
    // A `drift --accept` / `state refresh-observed` moved the baseline to
    // ACCEPTED while `properties` still holds RECORDED; then the second copy
    // was widened. The first copy equals the baseline, so reporting "the
    // first copy that differs from the template" would read clean.
    const ACCEPTED = {
      Version: '2012-10-17',
      Statement: [{ Effect: 'Allow', Action: 's3:ListBucket', Resource: '*' }],
    };
    liveCopies({ 'role:R1': ACCEPTED, 'role:R2': WIDENED });
    const result = await provider.readCurrentState(
      'pol',
      'P',
      TYPE,
      { PolicyDocument: RECORDED, Roles: ['R1', 'R2'] },
      { driftBaseline: { PolicyDocument: ACCEPTED, Roles: ['R1', 'R2'] } }
    );
    expect(result).toMatchObject({ PolicyDocument: WIDENED });
  });

  it.each([
    ['a dynamic reference', '{{resolve:ssm:/bucket-arn}}'],
    ['the *** mask', '***'],
  ])(
    'copies differing under a baseline holding %s fail the read (not fully compared), never clean',
    async (_label, leaf) => {
      const withSecret = {
        Version: '2012-10-17',
        Statement: [{ Effect: 'Allow', Action: 's3:GetObject', Resource: leaf }],
      };
      liveCopies({ 'role:R1': RECORDED, 'role:R2': WIDENED });
      const read = provider.readCurrentState('pol', 'P', TYPE, {
        PolicyDocument: withSecret,
        Roles: ['R1', 'R2'],
      });
      await expect(read).rejects.toThrow(/differ across its principals/);
      // A cdkd refusal, not an AWS failure: drift keeps it off the breaker.
      await expect(read).rejects.toBeInstanceOf(DriftReadRefusedError);
      // The message names the policy only, never a document's content.
      await expect(read).rejects.not.toThrow(/s3:GetObject|resolve:|\*\*\*/);
    }
  );

  it('a secret-leaf baseline with every copy agreeing reads as before, no refusal', async () => {
    liveCopies({ 'role:R1': RECORDED, 'role:R2': RECORDED });
    const result = await provider.readCurrentState('pol', 'P', TYPE, {
      PolicyDocument: { ...RECORDED, Id: '{{resolve:ssm:/id}}' },
      Roles: ['R1', 'R2'],
    });
    expect(result).toMatchObject({ PolicyDocument: RECORDED });
  });

  // go-to-k/cdkd#6616 review B1: every "equal" is the drift comparator's,
  // which sorts ARN / id arrays. A copy that only REORDERS an ARN list is
  // equal to the comparator; picking it as "the edited copy" would read clean
  // and hide the widened copy beside it.
  const ARN_A = 'arn:aws:s3:::bucket-a/*';
  const ARN_B = 'arn:aws:s3:::bucket-b/*';
  const twoArns = (action: string, resources: string[]) => ({
    Version: '2012-10-17',
    Statement: [{ Effect: 'Allow', Action: action, Resource: resources }],
  });

  it('a copy that only reorders an ARN list is not the edited copy: the widened one is reported', async () => {
    const recorded = twoArns('s3:GetObject', [ARN_A, ARN_B]);
    const reordered = twoArns('s3:GetObject', [ARN_B, ARN_A]);
    const widened = twoArns('*', [ARN_A, ARN_B]);
    for (const context of [undefined, { driftBaseline: { PolicyDocument: recorded } }]) {
      liveCopies({ 'role:R1': reordered, 'role:R2': widened });
      const result = await provider.readCurrentState(
        'pol',
        'P',
        TYPE,
        { PolicyDocument: recorded, Roles: ['R1', 'R2'] },
        context
      );
      expect(result).toMatchObject({ PolicyDocument: widened });
    }
  });

  it('copies differing only by ARN-list order are not differing copies', async () => {
    const recorded = twoArns('s3:GetObject', [ARN_A, ARN_B]);
    liveCopies({
      'role:R1': twoArns('s3:GetObject', [ARN_B, ARN_A]),
      'role:R2': recorded,
    });
    const result = await provider.readCurrentState('pol', 'P', TYPE, {
      // A secret leaf would refuse a genuine divergence; it must not here.
      PolicyDocument: { ...recorded, Id: '{{resolve:ssm:/id}}' },
      Roles: ['R1', 'R2'],
    });
    expect(result).toMatchObject({ Roles: ['R1', 'R2'] });
  });

  it('a missing target beside copies that are all empty still reports the list drift', async () => {
    mockSend.mockImplementation((command: unknown) =>
      command instanceof GetRolePolicyCommand && command.input.RoleName === 'R2'
        ? Promise.reject(notFound())
        : Promise.resolve({ PolicyDocument: undefined })
    );
    const result = await provider.readCurrentState('pol', 'P', TYPE, {
      PolicyDocument: RECORDED,
      Roles: ['R1', 'R2'],
    });
    expect(result).toEqual({ PolicyName: 'pol', PolicyDocument: undefined, Roles: ['R1'] });
  });

  it('every copy edited, each differently: an edited copy is reported', async () => {
    const OTHER = {
      Version: '2012-10-17',
      Statement: [{ Effect: 'Allow', Action: 'iam:*', Resource: '*' }],
    };
    liveCopies({ 'role:R1': OTHER, 'role:R2': WIDENED });
    const result = await provider.readCurrentState('pol', 'P', TYPE, {
      PolicyDocument: RECORDED,
      Roles: ['R1', 'R2'],
    });
    expect(result).toMatchObject({ PolicyDocument: OTHER });
  });

  it('an empty copy among readable ones is a differing copy, not drift unknown', async () => {
    mockSend.mockImplementation((command: unknown) =>
      Promise.resolve({
        PolicyDocument:
          command instanceof GetRolePolicyCommand && command.input.RoleName === 'R2'
            ? undefined
            : encodeURIComponent(JSON.stringify(RECORDED)),
      })
    );
    const result = await provider.readCurrentState('pol', 'P', TYPE, {
      PolicyDocument: RECORDED,
      Roles: ['R1', 'R2'],
    });
    expect(result).toEqual({ PolicyName: 'pol', PolicyDocument: undefined, Roles: ['R1', 'R2'] });
  });

  it('reads many targets at most five at a time, and still reports the last one edited', async () => {
    const roles = Array.from({ length: 12 }, (_, i) => `R${i + 1}`);
    let inFlight = 0;
    let peak = 0;
    mockSend.mockImplementation(async (command: unknown) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      const name = (command as GetRolePolicyCommand).input.RoleName;
      return { PolicyDocument: encodeURIComponent(JSON.stringify(name === 'R12' ? WIDENED : RECORDED)) };
    });
    const result = await provider.readCurrentState('pol', 'P', TYPE, {
      PolicyDocument: RECORDED,
      Roles: roles,
    });
    expect(mockSend).toHaveBeenCalledTimes(12);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(5);
    expect(result).toMatchObject({ PolicyDocument: WIDENED, Roles: roles });
  });

  it('a drift read with a sibling context (no afterOwnWrite) still reads every target', async () => {
    liveCopies({ 'role:R1': RECORDED, 'role:R2': WIDENED });
    const result = await provider.readCurrentState(
      'pol',
      'P',
      TYPE,
      { PolicyDocument: RECORDED, Roles: ['R1', 'R2'] },
      { siblings: {} }
    );
    expect(calledKeys()).toEqual(['role:R1', 'role:R2']);
    expect(result).toMatchObject({ PolicyDocument: WIDENED });
  });
});

describe('IAMPolicyProvider.readCurrentState over an object-form Statement (go-to-k/cdkd#6622)', () => {
  const DENY_DOC = {
    Version: '2012-10-17',
    Statement: { Effect: 'Deny', Action: 's3:DeleteBucket', Resource: '*' },
  };
  const NARROWED = {
    ...DENY_DOC,
    Statement: { ...DENY_DOC.Statement, Condition: { Bool: { 'aws:SecureTransport': 'false' } } },
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('a Condition on the SECOND copy is the reported document on the template-only baseline', async () => {
    liveCopies({ 'role:R1': DENY_DOC, 'role:R2': NARROWED });
    const result = await new IAMPolicyProvider().readCurrentState('pol', 'P', TYPE, {
      PolicyDocument: DENY_DOC,
      Roles: ['R1', 'R2'],
    });
    expect(result).toMatchObject({ PolicyDocument: NARROWED });
  });

  it('every copy unchanged reports the recorded document', async () => {
    liveCopies({ 'role:R1': DENY_DOC, 'role:R2': DENY_DOC });
    const result = await new IAMPolicyProvider().readCurrentState('pol', 'P', TYPE, {
      PolicyDocument: DENY_DOC,
      Roles: ['R1', 'R2'],
    });
    expect(result).toMatchObject({ PolicyDocument: DENY_DOC });
  });
});
