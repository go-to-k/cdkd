/**
 * go-to-k/cdkd#6337: the producer-secret check a cdkd-built cross-stack
 * resolver carries beside cdk-local's `CrossStackResolver` contract.
 */
import { describe, expect, it } from 'vite-plus/test';
import {
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
            MasterUserSecret: { SecretArn: 'arn:aws:secretsmanager:::secret:db-AbCd' },
          },
        },
        Bucket: { resourceType: 'AWS::S3::Bucket', physicalId: 'b', attributes: { Arn: 'a' } },
      },
    });
    expect(needles.segments).toEqual(['da2-key-segment']);
    // `MasterUserSecret.SecretArn` is an ARN by its dotted name, as the
    // same-stack check reads it.
    expect(new Set(needles.leaves)).toEqual(
      new Set(['da2-key-segment', 'secret-access-key-value', 'nested-secret-value'])
    );
  });

  it('reads a malformed state as holding nothing', () => {
    const none = { segments: [], leaves: [] };
    expect(producerSecretNeedles(null)).toEqual(none);
    expect(producerSecretNeedles({ resources: [] })).toEqual(none);
    expect(producerSecretNeedles({ resources: { A: { attributes: 'x' } } })).toEqual(none);
  });
});

describe('ProducerSecretLedger matching', () => {
  const ledger = new ProducerSecretLedger();
  ledger.noteProducerState({
    resources: {
      K: { resourceType: 'AWS::AppSync::ApiKey', physicalId: 'a|abcd' },
      N: {
        resourceType: 'AWS::CloudFormation::Stack',
        physicalId: 'n',
        attributes: {
          'Outputs.PasswordPolicy': 'strict',
          'Outputs.ClientSecret': 'a-long-client-secret-value',
        },
      },
    },
  });
  it('matches an id segment whole, or inside a value from four characters', () => {
    expect(ledger.producerSecretOf('abcd')).toBe('secret');
    expect(ledger.producerSecretOf('x-abcd-y')).toBe('secret');
  });
  it('matches an attribute leaf whole, and inside a value only from sixteen characters', () => {
    expect(ledger.producerSecretOf('strict')).toBe('secret');
    expect(ledger.producerSecretOf('mode=strict')).toBeUndefined();
    expect(ledger.producerSecretOf('k=a-long-client-secret-value')).toBe('secret');
  });
  it('reports a noted unverified value as such, and nothing else', () => {
    ledger.noteUnverified('maybe');
    expect(ledger.producerSecretOf('maybe')).toBe('unverified');
    expect(ledger.producerSecretOf('other')).toBeUndefined();
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
      producerSecretOf: (v: string) => ledger.producerSecretOf(v),
    };
    expect(producerSecretCheckOf(resolver)?.producerSecretOf('da2-secretkey')).toBe('secret');
    expect(producerSecretCheckOf(resolver)?.producerSecretOf('public')).toBeUndefined();
    expect(
      producerSecretCheckOf({
        resolveImport: async () => undefined,
        resolveGetStackOutput: async () => undefined,
      })
    ).toBeUndefined();
    expect(producerSecretCheckOf(undefined)).toBeUndefined();
  });
});
