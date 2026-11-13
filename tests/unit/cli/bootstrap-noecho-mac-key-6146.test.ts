/** go-to-k/cdkd#6146: `cdkd bootstrap`'s HMAC key for NoEcho value MACs. */
import { describe, it, expect, afterEach } from 'vite-plus/test';
import {
  ensureNoEchoMacKey,
  partitionOfArn,
} from '../../../src/cli/commands/bootstrap-noecho-mac-key.js';
import { setAwsEndpointOverrideSource } from '../../../src/utils/aws-client-defaults.js';

type Answer = (input: Record<string, unknown>) => unknown;

function fakeKms(answers: Record<string, Answer>) {
  const calls: Array<{ op: string; input: Record<string, unknown> }> = [];
  return {
    calls,
    kms: {
      send: async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
        const op = command.constructor.name.replace(/Command$/, '');
        calls.push({ op, input: command.input });
        const answer = answers[op];
        if (answer === undefined) throw new Error(`unexpected ${op}`);
        return answer(command.input);
      },
    } as never,
  };
}

const fail = (name: string) => () => {
  throw Object.assign(new Error(`message naming arn:aws:iam::123456789012:role/secret-role`), { name });
};

async function run(answers: Record<string, Answer>) {
  const { kms, calls } = fakeKms(answers);
  const reports: string[] = [];
  const warnings: string[] = [];
  const outcome = await ensureNoEchoMacKey({
    kms,
    region: 'us-east-1',
    accountId: '123456789012',
    partition: 'aws',
    report: (m) => reports.push(m),
    warn: (m) => warnings.push(m),
  });
  return { outcome, calls, reports, warnings };
}

afterEach(() => setAwsEndpointOverrideSource(undefined));

describe('ensureNoEchoMacKey', () => {
  it('creates an HMAC_256 key and the alias when none exists', async () => {
    const r = await run({
      DescribeKey: fail('NotFoundException'),
      CreateKey: () => ({ KeyMetadata: { KeyId: 'k-1' } }),
      CreateAlias: () => ({}),
    });
    expect(r.outcome).toBe('created');
    expect(r.calls.map((c) => c.op)).toEqual(['DescribeKey', 'CreateKey', 'CreateAlias']);
    expect(r.calls[1]!.input).toMatchObject({ KeySpec: 'HMAC_256', KeyUsage: 'GENERATE_VERIFY_MAC' });
    // Least privilege: the account's IAM policies may grant administration
    // and kms:GenerateMac on the key, never kms:VerifyMac or a grant.
    const policy = JSON.parse(String(r.calls[1]!.input['Policy'])) as {
      Statement: Array<{ Principal: { AWS: string }; Action: string | string[] }>;
    };
    const actions = policy.Statement.flatMap((s) => [s.Action].flat());
    expect(policy.Statement.map((s) => s.Principal.AWS)).toEqual([
      'arn:aws:iam::123456789012:root',
      'arn:aws:iam::123456789012:root',
    ]);
    expect(actions).toContain('kms:GenerateMac');
    expect(actions).toContain('kms:PutKeyPolicy'); // KMS's lockout check
    for (const forbidden of ['kms:VerifyMac', 'kms:CreateGrant', 'kms:*']) {
      expect(actions).not.toContain(forbidden);
    }
    expect(actions.every((a) => !a.includes('*'))).toBe(true);
    expect(r.calls[2]!.input).toEqual({ AliasName: 'alias/cdkd-noecho-mac', TargetKeyId: 'k-1' });
  });

  it('keeps an existing enabled HMAC key', async () => {
    const r = await run({
      DescribeKey: () => ({
        KeyMetadata: { KeySpec: 'HMAC_256', KeyUsage: 'GENERATE_VERIFY_MAC', KeyState: 'Enabled' },
      }),
    });
    expect(r.outcome).toBe('exists');
    expect(r.calls.map((c) => c.op)).toEqual(['DescribeKey']);
  });

  it('warns about an alias naming a key it cannot use, and creates nothing', async () => {
    const r = await run({
      DescribeKey: () => ({ KeyMetadata: { KeySpec: 'SYMMETRIC_DEFAULT', KeyState: 'Enabled' } }),
    });
    expect(r.outcome).toBe('failed');
    expect(r.warnings).toHaveLength(1);
    expect(r.calls).toHaveLength(1);
  });

  it('a missing permission warns with the error name only, and the bootstrap goes on', async () => {
    const r = await run({ DescribeKey: fail('AccessDeniedException') });
    expect(r.outcome).toBe('failed');
    expect(r.warnings[0]).toContain('AccessDeniedException');
    expect(r.warnings[0]).not.toContain('secret-role');
  });

  // The first DescribeKey finds no alias; the one after a lost race reads the winner's.
  const describeThen = (winner: Record<string, unknown>): Answer => {
    let n = 0;
    return (input) => (n++ === 0 ? fail('NotFoundException')() : { KeyMetadata: winner, input });
  };
  const HMAC = { KeySpec: 'HMAC_256', KeyUsage: 'GENERATE_VERIFY_MAC', KeyState: 'Enabled' };

  it('a concurrent bootstrap that won the alias: its key is kept, ours is scheduled for deletion', async () => {
    const r = await run({
      DescribeKey: describeThen(HMAC),
      CreateKey: () => ({ KeyMetadata: { KeyId: 'k-2' } }),
      CreateAlias: fail('AlreadyExistsException'),
      ScheduleKeyDeletion: () => ({}),
    });
    expect(r.outcome).toBe('exists');
    expect(r.calls.map((c) => c.op)).toEqual([
      'DescribeKey',
      'CreateKey',
      'CreateAlias',
      'ScheduleKeyDeletion',
      'DescribeKey',
    ]);
    expect(r.calls[3]).toEqual({ op: 'ScheduleKeyDeletion', input: { KeyId: 'k-2', PendingWindowInDays: 7 } });
    expect(r.warnings).toEqual([]);
  });

  it("a lost race whose winner's alias names no usable key warns and fails", async () => {
    const r = await run({
      DescribeKey: describeThen({ ...HMAC, KeyState: 'PendingDeletion' }),
      CreateKey: () => ({ KeyMetadata: { KeyId: 'k-3' } }),
      CreateAlias: fail('AlreadyExistsException'),
      ScheduleKeyDeletion: () => ({}),
    });
    expect(r.outcome).toBe('failed');
    expect(r.warnings).toHaveLength(1);
  });

  it('an unused key whose deletion fails is named with the command to retire it', async () => {
    const r = await run({
      DescribeKey: describeThen(HMAC),
      CreateKey: () => ({ KeyMetadata: { KeyId: 'k-4' } }),
      CreateAlias: fail('AlreadyExistsException'),
      ScheduleKeyDeletion: fail('AccessDeniedException'),
    });
    expect(r.outcome).toBe('exists');
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain('k-4');
    expect(r.warnings[0]).toContain('AccessDeniedException');
    expect(r.warnings[0]).not.toContain('secret-role');
  });

  it.each([
    ['CreateKey fails', { CreateKey: fail('AccessDeniedException') }, 'kms:CreateKey'],
    ['CreateKey answers no key id', { CreateKey: () => ({ KeyMetadata: {} }) }, 'kms:CreateKey'],
    [
      'CreateAlias fails for another reason',
      { CreateKey: () => ({ KeyMetadata: { KeyId: 'k-5' } }), CreateAlias: fail('AccessDeniedException'), ScheduleKeyDeletion: () => ({}) },
      'kms:CreateAlias',
    ],
  ])('%s: warns with the step and the error name, and the bootstrap goes on', async (_l, answers, step) => {
    const r = await run({ DescribeKey: fail('NotFoundException'), ...(answers as Record<string, Answer>) });
    expect(r.outcome).toBe('failed');
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain(step);
    expect(r.warnings[0]).not.toContain('secret-role');
  });

  it('reads the partition off the caller ARN, aws when unreadable', () => {
    expect(partitionOfArn('arn:aws-cn:iam::123456789012:user/x')).toBe('aws-cn');
    expect(partitionOfArn('arn:aws-us-gov:sts::123456789012:assumed-role/r/s')).toBe('aws-us-gov');
    expect(partitionOfArn(undefined)).toBe('aws');
    expect(partitionOfArn('not-an-arn')).toBe('aws');
  });

  it('makes no call against an AWS Emulator target', async () => {
    setAwsEndpointOverrideSource(() => ({ endpoint: 'http://localhost:4566' }) as never);
    const r = await run({});
    expect(r.outcome).toBe('skipped');
    expect(r.calls).toHaveLength(0);
  });
});
