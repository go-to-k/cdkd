import { describe, it, expect, vi } from 'vite-plus/test';
import {
  GetBucketLifecycleConfigurationCommand,
  PutBucketLifecycleConfigurationCommand,
  type LifecycleRule,
  type S3Client,
} from '@aws-sdk/client-s3';
import {
  applyAbortIncompleteMultipartUpload,
  ABORT_INCOMPLETE_MULTIPART_LIFECYCLE_RULE_ID,
} from '../../../src/assets/asset-storage/lifecycle.js';

// Issue #6185: the asset bucket aborts incomplete multipart uploads after 1 day.
// PutBucketLifecycleConfiguration REPLACES the configuration, so the properties
// are: user rules survive, a present rule means no PUT, a failed read means no PUT.

const BUCKET = 'cdkd-assets-123456789012-us-east-1';
const OUR_RULE: LifecycleRule = {
  ID: ABORT_INCOMPLETE_MULTIPART_LIFECYCLE_RULE_ID,
  Status: 'Enabled',
  Filter: { Prefix: '' },
  AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
};
const USER_RULE: LifecycleRule = {
  ID: 'user-logs',
  Status: 'Enabled',
  Filter: { Prefix: 'logs/' },
  Expiration: { Days: 30 },
};

function s3With(rules: LifecycleRule[] | 'none' | Error, minSize?: string) {
  const puts: PutBucketLifecycleConfigurationCommand[] = [];
  const send = vi.fn(async (cmd: unknown) => {
    if (cmd instanceof GetBucketLifecycleConfigurationCommand) {
      if (rules === 'none') throw Object.assign(new Error('x'), { name: 'NoSuchLifecycleConfiguration' });
      if (rules instanceof Error) throw rules;
      return { Rules: rules, TransitionDefaultMinimumObjectSize: minSize };
    }
    puts.push(cmd as PutBucketLifecycleConfigurationCommand);
    return {};
  });
  return { s3: { send } as unknown as S3Client, puts };
}

describe('applyAbortIncompleteMultipartUpload (#6185)', () => {
  it('creates the rule on a bucket with no configuration', async () => {
    const { s3, puts } = s3With('none');
    expect(await applyAbortIncompleteMultipartUpload(s3, BUCKET, { expectedBucketOwner: '1' })).toEqual({
      status: 'added',
    });
    expect(puts).toHaveLength(1);
    expect(puts[0].input.LifecycleConfiguration?.Rules).toEqual([OUR_RULE]);
    expect(puts[0].input.ExpectedBucketOwner).toBe('1');
  });

  it('keeps every existing rule and passes TransitionDefaultMinimumObjectSize through', async () => {
    const { s3, puts } = s3With([USER_RULE], 'all_storage_classes_128K');
    expect((await applyAbortIncompleteMultipartUpload(s3, BUCKET)).status).toBe('added');
    expect(puts[0].input.LifecycleConfiguration?.Rules).toEqual([USER_RULE, OUR_RULE]);
    expect(puts[0].input.TransitionDefaultMinimumObjectSize).toBe('all_storage_classes_128K');
  });

  it('uses the legacy Prefix form when an existing rule does', async () => {
    const legacy: LifecycleRule = { ID: 'old', Status: 'Enabled', Prefix: 'a/', Expiration: { Days: 3 } };
    const { s3, puts } = s3With([legacy]);
    await applyAbortIncompleteMultipartUpload(s3, BUCKET);
    const added = puts[0].input.LifecycleConfiguration?.Rules?.[1];
    expect(added?.Prefix).toBe('');
    expect(added?.Filter).toBeUndefined();
  });

  it('is idempotent: a present rule (even edited) sends no PUT', async () => {
    const edited = { ...OUR_RULE, AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 } };
    const { s3, puts } = s3With([USER_RULE, edited]);
    expect(await applyAbortIncompleteMultipartUpload(s3, BUCKET)).toEqual({ status: 'present' });
    expect(puts).toHaveLength(0);
  });

  it('does not duplicate the rule across two runs', async () => {
    let stored: LifecycleRule[] = [USER_RULE];
    const send = vi.fn(async (cmd: unknown) => {
      if (cmd instanceof GetBucketLifecycleConfigurationCommand) return { Rules: stored };
      stored = (cmd as PutBucketLifecycleConfigurationCommand).input.LifecycleConfiguration!.Rules!;
      return {};
    });
    const s3 = { send } as unknown as S3Client;
    await applyAbortIncompleteMultipartUpload(s3, BUCKET);
    await applyAbortIncompleteMultipartUpload(s3, BUCKET);
    expect(stored.filter((r) => r.ID === ABORT_INCOMPLETE_MULTIPART_LIFECYCLE_RULE_ID)).toHaveLength(1);
    expect(stored).toHaveLength(2);
  });

  it('never writes when the read failed, and reports accessDenied', async () => {
    const { s3, puts } = s3With(Object.assign(new Error('denied'), { name: 'AccessDenied' }));
    const out = await applyAbortIncompleteMultipartUpload(s3, BUCKET);
    expect(out).toMatchObject({ status: 'failed', accessDenied: true });
    expect(puts).toHaveLength(0);
  });

  it('reports a failed PUT without throwing', async () => {
    const send = vi.fn(async (cmd: unknown) => {
      if (cmd instanceof GetBucketLifecycleConfigurationCommand) return { Rules: [] };
      throw Object.assign(new Error('bad'), { name: 'InvalidRequest' });
    });
    const out = await applyAbortIncompleteMultipartUpload({ send } as unknown as S3Client, BUCKET);
    expect(out).toMatchObject({ status: 'failed', accessDenied: false });
  });
});
