import { describe, it, expect } from 'vite-plus/test';
import { undeclaredUncomparedDriftKeys } from '../../../src/cli/commands/drift.js';

/**
 * go-to-k/cdkd#5736 / #5741: a bucket's `NotificationConfiguration` that the
 * template does not declare is written by a custom resource (CDK's
 * `Custom::S3BucketNotifications`) that can live in the same stack, another
 * stack, or outside cdkd. `cdkd drift` never compares it, so `--revert` can
 * never delete another writer's notifications.
 */
describe('undeclaredUncomparedDriftKeys (go-to-k/cdkd#5736, #5741, #6323)', () => {
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

  // go-to-k/cdkd#6323: a sibling AWS::Events::EventBusPolicy writes the bus's
  // policy; the bus's own baseline goes stale on its next update.
  it('skips an undeclared event bus Policy', () => {
    expect(undeclaredUncomparedDriftKeys('AWS::Events::EventBus', { Name: 'bus' })).toEqual([
      'Policy',
    ]);
    expect(undeclaredUncomparedDriftKeys('AWS::Events::EventBus', {})).toEqual(['Policy']);
  });

  it('keeps comparing a Policy the event bus declares', () => {
    expect(
      undeclaredUncomparedDriftKeys('AWS::Events::EventBus', {
        Name: 'bus',
        Policy: { Version: '2012-10-17', Statement: [] },
      })
    ).toEqual([]);
  });

  it.each([
    ['AWS::Events::EventBusPolicy'],
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
