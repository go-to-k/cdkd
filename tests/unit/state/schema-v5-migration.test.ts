import { describe, it, expect } from 'vite-plus/test';
import {
  STATE_SCHEMA_VERSION_CURRENT,
  STATE_SCHEMA_VERSIONS_READABLE,
  type ResourceState,
} from '../../../src/types/state.js';

describe('State schema v5 — DeletionPolicy / UpdateReplacePolicy attribute fields', () => {
  it('current schema version is 5', () => {
    expect(STATE_SCHEMA_VERSION_CURRENT).toBe(5);
  });

  it('readers accept every prior version + v5', () => {
    expect(STATE_SCHEMA_VERSIONS_READABLE).toContain(1);
    expect(STATE_SCHEMA_VERSIONS_READABLE).toContain(2);
    expect(STATE_SCHEMA_VERSIONS_READABLE).toContain(3);
    expect(STATE_SCHEMA_VERSIONS_READABLE).toContain(4);
    expect(STATE_SCHEMA_VERSIONS_READABLE).toContain(5);
  });

  it('ResourceState.deletionPolicy / updateReplacePolicy are optional', () => {
    const minimal: ResourceState = {
      physicalId: 'arn:aws:s3:::my-bucket',
      resourceType: 'AWS::S3::Bucket',
      properties: {},
    };
    expect(minimal.deletionPolicy).toBeUndefined();
    expect(minimal.updateReplacePolicy).toBeUndefined();
  });

  it('ResourceState round-trips deletionPolicy / updateReplacePolicy through JSON', () => {
    const resource: ResourceState = {
      physicalId: 'my-table',
      resourceType: 'AWS::DynamoDB::GlobalTable',
      properties: {},
      deletionPolicy: 'Retain',
      updateReplacePolicy: 'Retain',
    };

    const round = JSON.parse(JSON.stringify(resource)) as ResourceState;
    expect(round.deletionPolicy).toBe('Retain');
    expect(round.updateReplacePolicy).toBe('Retain');
  });

  it('JSON.stringify omits undefined attribute fields (v4 state stays v4-shaped on serialize)', () => {
    const v4ish: ResourceState = {
      physicalId: 'x',
      resourceType: 'AWS::S3::Bucket',
      properties: {},
      deletionPolicy: undefined,
      updateReplacePolicy: undefined,
    };
    const serialized = JSON.stringify(v4ish);
    expect(serialized).not.toContain('deletionPolicy');
    expect(serialized).not.toContain('updateReplacePolicy');
  });
});
