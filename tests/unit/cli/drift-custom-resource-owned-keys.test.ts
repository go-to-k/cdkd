import { describe, it, expect } from 'vite-plus/test';
import { customResourceOwnedDriftKeys } from '../../../src/cli/commands/drift.js';
import type { ResourceState } from '../../../src/types/state.js';

/**
 * go-to-k/cdkd#5736: a bucket's `NotificationConfiguration` that CDK's
 * `Custom::S3BucketNotifications` writes is not compared by `cdkd drift`, since
 * the bucket's observed baseline is captured before the custom resource runs.
 */
const record = (
  resourceType: string,
  physicalId: string,
  properties: unknown
): ResourceState =>
  ({ resourceType, physicalId, properties, dependencies: [] }) as unknown as ResourceState;

const bucket = (name: string, properties: unknown = { BucketName: name }): ResourceState =>
  record('AWS::S3::Bucket', name, properties);
const notifications = (bucketName: unknown): ResourceState =>
  record('Custom::S3BucketNotifications', 'notif', {
    ServiceToken: 'arn:aws:lambda:us-east-1:123456789012:function:h',
    BucketName: bucketName,
    Managed: true,
  });

describe('customResourceOwnedDriftKeys (go-to-k/cdkd#5736)', () => {
  it('names the targeted bucket only', () => {
    const owned = customResourceOwnedDriftKeys({
      A: bucket('bucket-a'),
      B: bucket('bucket-b'),
      ANotifications: notifications('bucket-a'),
    });
    expect([...owned.entries()]).toEqual([['A', ['NotificationConfiguration']]]);
  });

  it('names nothing without a custom resource', () => {
    expect(customResourceOwnedDriftKeys({ A: bucket('bucket-a') }).size).toBe(0);
  });

  it('keeps comparing a key the bucket declares', () => {
    const owned = customResourceOwnedDriftKeys({
      A: bucket('bucket-a', { NotificationConfiguration: { EventBridgeConfiguration: {} } }),
      ANotifications: notifications('bucket-a'),
    });
    expect(owned.size).toBe(0);
  });

  it.each([
    ['an unresolved Ref', { Ref: 'A' }],
    ['an empty string', ''],
    ['no value', undefined],
  ])('a custom resource whose BucketName is %s owns nothing', (_l, bucketName) => {
    const owned = customResourceOwnedDriftKeys({
      A: bucket('bucket-a'),
      ANotifications: notifications(bucketName),
    });
    expect(owned.size).toBe(0);
  });

  it('ignores a record whose properties are not a plain object', () => {
    const owned = customResourceOwnedDriftKeys({
      A: bucket('bucket-a', null),
      B: bucket('bucket-b', ['x']),
      Torn: record('Custom::S3BucketNotifications', 'n', 'bucket-b'),
      ANotifications: notifications('bucket-a'),
    });
    expect(owned.size).toBe(0);
  });

  it('ignores a custom resource whose properties are an array carrying BucketName', () => {
    const owned = customResourceOwnedDriftKeys({
      A: bucket('bucket-a'),
      ANotifications: record(
        'Custom::S3BucketNotifications',
        'n',
        Object.assign(['x'], { BucketName: 'bucket-a' })
      ),
    });
    expect(owned.size).toBe(0);
  });

  it('does not match another resource type that shares the name', () => {
    const owned = customResourceOwnedDriftKeys({
      Q: record('AWS::SQS::Queue', 'bucket-a', {}),
      ANotifications: notifications('bucket-a'),
    });
    expect(owned.size).toBe(0);
  });
});
