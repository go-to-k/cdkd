import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
/**
 * Issue [#3164](https://github.com/go-to-k/cdkd/issues/3164): every `Stack
 * (region)` reference `src/cli/commands/state.ts` renders goes through
 * `formatStackRefSafe`, and that helper now renders BOTH halves with
 * `displayIdent` rather than the bare ASCII allowlist.
 *
 * Two properties, and the suite is arranged so that neither can pass
 * vacuously:
 *
 * 1. **Byte-identity on every legitimate row.** The allowlist was already the
 *    identity on printable ASCII, so a change that only ever ADDS quotes is
 *    indistinguishable from one that quotes too much unless the legitimate
 *    shapes are pinned EXACTLY -- `ProdStack`, `my-stack-1`, `Parent~Child`,
 *    `CdkdTest-abc_123`, every AWS region code. Anything else breaks a
 *    `cdkd state list | while read -r ref` consumer, which is the reader the
 *    sanitization exists for.
 * 2. **The spoof no longer collides.** A 2-segment legacy key
 *    `cdkd/ProdStack (us-east-1)/state.json` yields a region-LESS ref whose
 *    `stackName` is literally `ProdStack (us-east-1)`, which used to render
 *    byte-equal to the genuine `ProdStack` in `us-east-1`. The REGION half is
 *    the same boundary from the other side: a planted region `x) (us-east-1`
 *    made `Decoy` render as `Decoy (x) (us-east-1)`, reading as stack
 *    `Decoy (x)` in `us-east-1`.
 *
 * Both are asserted at ALL SIX callers of the helper, not at the listing
 * alone. Guarding one site and leaving five is the per-site spelling
 * `safe()`'s own doc comment records having failed twice (go-to-k/cdkd#2772,
 * and the first cut of go-to-k/cdkd#3003), so the population lives here as a
 * TABLE: a seventh caller added to `state.ts` is a row added here, and the
 * floor below refuses a table that silently shrinks.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setStdinIsTty } from '../../stdin-tty.js';

const infoSpy = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: infoSpy,
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  }),
  reserveStdoutForPayload: vi.fn(),
}));

vi.mock('../../../src/cli/config-loader.js', () => ({
  resolveStateBucketWithDefault: vi.fn(async () => 'test-bucket'),
}));

vi.mock('../../../src/utils/aws-clients.ts', () => ({
  AwsClients: vi.fn().mockImplementation(() => ({
    get s3() {
      return {};
    },
    destroy: vi.fn(),
  })),
  setAwsClients: vi.fn(),
  getAwsClients: vi.fn(),
}));

const mockListStacks =
  vi.fn<() => Promise<Array<{ stackName: string; region?: string }>>>();
const mockGetState = vi.fn<() => Promise<unknown>>();
const mockVerifyBucketExists = vi.fn<() => Promise<void>>();
const mockDeleteState = vi.fn<() => Promise<void>>();
const mockDeleteLegacyState = vi.fn<() => Promise<void>>();
vi.mock('../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn().mockImplementation(() => ({
    listStacks: mockListStacks,
    getState: mockGetState,
    verifyBucketExists: mockVerifyBucketExists,
    deleteState: mockDeleteState,
    deleteLegacyState: mockDeleteLegacyState,
  })),
}));

const mockIsLocked = vi.fn<() => Promise<boolean>>();
vi.mock('../../../src/state/lock-manager.js', () => ({
  LockManager: vi.fn().mockImplementation(() => ({
    isLocked: mockIsLocked,
    forceReleaseLock: vi.fn(async () => {}),
    getLockInfo: vi.fn(async () => null),
  })),
}));

// `state refresh-observed` builds a registry before its confirmation prompt.
// Every case here answers the prompt `n` (or reads it and aborts), so no
// provider is ever consulted -- the stub exists to keep the real registry's
// construction out of a display test.
vi.mock('../../../src/provisioning/provider-registry.js', () => ({
  ProviderRegistry: vi.fn().mockImplementation(() => ({
    setCustomResourceResponseBucket: vi.fn(),
  })),
}));
vi.mock('../../../src/provisioning/register-providers.js', () => ({
  registerAllProviders: vi.fn(),
}));

const readlineQuestion = vi.hoisted(() => vi.fn<(prompt: string) => Promise<string>>());
vi.mock('node:readline/promises', () => ({
  createInterface: vi.fn(() => ({
    question: readlineQuestion,
    close: vi.fn(),
  })),
}));

import { createStateCommand } from '../../../src/cli/commands/state.js';
import {
  IDENT_MAX_CODE_POINTS,
  STACK_REF_MAX_CODE_POINTS,
  UNRENDERABLE,
} from '../../../src/utils/display-safe.js';

interface Ref {
  stackName: string;
  region?: string;
}

function captureStdout(): { output: string[]; restore: () => void } {
  const output: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    output.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
    return true;
  }) as typeof process.stdout.write;
  return {
    output,
    restore: () => {
      process.stdout.write = original;
    },
  };
}

async function runState(args: string[]): Promise<string> {
  const cap = captureStdout();
  try {
    const cmd = createStateCommand();
    cmd.exitOverride();
    cmd.commands.forEach((sub) => sub.exitOverride());
    await cmd.parseAsync(args, { from: 'user' });
  } finally {
    cap.restore();
  }
  return cap.output.join('');
}

/**
 * One row per `formatStackRefSafe` caller in `src/cli/commands/state.ts`.
 * `render` drives the real command with a state bucket holding exactly ONE
 * ref and returns the reference string THAT site produced for it, with every
 * surrounding word of cdkd's own sentence stripped -- so the assertions below
 * compare the rendering itself rather than a substring of it.
 */
const SITES: Array<{ name: string; render: (ref: Ref) => Promise<string> }> = [
  {
    name: 'state list (plain listing)',
    render: async (ref) => {
      mockListStacks.mockResolvedValue([ref]);
      return (await runState(['list'])).trimEnd();
    },
  },
  {
    name: 'state list --long (header row)',
    render: async (ref) => {
      mockListStacks.mockResolvedValue([ref]);
      mockGetState.mockResolvedValue({ state: { resources: {}, lastModified: 0 } });
      mockIsLocked.mockResolvedValue(false);
      const out = await runState(['list', '--long']);
      return out.split('\n')[0]!;
    },
  },
  {
    name: 'state list --tree (node label)',
    render: async (ref) => {
      mockListStacks.mockResolvedValue([ref]);
      mockGetState.mockResolvedValue({ state: { resources: {}, lastModified: 0 } });
      return (await runState(['list', '--tree'])).trimEnd();
    },
  },
  {
    name: 'state orphan (confirmation prompt)',
    render: async (ref) => {
      mockListStacks.mockResolvedValue([ref]);
      mockIsLocked.mockResolvedValue(false);
      readlineQuestion.mockResolvedValue('n');
      await runState(['orphan', ref.stackName]);
      const prompt = readlineQuestion.mock.calls.at(-1)?.[0] ?? '';
      // Greedy: the reference itself may contain ` from s3://` only if an
      // attacker plants it, and the trailing literal is cdkd's own.
      return /^Remove state for (.*) from s3:\/\//.exec(prompt)?.[1] ?? '';
    },
  },
  {
    name: 'state orphan (removal confirmation line)',
    render: async (ref) => {
      mockListStacks.mockResolvedValue([ref]);
      mockIsLocked.mockResolvedValue(false);
      readlineQuestion.mockResolvedValue('y');
      await runState(['orphan', ref.stackName]);
      const line = infoSpy.mock.calls
        .map((c) => String(c[0]))
        .filter((m) => m.startsWith('✓ Removed state for stack: '))
        .at(-1);
      return (line ?? '').slice('✓ Removed state for stack: '.length);
    },
  },
  {
    name: 'state refresh-observed (confirmation prompt)',
    render: async (ref) => {
      mockListStacks.mockResolvedValue([ref]);
      readlineQuestion.mockResolvedValue('n');
      await runState(['refresh-observed', '--all']);
      const prompt = readlineQuestion.mock.calls.at(-1)?.[0] ?? '';
      return /^Refresh observedProperties for 1 stack\(s\) \((.*)\)\?/.exec(prompt)?.[1] ?? '';
    },
  },
];

/**
 * The floor. `formatStackRefSafe` had six callers when this fix landed; the
 * table above is the claim that all six are covered. A row silently dropped
 * (a merge, a rewrite) would leave the remaining cases green while testing
 * less, which is the failure this number exists to make loud. It is NOT
 * derived from the source, deliberately -- a population computed from the
 * subject cannot notice the subject shrinking.
 *
 * It is only HALF the fence, and on its own it is the weaker half: it catches
 * the table shrinking and cannot see the SOURCE growing. A seventh caller
 * added to `state.ts` would be rendered by the changed helper and exercised by
 * nothing here -- which is precisely the per-site miss this PR cites as having
 * happened twice. `formatStackRefSafe callers` below closes that direction by
 * counting the call sites in the source.
 */
const EXPECTED_SITE_COUNT = 6;

/**
 * Where the source population is read from. A literal path, not a glob: this
 * fence is a claim about ONE function in ONE file, and a walk that silently
 * matched nothing would be green.
 */
const STATE_TS = fileURLToPath(new URL('../../../src/cli/commands/state.ts', import.meta.url));

/**
 * Every shape a LEGITIMATE row takes. A top-level stack name comes from
 * CloudFormation; cdkd's own `deriveChildStackName` mints `Parent~Child` for a
 * nested-stack child; an AWS region code is `[a-z]+(-[a-z]+)+-\d`. The
 * underscore row is deliberate and is NOT a CloudFormation stack name: a state
 * record's first key segment is whatever `listStacks` read, and `_` is inside
 * `PLAIN_IDENT`, so a record carrying one must still render bare rather than
 * gaining quotes. All of these are plain identifiers, so all of them must
 * render VERBATIM.
 */
const LEGIT: Array<{ ref: Ref; expected: string }> = [
  { ref: { stackName: 'ProdStack', region: 'us-east-1' }, expected: 'ProdStack (us-east-1)' },
  { ref: { stackName: 'my-stack-1', region: 'ap-northeast-1' }, expected: 'my-stack-1 (ap-northeast-1)' },
  { ref: { stackName: 'Parent~Child', region: 'us-gov-west-1' }, expected: 'Parent~Child (us-gov-west-1)' },
  { ref: { stackName: 'CdkdTest-abc_123', region: 'eu-central-1' }, expected: 'CdkdTest-abc_123 (eu-central-1)' },
  { ref: { stackName: 'cn-stack', region: 'cn-northwest-1' }, expected: 'cn-stack (cn-northwest-1)' },
  // A legacy record carries no region at all: no annotation, so no boundary
  // to make visible, and the name must still render bare.
  { ref: { stackName: 'LegacyStack' }, expected: 'LegacyStack' },
];

/** The genuine row the two spoofs below try to impersonate. */
const GENUINE: Ref = { stackName: 'ProdStack', region: 'us-east-1' };

/**
 * A 2-segment legacy key `cdkd/ProdStack (us-east-1)/state.json`. `listStacks`
 * reads the first segment as the stack name and the body names no region, so
 * the ref is region-LESS and the whole annotation lives inside the name.
 */
const NAME_SPOOF: Ref = { stackName: 'ProdStack (us-east-1)' };

/**
 * The same attack from the right-hand side: the REGION is an S3 key segment
 * too (or, for a legacy record, the state body via `readLegacyRegion`), so a
 * planted `x) (us-east-1` renders `Decoy (x) (us-east-1)` and reads as stack
 * `Decoy (x)` in `us-east-1`.
 */
const REGION_SPOOF: Ref = { stackName: 'Decoy', region: 'x) (us-east-1' };
const REGION_SPOOF_TARGET: Ref = { stackName: 'Decoy (x)', region: 'us-east-1' };

describe('every state-list / prompt reference renders its own boundary (issue #3164)', () => {
  let originalIsTty: boolean | undefined;

  beforeEach(() => {
    originalIsTty = process.stdin.isTTY;
    setStdinIsTty(true);
    mockListStacks.mockReset();
    mockGetState.mockReset();
    mockIsLocked.mockReset();
    mockVerifyBucketExists.mockReset();
    mockVerifyBucketExists.mockResolvedValue();
    mockDeleteState.mockReset();
    mockDeleteState.mockResolvedValue();
    mockDeleteLegacyState.mockReset();
    mockDeleteLegacyState.mockResolvedValue();
    readlineQuestion.mockReset();
    infoSpy.mockReset();
  });

  afterEach(() => {
    setStdinIsTty(originalIsTty);
    vi.clearAllMocks();
  });

  it('covers every formatStackRefSafe caller', () => {
    expect(SITES).toHaveLength(EXPECTED_SITE_COUNT);
    expect(new Set(SITES.map((s) => s.name)).size).toBe(EXPECTED_SITE_COUNT);
  });

  it('and the SOURCE has no caller the table does not cover', () => {
    const source = readFileSync(STATE_TS, 'utf-8');

    // Count CALLS, not mentions: the declaration is `function
    // formatStackRefSafe(`, and the doc comments above it name the helper in
    // prose several times. A call is the identifier followed by `(` or, at the
    // two `.map(formatStackRefSafe)` sites, by `)`.
    const calls = source.match(/\bformatStackRefSafe\s*[()]/g) ?? [];
    const declarations = source.match(/\bfunction\s+formatStackRefSafe\s*\(/g) ?? [];

    // Prove the scan SAW its input before trusting its verdict: a regex that
    // silently stopped matching would report zero callers, which is green
    // against a `<=` and meaningless.
    expect(source.length).toBeGreaterThan(10_000);
    expect(declarations).toHaveLength(1);

    expect(calls.length - declarations.length).toBe(EXPECTED_SITE_COUNT);
  });

  describe('a legitimate row is byte-identical', () => {
    for (const site of SITES) {
      it(`${site.name}`, async () => {
        for (const { ref, expected } of LEGIT) {
          // eslint-disable-next-line no-await-in-loop
          const rendered = await site.render(ref);
          expect(rendered, `${site.name} rendered ${ref.stackName}`).toBe(expected);
        }
      });
    }
  });

  describe('a planted NAME carrying the (region) annotation cannot impersonate a real row', () => {
    for (const site of SITES) {
      it(`${site.name}`, async () => {
        const genuine = await site.render(GENUINE);
        const spoof = await site.render(NAME_SPOOF);

        // The discriminator, and the only one that matters: the two strings a
        // `while read -r ref` loop compares. Before the fix these were EQUAL.
        expect(spoof).not.toBe(genuine);
        // ...and specifically because the planted text is now inside a visible
        // boundary, not because it was mangled or dropped.
        expect(spoof).toBe('"ProdStack (us-east-1)"');
        expect(genuine).toBe('ProdStack (us-east-1)');
      });
    }
  });

  describe('a planted REGION carrying the annotation cannot impersonate a real row', () => {
    for (const site of SITES) {
      it(`${site.name}`, async () => {
        const target = await site.render(REGION_SPOOF_TARGET);
        const spoof = await site.render(REGION_SPOOF);

        expect(spoof).not.toBe(target);
        // BOTH sides gain a boundary here: the target's own name carries a
        // space, so quoting it is equally correct, and the two quoted forms
        // are distinct.
        expect(spoof).toBe('Decoy ("x) (us-east-1")');
        expect(target).toBe('"Decoy (x)" (us-east-1)');
      });
    }
  });

  it('caps a planted name rather than pushing the genuine (region) off the line', async () => {
    const long = `A${'b'.repeat(STACK_REF_MAX_CODE_POINTS)}`;
    const rendered = await SITES[0]!.render({ stackName: long, region: 'us-east-1' });

    expect(rendered.endsWith(' (us-east-1)')).toBe(true);
    // One code point over the cap, so exactly one is withheld.
    expect(rendered).toContain('[cut: 1 more characters withheld]');
    expect(rendered.startsWith(`A${'b'.repeat(STACK_REF_MAX_CODE_POINTS - 1)} [cut:`)).toBe(true);
  });

  it('does NOT cap the longest LEGITIMATE nested-stack chain', async () => {
    // `deriveChildStackName` appends `~<logicalId>` per nesting level, so a
    // state-record name is bounded by CloudFormation's NESTING limit (5 levels,
    // i.e. four `~` segments) and its 255-character logical id -- NOT by the
    // 128-character stack-name limit, and NOT by `displayIdent`'s 255 default.
    // Rendering this CUT would be a byte change on a legitimate row, which is
    // the property the whole boundary rendering rests on.
    const root = 'R'.repeat(128);
    const segment = `~${'L'.repeat(255)}`;
    const deepest = `${root}${segment.repeat(4)}`;
    expect(deepest).toHaveLength(STACK_REF_MAX_CODE_POINTS);

    const rendered = await SITES[0]!.render({ stackName: deepest, region: 'us-east-1' });

    expect(rendered).toBe(`${deepest} (us-east-1)`);
    expect(rendered).not.toContain('[cut:');
  });

  it('caps the REGION half at the ordinary identifier bound', async () => {
    // The region half keeps `displayIdent`'s default: an AWS region code is at
    // most 25 characters, so nothing legitimate is near it and a planted region
    // must not be able to run away with the line.
    const longRegion = 'z'.repeat(IDENT_MAX_CODE_POINTS + 10);
    const rendered = await SITES[0]!.render({ stackName: 'ProdStack', region: longRegion });

    expect(rendered.startsWith('ProdStack (')).toBe(true);
    expect(rendered).toContain('[cut: 10 more characters withheld]');
  });

  it('renders a value with nothing printable left as UNRENDERABLE, not as an empty gap', async () => {
    // `safe()`'s fallback, which `formatStackRefSafe` keeps: an empty `()`
    // would read as "no region" rather than "a region cdkd will not print".
    // Asserted through the command, not through `displayIdent` directly --
    // `display-safe.test.ts` already pins the helper; what is unpinned is that
    // the six sites still reach it.
    //
    // The bad value is spelled as an ESCAPE, never as a raw byte: a raw NUL
    // makes grep and rg treat this whole file as binary and skip it, which
    // `tests/unit/scripts/source-control-bytes.test.ts` refuses. Identical at
    // runtime -- the ASCII allowlist maps a control character to a space and
    // `displaySafe` trims, so nothing renderable is left.
    const nothingPrintable = '\u0000\u0007';

    const rendered = await SITES[0]!.render({ stackName: 'ProdStack', region: nothingPrintable });
    expect(rendered).toBe(`ProdStack (${UNRENDERABLE})`);

    const nameless = await SITES[0]!.render({ stackName: nothingPrintable, region: 'us-east-1' });
    expect(nameless).toBe(`${UNRENDERABLE} (us-east-1)`);
  });

  it('quotes an entry so a planted name cannot forge a second entry in a joined prompt list', async () => {
    // The two prompt sites `join(', ')`. Every case above renders ONE ref, so
    // the join itself never runs there; this is the case that exercises it.
    mockListStacks.mockResolvedValue([
      { stackName: 'Real', region: 'us-east-1' },
      { stackName: 'Planted, Victim (us-east-1)', region: 'us-west-2' },
    ]);
    readlineQuestion.mockResolvedValue('n');
    await runState(['refresh-observed', '--all']);

    const prompt = readlineQuestion.mock.calls.at(-1)?.[0] ?? '';
    const list = /^Refresh observedProperties for 2 stack\(s\) \((.*)\)\?/.exec(prompt)?.[1] ?? '';

    // Split the way a reader (or a consumer) would. Unquoted, the planted name
    // contributes TWO entries and the operator agrees to a set they did not
    // read; quoted, the `, ` inside it is visibly inside the boundary.
    expect(list).toBe('Real (us-east-1), "Planted, Victim (us-east-1)" (us-west-2)');
    expect(list.split(', ')).not.toHaveLength(2);
  });
});
