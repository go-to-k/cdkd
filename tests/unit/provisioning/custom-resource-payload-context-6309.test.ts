/**
 * go-to-k/cdkd#6309, provider half: `create` / `update` / `delete` type the
 * handler payload by the coordinates their context carries
 * (`typedPayloadLeaves`, `previousTypedPayloadLeaves`,
 * `recordedTypedPayloadLeaves`), and keep the pre-#6309 rule without them.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    lambda: { send: vi.fn() },
    sns: { send: vi.fn() },
    s3: { send: vi.fn() },
    sts: { send: vi.fn(() => Promise.resolve({ Account: '123456789012' })) },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => logger,
  };
  return { getLogger: () => logger };
});

import { CustomResourceProvider } from '../../../src/provisioning/providers/custom-resource-provider.js';

const TOKEN = 'arn:aws:lambda:us-east-1:123456789012:function:handler';
/** `Count` came from an `Fn::GetAtt`, `Lit` was a template literal. */
const PROPS = { ServiceToken: TOKEN, Count: 0, Lit: 5, Flag: true, List: [1] };
const OLD = { ServiceToken: TOKEN, Count: 1, Lit: 4, Flag: false, List: [2] };

describe('CustomResourceProvider payload types (#6309)', () => {
  let provider: CustomResourceProvider;
  let sent: Record<string, unknown>[];

  beforeEach(() => {
    sent = [];
    provider = new CustomResourceProvider({ responseBucket: 'test-bucket' });
    vi.spyOn(provider, 'invokeCustomResourceWithRetry').mockImplementation(
      async (_token, _logicalId, _requestType, build) => {
        sent.push(
          build({
            requestId: 'req',
            responseURL: 'https://example.com/r',
            stackId: 'stack',
          } as never) as unknown as Record<string, unknown>
        );
        return { Status: 'SUCCESS', PhysicalResourceId: 'phys' } as never;
      }
    );
    vi.spyOn(provider, 'isBackingLambdaGone').mockResolvedValue(false);
  });

  it('create keeps a typed leaf and stringifies every literal, lists included', async () => {
    await provider.create('Cr', 'Custom::Echo', { ...PROPS }, { typedPayloadLeaves: [['Count']] });
    expect(sent[0]!['ResourceProperties']).toStrictEqual({
      ServiceToken: TOKEN,
      Count: 0,
      Lit: '5',
      Flag: 'true',
      List: ['1'],
    });
  });

  it('create without leaves keeps the pre-#6309 rule', async () => {
    await provider.create('Cr', 'Custom::Echo', { ...PROPS });
    expect(sent[0]!['ResourceProperties']).toStrictEqual({
      ServiceToken: TOKEN,
      Count: '0',
      Lit: '5',
      Flag: 'true',
      List: [1],
    });
  });

  it('update types each side by its own leaves', async () => {
    await provider.update('Cr', 'phys', 'Custom::Echo', { ...PROPS }, { ...OLD }, {
      typedPayloadLeaves: [['Count']],
      previousTypedPayloadLeaves: [['Lit']],
    });
    expect(sent[0]!['ResourceProperties']).toMatchObject({ Count: 0, Lit: '5', List: ['1'] });
    expect(sent[0]!['OldResourceProperties']).toMatchObject({ Count: '1', Lit: 4, List: ['2'] });
  });

  it('update of a record an earlier cdkd wrote: the old side keeps the pre-#6309 rule', async () => {
    await provider.update('Cr', 'phys', 'Custom::Echo', { ...PROPS }, { ...OLD }, {
      typedPayloadLeaves: [['Count']],
    });
    expect(sent[0]!['ResourceProperties']).toMatchObject({ Count: 0, List: ['1'] });
    expect(sent[0]!['OldResourceProperties']).toMatchObject({ Count: '1', Lit: '4', List: [2] });
  });

  it("delete types the payload by the record's leaves", async () => {
    await provider.delete('Cr', 'phys', 'Custom::Echo', { ...PROPS }, {
      recordedTypedPayloadLeaves: [['Count']],
    });
    expect(sent[0]!['ResourceProperties']).toStrictEqual({
      ServiceToken: TOKEN,
      Count: 0,
      Lit: '5',
      Flag: 'true',
      List: ['1'],
    });
  });

  it('delete of a record with no leaves keeps the pre-#6309 rule', async () => {
    await provider.delete('Cr', 'phys', 'Custom::Echo', { ...PROPS });
    expect(sent[0]!['ResourceProperties']).toMatchObject({ Count: '0', List: [1] });
  });
});
