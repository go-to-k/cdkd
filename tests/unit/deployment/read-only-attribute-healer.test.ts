/**
 * Issue [go-to-k/cdkd#3456](https://github.com/go-to-k/cdkd/issues/3456): the
 * read-only stale-attribute healer `cdkd diff` supplies — the read itself
 * (`readRecordAttributes`) and the factory's eligibility, memo, region binding
 * and never-throw contract. The diff wiring is pinned in
 * `tests/unit/cli/diff-recursive-stale-attribute-heal.test.ts` and
 * `tests/unit/cli/diff-stale-attribute-heal-3456.test.ts`.
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

import { getLogger } from '../../../src/utils/logger.js';
import {
  createReadOnlyAttributeHealerFactory,
  readRecordAttributes,
} from '../../../src/deployment/read-only-attribute-healer.js';
import { SECRET_MASK } from '../../../src/deployment/secret-redaction.js';
import type { ResourceImportResult, ResourceProvider } from '../../../src/types/resource.js';
import type { ResourceState } from '../../../src/types/state.js';

const record = (overrides: Partial<ResourceState> = {}): ResourceState => ({
  physicalId: '/app/p',
  resourceType: 'AWS::SSM::Parameter',
  properties: { Name: '/app/p', Type: 'String', Value: 'v' },
  attributes: { Type: 'String' },
  ...overrides,
});

function providerAnswering(
  answer: (knownPhysicalId: string | undefined) => ResourceImportResult | null
): ResourceProvider & { import: ReturnType<typeof vi.fn> } {
  return {
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    import: vi.fn(async (input: { knownPhysicalId?: string }) => answer(input.knownPhysicalId)),
  } as unknown as ResourceProvider & { import: ReturnType<typeof vi.fn> };
}

const passThrough = <T>(_region: string, fn: () => Promise<T>): Promise<T> => fn();

/** `inRegion` that records the region it was entered with. */
function recordingInRegion(): {
  regions: string[];
  inRegion: <T>(region: string, fn: () => Promise<T>) => Promise<T>;
} {
  const regions: string[] = [];
  return {
    regions,
    inRegion: (region, fn) => {
      regions.push(region);
      return fn();
    },
  };
}

describe('readRecordAttributes (go-to-k/cdkd#3456)', () => {
  const read = (provider: ResourceProvider, resource = record()) =>
    readRecordAttributes({
      provider,
      logicalId: 'Param',
      resource,
      stackName: 'S',
      region: 'eu-west-1',
    });

  it("asks import() by the record's physical id, in the stack's region", async () => {
    const provider = providerAnswering((id) => ({ physicalId: id!, attributes: { Arn: 'arn:x' } }));
    await expect(read(provider)).resolves.toEqual({ kind: 'read', attributes: { Arn: 'arn:x' } });
    expect(provider.import).toHaveBeenCalledWith({
      logicalId: 'Param',
      resourceType: 'AWS::SSM::Parameter',
      stackName: 'S',
      region: 'eu-west-1',
      properties: { Name: '/app/p', Type: 'String', Value: 'v' },
      knownPhysicalId: '/app/p',
    });
  });

  it('drops empty values, and a masked one into withheldKeys', async () => {
    const provider = providerAnswering((id) => ({
      physicalId: id!,
      attributes: { Arn: 'arn:x', Empty: '', Nothing: null, Hidden: SECRET_MASK },
    }));
    await expect(read(provider)).resolves.toEqual({
      kind: 'read',
      attributes: { Arn: 'arn:x' },
      withheldKeys: ['Hidden'],
    });
  });

  it('reports not-found for a null answer, not-attempted for a provider with no import()', async () => {
    await expect(read(providerAnswering(() => null))).resolves.toEqual({ kind: 'not-found' });
    const noImport = { create: vi.fn(), update: vi.fn(), delete: vi.fn() } as unknown as ResourceProvider;
    await expect(read(noImport)).resolves.toEqual({ kind: 'not-attempted' });
  });

  // go-to-k/cdkd#3211: the provider here echoes whatever id it is asked about,
  // so without the guard each of these reads back as `read` for a record that
  // names no resource.
  for (const [label, physicalId] of [
    ['an empty', ''],
    ['a whitespace-only', '  '],
    ['an absent', undefined],
    ['a non-string', 5],
  ] as Array<[string, unknown]>) {
    it(`does not call import() for ${label} physical id (go-to-k/cdkd#3211)`, async () => {
      const provider = providerAnswering((id) => ({
        physicalId: id as string,
        attributes: { Arn: 'arn:x' },
      }));
      await expect(
        read(provider, record({ physicalId: physicalId as string }))
      ).resolves.toEqual({ kind: 'not-attempted' });
      expect(provider.import).not.toHaveBeenCalled();
    });
  }

  it('refuses an answer for a DIFFERENT physical id', async () => {
    const provider = providerAnswering(() => ({ physicalId: '/other', attributes: { Arn: 'arn:other' } }));
    await expect(read(provider)).rejects.toThrow(
      'the provider answered for a different resource (/other) than the one asked about (/app/p)'
    );
  });
});

describe('createReadOnlyAttributeHealerFactory (go-to-k/cdkd#3456)', () => {
  it('routes the read through getProvider and inRegion, both given the STACK region', async () => {
    const provider = providerAnswering((id) => ({ physicalId: id!, attributes: { Arn: 'arn:x' } }));
    const getProvider = vi.fn(() => provider);
    const { regions, inRegion } = recordingInRegion();
    const heal = createReadOnlyAttributeHealerFactory({ getProvider, inRegion })('S', 'eu-west-1');
    const resource = record();
    await expect(heal('Param', resource)).resolves.toEqual({
      kind: 'read',
      attributes: { Arn: 'arn:x' },
    });
    expect(regions).toEqual(['eu-west-1']);
    expect(getProvider).toHaveBeenCalledWith(resource, 'eu-west-1');
  });

  it.each(['AWS::CloudFormation::Stack', 'AWS::CloudFormation::CustomResource', 'Custom::Thing'])(
    'never reads %s: its attributes are not an AWS read-back',
    async (resourceType) => {
      const getProvider = vi.fn();
      const { regions, inRegion } = recordingInRegion();
      const heal = createReadOnlyAttributeHealerFactory({ getProvider, inRegion })('S', 'us-east-1');
      await expect(heal('R', record({ resourceType }))).resolves.toEqual({ kind: 'not-attempted' });
      expect(getProvider).not.toHaveBeenCalled();
      expect(regions).toEqual([]);
    }
  );

  it('reads a record once per run, across healers and concurrent asks', async () => {
    const provider = providerAnswering((id) => ({ physicalId: id!, attributes: { Arn: 'arn:x' } }));
    const factory = createReadOnlyAttributeHealerFactory({
      getProvider: () => provider,
      inRegion: passThrough,
    });
    // Two healers for ONE node, as the per-stack diff and a nested child's
    // parameters build them.
    const [a, b] = await Promise.all([
      factory('S', 'us-east-1')('Param', record()),
      factory('S', 'us-east-1')('Param', record()),
    ]);
    expect(a).toBe(b);
    expect(provider.import).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['another stack', 'S2', 'us-east-1', 'Param', '/app/p'],
    ['another region', 'S', 'eu-west-1', 'Param', '/app/p'],
    ['another logical id', 'S', 'us-east-1', 'Other', '/app/p'],
    ['another physical id', 'S', 'us-east-1', 'Param', '/app/q'],
  ])('reads again for %s', async (_label, stackName, region, logicalId, physicalId) => {
    const provider = providerAnswering((id) => ({ physicalId: id!, attributes: { Arn: 'arn:x' } }));
    const factory = createReadOnlyAttributeHealerFactory({
      getProvider: () => provider,
      inRegion: passThrough,
    });
    await factory('S', 'us-east-1')('Param', record());
    await factory(stackName, region)(logicalId, record({ physicalId }));
    expect(provider.import).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['a `:` join', ['a:b', 'c'], ['a', 'b:c']],
    ['a NUL join', ['a\u0000b', 'c'], ['a', 'b\u0000c']],
    ['a `,` join', ['a,b', 'c'], ['a', 'b,c']],
  ])(
    'keeps two records apart whose parts would collide under %s',
    async (_label, [stackA, regionA], [stackB, regionB]) => {
      // Each answer names the region it was read in, so a shared memo entry
      // would hand the second record the FIRST record's read.
      const provider = providerAnswering((id) => ({ physicalId: id!, attributes: { Arn: 'arn:x' } }));
      const answers: string[] = [];
      const factory = createReadOnlyAttributeHealerFactory({
        getProvider: () => provider,
        inRegion: (region, fn) => {
          answers.push(region);
          return fn();
        },
      });
      await factory(stackA!, regionA!)('Param', record());
      await factory(stackB!, regionB!)('Param', record());
      expect(provider.import).toHaveBeenCalledTimes(2);
      expect(answers).toEqual([regionA, regionB]);
    }
  );

  it('never throws: a synchronous getProvider throw becomes a failed outcome', async () => {
    const error = new Error('No provider for AWS::Nope::Nope');
    const heal = createReadOnlyAttributeHealerFactory({
      getProvider: () => {
        throw error;
      },
      inRegion: passThrough,
    })('S', 'us-east-1');
    await expect(heal('Param', record())).resolves.toEqual({ kind: 'failed', error });
  });

  it('never throws: a synchronous inRegion throw becomes a failed outcome', async () => {
    const error = new Error('runWithStackAwsClients requires AwsClients configured with a region');
    const heal = createReadOnlyAttributeHealerFactory({
      getProvider: vi.fn(),
      inRegion: () => {
        throw error;
      },
    })('S', 'us-east-1');
    await expect(heal('Param', record())).resolves.toEqual({ kind: 'failed', error });
  });

  it('never throws: a rejected read and a mismatched answer become failed outcomes', async () => {
    const denied = Object.assign(new Error('denied'), { name: 'AccessDeniedException' });
    const rejecting = providerAnswering(() => {
      throw denied;
    });
    const heal = createReadOnlyAttributeHealerFactory({
      getProvider: () => rejecting,
      inRegion: passThrough,
    })('S', 'us-east-1');
    await expect(heal('Param', record())).resolves.toEqual({ kind: 'failed', error: denied });

    const mismatched = providerAnswering(() => ({ physicalId: '/other', attributes: { Arn: 'arn:o' } }));
    const heal2 = createReadOnlyAttributeHealerFactory({
      getProvider: () => mismatched,
      inRegion: passThrough,
    })('S', 'us-east-1');
    await expect(heal2('Param', record())).resolves.toMatchObject({ kind: 'failed' });
  });

  it('never throws: a record with a non-string resourceType becomes a failed outcome', async () => {
    const getProvider = vi.fn();
    const heal = createReadOnlyAttributeHealerFactory({ getProvider, inRegion: passThrough })(
      'S',
      'us-east-1'
    );
    // A hand-edited state row: the record is an unchecked cast.
    const torn = record({ resourceType: 42 as unknown as string });
    let outcome: Promise<unknown> | undefined;
    expect(() => {
      outcome = heal('Param', torn);
    }).not.toThrow();
    await expect(outcome).resolves.toMatchObject({ kind: 'failed' });
    expect(getProvider).not.toHaveBeenCalled();
  });

  it('memoizes a REJECTED read: a second ask with the same key issues no second import()', async () => {
    const denied = Object.assign(new Error('denied'), { name: 'AccessDeniedException' });
    const provider = providerAnswering(() => {
      throw denied;
    });
    const factory = createReadOnlyAttributeHealerFactory({
      getProvider: () => provider,
      inRegion: passThrough,
    });
    const first = await factory('S', 'us-east-1')('Param', record());
    const second = await factory('S', 'us-east-1')('Param', record());
    expect(first).toEqual({ kind: 'failed', error: denied });
    expect(second).toBe(first);
    expect(provider.import).toHaveBeenCalledTimes(1);
  });

  it('a throwing debug log does not turn a completed read into failed', async () => {
    const provider = providerAnswering((id) => ({ physicalId: id!, attributes: { Arn: 'arn:x' } }));
    const heal = createReadOnlyAttributeHealerFactory({ getProvider: () => provider, inRegion: passThrough })(
      'S',
      'us-east-1'
    );
    vi.mocked(getLogger().debug).mockImplementationOnce(() => {
      throw new Error('log sink closed');
    });
    await expect(heal('Param', record())).resolves.toEqual({ kind: 'read', attributes: { Arn: 'arn:x' } });
  });

  it('merges nothing into the record it was handed', async () => {
    const provider = providerAnswering((id) => ({ physicalId: id!, attributes: { Arn: 'arn:x' } }));
    const resource = record();
    const before = structuredClone(resource);
    await createReadOnlyAttributeHealerFactory({ getProvider: () => provider, inRegion: passThrough })(
      'S',
      'us-east-1'
    )('Param', resource);
    expect(resource).toEqual(before);
  });
});
