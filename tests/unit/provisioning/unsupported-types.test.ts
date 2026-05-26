import { describe, it, expect } from 'vite-plus/test';
import { CloudControlProvider } from '../../../src/provisioning/cloud-control-provider.js';
import {
  NON_PROVISIONABLE_TYPES,
  isNonProvisionable,
  unsupportedTypeIssueUrl,
} from '../../../src/provisioning/unsupported-types.js';

describe('unsupported-types helpers', () => {
  it('NON_PROVISIONABLE_TYPES is non-empty and contains known tier3 types', () => {
    expect(NON_PROVISIONABLE_TYPES.size).toBeGreaterThan(0);
    expect(NON_PROVISIONABLE_TYPES.has('AWS::AppMesh::Mesh')).toBe(true);
    expect(NON_PROVISIONABLE_TYPES.has('AWS::CloudFormation::WaitCondition')).toBe(true);
  });

  it('isNonProvisionable mirrors the generated set', () => {
    expect(isNonProvisionable('AWS::AppMesh::Mesh')).toBe(true);
    expect(isNonProvisionable('AWS::S3::Bucket')).toBe(false);
  });

  it('unsupportedTypeIssueUrl builds a 1-click pre-filled issue link', () => {
    const url = unsupportedTypeIssueUrl('AWS::Foo::Bar');
    expect(url).toContain('https://github.com/go-to-k/cdkd/issues/new');
    expect(url).toContain('labels=resource-support');
    // The resource type is URL-encoded into the title.
    expect(url).toContain(encodeURIComponent('AWS::Foo::Bar'));
  });
});

describe('CloudControlProvider.isSupportedResourceType (tier3-grounded)', () => {
  const isCC = (t: string) => CloudControlProvider.isSupportedResourceType(t);

  it('rejects NON_PROVISIONABLE (tier3) types so pre-flight fails fast', () => {
    expect(isCC('AWS::AppMesh::Mesh')).toBe(false);
    expect(isCC('AWS::CloudFormation::WaitConditionHandle')).toBe(false);
  });

  it('still accepts ordinary AWS:: types via the optimistic fallthrough', () => {
    expect(isCC('AWS::S3::Bucket')).toBe(true);
    expect(isCC('AWS::SomeBrandNew::Type')).toBe(true);
  });

  it('still rejects custom resources and non-AWS namespaces', () => {
    expect(isCC('Custom::MyThing')).toBe(false);
    expect(isCC('AWS::CloudFormation::CustomResource')).toBe(false);
    expect(isCC('Alexa::ASK::Skill')).toBe(false);
  });
});
