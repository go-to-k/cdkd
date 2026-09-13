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
import { NoSuchKey } from '@aws-sdk/client-s3';

const errorSpy = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/logger.js', () => ({
  reserveStdoutForPayload: vi.fn(),
  getLogger: () => ({
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
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

import { createStateCommand } from '../../../src/cli/commands/state.js';

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
      const stack = key.split('/')[1] ?? '';
      const body = bucket.children[stack] ?? bucket.state;
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
    // flows through subtraction and `formatDuration` unchanged.
    expect(out).toContain('locked by u@h:1, expired NaNmNaNs ago');
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
});
