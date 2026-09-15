/**
 * Issue #2947: `cdkd state show` / `state resources` / `state list` over a state
 * or lock record whose SHAPE violates its declared types.
 *
 * Every case here drives the REAL `S3StateBackend` and the REAL `LockManager`
 * over a mocked S3 client that answers with raw bytes. That is deliberate and
 * is what the issue's verification plan asks for: `state-show.test.ts` mocks
 * `getState` and `getLockInfo` wholesale, and a mocked read skips exactly the
 * code this class lives in — `parseStateBody`'s version check, `getLockRecord`'s
 * normalisation — so a case built that way proves nothing about it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { NoSuchKey } from '@aws-sdk/client-s3';

const errorSpy = vi.hoisted(() => vi.fn());
const warnSpy = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/logger.js', () => ({
  reserveStdoutForPayload: vi.fn(),
  getLogger: () => ({
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: warnSpy,
    error: errorSpy,
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }),
}));

vi.mock('../../../src/cli/config-loader.js', () => ({
  resolveStateBucketWithDefault: vi.fn(async () => 'test-bucket'),
}));

// The client double below is standard-shaped, so `resolveExpectedBucketOwner`
// would otherwise issue a LIVE GetCallerIdentity.
vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: vi.fn().mockImplementation(() => ({
    send: vi.fn().mockResolvedValue({ Account: '999999999999' }),
    destroy: vi.fn(),
  })),
  GetCallerIdentityCommand: vi.fn().mockImplementation((input) => ({ ...input })),
}));

vi.mock('../../../src/utils/aws-region-resolver.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/utils/aws-region-resolver.js')>(
    '../../../src/utils/aws-region-resolver.js'
  );
  return { ...actual, resolveBucketRegion: vi.fn(async () => 'us-east-1') };
});

/** What the bucket holds for the one stack every case reads. */
const bucket = vi.hoisted(() => ({
  state: '',
  lock: undefined as string | undefined,
  /** Nested-child `state.json` bodies, keyed by the child's stack name. */
  children: {} as Record<string, string>,
}));
const s3Send = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/aws-clients.ts', () => ({
  AwsClients: vi.fn().mockImplementation(() => ({
    get s3() {
      return {
        send: s3Send,
        destroy: vi.fn(),
        config: {
          region: () => Promise.resolve('us-east-1'),
          credentials: () => Promise.resolve({ accessKeyId: 'AKIAFAKE', secretAccessKey: 'fake' }),
        },
      };
    },
    destroy: vi.fn(),
  })),
  setAwsClients: vi.fn(),
  getAwsClients: vi.fn(),
}));

/**
 * Counts invocations of `walkCdkdStateStackTree` — every node the nested-stack
 * walk enters, not just the top-level call.
 *
 * The walk is where the per-element allocation lives, and no assertion over
 * cdkd's OUTPUT can see it: for a plain string bag the walker finds no children
 * and the render is repaired afterwards either way, so a probe reverting the
 * guard leaves every output-shaped case GREEN (measured). "The walk did not
 * enter that node" is the only observable that discriminates.
 *
 * COUNTED VIA THE PREDICATE, and that indirection is the point. An earlier cut
 * wrapped `buildCdkdStateStackTree`, which is the TOP-LEVEL entry point called
 * exactly once per command — so it could not see the recursion, and the guard
 * it was fencing was itself at the root only. A healthy root naming a nested
 * child walked that child's bag unguarded, and this spy read 1 either way.
 * `walkCdkdStateStackTree` is module-private, but it calls
 * `hasReadableResources` exactly once on entry, and every OTHER caller a case
 * here can reach is accounted for, so this count is the per-node walk count
 * plus a known constant:
 *
 * - `repairMalformedResourcesForReadOnly` calls it INTERNALLY, which a module
 *   mock does not intercept, so those calls never reach the spy.
 * - `warnUnreadableTreeNodes` (`state.ts`) calls it once per node, and ONLY on
 *   the `--show-nested --json` path. That is why the nested-JSON cases halve
 *   the count they read; a case on any other path sees the walk alone. The
 *   earlier wording here said `state.ts` no longer calls it at all, which was
 *   false in exactly the direction that makes a halving look arbitrary.
 * - `repairRenderedContainers` (issue go-to-k/cdkd#3187) deliberately reads
 *   `isReadableBag` rather than this predicate, so it adds nothing here — a
 *   second caller would silently inflate every count below.
 */
const walkSpy = vi.hoisted(() => vi.fn());

vi.mock('../../../src/state/malformed-resources-bag.js', async () => {
  const actual =
    await vi.importActual<typeof import('../../../src/state/malformed-resources-bag.js')>(
      '../../../src/state/malformed-resources-bag.js'
    );
  return {
    ...actual,
    hasReadableResources: (...args: Parameters<typeof actual.hasReadableResources>) => {
      walkSpy();
      return actual.hasReadableResources(...args);
    },
  };
});

import { createStateCommand } from '../../../src/cli/commands/state.js';
import {
  malformedRenderedContainersWarning,
  malformedResourcesWarning,
} from '../../../src/state/malformed-resources-bag.js';

/**
 * Where the source-population fence below reads its subject from. A literal
 * path, not a glob: it is a claim about ONE function in ONE file, and a walk
 * that silently matched nothing would be green.
 */
const STATE_TS = fileURLToPath(new URL('../../../src/cli/commands/state.ts', import.meta.url));

/** Answer each command the real read path issues, by name and key. */
function route(command: { constructor: { name: string }; input: { Key?: string } }): unknown {
  const name = command.constructor.name;
  if (name === 'ListObjectsV2Command') {
    return { Contents: [{ Key: 'cdkd/MyStack/us-east-1/state.json' }], IsTruncated: false };
  }
  if (name === 'GetObjectCommand') {
    const key = command.input.Key ?? '';
    if (key.endsWith('/state.json')) {
      // `cdkd/<stack>/<region>/state.json`: a nested child is its own stack.
      //
      // A key that is NEITHER the root stack NOR a seeded child answers
      // NoSuchKey, the way the real bucket does. An earlier cut fell back to the
      // ROOT's body for every key, which made the harness answer a child lookup
      // with the parent's own record: under a bag that names children, the
      // walker then recursed forever and the worker died of heap exhaustion —
      // so a probe reverting the walk guard reported an OOM where production
      // raises `cdkd state is missing nested-child`. A mock must fail the way
      // production fails, or the failure mode a test pins is the mock's.
      const stack = key.split('/')[1] ?? '';
      const body = stack === 'MyStack' ? bucket.state : bucket.children[stack];
      if (body === undefined) throw new NoSuchKey({ message: 'NoSuchKey', $metadata: {} });
      return { Body: { transformToString: () => Promise.resolve(body) }, ETag: '"s"' };
    }
    if (key.endsWith('/lock.json')) {
      if (bucket.lock === undefined) throw new NoSuchKey({ message: 'NoSuchKey', $metadata: {} });
      const lock = bucket.lock;
      return { Body: { transformToString: () => Promise.resolve(lock) }, ETag: '"l"' };
    }
  }
  return {};
}

/** A well-formed record, with the fields a case breaks overridden. */
function record(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 2,
    stackName: 'MyStack',
    region: 'us-east-1',
    resources: {},
    outputs: {},
    lastModified: 0,
    ...overrides,
  });
}

async function runState(args: string[]): Promise<{ out: string; error: unknown }> {
  const output: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    output.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
    return true;
  }) as typeof process.stdout.write;
  let error: unknown;
  try {
    const cmd = createStateCommand();
    cmd.exitOverride();
    cmd.commands.forEach((sub) => sub.exitOverride());
    await cmd.parseAsync(args, { from: 'user' });
  } catch (e) {
    error = e;
  } finally {
    process.stdout.write = original;
  }
  return { out: output.join(''), error };
}

/** Everything a failing run said, wherever the error handler put it. */
function failureText(error: unknown): string {
  return [
    error instanceof Error ? error.message : String(error ?? ''),
    ...errorSpy.mock.calls.map((call) => call.map(String).join(' ')),
  ].join('\n');
}

// Ordinary JSON — and `String` / `Number` of it THROW, because ToPrimitive
// finds `valueOf` returning the object and `toString` not callable.
const UNCOERCIBLE = { toString: null };

// Built at runtime so this source file carries no raw control byte.
const ESC = String.fromCharCode(0x1b);

// `withErrorHandling` reports a failure by logging it and calling
// `process.exit(1)`; mocked to throw, as `state-show.test.ts` does, so a failed
// command REJECTS instead of ending the worker. That makes the oracle two-sided.
// An earlier cut of this file asserted only "no error was thrown" for the
// render cases, and with the exit unmocked the handler swallowed the failure:
// three of those cases passed against the UNFIXED source (measured).
let exitSpy: ReturnType<typeof vi.spyOn>;

/** The command RENDERED: nothing reached the error handler, nothing exited. */
function expectRendered(error: unknown): void {
  expect(exitSpy).not.toHaveBeenCalled();
  expect(errorSpy).not.toHaveBeenCalled();
  expect(error).toBeUndefined();
}

/** The command REFUSED — exit 1 with the reason logged — and what it said. */
function expectRefused(error: unknown): string {
  expect(exitSpy).toHaveBeenCalledWith(1);
  expect(errorSpy).toHaveBeenCalled();
  return failureText(error);
}

describe('state commands over a record no display guard reaches (issue #2947)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    errorSpy.mockReset();
    warnSpy.mockReset();
    walkSpy.mockReset();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit-mock');
    }) as never);
    bucket.state = record();
    bucket.lock = undefined;
    bucket.children = {};
    s3Send.mockImplementation(async (command) => route(command));
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  it('state show renders a null resource entry instead of aborting', async () => {
    bucket.state = record({ resources: { Broken: null } });

    const { out, error } = await runState(['show', 'MyStack']);

    expectRendered(error);
    // The SHAPE docs/cli-state.md promises, not just the id: the two fields
    // read `undefined` and the rest their defaults. `toContain('Broken')`
    // alone would still pass if the row rendered as `(unknown)` or dropped
    // every field.
    expect(out).toContain('Broken');
    expect(out).toContain('Type: undefined');
    expect(out).toContain('PhysicalID: undefined');
  });

  it('plain state show --json still reads that record — the comparand is preserved', async () => {
    // The one mode that already read such a record before this fix, so this
    // case passes on the unfixed source BY DESIGN: it pins that the fix did
    // not break it, rather than proving the fix.
    bucket.state = record({ resources: { Broken: null } });

    const { out, error } = await runState(['show', 'MyStack', '--json']);

    expectRendered(error);
    expect(JSON.parse(out).state.resources).toEqual({ Broken: null });
  });

  it.each([[[] as string[]], [['--long']], [['--json']]])(
    'state resources %j renders a null resource entry',
    async (flags) => {
      bucket.state = record({ resources: { Broken: null } });

      const { out, error } = await runState(['resources', 'MyStack', ...flags]);

      expectRendered(error);
      expect(out).toContain('Broken');
      if (flags.includes('--json')) {
        // The entry is LISTED with its absent fields absent — `JSON.stringify`
        // drops an `undefined` value — and the two defaulted ones present.
        const [row] = JSON.parse(out) as Array<Record<string, unknown>>;
        expect(row).toEqual({ logicalId: 'Broken', dependencies: [], attributes: {} });
      }
    }
  );

  // `undefined` is dropped by `JSON.stringify`, so that row is a record with no
  // `resources` key at all — the other half of what `?? {}` covers.
  it.each([
    ['null', null],
    ['absent', undefined],
  ])('state show --show-nested renders a record whose resources bag is %s', async (_, bag) => {
    bucket.state = record({ resources: bag });

    const { out, error } = await runState(['show', 'MyStack', '--show-nested']);

    expectRendered(error);
    expect(out).toContain('MyStack');
  });

  it('state show --show-nested walks past a null resource ENTRY', async () => {
    // The walker's own dereference, separate from the null BAG above: it read
    // `resourceType` on every entry to find nested stacks, and a null entry
    // threw there. A null entry is never a nested stack, so it is skipped.
    bucket.state = record({ resources: { Broken: null } });

    const { out, error } = await runState(['show', 'MyStack', '--show-nested']);

    expectRendered(error);
    expect(out).toContain('Broken');
  });

  it('state show --show-nested --json renders that null ENTRY too', async () => {
    // The second JSON walk `docs/cli-state.md` named as failing on a null
    // entry before this fix; the doc now says it renders, so this pins it.
    bucket.state = record({ resources: { Broken: null } });

    const { out, error } = await runState(['show', 'MyStack', '--show-nested', '--json']);

    expectRendered(error);
    expect(out).toContain('Broken');
  });

  it('state show --show-nested REFUSES a region-mismatched child by naming it, not with a TypeError', async () => {
    // The walker deliberately fails fast on a child whose recorded region is
    // not the parent's. That refusal is kept; what changes is its MESSAGE,
    // which interpolated the child's region and, for an uncoercible one, threw
    // a primitive-conversion TypeError instead of saying "region mismatch".
    bucket.state = record({
      resources: { Child: { resourceType: 'AWS::CloudFormation::Stack', physicalId: 'child-arn', properties: {} } },
    });
    bucket.children['MyStack~Child'] = record({ stackName: 'MyStack~Child', region: UNCOERCIBLE });

    const { error } = await runState(['show', 'MyStack', '--show-nested']);

    const text = expectRefused(error);
    expect(text).toContain('cdkd state region mismatch');
    expect(text).toContain("state.region='[object Object]'");
    expect(text).not.toMatch(/Cannot convert object to primitive value/);
  });

  it.each([
    ['null', null],
    ['absent', undefined],
  ])('state list --long counts the resources bag as zero when it is %s, instead of aborting', async (_, bag) => {
    bucket.state = record({ resources: bag });

    const { out, error } = await runState(['list', '--long']);

    expectRendered(error);
    expect(out).toContain('MyStack');
    expect(out).toContain('Resources: 0');
  });

  it('state show renders a lock whose expiresAt cannot be coerced', async () => {
    bucket.lock = JSON.stringify({ owner: 'u@h:1', timestamp: 1, expiresAt: UNCOERCIBLE });

    const { out, error } = await runState(['show', 'MyStack']);

    expectRendered(error);
    // The exact row `docs/cli-state.md` quotes: the NaN the read substitutes
    // is reported as an unknown deadline (issue #3083), never pushed through
    // `formatDuration` — which is what printed `expired NaNmNaNs ago`.
    expect(out).toContain('locked by u@h:1, expires at an unknown time');
    expect(out).not.toContain('NaN');
  });

  it('state show reports a merely non-finite expiresAt ({} / "soon") the same way (issue #3083)', async () => {
    // Neither value throws on coercion, so `getLockRecord` passes both through
    // as stored (go-to-k/cdkd#2947); the renderer is what must refuse the
    // arithmetic. Both are pinned because `{}` reaches `NaN` via ToPrimitive
    // and `"soon"` via ToNumber — two conversion paths, one verdict.
    for (const expiresAt of [{}, 'soon']) {
      vi.clearAllMocks();
      errorSpy.mockReset();
      s3Send.mockImplementation(async (command) => route(command));
      bucket.lock = JSON.stringify({ owner: 'u@h:1', timestamp: 1, expiresAt });
      const { out, error } = await runState(['show', 'MyStack']);
      expectRendered(error);
      expect(out).toContain('locked by u@h:1, expires at an unknown time');
      expect(out).not.toContain('NaN');
    }
  });

  const uncoercibleOwnerLock = (): string =>
    JSON.stringify({
      owner: UNCOERCIBLE,
      operation: UNCOERCIBLE,
      timestamp: 1,
      expiresAt: Date.now() + 60_000,
    });

  it('state show renders a lock whose owner and operation cannot be coerced', async () => {
    bucket.lock = uncoercibleOwnerLock();

    const { out, error } = await runState(['show', 'MyStack']);

    expectRendered(error);
    expect(out).toContain('locked by [object Object] (operation: [object Object])');
  });

  it('state show --json renders that lock too — the read threw before any renderer ran', async () => {
    bucket.lock = uncoercibleOwnerLock();

    const { out, error } = await runState(['show', 'MyStack', '--json']);

    expectRendered(error);
    expect(JSON.parse(out).lock.owner).toBe('[object Object]');
  });

  it('state show --json emits a THROWING expiresAt as null and a merely-NaN one as stored', async () => {
    // Both halves of the sentence in `docs/cli-state.md`: only a coercion that
    // THROWS is replaced (with `NaN`, which `JSON.stringify` writes as `null`),
    // while `{}` converts to `NaN` without throwing and is emitted unchanged.
    bucket.lock = JSON.stringify({ owner: 'u@h:1', timestamp: 1, expiresAt: UNCOERCIBLE });
    const thrown = await runState(['show', 'MyStack', '--json']);
    expectRendered(thrown.error);
    expect(JSON.parse(thrown.out).lock.expiresAt).toBeNull();

    vi.clearAllMocks();
    errorSpy.mockReset();
    s3Send.mockImplementation(async (command) => route(command));
    bucket.lock = JSON.stringify({ owner: 'u@h:1', timestamp: 1, expiresAt: {} });
    const converts = await runState(['show', 'MyStack', '--json']);
    expectRendered(converts.error);
    expect(JSON.parse(converts.out).lock.expiresAt).toEqual({});
  });

  it('refuses a body that parses to null by NAMING the shape, not with a TypeError', async () => {
    bucket.state = 'null';

    const { error } = await runState(['show', 'MyStack']);

    const text = expectRefused(error);
    expect(text).toContain('is not a JSON object (it parses to null)');
    expect(text).not.toMatch(/TypeError|Cannot read properties/);
  });

  it('names an uncoercible schema version in its refusal instead of throwing', async () => {
    bucket.state = record({ version: UNCOERCIBLE });

    const { error } = await runState(['show', 'MyStack']);

    expect(expectRefused(error)).toContain('Unsupported state schema version [object Object]');
  });

  it('keeps a control-bearing schema version on ONE line, so it cannot forge a Stack header', async () => {
    // A newline would start what reads as a fresh `Stack:` header; ESC `[2J`
    // is an ANSI clear-screen the terminal would interpret.
    bucket.state = record({ version: `2\nStack: FORGED${ESC}[2J` });

    const { error } = await runState(['show', 'MyStack']);

    const text = expectRefused(error);
    expect(text).toContain('Unsupported state schema version 2 Stack: FORGED');
    expect(text).not.toContain('\nStack: FORGED');
    expect(text).not.toContain(ESC);
  });

  it('never splits a surrogate pair in a skippedOutputs digest preview', async () => {
    // 11 BMP characters, then an astral one: UTF-16 units 12 and 13 are the
    // two halves of one surrogate pair, so a unit-based cut at 12 splits it.
    bucket.state = record({ skippedOutputs: { Out: 'abcdefghijk\u{1F600}tail' } });

    const { out, error } = await runState(['show', 'MyStack']);

    expectRendered(error);
    const line = out.split('\n').find((l) => l.includes('Out:'));
    expect(line).toContain('abcdefghijk\u{1F600}…');
    expect(/[\uD800-\uDBFF]…/.test(line ?? '')).toBe(false);
  });

  describe('a non-object resources bag fabricates no rows (issue #3172)', () => {
    /**
     * The five shapes `cdkd state list --long` already pins (issue #3157),
     * with what each one PROVES here, because they do not all prove the same
     * thing and a table of five identical-looking rows hides that:
     *
     * - `"abcdef"` and `[1,2,3]` are the FABRICATING shapes —
     *   `Object.entries` yields one `[index, element]` pair per character or
     *   item, so the unfixed commands rendered six and three resources that do
     *   not exist. `rows` is what each case asserts is gone.
     * - `42` and `true` yield NO pairs, so the unfixed commands reported zero
     *   resources over a corrupt record and said nothing. The warning is the
     *   whole delta for them, which is why every case below asserts it.
     * - `null` was already tolerated as an empty bag by the `?? {}` at the
     *   walk, so — like the two above — only the warning changes. The RENDER
     *   must stay byte-identical to a healthy empty bag, pinned separately.
     */
    const MALFORMED: Array<{ label: string; bag: unknown; rows: number }> = [
      { label: 'a string', bag: 'abcdef', rows: 6 },
      { label: 'a list', bag: [1, 2, 3], rows: 3 },
      { label: 'a number', bag: 42, rows: 0 },
      { label: 'a boolean', bag: true, rows: 0 },
      { label: 'null', bag: null, rows: 0 },
    ];

    /** What the shared module says, for the one stack every case reads. */
    const WARNING = malformedResourcesWarning('MyStack', 'us-east-1');

    it('the fabricating shapes really do fabricate, so the cases below are not vacuous', () => {
      // Not a claim about cdkd: a claim about `Object.entries`, which is the
      // mechanism every case here is built on. Without it, a case asserting
      // "no row rendered" would pass just as well against a bag that could
      // never have produced one.
      for (const { label, bag, rows } of MALFORMED) {
        expect(Object.entries((bag ?? {}) as object), label).toHaveLength(rows);
      }
    });

    it.each(MALFORMED)('state resources warns and lists nothing for $label', async ({ bag }) => {
      bucket.state = record({ resources: bag });

      const { out, error } = await runState(['resources', 'MyStack']);

      expectRendered(error);
      // The FABRICATION is asserted first, deliberately. It is the harm, and it
      // is the assertion only `"abcdef"` and `[1,2,3]` can red — putting the
      // warning ahead of it would make the warning red first for every shape
      // and hide whether this one discriminates at all. The whole listing, not
      // a substring: a fabricated row prints its logical id — `0`, `1`, ... —
      // in the first column, so the honest assertion is that nothing printed.
      expect(out).toBe('');
      expect(warnSpy.mock.calls.map((call) => String(call[0]))).toEqual([WARNING]);
    });

    it.each(MALFORMED)(
      'state resources --long warns and lists nothing for $label',
      async ({ bag }) => {
        bucket.state = record({ resources: bag });

        const { out, error } = await runState(['resources', 'MyStack', '--long']);

        expectRendered(error);
        expect(out).toBe('');
        expect(warnSpy.mock.calls.map((call) => String(call[0]))).toEqual([WARNING]);
      }
    );

    it.each(MALFORMED)('state resources --json emits [] for $label', async ({ bag }) => {
      // The mode the issue's first revision called safe. `details` is built
      // ABOVE the `--json` branch, so this mode emitted the fabricated rows as
      // JSON objects — and it is the mode a script consumes without a human
      // reading it.
      bucket.state = record({ resources: bag });

      const { out, error } = await runState(['resources', 'MyStack', '--json']);

      expectRendered(error);
      expect(JSON.parse(out)).toEqual([]);
      expect(warnSpy.mock.calls.map((call) => String(call[0]))).toEqual([WARNING]);
    });

    it.each(MALFORMED)('state show renders zero resources for $label', async ({ bag }) => {
      bucket.state = record({ resources: bag });

      const { out, error } = await runState(['show', 'MyStack']);

      expectRendered(error);
      // Fabrication first, warning second, for the reason the plain
      // `state resources` case above states.
      expect(out).toContain('Resources (0):');
      // `Type:` is printed once per rendered resource and nowhere else in the
      // block, so its absence is the discriminator a count in the header alone
      // would not give: the unfixed render printed `Resources (6):` followed by
      // six `Type: undefined` rows.
      expect(out).not.toContain('Type:');
      expect(warnSpy.mock.calls.map((call) => String(call[0]))).toEqual([WARNING]);
    });

    it('state show --json still emits the stored bag — the evidence is preserved', async () => {
      // `cdkd state list --long`'s reason string sends the operator to exactly
      // this command to SEE a record it could not count. Repairing before the
      // `--json` branch would hand them `"resources": {}` instead, so this case
      // is the one that must stay unchanged; it warns about nothing, because
      // nothing was repaired.
      bucket.state = record({ resources: 'abcdef' });

      const { out, error } = await runState(['show', 'MyStack', '--json']);

      expectRendered(error);
      // The laundering is the harm, so it is asserted first: a repair moved
      // above this branch emits `"resources": {}` here, and the warning being
      // absent is the second, weaker tell.
      expect(JSON.parse(out).state.resources).toBe('abcdef');
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('state show --show-nested warns per record and fabricates nothing for a CHILD', async () => {
      // The child is a second record with its own bag, rendered by the same
      // block through a different call site. Only the CHILD is malformed, so a
      // fix applied to the root alone leaves this case red.
      bucket.state = record({
        resources: {
          Child: {
            resourceType: 'AWS::CloudFormation::Stack',
            physicalId: 'child-arn',
            properties: {},
          },
        },
      });
      bucket.children['MyStack~Child'] = record({
        stackName: 'MyStack~Child',
        resources: 'abcdef',
      });

      const { out, error } = await runState(['show', 'MyStack', '--show-nested']);

      expectRendered(error);
      expect(out).toContain('Nested stack: MyStack~Child');
      // The parent's own row still renders; the child's block shows none.
      const childBlock = out.slice(out.indexOf('Nested stack: MyStack~Child'));
      expect(childBlock).toContain('Resources (0):');
      expect(childBlock).not.toContain('Type:');
      expect(out).toContain('AWS::CloudFormation::Stack');
      // Named by the CHILD's stack name, not the root's — one warning per
      // repaired record is what tells an operator which one is broken.
      expect(warnSpy.mock.calls.map((call) => String(call[0]))).toEqual([
        malformedResourcesWarning('MyStack~Child', 'us-east-1'),
      ]);
    });

    it('state show --show-nested warns about a malformed ROOT and fabricates nothing', async () => {
      // The other half of the tree render. The case above plants the bag on a
      // CHILD, so the ROOT node's own render site was covered only by the
      // source-population fence; this drives it.
      bucket.state = record({ resources: 'abcdef' });

      const { out, error } = await runState(['show', 'MyStack', '--show-nested']);

      expectRendered(error);
      expect(out).toContain('Resources (0):');
      expect(out).not.toContain('Type:');
      expect(warnSpy.mock.calls.map((call) => String(call[0]))).toEqual([WARNING]);
    });

    it('state show --show-nested --json preserves the bag too — the SECOND json branch', async () => {
      // `stateShowCommand` returns from `--json` in two places. The plain case
      // above drives one; without this one, hoisting a repair above the nested
      // branch reds nothing.
      bucket.state = record({ resources: 'abcdef' });

      const { out, error } = await runState(['show', 'MyStack', '--show-nested', '--json']);

      expectRendered(error);
      expect(JSON.parse(out).state.resources).toBe('abcdef');
      expect(JSON.parse(out).children).toEqual([]);
      // WARNED, unlike the plain `--json` branch. There the malformed bag is
      // visible in the payload the operator is reading; here `children: []` is
      // byte-identical to a genuine leaf, so the absence of a subtree is
      // invisible without this line. The record is still emitted as stored.
      expect(warnSpy.mock.calls.map((call) => String(call[0]))).toEqual([WARNING]);
    });

    it.each([
      ['plain', [] as string[]],
      ['--show-nested', ['--show-nested']],
      ['--show-nested --json', ['--show-nested', '--json']],
    ])('a planted megabyte-scale bag costs no pair per character: %s', async (_label, flags) => {
      // The RENDER half of the memory problem: before the fix the text view
      // turned a planted string into one resource block per character, so
      // 100,000 characters emitted hundreds of thousands of lines. That is what
      // these assertions observe.
      //
      // They do NOT observe the walker's allocation under `--show-nested`:
      // measured, reverting the walk guard leaves all three of these GREEN,
      // because the walker finds no children in a string bag and the render is
      // repaired either way. The `guards the walk at …` cases below are the ones
      // that red for that, and they are the ones to keep pointed at the guard.
      //
      // The length bound is a proxy, so it is paired with an exact structural
      // assertion per mode below — a truncating implementation would satisfy
      // the bound alone.
      bucket.state = record({ resources: 'x'.repeat(100_000) });

      const { out, error } = await runState(['show', 'MyStack', ...flags]);

      expectRendered(error);
      if (flags.includes('--json')) {
        // Emitted AS STORED, so the payload is necessarily ~100 KB — the bound
        // that matters here is that no per-character structure was built, which
        // the exact equality proves.
        expect(JSON.parse(out).state.resources).toBe('x'.repeat(100_000));
        expect(JSON.parse(out).children).toEqual([]);
      } else {
        expect(out).toContain('Resources (0):');
        expect(out).not.toContain('Type:');
        expect(out.length).toBeLessThan(2_000);
      }
    });

    /** A record declaring ONE nested-stack child, so the walk has somewhere to go. */
    const parentOf = (childLogicalId: string): string =>
      record({
        resources: {
          [childLogicalId]: {
            resourceType: 'AWS::CloudFormation::Stack',
            physicalId: 'child-arn',
            properties: {},
          },
        },
      });

    /**
     * How many nodes the WALK entered.
     *
     * `--show-nested --json` runs a second pass over the finished tree —
     * `warnUnreadableTreeNodes` — which asks the SAME predicate once per node,
     * so the raw spy count doubles there. Dividing is exact rather than
     * approximate: both passes visit every node exactly once, and the division
     * is asserted to be clean below, so a change that made the warn pass skip
     * or revisit nodes shows up as a non-integer rather than as a plausible
     * walk count.
     */
    const nodesWalked = (flags: string[]): number => {
      const calls = walkSpy.mock.calls.length;
      if (!flags.includes('--json')) return calls;
      expect(calls % 2, 'warn pass must visit each walked node exactly once').toBe(0);
      return calls / 2;
    };

    /** Every `state.json` key the run asked S3 for, in order. */
    const requestedStateKeys = (): string[] =>
      s3Send.mock.calls
        .map((call) => (call[0] as { input?: { Key?: string } })?.input?.Key ?? '')
        .filter((key) => key.endsWith('/state.json'));

    it.each([
      ['plain', [] as string[]],
      ['--json', ['--json']],
    ])(
      'guards the walk at the ROOT and descends no further: --show-nested %s',
      async (_label, flags) => {
        // The guard lives INSIDE the walker, so the root node is still ENTERED
        // — one predicate call — and returns childless before `Object.entries`
        // touches the bag. Both modes, because the walk precedes the branch that
        // separates them.
        bucket.state = record({ resources: 'abcdef' });

        const { error } = await runState(['show', 'MyStack', '--show-nested', ...flags]);

        // Asserted even though the count is the point: without it the case is
        // satisfied by a run that exited through the error handler having walked
        // the root once, which is indistinguishable from success by the count
        // alone.
        expectRendered(error);
        expect(nodesWalked(flags)).toBe(1);
      }
    );

    it('guards the walk at a CHILD, not only at the root', async () => {
      // THE case the first cut of this guard could not fail. A caller-side test
      // covers the root record and nothing below it, so a healthy root naming a
      // nested child walked that child's bag unguarded — measured live at
      // 1623 ms / 1277 MB for a 5,000,000-character child bag, in `--json` too.
      //
      // The discriminator is the per-node count: the walk must ENTER the child
      // (2 nodes, so the guard is reached where the harm was) and stop there.
      //
      // The child's bag is a LIST OF NESTED-STACK OBJECTS rather than a string,
      // and that choice is what makes depth 1 fenced BEHAVIOURALLY. With a
      // string bag, removing the guard's effect while keeping the call — the
      // `void hasReadableResources(state);` mutant — leaves this case green,
      // because a string yields no Stack entries either way and the render is
      // repaired downstream regardless; only the spy's call site would have been
      // under test. A list of Stack objects makes the unguarded walker read the
      // INDEX `0` as a logical id and abort on the missing `MyStack~Child~0`,
      // so the case reds on behaviour at the depth the round-2 blocker lived at.
      bucket.state = parentOf('Child');
      bucket.children['MyStack~Child'] = record({
        stackName: 'MyStack~Child',
        resources: [
          { resourceType: 'AWS::CloudFormation::Stack', physicalId: 'g-arn', properties: {} },
        ],
      });

      const { out, error } = await runState(['show', 'MyStack', '--show-nested']);

      expectRendered(error);
      expect(nodesWalked([])).toBe(2);
      // ...and the child's own bag produced no grandchild lookup. Read off the
      // KEYS rather than the count, so a lookup for a fabricated grandchild is
      // named rather than merely tallied.
      expect(requestedStateKeys()).toEqual([
        'cdkd/MyStack/us-east-1/state.json',
        'cdkd/MyStack~Child/us-east-1/state.json',
      ]);
      expect(out).toContain('Nested stack: MyStack~Child');
    });

    it.each([
      ['plain', [] as string[]],
      ['--show-nested', ['--show-nested']],
      ['--show-nested --json', ['--show-nested', '--json']],
    ])(
      'a GRANDCHILD bag that is a LIST of nested-stack objects no longer aborts the command: %s',
      async (_label, flags) => {
        // The shape `'abcdef'` cannot reach, planted at DEPTH 2 — the level a
        // root-only guard and a top-level-entry counter are both blind to. Its
        // elements are OBJECTS carrying the nested-stack type, so the walker
        // matched `entry?.resourceType`, read the list INDEX `0` as a logical id
        // and looked for `MyStack~Child~Grand~0`. That threw
        // `cdkd state is missing nested-child` ABOVE the `--json` return, so
        // both `--show-nested` modes exited 1 and the evidence branch was
        // unreachable rather than merely noisy.
        //
        // Plain `show` is included as the CONTROL: it never walks, so it must be
        // unaffected in every revision, and a change that made it fail would
        // mean the guard leaked out of the walker.
        bucket.state = parentOf('Child');
        bucket.children['MyStack~Child'] = parentOf('Grand');
        bucket.children['MyStack~Child~Grand'] = record({
          stackName: 'MyStack~Child~Grand',
          resources: [
            { resourceType: 'AWS::CloudFormation::Stack', physicalId: 'g-arn', properties: {} },
          ],
        });

        const { out, error } = await runState(['show', 'MyStack', ...flags]);

        expectRendered(error);
        if (flags.includes('--show-nested')) {
          // Three nodes entered — root, child, grandchild — and the grandchild's
          // guard stopped the descent there.
          expect(nodesWalked(flags)).toBe(3);
          expect(requestedStateKeys()).not.toContain(
            'cdkd/MyStack~Child~Grand~0/us-east-1/state.json'
          );
          expect(out).not.toContain('MyStack~Child~Grand~0');
        }
        if (flags.includes('--json')) {
          // The evidence branch, reachable again: the grandchild's bag comes
          // back as stored rather than the command aborting above it.
          const grandchild = JSON.parse(out).children[0].children[0];
          expect(grandchild.state.resources).toEqual([
            { resourceType: 'AWS::CloudFormation::Stack', physicalId: 'g-arn', properties: {} },
          ]);
          expect(grandchild.children).toEqual([]);
          // ...and the cut at DEPTH 2 is announced, naming the grandchild and
          // nothing else. Without this, deleting the warn pass's RECURSION reds
          // only through `nodesWalked`'s arithmetic, which reports a wrong walk
          // count and points a reader at the walker instead of the warner.
          expect(warnSpy.mock.calls.map((call) => String(call[0]))).toEqual([
            malformedResourcesWarning('MyStack~Child~Grand', 'us-east-1'),
          ]);
        }
      }
    );

    it('still walks to DEPTH 2 for healthy records — the guard is not a blanket skip', async () => {
      // The other direction, at depth. Without this, a "guard" that returned
      // childless unconditionally would satisfy every case above while silently
      // removing nested-stack support, and nothing else here would notice.
      bucket.state = parentOf('Child');
      bucket.children['MyStack~Child'] = parentOf('Grand');
      bucket.children['MyStack~Child~Grand'] = record({ stackName: 'MyStack~Child~Grand' });

      const { out, error } = await runState(['show', 'MyStack', '--show-nested']);

      expectRendered(error);
      expect(walkSpy).toHaveBeenCalledTimes(3);
      expect(out).toContain('Nested stack: MyStack~Child');
      expect(out).toContain('Nested stack: MyStack~Child~Grand');
    });

    it.each([
      ['text', [] as string[]],
      ['--json', ['--json']],
    ])(
      'says NOTHING about a wholly healthy tree: --show-nested %s',
      async (_label, flags) => {
        // The FLOOR for the warning, paired with the cap above. Every other
        // nested case asserts the warning FIRES; none asserts it stays quiet,
        // and an unconditional warn — `void hasReadableResources(node.state);`
        // followed by an unguarded `logger.warn(...)` — was measured GREEN
        // across this file, `state-show.test.ts` and `export-nested-loop.test.ts`.
        //
        // That is not a cosmetic false positive. The text tells the operator the
        // record is malformed and NOT to run `cdkd deploy` or `cdkd destroy`
        // against it; emitting that for every healthy node of a healthy tree is
        // its own harm.
        //
        // Both modes, because only the `--json` branch runs the warn PASS while
        // the text branch warns from the repair — two independent ways to
        // acquire the same false positive.
        bucket.state = parentOf('Child');
        bucket.children['MyStack~Child'] = parentOf('Grand');
        bucket.children['MyStack~Child~Grand'] = record({ stackName: 'MyStack~Child~Grand' });

        const { out, error } = await runState(['show', 'MyStack', '--show-nested', ...flags]);

        expectRendered(error);
        expect(warnSpy).not.toHaveBeenCalled();
        // Proof the tree was actually WALKED, so the silence is a verdict on
        // three healthy nodes rather than on a render that never happened.
        expect(nodesWalked(flags)).toBe(3);
        expect(out).toContain('MyStack~Child~Grand');
      }
    );

    it('a megabyte-scale CHILD bag costs no pair per element either', async () => {
      // The allocation half at depth-1, which is where it was live. The bound is
      // a proxy for "no per-element structure was built"; the per-node count
      // above is the exact fence.
      bucket.state = parentOf('Child');
      bucket.children['MyStack~Child'] = record({
        stackName: 'MyStack~Child',
        resources: 'x'.repeat(100_000),
      });

      const { out, error } = await runState(['show', 'MyStack', '--show-nested']);

      expectRendered(error);
      expect(walkSpy).toHaveBeenCalledTimes(2);
      const childBlock = out.slice(out.indexOf('Nested stack: MyStack~Child'));
      expect(childBlock).toContain('Resources (0):');
      expect(childBlock).not.toContain('Type:');
      expect(out.length).toBeLessThan(3_000);
    });

    it('a resources bag hand-edited from a MAP into a LIST of resource objects renders', async () => {
      // The shape `[1,2,3]` does NOT cover, and the one the nested-stack walker
      // used to hard-fail on: its elements are OBJECTS, so `entry?.resourceType`
      // matches, the walker reads the list INDEX `0` as a logical id, looks for
      // a child record at `MyStack~0`, finds none, and throws
      // `cdkd state is missing nested-child`. That happened above the `--json`
      // return, so this shape reached neither the guard nor the evidence.
      const listOfResources = [
        { resourceType: 'AWS::CloudFormation::Stack', physicalId: 'arn:aws:...', properties: {} },
      ];

      for (const flags of [[], ['--show-nested'], ['--show-nested', '--json']]) {
        vi.clearAllMocks();
        warnSpy.mockReset();
        errorSpy.mockReset();
        s3Send.mockImplementation(async (command) => route(command));
        bucket.state = record({ resources: listOfResources });

        // eslint-disable-next-line no-await-in-loop
        const { out, error } = await runState(['show', 'MyStack', ...flags]);

        expectRendered(error);
        if (flags.includes('--json')) {
          expect(JSON.parse(out).state.resources).toEqual(listOfResources);
          expect(JSON.parse(out).children).toEqual([]);
          // `--show-nested --json`: the cut subtree is announced on stderr while
          // the payload stays as stored.
          expect(warnSpy.mock.calls.map((call) => String(call[0]))).toEqual([WARNING]);
        } else {
          expect(out).toContain('Resources (0):');
          // No `MyStack~0` anywhere: neither a fabricated child nor the
          // missing-nested-child refusal that used to name it.
          expect(out).not.toContain('MyStack~0');
          expect(warnSpy.mock.calls.map((call) => String(call[0]))).toEqual([WARNING]);
        }
      }
    });

    const ORDINARY: Array<{ label: string; bag: Record<string, unknown> }> = [
      { label: 'an empty object', bag: {} },
      {
        label: 'a healthy bag',
        bag: { R: { resourceType: 'AWS::S3::Bucket', physicalId: 'b', properties: {} } },
      },
    ];

    it.each(ORDINARY)('does not swallow the ordinary case: $label', async ({ bag }) => {
      bucket.state = record({ resources: bag });

      const show = await runState(['show', 'MyStack']);
      const resources = await runState(['resources', 'MyStack']);

      expectRendered(show.error);
      expectRendered(resources.error);
      // The guard must not fire on a record nothing is wrong with — a warning
      // here would train operators to ignore the one that matters.
      expect(warnSpy).not.toHaveBeenCalled();
      const expectedRows = Object.keys(bag).length;
      expect(show.out).toContain(`Resources (${expectedRows}):`);
      if (expectedRows > 0) {
        expect(show.out).toContain('Type: AWS::S3::Bucket');
        expect(resources.out).toContain('AWS::S3::Bucket');
      } else {
        expect(resources.out).toBe('');
      }
    });

    it('a null and an absent bag still render exactly like an empty one', async () => {
      // The render is what must not change for the two shapes
      // `docs/cli-state.md` documents as tolerated; the added stderr warning is
      // the only difference, and it is asserted above.
      bucket.state = record({ resources: {} });
      const empty = await runState(['show', 'MyStack']);

      for (const bag of [null, undefined]) {
        vi.clearAllMocks();
        warnSpy.mockReset();
        errorSpy.mockReset();
        s3Send.mockImplementation(async (command) => route(command));
        bucket.state = record({ resources: bag });
        // eslint-disable-next-line no-await-in-loop
        const rendered = await runState(['show', 'MyStack']);
        expectRendered(rendered.error);
        expect(rendered.out).toBe(empty.out);
      }
    });

    it("the integ fixture's needle still matches the warning it greps for", () => {
      // `tests/integration/state-info-command/verify.sh` greps cdkd's OWN
      // output for this phrase, and two of its checks assert the phrase is
      // ABSENT (`state show --json`, and the healthy record). Those two go
      // blind — not red — if the wording moves, which is the one direction a
      // re-run of the fixture cannot catch. This pins the needle to the string
      // the module actually produces.
      const fixture = readFileSync(
        fileURLToPath(
          new URL('../../../tests/integration/state-info-command/verify.sh', import.meta.url)
        ),
        'utf-8'
      );
      const needle = "no readable 'resources' map";

      // Both halves: the fixture still greps for it, and the warning still
      // contains it. Asserting only the second would leave a fixture that had
      // dropped the grep looking covered.
      expect(fixture).toContain(needle);
      expect(malformedResourcesWarning('MyStack', 'us-east-1')).toContain(needle);
      // The count is the floor. Seven occurrences, and they are not all the same
      // KIND, which is the thing to check when this number moves:
      //
      //   2 ABSENCE — plain `state show --json` (that branch repairs nothing)
      //               and the healthy record
      //   3 PRESENCE — `--show-nested --json` at the root, the depth arm's
      //               child, and the one grep `malformed_view`'s six call sites
      //               share
      //   1 COUNT    — the depth arm's `grep -c`, asserting EXACTLY one node was
      //               warned about, so a healthy parent cannot be warned about
      //   1 PAYLOAD  — a `case` over captured STDOUT asserting the warning did
      //               NOT reach the `--json` payload
      //
      // An earlier revision had FOUR, with `--show-nested --json` on the absence
      // side; a real-AWS run failed on it once that branch started warning. The
      // fixture was asserting silence where the contract only promises an
      // untouched payload. If this number falls, check which KIND was lost
      // before re-baselining it.
      expect(fixture.split(needle)).toHaveLength(7 + 1);

      // And the KIND, for the two branches whose polarity this PR changed —
      // the defect that reached real AWS was a fixture asserting SILENCE on a
      // branch the command warns on, which no unit test could see because
      // nothing here executes `verify.sh`. Keyed on each branch's own stderr
      // capture variable, so the check fails if a polarity is flipped back
      // rather than merely if the file is reworded.
      //
      // `state show --show-nested --json` must assert the warning is PRESENT.
      for (const errVar of ['NESTED_JSON_ERR', 'NESTED_JSON_ERR2']) {
        expect(
          fixture,
          `${errVar}: --show-nested --json must assert the cut subtree IS announced`
        ).toContain(`if ! grep -q "${needle}" "\${${errVar}}"`);
        expect(
          fixture,
          `${errVar}: asserting SILENCE here is the go-to-k/cdkd#3172 live-run failure`
        ).not.toContain(`if grep -q "${needle}" "\${${errVar}}"`);
      }
      // ...while plain `state show --json` returns above every repair and every
      // warn pass, so there silence is the correct assertion and stays.
      expect(fixture).toContain(`if grep -q "${needle}" "\${MALFORMED_SHOW_JSON_ERR}"`);
    });

    it('state.ts names renderStateBlock in CODE exactly 1 + 3 times', () => {
      // The source half of the fence, ported from
      // `state-ref-display-boundary.test.ts`: the behavioural cases above cover
      // the three call sites that exist, and cannot see a FOURTH being added.
      // Every call site must be dominated by a repair, so a new one is a
      // decision someone has to make rather than inherit — this number going
      // red is how they are asked.
      //
      // Bare references over comment-stripped source, not a call-shaped regex:
      // `const render = renderStateBlock;` adds a rendering site while matching
      // neither a call nor the declaration, and the doc comments name both
      // helpers repeatedly, so a prose edit would otherwise move the count.
      const source = readFileSync(STATE_TS, 'utf-8');
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

      const references = code.match(/\brenderStateBlock\b/g) ?? [];
      const declarations = code.match(/\bfunction\s+renderStateBlock\b/g) ?? [];
      // The repair helper's own population: one declaration, one call from the
      // single-stack path, one from the tree walker. `repairTreeForTextRender`
      // is one declaration, one call, one recursion.
      const repairRefs = code.match(/\brepairRecordForTextRender\b/g) ?? [];
      const treeRepairRefs = code.match(/\brepairTreeForTextRender\b/g) ?? [];

      // Prove the scan saw its input before trusting the counts: a stripper
      // that ate the code as well as the comments would satisfy every equality
      // below with zeros.
      expect(code.length).toBeGreaterThan(50_000);
      expect(declarations).toHaveLength(1);
      expect(code).toContain('function repairRecordForTextRender');

      expect(references).toHaveLength(declarations.length + 3);
      expect(repairRefs).toHaveLength(3);
      expect(treeRepairRefs).toHaveLength(3);
    });
  });

  describe('a non-object VALUE container fabricates no rows either (issue #3187)', () => {
    /**
     * go-to-k/cdkd#3185 guarded the `resources` bag. The four containers below
     * are walked by the same renderers with the same `Object.entries`, from the
     * same unchecked cast, and were left fabricating exactly as the bag did:
     * `outputs` and `skippedOutputs` on the record, `attributes` and
     * `properties` on each resource.
     *
     * Each case is TWO-SIDED, because go-to-k/cdkd#3185 shipped three one-sided
     * fences and its false-positive direction stayed green across 63 tests: a
     * case proving the guard fires on a malformed container, and a case proving
     * nothing is said about a healthy one — populated, empty, `null` and absent.
     */
    const MALFORMED: Array<{ label: string; value: unknown; rows: number }> = [
      { label: 'a string', value: 'abcdef', rows: 6 },
      { label: 'a list', value: [1, 2, 3], rows: 3 },
      { label: 'a number', value: 42, rows: 0 },
      { label: 'a boolean', value: true, rows: 0 },
    ];

    /** A populated healthy container. Keys chosen so no row can read as an index. */
    const HEALTHY = { Alpha: 'one', Beta: 'two' };

    /** A healthy resource row, with the container a case breaks overridden. */
    function resourceRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
      return {
        resourceType: 'AWS::S3::Bucket',
        physicalId: 'my-bucket',
        properties: {},
        ...overrides,
      };
    }

    /** What the shared module says, for the one stack every case reads. */
    function containerWarning(
      ...containers: Parameters<typeof malformedRenderedContainersWarning>[2]
    ): string {
      return malformedRenderedContainersWarning('MyStack', 'us-east-1', containers);
    }

    /** Every warning the run emitted, in order. */
    function warnings(): string[] {
      return warnSpy.mock.calls.map((call) => String(call[0]));
    }

    /**
     * The four sites, each with the record shape that plants a value in it and
     * the marker that proves its block rendered.
     *
     * `absent` is what a case sets to REMOVE the container; `undefined` is not
     * enough on `attributes` / `properties`, whose owner is a resource row, so
     * each site spells its own removal.
     */
    const SITES = [
      {
        name: 'outputs' as const,
        plant: (value: unknown) => ({ outputs: value }),
        blockHeader: '\nOutputs:\n',
        healthyRow: '  Alpha: one',
        populated: { outputs: HEALTHY },
      },
      {
        name: 'skippedOutputs' as const,
        plant: (value: unknown) => ({ skippedOutputs: value }),
        blockHeader: '\nSkipped outputs:\n',
        healthyRow: '  Alpha: one',
        populated: { skippedOutputs: HEALTHY },
      },
      {
        name: 'attributes' as const,
        plant: (value: unknown) => ({ resources: { R: resourceRow({ attributes: value }) } }),
        blockHeader: '\n  Attributes:\n',
        healthyRow: '    Alpha: one',
        populated: { resources: { R: resourceRow({ attributes: HEALTHY }) } },
      },
      {
        name: 'properties' as const,
        plant: (value: unknown) => ({ resources: { R: resourceRow({ properties: value }) } }),
        blockHeader: '\n  Properties:\n',
        healthyRow: '    Alpha: one',
        populated: { resources: { R: resourceRow({ properties: HEALTHY }) } },
      },
    ];

    /**
     * A row an `Object.entries` walk over a string or a list INVENTS, and which
     * nothing legitimate in these records prints: every healthy container here
     * is keyed `Alpha` / `Beta`.
     *
     * A READABILITY aid, not the fence — {@link expectRendersAsEmpty} is. Two
     * review rounds measured why. It is keyed to one row GRAMMAR, so a walk
     * rendering `    - key = value` instead of `    key: value` fabricates the
     * same phantom rows and this matches none of them: the whole suite stayed
     * green with such a walk live. The block HEADER is no better —
     * `Attributes: (none)` contains `  Attributes:` — which is why it was not
     * the discriminator either.
     */
    const FABRICATED_ROW = /(^|\n)\s*0: /;

    /**
     * THE oracle: an unreadable container must render EXACTLY as an empty one.
     *
     * That is the invariant the fix actually establishes — the repair writes
     * `{}` — and it is what makes the fence independent of how any renderer,
     * present or future, spells a row. A new walk over a container A CASE
     * PLANTS A MALFORMED VALUE FOR adds output the emptied record does not
     * have, whatever grammar it uses, whatever key it prints, and whether it is
     * destructured, aliased, bracket-accessed or reached through a two-level
     * owner. The two spelling-keyed predicates it replaces were each defeated
     * by a probe within one review round.
     *
     * **Its blind spot, measured rather than reasoned:** a walk over a FIFTH
     * container no case plants — `observedProperties` is the live example — is
     * absent from BOTH renders, so byte-identity holds while the walk
     * fabricates. That direction belongs to
     * `walks exactly the fields a repair covers, and nothing else`, which reads
     * the field names out of the source. Neither case subsumes the other; an
     * earlier revision of this comment claimed this one caught "a seventh walk"
     * outright, which is false.
     *
     * The comparand is `site.plant({})` — the same builder the malformed record
     * uses, so the two cannot drift into a vacuously-equal pair — rendered by
     * the SAME command in the SAME process, and the caller floors it on a
     * marker every healthy render prints, so a case cannot pass by both renders
     * having collapsed.
     */
    async function expectRendersAsEmpty(
      args: string[],
      malformed: Record<string, unknown>,
      emptied: Record<string, unknown>,
      floor: string
    ): Promise<string> {
      bucket.state = record(emptied);
      const reference = await runState(args);
      expectRendered(reference.error);
      expect(reference.out).toContain(floor);
      expect(warnSpy).not.toHaveBeenCalled();

      vi.clearAllMocks();
      warnSpy.mockReset();
      errorSpy.mockReset();
      s3Send.mockImplementation(async (command) => route(command));

      bucket.state = record(malformed);
      const { out, error } = await runState(args);
      expectRendered(error);
      expect(out).toBe(reference.out);
      return out;
    }

    it('the fabricating shapes really do fabricate, so the cases below are not vacuous', () => {
      // A claim about `Object.entries`, not about cdkd: without it, "no row
      // rendered" would pass just as well against a value that could never have
      // produced one.
      for (const { label, value, rows } of MALFORMED) {
        expect(Object.entries(value as object), label).toHaveLength(rows);
      }
      // ...and the readability aid matches what such a walk would print in the
      // grammar these renderers happen to use today.
      expect(FABRICATED_ROW.test('\n  0: a\n')).toBe(true);
      expect(FABRICATED_ROW.test('\n  Alpha: one\n')).toBe(false);
      // ...while a walk in ANY other grammar is invisible to it, which is the
      // measured reason the oracle above exists. Pinned so a later reader does
      // not reinstate it as the fence.
      expect(FABRICATED_ROW.test('\n    - 0 = a\n')).toBe(false);
    });

    for (const site of SITES) {
      describe(site.name, () => {
        it.each(MALFORMED)(`state show empties ${site.name} for $label`, async ({ value }) => {
          // The FABRICATION first: it is the harm, and byte-identity with the
          // emptied record is the assertion only the string and the list shapes
          // can red. The warning second, which is the whole delta for the number
          // and the boolean.
          const out = await expectRendersAsEmpty(
            ['show', 'MyStack'],
            site.plant(value),
            site.plant({}),
            'Resources ('
          );
          expect(out).not.toMatch(FABRICATED_ROW);
          expect(out).not.toContain(site.blockHeader);
          expect(warnings()).toEqual([containerWarning(site.name)]);
        });

        it(`state show renders a POPULATED ${site.name} and says nothing`, async () => {
          // The floor. go-to-k/cdkd#3185's warning fired on healthy records
          // undetected across 63 tests because only the malformed direction was
          // pinned; every cap here carries this.
          bucket.state = record(site.populated);

          const { out, error } = await runState(['show', 'MyStack']);

          expectRendered(error);
          expect(out).toContain(site.blockHeader);
          expect(out).toContain(site.healthyRow);
          expect(warnSpy).not.toHaveBeenCalled();
        });

        it(`state show renders an empty, null and absent ${site.name} identically`, async () => {
          // `null` and absent are NOT malformed for these four, unlike the
          // `resources` bag: `skippedOutputs` is absent on every pre-#2740
          // record and `attributes` is optional on `ResourceState`, so warning
          // about them would fire on records cdkd itself writes. The render must
          // stay byte-identical to the empty one, and nothing may be said.
          bucket.state = record(site.plant({}));
          const empty = await runState(['show', 'MyStack']);
          expectRendered(empty.error);
          // The comparand needs its own floor: `toBe(empty.out)` is satisfied
          // by three renders that all collapsed to `''`, so pin that the empty
          // case rendered a block at all before comparing anything to it.
          expect(empty.out).toContain('Resources (');
          expect(warnSpy).not.toHaveBeenCalled();

          for (const value of [null, undefined]) {
            vi.clearAllMocks();
            warnSpy.mockReset();
            errorSpy.mockReset();
            s3Send.mockImplementation(async (command) => route(command));
            bucket.state = record(site.plant(value));
            // eslint-disable-next-line no-await-in-loop
            const rendered = await runState(['show', 'MyStack']);
            expectRendered(rendered.error);
            expect(rendered.out).toBe(empty.out);
            expect(warnSpy).not.toHaveBeenCalled();
          }
        });
      });
    }

    it('names every emptied container ONCE, in a fixed order', async () => {
      // One warning per record however many containers it names, and the order
      // is the constant's rather than discovery order — so two records that lost
      // the same set produce the same line. A production list in another order
      // reds this, because the expectation builds its text from the canonical
      // one.
      bucket.state = record({
        outputs: 'abcdef',
        skippedOutputs: [1, 2, 3],
        resources: { R: resourceRow({ attributes: 42, properties: true }) },
      });

      const { out, error } = await runState(['show', 'MyStack']);

      expectRendered(error);
      expect(out).not.toMatch(FABRICATED_ROW);
      expect(warnings()).toEqual([
        containerWarning('outputs', 'skippedOutputs', 'attributes', 'properties'),
      ]);
    });

    it('names a per-resource container once however many resources hold one', async () => {
      // The reason the warning is built per RECORD and not per container read:
      // a stack whose resources were all hand-edited would otherwise emit one
      // line each.
      bucket.state = record({
        resources: {
          A: resourceRow({ properties: 'abcdef' }),
          B: resourceRow({ properties: [1, 2] }),
          C: resourceRow({ properties: 42 }),
        },
      });

      const { out, error } = await runState(['show', 'MyStack']);

      expectRendered(error);
      expect(out).not.toMatch(FABRICATED_ROW);
      expect(warnings()).toEqual([containerWarning('properties')]);
    });

    it('costs no line per character for a megabyte-scale outputs string', async () => {
      // The measured harm, in the one form an assertion over cdkd's OUTPUT can
      // see. On the shipped bundle a 5,000,000-character `outputs` cost
      // ~1616 ms / ~1010 MB RSS and emitted 5,000,002 lines; this is the same
      // shape at a size a unit suite can afford.
      bucket.state = record({ outputs: 'x'.repeat(200_000) });

      const { out, error } = await runState(['show', 'MyStack']);

      expectRendered(error);
      expect(out.split('\n').length).toBeLessThan(100);
      expect(warnings()).toEqual([containerWarning('outputs')]);
    });

    it('state show --json still emits the stored container — the evidence is preserved', async () => {
      // The same carve-out the `resources` bag takes: this mode is what
      // `cdkd state list --long` and this warning's own text name as the way to
      // SEE the record, so a repair above the `--json` branch would hand the
      // operator a well-formed `{}` and delete what they came for. It
      // fabricates nothing, because it emits the value whole rather than
      // walking it.
      bucket.state = record({ outputs: 'abcdef' });

      const { out, error } = await runState(['show', 'MyStack', '--json']);

      expectRendered(error);
      expect(JSON.parse(out).state.outputs).toBe('abcdef');
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('state show --show-nested empties a CHILD container and names that child', async () => {
      // Each node carries its own record and is rendered through the same
      // block, so a fix applied to the root alone leaves this red — and the
      // warning has to name the CHILD, not the stack the user typed.
      bucket.state = record({
        resources: {
          Child: {
            resourceType: 'AWS::CloudFormation::Stack',
            physicalId: 'child-arn',
            properties: {},
          },
        },
      });
      bucket.children['MyStack~Child'] = record({
        stackName: 'MyStack~Child',
        outputs: 'abcdef',
      });

      const { out, error } = await runState(['show', 'MyStack', '--show-nested']);

      expectRendered(error);
      expect(out).toContain('Nested stack: MyStack~Child');
      expect(out).not.toMatch(FABRICATED_ROW);
      expect(warnings()).toEqual([
        malformedRenderedContainersWarning('MyStack~Child', 'us-east-1', ['outputs']),
      ]);
    });

    it('state show --show-nested warns per RECORD when root and child are both malformed', async () => {
      // Two warnings, each naming its own stack and its own containers, because
      // `repairTreeForTextRender` visits every node. A fix that emptied the
      // tree from one aggregated pass would print one line here and name the
      // wrong stack in it. The child breaks a DIFFERENT container from the
      // root, so a per-node pass that reused the root's repaired set would show
      // up as the wrong names rather than the wrong count.
      bucket.state = record({
        outputs: 'abcdef',
        resources: {
          Child: {
            resourceType: 'AWS::CloudFormation::Stack',
            physicalId: 'child-arn',
            properties: {},
          },
        },
      });
      bucket.children['MyStack~Child'] = record({
        stackName: 'MyStack~Child',
        resources: { R: resourceRow({ properties: [1, 2, 3] }) },
      });

      const { out, error } = await runState(['show', 'MyStack', '--show-nested']);

      expectRendered(error);
      expect(out).not.toMatch(FABRICATED_ROW);
      expect(out).toContain('Nested stack: MyStack~Child');
      expect(warnings()).toEqual([
        containerWarning('outputs'),
        malformedRenderedContainersWarning('MyStack~Child', 'us-east-1', ['properties']),
      ]);
    });

    it('state show --show-nested --json neither repairs nor warns about a container', async () => {
      // Deliberately unlike the `resources` bag, which that mode DOES warn
      // about: an unreadable bag makes the walk return a node with
      // `children: []`, byte-indistinguishable from a genuine leaf, so a
      // consumer reads a cut subtree as complete. A container has no such
      // ambiguity — the payload carries the stored value, and every mode that
      // could fabricate from it is a text one.
      bucket.state = record({
        resources: {
          Child: {
            resourceType: 'AWS::CloudFormation::Stack',
            physicalId: 'child-arn',
            properties: {},
          },
        },
      });
      bucket.children['MyStack~Child'] = record({
        stackName: 'MyStack~Child',
        outputs: 'abcdef',
      });

      const { out, error } = await runState(['show', 'MyStack', '--show-nested', '--json']);

      expectRendered(error);
      expect(JSON.parse(out).children[0].state.outputs).toBe('abcdef');
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it.each(MALFORMED)('state resources --long empties attributes for $label', async ({ value }) => {
      const out = await expectRendersAsEmpty(
        ['resources', 'MyStack', '--long'],
        { resources: { R: resourceRow({ attributes: value }) } },
        { resources: { R: resourceRow({ attributes: {} }) } },
        'AWS::S3::Bucket'
      );
      expect(out).not.toMatch(FABRICATED_ROW);
      expect(out).toContain('Attributes: (none)');
      expect(warnings()).toEqual([containerWarning('attributes')]);
    });

    it('state resources --json emits an attributes MAP, not the stored value', async () => {
      // The repair sits at the LOAD here rather than after the `--json` branch,
      // which is the choice the `resources` repair one line up already made:
      // `details` is a PROJECTION — it already substitutes `[]` and `{}` for an
      // absent `dependencies` / `attributes` — and `cdkd state show --json` is
      // the mode that answers "what does the record hold". Leaving it alone
      // would hand a script a non-object where the shape it consumes says
      // otherwise, with nothing said about it.
      bucket.state = record({ resources: { R: resourceRow({ attributes: 'abcdef' }) } });

      const { out, error } = await runState(['resources', 'MyStack', '--json']);

      expectRendered(error);
      expect(JSON.parse(out)).toEqual([
        {
          logicalId: 'R',
          resourceType: 'AWS::S3::Bucket',
          physicalId: 'my-bucket',
          dependencies: [],
          attributes: {},
        },
      ]);
      expect(warnings()).toEqual([containerWarning('attributes')]);
    });

    it('state resources says NOTHING about containers it does not render', async () => {
      // The scope floor. `properties`, `outputs` and `skippedOutputs` are
      // excluded from every mode of this command, so warning about them would
      // report a defect the user cannot see in the output in front of them —
      // and a set that silently widened to all four would red here rather than
      // going unnoticed.
      // Byte-identity against the same record with those three containers
      // EMPTY, and this is the case that makes the whole block a fence rather
      // than a scope note. Saying only "no warning" pins that this command
      // IGNORES those containers; this pins that it does not RENDER them
      // either. A later edit teaching `--long` to print properties — the
      // plausible one — adds a walk the scope set does not cover, and it reds
      // HERE, in ANY row grammar.
      //
      // Both defeating probes a review round built landed on exactly this case:
      // a destructured walk rendering `    key: value` (which the regex below
      // does catch) and the same walk rendering `    - key = value` (which it
      // does not). The comparand catches both.
      const out = await expectRendersAsEmpty(
        ['resources', 'MyStack', '--long'],
        {
          outputs: 'abcdef',
          skippedOutputs: [1, 2, 3],
          resources: { R: resourceRow({ properties: 'abcdef', attributes: HEALTHY }) },
        },
        {
          outputs: {},
          skippedOutputs: {},
          resources: { R: resourceRow({ properties: {}, attributes: HEALTHY }) },
        },
        'AWS::S3::Bucket'
      );
      expect(out).not.toMatch(FABRICATED_ROW);
      // The command still renders, and the attribute bag it DOES read is
      // untouched — so this is not passing because the record failed to load.
      expect(out).toContain('Alpha: one');
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it.each(MALFORMED)(
      'state resources PLAIN mode neither walks attributes nor warns for $label',
      async ({ value }) => {
        // The default three-column listing prints logicalId / type / physicalId
        // and nothing else, so it walks no container at all. Warning there would
        // name a block absent from the output in front of the reader — the same
        // false positive the scope set excludes `properties` to avoid, one mode
        // over. `--long` and `--json` on the identical record DO warn, which is
        // what makes this a scope assertion rather than a claim the guard is
        // off.
        //
        // Byte-identity is what carries it: `FABRICATED_ROW` cannot match this
        // mode's one-line `id  type  physicalId` row in ANY case, so it would
        // be inert here (review finding), while the comparand reds on any
        // output this mode gains that the emptied record does not have.
        const out = await expectRendersAsEmpty(
          ['resources', 'MyStack'],
          { resources: { R: resourceRow({ attributes: value }) } },
          { resources: { R: resourceRow({ attributes: {} }) } },
          'AWS::S3::Bucket'
        );
        // The row itself still renders: a case passing because the listing was
        // empty would prove nothing about the container.
        expect(out).toContain('AWS::S3::Bucket');
        expect(warnSpy).not.toHaveBeenCalled();
      }
    );

    it('walks exactly the fields a repair covers, and nothing else', () => {
      // The direction the byte-identity oracle above CANNOT see, and it took a
      // review probe to find it: that oracle compares a malformed render to an
      // EMPTIED one, so it is blind to a walk over a container no case plants a
      // malformed value for. A fabricating walk over `observedProperties` — a
      // real optional `ResourceState` field — left every behavioural case green.
      //
      // So this case does not count walks over the four names, which would have
      // been blind the same way. It reads the field name out of EVERY
      // `Object.entries` / `.keys` over an `owner.field` in the file and requires
      // the set, and the per-field counts, to equal the table below. A fifth
      // field reds it, whatever it is called, and a decision has to be made about
      // it rather than inherited.
      //
      // Counts per field and not just the set, because a field can also change
      // PARTITION: a walk moving from a repaired site to an unrepaired one keeps
      // the set identical while breaking the guarantee.
      //
      // What it still cannot see is a walk that never spells `owner.field` — a
      // destructured binding, an alias, a bracket access, a two-level owner.
      // That direction is the oracle's, and the two are complementary rather
      // than redundant: each was measured blind to exactly what the other
      // catches.
      const WALKED: ReadonlyArray<readonly [string, number, string]> = [
        ['outputs', 1, 'renderStateBlock; repaired by repairRecordForTextRender'],
        ['skippedOutputs', 2, 'sortedSkippedOutputs + rendersSkippedBlock; same repair'],
        ['attributes', 2, 'renderStateBlock + stateResourcesCommand --long; both repaired'],
        ['properties', 1, 'renderStateBlock; repaired by repairRecordForTextRender'],
        ['resources', 2, 'the bag, repaired by repairMalformedResourcesForReadOnly'],
      ];

      const source = readFileSync(STATE_TS, 'utf-8');
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

      const WALK = /Object\.(?:entries|keys)\(\s*[A-Za-z_$][\w$]*\.([A-Za-z_$][\w$]*)/g;
      const found: Record<string, number> = {};
      for (const m of code.matchAll(WALK)) found[m[1]!] = (found[m[1]!] ?? 0) + 1;

      const repairRefs = code.match(/\brepairRenderedContainers\b/g) ?? [];
      const showSet = code.match(/\bSHOW_RENDERED_CONTAINERS\b/g) ?? [];
      const resourcesSet = code.match(/\bRESOURCES_RENDERED_CONTAINERS\b/g) ?? [];

      // Prove the scan saw its input before trusting any verdict: a stripper
      // that ate the code as well as the comments satisfies every equality
      // below with zeros, and the pattern is pinned in both directions on
      // strings whose answer is known by eye — including the FIELD it extracts,
      // which is the part this rewrite depends on.
      expect(code.length).toBeGreaterThan(50_000);
      expect(code).toContain('function repairRenderedContainers');
      expect([...'Object.entries(state.outputs ?? {})'.matchAll(WALK)].map((m) => m[1])).toEqual([
        'outputs',
      ]);
      expect([
        ...'Object.entries(resource.observedProperties ?? {})'.matchAll(WALK),
      ].map((m) => m[1])).toEqual(['observedProperties']);
      expect([...'Object.entries(buildBag())'.matchAll(WALK)]).toHaveLength(0);

      expect(found).toEqual(Object.fromEntries(WALKED.map(([name, n]) => [name, n])));

      // One declaration plus the two entries that dominate the four container
      // walks: `repairRecordForTextRender` for `cdkd state show`, and the
      // mode-gated load site of `cdkd state resources`.
      expect(repairRefs).toHaveLength(3);
      // Each scope set is declared once and read once, at its own entry.
      expect(showSet).toHaveLength(2);
      expect(resourcesSet).toHaveLength(2);
    });
  });
});
