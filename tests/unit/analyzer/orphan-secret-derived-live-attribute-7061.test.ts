import { describe, it, expect, vi } from 'vite-plus/test';
import { AttributeFetcher } from '../../../src/analyzer/orphan-rewriter/attribute-fetcher.js';
import type { ProviderRegistry } from '../../../src/provisioning/provider-registry.js';
import type { ResourceState } from '../../../src/types/state.js';

vi.mock('../../../src/utils/logger.js', () => {
  const fns = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => fns };
  return { getLogger: () => fns };
});

/**
 * go-to-k/cdkd#7061: `cdkd orphan` writes a sibling's `Fn::GetAtt` answer into
 * persisted state outside every redaction pass. A live answer the orphan's
 * record calls secret-derived (by provenance, never by its text) is the
 * plaintext state kept out, so it is neither read nor spliced, with or without
 * `--force`.
 */
const PLAINTEXT = 'arn:aws:lambda:us-east-1:123456789012:function:hunter2-fn';
const TOKEN = '{{resolve:secretsmanager:db-secret:SecretString:password::}}';

const record = (over: Partial<ResourceState>): ResourceState => ({
  physicalId: 'phys-x',
  resourceType: 'AWS::Lambda::Function',
  properties: {},
  attributes: {},
  dependencies: [],
  ...over,
});

const fetcherWith = (orphan: ResourceState, force: boolean) => {
  const getAttribute = vi.fn(async () => PLAINTEXT);
  const registry = {
    getProviderFor: () => ({ provider: { getAttribute } }),
  } as unknown as ProviderRegistry;
  return { fetcher: new AttributeFetcher({ X: orphan }, registry, { force }), getAttribute };
};

describe('cdkd orphan: a secret-derived live attribute is never spliced (#7061)', () => {
  const refused: Array<[string, Partial<ResourceState>, string]> = [
    ['recorded as the mask', { attributes: { Arn: '***' } }, 'Arn'],
    ['recorded with an embedded mask leaf', { attributes: { Arn: ['***'] } }, 'Arn'],
    ['recorded as a secret dynamic reference', { attributes: { Arn: TOKEN } }, 'Arn'],
    ['a dotted member recorded as the mask', { attributes: { Endpoint: { Address: '***' } } }, 'Endpoint.Address'],
    ['declared NoEcho', { attributes: {}, noEchoAttributeNames: ['Arn'] }, 'Arn'],
    ['a secret-derived name', { attributes: {}, secretNamedAttributes: ['Arn'] }, 'Arn'],
    ['unrecorded, the record masks a property', { properties: { FunctionName: '***' } }, 'Arn'],
    ['unrecorded, the record holds a secret reference', { properties: { Env: TOKEN } }, 'Arn'],
    ['unrecorded, the observed bag masks a leaf', { observedProperties: { FunctionName: '***' } }, 'Arn'],
    ['unrecorded, NoEcho leaves', { noEchoLeaves: [['FunctionName']] }, 'Arn'],
    ['unrecorded, masked fingerprints', { maskedPropertyFingerprints: { FunctionName: 'h' } }, 'Arn'],
    ['unrecorded, NoEcho value MACs', { noEchoValueMacs: { FunctionName: { p: 'm' } } }, 'Arn'],
    ['a credential-named attribute', {}, 'SecretAccessKey'],
    ['a custom resource attribute', { resourceType: 'Custom::Thing' }, 'Arn'],
    ['a secret-valued attribute', { resourceType: 'AWS::AppSync::ApiKey' }, 'ApiKey'],
  ];

  it.each(refused.flatMap(([what, over, attr]) => [false, true].map((force) => [what, over, attr, force] as const)))(
    '%s (%s.%s, force=%s): refused before the live read',
    async (_what, over, attribute, force) => {
      const { fetcher, getAttribute } = fetcherWith(record(over), force);
      const result = await fetcher.getAtt('X', attribute);
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain('hunter2');
      expect(getAttribute).not.toHaveBeenCalled();
    }
  );

  it('a record with no secret provenance still takes the live answer', async () => {
    const { fetcher, getAttribute } = fetcherWith(
      record({ properties: { FunctionName: 'plain-fn', Env: '{{resolve:ssm:/plain/param}}' } }),
      false
    );
    await expect(fetcher.getAtt('X', 'Arn')).resolves.toEqual({ ok: true, value: PLAINTEXT });
    expect(getAttribute).toHaveBeenCalledOnce();
  });

  it('a served recorded value is unchanged, even on a secret-carrying record', async () => {
    const { fetcher } = fetcherWith(
      record({ properties: { Env: TOKEN }, attributes: { Arn: 'arn:recorded' } }),
      false
    );
    await expect(fetcher.getAtt('X', 'Arn')).resolves.toEqual({ ok: true, value: 'arn:recorded' });
  });

  it('a secret-carrying record still answers Ref from its physical id', async () => {
    const { fetcher, getAttribute } = fetcherWith(record({ properties: { Env: TOKEN } }), false);
    expect(fetcher.ref('X')).toMatchObject({ ok: true });
    expect(getAttribute).not.toHaveBeenCalled();
  });
});
