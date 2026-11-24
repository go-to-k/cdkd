/**
 * go-to-k/cdkd#6609 slice B1: the `LifecycleConfiguration` drift baseline an
 * `AWS::S3::Bucket` capture records right after cdkd's own write.
 * `GetBucketLifecycleConfiguration` answered the previous configuration, or
 * none, on 40 of 143 reads right after a Put / Delete (us-east-1,
 * 2026-11-19), flapping for 4 s, so the capture re-reads until it sees the
 * declared configuration and keeps the declared one otherwise.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  GetBucketLifecycleConfigurationCommand,
  GetBucketLocationCommand,
  NoSuchBucket,
  PutBucketCorsCommand,
  PutBucketLoggingCommand,
  PutBucketLifecycleConfigurationCommand,
} from '@aws-sdk/client-s3';

const mockSend = vi.fn();

// `CreateBucket` goes through the provider's own client; forward it to the double.
vi.mock('@aws-sdk/client-s3', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@aws-sdk/client-s3')>()),
  ...(await import('./s3-create-client-forward.js')).forwardedS3Client(),
}));

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

import { S3BucketProvider } from '../../../src/provisioning/providers/s3-bucket-provider.js';
import {
  declaredLifecycle,
  declaredLifecycleBaseline,
  lifecycleMatchesDeclared,
  type LifecycleWrite,
  recordLifecycleWrite,
} from '../../../src/provisioning/providers/s3-bucket/lifecycle-baseline.js';
import { effectiveLifecycleConfiguration } from '../../../src/provisioning/providers/s3-bucket/lifecycle-fold.js';
import { preFixBaselineUncomparedDriftKeys } from '../../../src/cli/commands/drift/baseline-keys.js';
import { calculateResourceDrift } from '../../../src/analyzer/drift-calculator.js';
import { getLogger } from '../../../src/utils/logger.js';

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
function socketReset(): Error {
  const err = new Error('socket hang up');
  Object.assign(err, { code: 'ECONNRESET' });
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
  context?: { afterOwnWrite?: boolean; write?: LifecycleWrite }
): Promise<Record<string, unknown>> {
  // What the create / update before this capture sent, as the appliers note it.
  if (context?.write !== undefined) recordLifecycleWrite(provider, BUCKET, context.write);
  const out = await provider.readCurrentState(
    BUCKET,
    'Bucket',
    'AWS::S3::Bucket',
    properties,
    context === undefined ? undefined : { afterOwnWrite: context.afterOwnWrite }
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
    const out = await capture(makeProvider(), DECLARED, { afterOwnWrite: true, write: 'put' });
    expect(out['LifecycleConfiguration']).toEqual(NEW_READBACK);
    expect(lifecycleCalls).toBe(1);
  });

  it('re-reads a just-written configuration that still reads ABSENT', async () => {
    scriptLifecycle(NONE, NONE, NEW);
    const out = await capture(makeProvider(), DECLARED, { afterOwnWrite: true, write: 'put' });
    expect(out['LifecycleConfiguration']).toEqual(NEW_READBACK);
    expect(lifecycleCalls).toBe(3);
  });

  it('re-reads a just-replaced configuration that still reads the OLD rules', async () => {
    scriptLifecycle(OLD, NEW);
    const out = await capture(makeProvider(), DECLARED, { afterOwnWrite: true, write: 'put' });
    expect(out['LifecycleConfiguration']).toEqual(NEW_READBACK);
    expect(lifecycleCalls).toBe(2);
  });

  it('a FLAPPING read (old, new, old) stops on the first new answer', async () => {
    scriptLifecycle(OLD, NEW, OLD);
    const out = await capture(makeProvider(), DECLARED, { afterOwnWrite: true, write: 'put' });
    expect(out['LifecycleConfiguration']).toEqual(NEW_READBACK);
    expect(lifecycleCalls).toBe(2);
  });

  it('keeps the DECLARED rules, in the readback shape, after the schedule still reads OLD', async () => {
    scriptLifecycle(OLD);
    const out = await capture(makeProvider(), DECLARED, { afterOwnWrite: true, write: 'put' });
    // Exactly what the next drift read emits once AWS settles.
    expect(out['LifecycleConfiguration']).toEqual(NEW_READBACK);
    expect(lifecycleCalls).toBe(5);
  });

  it('keeps the DECLARED rules after the schedule still reads ABSENT', async () => {
    scriptLifecycle(NONE);
    const out = await capture(makeProvider(), DECLARED, { afterOwnWrite: true, write: 'put' });
    expect(out['LifecycleConfiguration']).toEqual(NEW_READBACK);
    expect(lifecycleCalls).toBe(5);
  });

  it('records NO key when a just-deleted configuration still reads after the schedule', async () => {
    scriptLifecycle(OLD);
    const out = await capture(makeProvider(), DECLARED_NONE, { afterOwnWrite: true, write: 'delete' });
    expect(out).not.toHaveProperty('LifecycleConfiguration');
    expect(out['BucketName']).toBe(BUCKET);
    expect(lifecycleCalls).toBe(5);
  });

  it('records the empty placeholder once a just-deleted configuration reads gone', async () => {
    scriptLifecycle(OLD, NONE);
    const out = await capture(makeProvider(), DECLARED_NONE, { afterOwnWrite: true, write: 'delete' });
    expect(out['LifecycleConfiguration']).toEqual({ Rules: [] });
    expect(lifecycleCalls).toBe(2);
  });

  it('an undeclared, unconfigured lifecycle settles on ONE call', async () => {
    scriptLifecycle(NONE);
    const out = await capture(makeProvider(), DECLARED_NONE, { afterOwnWrite: true, write: 'delete' });
    expect(out['LifecycleConfiguration']).toEqual({ Rules: [] });
    expect(lifecycleCalls).toBe(1);
  });

  describe('read failures', () => {
    it('a TRANSIENT failure on the first read keeps the declared rules', async () => {
      scriptLifecycle(throttled);
      const out = await capture(makeProvider(), DECLARED, { afterOwnWrite: true, write: 'put' });
      expect(out['LifecycleConfiguration']).toEqual(NEW_READBACK);
      expect(lifecycleCalls).toBe(1);
    });

    it('a DETERMINISTIC failure on the first read fails the read, as before', async () => {
      scriptLifecycle(accessDenied);
      await expect(
        capture(makeProvider(), DECLARED, { afterOwnWrite: true, write: 'put' })
      ).rejects.toThrow('Access Denied');
      expect(lifecycleCalls).toBe(1);
    });

    it('a SOCKET failure on the first read keeps the declared rules', async () => {
      scriptLifecycle(socketReset);
      const out = await capture(makeProvider(), DECLARED, { afterOwnWrite: true, write: 'put' });
      expect(out['LifecycleConfiguration']).toEqual(NEW_READBACK);
      expect(lifecycleCalls).toBe(1);
    });

    it('any failure AFTER a stale answer keeps the declared rules, never the stale one', async () => {
      scriptLifecycle(OLD, accessDenied);
      const out = await capture(makeProvider(), DECLARED, { afterOwnWrite: true, write: 'put' });
      expect(out['LifecycleConfiguration']).toEqual(NEW_READBACK);
      expect(lifecycleCalls).toBe(2);
    });

    it('a just-deleted configuration whose re-read fails records no key, never the deleted rules', async () => {
      scriptLifecycle(OLD, throttled);
      const out = await capture(makeProvider(), DECLARED_NONE, { afterOwnWrite: true, write: 'delete' });
      expect(out).not.toHaveProperty('LifecycleConfiguration');
      expect(lifecycleCalls).toBe(2);
    });

    it('after a Delete, a TRANSIENT first-read failure still fails the read', async () => {
      scriptLifecycle(throttled);
      await expect(
        capture(makeProvider(), DECLARED_NONE, { afterOwnWrite: true, write: 'delete' })
      ).rejects.toThrow('Slow Down');
      expect(lifecycleCalls).toBe(1);
    });

    it('an undeclared lifecycle whose FIRST read fails still fails the read, as before', async () => {
      scriptLifecycle(accessDenied);
      await expect(
        capture(makeProvider(), DECLARED_NONE, { afterOwnWrite: true, write: 'delete' })
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
      const out = await capture(makeProvider(), refused, { afterOwnWrite: true, write: 'put' });
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
      const out = await capture(makeProvider(), declaredNoId, { afterOwnWrite: true, write: 'put' });
      expect(lifecycleCalls).toBe(1);
      expect(
        (out['LifecycleConfiguration'] as { Rules: Array<Record<string, unknown>> }).Rules[0]!['Id']
      ).toBe('OGJiNDg2NTAtNmVhOS00Njg3LTkxMTUtMDEyNGY1MTBiNDBk');
    });

    it('a stale read with an Id does not settle it, and the kept rules carry no Id', async () => {
      scriptLifecycle(sdkConfig(30, 'b2xk'));
      const out = await capture(makeProvider(), declaredNoId, { afterOwnWrite: true, write: 'put' });
      expect(lifecycleCalls).toBe(5);
      expect(out['LifecycleConfiguration']).toEqual({
        TransitionDefaultMinimumObjectSize: TDMOS,
        Rules: [{ Status: 'Enabled', ExpirationInDays: 7, Filter: { Prefix: '' } }],
      });
    });
  });
});

describe('the capture re-reads only a lifecycle THIS write touched (#6609 B1)', () => {
  it('a tags-only update on a bucket with an out-of-band lifecycle and no declaration records it, ONE call', async () => {
    scriptLifecycle(OLD, NONE);
    const out = await capture(makeProvider(), DECLARED_NONE, { afterOwnWrite: true });
    expect(out['LifecycleConfiguration']).toEqual(OLD_READBACK);
    expect(lifecycleCalls).toBe(1);
  });

  it('a tags-only update with a declared lifecycle takes the read as is, ONE call', async () => {
    scriptLifecycle(OLD, NEW);
    const out = await capture(makeProvider(), DECLARED, { afterOwnWrite: true });
    expect(out['LifecycleConfiguration']).toEqual(OLD_READBACK);
    expect(lifecycleCalls).toBe(1);
  });

  it('the applier notes its Put, so the next capture re-reads', async () => {
    const provider = makeProvider();
    const applied = await provider.applyLifecycleConfiguration(
      BUCKET,
      DECLARED.LifecycleConfiguration
    );
    expect(applied).toBe(true);
    scriptLifecycle(OLD, NEW);
    const out = await capture(provider, DECLARED, { afterOwnWrite: true });
    expect(out['LifecycleConfiguration']).toEqual(NEW_READBACK);
    expect(lifecycleCalls).toBe(2);
  });

  it('an update removing the lifecycle notes its Delete, so the next capture re-reads', async () => {
    const provider = makeProvider();
    await provider.update('Bucket', BUCKET, 'AWS::S3::Bucket', DECLARED_NONE, DECLARED);
    expect(
      mockSend.mock.calls.some(
        ([command]) => (command as object).constructor.name === 'DeleteBucketLifecycleCommand'
      )
    ).toBe(true);
    lifecycleCalls = 0;
    scriptLifecycle(OLD, NONE);
    const out = await capture(provider, DECLARED_NONE, { afterOwnWrite: true });
    expect(out['LifecycleConfiguration']).toEqual({ Rules: [] });
    expect(lifecycleCalls).toBe(2);
  });

  it('an update to `Rules: []` (the update path SKIPS it) sends no Delete, so the capture takes the first answer', async () => {
    const provider = makeProvider();
    const emptied = { BucketName: BUCKET, LifecycleConfiguration: { Rules: [] } };
    await provider.update('Bucket', BUCKET, 'AWS::S3::Bucket', emptied, DECLARED);
    lifecycleCalls = 0;
    scriptLifecycle(OLD, NONE);
    const out = await capture(provider, emptied, { afterOwnWrite: true });
    expect(out['LifecycleConfiguration']).toEqual(OLD_READBACK);
    expect(lifecycleCalls).toBe(1);
  });

  it('a revert to `Rules: []` from a readback notes its Delete, so the capture re-reads', async () => {
    const provider = makeProvider();
    const emptied = { BucketName: BUCKET, LifecycleConfiguration: { Rules: [] } };
    await provider.update('Bucket', BUCKET, 'AWS::S3::Bucket', emptied, DECLARED, {
      desiredFromAwsReadback: true,
    });
    lifecycleCalls = 0;
    scriptLifecycle(OLD, NONE);
    const out = await capture(provider, emptied, { afterOwnWrite: true });
    expect(out['LifecycleConfiguration']).toEqual({ Rules: [] });
    expect(lifecycleCalls).toBe(2);
  });

  it('an update that THROWS after its lifecycle Put drops the note, so a later capture takes the first answer', async () => {
    const provider = makeProvider();
    const corsFails = vi.fn();
    mockSend.mockImplementation((command: unknown) => {
      if (command instanceof PutBucketCorsCommand) {
        corsFails();
        return Promise.reject(new Error('cors refused'));
      }
      if (command instanceof GetBucketLifecycleConfigurationCommand) {
        lifecycleCalls++;
        const answer = script.length > 1 ? script.shift()! : script[0];
        return typeof answer === 'function' ? Promise.reject(answer()) : Promise.resolve(answer);
      }
      return Promise.resolve({});
    });
    const desired = {
      ...DECLARED,
      CorsConfiguration: { CorsRules: [{ AllowedMethods: ['GET'], AllowedOrigins: ['*'] }] },
    };
    const previous = {
      BucketName: BUCKET,
      LifecycleConfiguration: { Rules: [{ Id: 'r1', Status: 'Enabled', ExpirationInDays: 30 }] },
    };
    await expect(
      provider.update('Bucket', BUCKET, 'AWS::S3::Bucket', desired, previous)
    ).rejects.toThrow();
    expect(
      mockSend.mock.calls.filter(([c]) => c instanceof PutBucketLifecycleConfigurationCommand)
    ).toHaveLength(1);
    expect(corsFails).toHaveBeenCalled();
    lifecycleCalls = 0;
    scriptLifecycle(OLD, NEW);
    const out = await capture(provider, DECLARED, { afterOwnWrite: true });
    expect(out['LifecycleConfiguration']).toEqual(OLD_READBACK);
    expect(lifecycleCalls).toBe(1);
  });

  it('a create that THROWS after its lifecycle Put drops the note too', async () => {
    const provider = makeProvider();
    mockSend.mockImplementation((command: unknown) => {
      if (command instanceof PutBucketLoggingCommand) {
        return Promise.reject(new Error('logging refused'));
      }
      if (command instanceof GetBucketLifecycleConfigurationCommand) {
        lifecycleCalls++;
        const answer = script.length > 1 ? script.shift()! : script[0];
        return typeof answer === 'function' ? Promise.reject(answer()) : Promise.resolve(answer);
      }
      // No bucket holds the name yet, so the create goes ahead.
      if (command instanceof GetBucketLocationCommand) {
        return Promise.reject(
          new NoSuchBucket({ message: 'no such bucket', $metadata: { httpStatusCode: 404 } })
        );
      }
      return Promise.resolve({});
    });
    const desired = {
      ...DECLARED,
      // Applied after the lifecycle on create, so its failure follows the Put.
      LoggingConfiguration: { DestinationBucketName: 'logs-bucket' },
    };
    await expect(provider.create('Bucket', 'AWS::S3::Bucket', desired)).rejects.toThrow();
    expect(
      mockSend.mock.calls.filter(([c]) => c instanceof PutBucketLifecycleConfigurationCommand)
    ).toHaveLength(1);
    mockSend.mockImplementation((command: unknown) => {
      if (command instanceof GetBucketLifecycleConfigurationCommand) {
        lifecycleCalls++;
        const answer = script.length > 1 ? script.shift()! : script[0];
        return typeof answer === 'function' ? Promise.reject(answer()) : Promise.resolve(answer);
      }
      return Promise.resolve({});
    });
    lifecycleCalls = 0;
    scriptLifecycle(OLD, NEW);
    const out = await capture(provider, DECLARED, { afterOwnWrite: true });
    expect(out['LifecycleConfiguration']).toEqual(OLD_READBACK);
    expect(lifecycleCalls).toBe(1);
  });

  it('a read WITHOUT the post-write context neither re-reads nor consumes the note', async () => {
    const provider = makeProvider();
    recordLifecycleWrite(provider, BUCKET, 'put');
    scriptLifecycle(OLD, NEW);
    const drift = await capture(provider, DECLARED);
    expect(drift['LifecycleConfiguration']).toEqual(OLD_READBACK);
    expect(lifecycleCalls).toBe(1);
    // The capture that follows still finds the note and settles.
    lifecycleCalls = 0;
    scriptLifecycle(OLD, NEW);
    const out = await capture(provider, DECLARED, { afterOwnWrite: true });
    expect(out['LifecycleConfiguration']).toEqual(NEW_READBACK);
    expect(lifecycleCalls).toBe(2);
  });

  it('the note is consumed: a second capture takes the first answer', async () => {
    const provider = makeProvider();
    scriptLifecycle(OLD, NEW);
    await capture(provider, DECLARED, { afterOwnWrite: true, write: 'put' });
    lifecycleCalls = 0;
    scriptLifecycle(OLD, NEW);
    const out = await capture(provider, DECLARED, { afterOwnWrite: true });
    expect(out['LifecycleConfiguration']).toEqual(OLD_READBACK);
    expect(lifecycleCalls).toBe(1);
  });

  it('a TransitionDefaultMinimumObjectSize-only change re-reads until the new size shows (2 calls)', async () => {
    const declared = {
      LifecycleConfiguration: {
        TransitionDefaultMinimumObjectSize: 'varies_by_storage_class',
        Rules: DECLARED.LifecycleConfiguration.Rules,
      },
    };
    scriptLifecycle(NEW, { ...NEW, TransitionDefaultMinimumObjectSize: 'varies_by_storage_class' });
    const out = await capture(makeProvider(), declared, { afterOwnWrite: true, write: 'put' });
    expect(out['LifecycleConfiguration']).toEqual({
      ...NEW_READBACK,
      TransitionDefaultMinimumObjectSize: 'varies_by_storage_class',
    });
    expect(lifecycleCalls).toBe(2);
  });

  it('quoted numbers settle on the first read', async () => {
    // Measured (us-east-1, 2026-11-19): put through the applier, these read
    // back as numbers. Two rules: S3 refuses an abort rule with a size filter.
    const declared = {
      LifecycleConfiguration: {
        Rules: [
          {
            Id: 'q',
            Status: 'Enabled',
            ObjectSizeGreaterThan: '1024',
            Transitions: [{ StorageClass: 'GLACIER', TransitionInDays: '30' }],
          },
          { Id: 'a', Status: 'Enabled', AbortIncompleteMultipartUpload: { DaysAfterInitiation: '7' } },
        ],
      },
    };
    scriptLifecycle({
      TransitionDefaultMinimumObjectSize: TDMOS,
      Rules: [
        {
          ID: 'q',
          Status: 'Enabled',
          Filter: { ObjectSizeGreaterThan: 1024 },
          Transitions: [{ Days: 30, StorageClass: 'GLACIER' }],
        },
        {
          ID: 'a',
          Status: 'Enabled',
          Filter: { Prefix: '' },
          AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 },
        },
      ],
    });
    const out = await capture(makeProvider(), declared, { afterOwnWrite: true, write: 'put' });
    expect(lifecycleCalls).toBe(1);
    // ...and the heal compares them the same way.
    expect(
      preFixBaselineUncomparedDriftKeys('AWS::S3::Bucket', {}, declared, {
        LifecycleConfiguration: out['LifecycleConfiguration'],
      })
    ).toEqual(['LifecycleConfiguration']);
  });

  describe('unsettled arms warn once, value-free; settled ones never', () => {
    const warn = () => vi.mocked(getLogger().child('S3BucketProvider').warn);

    it('kept declared after the schedule: one warning naming no value', async () => {
      scriptLifecycle(OLD);
      await capture(makeProvider(), DECLARED, { afterOwnWrite: true, write: 'put' });
      expect(warn()).toHaveBeenCalledTimes(1);
      const message = String(warn().mock.calls[0]![0]);
      expect(message).toContain('LifecycleConfiguration');
      expect(message).not.toContain('30');
      expect(message).not.toContain('Expiration');
    });

    it('a just-deleted configuration still visible: one warning', async () => {
      scriptLifecycle(OLD);
      await capture(makeProvider(), DECLARED_NONE, { afterOwnWrite: true, write: 'delete' });
      expect(warn()).toHaveBeenCalledTimes(1);
    });

    it('settled: no warning', async () => {
      scriptLifecycle(OLD, NEW);
      await capture(makeProvider(), DECLARED, { afterOwnWrite: true, write: 'put' });
      expect(warn()).not.toHaveBeenCalled();
    });
  });
});

describe('declaredLifecycle: declarations no readback can equal are not settled on', () => {
  it.each([
    ['a non-object configuration', { LifecycleConfiguration: 'x' }],
    ['a non-object rule', { LifecycleConfiguration: { Rules: ['r'] } }],
    ['non-array rules', { LifecycleConfiguration: { Rules: { Id: 'r' } } }],
    [
      'ExpiredObjectDeleteMarker beside an expiration (the applier drops the marker)',
      {
        LifecycleConfiguration: {
          Rules: [{ Id: 'm', ExpiredObjectDeleteMarker: true, ExpirationInDays: 3 }],
        },
      },
    ],
    [
      'a quoted ExpirationInDays (the applier sends it as a date)',
      { LifecycleConfiguration: { Rules: [{ Id: 'm', ExpirationInDays: '30' }] } },
    ],
    [
      'an unreadable day count',
      { LifecycleConfiguration: { Rules: [{ Id: 'm', AbortIncompleteMultipartUpload: { DaysAfterInitiation: 'x' } }] } },
    ],
  ])('%s', async (_label, properties) => {
    expect(declaredLifecycle(properties)).toBeUndefined();
    scriptLifecycle(OLD, NEW);
    const out = await capture(makeProvider(), properties, { afterOwnWrite: true, write: 'put' });
    expect(out['LifecycleConfiguration']).toEqual(OLD_READBACK);
    expect(lifecycleCalls).toBe(1);
  });

  it.each([
    ['no configuration', {}],
    ['`Rules: []` (the update path skips it)', { LifecycleConfiguration: { Rules: [] } }],
    ['`{}`', { LifecycleConfiguration: {} }],
  ])('%s reads as absent, and without a Delete takes the first answer', async (_l, lifecycle) => {
    const properties = { BucketName: BUCKET, ...lifecycle };
    expect(declaredLifecycle(properties)).toEqual({ kind: 'absent' });
    scriptLifecycle(OLD, NONE);
    const out = await capture(makeProvider(), properties, { afterOwnWrite: true });
    expect(out['LifecycleConfiguration']).toEqual(OLD_READBACK);
    expect(lifecycleCalls).toBe(1);
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
    const declaredSize = expectedOf({
      TransitionDefaultMinimumObjectSize: 'varies_by_storage_class',
      Rules: [{ Id: 'a', ExpirationInDays: 1 }, { Id: 'b', ExpirationInDays: 2 }],
    });
    expect(
      lifecycleMatchesDeclared({ TransitionDefaultMinimumObjectSize: TDMOS, Rules: [a, b] }, declaredSize)
    ).toBe(false);
    expect(lifecycleMatchesDeclared({ Rules: [] }, expected)).toBe(false);
  });

  it('a top-level key other than Rules / TransitionDefaultMinimumObjectSize that differs is not a match', () => {
    const expected = expectedOf({ Rules: [{ Id: 'a', ExpirationInDays: 1 }] });
    const rule = { Id: 'a', Status: 'Enabled', ExpirationInDays: 1, Filter: { Prefix: '' } };
    expect(lifecycleMatchesDeclared({ Rules: [rule] }, expected)).toBe(true);
    expect(lifecycleMatchesDeclared({ Rules: [rule], Other: 1 }, expected)).toBe(false);
  });

  it('an Id-less declared rule needs SOME Id on the read rule', () => {
    const expected = expectedOf({ Rules: [{ ExpirationInDays: 1 }] });
    const rule = { Status: 'Enabled', ExpirationInDays: 1, Filter: { Prefix: '' } };
    expect(lifecycleMatchesDeclared({ Rules: [{ Id: 'gen', ...rule }] }, expected)).toBe(true);
    expect(lifecycleMatchesDeclared({ Rules: [rule] }, expected)).toBe(false);
  });
});

describe('drift heal of a LifecycleConfiguration baseline (#6609 B1)', () => {
  const TYPE = 'AWS::S3::Bucket';
  const GENERATED = 'OGJiNDg2NTAtNmVhOS00Njg3LTkxMTUtMDEyNGY1MTBiNDBk';
  const declaredNoId = {
    BucketName: BUCKET,
    LifecycleConfiguration: { Rules: [{ Status: 'Enabled', ExpirationInDays: 7 }] },
  };

  /** The drift comparison as `compare.ts` runs it on an observed baseline. */
  function driftPaths(
    observed: Record<string, unknown>,
    properties: Record<string, unknown>,
    aws: Record<string, unknown>,
    heal = true
  ): string[] {
    const ignorePaths = heal
      ? preFixBaselineUncomparedDriftKeys(TYPE, observed, properties, aws)
      : [];
    return calculateResourceDrift(observed, aws, { ignorePaths, unionWalkObjects: true }).map(
      (change) => change.path
    );
  }

  it('Id-less end to end: kept without an Id, read later with the generated one, reports nothing', async () => {
    // The capture: the schedule only ever sees the previous rules.
    scriptLifecycle(sdkConfig(30, 'b2xk'));
    const observed = await capture(makeProvider(), declaredNoId, { afterOwnWrite: true, write: 'put' });
    expect(lifecycleCalls).toBe(5);
    // A later drift read, once S3 settled: the declared rule under its generated Id.
    lifecycleCalls = 0;
    scriptLifecycle(sdkConfig(7, GENERATED));
    const aws = await capture(makeProvider(), declaredNoId);
    expect(lifecycleCalls).toBe(1);
    expect(driftPaths(observed, declaredNoId, aws)).toEqual([]);
    // The heal is what makes it clean: compared, the generated Id would be drift.
    expect(driftPaths(observed, declaredNoId, aws, false)).not.toEqual([]);
  });

  it('Id-less end to end: a rule changed out of band is still reported', async () => {
    scriptLifecycle(sdkConfig(30, 'b2xk'));
    const observed = await capture(makeProvider(), declaredNoId, { afterOwnWrite: true, write: 'put' });
    scriptLifecycle(sdkConfig(9, GENERATED));
    const aws = await capture(makeProvider(), declaredNoId);
    expect(preFixBaselineUncomparedDriftKeys(TYPE, observed, declaredNoId, aws)).toEqual([]);
    expect(driftPaths(observed, declaredNoId, aws).join(',')).toContain('LifecycleConfiguration');
  });

  it('a pre-fix baseline holding the OLD rules is not compared while live is the declared one', () => {
    const observed = { BucketName: BUCKET, LifecycleConfiguration: OLD_READBACK };
    const aws = { BucketName: BUCKET, LifecycleConfiguration: NEW_READBACK };
    expect(preFixBaselineUncomparedDriftKeys(TYPE, observed, DECLARED, aws)).toEqual([
      'LifecycleConfiguration',
    ]);
    expect(driftPaths(observed, DECLARED, aws)).toEqual([]);
  });

  it('a pre-fix baseline holding the declared rules while live changed out of band is reported', () => {
    const observed = { BucketName: BUCKET, LifecycleConfiguration: NEW_READBACK };
    const aws = { BucketName: BUCKET, LifecycleConfiguration: OLD_READBACK };
    expect(preFixBaselineUncomparedDriftKeys(TYPE, observed, DECLARED, aws)).toEqual([]);
    expect(driftPaths(observed, DECLARED, aws).join(',')).toContain('LifecycleConfiguration');
  });

  it('a pre-fix baseline holding just-deleted rules is not compared while none are declared or live', () => {
    const observed = { BucketName: BUCKET, LifecycleConfiguration: OLD_READBACK };
    const aws = { BucketName: BUCKET, LifecycleConfiguration: { Rules: [] } };
    expect(preFixBaselineUncomparedDriftKeys(TYPE, observed, DECLARED_NONE, aws)).toEqual([
      'LifecycleConfiguration',
    ]);
  });

  it('rules added out of band to a bucket that declares none are reported', () => {
    const observed = { BucketName: BUCKET, LifecycleConfiguration: { Rules: [] } };
    const aws = { BucketName: BUCKET, LifecycleConfiguration: OLD_READBACK };
    expect(preFixBaselineUncomparedDriftKeys(TYPE, observed, DECLARED_NONE, aws)).toEqual([]);
    expect(driftPaths(observed, DECLARED_NONE, aws).join(',')).toContain('LifecycleConfiguration');
  });

  it('a declaration the applier refuses skips nothing', () => {
    const refused = {
      LifecycleConfiguration: {
        Rules: [{ Id: 'r1', Status: 'Enabled', Filter: 'logs/', ExpirationInDays: 7 }],
      },
    };
    const observed = { LifecycleConfiguration: OLD_READBACK };
    const aws = { LifecycleConfiguration: NEW_READBACK };
    expect(preFixBaselineUncomparedDriftKeys(TYPE, observed, refused, aws)).toEqual([]);
  });
});
