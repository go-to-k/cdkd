import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import {
  getAccountInfo,
  resetAccountInfoCache,
  accountInfoClock,
  embedsAccountId,
} from '../../../src/deployment/intrinsic-function-resolver.js';

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  }),
}));

const stsSend = vi.hoisted(() => vi.fn());
vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({ sts: { send: stsSend }, ec2: { send: vi.fn() } }),
}));

/**
 * Issue #1746 item 1 — the account-info cache used to pin the FIRST caller's
 * region, and issue #1730 made `partition` derive from that region, so a stale
 * region started dragging a stale partition with it. Only the ACCOUNT is
 * cached now; region + partition are derived per call.
 */
describe('getAccountInfo caches the ACCOUNT only (issue #1746)', () => {
  const originalRegion = process.env['AWS_REGION'];
  const originalAccountId = process.env['AWS_ACCOUNT_ID'];
  const realNow = accountInfoClock.now;
  let now = 1_000_000;

  beforeEach(() => {
    resetAccountInfoCache();
    stsSend.mockReset();
    delete process.env['AWS_ACCOUNT_ID'];
    process.env['AWS_REGION'] = 'us-east-1';
    now = 1_000_000;
    accountInfoClock.now = () => now;
  });

  afterEach(() => {
    resetAccountInfoCache();
    accountInfoClock.now = realNow;
    if (originalRegion === undefined) delete process.env['AWS_REGION'];
    else process.env['AWS_REGION'] = originalRegion;
    if (originalAccountId === undefined) delete process.env['AWS_ACCOUNT_ID'];
    else process.env['AWS_ACCOUNT_ID'] = originalAccountId;
  });

  it('a no-override caller after a cn- override reads the AMBIENT region, not the cached one', async () => {
    stsSend.mockResolvedValue({ Account: '999988887777' });

    const first = await getAccountInfo('cn-north-1');
    expect(first).toEqual({
      accountId: '999988887777',
      region: 'cn-north-1',
      partition: 'aws-cn',
    });

    // The defect: this second call passed NO override, so it used to inherit
    // `cn-north-1` / `aws-cn` from the cache written by the first caller.
    const second = await getAccountInfo();
    expect(second.region).toBe('us-east-1');
    expect(second.partition).toBe('aws');
    expect(second.accountId).toBe('999988887777');
  });

  it('the inverse order is symmetric — a cn- override after a commercial first caller still gets aws-cn', async () => {
    stsSend.mockResolvedValue({ Account: '999988887777' });

    await getAccountInfo();
    const overridden = await getAccountInfo('cn-north-1');
    expect(overridden.region).toBe('cn-north-1');
    expect(overridden.partition).toBe('aws-cn');
  });

  it('still issues exactly ONE GetCallerIdentity across those callers', async () => {
    stsSend.mockResolvedValue({ Account: '999988887777' });

    await getAccountInfo('cn-north-1');
    await getAccountInfo();
    await getAccountInfo('us-gov-west-1');

    expect(stsSend).toHaveBeenCalledTimes(1);
  });

  it('every partition is derived per call from ONE cached account', async () => {
    stsSend.mockResolvedValue({ Account: '999988887777' });

    const seen = await Promise.all(
      ['cn-north-1', 'us-gov-west-1', 'us-iso-east-1', 'us-isob-east-1', 'eu-west-1'].map((r) =>
        getAccountInfo(r)
      )
    );
    expect(seen.map((i) => i.partition)).toEqual([
      'aws-cn',
      'aws-us-gov',
      'aws-iso',
      'aws-iso-b',
      'aws',
    ]);
    expect(new Set(seen.map((i) => i.accountId))).toEqual(new Set(['999988887777']));
  });

  it('the FABRICATED TTL window derives its region per call too', async () => {
    stsSend.mockRejectedValue(new Error('STS unreachable'));

    const first = await getAccountInfo('cn-north-1');
    expect(first.fabricated).toBe(true);
    expect(first.partition).toBe('aws-cn');

    // Inside the TTL, so the same fabricated identity is reused — but the
    // region must still come from THIS caller.
    const second = await getAccountInfo();
    expect(second.fabricated).toBe(true);
    expect(second.region).toBe('us-east-1');
    expect(second.partition).toBe('aws');
    expect(stsSend).toHaveBeenCalledTimes(1);
  });

  it('concurrent callers sharing ONE in-flight lookup each get their own region', async () => {
    let release: (value: { Account: string }) => void = () => {};
    stsSend.mockReturnValue(
      new Promise<{ Account: string }>((resolve) => {
        release = resolve;
      })
    );

    const both = Promise.all([getAccountInfo('cn-north-1'), getAccountInfo('us-east-1')]);
    release({ Account: '999988887777' });
    const [cn, commercial] = await both;

    expect(stsSend).toHaveBeenCalledTimes(1);
    expect(cn.partition).toBe('aws-cn');
    expect(commercial.partition).toBe('aws');
  });

  it('an operator-supplied AWS_ACCOUNT_ID fallback is cached without its region', async () => {
    stsSend.mockRejectedValue(new Error('STS unreachable'));
    process.env['AWS_ACCOUNT_ID'] = '111122223333';

    const first = await getAccountInfo('cn-north-1');
    expect(first).toEqual({
      accountId: '111122223333',
      region: 'cn-north-1',
      partition: 'aws-cn',
    });

    const second = await getAccountInfo();
    expect(second.region).toBe('us-east-1');
    expect(second.partition).toBe('aws');
    expect(second.fabricated).toBeUndefined();
  });
});

/**
 * Issue #1746 item 2 — the fabricated-account guard inspected STRING values
 * only. Every account-bearing `constructAttribute` branch returns a string
 * today, so no live defect; the array arm exists so a future list-valued
 * attribute cannot bypass the guard silently.
 */
describe('embedsAccountId (issue #1746)', () => {
  it('detects the placeholder account inside a string', () => {
    expect(embedsAccountId('arn:aws:iam::123456789012:role/x', '123456789012')).toBe(true);
  });

  it('detects it inside an array of strings — the arm no live branch reaches yet', () => {
    expect(
      embedsAccountId(['arn:aws:s3:::ok', 'arn:aws:iam::123456789012:role/x'], '123456789012')
    ).toBe(true);
  });

  it('does not fire on an array carrying no account', () => {
    expect(embedsAccountId(['2001:db8::/64', '2001:db8:1::/64'], '123456789012')).toBe(false);
  });

  it('ignores non-string, non-array values rather than stringifying them', () => {
    expect(embedsAccountId(undefined, '123456789012')).toBe(false);
    expect(embedsAccountId(123456789012, '123456789012')).toBe(false);
    expect(embedsAccountId({ Arn: 'arn:aws:iam::123456789012:role/x' }, '123456789012')).toBe(
      false
    );
  });
});
