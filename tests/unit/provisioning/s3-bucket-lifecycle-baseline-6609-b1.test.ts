/**
 * go-to-k/cdkd#6609 slice B1: the `LifecycleConfiguration` drift baseline an
 * `AWS::S3::Bucket` capture records right after cdkd's own write.
 * `GetBucketLifecycleConfiguration` answered the previous configuration, or
 * none, on 40 of 143 reads right after a Put / Delete (us-east-1,
 * 2026-11-19), flapping for 4 s, so the capture re-reads until it sees the
 * declared configuration and keeps the declared one otherwise.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { GetBucketLifecycleConfigurationCommand } from '@aws-sdk/client-s3';

const mockSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    s3: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
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

import { S3BucketProvider } from '../../../src/provisioning/providers/s3-bucket-provider.js';
import {
  declaredLifecycle,
  declaredLifecycleBaseline,
  lifecycleMatchesDeclared,
} from '../../../src/provisioning/providers/s3-bucket/lifecycle-baseline.js';
import { effectiveLifecycleConfiguration } from '../../../src/provisioning/providers/s3-bucket/lifecycle-fold.js';

const BUCKET = 'my-bucket';
const TDMOS = 'all_storage_classes_128K';

/** SDK answers of GetBucketLifecycleConfiguration. */
const sdkConfig = (days: number, id: string | undefined = 'r1') => ({
  TransitionDefaultMinimumObjectSize: TDMOS,
  Rules: [{ ID: id, Status: 'Enabled', Filter: { Prefix: '' }, Expiration: { Days: days } }],
});
const OLD = sdkConfig(30);
const NEW = sdkConfig(7);
function noSuchLifecycle(): Error {
  const err = new Error('The lifecycle configuration does not exist');
  err.name = 'NoSuchLifecycleConfiguration';
  return err;
}
const NONE = noSuchLifecycle;
function throttled(): Error {
  const err = new Error('Slow Down');
  err.name = 'SlowDown';
  Object.assign(err, { $metadata: { httpStatusCode: 503 } });
  return err;
}
function accessDenied(): Error {
  const err = new Error('Access Denied');
  err.name = 'AccessDenied';
  Object.assign(err, { $metadata: { httpStatusCode: 403 } });
  return err;
}

/** What `readLifecycle` emits for `NEW`. */
const NEW_READBACK = {
  TransitionDefaultMinimumObjectSize: TDMOS,
  Rules: [{ Id: 'r1', Status: 'Enabled', ExpirationInDays: 7, Filter: { Prefix: '' } }],
};
const OLD_READBACK = {
  TransitionDefaultMinimumObjectSize: TDMOS,
  Rules: [{ Id: 'r1', Status: 'Enabled', ExpirationInDays: 30, Filter: { Prefix: '' } }],
};

/** The template: one rule, as CDK synthesizes `{ id: 'r1', expiration: Duration.days(7) }`. */
const DECLARED = {
  BucketName: BUCKET,
  LifecycleConfiguration: { Rules: [{ Id: 'r1', Status: 'Enabled', ExpirationInDays: 7 }] },
};
const DECLARED_NONE = { BucketName: BUCKET };

type Answer = object | (() => Error);
let script: Answer[];
let lifecycleCalls: number;

function scriptLifecycle(...answers: Answer[]): void {
  script = answers;
}

function makeProvider(): S3BucketProvider {
  const provider = new S3BucketProvider();
  (provider as unknown as { lifecycleBaselineRereadDelaysMs: number[] }).lifecycleBaselineRereadDelaysMs =
    [0, 0, 0, 0];
  return provider;
}

async function capture(
  provider: S3BucketProvider,
  properties: Record<string, unknown> | undefined,
  context?: { afterOwnWrite?: boolean }
): Promise<Record<string, unknown>> {
  const out = await provider.readCurrentState(
    BUCKET,
    'Bucket',
    'AWS::S3::Bucket',
    properties,
    context
  );
  return out as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  script = [];
  lifecycleCalls = 0;
  mockSend.mockImplementation((command: unknown) => {
    if (command instanceof GetBucketLifecycleConfigurationCommand) {
      lifecycleCalls++;
      // The last scripted answer repeats once the script runs out.
      const answer = script.length > 1 ? script.shift()! : script[0];
      if (typeof answer === 'function') return Promise.reject(answer());
      return Promise.resolve(answer);
    }
    return Promise.resolve({});
  });
});

describe('post-write capture of LifecycleConfiguration (#6609 B1)', () => {
  it('settles on the first read with ONE call', async () => {
    scriptLifecycle(NEW);
    const out = await capture(makeProvider(), DECLARED, { afterOwnWrite: true });
    expect(out['LifecycleConfiguration']).toEqual(NEW_READBACK);
    expect(lifecycleCalls).toBe(1);
  });

  it('re-reads a just-written configuration that still reads ABSENT', async () => {
    scriptLifecycle(NONE, NONE, NEW);
    const out = await capture(makeProvider(), DECLARED, { afterOwnWrite: true });
    expect(out['LifecycleConfiguration']).toEqual(NEW_READBACK);
    expect(lifecycleCalls).toBe(3);
  });

  it('re-reads a just-replaced configuration that still reads the OLD rules', async () => {
    scriptLifecycle(OLD, NEW);
    const out = await capture(makeProvider(), DECLARED, { afterOwnWrite: true });
    expect(out['LifecycleConfiguration']).toEqual(NEW_READBACK);
    expect(lifecycleCalls).toBe(2);
  });

  it('a FLAPPING read (old, new, old) stops on the first new answer', async () => {
    scriptLifecycle(OLD, NEW, OLD);
    const out = await capture(makeProvider(), DECLARED, { afterOwnWrite: true });
    expect(out['LifecycleConfiguration']).toEqual(NEW_READBACK);
    expect(lifecycleCalls).toBe(2);
  });

  it('keeps the DECLARED rules, in the readback shape, after the schedule still reads OLD', async () => {
    scriptLifecycle(OLD);
    const out = await capture(makeProvider(), DECLARED, { afterOwnWrite: true });
    // Exactly what the next drift read emits once AWS settles.
    expect(out['LifecycleConfiguration']).toEqual(NEW_READBACK);
    expect(lifecycleCalls).toBe(5);
  });

  it('keeps the DECLARED rules after the schedule still reads ABSENT', async () => {
    scriptLifecycle(NONE);
    const out = await capture(makeProvider(), DECLARED, { afterOwnWrite: true });
    expect(out['LifecycleConfiguration']).toEqual(NEW_READBACK);
    expect(lifecycleCalls).toBe(5);
  });

  it('records NO key when a just-deleted configuration still reads after the schedule', async () => {
    scriptLifecycle(OLD);
    const out = await capture(makeProvider(), DECLARED_NONE, { afterOwnWrite: true });
    expect(out).not.toHaveProperty('LifecycleConfiguration');
    expect(out['BucketName']).toBe(BUCKET);
    expect(lifecycleCalls).toBe(5);
  });

  it('records the empty placeholder once a just-deleted configuration reads gone', async () => {
    scriptLifecycle(OLD, NONE);
    const out = await capture(makeProvider(), DECLARED_NONE, { afterOwnWrite: true });
    expect(out['LifecycleConfiguration']).toEqual({ Rules: [] });
    expect(lifecycleCalls).toBe(2);
  });

  it('an undeclared, unconfigured lifecycle settles on ONE call', async () => {
    scriptLifecycle(NONE);
    const out = await capture(makeProvider(), DECLARED_NONE, { afterOwnWrite: true });
    expect(out['LifecycleConfiguration']).toEqual({ Rules: [] });
    expect(lifecycleCalls).toBe(1);
  });

  describe('read failures', () => {
    it('a TRANSIENT failure on the first read keeps the declared rules', async () => {
      scriptLifecycle(throttled);
      const out = await capture(makeProvider(), DECLARED, { afterOwnWrite: true });
      expect(out['LifecycleConfiguration']).toEqual(NEW_READBACK);
      expect(lifecycleCalls).toBe(1);
    });

    it('a DETERMINISTIC failure on the first read records no key', async () => {
      scriptLifecycle(accessDenied);
      const out = await capture(makeProvider(), DECLARED, { afterOwnWrite: true });
      expect(out).not.toHaveProperty('LifecycleConfiguration');
      expect(out['BucketName']).toBe(BUCKET);
    });

    it('any failure AFTER a stale answer keeps the declared rules, never the stale one', async () => {
      scriptLifecycle(OLD, accessDenied);
      const out = await capture(makeProvider(), DECLARED, { afterOwnWrite: true });
      expect(out['LifecycleConfiguration']).toEqual(NEW_READBACK);
      expect(lifecycleCalls).toBe(2);
    });

    it('a just-deleted configuration whose re-read fails records no key, never the deleted rules', async () => {
      scriptLifecycle(OLD, throttled);
      const out = await capture(makeProvider(), DECLARED_NONE, { afterOwnWrite: true });
      expect(out).not.toHaveProperty('LifecycleConfiguration');
    });

    it('an undeclared lifecycle whose FIRST read fails still fails the read, as before', async () => {
      scriptLifecycle(accessDenied);
      await expect(
        capture(makeProvider(), DECLARED_NONE, { afterOwnWrite: true })
      ).rejects.toThrow('Access Denied');
    });
  });

  describe('every other read takes the first answer, with zero extra calls', () => {
    it.each([
      ['no context (drift)', DECLARED, undefined],
      ['afterOwnWrite false', DECLARED, { afterOwnWrite: false }],
      ['no desired bag (import)', undefined, { afterOwnWrite: true }],
      ['an empty desired bag', {}, { afterOwnWrite: true }],
    ])('%s', async (_label, properties, context) => {
      scriptLifecycle(OLD, NEW);
      const out = await capture(makeProvider(), properties, context);
      expect(out['LifecycleConfiguration']).toEqual(OLD_READBACK);
      expect(lifecycleCalls).toBe(1);
    });

    it('a drift read of a just-deleted configuration still reports it', async () => {
      scriptLifecycle(OLD);
      const out = await capture(makeProvider(), DECLARED_NONE);
      expect(out['LifecycleConfiguration']).toEqual(OLD_READBACK);
      expect(lifecycleCalls).toBe(1);
    });

    it('a declaration the applier REFUSES (so AWS keeps the old rules) is not re-read', async () => {
      scriptLifecycle(OLD, NEW);
      const refused = {
        LifecycleConfiguration: {
          Rules: [{ Id: 'r1', Status: 'Enabled', Filter: 'logs/', ExpirationInDays: 7 }],
        },
      };
      const out = await capture(makeProvider(), refused, { afterOwnWrite: true });
      expect(out['LifecycleConfiguration']).toEqual(OLD_READBACK);
      expect(lifecycleCalls).toBe(1);
    });
  });

  describe('rules declared WITHOUT an Id (S3 generates one)', () => {
    const declaredNoId = {
      LifecycleConfiguration: { Rules: [{ Status: 'Enabled', ExpirationInDays: 7 }] },
    };

    it('settles on ONE call against the generated Id', async () => {
      scriptLifecycle(sdkConfig(7, 'OGJiNDg2NTAtNmVhOS00Njg3LTkxMTUtMDEyNGY1MTBiNDBk'));
      const out = await capture(makeProvider(), declaredNoId, { afterOwnWrite: true });
      expect(lifecycleCalls).toBe(1);
      expect(
        (out['LifecycleConfiguration'] as { Rules: Array<Record<string, unknown>> }).Rules[0]!['Id']
      ).toBe('OGJiNDg2NTAtNmVhOS00Njg3LTkxMTUtMDEyNGY1MTBiNDBk');
    });

    it('a stale read with an Id does not settle it, and the kept rules carry no Id', async () => {
      scriptLifecycle(sdkConfig(30, 'b2xk'));
      const out = await capture(makeProvider(), declaredNoId, { afterOwnWrite: true });
      expect(lifecycleCalls).toBe(5);
      expect(out['LifecycleConfiguration']).toEqual({
        TransitionDefaultMinimumObjectSize: TDMOS,
        Rules: [{ Status: 'Enabled', ExpirationInDays: 7, Filter: { Prefix: '' } }],
      });
    });
  });
});

describe('lifecycleMatchesDeclared', () => {
  // Each pair is a CFn declaration and the readback `readLifecycle` emitted
  // for it after `applyLifecycleConfiguration` put it on a real bucket
  // (us-east-1, 2026-11-19, settled reads), copied verbatim.
  const measured: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
    [
      'CDK V2 mix: prefix + transitions + noncurrent, two-tag filter, abort-only',
      {
        Rules: [
          {
            Id: 'archive',
            Status: 'Enabled',
            Prefix: 'logs/',
            Transitions: [
              { StorageClass: 'STANDARD_IA', TransitionInDays: 30 },
              { StorageClass: 'GLACIER', TransitionInDays: 90 },
            ],
            ExpirationInDays: 730,
            NoncurrentVersionExpiration: { NoncurrentDays: 30 },
            NoncurrentVersionTransitions: [{ StorageClass: 'GLACIER', TransitionInDays: 15 }],
          },
          {
            Id: 'tag-scoped',
            Status: 'Enabled',
            TagFilters: [
              { Key: 'team', Value: 'core' },
              { Key: 'env', Value: 'prod' },
            ],
            ExpirationInDays: 400,
          },
          {
            Id: 'abort-mpu',
            Status: 'Enabled',
            AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 },
          },
        ],
      },
      {
        TransitionDefaultMinimumObjectSize: 'all_storage_classes_128K',
        Rules: [
          {
            Id: 'archive',
            Status: 'Enabled',
            ExpirationInDays: 730,
            Transitions: [
              { TransitionInDays: 30, StorageClass: 'STANDARD_IA' },
              { TransitionInDays: 90, StorageClass: 'GLACIER' },
            ],
            NoncurrentVersionExpiration: { NoncurrentDays: 30 },
            NoncurrentVersionTransitions: [{ TransitionInDays: 15, StorageClass: 'GLACIER' }],
            Filter: { Prefix: 'logs/' },
          },
          {
            Id: 'tag-scoped',
            Status: 'Enabled',
            ExpirationInDays: 400,
            Filter: {
              TagFilters: [
                { Key: 'team', Value: 'core' },
                { Key: 'env', Value: 'prod' },
              ],
            },
          },
          {
            Id: 'abort-mpu',
            Status: 'Enabled',
            AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 },
            Filter: { Prefix: '' },
          },
        ],
      },
    ],
    [
      'rules without an Id',
      {
        Rules: [
          { Status: 'Enabled', ExpirationInDays: 30 },
          { Status: 'Enabled', AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 } },
        ],
      },
      {
        TransitionDefaultMinimumObjectSize: 'all_storage_classes_128K',
        Rules: [
          {
            Id: 'OGJiNDg2NTAtNmVhOS00Njg3LTkxMTUtMDEyNGY1MTBiNDBk',
            Status: 'Enabled',
            ExpirationInDays: 30,
            Filter: { Prefix: '' },
          },
          {
            Id: 'MTVlZThjYTctN2JkMC00MjhkLTk2ZDgtZTRkMTQxMzkwZDAz',
            Status: 'Enabled',
            AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
            Filter: { Prefix: '' },
          },
        ],
      },
    ],
    [
      'rule order and a Disabled rule',
      {
        Rules: [
          { Id: 'zeta', Status: 'Enabled', ExpirationInDays: 3 },
          { Id: 'alpha', Status: 'Enabled', ExpirationInDays: 4 },
          { Id: 'mid', Status: 'Disabled', ExpirationInDays: 5 },
        ],
      },
      {
        TransitionDefaultMinimumObjectSize: 'all_storage_classes_128K',
        Rules: [
          { Id: 'zeta', Status: 'Enabled', ExpirationInDays: 3, Filter: { Prefix: '' } },
          { Id: 'alpha', Status: 'Enabled', ExpirationInDays: 4, Filter: { Prefix: '' } },
          { Id: 'mid', Status: 'Disabled', ExpirationInDays: 5, Filter: { Prefix: '' } },
        ],
      },
    ],
    [
      'ExpiredObjectDeleteMarker, NewerNoncurrentVersions, And filter, one tag, dates, declared TDMOS',
      {
        TransitionDefaultMinimumObjectSize: 'varies_by_storage_class',
        Rules: [
          {
            Id: 'marker',
            Status: 'Enabled',
            ExpiredObjectDeleteMarker: true,
            NoncurrentVersionExpiration: { NoncurrentDays: 10, NewerNoncurrentVersions: 2 },
          },
          {
            Id: 'and',
            Status: 'Enabled',
            Prefix: 'p/',
            ObjectSizeLessThan: 500,
            ObjectSizeGreaterThan: 10,
            ExpirationInDays: 9,
          },
          {
            Id: 'onetag',
            Status: 'Enabled',
            TagFilters: [{ Key: 'k', Value: 'v' }],
            ExpirationDate: '2030-01-01T00:00:00.000Z',
          },
          {
            Id: 'gt',
            Status: 'Enabled',
            ObjectSizeGreaterThan: 1048576,
            Transitions: [{ StorageClass: 'GLACIER', TransitionDate: '2031-01-01' }],
          },
        ],
      },
      {
        TransitionDefaultMinimumObjectSize: 'varies_by_storage_class',
        Rules: [
          {
            Id: 'marker',
            Status: 'Enabled',
            ExpiredObjectDeleteMarker: true,
            NoncurrentVersionExpiration: { NoncurrentDays: 10, NewerNoncurrentVersions: 2 },
            Filter: { Prefix: '' },
          },
          {
            Id: 'and',
            Status: 'Enabled',
            ExpirationInDays: 9,
            Filter: { Prefix: 'p/', ObjectSizeGreaterThan: 10, ObjectSizeLessThan: 500 },
          },
          {
            Id: 'onetag',
            Status: 'Enabled',
            ExpirationDate: '2030-01-01T00:00:00.000Z',
            Filter: { TagFilters: [{ Key: 'k', Value: 'v' }] },
          },
          {
            Id: 'gt',
            Status: 'Enabled',
            Transitions: [{ TransitionDate: '2031-01-01T00:00:00.000Z', StorageClass: 'GLACIER' }],
            Filter: { ObjectSizeGreaterThan: 1048576 },
          },
        ],
      },
    ],
    [
      'V1 (every rule a single top-level Prefix)',
      {
        Rules: [
          {
            Id: 'legacy',
            Status: 'Enabled',
            Prefix: 'archive/',
            Transitions: [{ StorageClass: 'GLACIER', TransitionInDays: 90 }],
            NoncurrentVersionExpiration: { NoncurrentDays: 365 },
          },
          { Id: 'dm', Status: 'Enabled', Prefix: 'markers/', ExpiredObjectDeleteMarker: true },
        ],
      },
      {
        TransitionDefaultMinimumObjectSize: 'all_storage_classes_128K',
        Rules: [
          {
            Id: 'legacy',
            Status: 'Enabled',
            Prefix: 'archive/',
            Transitions: [{ TransitionInDays: 90, StorageClass: 'GLACIER' }],
            NoncurrentVersionExpiration: { NoncurrentDays: 365 },
          },
          { Id: 'dm', Status: 'Enabled', Prefix: 'markers/', ExpiredObjectDeleteMarker: true },
        ],
      },
    ],
  ];

  function expectedOf(config: Record<string, unknown>): Record<string, unknown> {
    const declared = declaredLifecycle({ LifecycleConfiguration: config });
    if (declared?.kind !== 'present') throw new Error('expected a present declaration');
    return declared.expected;
  }

  it.each(measured)('%s: the measured readback matches its declaration', (_l, config, read) => {
    expect(lifecycleMatchesDeclared(read, expectedOf(config))).toBe(true);
  });

  it.each(measured)(
    '%s: the kept declared baseline is what the readback holds (Ids aside)',
    (_l, config, read) => {
      const kept = declaredLifecycleBaseline(expectedOf(config));
      // The kept value compares equal to the settled read under the same
      // comparator, and equal outright whenever every rule declares its Id.
      expect(lifecycleMatchesDeclared(read, kept)).toBe(true);
      const rules = (config['Rules'] as Array<Record<string, unknown>>).every(
        (rule) => rule['Id'] !== undefined
      );
      if (rules) expect(kept).toEqual(read);
    }
  );

  it.each(measured)('%s: a one-value change is NOT a match', (_l, config, read) => {
    const changed = structuredClone(read) as { Rules: Array<Record<string, unknown>> };
    changed.Rules[0]!['Status'] = changed.Rules[0]!['Status'] === 'Enabled' ? 'Disabled' : 'Enabled';
    expect(lifecycleMatchesDeclared(changed, expectedOf(config))).toBe(false);
  });

  it('folding an already-folded declaration yields the same expectation', () => {
    for (const [, config] of measured) {
      const once = expectedOf(config);
      expect(effectiveLifecycleConfiguration(once)).toEqual(once);
    }
  });

  it('a different TransitionDefaultMinimumObjectSize, a missing rule or a swapped order is not a match', () => {
    const expected = expectedOf({ Rules: [{ Id: 'a', ExpirationInDays: 1 }, { Id: 'b', ExpirationInDays: 2 }] });
    const a = { Id: 'a', Status: 'Enabled', ExpirationInDays: 1, Filter: { Prefix: '' } };
    const b = { Id: 'b', Status: 'Enabled', ExpirationInDays: 2, Filter: { Prefix: '' } };
    expect(lifecycleMatchesDeclared({ Rules: [a, b] }, expected)).toBe(true);
    expect(lifecycleMatchesDeclared({ TransitionDefaultMinimumObjectSize: TDMOS, Rules: [a, b] }, expected)).toBe(true);
    expect(
      lifecycleMatchesDeclared({ TransitionDefaultMinimumObjectSize: 'varies_by_storage_class', Rules: [a, b] }, expected)
    ).toBe(false);
    expect(lifecycleMatchesDeclared({ Rules: [a] }, expected)).toBe(false);
    expect(lifecycleMatchesDeclared({ Rules: [b, a] }, expected)).toBe(false);
    expect(lifecycleMatchesDeclared({ Rules: [] }, expected)).toBe(false);
  });

  it('an Id-less declared rule needs SOME Id on the read rule', () => {
    const expected = expectedOf({ Rules: [{ ExpirationInDays: 1 }] });
    const rule = { Status: 'Enabled', ExpirationInDays: 1, Filter: { Prefix: '' } };
    expect(lifecycleMatchesDeclared({ Rules: [{ Id: 'gen', ...rule }] }, expected)).toBe(true);
    expect(lifecycleMatchesDeclared({ Rules: [rule] }, expected)).toBe(false);
  });
});
