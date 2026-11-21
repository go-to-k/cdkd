/**
 * go-to-k/cdkd#6761: Lambda `Layers` is an ORDER-SIGNIFICANT ARN list. Both
 * callers of `calculateResourceDrift` that compare a typed resource pass the
 * type, so the id/ARN sort leaves the list in order: `cdkd drift` reports an
 * out-of-band reorder (and `--accept` records the live order), and the
 * after-update unsettled check keeps a name whose live order is not the
 * template's.
 */
import { describe, it, expect, vi } from 'vite-plus/test';
import { compareDriftReadback } from '../../../src/cli/commands/drift/compare.js';
import { unsettledAfterUpdate } from '../../../src/deployment/unsettled-convergence.js';
import type { ResourceProvider } from '../../../src/types/resource.js';

const TYPE = 'AWS::Lambda::Function';
const ZETA = 'arn:aws:lambda:us-east-1:123456789012:layer:zeta:3';
const ALPHA = 'arn:aws:lambda:us-east-1:123456789012:layer:alpha:1';
const SUBNETS = ['subnet-aaa111', 'subnet-bbb222'];
const bag = (layers: string[], subnets: string[] = SUBNETS) => ({
  FunctionName: 'fn',
  Layers: layers,
  VpcConfig: { SubnetIds: subnets },
});

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: () => logger,
};

const compare = async (live: Record<string, unknown>) => {
  const resource = {
    resourceType: TYPE,
    physicalId: 'fn',
    properties: bag([ZETA, ALPHA]),
    observedProperties: bag([ZETA, ALPHA]),
    attributes: {},
  };
  const outcomes: Array<{
    kind: string;
    changes?: Array<{ path: string; stateValue: unknown; awsValue: unknown }>;
  }> = [];
  await compareDriftReadback({
    region: 'us-east-1',
    resolvePrincipalUniqueId: () => Promise.resolve(undefined),
    outcomes: outcomes as never,
    logger: logger as never,
    secretResolvers: {} as never,
    producerRegions: { regions: [], complete: true },
    stackSecretNames: new Map(),
    resource: resource as never,
    logicalId: 'Fn',
    provider: {} as ResourceProvider,
    secrets: new Map(),
    printing: new Map(),
    aws: live,
  });
  expect(outcomes).toHaveLength(1);
  return outcomes[0]!;
};

describe('cdkd drift compares Lambda Layers in order (#6761)', () => {
  it('reports layers reordered out of band, with the live order as the AWS value', async () => {
    const outcome = await compare(bag([ALPHA, ZETA]));
    expect(outcome.kind).toBe('drifted');
    expect(outcome.changes!.map((c) => c.path)).toEqual(['Layers']);
    expect(outcome.changes![0]!.stateValue).toEqual([ZETA, ALPHA]);
    expect(outcome.changes![0]!.awsValue).toEqual([ALPHA, ZETA]);
  });

  it('reads the same order as clean', async () => {
    expect((await compare(bag([ZETA, ALPHA]))).kind).toBe('clean');
  });

  it('still reads reordered subnets as clean', async () => {
    expect((await compare(bag([ZETA, ALPHA], [...SUBNETS].reverse()))).kind).toBe('clean');
  });
});

describe('the after-update unsettled check compares Lambda Layers in order (#6761)', () => {
  const unsettled = (live: string[]) =>
    unsettledAfterUpdate({
      provider: {
        readCurrentState: () => Promise.resolve(bag(live)),
      } as unknown as ResourceProvider,
      logicalId: 'Fn',
      physicalId: 'fn',
      resourceType: TYPE,
      recordedProperties: bag([ZETA, ALPHA]),
      names: new Set(['Layers']),
      desired: bag([ZETA, ALPHA]),
    });

  it('keeps Layers unsettled while the live order is not the template order', async () => {
    expect(await unsettled([ALPHA, ZETA])).toEqual(['Layers']);
  });

  it('settles Layers once the live order matches', async () => {
    expect(await unsettled([ZETA, ALPHA])).toEqual([]);
  });
});
