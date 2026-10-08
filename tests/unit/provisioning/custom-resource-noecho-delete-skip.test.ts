import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

/**
 * go-to-k/cdkd#4043 (schema v11, maintainer decision in round 8): a custom
 * resource whose recorded `ResourceProperties` hold the `***` mask where a
 * `NoEcho` parameter value stood (a coordinate its `noEchoLeaves` names) is
 * NOT sent to its handler on delete. The handler would receive `***` instead
 * of the value it was created with. Skipped, record kept, the same shape as the
 * redacted-address skip. A caller that re-resolves the value
 * (go-to-k/cdkd#4682) is covered by `custom-resource-noecho-delete-reresolve.test.ts`.
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
vi.mock('@aws-sdk/client-sns', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@aws-sdk/client-sns');
  return { ...actual, SNSClient: vi.fn().mockImplementation(stubClient) };
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
  CustomResourceProvider,
  CR_NOECHO_PROPERTIES_SKIP_REASON,
  CR_MASKED_PROPERTIES_SKIP_REASON,
  CR_BACKING_LAMBDA_GONE_SKIP_REASON,
} from '../../../src/provisioning/providers/custom-resource-provider.js';
import { SECRET_MASK } from '../../../src/deployment/secret-redaction.js';
import { deleteSkipReason } from '../../../src/deployment/delete-outcome.js';

const LAMBDA_ARN = 'arn:aws:lambda:us-east-1:111122223333:function:my-handler';
const GONE_SKIP = { outcome: 'skipped', reason: CR_BACKING_LAMBDA_GONE_SKIP_REASON };
const warnText = (): string => warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
const notFound = (): Error =>
  Object.assign(new Error('not found'), { name: 'ResourceNotFoundException' });

describe('CustomResourceProvider.delete: a NoEcho mask in the recorded properties', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('skips with its own reason, names the path, and issues NO AWS call', async () => {
    const result = await new CustomResourceProvider().delete(
      'SeedCr',
      'cr-physical-id',
      'Custom::Seed',
      { ServiceToken: LAMBDA_ARN, Config: { Password: SECRET_MASK, User: 'admin' } },
      { recordedNoEchoLeaves: [['Config', 'Password']] }
    );

    expect(result).toEqual({ outcome: 'skipped', reason: CR_NOECHO_PROPERTIES_SKIP_REASON });
    expect(deleteSkipReason(result)).toBe(CR_NOECHO_PROPERTIES_SKIP_REASON);
    expect(send).not.toHaveBeenCalled();
    const text = warnText();
    expect(text).toContain('Custom resource SeedCr is recorded in state with Config.Password');
    // Names the path, never a value (the record holds only the mask).
    expect(text).toContain("holding the '***' mask of a NoEcho value");
    expect(text).toContain('LEFT IN PLACE');
    // Deploy-side remedy: the single-record drop and the exit-0 flag.
    expect(text).toContain('--resource SeedCr');
    expect(text).toContain('--allow-unaddressed');
  });

  it('on a stack destroy says the record is kept, the run exits non-zero, and names cdkd state orphan', async () => {
    await new CustomResourceProvider().delete(
      'SeedCr',
      'cr-physical-id',
      'Custom::Seed',
      { ServiceToken: LAMBDA_ARN, Password: SECRET_MASK },
      { recordedNoEchoLeaves: [['Password']], stackDestroy: true }
    );

    const text = warnText();
    expect(text).toContain('KEEPING the state record and the run exits non-zero');
    expect(text).toContain('Tear down what the handler manages by hand');
    expect(text).toContain("'cdkd state orphan <stack> --stack-region <region>'");
    expect(send).not.toHaveBeenCalled();
  });

  it('the skip reason never reads as "already deleted"', () => {
    expect(CR_NOECHO_PROPERTIES_SKIP_REASON).not.toMatch(/not found|does not exist|NoSuchEntity/i);
  });

  it.each([
    ['no recorded coordinates (a pre-v11 record)', undefined],
    ['coordinates whose value is not the mask', [['Password']]],
    ['an empty coordinate list', []],
  ])('with %s and no mask anywhere, deletes as before (reaches the GetFunction pre-check)', async (_label, leaves) => {
    send.mockRejectedValueOnce(notFound());
    const result = await new CustomResourceProvider().delete(
      'PlainCr',
      'cr-physical-id',
      'Custom::Seed',
      { ServiceToken: LAMBDA_ARN, Password: 'plain', Other: 'also plain' },
      { stackDestroy: true, ...(leaves !== undefined && { recordedNoEchoLeaves: leaves }) }
    );
    expect(result).toEqual(GONE_SKIP);
    expect(send).toHaveBeenCalledTimes(1);
  });

  // go-to-k/cdkd#4682 (the issue's second decision): a mask no coordinate
  // names used to be SENT; it is now skipped before any AWS call.
  it('skips a mask no coordinate names (a CR-class mask) before any AWS call', async () => {
    const result = await new CustomResourceProvider().delete(
      'PlainCr',
      'cr-physical-id',
      'Custom::Seed',
      { ServiceToken: LAMBDA_ARN, Password: 'plain', Other: SECRET_MASK },
      { stackDestroy: true }
    );
    expect(result).toEqual({ outcome: 'skipped', reason: CR_MASKED_PROPERTIES_SKIP_REASON });
    expect(send).not.toHaveBeenCalled();
  });
});
