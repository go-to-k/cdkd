/**
 * Issue go-to-k/cdkd#3202: `S3LocalStateProvider.load` passed the target
 * stack's `resources` bag through UNCHANGED, so every `cdkd local *`
 * `--from-state` consumer read it as an unchecked cast.
 *
 * Two consequences, one per half of the class. A `null` or absent BAG threw at
 * `state.resources[logicalId]` in `local invoke`'s bare `--assume-role`
 * resolver, one line ABOVE the falsy guard that leads to the documented
 * fall-back to developer credentials — so that fall-back was unreachable. An
 * unreadable ROW reached cdk-local's env substitution, which indexes the bag
 * per key and dereferences what it finds.
 *
 * ONE remedy at the load rather than one per consumer: this is the only load
 * `--from-state` goes through (`createLocalStateProvider`), so a consumer added
 * later inherits it. REPAIR-AND-WARN for the reason the `outputs` twin in
 * `s3-local-state-provider-malformed-outputs.test.ts` records: this provider
 * writes no `state.json`.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { StackState } from '../../../src/types/state.js';

const mocks = vi.hoisted(() => ({
  loadStateForStackMock: vi.fn(),
  buildCrossStackResolverMock: vi.fn(),
  warnMock: vi.fn(),
}));

vi.mock('../../../src/cli/commands/local-state-loader.js', () => ({
  loadStateForStack: mocks.loadStateForStackMock,
  buildCrossStackResolver: mocks.buildCrossStackResolverMock,
}));
vi.mock('../../../src/utils/logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/utils/logger.js')>();
  const quiet = {
    info: vi.fn(),
    warn: mocks.warnMock,
    error: vi.fn(),
    debug: vi.fn(),
    setLevel: vi.fn(),
    child: (): unknown => quiet,
  };
  return { ...actual, getLogger: () => quiet };
});

import { S3LocalStateProvider } from '../../../src/local/s3-local-state-provider.js';
import { resolveExecutionRoleArnFromState } from '../../../src/cli/commands/local-invoke.js';

const REGION = 'us-east-1';
const HEALTHY = { physicalId: 'f', resourceType: 'AWS::S3::Bucket', properties: {} };

function loaded(resources: unknown, opts: { omitResources?: boolean } = {}): unknown {
  const state: StackState = {
    version: 9,
    stackName: 'TargetStack',
    region: REGION,
    resources: resources as StackState['resources'],
    outputs: { Out: 'v' },
    lastModified: 1,
  };
  if (opts.omitResources) delete (state as Partial<StackState>).resources;
  return { state, region: REGION };
}

const warned = (): string => mocks.warnMock.mock.calls.map((c) => String(c[0])).join('\n');

const load = async (): Promise<{ resources: StackState['resources'] } | undefined> =>
  (await new S3LocalStateProvider({ statePrefix: 'cdkd' }).load('TargetStack', REGION)) as
    | { resources: StackState['resources'] }
    | undefined;

describe('S3LocalStateProvider repairs a malformed resources BAG (go-to-k/cdkd#3202)', () => {
  beforeEach(() => {
    mocks.loadStateForStackMock.mockReset();
    mocks.warnMock.mockReset();
  });

  const MALFORMED: Array<[string, unknown]> = [
    ['a string bag', 'abcdef'],
    ['a list bag', [HEALTHY]],
    ['a null bag', null],
    ['a number bag', 5],
    ['a boolean bag', true],
  ];

  for (const [label, bag] of MALFORMED) {
    it(`reads ${label} as EMPTY and names the record`, async () => {
      mocks.loadStateForStackMock.mockResolvedValue(loaded(bag));
      const record = await load();
      expect(record?.resources).toEqual({});
      expect(warned()).toContain('TargetStack');
      expect(warned()).toContain("no readable 'resources' map");
      // The LOCAL text, not the read-only command one: a `cdkd local` run has
      // no "output describing zero resources" — what the empty map costs it
      // is the substitution and the role fall-back, which the text names.
      expect(warned()).toContain('--assume-role');
      expect(warned()).not.toContain("this command's output");
    });
  }

  it('reads an ABSENT bag as EMPTY too — unlike `outputs`, absence is a defect here', async () => {
    mocks.loadStateForStackMock.mockResolvedValue(loaded(undefined, { omitResources: true }));
    expect((await load())?.resources).toEqual({});
    expect(warned()).toContain("no readable 'resources' map");
  });

  /**
   * THE CONSEQUENCE the repair exists for, driven through the real consumer:
   * `resolveExecutionRoleArnFromState` indexes `state.resources[logicalId]`
   * and then tests the result — so on a `null` bag the index threw before the
   * guard, and the caller's warn-and-fall-back never ran. On the repaired
   * record it RETURNS `undefined`, which is what reaches that fall-back.
   */
  it('lets the bare --assume-role resolver RETURN instead of throwing on the repaired record', async () => {
    mocks.loadStateForStackMock.mockResolvedValue(loaded(null));
    const record = await load();
    expect(() => resolveExecutionRoleArnFromState({ resources: record!.resources }, 'Fn')).not.toThrow();
    expect(resolveExecutionRoleArnFromState({ resources: record!.resources }, 'Fn')).toBeUndefined();
    // CONTROL: the unrepaired shape is what threw.
    expect(() =>
      resolveExecutionRoleArnFromState({ resources: null as unknown as StackState['resources'] }, 'Fn')
    ).toThrow(TypeError);
  });

  it('passes a healthy bag through UNCHANGED, by identity, and warns about nothing', async () => {
    const bag = { Foo: HEALTHY };
    mocks.loadStateForStackMock.mockResolvedValue(loaded(bag));
    const record = await load();
    expect(record?.resources).toBe(bag);
    expect(warned()).toBe('');
  });

  it('stays silent on an EMPTY bag', async () => {
    mocks.loadStateForStackMock.mockResolvedValue(loaded({}));
    expect((await load())?.resources).toEqual({});
    expect(warned()).toBe('');
  });
});

describe('S3LocalStateProvider DROPS an unreadable resource ROW (go-to-k/cdkd#3202)', () => {
  beforeEach(() => {
    mocks.loadStateForStackMock.mockReset();
    mocks.warnMock.mockReset();
  });

  const UNREADABLE: Array<[string, unknown]> = [
    ['null', null],
    ['a string', 'abc'],
    ['a number', 5],
    ['a list', [HEALTHY]],
    ['an object with no resourceType', { physicalId: 'p', properties: {} }],
  ];

  for (const [label, row] of UNREADABLE) {
    it(`drops a row that is ${label}, keeps its siblings, and names the row`, async () => {
      mocks.loadStateForStackMock.mockResolvedValue(loaded({ Good: HEALTHY, Bad: row }));
      const record = await load();
      expect(record?.resources).toEqual({ Good: HEALTHY });
      expect(warned()).toContain('Bad');
      expect(warned()).toContain('cannot be read as resources');
      // The LOCAL entry text, for the reason the bag one is local.
      expect(warned()).toContain('--assume-role');
      expect(warned()).not.toContain("this command's output");
      // And the BAG warning did not fire: the map itself was readable.
      expect(warned()).not.toContain("no readable 'resources' map");
    });
  }

  it('names EVERY dropped row in one warning', async () => {
    mocks.loadStateForStackMock.mockResolvedValue(
      loaded({ A: null, Good: HEALTHY, B: 'x', C: { physicalId: 'p' } })
    );
    const record = await load();
    expect(Object.keys(record!.resources)).toEqual(['Good']);
    expect(mocks.warnMock).toHaveBeenCalledTimes(1);
    for (const id of ['A', 'B', 'C']) expect(warned()).toContain(id);
  });

  it('does not ask for a physicalId — a typed row with none is KEPT', async () => {
    // `isReadableResourceEntry` stops at `resourceType` by a recorded decision;
    // the substitution then answers such a row's `Ref` with `undefined` and
    // reports it per key, in its own terms.
    const typed = { resourceType: 'AWS::S3::Bucket', properties: {} };
    mocks.loadStateForStackMock.mockResolvedValue(loaded({ Typed: typed }));
    expect((await load())?.resources).toEqual({ Typed: typed });
    expect(warned()).toBe('');
  });
});
