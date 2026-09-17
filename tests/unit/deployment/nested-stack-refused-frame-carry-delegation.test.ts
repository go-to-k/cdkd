import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

/**
 * Issue [#3156](https://github.com/go-to-k/cdkd/issues/3156), the REGION-PINNED
 * delegation arm: a framed `ssm` reference naming another region is resolved
 * by a sibling resolver, and the nested-stack carry certifies it on the verdict
 * the SIBLING's replacement took. A public parameter there must not carry, a
 * SecureString must.
 *
 * The SDK client classes are faked, as in
 * `intrinsic-resolver-assembled-secret-region.test.ts`, because the sibling is
 * derived only from a real `AwsClients`, and the faked response is keyed by the
 * region the client was constructed for, so a case also shows the foreign
 * region answered.
 */

const { responses, makeFakeClientClass } = vi.hoisted(() => {
  // A value, or a queue of values answered in order (the last one repeats).
  const responses = new Map<string, unknown>();
  const makeFakeClientClass = (): unknown =>
    class {
      readonly config: { region: () => Promise<string> };
      constructor(private readonly ctorConfig: { region?: string } = {}) {
        this.config = { region: async () => this.ctorConfig.region ?? String(process.env['AWS_REGION']) };
      }
      async send(command: { constructor: { name: string } }): Promise<unknown> {
        const key = `${String(this.ctorConfig.region)}|${command.constructor.name}`;
        const response = responses.get(key);
        if (response === undefined) throw new Error(`no response primed for ${key}`);
        if (!Array.isArray(response)) return response;
        return response.length > 1 ? response.shift() : response[0];
      }
      destroy(): void {}
    };
  return { responses, makeFakeClientClass };
});

vi.mock('@aws-sdk/client-ssm', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return { ...actual, SSMClient: makeFakeClientClass() };
});
vi.mock('@aws-sdk/client-sts', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return { ...actual, STSClient: makeFakeClientClass() };
});

import { AwsClients, setAwsClients, resetAwsClients } from '../../../src/utils/aws-clients.js';
import {
  IntrinsicFunctionResolver,
  resetAccountInfoCache,
} from '../../../src/deployment/intrinsic-function-resolver.js';
import {
  markSameGenerationBag,
  recordNestedStackParameterExpressions,
  redactSecretsForState,
  type RecordedSecretValues,
} from '../../../src/deployment/secret-redaction.js';

const CONSUMER_REGION = 'us-east-1';
const PRODUCER_REGION = 'eu-west-1';
const TOKEN = `{{resolve:ssm:arn:aws:ssm:${PRODUCER_REGION}:111122223333:parameter/app/pin}}`;
const PIN = 'q7';

beforeEach(() => {
  responses.clear();
  resetAccountInfoCache();
  for (const region of [CONSUMER_REGION, PRODUCER_REGION]) {
    responses.set(`${region}|GetCallerIdentityCommand`, {
      Account: '111122223333',
      Arn: 'arn:aws:iam::111122223333:user/test',
    });
  }
  setAwsClients(new AwsClients({ region: CONSUMER_REGION }));
});

afterEach(() => {
  resetAwsClients();
  resetAccountInfoCache();
});

async function deployRow(
  pin: unknown = { 'Fn::Join': ['', ['port:', TOKEN]] }
): Promise<{ bag: RecordedSecretValues; value: unknown; record: unknown }> {
  const bag: RecordedSecretValues = new Map();
  const source = {
    TemplateURL: 'https://s3.amazonaws.com/bucket/child.json',
    Parameters: { Pin: pin },
  };
  const resolved = (await new IntrinsicFunctionResolver(CONSUMER_REGION).resolve(source, {
    template: { Resources: {} },
    resources: {},
    recordedSecretValues: bag,
  } as never)) as { Parameters: Record<string, unknown> };
  recordNestedStackParameterExpressions(bag, 'AWS::CloudFormation::Stack', resolved, source);
  const record = redactSecretsForState(markSameGenerationBag(structuredClone(resolved)), bag, source) as {
    Parameters: Record<string, unknown>;
  };
  return { bag, value: resolved.Parameters['Pin'], record: record.Parameters['Pin'] };
}

describe('issue #3156: the carry reads the verdict a region-pinned sibling took', () => {
  it('carries a foreign-region SecureString frame', async () => {
    responses.set(`${PRODUCER_REGION}|GetParameterCommand`, {
      Parameter: { Value: PIN, Type: 'SecureString' },
    });
    const { bag, value, record } = await deployRow();
    expect(value).toBe(`port:${PIN}`);
    expect(bag.get(`port:${PIN}`)).toBe(`port:${TOKEN}`);
    expect(record).toBe(`port:${TOKEN}`);
  });

  it('does not carry a foreign-region PUBLIC parameter holding the same characters, for which the pass holds no pair', async () => {
    responses.set(`${PRODUCER_REGION}|GetParameterCommand`, {
      Parameter: { Value: PIN, Type: 'String' },
    });
    const { bag, value, record } = await deployRow();
    expect(value).toBe(`port:${PIN}`);
    expect(bag.has(`port:${PIN}`)).toBe(false);
    expect(record).toBe(`port:${PIN}`);
  });

  it("refuses a sibling's PUBLIC answer for the leaf's own token, though an unused variable's unclassifiable answer left a pair for it", async () => {
    // The unused variable is read first (no `Type`: secret for that read, a
    // pair, never cached), then the template's own token (public).
    responses.set(`${PRODUCER_REGION}|GetParameterCommand`, [
      { Parameter: { Value: PIN } },
      { Parameter: { Value: PIN, Type: 'String' } },
    ]);
    const { bag, value } = await deployRow({ 'Fn::Sub': [`port:${TOKEN}`, { Unused: TOKEN }] });
    expect(value).toBe(`port:${PIN}`);
    expect(bag.get(PIN)).toBe(TOKEN);
    expect(bag.has(`port:${PIN}`)).toBe(false);
  });
});
