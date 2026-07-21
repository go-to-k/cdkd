import { describe, expect, it } from 'vite-plus/test';
import { countDeployableResources } from '../../../src/cli/commands/synth.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';

describe('countDeployableResources', () => {
  it('excludes AWS::CDK::Metadata from the count', () => {
    const template: CloudFormationTemplate = {
      Resources: {
        HistoryTable24A0CCCB: { Type: 'AWS::DynamoDB::GlobalTable', Properties: {} },
        CDKMetadata: { Type: 'AWS::CDK::Metadata', Properties: { Analytics: 'v2:deflate64:...' } },
      },
    };

    expect(countDeployableResources(template)).toBe(1);
  });

  it('returns 0 when only AWS::CDK::Metadata is present', () => {
    const template: CloudFormationTemplate = {
      Resources: {
        CDKMetadata: { Type: 'AWS::CDK::Metadata', Properties: {} },
      },
    };

    expect(countDeployableResources(template)).toBe(0);
  });

  it('returns 0 for an empty Resources map', () => {
    expect(countDeployableResources({ Resources: {} })).toBe(0);
  });

  it('counts every non-CDK-Metadata resource', () => {
    const template: CloudFormationTemplate = {
      Resources: {
        Bucket: { Type: 'AWS::S3::Bucket', Properties: {} },
        Table: { Type: 'AWS::DynamoDB::Table', Properties: {} },
        Fn: { Type: 'AWS::Lambda::Function', Properties: {} },
        CDKMetadata: { Type: 'AWS::CDK::Metadata', Properties: {} },
      },
    };

    expect(countDeployableResources(template)).toBe(3);
  });
});
