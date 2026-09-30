/**
 * Issue #2177 — the S3 bucket family's masked log sinks.
 *
 * `S3BucketProvider.create()` / `update()` interpolate the bucket name (a
 * RESOLVED `BucketName` off the `properties` bag, or the physical id recorded
 * from one) into ~60 log lines and messages across the private appliers they
 * reach, and a provider's own `this.logger` lines reach no engine sink. Each
 * operation now runs its appliers on a per-call view whose logger routes every
 * line through the deploy's masker, and every interpolated name is masked RAW
 * before it joins the sentence.
 *
 * Every case asserts over the WHOLE transcript (every debug / info / warn /
 * error line), not one known line: the view's promise is that a line added
 * later is masked by construction. Two secret classes are used on purpose:
 *
 *  - `SHORT` (three characters) is below the substring arm's
 *    `MIN_NEEDLE_LENGTH`, so ONLY the raw per-value mask catches it. A site
 *    that stopped masking its name raw — or an applier called on the singleton
 *    instead of the view — leaks it.
 *  - `LONG` reaches the message-level arm, and is echoed inside AWS error text
 *    the provider interpolates WITHOUT a per-value mask, so it fails if the
 *    view's logger stops masking whole lines.
 *
 * The unmasked control proves the transcript names each value when no masker
 * is supplied, so no assertion here passes vacuously.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const { mockSend, logSpies, clientRegion } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  logSpies: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  clientRegion: { value: 'us-east-1' },
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    s3: { send: mockSend, config: { region: () => Promise.resolve(clientRegion.value) } },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = { ...logSpies, child: vi.fn().mockReturnThis() };
  return {
    getLogger: () => ({ ...logSpies, child: () => childLogger }),
  };
});

import { S3BucketProvider } from '../../../src/provisioning/providers/s3-bucket-provider.js';
import { createMaskedLogSinks } from '../../../src/provisioning/masked-retry-logger.js';
import {
  createSecretMasker,
  SECRET_MASK,
  type RecordedSecretValues,
} from '../../../src/deployment/secret-redaction.js';

const RESOURCE_TYPE = 'AWS::S3::Bucket';

/** Below `MIN_NEEDLE_LENGTH`: only a RAW value mask catches it. */
const SHORT = 'q7z';
/** A second short secret, used as a configuration Id / storage class. */
const SHORT_ID = 'k2w';
/** Long enough for the message-level substring arm. */
const LONG = 's3-2177-long-plaintext';
/** A rotated secret's OLD plaintext: in NO bag of this deploy. */
const OLD = 's3-2177-old-plaintext';

function bagOf(...values: string[]): RecordedSecretValues {
  return new Map(values.map((v) => [v, `{{resolve:secretsmanager:${v}}}`]));
}

/**
 * A secret `JSON.stringify` ESCAPES, so no mask applied to the finished message
 * can find it: only a leaf mask before the stringify does.
 */
const ESCAPED = 's3-2177 "quoted" and\nnewlined plaintext';

const maskSecrets = createSecretMasker(bagOf(SHORT, SHORT_ID, LONG, ESCAPED));

/** Every log line, every level, as one string. */
function transcript(): string {
  return Object.values(logSpies)
    .flatMap((spy) => spy.mock.calls)
    .map((call) => call.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '))
    .join('\n');
}

/**
 * Whether `text` names `plaintext`. A three-character needle is matched as a
 * token so it cannot collide with an ordinary word.
 */
function names(text: string, plaintext: string): boolean {
  if (plaintext.length >= 4) return text.includes(plaintext);
  return new RegExp(`(^|[^A-Za-z0-9])${plaintext}([^A-Za-z0-9]|$)`).test(text);
}

function expectMasked(text: string, ...plaintexts: string[]): void {
  for (const plaintext of plaintexts) expect(names(text, plaintext), plaintext).toBe(false);
  expect(text).toContain(SECRET_MASK);
}

function expectNamed(text: string, ...plaintexts: string[]): void {
  for (const plaintext of plaintexts) expect(names(text, plaintext), plaintext).toBe(true);
}

function awsError(name: string, message: string): Error {
  return Object.assign(new Error(message), {
    name,
    $fault: 'client',
    $metadata: { httpStatusCode: 403 },
  });
}

/**
 * Answer every command with `{}` unless `answers` names it. A value that is an
 * `Error` rejects; a function is called with the command's input.
 */
function answer(answers: Record<string, unknown> = {}): void {
  mockSend.mockImplementation(
    (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      const name = command.constructor.name;
      if (!(name in answers)) return Promise.resolve({});
      const a = answers[name];
      const value = typeof a === 'function' ? (a as (i: unknown) => unknown)(command.input) : a;
      return value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
    }
  );
}

const noSuchBucket = (): Error =>
  Object.assign(new Error('The specified bucket does not exist'), { name: 'NoSuchBucket' });

/** A lifecycle rule reaching all three of the applier's warnings. */
const LIFECYCLE_RULE = {
  Id: SHORT_ID,
  Status: 'Enabled',
  ExpirationInDays: 30,
  ExpiredObjectDeleteMarker: true,
  NoncurrentVersionTransitions: [{ StorageClass: SHORT_ID, TransitionInDays: 30 }],
  NoncurrentVersionTransition: { StorageClass: SHORT_ID, TransitionInDays: 60 },
  Transitions: [{ StorageClass: SHORT_ID, TransitionInDays: 30 }],
  Transition: { StorageClass: SHORT_ID, TransitionInDays: 60 },
};

/** Every configuration `create()` applies, so every applier's line runs. */
function everyConfig(bucketName: string): Record<string, unknown> {
  return {
    BucketName: bucketName,
    VersioningConfiguration: { Status: 'Enabled' },
    Tags: [{ Key: 'k', Value: 'v' }],
    OwnershipControls: { Rules: [{ ObjectOwnership: 'BucketOwnerEnforced' }] },
    PublicAccessBlockConfiguration: { BlockPublicAcls: true },
    BucketEncryption: {
      ServerSideEncryptionConfiguration: [
        { ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } },
      ],
    },
    LifecycleConfiguration: { Rules: [LIFECYCLE_RULE] },
    CorsConfiguration: { CorsRules: [{ AllowedMethods: ['GET'], AllowedOrigins: ['*'] }] },
    WebsiteConfiguration: { IndexDocument: 'index.html' },
    LoggingConfiguration: { DestinationBucketName: 'log-bucket', LogFilePrefix: 'logs/' },
    AccelerateConfiguration: { AccelerationStatus: 'Enabled' },
    NotificationConfiguration: {
      TopicConfigurations: [{ Topic: 'arn:aws:sns:us-east-1:1:t', Event: 's3:ObjectCreated:*' }],
    },
    MetricsConfigurations: [{ Id: 'm1' }],
    AnalyticsConfigurations: [{ Id: 'a1' }],
    IntelligentTieringConfigurations: [
      { Id: 'it1', Status: 'Enabled', Tierings: [{ AccessTier: 'ARCHIVE_ACCESS', Days: 90 }] },
    ],
    InventoryConfigurations: [
      {
        Id: 'inv1',
        Enabled: true,
        IncludedObjectVersions: 'All',
        ScheduleFrequency: 'Weekly',
        Destination: { BucketArn: 'arn:aws:s3:::inv-bucket', Format: 'CSV' },
      },
    ],
    ReplicationConfiguration: {
      Role: 'arn:aws:iam::1:role/repl',
      Rules: [{ Id: 'r1', Status: 'Enabled', Destination: { Bucket: 'arn:aws:s3:::dest' } }],
    },
    ObjectLockEnabled: true,
    ObjectLockConfiguration: {
      ObjectLockEnabled: 'Enabled',
      Rule: { DefaultRetention: { Mode: 'GOVERNANCE', Days: 30 } },
    },
  };
}

/** The same bucket with every configuration GONE, or changed: every remove arm. */
function everyConfigRemoved(bucketName: string): Record<string, unknown> {
  return {
    BucketName: bucketName,
    Tags: [{ Key: 'k', Value: 'changed' }],
    ObjectLockEnabled: true,
    // Metrics / analytics / intelligent tiering / inventory: `SHORT_ID` is
    // REMOVED (a per-Id Delete naming it) while a sibling is kept.
    MetricsConfigurations: [{ Id: 'm1' }],
  };
}

function everyConfigWithRemovableIds(bucketName: string): Record<string, unknown> {
  const all = everyConfig(bucketName);
  return {
    ...all,
    MetricsConfigurations: [{ Id: 'm1' }, { Id: SHORT_ID }],
    AnalyticsConfigurations: [{ Id: SHORT_ID }],
    IntelligentTieringConfigurations: [
      { Id: SHORT_ID, Status: 'Enabled', Tierings: [{ AccessTier: 'ARCHIVE_ACCESS', Days: 90 }] },
    ],
    InventoryConfigurations: [
      {
        ...(all['InventoryConfigurations'] as Array<Record<string, unknown>>)[0],
        Id: SHORT_ID,
      },
    ],
  };
}

describe('S3BucketProvider masked log sinks (issue #2177)', () => {
  let provider: S3BucketProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    clientRegion.value = 'us-east-1';
    provider = new S3BucketProvider();
    answer({ GetBucketLocationCommand: noSuchBucket() });
  });

  describe('create()', () => {
    it('masks the bucket name, rule ids and storage classes on every applier line', async () => {
      await provider.create('Bucket', RESOURCE_TYPE, everyConfig(SHORT), { maskSecrets });

      const text = transcript();
      expectMasked(text, SHORT, SHORT_ID);
      // Every applier ran: its own line is in the transcript, masked.
      for (const line of [
        'Applied versioning',
        'tags to bucket',
        'Applied CORS configuration',
        'Applied lifecycle configuration',
        'Applied public access block',
        'Applied encryption configuration',
        'Applied logging configuration',
        'Applied website configuration',
        'Applied accelerate configuration',
        'Applied notification configuration',
        'metrics configuration(s)',
        'analytics configuration(s)',
        'intelligent tiering configuration(s)',
        'inventory configuration(s)',
        'Applied replication configuration',
        'Applied object lock configuration',
        'Applied ownership controls',
        'sets ExpiredObjectDeleteMarker',
        'legacy NoncurrentVersionTransition',
        'legacy Transition for storage class',
        'Created S3 bucket',
        'Successfully created S3 bucket',
      ]) {
        expect(text).toContain(line);
      }
    });

    it('UNMASKED control: with no masker the same transcript names every value', async () => {
      await provider.create('Bucket', RESOURCE_TYPE, everyConfig(SHORT));

      expectNamed(transcript(), SHORT, SHORT_ID);
    });

    it('masks the adopted-bucket warning (us-east-1 legacy 200)', async () => {
      answer({ GetBucketLocationCommand: { LocationConstraint: null } });

      await provider.create('Bucket', RESOURCE_TYPE, { BucketName: SHORT }, { maskSecrets });

      const text = transcript();
      expect(text).toContain('was ADOPTED');
      expectMasked(text, SHORT);
    });

    it('masks the already-owned line (BucketAlreadyOwnedByYou in the stack region)', async () => {
      clientRegion.value = 'eu-west-1';
      answer({
        CreateBucketCommand: Object.assign(new Error('you already own it'), {
          name: 'BucketAlreadyOwnedByYou',
        }),
        GetBucketLocationCommand: { LocationConstraint: 'eu-west-1' },
      });

      await provider.create('Bucket', RESOURCE_TYPE, { BucketName: SHORT }, { maskSecrets });

      const text = transcript();
      expect(text).toContain('already exists and is owned by you');
      expectMasked(text, SHORT);
    });

    it('masks the foreign-region adopt refusal it throws', async () => {
      clientRegion.value = 'eu-west-1';
      answer({
        CreateBucketCommand: Object.assign(new Error('you already own it'), {
          name: 'BucketAlreadyOwnedByYou',
        }),
        GetBucketLocationCommand: { LocationConstraint: 'us-west-2' },
      });

      const error = await provider
        .create('Bucket', RESOURCE_TYPE, { BucketName: SHORT }, { maskSecrets })
        .then(() => new Error("resolved instead of rejecting"))
        .catch((e: unknown) => e as Error);

      expect(error.message).toContain('Refusing to adopt existing S3 bucket');
      expectMasked(error.message, SHORT);
    });

    it('masks every partial-create cleanup line, AWS text included, and withholds the command', async () => {
      answer({
        GetBucketLocationCommand: noSuchBucket(),
        PutBucketVersioningCommand: awsError('AccessDenied', `denied on ${LONG}`),
        DeleteBucketCommand: awsError('AccessDenied', `cannot delete ${LONG}`),
      });

      const error = await provider
        .create(
          'Bucket',
          RESOURCE_TYPE,
          { BucketName: LONG, VersioningConfiguration: { Status: 'Enabled' } },
          { maskSecrets }
        )
        .then(() => new Error("resolved instead of rejecting"))
        .catch((e: unknown) => e as Error);

      const text = transcript();
      expect(text).toContain('DeleteBucket cleanup failed');
      expect(text).toContain('Failed to clean up partially-created S3 bucket');
      expect(text).toContain('via the console');
      expect(text).not.toContain('delete-bucket --bucket');
      expect(text).toContain('Failed to create S3 bucket');
      expectMasked(text, LONG);
      expect(error.message).toContain('Failed to create S3 bucket');
    });

    it('masks the successful partial-create cleanup line', async () => {
      answer({
        GetBucketLocationCommand: noSuchBucket(),
        PutBucketVersioningCommand: new Error('boom'),
      });

      await provider
        .create(
          'Bucket',
          RESOURCE_TYPE,
          { BucketName: SHORT, VersioningConfiguration: { Status: 'Enabled' } },
          { maskSecrets }
        )
        .catch(() => undefined);

      const text = transcript();
      expect(text).toContain('Cleaned up partially-created S3 bucket');
      expectMasked(text, SHORT);
    });

    it('masks the indeterminate-probe lines, AWS text included', async () => {
      answer({
        GetBucketLocationCommand: awsError('AccessDenied', `no location for ${LONG}`),
        PutBucketVersioningCommand: new Error('boom'),
      });

      await provider
        .create(
          'Bucket',
          RESOURCE_TYPE,
          { BucketName: LONG, VersioningConfiguration: { Status: 'Enabled' } },
          { maskSecrets }
        )
        .catch(() => undefined);

      const text = transcript();
      expect(text).toContain('during create');
      expect(text).toContain('Not cleaning up S3 bucket');
      expectMasked(text, LONG);
    });

    it('masks a SHORT name on the failed-cleanup lines', async () => {
      answer({
        GetBucketLocationCommand: noSuchBucket(),
        PutBucketVersioningCommand: new Error('boom'),
        DeleteBucketCommand: awsError('AccessDenied', 'cannot delete'),
      });

      await provider
        .create(
          'Bucket',
          RESOURCE_TYPE,
          { BucketName: SHORT, VersioningConfiguration: { Status: 'Enabled' } },
          { maskSecrets }
        )
        .catch(() => undefined);

      const text = transcript();
      expect(text).toContain('DeleteBucket cleanup failed');
      expect(text).toContain('Failed to clean up partially-created S3 bucket');
      expectMasked(text, SHORT);
    });

    it('masks a SHORT name on the indeterminate-probe lines, and withholds the command', async () => {
      answer({
        GetBucketLocationCommand: awsError('AccessDenied', 'no location'),
        PutBucketVersioningCommand: new Error('boom'),
      });

      await provider
        .create(
          'Bucket',
          RESOURCE_TYPE,
          { BucketName: SHORT, VersioningConfiguration: { Status: 'Enabled' } },
          { maskSecrets }
        )
        .catch(() => undefined);

      const text = transcript();
      expect(text).toContain('during create');
      expect(text).toContain('Not cleaning up S3 bucket');
      expect(text).toContain('via the console');
      expect(text).not.toContain('delete-bucket --bucket');
      expectMasked(text, SHORT);
    });

    it('masks the us-east-1 pre-flight foreign-region refusal it throws', async () => {
      answer({ GetBucketLocationCommand: { LocationConstraint: 'us-west-2' } });

      const error = await provider
        .create('Bucket', RESOURCE_TYPE, { BucketName: SHORT }, { maskSecrets })
        .then(() => new Error("resolved instead of rejecting"))
        .catch((e: unknown) => e as Error);

      expect(error.message).toContain('Refusing to adopt existing S3 bucket');
      expectMasked(error.message, SHORT);
    });

    it('masks a short versioning status RAW', async () => {
      await provider.create(
        'Bucket',
        RESOURCE_TYPE,
        { BucketName: 'plain-bucket', VersioningConfiguration: { Status: SHORT_ID } },
        { maskSecrets }
      );

      const text = transcript();
      expect(text).toContain('Applied versioning (***) to bucket plain-bucket');
    });

    it('masks the wrapped debug detail RAW, so a short secret AWS echoes whole is caught', async () => {
      answer({
        GetBucketLocationCommand: noSuchBucket(),
        CreateBucketCommand: awsError('AccessDenied', SHORT),
      });

      await provider
        .create('Bucket', RESOURCE_TYPE, { BucketName: 'plain-bucket' }, { maskSecrets })
        .catch(() => undefined);

      expect(transcript()).toContain(
        `Failed to create S3 bucket Bucket (plain-bucket): ${SECRET_MASK}`
      );
    });

    it('masks the thrown summary RAW, so a short secret AWS echoes whole is caught', async () => {
      answer({ GetBucketLocationCommand: noSuchBucket(), CreateBucketCommand: new Error(SHORT) });

      const error = await provider
        .create('Bucket', RESOURCE_TYPE, { BucketName: 'plain-bucket' }, { maskSecrets })
        .then(() => new Error("resolved instead of rejecting"))
        .catch((e: unknown) => e as Error);

      expect(error.message).toBe(`Failed to create S3 bucket Bucket: ${SECRET_MASK}`);
    });
  });

  describe('update()', () => {
    /**
     * Drives `update()` with the PREVIOUS side's `BucketName` DROPPED. A
     * previous `BucketName` that is itself secret makes the recorded name a
     * derived-name needle with no length floor (`withDerivedNameMasks`), which
     * would mask every line on its own and hide whether each site masks its
     * name RAW. Without it, only the per-site mask can catch `SHORT`. The
     * derived-name arm has its own cases at the end of this block.
     */
    const update = (
      props: Record<string, unknown>,
      previous: Record<string, unknown>,
      physicalId = SHORT,
      context: Record<string, unknown> = {}
    ): Promise<unknown> => {
      const { BucketName: _dropped, ...previousWithoutName } = previous;
      return provider.update('Bucket', physicalId, RESOURCE_TYPE, props, previousWithoutName, {
        maskSecrets,
        ...context,
      });
    };

    beforeEach(() => answer());

    it('masks every applier line of a full re-apply', async () => {
      await update(everyConfig(SHORT), { BucketName: SHORT });

      const text = transcript();
      expectMasked(text, SHORT, SHORT_ID);
      for (const line of [
        'Updating S3 bucket',
        'Applied versioning',
        'Replaced tag set on bucket',
        'Applied lifecycle configuration',
        'inventory configuration(s)',
        'Successfully updated S3 bucket',
      ]) {
        expect(text).toContain(line);
      }
    });

    it('masks every remove arm, per-Id deletes included', async () => {
      await update(everyConfigRemoved(SHORT), everyConfigWithRemovableIds(SHORT));

      const text = transcript();
      expectMasked(text, SHORT, SHORT_ID);
      for (const line of [
        'Deleted ownership controls',
        'Deleted bucket encryption',
        'Deleted lifecycle configuration on bucket',
        'Deleted CORS configuration on bucket',
        'Deleted website configuration',
        'Cleared logging configuration',
        'Deleted replication configuration',
        'Cleared object lock rule',
        'Deleted metrics configuration',
        'Deleted analytics configuration',
        'Deleted intelligent tiering configuration',
        'Deleted inventory configuration',
        'versioning would be suspended',
      ]) {
        expect(text).toContain(line);
      }
    });

    it('UNMASKED control: the remove arms name every value with no masker', async () => {
      await provider.update(
        'Bucket',
        SHORT,
        RESOURCE_TYPE,
        everyConfigRemoved(SHORT),
        everyConfigWithRemovableIds(SHORT)
      );

      expectNamed(transcript(), SHORT, SHORT_ID);
    });

    it('masks the cleared-tags line', async () => {
      await update({ BucketName: SHORT }, { BucketName: SHORT, Tags: [{ Key: 'k', Value: 'v' }] });

      const text = transcript();
      expect(text).toContain('Cleared tags from bucket');
      expectMasked(text, SHORT);
    });

    it('masks the drift-revert baseline deletes (desiredFromAwsReadback)', async () => {
      await update(
        {
          BucketName: SHORT,
          LifecycleConfiguration: { Rules: [] },
          CorsConfiguration: { CorsRules: [] },
        },
        {
          BucketName: SHORT,
          LifecycleConfiguration: { Rules: [{ Id: 'r', Status: 'Enabled', ExpirationInDays: 1 }] },
          CorsConfiguration: { CorsRules: [{ AllowedMethods: ['GET'], AllowedOrigins: ['*'] }] },
        },
        SHORT,
        { desiredFromAwsReadback: true }
      );

      const text = transcript();
      expect(text).toContain('Deleted lifecycle configuration on bucket');
      expect(text).toContain('Deleted CORS configuration on bucket');
      expect(text).toContain('reverting to an unset baseline');
      expectMasked(text, SHORT);
    });

    it('masks the replayed-versioning refusal warning', async () => {
      await update(
        { BucketName: SHORT, VersioningConfiguration: { Status: 7 } },
        { BucketName: SHORT, VersioningConfiguration: { Status: 'Enabled' } },
        SHORT,
        { replayingState: true }
      );

      const text = transcript();
      expect(text).toContain("Leaving the bucket's LIVE versioning state");
      expectMasked(text, SHORT);
    });

    it('masks the unrecordable per-item line (a non-array iterable desired side)', async () => {
      await update(
        { BucketName: SHORT, MetricsConfigurations: new Set([{ Id: 'm1', TagFilters: 'k=v' }]) },
        { BucketName: SHORT },
        SHORT,
        { replayingState: true }
      );

      const text = transcript();
      expect(text).toContain('could not be recorded');
      expectMasked(text, SHORT);
    });

    it('masks the name-change line, both names', async () => {
      await update({ BucketName: SHORT_ID }, { BucketName: SHORT });

      const text = transcript();
      expect(text).toContain('Bucket name changed');
      expectMasked(text, SHORT, SHORT_ID);
    });

    it('masks the template-path refusals it throws', async () => {
      const versioning = (await update(
        { BucketName: SHORT, VersioningConfiguration: { Status: 7 } },
        { BucketName: SHORT }
      ).catch((e: unknown) => e)) as Error;
      expect(versioning.message).toContain('Nothing was applied to bucket');
      expectMasked(versioning.message, SHORT);

      const applier = (await update(
        { BucketName: SHORT, MetricsConfigurations: [{ Id: 'm1', TagFilters: 'k=v' }] },
        { BucketName: SHORT }
      ).catch((e: unknown) => e)) as Error;
      expect(applier.message).toContain('Nothing was applied to bucket');
      expectMasked(applier.message, SHORT);
    });

    it('masks an escaping secret in a pre-flight destination refusal (leaf mask before stringify)', async () => {
      const error = (await update(
        {
          BucketName: SHORT,
          InventoryConfigurations: [
            {
              Id: 'inv1',
              Enabled: true,
              IncludedObjectVersions: 'All',
              ScheduleFrequency: 'Weekly',
              Destination: ESCAPED,
            },
          ],
        },
        {}
      ).catch((e: unknown) => e)) as Error;

      expect(error.message).toContain('Nothing was applied to bucket');
      expect(error.message).not.toContain(JSON.stringify(ESCAPED).slice(1, -1));
      expect(error.message).not.toContain('quoted');
      expectMasked(error.message, SHORT);
    });

    it('masks the indeterminate region-guard lines, AWS text included', async () => {
      answer({ GetBucketLocationCommand: awsError('AccessDenied', `no location for ${LONG}`) });

      await provider.update('Bucket', LONG, RESOURCE_TYPE, { BucketName: LONG }, { BucketName: LONG }, {
        maskSecrets,
      });

      const text = transcript();
      expect(text).toContain('GetBucketLocation failed for S3 bucket');
      expect(text).toContain('Could not confirm which bucket');
      expectMasked(text, LONG);
    });

    it('masks a SHORT name on the indeterminate region-guard lines', async () => {
      answer({ GetBucketLocationCommand: awsError('AccessDenied', 'no location') });

      await update({ BucketName: SHORT }, {});

      const text = transcript();
      expect(text).toContain('GetBucketLocation failed for S3 bucket');
      expect(text).toContain('Could not confirm which bucket');
      expectMasked(text, SHORT);
    });

    it('masks the cross-region refusal it throws', async () => {
      answer({ GetBucketLocationCommand: { LocationConstraint: 'us-west-2' } });

      const error = (await update({ BucketName: SHORT }, { BucketName: SHORT }).catch(
        (e: unknown) => e
      )) as Error;

      expect(error.message).toContain('Refusing to update S3 bucket');
      expectMasked(error.message, SHORT);
    });

    it('masks the wrapped AWS failure: debug detail and thrown summary', async () => {
      answer({ PutBucketVersioningCommand: awsError('AccessDenied', `denied on ${LONG}`) });

      const error = (await provider
        .update(
          'Bucket',
          SHORT,
          RESOURCE_TYPE,
          { BucketName: SHORT, VersioningConfiguration: { Status: 'Enabled' } },
          {},
          { maskSecrets }
        )
        .catch((e: unknown) => e)) as Error;

      const text = transcript();
      expect(text).toContain('Failed to update S3 bucket Bucket (');
      expectMasked(text, SHORT, LONG);
      expect(error.message).toContain('Failed to update S3 bucket Bucket: AccessDenied');
      expect(error.message).not.toContain(LONG);
    });

    it('masks the recorded name when the PREVIOUS BucketName is a secret reference (rotated secret)', async () => {
      await provider.update(
        'Bucket',
        OLD,
        RESOURCE_TYPE,
        { BucketName: OLD, VersioningConfiguration: { Status: 'Enabled' } },
        { BucketName: '{{resolve:secretsmanager:bucket-name}}' },
        { maskSecrets }
      );

      const text = transcript();
      expect(text).toContain('Applied versioning');
      expect(text).not.toContain(OLD);
      expect(text).toContain(SECRET_MASK);
    });

    it('masks a SHORT recorded name inside AWS text when the previous BucketName is that secret', async () => {
      // AWS quotes the name inside an ARN, where only the derived-name needle
      // (which has no length floor) can find a three-character secret: the
      // per-value mask never sees AWS's sentence as a whole value.
      answer({ PutBucketVersioningCommand: awsError('AccessDenied', `denied on arn:aws:s3:::${SHORT}`) });

      await provider
        .update(
          'Bucket',
          SHORT,
          RESOURCE_TYPE,
          { BucketName: SHORT, VersioningConfiguration: { Status: 'Enabled' } },
          { BucketName: SHORT },
          { maskSecrets }
        )
        .catch(() => undefined);

      const text = transcript();
      expect(text).toContain('arn:aws:s3:::');
      expectMasked(text, SHORT);
    });

    it('NEGATIVE control: a plain recorded name is left alone', async () => {
      await provider.update(
        'Bucket',
        OLD,
        RESOURCE_TYPE,
        { BucketName: OLD, VersioningConfiguration: { Status: 'Enabled' } },
        { BucketName: OLD },
        { maskSecrets }
      );

      expect(transcript()).toContain(`Applied versioning (Enabled) to bucket ${OLD}`);
    });

    it('does not split a longer recorded secret AWS echoes that contains the recorded name (issue #4193)', async () => {
      const longer = `${SHORT} owner hunter2x`;
      answer({ PutBucketVersioningCommand: awsError('AccessDenied', `denied on '${longer}'`) });

      await provider
        .update(
          'Bucket',
          SHORT,
          RESOURCE_TYPE,
          { BucketName: SHORT, VersioningConfiguration: { Status: 'Enabled' } },
          { BucketName: SHORT },
          { maskSecrets: createSecretMasker(bagOf(SHORT, longer)) }
        )
        .catch(() => undefined);

      const text = transcript();
      expect(text).toContain(`denied on '${SECRET_MASK}'`);
      expect(text).not.toContain('owner hunter2x');
    });
  });

  describe('the view', () => {
    it('masks structured log arguments as well as the message', () => {
      const view = (
        provider as unknown as {
          maskedView(s: ReturnType<typeof createMaskedLogSinks>): {
            logger: { debug(m: string, ...a: unknown[]): void };
          };
        }
      ).maskedView(createMaskedLogSinks(logSpies, maskSecrets));

      view.logger.debug(`line ${LONG}`, { name: SHORT, [LONG]: 'x' });

      const [message, arg] = logSpies.debug.mock.calls[0]!;
      expect(message).toBe(`line ${SECRET_MASK}`);
      expect(arg).toEqual({ name: SECRET_MASK, [SECRET_MASK]: 'x' });
    });

    it('passes an Error argument as its class only, never its text', () => {
      const view = (
        provider as unknown as {
          maskedView(s: ReturnType<typeof createMaskedLogSinks>): {
            logger: { warn(m: string, ...a: unknown[]): void };
          };
        }
      ).maskedView(createMaskedLogSinks(logSpies, maskSecrets));

      // A SHORT secret inside a sentence: the substring arm cannot find it, so
      // any rendering of the text would leak it.
      view.logger.warn('failed', new TypeError(`denied on ${SHORT} and ${LONG}`));

      expect(logSpies.warn.mock.calls[0]![1]).toBe('TypeError');
    });

    it('does not leak one operation masker into a concurrent unmasked one on the same instance, in either start order', async () => {
      // The UNMASKED operation names a value that IS in the bag (`SHORT_ID`),
      // so a masker leaking into it would visibly mask it; the masked one names
      // `SHORT`, so an identity leaking into it would visibly print it.
      const tagged = { Tags: [{ Key: 'k', Value: 'v' }] };
      const masked = (): Promise<unknown> =>
        provider.create('Masked', RESOURCE_TYPE, { BucketName: SHORT, ...tagged }, { maskSecrets });
      const plain = (): Promise<unknown> =>
        provider.create('Plain', RESOURCE_TYPE, { BucketName: SHORT_ID, ...tagged });

      for (const order of [[plain, masked], [masked, plain]]) {
        for (const spy of Object.values(logSpies)) spy.mockClear();
        await Promise.all(order.map((start) => start()));

        const text = transcript();
        expect(names(text, SHORT)).toBe(false);
        expect(text).toContain(`Applied 1 tags to bucket ${SHORT_ID}`);
      }

      // Nothing was cached on the singleton: it carries no masker, a later
      // unmasked operation prints in plaintext, and a later masked one with a
      // DIFFERENT masker masks by that one.
      expect((provider as unknown as { opMask: unknown }).opMask).toBeUndefined();
      for (const spy of Object.values(logSpies)) spy.mockClear();
      await provider.create('After', RESOURCE_TYPE, { BucketName: SHORT });
      expect(transcript()).toContain(`Created S3 bucket: ${SHORT}`);
      for (const spy of Object.values(logSpies)) spy.mockClear();
      await provider.create('Other', RESOURCE_TYPE, { BucketName: 'x7y' }, {
        maskSecrets: createSecretMasker(bagOf('x7y')),
      });
      expect(transcript()).toContain(`Created S3 bucket: ${SECRET_MASK}`);
    });
  });
});
