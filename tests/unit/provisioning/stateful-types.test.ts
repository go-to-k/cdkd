/**
 * Unit tests for the #615 stateful-resource guard list + the
 * conditional-stateful predicate that distinguishes empty / no-retention
 * resources from data-bearing ones.
 */

import { describe, it, expect } from 'vite-plus/test';
import {
  STATEFUL_TYPES,
  isStatefulRecreateTargetSync,
  renderStatefulReason,
} from '../../../src/provisioning/stateful-types.js';

describe('STATEFUL_TYPES (#615)', () => {
  it('includes the data-bearing primary types from the design doc', () => {
    // Spot-check the categories — full list is hand-curated in the
    // source. We just confirm a representative from each category
    // (DB / filesystem / streaming / search / identity / metadata /
    // logs / edge) is present so a future PR that accidentally drops
    // one will fail this test.
    expect(STATEFUL_TYPES.has('AWS::RDS::DBInstance')).toBe(true);
    expect(STATEFUL_TYPES.has('AWS::DynamoDB::Table')).toBe(true);
    expect(STATEFUL_TYPES.has('AWS::EFS::FileSystem')).toBe(true);
    expect(STATEFUL_TYPES.has('AWS::S3::Bucket')).toBe(true);
    expect(STATEFUL_TYPES.has('AWS::ECR::Repository')).toBe(true);
    expect(STATEFUL_TYPES.has('AWS::Kinesis::Stream')).toBe(true);
    // Note canonical CFn casing: 'Elasticsearch' (lowercase 's') —
    // matches `cloudformation:DescribeType AWS::Elasticsearch::Domain`.
    // A camelcased typo `AWS::ElasticSearch::Domain` would silently
    // bypass the guard, so this assertion is load-bearing.
    expect(STATEFUL_TYPES.has('AWS::Elasticsearch::Domain')).toBe(true);
    expect(STATEFUL_TYPES.has('AWS::ElasticSearch::Domain')).toBe(false);
    expect(STATEFUL_TYPES.has('AWS::OpenSearchService::Domain')).toBe(true);
    expect(STATEFUL_TYPES.has('AWS::Cognito::UserPool')).toBe(true);
    expect(STATEFUL_TYPES.has('AWS::SecretsManager::Secret')).toBe(true);
    expect(STATEFUL_TYPES.has('AWS::SSM::Parameter')).toBe(true);
    expect(STATEFUL_TYPES.has('AWS::Glue::Database')).toBe(true);
    expect(STATEFUL_TYPES.has('AWS::Logs::LogGroup')).toBe(true);
    expect(STATEFUL_TYPES.has('AWS::CloudFront::Distribution')).toBe(true);
  });

  it('excludes ephemeral types where destroy+recreate loses no user data', () => {
    expect(STATEFUL_TYPES.has('AWS::Lambda::Function')).toBe(false);
    expect(STATEFUL_TYPES.has('AWS::IAM::Role')).toBe(false);
    expect(STATEFUL_TYPES.has('AWS::IAM::Policy')).toBe(false);
    expect(STATEFUL_TYPES.has('AWS::SQS::Queue')).toBe(false);
    expect(STATEFUL_TYPES.has('AWS::SNS::Topic')).toBe(false);
    // EC2::Instance not on the list — boot disk is ephemeral by default and
    // the user is responsible for EBS / snapshot lifecycle if they want
    // persistence. Could be argued either way; current design says "no."
    expect(STATEFUL_TYPES.has('AWS::EC2::Instance')).toBe(false);
  });
});

describe('isStatefulRecreateTargetSync (#615)', () => {
  it('returns "always" for unconditional stateful types regardless of properties', () => {
    expect(isStatefulRecreateTargetSync('AWS::DynamoDB::Table', {})).toBe('always');
    expect(isStatefulRecreateTargetSync('AWS::RDS::DBInstance', undefined)).toBe('always');
    expect(isStatefulRecreateTargetSync('AWS::Cognito::UserPool', { UserPoolName: 'x' })).toBe(
      'always'
    );
  });

  it('returns null for ephemeral types', () => {
    expect(isStatefulRecreateTargetSync('AWS::Lambda::Function', {})).toBe(null);
    expect(isStatefulRecreateTargetSync('AWS::IAM::Role', { RoleName: 'foo' })).toBe(null);
    expect(isStatefulRecreateTargetSync('AWS::Unknown::Thing', {})).toBe(null);
  });

  describe('AWS::Logs::LogGroup conditional', () => {
    it('returns "has-retention" when RetentionInDays > 0', () => {
      expect(
        isStatefulRecreateTargetSync('AWS::Logs::LogGroup', { RetentionInDays: 7 })
      ).toBe('has-retention');
      expect(
        isStatefulRecreateTargetSync('AWS::Logs::LogGroup', { RetentionInDays: 365 })
      ).toBe('has-retention');
    });

    it('returns null when RetentionInDays is 0 or absent', () => {
      // RetentionInDays=0 is "infinite" in CFn semantics — but it's also
      // a clean "no retention configured" sentinel for the guard's purposes
      // (the test below covers infinite separately).
      // Actually 0 is reserved in CFn; the documented values are 1, 3, ...
      // — 0 should be treated as "absent" for our guard.
      expect(isStatefulRecreateTargetSync('AWS::Logs::LogGroup', {})).toBe(null);
      expect(
        isStatefulRecreateTargetSync('AWS::Logs::LogGroup', { LogGroupName: 'x' })
      ).toBe(null);
      expect(
        isStatefulRecreateTargetSync('AWS::Logs::LogGroup', { RetentionInDays: 0 })
      ).toBe(null);
    });

    it('returns null when properties is undefined', () => {
      expect(isStatefulRecreateTargetSync('AWS::Logs::LogGroup', undefined)).toBe(null);
    });
  });

  describe('AWS::S3::Bucket conditional', () => {
    it('returns null at sync time — the live ListObjectsV2 probe runs in the deploy engine', () => {
      // The sync map intentionally defers S3. A caller that only has the
      // map gets `null` and is expected to call the async probe before
      // deciding to block the recreate.
      expect(isStatefulRecreateTargetSync('AWS::S3::Bucket', { BucketName: 'foo' })).toBe(null);
      expect(isStatefulRecreateTargetSync('AWS::S3::Bucket', undefined)).toBe(null);
    });
  });
});

describe('renderStatefulReason', () => {
  it('produces user-readable strings for each reason', () => {
    expect(renderStatefulReason('always')).toMatch(/destroy loses all data/);
    expect(renderStatefulReason('has-objects')).toMatch(/non-empty/);
    expect(renderStatefulReason('has-retention')).toMatch(/retains data/);
    expect(renderStatefulReason(null)).toBe('(not stateful)');
  });
});
