/**
 * `rollbackFinalSnapshotId` (issue #1354): the rollback executor's
 * delete-of-the-NEW-resource honors `UpdateReplacePolicy: Snapshot` for
 * atomic-final-snapshot types on the SDK route (a generated identifier is
 * threaded into the delete context); every other Snapshot shape keeps the
 * plain delete deliberately (see the helper's JSDoc for the scope decision).
 */

import { describe, it, expect } from 'vite-plus/test';
import { rollbackFinalSnapshotId } from '../../../src/deployment/rollback-executor.js';

const base = { physicalId: 'my-db' } as const;

describe('rollbackFinalSnapshotId (#1354)', () => {
  it('returns a generated identifier for an SDK-routed atomic type under Snapshot', () => {
    const id = rollbackFinalSnapshotId('AWS::RDS::DBInstance', {
      ...base,
      updateReplacePolicy: 'Snapshot',
    });
    expect(id).toMatch(/^my-db-final-\d{8}-\d{6}$/);
  });

  it('returns undefined for non-Snapshot policies (both unset and Delete)', () => {
    expect(rollbackFinalSnapshotId('AWS::RDS::DBInstance', { ...base })).toBeUndefined();
    expect(
      rollbackFinalSnapshotId('AWS::RDS::DBInstance', { ...base, updateReplacePolicy: 'Delete' })
    ).toBeUndefined();
  });

  it('returns undefined for cc-api routing (record field or op fallback)', () => {
    expect(
      rollbackFinalSnapshotId('AWS::RDS::DBInstance', {
        ...base,
        updateReplacePolicy: 'Snapshot',
        provisionedBy: 'cc-api',
      })
    ).toBeUndefined();
    expect(
      rollbackFinalSnapshotId(
        'AWS::RDS::DBInstance',
        { ...base, updateReplacePolicy: 'Snapshot' },
        'cc-api'
      )
    ).toBeUndefined();
  });

  it('returns undefined for non-atomic types (pre-delete / unsupported shapes keep the plain delete)', () => {
    expect(
      rollbackFinalSnapshotId('AWS::EC2::Volume', { ...base, updateReplacePolicy: 'Snapshot' })
    ).toBeUndefined();
    expect(
      rollbackFinalSnapshotId('AWS::S3::Bucket', { ...base, updateReplacePolicy: 'Snapshot' })
    ).toBeUndefined();
  });
});
