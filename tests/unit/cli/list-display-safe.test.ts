/**
 * `cdkd list` renders no manifest-derived value raw (issue go-to-k/cdkd#3479).
 *
 * This is the most reachable render of the class in cdkd: the default mode
 * writes one display id per line to STDOUT at default verbosity with no error
 * path involved, so `cdkd list -a ./cdk.out` over someone else's assembly
 * prints it. `--long` / `--show-dependencies` are no safer for being structured
 * — measured, not assumed: `JSON.stringify` escapes C0 (below `U+0020`) and
 * nothing above it, so DEL, the C1 range, `U+2028` and the bidi overrides all
 * pass through; `yaml` escapes ESC and likewise passes DEL, C1 and `U+2028`.
 *
 * `displaySafe` rather than `describeStack` (which sanitizes the same two fields
 * for every other command) is deliberate; the reasons are at `formatDisplayId`.
 * The cases below pin the consequence: the field ORDER stays display-path-first,
 * and a legitimate name with a space is NOT quoted.
 *
 * Both polarities per site; the hostile cases carry a DISTINCT marker per
 * interpolated value.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';

const mockSynthesize = vi.fn();
vi.mock('../../../src/synthesis/synthesizer.js', () => ({
  Synthesizer: vi.fn().mockImplementation(() => ({ synthesize: mockSynthesize })),
}));

const mockResolveApp = vi.fn();
vi.mock('../../../src/cli/config-loader.js', () => ({
  resolveApp: (cliApp?: string) => mockResolveApp(cliApp),
}));

vi.mock('../../../src/utils/logger.js', () => ({
  reserveStdoutForPayload: vi.fn(),
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    setLevel: vi.fn(),
  }),
}));

import { createListCommand } from '../../../src/cli/commands/list.js';
import {
  CSI,
  hasForgingCharacter,
  LINE_SEP,
  NEL,
  RLO,
  ST,
  ZWSP,
} from '../_forging-characters.js';

/** One hostile marker per interpolated value, each with its own sanitized twin. */
const HOSTILE = {
  displayName: { raw: `MyStage/${CSI}Api`, clean: 'MyStage/ Api' },
  stackName: { raw: `MyStage-${NEL}Api`, clean: 'MyStage- Api' },
  account: { raw: `1111${LINE_SEP}11111111`, clean: '1111 11111111' },
  region: { raw: `us-${RLO}east-1`, clean: 'us- east-1' },
  dependency: { raw: `Dep${ST}Stack`, clean: 'Dep Stack' },
} as const;

function makeStack(overrides: Partial<StackInfo> & { stackName: string }): StackInfo {
  return {
    artifactId: overrides.stackName,
    displayName: overrides.displayName ?? overrides.stackName,
    template: { Resources: {} },
    dependencyNames: [],
    region: 'us-east-1',
    account: '111111111111',
    ...overrides,
  } as StackInfo;
}

async function runList(args: string[]): Promise<string> {
  const cmd = createListCommand();
  cmd.exitOverride();
  const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  try {
    await cmd.parseAsync(args, { from: 'user' });
    return writeSpy.mock.calls.map((call) => String(call[0])).join('');
  } finally {
    // Restore even when the run throws — a leaked stdout spy silences every
    // later test in the file, including the failure report.
    writeSpy.mockRestore();
  }
}

/**
 * Assert per LINE rather than over the whole payload: cdkd's own line
 * terminators are C0 characters, so a whole-payload check would fail on the
 * separators the command legitimately writes.
 */
function expectNoForgingLine(payload: string): void {
  for (const line of payload.split('\n')) expect(hasForgingCharacter(line)).toBe(false);
}

function primeStacks(stacks: StackInfo[]): void {
  mockSynthesize.mockResolvedValue({
    stacks,
    manifest: {},
    assemblyDir: '/tmp/cdk.out',
    failedStages: [],
  });
}

beforeEach(() => {
  mockSynthesize.mockReset();
  mockResolveApp.mockReset();
  mockResolveApp.mockReturnValue('node app.ts');
});

describe('cdkd list renders manifest-derived values display-safe (#3479)', () => {
  describe('the default mode — one display id per line on STDOUT, normal run', () => {
    it('sanitizes the display path and the physical name, distinct markers per value', async () => {
      primeStacks([
        makeStack({
          stackName: HOSTILE.stackName.raw,
          displayName: HOSTILE.displayName.raw,
        }),
      ]);
      const stdout = await runList([]);
      expect(stdout).toBe(`${HOSTILE.displayName.clean} (${HOSTILE.stackName.clean})\n`);
      expectNoForgingLine(stdout);
    });

    it('keeps the display path FIRST — the shape `describeStack` would have inverted', async () => {
      primeStacks([makeStack({ stackName: 'MyStage-Api', displayName: 'MyStage/Api' })]);
      expect(await runList([])).toBe('MyStage/Api (MyStage-Api)\n');
    });

    it('leaves a legitimate name carrying a SPACE unquoted, unlike displayIdent', async () => {
      // `new Stack(app, 'My Stack')` is legal — `constructs` rewrites only `/`.
      primeStacks([makeStack({ stackName: 'MyStack', displayName: 'My Stack' })]);
      expect(await runList([])).toBe('My Stack (MyStack)\n');
    });

    it('leaves a plain stack name byte-identical', async () => {
      primeStacks([makeStack({ stackName: 'StackA', displayName: 'StackA' })]);
      expect(await runList([])).toBe('StackA\n');
    });
  });

  describe('the display-path/physical-name equality test stays on the RAW values', () => {
    it('still prints BOTH names when two names differ only in what sanitization removes', async () => {
      // Comparing the SANITIZED forms would collapse these into one printed
      // name, hiding that the manifest carries two different values.
      primeStacks([
        makeStack({ stackName: `A${NEL}B`, displayName: `A${CSI}B` }),
      ]);
      expect(await runList([])).toBe('A B (A B)\n');
    });
  });

  describe('--long --json — the structured payload its encoder does NOT protect', () => {
    it('sanitizes id, name, account, region and every dependency name', async () => {
      primeStacks([
        makeStack({
          stackName: HOSTILE.stackName.raw,
          displayName: HOSTILE.displayName.raw,
          account: HOSTILE.account.raw,
          region: HOSTILE.region.raw,
          dependencyNames: [HOSTILE.dependency.raw],
        }),
      ]);
      const stdout = await runList(['--long', '--show-dependencies', '--json']);
      expect(JSON.parse(stdout)).toEqual([
        {
          id: HOSTILE.displayName.clean,
          name: HOSTILE.stackName.clean,
          environment: { account: HOSTILE.account.clean, region: HOSTILE.region.clean },
          dependencies: [HOSTILE.dependency.clean],
        },
      ]);
      expectNoForgingLine(stdout);
    });

    it('leaves an ordinary record byte-identical', async () => {
      primeStacks([
        makeStack({
          stackName: 'MyStage-Api',
          displayName: 'MyStage/Api',
          account: '111111111111',
          region: 'us-east-1',
          dependencyNames: ['MyStage-Db'],
        }),
        makeStack({ stackName: 'MyStage-Db', displayName: 'MyStage/Db' }),
      ]);
      const stdout = await runList(['--long', '--show-dependencies', '--json']);
      expect(JSON.parse(stdout)).toEqual([
        {
          id: 'MyStage/Db',
          name: 'MyStage-Db',
          environment: { account: '111111111111', region: 'us-east-1' },
          dependencies: [],
        },
        {
          id: 'MyStage/Api',
          name: 'MyStage-Api',
          environment: { account: '111111111111', region: 'us-east-1' },
          dependencies: ['MyStage-Db'],
        },
      ]);
    });
  });

  describe('an account and a region take the asciiOnly ALLOWLIST, not the denylist', () => {
    it('removes an invisible formatter the denylist keeps', async () => {
      // `displaySafe`'s denylist records the invisible formatters as a
      // RESIDUAL; `asciiOnly` is a positive allowlist and has none. A region and
      // an account id have a known ASCII charset, which is the case
      // `display-safe.ts`'s header asks for that mode.
      primeStacks([
        makeStack({
          stackName: 'StackA',
          account: `1111${ZWSP}11111111`,
          region: `us-east${ZWSP}-1`,
        }),
      ]);
      const stdout = await runList(['--long', '--json']);
      expect(JSON.parse(stdout)).toEqual([
        {
          id: 'StackA',
          name: 'StackA',
          environment: { account: '1111 11111111', region: 'us-east -1' },
        },
      ]);
    });

    it('leaves an ordinary account and region byte-identical', async () => {
      primeStacks([
        makeStack({ stackName: 'StackA', account: '111111111111', region: 'us-east-1' }),
      ]);
      const stdout = await runList(['--long', '--json']);
      expect(JSON.parse(stdout)).toEqual([
        {
          id: 'StackA',
          name: 'StackA',
          environment: { account: '111111111111', region: 'us-east-1' },
        },
      ]);
    });
  });

  describe('--show-dependencies without --long — the display id inside a payload', () => {
    it('sanitizes the id and every dependency name', async () => {
      primeStacks([
        makeStack({
          stackName: HOSTILE.stackName.raw,
          displayName: HOSTILE.displayName.raw,
          dependencyNames: [HOSTILE.dependency.raw],
        }),
      ]);
      const stdout = await runList(['--show-dependencies', '--json']);
      expect(JSON.parse(stdout)).toEqual([
        {
          id: `${HOSTILE.displayName.clean} (${HOSTILE.stackName.clean})`,
          dependencies: [HOSTILE.dependency.clean],
        },
      ]);
      expectNoForgingLine(stdout);
    });

    it('leaves an ordinary record byte-identical', async () => {
      primeStacks([makeStack({ stackName: 'StackA', dependencyNames: ['StackB'] }), makeStack({ stackName: 'StackB' })]);
      const stdout = await runList(['--show-dependencies', '--json']);
      expect(JSON.parse(stdout)).toEqual([
        { id: 'StackB', dependencies: [] },
        { id: 'StackA', dependencies: ['StackB'] },
      ]);
    });
  });
});
