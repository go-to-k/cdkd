import { describe, it, expect, vi } from 'vite-plus/test';
import { withRetry } from '../../../src/deployment/retry.js';
import {
  createdBeforeFailure,
  isAuxiliaryFailure,
  markAuxiliaryFailure,
  markCreatedBeforeFailure,
  markSupersedesEarlierCreate,
} from '../../../src/provisioning/auxiliary-failure.js';
import { hasReplayMayCollide } from '../../../src/deployment/retryable-errors.js';

/**
 * go-to-k/cdkd#4945: a retried create whose replay made ANOTHER resource
 * (its mark names a different physical id than the earlier attempt's) is not
 * retried again. Every further replay of a create that takes no name would
 * mint one more resource, and the journal records one id per failed CREATE.
 * A replay that resumes the earlier resource marks the same id and is retried
 * as before.
 */

const ID = 'MyKey';
const TYPE = 'AWS::IAM::AccessKey';
// Matches the IAM-propagation pattern, so the default classifier retries it.
const RETRYABLE =
  'User: arn:aws:iam::123456789012:user/deployer is not authorized to perform: iam:UpdateAccessKey';
const noSleep = (): Promise<void> => Promise.resolve();

function marked(physicalId: string, logicalId = ID, type = TYPE): Error {
  return markCreatedBeforeFailure(new Error(RETRYABLE), logicalId, type, physicalId);
}

async function run(
  errors: readonly Error[],
  opts: Parameters<typeof withRetry>[2] = {}
): Promise<{ attempts: number; error: unknown; warns: string[] }> {
  let attempts = 0;
  const warns: string[] = [];
  const error = await withRetry(
    () => {
      const next = errors[attempts];
      attempts++;
      return next ? Promise.reject(next) : Promise.resolve('ok');
    },
    ID,
    { sleep: noSleep, logger: { debug: vi.fn(), warn: (m) => warns.push(m) }, ...opts }
  ).then(
    () => undefined,
    (e: unknown) => e
  );
  return { attempts, error, warns };
}

describe('withRetry stops a replay that made another resource (go-to-k/cdkd#4945)', () => {
  it('stops after the replay that marked a second resource, keeping its mark', async () => {
    const second = marked('key-2');
    const { attempts, error, warns } = await run([marked('key-1'), second, marked('key-3')]);

    expect(attempts).toBe(2);
    expect(error).toBe(second);
    expect(createdBeforeFailure(error, ID, TYPE)).toBe('key-2');
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('made another resource');
    // No physical id on the line: retry.ts has no mask for it.
    expect(warns[0]).not.toMatch(/key-[12]/);
  });

  it('stops under a caller-supplied classifier too', async () => {
    const { attempts } = await run([marked('key-1'), marked('key-2'), marked('key-3')], {
      isRetryable: () => true,
      maxRetries: 5,
    });
    expect(attempts).toBe(2);
  });

  it('keeps retrying a replay that resumed the same resource', async () => {
    const { attempts, error, warns } = await run([marked('key-1'), marked('key-1')]);
    expect(attempts).toBe(3);
    expect(error).toBeUndefined();
    expect(warns).toEqual([]);
  });

  it('keeps retrying when the replay made nothing', async () => {
    const { attempts, error } = await run([marked('key-1'), new Error(RETRYABLE)]);
    expect(attempts).toBe(3);
    expect(error).toBeUndefined();
  });

  it('keeps retrying when the second mark is for another resource or type', async () => {
    for (const second of [marked('key-2', 'Other'), marked('key-2', ID, 'AWS::KMS::Key')]) {
      const { attempts } = await run([marked('key-1'), second]);
      expect(attempts).toBe(3);
    }
  });

  it("compares against the earlier mark carried past an attempt that made nothing", async () => {
    const { attempts } = await run([marked('key-1'), new Error(RETRYABLE), marked('key-2')]);
    expect(attempts).toBe(3);
  });

  it('keeps retrying a multi-target policy whose written set grows or shrinks across attempts', async () => {
    const POLICY = 'AWS::SNS::TopicPolicy';
    const policy = (id: string): Error => marked(id, 'Policy', POLICY);
    const grows = await run([policy('arn:t1'), policy('arn:t1,arn:t2')]);
    expect(grows.attempts).toBe(3);
    expect(grows.error).toBeUndefined();
    const shrinks = await run([policy('arn:t1,arn:t2'), policy('arn:t1'), policy('arn:t1,arn:t2')]);
    expect(shrinks.attempts).toBe(4);
    expect(shrinks.error).toBeUndefined();
  });

  it('still stops a multi-id mark that shares no member with the earlier one', async () => {
    const { attempts } = await run([marked('a,b'), marked('c,d')]);
    expect(attempts).toBe(2);
  });

  it('does not read an empty member as shared', async () => {
    const { attempts } = await run([marked('a,'), marked('b,')]);
    expect(attempts).toBe(2);
  });

  it('keeps retrying a create that declared it replaced the earlier leftover (KMS)', async () => {
    const { attempts, error } = await run([
      marked('key-1'),
      markSupersedesEarlierCreate(marked('key-2')),
      marked('key-2'),
    ]);
    expect(attempts).toBe(4);
    expect(error).toBeUndefined();
  });

  it('keeps the auxiliary mark and the replay-may-collide stamp on the error it stops on', async () => {
    const first = markAuxiliaryFailure(marked('key-1'), ID);
    const { attempts, error } = await run([first, marked('key-2')]);
    expect(attempts).toBe(2);
    expect(isAuxiliaryFailure(error)).toBe(true);
    expect(hasReplayMayCollide(error)).toBe(true);
  });
});
