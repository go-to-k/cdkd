import { describe, expect, it } from 'vite-plus/test';
import { getAttReadsOf } from '../../../src/deployment/deploy-engine/signal-receiver-run.js';

describe('getAttReadsOf (go-to-k/cdkd#6705 receiver metadata refusal)', () => {
  it('finds GetAtt reads in both spellings and in Fn::Sub, at any depth', () => {
    const metadata = {
      'AWS::CloudFormation::Authentication': {
        S3Auth: {
          accessKeyId: { Ref: 'Key' },
          secretKey: { 'Fn::GetAtt': ['Key', 'SecretAccessKey'] },
        },
      },
      'AWS::CloudFormation::Init': {
        config: {
          files: {
            '/a': { content: { 'Fn::Sub': 'x=${Client.ClientSecret} y=${AWS::Region} z=${Plain}' } },
            '/b': { content: { 'Fn::Sub': ['${Api.ApiKey}', {}] } },
            '/c': { content: { 'Fn::GetAtt': 'Bucket.Arn' } },
          },
        },
      },
    };
    expect(getAttReadsOf(metadata)).toEqual([
      ['Key', 'SecretAccessKey'],
      ['Client', 'ClientSecret'],
      ['Api', 'ApiKey'],
      ['Bucket', 'Arn'],
    ]);
  });

  it('finds nothing in literal metadata', () => {
    expect(getAttReadsOf({ a: ['x', { b: 'Fn::GetAtt' }] })).toEqual([]);
  });
});
