import { describe, it, expect, vi } from 'vite-plus/test';

vi.mock('../../../src/deployment/intrinsic-function-resolver.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/deployment/intrinsic-function-resolver.js')>()),
  getAccountInfo: vi.fn(async (region?: string) => ({
    accountId: '123456789012',
    region: region ?? 'us-east-1',
    partition: 'aws',
  })),
}));
import { AttributeHealer } from '../../../src/deployment/deploy-engine/attribute-healer.js';
import {
  NoEchoRunState,
  noEchoAttributeOverridesFor,
  type NoEchoDeps,
} from '../../../src/deployment/deploy-engine/noecho.js';
import { SECRET_MASK } from '../../../src/deployment/secret-redaction.js';
import type { ResourceState } from '../../../src/types/state.js';

/**
 * `--pin-cc-api` reaches the two deploy-time reads that route a record as its
 * own baseline (go-to-k/cdkd#5654). Without it a pinned cc-api record of an
 * `'sdk-coverage'` type would be READ through its SDK provider under the
 * normalized id while its update stays on Cloud Control, and a refused id
 * would fail the read with a `--pin-cc-api` remedy the pin cannot honor.
 */
const record = {
  physicalId: 'arn:aws:ecs:us-east-1:123456789012:service/c/s|c',
  resourceType: 'AWS::ECS::Service',
  properties: { Cluster: 'c' },
  attributes: { Secret: SECRET_MASK },
  noEchoAttributeNames: ['Secret'],
  dependencies: [],
  provisionedBy: 'cc-api',
} as unknown as ResourceState;

function registry() {
  const getProviderFor = vi.fn((_input: Record<string, unknown>) => ({
    provider: {},
    provisionedBy: 'cc-api' as const,
  }));
  return { getProviderFor };
}

describe('AttributeHealer.read honors --pin-cc-api (go-to-k/cdkd#5654)', () => {
  const healerWith = (pinned: boolean | undefined, reg: ReturnType<typeof registry>) =>
    new AttributeHealer({
      providerRegistry: reg as never,
      baseline: { Svc: record },
      stackRegion: 'us-east-1',
      logger: { debug: () => undefined },
      resolvedSecretsOf: () => undefined,
      namingSecrets: () => ({}) as never,
      ...(pinned !== undefined && {
        pinnedToCcApi: (stackName: string, logicalId: string) =>
          pinned && stackName === 'App' && logicalId === 'Svc',
      }),
    });

  it('a pinned resource is routed with forceCcApi', async () => {
    const reg = registry();
    await healerWith(true, reg).read('Svc', record, 'App');
    expect(reg.getProviderFor.mock.calls[0]![0]).toMatchObject({ forceCcApi: true });
  });

  it('an unpinned resource, or no pin wiring, is not', async () => {
    for (const pinned of [false, undefined]) {
      const reg = registry();
      await healerWith(pinned, reg).read('Svc', record, 'App');
      expect(reg.getProviderFor.mock.calls[0]![0]).not.toHaveProperty('forceCcApi');
    }
  });
});

describe('the NoEcho attribute read honors --pin-cc-api (go-to-k/cdkd#5654)', () => {
  const run = async (pinned: boolean) => {
    const reg = registry();
    const deps = {
      stackRegion: 'us-east-1',
      logger: { warn: () => undefined },
      providerRegistry: reg,
      perResourceSecrets: () => new Map([['Svc', {}]]),
      pinnedToCcApi: (stackName: string, logicalId: string) =>
        pinned && stackName === 'App' && logicalId === 'Svc',
    } as unknown as NoEchoDeps;
    await noEchoAttributeOverridesFor(
      new NoEchoRunState(),
      deps,
      { Value: { 'Fn::GetAtt': ['Svc', 'Secret'] } },
      { Svc: record },
      'App'
    );
    // Premise: the read was routed at all.
    expect(reg.getProviderFor).toHaveBeenCalledTimes(1);
    return reg.getProviderFor.mock.calls[0]![0];
  };

  it('a pinned resource is routed with forceCcApi', async () => {
    expect(await run(true)).toMatchObject({ forceCcApi: true });
  });

  it('an unpinned one is not', async () => {
    expect(await run(false)).not.toHaveProperty('forceCcApi');
  });
});

describe('the NoEcho attribute read addresses a flipped record in the stack region (go-to-k/cdkd#6490)', () => {
  it("hands a WAFv2 normalizer the deps' stack region, and import() the same region", async () => {
    const id = '20803c2a-0b8f-4df4-a600-11eda6efc69b';
    const acl = {
      physicalId: `my-acl|${id}|REGIONAL`,
      resourceType: 'AWS::WAFv2::WebACL',
      properties: { Name: 'my-acl', Scope: 'REGIONAL' },
      attributes: { Secret: SECRET_MASK },
      noEchoAttributeNames: ['Secret'],
      dependencies: [],
      provisionedBy: 'cc-api',
    } as unknown as ResourceState;
    const importFn = vi.fn(async (input: { knownPhysicalId?: string }) => ({
      physicalId: input.knownPhysicalId!,
      attributes: { Secret: 'live' },
    }));
    const deps = {
      stackRegion: 'eu-west-1',
      logger: { warn: () => undefined },
      providerRegistry: {
        getProviderFor: vi.fn(() => ({ provider: { import: importFn }, provisionedBy: 'sdk' as const })),
      },
      perResourceSecrets: () => new Map([['Acl', {}]]),
    } as unknown as NoEchoDeps;
    await noEchoAttributeOverridesFor(
      new NoEchoRunState(),
      deps,
      { Value: { 'Fn::GetAtt': ['Acl', 'Secret'] } },
      { Acl: acl },
      'App'
    );
    expect(importFn).toHaveBeenCalledTimes(1);
    expect(importFn.mock.calls[0]![0]).toMatchObject({
      knownPhysicalId: `arn:aws:wafv2:eu-west-1:123456789012:regional/webacl/my-acl/${id}`,
      region: 'eu-west-1',
    });
  });
});
