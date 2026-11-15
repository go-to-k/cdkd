/**
 * go-to-k/cdkd#6337: the producer-secret check a cdkd-built cross-stack
 * resolver carries beside cdk-local's `CrossStackResolver` contract.
 */
import { describe, expect, it } from 'vite-plus/test';
import {
  producerSecretCheckOf,
  producerSecretNeedles,
  ProducerSecretReader,
  strongerJudgement,
  strongerVerdict,
} from '../../../src/local/cross-stack-secrets.js';

describe('producerSecretNeedles', () => {
  it('collects id segments, typed leaves and long name-judged leaves', () => {
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
            PasswordPolicy: 'strict',
            SecretArn: 'arn:aws:secretsmanager:::secret:x',
            MasterUserSecret: { SecretArn: 'arn:aws:secretsmanager:::secret:db-AbCd' },
          },
        },
        Bucket: { resourceType: 'AWS::S3::Bucket', physicalId: 'b', attributes: { Arn: 'a' } },
      },
    });
    expect(needles.segments).toEqual(['da2-key-segment']);
    expect(needles.typed).toEqual(['da2-key-segment']);
    // `MasterUserSecret.SecretArn` is an ARN by its dotted name, as the
    // same-stack check reads it; `strict` is too short to be a credential.
    expect(new Set(needles.named)).toEqual(
      new Set(['secret-access-key-value', 'nested-secret-value'])
    );
  });

  it('reads a malformed state as holding nothing', () => {
    const none = { segments: [], typed: [], named: [] };
    expect(producerSecretNeedles(null)).toEqual(none);
    expect(producerSecretNeedles({ resources: [] })).toEqual(none);
    expect(producerSecretNeedles({ resources: { A: { attributes: 'x' } } })).toEqual(none);
  });
});

describe('ProducerSecretReader.judge', () => {
  const state = {
    resources: {
      K: { resourceType: 'AWS::AppSync::ApiKey', physicalId: 'a|abcd' },
      S: { resourceType: 'AWS::IVS::StreamKey', physicalId: 's', attributes: { Value: 'wxyz' } },
      N: {
        resourceType: 'Custom::Thing',
        physicalId: 'n',
        attributes: { ClientSecret: 'a-long-client-secret-value', PasswordPolicy: 'strict' },
      },
    },
  };
  const reader = new ProducerSecretReader(
    async () => null,
    () => undefined
  );
  const judge = async (v: string) => (await reader.judge('P', 'us-east-1', state, v))?.verdict;

  it('matches an id segment or a typed leaf whole, or inside a value from four characters', async () => {
    expect(await judge('abcd')).toBe('secret');
    expect(await judge('x-abcd-y')).toBe('secret');
    expect(await judge('k=wxyz')).toBe('secret');
  });

  it('matches a name-judged leaf whole from eight characters, inside only from sixteen', async () => {
    const tenChars = new ProducerSecretReader(
      async () => null,
      () => undefined
    );
    const db = {
      resources: {
        D: {
          resourceType: 'Custom::Thing',
          physicalId: 'd',
          attributes: { DbPassword: 'pw10charsX', Pin: 'x', ApiSecret: 'sevench' },
        },
      },
    };
    expect((await tenChars.judge('P', 'r', db, 'pw10charsX'))?.verdict).toBe('secret');
    expect(await tenChars.judge('P', 'r', db, 'u:pw10charsX@h')).toBeUndefined();
    // Seven characters: no secret, even whole.
    expect(await tenChars.judge('P', 'r', db, 'sevench')).toBeUndefined();
  });

  it('matches a long name-judged leaf whole or inside', async () => {
    expect(await judge('strict')).toBeUndefined();
    expect(await judge('mode=strict')).toBeUndefined();
    expect(await judge('a-long-client-secret-value')).toBe('secret');
    expect(await judge('k=a-long-client-secret-value')).toBe('secret');
    expect(await judge('public')).toBeUndefined();
  });

  it('renders a failed read in the debug line without its raw detail', async () => {
    const lines: string[] = [];
    const failing = new ProducerSecretReader(
      async () => {
        throw new Error('denied \u001b[31mred\u001b[0m');
      },
      (m) => lines.push(m)
    );
    expect(await failing.judgeIndexed('Bad\u001bStack', 'us-east-1', 'E', 'v')).toEqual({
      verdict: 'unreadable',
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/state read failed for /);
    expect(lines[0]).not.toContain('\u001b');
  });
});

describe('strongerVerdict', () => {
  it('ranks secret over the fail-closed verdicts, and either over none', () => {
    expect(strongerVerdict('unreadable', 'secret')).toBe('secret');
    expect(strongerVerdict('secret', 'stale')).toBe('secret');
    expect(strongerVerdict(undefined, 'stale')).toBe('stale');
    expect(strongerVerdict('unreadable', undefined)).toBe('unreadable');
    expect(strongerVerdict(undefined, undefined)).toBeUndefined();
  });
});

describe('strongerJudgement', () => {
  it("keeps the winning verdict's blocking source", () => {
    const blocked = {
      verdict: 'unreadable' as const,
      source: { reason: 'unreadable' as const, shown: 'Q (us-east-1)' },
    };
    expect(strongerJudgement(blocked, undefined)).toBe(blocked);
    expect(strongerJudgement(blocked, { verdict: 'secret' })).toEqual({ verdict: 'secret' });
    expect(strongerJudgement({ verdict: 'secret' }, blocked)).toEqual({ verdict: 'secret' });
  });
});

describe('producerSecretCheckOf', () => {
  it('reads the judged variants off a resolver that carries them, and nothing otherwise', async () => {
    const resolver = {
      resolveImport: async () => 'v',
      resolveGetStackOutput: async () => 'v',
      resolveImportJudged: async () => ({ value: 'v', verdict: 'secret' as const }),
      resolveGetStackOutputJudged: async () => ({ value: 'w' }),
    };
    const check = producerSecretCheckOf(resolver);
    expect(await check?.resolveImportJudged('E')).toEqual({ value: 'v', verdict: 'secret' });
    expect(await check?.resolveGetStackOutputJudged('S', 'r', 'O')).toEqual({ value: 'w' });
    expect(
      producerSecretCheckOf({
        resolveImport: async () => undefined,
        resolveGetStackOutput: async () => undefined,
      })
    ).toBeUndefined();
    expect(producerSecretCheckOf(undefined)).toBeUndefined();
  });
});
