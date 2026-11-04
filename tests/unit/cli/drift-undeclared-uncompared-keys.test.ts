import { describe, it, expect } from 'vite-plus/test';
import { undeclaredUncomparedDriftKeys } from '../../../src/cli/commands/drift.js';

/**
 * go-to-k/cdkd#5736 / #5741: a bucket's `NotificationConfiguration` that the
 * template does not declare is written by a custom resource (CDK's
 * `Custom::S3BucketNotifications`) that can live in the same stack, another
 * stack, or outside cdkd. `cdkd drift` never compares it, so `--revert` can
 * never delete another writer's notifications.
 */
describe('undeclaredUncomparedDriftKeys (go-to-k/cdkd#5736, #5741)', () => {
  it('skips an undeclared bucket NotificationConfiguration', () => {
    expect(undeclaredUncomparedDriftKeys('AWS::S3::Bucket', { BucketName: 'b' })).toEqual([
      'NotificationConfiguration',
    ]);
    expect(undeclaredUncomparedDriftKeys('AWS::S3::Bucket', {})).toEqual([
      'NotificationConfiguration',
    ]);
  });

  it('keeps comparing a NotificationConfiguration the bucket declares', () => {
    expect(
      undeclaredUncomparedDriftKeys('AWS::S3::Bucket', {
        NotificationConfiguration: { EventBridgeConfiguration: {} },
      })
    ).toEqual([]);
  });

  it('treats a declared-but-undefined key as declared (own key present)', () => {
    expect(
      undeclaredUncomparedDriftKeys('AWS::S3::Bucket', { NotificationConfiguration: undefined })
    ).toEqual([]);
  });

  it.each([
    ['AWS::SQS::Queue'],
    ['Custom::S3BucketNotifications'],
    ['AWS::S3::BucketPolicy'],
    // An inherited Object.prototype member must not read as a table entry.
    ['constructor'],
    ['__proto__'],
  ])('skips nothing on %s', (resourceType) => {
    expect(undeclaredUncomparedDriftKeys(resourceType, {})).toEqual([]);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['an array', ['x']],
    ['a string', 'NotificationConfiguration'],
  ])('skips nothing on a bucket whose properties are %s', (_l, properties) => {
    expect(undeclaredUncomparedDriftKeys('AWS::S3::Bucket', properties)).toEqual([]);
  });

  it('does not read an inherited key as declared', () => {
    const inherited = Object.create({ NotificationConfiguration: {} }) as Record<string, unknown>;
    expect(undeclaredUncomparedDriftKeys('AWS::S3::Bucket', inherited)).toEqual([
      'NotificationConfiguration',
    ]);
  });
});
