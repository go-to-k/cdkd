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

  it('lifts ElastiCache CacheCluster UPDATE to 60 min: a node-type scale is an in-place update (#5438)', () => {
    expect(slowCcOperationTimeoutMs('AWS::ElastiCache::CacheCluster', 'UPDATE')).toBe(HOUR_MS);
  });

  it('lifts DynamoDB Table / GlobalTable UPDATE only: the TTL rate-limit wait (#5451)', () => {
    for (const type of ['AWS::DynamoDB::Table', 'AWS::DynamoDB::GlobalTable']) {
      expect(slowCcOperationTimeoutMs(type, 'UPDATE')).toBe(HOUR_MS);
      expect(slowCcOperationTimeoutMs(type, 'CREATE')).toBe(0);
      expect(slowCcOperationTimeoutMs(type, 'DELETE')).toBe(0);
    }
  });

  it('does not lift UPDATE for the cluster types that only declare create/delete', () => {
    // Only the domain types and the ElastiCache CacheCluster (#5438) declare
    // an update floor; another cluster UPDATE falls
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
