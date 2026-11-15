/**
 * go-to-k/cdkd#6337: the producer-secret check a cdkd-built cross-stack
 * resolver carries beside cdk-local's `CrossStackResolver` contract.
 */
import { describe, expect, it } from 'vite-plus/test';
import {
  holdsNeedle,
  producerSecretCheckOf,
  producerSecretNeedles,
  ProducerSecretLedger,
} from '../../../src/local/cross-stack-secrets.js';

describe('producerSecretNeedles', () => {
  it('collects id segments and secret attribute leaves, not the mask or a reference', () => {
    const needles = producerSecretNeedles({
      resources: {
        ApiKey: {
          resourceType: 'AWS::AppSync::ApiKey',
          physicalId: 'apiid|da2-key-segment',
          attributes: { ApiKey: 'da2-key-segment', Arn: 'arn:aws:appsync:::apis/apiid' },
        },
        Key: {
          resourceType: 'AWS::IAM::AccessKey',
          physicalId: 'AKIAEXAMPLE',
          attributes: { SecretAccessKey: 'secret-access-key-value' },
        },
        Db: {
          resourceType: 'Custom::Thing',
          physicalId: 'db',
          attributes: {
            Password: '***',
            Token: '{{resolve:secretsmanager:s}}',
            ClientSecret: { Nested: ['nested-secret-value'] },
            SecretArn: 'arn:aws:secretsmanager:::secret:x',
          },
        },
        Bucket: { resourceType: 'AWS::S3::Bucket', physicalId: 'b', attributes: { Arn: 'a' } },
      },
    });
    expect(new Set(needles)).toEqual(
      new Set(['da2-key-segment', 'secret-access-key-value', 'nested-secret-value'])
    );
  });

  it('reads a malformed state as holding nothing', () => {
    expect(producerSecretNeedles(null)).toEqual([]);
    expect(producerSecretNeedles({ resources: [] })).toEqual([]);
    expect(producerSecretNeedles({ resources: { A: { attributes: 'x' } } })).toEqual([]);
  });
});

describe('holdsNeedle', () => {
  it('matches a needle whole, or inside a value from four characters', () => {
    expect(holdsNeedle('abc', ['abc'])).toBe(true);
    expect(holdsNeedle('x-abc-y', ['abc'])).toBe(false);
    expect(holdsNeedle('x-abcd-y', ['abcd'])).toBe(true);
    expect(holdsNeedle('other', ['abcd'])).toBe(false);
  });
});

describe('producerSecretCheckOf', () => {
  it('reads the check off a resolver that carries it, and nothing off one that does not', () => {
    const ledger = new ProducerSecretLedger();
    ledger.noteProducerState({
      resources: { K: { resourceType: 'AWS::AppSync::ApiKey', physicalId: 'a|da2-secretkey' } },
    });
    const resolver = {
      resolveImport: async () => undefined,
      resolveGetStackOutput: async () => undefined,
      producerSecretReason: (v: string) => ledger.producerSecretReason(v),
    };
    expect(producerSecretCheckOf(resolver)?.producerSecretReason('da2-secretkey')).toMatch(
      /holding a secret of the producer stack/
    );
    expect(producerSecretCheckOf(resolver)?.producerSecretReason('public')).toBeUndefined();
    expect(
      producerSecretCheckOf({
        resolveImport: async () => undefined,
        resolveGetStackOutput: async () => undefined,
      })
    ).toBeUndefined();
    expect(producerSecretCheckOf(undefined)).toBeUndefined();
  });
});
