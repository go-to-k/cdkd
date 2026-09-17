/**
 * Issue go-to-k/cdkd#3207: `S3LocalStateProvider.load` coerced the target
 * stack's `outputs` bag with a bare `?? {}`.
 *
 * `Object.entries` walks a string or a list as readily as a map, so a
 * six-character bag produced SIX local outputs — one per character — each of
 * which the local run then substitutes into an environment variable.
 *
 * REPAIR-AND-WARN, not refuse: this provider writes no `state.json` (the one
 * DERIVED key a `cdkd local` run can write is the exports index, separately
 * fail-closed by `hasReadableExportSet`), so there is nothing here to launder
 * and a local invoke over a damaged record is still worth running. The warning
 * is what stops an empty map from reading as "this stack publishes no outputs".
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { StackState } from '../../../src/types/state.js';

const mocks = vi.hoisted(() => ({
  loadStateForStackMock: vi.fn(),
  warnMock: vi.fn(),
}));

vi.mock('../../../src/cli/commands/local-state-loader.js', () => ({
  loadStateForStack: mocks.loadStateForStackMock,
  buildCrossStackResolver: vi.fn(),
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

const REGION = 'us-east-1';

function loaded(outputs: unknown, opts: { omitOutputs?: boolean } = {}): unknown {
  const state: StackState = {
    version: 9,
    stackName: 'TargetStack',
    region: REGION,
    resources: { Foo: { physicalId: 'f', resourceType: 'AWS::S3::Bucket', properties: {} } },
    outputs: outputs as StackState['outputs'],
    lastModified: 1,
  };
  if (opts.omitOutputs) delete (state as Partial<StackState>).outputs;
  return { state, region: REGION };
}

const warned = (): string => mocks.warnMock.mock.calls.map((c) => String(c[0])).join('\n');

const load = async (): Promise<{ outputs: Record<string, string> } | undefined> =>
  (await new S3LocalStateProvider({ statePrefix: 'cdkd' }).load('TargetStack', REGION)) as
    | { outputs: Record<string, string> }
    | undefined;

describe('S3LocalStateProvider repairs a malformed outputs bag (go-to-k/cdkd#3207)', () => {
  beforeEach(() => {
    mocks.loadStateForStackMock.mockReset();
    mocks.warnMock.mockReset();
  });

  const MALFORMED: Array<[string, unknown]> = [
    ['a string bag', 'abcdef'],
    ['a list bag', ['a', 'b']],
    ['a null bag', null],
    ['a number bag', 5],
    ['a boolean bag', true],
  ];

  for (const [label, bag] of MALFORMED) {
    it(`reads ${label} as EMPTY and names the record`, async () => {
      mocks.loadStateForStackMock.mockResolvedValue(loaded(bag));
      const record = await load();
      // The DISCRIMINATOR: the pre-fix walk produced `{'0':'a', ..., '5':'f'}`
      // for the string and `{'0':'a','1':'b'}` for the list. An empty map is
      // what the repair yields, and no other outcome does.
      expect(record?.outputs).toEqual({});
      expect(
        warned(),
        'the damaged record was emptied SILENTLY, which reads as "this stack publishes none"'
      ).toContain('TargetStack');
      expect(warned()).toContain("no readable 'outputs' map");
    });
  }

  // THE OTHER DIRECTION.
  it('coerces a healthy bag unchanged and warns about nothing', async () => {
    mocks.loadStateForStackMock.mockResolvedValue(
      loaded({ Str: 'v', Num: 7, Bool: false, Obj: { a: 1 } })
    );
    const record = await load();
    expect(record?.outputs).toEqual({
      Str: 'v',
      Num: '7',
      Bool: 'false',
      Obj: JSON.stringify({ a: 1 }),
    });
    expect(warned()).toBe('');
  });

  it('stays silent on an EMPTY bag and on an ABSENT one', async () => {
    mocks.loadStateForStackMock.mockResolvedValue(loaded({}));
    expect((await load())?.outputs).toEqual({});
    mocks.loadStateForStackMock.mockResolvedValue(loaded(undefined, { omitOutputs: true }));
    expect((await load())?.outputs).toEqual({});
    expect(
      warned(),
      'an empty or absent outputs bag is an ordinary record and must not be reported damaged'
    ).toBe('');
  });

  it('still returns undefined when there is no record at all', async () => {
    mocks.loadStateForStackMock.mockResolvedValue(undefined);
    expect(await load()).toBeUndefined();
    expect(warned()).toBe('');
  });
});
