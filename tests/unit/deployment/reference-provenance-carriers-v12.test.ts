/**
 * State schema v12 (go-to-k/cdkd#4852): the nested-stack CARRIERS of
 * reference provenance, through the real resolver.
 *
 * - a nested CHILD reading a parameter its parent row resolved from a token
 *   records that token's entry from the inherited snapshot, on the `read`
 *   route (the child never resolves the token itself);
 * - a child resource whose `Ref` does not carry the plaintext records nothing.
 */
import { describe, it, expect, vi } from 'vite-plus/test';

vi.mock('../../../src/utils/logger.js', () => {
  const fns = {
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => fns,
  };
  return { getLogger: () => fns };
});
vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sts: { send: vi.fn().mockResolvedValue({ Account: '123456789012' }) },
  }),
}));

const { IntrinsicFunctionResolver } = await import(
  '../../../src/deployment/intrinsic-function-resolver.js'
);
const { passProvenanceFor } = await import(
  '../../../src/deployment/secret-redaction/reference-provenance.js'
);

const TOKEN = '{{resolve:secretsmanager:app:SecretString:name::}}';
const PLAINTEXT = 'child-param-plaintext';
const V1 = 'a1b2c3d4-0000-1111-2222-333333333333';

function childContext(bag: Map<string, string>, value: string) {
  return {
    template: { Parameters: { P: { Type: 'String' } }, Resources: {} },
    resources: {},
    parameters: { P: value },
    recordedSecretValues: bag,
    inheritedSecrets: new Map([[PLAINTEXT, TOKEN]]),
    inheritedReferenceProvenance: new Map([[TOKEN, { region: 'us-west-2', versions: [V1] }]]),
  };
}

describe('a nested child reading a parameter its parent resolved from a token', () => {
  it('records the parent row entry on the read route', async () => {
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const bag = new Map<string, string>();
    const value = await resolver.resolve({ Ref: 'P' }, childContext(bag, PLAINTEXT) as never);
    expect(value).toBe(PLAINTEXT);
    expect(bag.get(PLAINTEXT)).toBe(TOKEN);
    expect(passProvenanceFor(bag, TOKEN)).toEqual({
      region: 'us-west-2',
      versions: [V1],
      readVersions: [V1],
    });
  });

  it('a parameter value that does not carry the plaintext records nothing', async () => {
    const resolver = new IntrinsicFunctionResolver('us-east-1');
    const bag = new Map<string, string>();
    await resolver.resolve({ Ref: 'P' }, childContext(bag, 'unrelated-value') as never);
    expect(passProvenanceFor(bag, TOKEN)).toBeUndefined();
  });
});
