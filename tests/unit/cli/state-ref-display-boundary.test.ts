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
 * Both are asserted at EVERY caller of the helper, not at the listing alone.
 * Guarding one site and leaving the rest is the per-site spelling that failed
 * twice (go-to-k/cdkd#2772, and the first cut of go-to-k/cdkd#3003), so the
 * population lives here as a TABLE: a new caller added to `state.ts` is a row
 * added here, and the floor below refuses a table that silently shrinks.
 *
 * The two CONFIRMATION PROMPTS left this helper for `describedStackRef`
 * (go-to-k/cdkd#3760): they sit beside a labelled pasteable line, where a
 * non-plain value is described rather than shown. Their own describe block is
 * at the end of this file.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setStdinIsTty } from '../../stdin-tty.js';

const infoSpy = vi.hoisted(() => vi.fn());
const warnSpy = vi.hoisted(() => vi.fn());
const errorSpy = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: infoSpy,
    warn: warnSpy,
    error: errorSpy,
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
  runWithStackAwsClients: (_clients: unknown, fn: () => unknown) => fn(),
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
const mockGetLockInfo = vi.fn<() => Promise<unknown>>();
vi.mock('../../../src/state/lock-manager.js', () => ({
  LockManager: vi.fn().mockImplementation(() => ({
    isLocked: mockIsLocked,
    forceReleaseLock: vi.fn(async () => {}),
    getLockInfo: mockGetLockInfo,
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
  loadProviderClasses: vi.fn(async () => ({})),
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
import { IDENT_MAX_CODE_POINTS, STACK_REF_MAX_CODE_POINTS, UNRENDERABLE, cutMarker } from '../../../src/utils/display-safe.js';

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

/** Run a command that REFUSES, and return the refusal `handleError` logged. */
async function refusalOf(args: string[]): Promise<string> {
  errorSpy.mockClear();
  await runState(args).catch(() => undefined);
  return errorSpy.mock.calls.map((c) => String(c[0])).join('\n');
}

/** Every line a logger spy received. */
function lines(spy: typeof infoSpy): string[] {
  return spy.mock.calls.map((c) => String(c[0]));
}

/** The last logger line at `spy` that starts with `prefix`, prefix removed. */
function lastLine(spy: typeof infoSpy, prefix: string): string {
  const line = spy.mock.calls
    .map((c) => String(c[0]))
    .filter((m) => m.startsWith(prefix))
    .at(-1);
  return (line ?? '').slice(prefix.length);
}

/**
 * One row per `formatStackRefSafe` caller in `src/cli/commands/state.ts`.
 * `render` drives the real command with a state bucket holding exactly ONE
 * ref and returns the reference string THAT site produced for it, with every
 * surrounding word of cdkd's own sentence stripped -- so the assertions below
 * compare the rendering itself rather than a substring of it.
 */
const SITES: Array<{
  name: string;
  regionOnly?: boolean;
  render: (ref: Ref) => Promise<string>;
}> = [
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
  // The sites below were raw or bare-allowlist renders until go-to-k/cdkd#3179.
  // `regionOnly`: the site never renders a region-LESS ref as this helper's
  // output (a legacy record takes a different refusal or wording there), so
  // the region-less rows of the cases below are skipped for it.
  {
    name: 'state resources (no-record refusal)',
    regionOnly: true,
    render: async (ref) => {
      mockListStacks.mockResolvedValue([ref]);
      mockGetState.mockResolvedValue(null);
      const message = await refusalOf(['resources', ref.stackName]);
      return /No state found for stack (.*) in s3:\/\//.exec(message)?.[1] ?? '';
    },
  },
  {
    name: 'state show (no-record refusal)',
    regionOnly: true,
    render: async (ref) => {
      mockListStacks.mockResolvedValue([ref]);
      mockGetState.mockResolvedValue(null);
      const message = await refusalOf(['show', ref.stackName]);
      return /No state found for stack (.*) in s3:\/\//.exec(message)?.[1] ?? '';
    },
  },
  {
    name: 'state destroy (preparing line)',
    render: async (ref) => {
      mockListStacks.mockResolvedValue([ref]);
      // No record at the read: the command skips the stack after naming it,
      // so no destroy runs.
      mockGetState.mockResolvedValue(null);
      await runState(['destroy', ref.stackName, '--yes']);
      return lastLine(infoSpy, '\nPreparing to destroy stack: ');
    },
  },
  {
    name: 'state refresh-observed (per-stack line)',
    regionOnly: true,
    render: async (ref) => {
      mockListStacks.mockResolvedValue([ref]);
      // An empty bag: the per-stack line names the record and skips it.
      mockGetState.mockResolvedValue({ state: { resources: {} } });
      await runState(['refresh-observed', '--all', '--yes']);
      const line = lastLine(infoSpy, '✓ ');
      return line.slice(0, line.lastIndexOf(': no resources in state'));
    },
  },
];

/**
 * The floor. `formatStackRefSafe` had six callers when issue #3164 landed and
 * seven since go-to-k/cdkd#3179 (every `state orphan` line and the
 * refresh-observed prompt left it for `describedStackRef`, and five raw or
 * bare-allowlist sites joined it); the table
 * above is the claim that all of them are covered. A row silently dropped
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
const EXPECTED_SITE_COUNT = 7;

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

/**
 * PADDING spoofs -- a strictly SIMPLER input than the annotation-carrying one
 * above, and the one the first cut of this fix left open (issue #3164 review).
 *
 * `displaySafe` maps every non-printable-ASCII character to a space and then
 * TRIMS, so padding is erased BEFORE the plain-identifier test runs: a planted
 * `cdkd/ProdStack /us-east-1/state.json` -- one trailing space -- used to test
 * as plain, render UNQUOTED, and print byte-identical to the genuine
 * `ProdStack` in `us-east-1`. `listStacks` dedupes on `stackName\0region`, so
 * BOTH refs reach the output and a `sort -u`-ing cleanup loop collapses them:
 * verbatim the harm this issue is about, from a one-character input.
 *
 * Spelled with escapes, never raw bytes -- a raw NUL makes grep treat this file
 * as binary (`tests/unit/scripts/source-control-bytes.test.ts`).
 */
const PADDING_SPOOFS: Array<{ label: string; ref: Ref }> = [
  { label: 'trailing space in the name', ref: { stackName: 'ProdStack ', region: 'us-east-1' } },
  { label: 'leading space in the name', ref: { stackName: ' ProdStack', region: 'us-east-1' } },
  { label: 'tab-wrapped name', ref: { stackName: '\tProdStack\t', region: 'us-east-1' } },
  { label: 'NUL-wrapped name', ref: { stackName: '\u0000ProdStack\u0000', region: 'us-east-1' } },
  { label: 'ESC-wrapped name', ref: { stackName: '\u001bProdStack\u001b', region: 'us-east-1' } },
  { label: 'padded region', ref: { stackName: 'ProdStack', region: ' us-east-1 ' } },
];

describe('every state-list / prompt reference renders its own boundary (issue #3164)', () => {
  let originalIsTty: boolean | undefined;
  let exitSpy: ReturnType<typeof vi.spyOn>;

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
    warnSpy.mockReset();
    errorSpy.mockReset();
    mockGetLockInfo.mockReset();
    mockGetLockInfo.mockResolvedValue(null);
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit-mock');
    }) as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    setStdinIsTty(originalIsTty);
    vi.clearAllMocks();
  });

  it('covers every formatStackRefSafe caller', () => {
    expect(SITES).toHaveLength(EXPECTED_SITE_COUNT);
    expect(new Set(SITES.map((s) => s.name)).size).toBe(EXPECTED_SITE_COUNT);
  });

  it('and state.ts names formatStackRefSafe in CODE exactly 1 + EXPECTED_SITE_COUNT times', () => {
    const source = readFileSync(STATE_TS, 'utf-8');

    // Strip comments FIRST, then count every remaining mention of the name.
    //
    // Counting `formatStackRefSafe\s*[()]` was the first attempt and it is
    // defeatable in the direction that matters: `const render =
    // formatStackRefSafe;` followed by `render(ref)` adds a rendering site and
    // matches neither the call shape nor the declaration, so the fence stayed
    // green (measured). It also reddened on a pure PROSE edit, because the doc
    // comments name the helper repeatedly. Counting BARE references over
    // comment-stripped source fixes both: an alias, an `?.()` call and a plain
    // call all count, and no amount of comment rewriting moves the number.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    const references = code.match(/\bformatStackRefSafe\b/g) ?? [];
    const declarations = code.match(/\bfunction\s+formatStackRefSafe\b/g) ?? [];

    // Prove the scan SAW its input before trusting its verdict. Both floors are
    // about the STRIPPER, which is the part that can silently eat everything:
    // if it removed the code as well as the comments, `code` would be short and
    // the declaration would be gone, and the equality below would still be
    // satisfiable by 0 === 0 + 0 had it been written as a subtraction.
    expect(code.length).toBeGreaterThan(50_000);
    expect(declarations).toHaveLength(1);
    expect(code).toContain('function formatStackRefSafe');

    expect(references).toHaveLength(declarations.length + EXPECTED_SITE_COUNT);
  });

  it('the comment stripper does not remove code', () => {
    // Guarding the guard: the fence above is only as good as its stripper, and
    // a stripper that ate a line containing a call would UNDER-count and read
    // as "no new caller". Pin it on inputs whose answer is known by eye,
    // including the shape that makes a naive `//` rule wrong -- a `://` inside
    // a URL string.
    const strip = (s: string): string =>
      s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

    expect(strip('a(); // formatStackRefSafe\nb();')).toBe('a(); \nb();');
    expect(strip('/* formatStackRefSafe */ keep();')).toBe(' keep();');
    expect(strip("const u = 'https://x/y'; call();")).toBe("const u = 'https://x/y'; call();");
  });

  describe('a legitimate row is byte-identical', () => {
    for (const site of SITES) {
      it(`${site.name}`, async () => {
        for (const { ref, expected } of LEGIT) {
          if (site.regionOnly && ref.region === undefined) continue;
          // eslint-disable-next-line no-await-in-loop
          const rendered = await site.render(ref);
          expect(rendered, `${site.name} rendered ${ref.stackName}`).toBe(expected);
        }
      });
    }
  });

  describe('a planted NAME carrying the (region) annotation cannot impersonate a real row', () => {
    // The spoof is a region-LESS ref by construction, so a `regionOnly` site
    // never renders it through this helper; the PADDED cases below reach
    // those sites' name half instead.
    for (const site of SITES.filter((s) => !s.regionOnly)) {
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

  describe('a PADDED name or region cannot impersonate a real row', () => {
    for (const site of SITES) {
      it(`${site.name}`, async () => {
        const genuine = await site.render(GENUINE);
        expect(genuine).toBe('ProdStack (us-east-1)');

        for (const { label, ref } of PADDING_SPOOFS) {
          // eslint-disable-next-line no-await-in-loop
          const spoof = await site.render(ref);
          // The discriminator: the bytes a `sort -u`-ing consumer compares.
          // Before the fix EVERY one of these equalled `genuine`, because
          // `displaySafe` trims the padding away before the plain-identifier
          // test decides whether to quote.
          expect(spoof, `${site.name} / ${label}`).not.toBe(genuine);
          // ...and because the value is QUOTED, not because it was mangled
          // into some third shape.
          expect(spoof, `${site.name} / ${label}`).toContain('"');
        }
      });
    }
  });

  it('a padded name is quoted at the exact boundary the trim would have erased', async () => {
    // The shape assertion behind the non-collision above: the quotes sit around
    // the TRIMMED text, so the row still reads honestly while no longer
    // matching the genuine one byte for byte.
    expect(await SITES[0]!.render({ stackName: 'ProdStack ', region: 'us-east-1' })).toBe(
      '"ProdStack" (us-east-1)'
    );
    expect(await SITES[0]!.render({ stackName: 'ProdStack', region: ' us-east-1 ' })).toBe(
      'ProdStack ("us-east-1")'
    );
  });

  it('caps a planted name rather than pushing the genuine (region) off the line', async () => {
    const long = `A${'b'.repeat(STACK_REF_MAX_CODE_POINTS)}`;
    const rendered = await SITES[0]!.render({ stackName: long, region: 'us-east-1' });

    expect(rendered.endsWith(' (us-east-1)')).toBe(true);
    // One code point over the cap, so exactly one is withheld.
    expect(rendered).toContain(cutMarker(1, 'b'));
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
    expect(rendered).toContain(cutMarker(10, 'z'.repeat(10)));
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
});

/**
 * The two CONFIRMATION PROMPTS (go-to-k/cdkd#3760, the maintainer's option 1).
 * Each sits beside a labelled pasteable line -- `state orphan`'s
 * `Destroy with:`, `state refresh-observed`'s legacy `Migrate with:` -- where
 * `displayIdent`'s boundary is not enough: it keeps interior spaces, so a
 * planted value padded to the terminal width WRAPS into a counterfeit
 * labelled row. So each half is shown only when `isPasteableIdent` admits it
 * and described otherwise.
 */
const PROMPTS: Array<{
  name: string;
  /** Renders ONE ref per line, so the joined-list case does not apply. */
  perRef?: boolean;
  /** Renders a region-less ref in its own wording (`(legacy lock key)`). */
  regionOnly?: boolean;
  render: (refs: Ref[]) => Promise<string>;
}> = [
  {
    // After the operator's `y`: the line lands just below the banner's
    // `Destroy with:` row (the go-to-k/cdkd#4004 security review).
    name: 'state orphan (removal confirmation line)',
    perRef: true,
    render: async (refs) => {
      mockListStacks.mockResolvedValue(refs);
      mockIsLocked.mockResolvedValue(false);
      readlineQuestion.mockResolvedValue('y');
      await runState(['orphan', refs[0]!.stackName]);
      // The reference only: the pointer a described target adds is pinned by
      // its own cases below.
      return lastLine(infoSpy, '✓ Removed state for stack: ');
    },
  },
  {
    name: 'state orphan (live-lock warning)',
    perRef: true,
    regionOnly: true,
    render: async (refs) => {
      mockListStacks.mockResolvedValue(refs);
      mockIsLocked.mockResolvedValue(false);
      mockGetLockInfo.mockResolvedValue({
        owner: 'someone@host:1',
        operation: 'deploy',
        expiresAt: Date.now() + 60_000,
      });
      await runState(['orphan', refs[0]!.stackName, '--yes']);
      const line = lastLine(warnSpy, 'Force-releasing a LIVE lock on ');
      return line.slice(0, line.lastIndexOf(' held by '));
    },
  },
  {
    name: 'state orphan (warning banner + prompt)',
    render: async (refs) => {
      mockListStacks.mockResolvedValue(refs);
      mockIsLocked.mockResolvedValue(false);
      readlineQuestion.mockResolvedValue('n');
      const out = await runState(['orphan', refs[0]!.stackName]);
      const banner = /removes cdkd's state record for \[(.*)\] only\./.exec(out)?.[1] ?? '';
      // The prompt renders the SAME string, so a forged entry would land in
      // whichever of the two the operator is reading.
      const prompt = readlineQuestion.mock.calls.at(-1)?.[0] ?? '';
      expect(prompt.startsWith(`Remove state for ${banner} from s3://`)).toBe(true);
      return banner;
    },
  },
  {
    name: 'state refresh-observed (prompt)',
    render: async (refs) => {
      mockListStacks.mockResolvedValue(refs);
      readlineQuestion.mockResolvedValue('n');
      await runState(['refresh-observed', '--all']);
      const prompt = readlineQuestion.mock.calls.at(-1)?.[0] ?? '';
      const head = `Refresh observedProperties for ${refs.length} stack(s) (`;
      const end = prompt.lastIndexOf(')?');
      return prompt.startsWith(head) && end > head.length ? prompt.slice(head.length, end) : '';
    },
  },
];

describe('the two confirmation prompts describe a non-plain name or region (go-to-k/cdkd#3760)', () => {
  let originalIsTty: boolean | undefined;

  beforeEach(() => {
    originalIsTty = process.stdin.isTTY;
    setStdinIsTty(true);
    mockListStacks.mockReset();
    mockIsLocked.mockReset();
    mockVerifyBucketExists.mockReset();
    mockVerifyBucketExists.mockResolvedValue();
    mockDeleteState.mockReset();
    mockDeleteState.mockResolvedValue();
    mockDeleteLegacyState.mockReset();
    mockDeleteLegacyState.mockResolvedValue();
    mockGetLockInfo.mockReset();
    mockGetLockInfo.mockResolvedValue(null);
    readlineQuestion.mockReset();
    infoSpy.mockReset();
    warnSpy.mockReset();
  });

  afterEach(() => {
    setStdinIsTty(originalIsTty);
    vi.clearAllMocks();
  });

  for (const site of PROMPTS) {
    it(`${site.name}: a legitimate reference is byte-identical`, async () => {
      for (const { ref, expected } of LEGIT) {
        if (site.regionOnly && ref.region === undefined) continue;
        // eslint-disable-next-line no-await-in-loop
        expect(await site.render([ref]), `${site.name} rendered ${ref.stackName}`).toBe(expected);
      }
    });

    it(`${site.name}: a planted name or region is described, never shown`, async () => {
      if (!site.regionOnly) {
        expect(await site.render([NAME_SPOOF])).toBe('a stack name that is not a plain identifier');
      }
      expect(await site.render([REGION_SPOOF])).toBe(
        'Decoy (a region that is not a plain identifier)'
      );
      for (const { label, ref } of PADDING_SPOOFS) {
        // eslint-disable-next-line no-await-in-loop
        const rendered = await site.render([ref]);
        expect(rendered, label).toContain('that is not a plain identifier');
        expect(rendered, label).not.toBe('ProdStack (us-east-1)');
      }
    });

    it(`${site.name}: a region padded to wrap cannot print a counterfeit labelled row`, async () => {
      // The go-to-k/cdkd#3755 security review's shape: a `*`-free REGION
      // segment whose padding puts a forged `Destroy with:` row at column 0 of
      // a terminal wrapped at the width the attacker guessed.
      const rendered = await site.render([{ stackName: 'Decoy', region: WRAPPING_REGION }]);

      expect(rendered).toBe('Decoy (a region that is not a plain identifier)');
      expect(rendered).not.toContain('Destroy with:');
    });

    it.skipIf(site.perRef === true)(`${site.name}: a bare comma cannot forge an extra list entry (go-to-k/cdkd#3179)`, async () => {
      // `ProdStack,` beside the formatter's own ` (region)` read as
      // `ProdStack, (us-east-1)` -- THREE entries in a two-target list. A
      // described half carries no `,`.
      const rendered = await site.render([
        { stackName: 'ProdStack,', region: 'us-east-1' },
        { stackName: 'ProdStack,', region: 'us-west-2' },
      ]);
      expect(rendered).toBe(
        'a stack name that is not a plain identifier (us-east-1), ' +
          'a stack name that is not a plain identifier (us-west-2)'
      );
    });
  }

  it('state orphan: the banner points at state list --long when a target is described, and only then', async () => {
    mockIsLocked.mockResolvedValue(false);
    readlineQuestion.mockResolvedValue('n');
    // Two records of one stack whose regions both describe the same way.
    mockListStacks.mockResolvedValue([
      { stackName: 'S', region: 'us-east-1 (a)' },
      { stackName: 'S', region: 'us-east-1 (b)' },
    ]);
    const described = await runState(['orphan', 'S']);
    expect(described).toContain(
      'AWS resources will NOT be deleted. ' + "'cdkd state list --long' shows the records as stored.\n"
    );

    mockListStacks.mockResolvedValue([{ stackName: 'S', region: 'us-east-1' }]);
    const plain = await runState(['orphan', 'S']);
    expect(plain).toContain('AWS resources will NOT be deleted.\n');
    expect(plain).not.toContain('state list --long');
  });

  it('state refresh-observed: the prompt is preceded by the pointer when a target is described, and only then', async () => {
    readlineQuestion.mockResolvedValue('n');
    mockListStacks.mockResolvedValue([{ stackName: 'S', region: 'us-east-1 (a)' }]);
    await runState(['refresh-observed', '--all']);
    expect(lines(infoSpy)).toContain("'cdkd state list --long' shows the records as stored.");

    infoSpy.mockClear();
    mockListStacks.mockResolvedValue([{ stackName: 'S', region: 'us-east-1' }]);
    await runState(['refresh-observed', '--all']);
    expect(lines(infoSpy).join('\n')).not.toContain('state list --long');
  });

  it('state orphan: the cancelled line describes a non-plain name', async () => {
    mockListStacks.mockResolvedValue([{ stackName: 'Decoy (x)', region: 'us-east-1' }]);
    mockIsLocked.mockResolvedValue(false);
    readlineQuestion.mockResolvedValue('n');
    await runState(['orphan', 'Decoy (x)']);
    // No pointer here: the banner above it already printed one.
    expect(lines(infoSpy)).toContain(
      'Cancelled removal of state for stack: a stack name that is not a plain identifier'
    );
    expect(lines(infoSpy).join('\n')).not.toContain('state list --long');
  });

  it('state orphan: the cancelled line carries no pointer for a plain name either', async () => {
    mockListStacks.mockResolvedValue([{ stackName: 'S', region: 'us-east-1' }]);
    mockIsLocked.mockResolvedValue(false);
    readlineQuestion.mockResolvedValue('n');
    await runState(['orphan', 'S']);
    expect(lines(infoSpy)).toContain('Cancelled removal of state for stack: S');
    expect(lines(infoSpy).join('\n')).not.toContain('state list --long');
  });

  it('state orphan --yes: the removal line carries the pointer for a described target, and only then', async () => {
    // No banner prints under `--yes`, so this line is where the route to the
    // records as stored has to be.
    mockIsLocked.mockResolvedValue(false);
    mockListStacks.mockResolvedValue([{ stackName: 'S', region: 'us-east-1 (a)' }]);
    await runState(['orphan', 'S', '--yes']);
    expect(lines(infoSpy)).toContain(
      `✓ Removed state for stack: S (a region that is not a plain identifier). ${POINTER}`
    );

    infoSpy.mockClear();
    mockListStacks.mockResolvedValue([{ stackName: 'S', region: 'us-east-1' }]);
    await runState(['orphan', 'S', '--yes']);
    expect(lines(infoSpy)).toContain('✓ Removed state for stack: S (us-east-1)');
    expect(lines(infoSpy).join('\n')).not.toContain('state list --long');
  });

  it('state orphan, answered y: the removal line carries no pointer (the banner printed it)', async () => {
    mockIsLocked.mockResolvedValue(false);
    readlineQuestion.mockResolvedValue('y');
    mockListStacks.mockResolvedValue([
      { stackName: 'S', region: 'us-east-1 (a)' },
      { stackName: 'S', region: 'us-east-1 (b)' },
    ]);
    const out = await runState(['orphan', 'S']);
    expect(out.match(/state list --long/g) ?? []).toHaveLength(1);
    const removed = lines(infoSpy).filter((l) => l.startsWith('✓ Removed state for stack: '));
    expect(removed).toHaveLength(2);
    for (const line of removed) expect(line).not.toContain('state list --long');
  });

  it('a described NAME with a plain region switches the pointer on at both prompts', async () => {
    mockIsLocked.mockResolvedValue(false);
    readlineQuestion.mockResolvedValue('n');
    mockListStacks.mockResolvedValue([{ stackName: 'Decoy (x)', region: 'us-east-1' }]);
    const banner = await runState(['orphan', 'Decoy (x)']);
    expect(banner).toContain(`AWS resources will NOT be deleted. ${POINTER}\n`);

    infoSpy.mockClear();
    await runState(['refresh-observed', '--all']);
    expect(lines(infoSpy)).toContain(POINTER);
  });

  for (const answer of ['n', 'y']) {
    it(`state orphan (answer ${answer}): stdout and every logger line carry exactly ONE Destroy with: row`, async () => {
      // Answering `y` too, with the logger lines: the removal line and the
      // live-lock warning print after the prompt, just below the real row
      // (the go-to-k/cdkd#4004 security review).
      mockListStacks.mockResolvedValue([{ stackName: 'Decoy', region: WRAPPING_REGION }]);
      mockIsLocked.mockResolvedValue(false);
      mockGetLockInfo.mockResolvedValue({
        owner: 'someone@host:1',
        operation: 'deploy',
        expiresAt: Date.now() + 60_000,
      });
      readlineQuestion.mockResolvedValue(answer);
      const out = await runState(['orphan', 'Decoy']);
      const logged = [...lines(infoSpy), ...lines(warnSpy)].join('\n');
      const all = `${out}\n${logged}`;

      expect(all.match(/Destroy with:/g) ?? []).toHaveLength(1);
      expect(out).toContain('\nDestroy with: cdkd destroy Decoy --state-bucket test-bucket\n');
      expect(all).not.toContain('--all --force');
      if (answer === 'y') {
        expect(logged).toContain('✓ Removed state for stack: Decoy (a region that is not a plain identifier)');
        expect(logged).toContain('Force-releasing a LIVE lock on Decoy (a region that is not a plain identifier)');
      } else {
        expect(logged).toContain('Cancelled removal of state for stack: Decoy');
      }
    });
  }
});

/** The sentence a message adds when it described a value. */
const POINTER = "'cdkd state list --long' shows the records as stored.";

/** A region segment padded so its tail wraps to column 0 as a labelled row. */
const WRAPPING_REGION = `x${' '.repeat(80)}Destroy with: cdkd destroy --all --force #`;
