/**
 * go-to-k/cdkd#5395 — the top-level `ObjectLockEnabled` of an existing bucket.
 *
 * The flag reaches S3 only through `CreateBucket`. A CloudFormation A/B in
 * us-east-1 (2026-10-27) showed CloudFormation sends nothing on an update
 * either: turning it on ends `UPDATE_COMPLETE` with no Object Lock, and
 * removing it from a locked bucket ends `UPDATE_COMPLETE` with Object Lock
 * still on. cdkd keeps that outcome — no write, the declared value recorded —
 * and warns, once `GetObjectLockConfiguration` confirms S3 still holds the
 * opposite.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const { mockSend, childLogger } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  childLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  },
}));

// CreateBucket goes through its own S3Client (issue #4639); forward it to the
// shared double below.
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
  childLogger.child.mockReturnValue(childLogger);
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
import { createSecretMasker, SECRET_MASK } from '../../../src/deployment/secret-redaction.js';

const RESOURCE_TYPE = 'AWS::S3::Bucket';
const BUCKET = 'locked-bucket-5395';

type LiveLock = 'enabled' | 'absent' | 'read-fails';

function commandName(cmd: unknown): string {
  return (cmd as { constructor: { name: string } }).constructor.name;
}

function answering(live: LiveLock): (cmd: unknown) => Promise<unknown> {
  return (cmd) => {
    const name = commandName(cmd);
    if (name === 'GetBucketLocationCommand') return Promise.resolve({ LocationConstraint: null });
    if (name === 'GetObjectLockConfigurationCommand') {
      if (live === 'enabled') {
        return Promise.resolve({ ObjectLockConfiguration: { ObjectLockEnabled: 'Enabled' } });
      }
      const err = new Error(live === 'absent' ? 'not found' : 'Access Denied');
      err.name = live === 'absent' ? 'ObjectLockConfigurationNotFoundError' : 'AccessDenied';
      return Promise.reject(err);
    }
    return Promise.resolve({});
  };
}

function warnings(): string {
  return childLogger.warn.mock.calls.map((c) => String(c[0])).join('\n---\n');
}

function sent(name: string): unknown[] {
  return mockSend.mock.calls.map((c) => c[0]).filter((cmd) => commandName(cmd) === name);
}

const VERSIONED = { VersioningConfiguration: { Status: 'Enabled' } };

let provider: S3BucketProvider;

beforeEach(() => {
  vi.clearAllMocks();
  childLogger.child.mockReturnValue(childLogger);
  provider = new S3BucketProvider();
});

describe('top-level ObjectLockEnabled turned on for an existing bucket (#5395)', () => {
  it('sends no Object Lock write, warns, and records the declared value', async () => {
    mockSend.mockImplementation(answering('absent'));
    const result = await provider.update(
      'B',
      BUCKET,
      RESOURCE_TYPE,
      { ...VERSIONED, ObjectLockEnabled: true },
      { ...VERSIONED }
    );

    expect(result.wasReplaced).toBe(false);
    expect(sent('PutObjectLockConfigurationCommand')).toHaveLength(0);
    expect(sent('GetObjectLockConfigurationCommand')).toHaveLength(1);
    // The declared value is what state records, as CloudFormation's template does.
    // No override: the engine records the desired bag as declared.
    expect(result.effectiveProperties?.['ObjectLockEnabled']).not.toBe(false);
    expect(result.effectiveProperties).toBeUndefined();
    const logged = warnings();
    expect(logged).toContain('B (AWS::S3::Bucket): ObjectLockEnabled is now true');
    expect(logged).toContain(`Object Lock was NOT enabled on the existing bucket ${BUCKET}`);
    expect(logged).toContain('ObjectLockConfiguration.ObjectLockEnabled: Enabled');
    expect(logged).toContain('must have versioning enabled');
    expect(logged).toContain('cannot be disabled once it is enabled');
  });

  it('accepts the string spelling "true" as CDK can emit it', async () => {
    mockSend.mockImplementation(answering('absent'));
    await provider.update('B', BUCKET, RESOURCE_TYPE, { ObjectLockEnabled: 'true' }, {});
    expect(warnings()).toContain('ObjectLockEnabled is now true');
  });

  it('warns from false as well as from absent', async () => {
    mockSend.mockImplementation(answering('absent'));
    await provider.update(
      'B',
      BUCKET,
      RESOURCE_TYPE,
      { ObjectLockEnabled: true },
      { ObjectLockEnabled: false }
    );
    expect(warnings()).toContain('ObjectLockEnabled is now true');
  });

  it('keeps the warning when the read-back fails, worded as unconfirmed', async () => {
    mockSend.mockImplementation(answering('read-fails'));
    const result = await provider.update(
      'B',
      BUCKET,
      RESOURCE_TYPE,
      { ObjectLockEnabled: true },
      {}
    );
    expect(result.wasReplaced).toBe(false);
    const logged = warnings();
    expect(logged).toContain('ObjectLockEnabled is now true');
    expect(logged).toContain(`nothing was sent to enable Object Lock on the existing bucket ${BUCKET}`);
    expect(logged).toContain('could not be read back, so this is not confirmed');
    expect(logged).not.toContain('was NOT enabled');
    expect(childLogger.debug.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
      '(AccessDenied)'
    );
  });

  it('stays quiet when the bucket already holds Object Lock', async () => {
    mockSend.mockImplementation(answering('enabled'));
    await provider.update('B', BUCKET, RESOURCE_TYPE, { ObjectLockEnabled: true }, {});
    expect(sent('GetObjectLockConfigurationCommand')).toHaveLength(1);
    expect(warnings()).not.toContain('ObjectLockEnabled');
  });

  it('masks a secret-derived bucket name in the warning', async () => {
    const secretName = 's3-5395-secret-bucket-name';
    mockSend.mockImplementation(answering('absent'));
    await provider.update(
      'B',
      secretName,
      RESOURCE_TYPE,
      { BucketName: secretName, ObjectLockEnabled: true },
      { BucketName: secretName },
      { maskSecrets: createSecretMasker(new Map([[secretName, '{{resolve:secretsmanager:s}}']])) }
    );
    const logged = warnings();
    expect(logged).toContain(`Object Lock was NOT enabled on the existing bucket ${SECRET_MASK}`);
    expect(logged).not.toContain(secretName);
  });

  it('stays quiet when the nested block enables it in the same update', async () => {
    // The nested `ObjectLockConfiguration` IS sent (CloudFormation enables it
    // in place too); the read-back then sees it enabled.
    let putSeen = false;
    mockSend.mockImplementation((cmd: unknown) => {
      if (commandName(cmd) === 'PutObjectLockConfigurationCommand') putSeen = true;
      if (commandName(cmd) === 'GetObjectLockConfigurationCommand' && putSeen) {
        return Promise.resolve({ ObjectLockConfiguration: { ObjectLockEnabled: 'Enabled' } });
      }
      return answering('absent')(cmd);
    });
    await provider.update(
      'B',
      BUCKET,
      RESOURCE_TYPE,
      {
        ...VERSIONED,
        ObjectLockEnabled: true,
        ObjectLockConfiguration: { ObjectLockEnabled: 'Enabled' },
      },
      { ...VERSIONED }
    );
    expect(sent('PutObjectLockConfigurationCommand')).toHaveLength(1);
    expect(warnings()).not.toContain('ObjectLockEnabled');
  });

  it('stays quiet when the nested block is sent beside the flag and the read-back fails', async () => {
    mockSend.mockImplementation(answering('read-fails'));
    await provider.update(
      'B',
      BUCKET,
      RESOURCE_TYPE,
      { ...VERSIONED, ObjectLockEnabled: true, ObjectLockConfiguration: { ObjectLockEnabled: 'Enabled' } },
      { ...VERSIONED }
    );
    expect(sent('PutObjectLockConfigurationCommand')).toHaveLength(1);
    expect(warnings()).not.toContain('ObjectLockEnabled');
  });

  it('stays quiet when the flag did not change', async () => {
    mockSend.mockImplementation(answering('absent'));
    await provider.update(
      'B',
      BUCKET,
      RESOURCE_TYPE,
      { ObjectLockEnabled: true, Tags: [{ Key: 'k', Value: 'v' }] },
      { ObjectLockEnabled: true }
    );
    expect(sent('GetObjectLockConfigurationCommand')).toHaveLength(0);
    expect(warnings()).not.toContain('ObjectLockEnabled');
  });
});

describe('top-level ObjectLockEnabled removed from a locked bucket (#5395)', () => {
  it('sends nothing, does not refuse, and warns that Object Lock stays enabled', async () => {
    mockSend.mockImplementation(answering('enabled'));
    const result = await provider.update(
      'B',
      BUCKET,
      RESOURCE_TYPE,
      { ...VERSIONED },
      { ...VERSIONED, ObjectLockEnabled: true }
    );
    expect(result.wasReplaced).toBe(false);
    expect(sent('PutObjectLockConfigurationCommand')).toHaveLength(0);
    const logged = warnings();
    expect(logged).toContain('B (AWS::S3::Bucket): ObjectLockEnabled is no longer true');
    expect(logged).toContain(`S3 cannot disable Object Lock on a bucket, so it stays enabled on bucket ${BUCKET}`);
  });

  it('warns when set to false, and when the read-back fails, worded as unconfirmed', async () => {
    mockSend.mockImplementation(answering('read-fails'));
    await provider.update(
      'B',
      BUCKET,
      RESOURCE_TYPE,
      { ObjectLockEnabled: false },
      { ObjectLockEnabled: true }
    );
    const logged = warnings();
    expect(logged).toContain('ObjectLockEnabled is no longer true');
    expect(logged).toContain(`so if bucket ${BUCKET} has it, it stays enabled`);
    expect(logged).toContain('could not be read back, so this is not confirmed');
    expect(logged).not.toContain('stay protected');
  });

  it.each([
    ['a rollback revert', { replayingState: true }],
    ['a drift revert', { desiredFromAwsReadback: true }],
  ])('says nothing unconfirmed on %s, where the template changed nothing', async (_, context) => {
    mockSend.mockImplementation(answering('read-fails'));
    await provider.update('B', BUCKET, RESOURCE_TYPE, {}, { ObjectLockEnabled: true }, context);
    await provider.update('B', BUCKET, RESOURCE_TYPE, { ObjectLockEnabled: true }, {}, context);
    expect(warnings()).not.toContain('ObjectLockEnabled');
  });

  it('stays quiet on the readback bag of an unlocked bucket (drift revert)', async () => {
    mockSend.mockImplementation(answering('absent'));
    await provider.update(
      'B',
      BUCKET,
      RESOURCE_TYPE,
      { ObjectLockConfiguration: {} },
      { ObjectLockEnabled: true },
      { desiredFromAwsReadback: true }
    );
    expect(sent('GetObjectLockConfigurationCommand')).toHaveLength(1);
    expect(warnings()).not.toContain('ObjectLockEnabled');
  });

  it('stays quiet on the readback bag of a locked bucket (drift revert)', async () => {
    mockSend.mockImplementation(answering('enabled'));
    await provider.update(
      'B',
      BUCKET,
      RESOURCE_TYPE,
      { ObjectLockConfiguration: { ObjectLockEnabled: 'Enabled' } },
      { ObjectLockEnabled: true },
      { desiredFromAwsReadback: true }
    );
    expect(warnings()).not.toContain('ObjectLockEnabled');
  });

  it('stays quiet when the live bucket has no Object Lock (a reverted enable)', async () => {
    mockSend.mockImplementation(answering('absent'));
    await provider.update('B', BUCKET, RESOURCE_TYPE, {}, { ObjectLockEnabled: true }, {
      replayingState: true,
    });
    expect(warnings()).not.toContain('ObjectLockEnabled');
  });

  it('stays quiet while the nested block still declares it', async () => {
    mockSend.mockImplementation(answering('enabled'));
    await provider.update(
      'B',
      BUCKET,
      RESOURCE_TYPE,
      { ObjectLockConfiguration: { ObjectLockEnabled: 'Enabled' } },
      { ObjectLockEnabled: true, ObjectLockConfiguration: { ObjectLockEnabled: 'Enabled' } }
    );
    expect(sent('GetObjectLockConfigurationCommand')).toHaveLength(0);
    expect(warnings()).not.toContain('ObjectLockEnabled');
  });
});

describe('versioning suspend beside a top-level ObjectLockEnabled that was never applied (#5395)', () => {
  function suspends(): unknown[] {
    return sent('PutBucketVersioningCommand').filter(
      (cmd) =>
        (cmd as { input: { VersioningConfiguration?: { Status?: string } } }).input
          .VersioningConfiguration?.Status === 'Suspended'
    );
  }
  const DESIRED = { ObjectLockEnabled: true, VersioningConfiguration: { Status: 'Suspended' } };
  const PREVIOUS = { ObjectLockEnabled: true, VersioningConfiguration: { Status: 'Enabled' } };

  it('suspends when the bucket has no Object Lock, as CloudFormation does', async () => {
    mockSend.mockImplementation(answering('absent'));
    await provider.update('B', BUCKET, RESOURCE_TYPE, DESIRED, PREVIOUS);
    expect(suspends()).toHaveLength(1);
    expect(warnings()).not.toContain('has Object Lock enabled');
  });

  it('skips the suspend and warns when the bucket holds Object Lock', async () => {
    mockSend.mockImplementation(answering('enabled'));
    await provider.update('B', BUCKET, RESOURCE_TYPE, DESIRED, PREVIOUS);
    expect(suspends()).toHaveLength(0);
    expect(warnings()).toContain('has Object Lock enabled');
  });

  it('keeps the conservative skip when the read-back fails, worded as unconfirmed', async () => {
    mockSend.mockImplementation(answering('read-fails'));
    const result = await provider.update('B', BUCKET, RESOURCE_TYPE, DESIRED, PREVIOUS);
    expect(suspends()).toHaveLength(0);
    const logged = warnings();
    expect(logged).toContain('could not be read back to confirm it');
    expect(logged).toContain('versioning is left enabled');
    expect(logged).not.toContain('has Object Lock enabled');
    expect(result.effectiveProperties?.['VersioningConfiguration']).toEqual({ Status: 'Enabled' });
  });

  it('trusts a nested Enabled without a read', async () => {
    mockSend.mockImplementation(answering('absent'));
    await provider.update(
      'B',
      BUCKET,
      RESOURCE_TYPE,
      { VersioningConfiguration: { Status: 'Suspended' } },
      {
        VersioningConfiguration: { Status: 'Enabled' },
        ObjectLockConfiguration: { ObjectLockEnabled: 'Enabled' },
      }
    );
    expect(sent('GetObjectLockConfigurationCommand')).toHaveLength(0);
    expect(suspends()).toHaveLength(0);
    expect(warnings()).toContain('has Object Lock enabled');
  });
});
