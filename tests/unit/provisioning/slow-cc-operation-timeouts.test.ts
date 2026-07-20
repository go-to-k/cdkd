import { describe, it, expect } from 'vite-plus/test';
import { slowCcOperationTimeoutMs } from '../../../src/provisioning/slow-cc-operation-timeouts.js';

describe('slowCcOperationTimeoutMs', () => {
  const HOUR_MS = 60 * 60 * 1000;

  it('returns 0 for a type with no special requirement (generic default applies)', () => {
    expect(slowCcOperationTimeoutMs('AWS::SNS::Topic', 'DELETE')).toBe(0);
    expect(slowCcOperationTimeoutMs('AWS::S3::Bucket', 'CREATE')).toBe(0);
    expect(slowCcOperationTimeoutMs('AWS::Logs::LogGroup', 'UPDATE')).toBe(0);
  });

  it('lifts OpenSearch domain CREATE / UPDATE / DELETE to 60 min (the observed slow case)', () => {
    expect(slowCcOperationTimeoutMs('AWS::OpenSearchService::Domain', 'CREATE')).toBe(HOUR_MS);
    expect(slowCcOperationTimeoutMs('AWS::OpenSearchService::Domain', 'UPDATE')).toBe(HOUR_MS);
    expect(slowCcOperationTimeoutMs('AWS::OpenSearchService::Domain', 'DELETE')).toBe(HOUR_MS);
  });

  it('lifts the legacy Elasticsearch domain type the same way', () => {
    expect(slowCcOperationTimeoutMs('AWS::Elasticsearch::Domain', 'DELETE')).toBe(HOUR_MS);
  });

  it('lifts Redshift / ElastiCache / RDS CREATE + DELETE', () => {
    for (const type of [
      'AWS::Redshift::Cluster',
      'AWS::ElastiCache::ReplicationGroup',
      'AWS::ElastiCache::CacheCluster',
      'AWS::RDS::DBInstance',
      'AWS::RDS::DBCluster',
    ]) {
      expect(slowCcOperationTimeoutMs(type, 'CREATE')).toBe(HOUR_MS);
      expect(slowCcOperationTimeoutMs(type, 'DELETE')).toBe(HOUR_MS);
    }
  });

  it('does not lift UPDATE for the cluster types that only declare create/delete', () => {
    // Only the domain types declare an update floor; a cluster UPDATE falls
    // back to the generic default (0), so an in-place cluster modify is not
    // silently given an hour.
    expect(slowCcOperationTimeoutMs('AWS::Redshift::Cluster', 'UPDATE')).toBe(0);
    expect(slowCcOperationTimeoutMs('AWS::RDS::DBInstance', 'UPDATE')).toBe(0);
    expect(slowCcOperationTimeoutMs('AWS::ElastiCache::ReplicationGroup', 'UPDATE')).toBe(0);
  });

  it('is safe to use as a Math.max term (never negative, never shrinks a budget)', () => {
    const DEFAULT = 15 * 60 * 1000;
    // A slow type grows the budget; a normal type leaves it untouched.
    expect(Math.max(DEFAULT, slowCcOperationTimeoutMs('AWS::OpenSearchService::Domain', 'DELETE'))).toBe(
      HOUR_MS
    );
    expect(Math.max(DEFAULT, slowCcOperationTimeoutMs('AWS::SNS::Topic', 'DELETE'))).toBe(DEFAULT);
  });
});
