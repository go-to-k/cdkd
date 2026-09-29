import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
/**
 * Issue [#2275](https://github.com/go-to-k/cdkd/issues/2275): the confirmation
 * prompt this file drives now REFUSES a non-interactive stdin
 * (`CdkdError` / `NON_INTERACTIVE_CONFIRM`, from the shared
 * `confirmOrRefuse` helper) instead of hanging on a `question` an EOF stdin
 * can never settle. Vitest's stdin is NOT a TTY, so every case that exercises
 * the PROMPT has to present as interactive; the refusal cases set it back.
 */
import { setStdinIsTty } from '../../stdin-tty.js';
import { PASTE_PAYLOADS, spansThatRun, withPasteDir } from '../utils/paste-harness.js';

const errorSpy = vi.hoisted(() => vi.fn());
const warnSpy = vi.hoisted(() => vi.fn());
const infoSpy = vi.hoisted(() => vi.fn());

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
}));

vi.mock('../../../src/cli/config-loader.js', () => ({
  resolveStateBucketWithDefault: vi.fn(async () => 'test-bucket'),
}));

vi.mock('../../../src/utils/aws-clients.ts', () => {
  return {
    AwsClients: vi.fn().mockImplementation(() => ({
      get s3() {
        return {};
      },
      destroy: vi.fn(),
    })),
    setAwsClients: vi.fn(),
    getAwsClients: vi.fn(),
  };
});

const mockStateExists = vi.fn<(stackName: string, region: string) => Promise<boolean>>();
const mockDeleteState = vi.fn<(stackName: string, region: string) => Promise<void>>();
const mockListStacks =
  vi.fn<() => Promise<Array<{ stackName: string; region?: string }>>>();
const mockVerifyBucketExists = vi.fn<() => Promise<void>>();
// Issue #2537: the region-less legacy record is deleted through its OWN
// backend method. `deleteState` requires a region and sweeps the legacy key
// only when that key's body names the SAME region, so it can never reach a
// record whose body names none — which is why the old code deleted nothing
// and still reported success.
const mockDeleteLegacyState = vi.fn<(stackName: string) => Promise<void>>();
vi.mock('../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn().mockImplementation(() => ({
    stateExists: mockStateExists,
    deleteState: mockDeleteState,
    deleteLegacyState: mockDeleteLegacyState,
    listStacks: mockListStacks,
    verifyBucketExists: mockVerifyBucketExists,
  })),
}));

const mockIsLocked = vi.fn<(stackName: string, region?: string) => Promise<boolean>>();
const mockForceReleaseLock = vi.fn<(stackName: string, region?: string) => Promise<void>>();
// Issue #2171: the force-release below is unconditional by design, so the only
// useful signal is naming the owner at the moment it destroys a LIVE lock.
const mockGetLockInfo = vi.fn<(stackName: string, region?: string) => Promise<unknown>>();
vi.mock('../../../src/state/lock-manager.js', () => ({
  LockManager: vi.fn().mockImplementation(() => ({
    isLocked: mockIsLocked,
    forceReleaseLock: mockForceReleaseLock,
    getLockInfo: mockGetLockInfo,
  })),
}));

// Mock readline so the confirmation prompt is fully scriptable in tests.
const readlineQuestion = vi.hoisted(() => vi.fn<(prompt: string) => Promise<string>>());
const readlineClose = vi.hoisted(() => vi.fn());
vi.mock('node:readline/promises', () => ({
  createInterface: vi.fn(() => ({
    question: readlineQuestion,
    close: readlineClose,
  })),
}));

import { createStateCommand } from '../../../src/cli/commands/state.js';
import { StateError } from '../../../src/utils/error-handler.js';
import { malformedOrphanResourcePropertiesRefusalMessage } from '../../../src/state/malformed-resources-bag.js';
import { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import { displayIdent, IDENT_MAX_CODE_POINTS } from '../../../src/utils/display-safe.js';

/**
 * Split a POSIX shell command line into words: whitespace separates, `'...'`
 * is literal, and a backslash outside quotes escapes one character — enough for
 * what `shellQuote` emits, including its `'\''` spelling of a quote.
 */
function shellWords(line: string): string[] {
  const words: string[] = [];
  let cur = '';
  let inWord = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === "'") {
      const end = line.indexOf("'", i + 1);
      if (end === -1) throw new Error(`unterminated quote in: ${line}`);
      cur += line.slice(i + 1, end);
      i = end;
      inWord = true;
    } else if (c === '\\') {
      cur += line[++i] ?? '';
      inWord = true;
    } else if (/\s/.test(c)) {
      if (inWord) words.push(cur);
      cur = '';
      inWord = false;
    } else {
      cur += c;
      inWord = true;
    }
  }
  if (inWord) words.push(cur);
  return words;
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

async function runStateOrphan(args: string[]): Promise<string> {
  const cap = captureStdout();
  try {
    const stateCmd = createStateCommand();
    stateCmd.exitOverride();
    stateCmd.commands.forEach((sub) => sub.exitOverride());
    await stateCmd.parseAsync(args, { from: 'user' });
  } finally {
    cap.restore();
  }
  return cap.output.join('');
}

let originalIsTTY: boolean | undefined;
beforeEach(() => {
  originalIsTTY = process.stdin.isTTY;
  setStdinIsTty(true);
});
afterEach(() => {
  setStdinIsTty(originalIsTTY);
});

describe('cdkd state orphan', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockStateExists.mockReset();
    mockDeleteState.mockReset();
    mockDeleteState.mockResolvedValue();
    mockDeleteLegacyState.mockReset();
    mockDeleteLegacyState.mockResolvedValue();
    mockListStacks.mockReset();
    mockIsLocked.mockReset();
    warnSpy.mockReset();
    mockGetLockInfo.mockReset();
    mockGetLockInfo.mockResolvedValue(null);
    mockForceReleaseLock.mockReset();
    mockForceReleaseLock.mockResolvedValue();
    mockVerifyBucketExists.mockReset();
    mockVerifyBucketExists.mockResolvedValue();
    readlineQuestion.mockReset();
    readlineClose.mockReset();
    errorSpy.mockReset();
    infoSpy.mockReset();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit-mock');
    }) as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    vi.clearAllMocks();
  });

  it('skips a stack whose state does not exist (idempotent)', async () => {
    // listStacks does not include the requested stack — `state orphan` skips
    // (no error: idempotent).
    mockListStacks.mockResolvedValue([]);

    await runStateOrphan(['orphan', 'Missing', '--yes']);

    expect(mockDeleteState).not.toHaveBeenCalled();
    expect(mockForceReleaseLock).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith(expect.stringMatching(/No state found for stack: Missing/));
  });

  it('removes state.json AND lock.json when --yes skips the prompt', async () => {
    mockListStacks.mockResolvedValue([{ stackName: 'MyStack', region: 'us-east-1' }]);
    mockIsLocked.mockResolvedValue(false);

    await runStateOrphan(['orphan', 'MyStack', '--yes']);

    expect(readlineQuestion).not.toHaveBeenCalled();
    expect(mockDeleteState).toHaveBeenCalledWith('MyStack', 'us-east-1');
    expect(mockForceReleaseLock).toHaveBeenCalledWith('MyStack', 'us-east-1');
  });

  it('removes both regions when a stack has state in multiple regions (no --stack-region)', async () => {
    mockListStacks.mockResolvedValue([
      { stackName: 'MyStack', region: 'us-east-1' },
      { stackName: 'MyStack', region: 'us-west-2' },
    ]);
    mockIsLocked.mockResolvedValue(false);

    await runStateOrphan(['orphan', 'MyStack', '--yes']);

    expect(mockDeleteState).toHaveBeenCalledWith('MyStack', 'us-east-1');
    expect(mockDeleteState).toHaveBeenCalledWith('MyStack', 'us-west-2');
    expect(mockForceReleaseLock).toHaveBeenCalledWith('MyStack', 'us-east-1');
    expect(mockForceReleaseLock).toHaveBeenCalledWith('MyStack', 'us-west-2');
  });

  it('scopes removal with --stack-region <region>', async () => {
    mockListStacks.mockResolvedValue([
      { stackName: 'MyStack', region: 'us-east-1' },
      { stackName: 'MyStack', region: 'us-west-2' },
    ]);
    mockIsLocked.mockResolvedValue(false);

    await runStateOrphan(['orphan', 'MyStack', '--yes', '--stack-region', 'us-east-1']);

    expect(mockDeleteState).toHaveBeenCalledWith('MyStack', 'us-east-1');
    expect(mockDeleteState).not.toHaveBeenCalledWith('MyStack', 'us-west-2');
  });

  it('refuses to remove a locked stack without --force', async () => {
    mockListStacks.mockResolvedValue([{ stackName: 'LockedStack', region: 'us-east-1' }]);
    mockIsLocked.mockResolvedValue(true);

    await expect(runStateOrphan(['orphan', 'LockedStack', '--yes'])).rejects.toThrow();

    expect(exitSpy).toHaveBeenCalledWith(1);
    const message = String(errorSpy.mock.calls[0]?.[0] ?? '');
    expect(message).toMatch(/Stack LockedStack \(us-east-1\) is locked/);
    expect(mockDeleteState).not.toHaveBeenCalled();
  });

  it('describes a non-plain locked name, so pasting the sentence, a line or a clause runs nothing (go-to-k/cdkd#3436, go-to-k/cdkd#3760)', async () => {
    // The row used to quote the name by hand, `Stack '${displaySafe(...)}'`.
    // `asciiOnly` keeps `'`, `$` and `(`, so `x'$(touch OWNED) #` closed that
    // quote and the substitution ran when the sentence was pasted (measured by
    // the maintainer). Every payload family, at the harness's granularities
    // (sentence, line, clause); selecting the NAME ALONE is not one of them,
    // and for `$(...)` / backtick names that still runs (see the source
    // comment). The name must `===` the ref the operator typed to get here.
    const messages: Array<{ value: string; message: string }> = [];
    for (const { value } of PASTE_PAYLOADS) {
      errorSpy.mockClear();
      mockListStacks.mockResolvedValue([{ stackName: value, region: 'us-east-1' }]);
      mockIsLocked.mockResolvedValue(true);
      await expect(runStateOrphan(['orphan', value, '--yes'])).rejects.toThrow();
      messages.push({ value, message: String(errorSpy.mock.calls[0]?.[0] ?? '') });
    }
    withPasteDir((dir) => {
      for (const { value, message } of messages) {
        // Described, not quoted, since go-to-k/cdkd#3760: this refusal sits in
        // `state orphan`'s run, where a padded name in quotes could wrap into
        // a counterfeit `Run:` row.
        expect(message, value).toContain(
          'A stack whose name is not a plain identifier (us-east-1) is locked'
        );
        // The HEAD never names it; the force-unlock command after `Run:` is
        // the shared builder's, which shell-quotes an exact value.
        expect(message.split(' Run: ')[0], value).not.toContain(value);
        expect(spansThatRun(message, dir), value).toEqual([]);
      }
    });
    expect(mockDeleteState).not.toHaveBeenCalled();
  }, 120_000);

  it('renders a locked name whole at the stack-ref cap, not cut at the identifier one (go-to-k/cdkd#3436)', async () => {
    // `displayStackName`, not `displayIdent`: a nested-child name legitimately
    // runs past 255 code points, and the force-unlock command below the head
    // names it whole up to 1152.
    const long = 'q'.repeat(1152);
    mockListStacks.mockResolvedValue([{ stackName: long, region: 'us-east-1' }]);
    mockIsLocked.mockResolvedValue(true);

    await expect(runStateOrphan(['orphan', long, '--yes'])).rejects.toThrow();

    const message = String(errorSpy.mock.calls[0]?.[0] ?? '');
    expect(message).toContain(`Stack ${long} (us-east-1) is locked`);
  });

  it('describes a locked name ONE past the stack-ref cap rather than cutting it (go-to-k/cdkd#3436, go-to-k/cdkd#3760)', async () => {
    const over = 'q'.repeat(1153);
    mockListStacks.mockResolvedValue([{ stackName: over, region: 'us-east-1' }]);
    mockIsLocked.mockResolvedValue(true);

    await expect(runStateOrphan(['orphan', over, '--yes'])).rejects.toThrow();

    const message = String(errorSpy.mock.calls[0]?.[0] ?? '');
    expect(message).toContain('is locked');
    expect(message).not.toContain(over);
    // Past the cap `isPasteableIdent` refuses it, so the head describes it,
    // and the force-unlock command is withheld for the same length.
    expect(message).toContain('A stack whose name is not a plain identifier (us-east-1)');
    expect(message).not.toContain('cdkd force-unlock');
  });

  it('removes a locked stack when --force is set (and skips lock check)', async () => {
    mockListStacks.mockResolvedValue([{ stackName: 'LockedStack', region: 'us-east-1' }]);

    await runStateOrphan(['orphan', 'LockedStack', '--force']);

    // --force bypasses both the lock check and the prompt.
    expect(mockIsLocked).not.toHaveBeenCalled();
    expect(readlineQuestion).not.toHaveBeenCalled();
    expect(mockDeleteState).toHaveBeenCalledWith('LockedStack', 'us-east-1');
    expect(mockForceReleaseLock).toHaveBeenCalledWith('LockedStack', 'us-east-1');
  });

  it('prompts and deletes when the user answers `y`', async () => {
    mockListStacks.mockResolvedValue([{ stackName: 'MyStack', region: 'us-east-1' }]);
    mockIsLocked.mockResolvedValue(false);
    readlineQuestion.mockResolvedValue('y');

    const out = await runStateOrphan(['orphan', 'MyStack']);

    expect(readlineQuestion).toHaveBeenCalledTimes(1);
    expect(out).toMatch(/AWS resources will NOT be deleted/);
    expect(out).toMatch(/^Destroy with: cdkd destroy MyStack$/m);
    expect(mockDeleteState).toHaveBeenCalledWith('MyStack', 'us-east-1');
  });

  it('holds a NON-PLAIN name out of the `Destroy with:` line, and says why (go-to-k/cdkd#3696)', async () => {
    // Exact, so the command gate alone would name it; `plainIdent` withholds
    // it beside the labelled line, and the clause names `cdkd destroy`'s
    // rule rather than `cdkd deploy`'s.
    mockListStacks.mockResolvedValue([{ stackName: 'Old;Stack', region: 'us-east-1' }]);
    mockIsLocked.mockResolvedValue(false);
    readlineQuestion.mockResolvedValue('n');

    const out = await runStateOrphan(['orphan', 'Old;Stack']);

    expect(out).toMatch(/AWS resources will NOT be deleted/);
    expect(out).toContain('is not a plain identifier');
    expect(out).toMatch(/^Destroy with: cdkd destroy '<stack>'$/m);
    expect(out).not.toContain("cdkd destroy 'Old;Stack'");
    expect(mockDeleteState).not.toHaveBeenCalled();
  });

  it('names the PATTERN reason with `cdkd destroy`, the verb this line runs (go-to-k/cdkd#3696)', async () => {
    mockListStacks.mockResolvedValue([{ stackName: 'Prod*', region: 'us-east-1' }]);
    mockIsLocked.mockResolvedValue(false);
    readlineQuestion.mockResolvedValue('n');

    const out = await runStateOrphan(['orphan', 'Prod*']);

    expect(out).toContain("would be read as a PATTERN by 'cdkd destroy'");
    expect(out).not.toContain("'cdkd deploy'");
    expect(out).toMatch(/^Destroy with: cdkd destroy '<stack>'$/m);
  });

  it('names no padded name on the `Destroy with:` line (go-to-k/cdkd#3696)', async () => {
    const forged = `ProdStack${' '.repeat(60)}Destroy with: cdkd destroy --all --force #`;
    mockListStacks.mockResolvedValue([{ stackName: forged, region: 'us-east-1' }]);
    mockIsLocked.mockResolvedValue(false);
    readlineQuestion.mockResolvedValue('n');

    const out = await runStateOrphan(['orphan', forged]);

    expect(out).toMatch(/AWS resources will NOT be deleted/);
    const labelled = out.split('\n').filter((l) => l.startsWith('Destroy with:'));
    expect(labelled).toEqual(["Destroy with: cdkd destroy '<stack>'"]);
    expect(mockDeleteState).not.toHaveBeenCalled();
  });

  it('prompts and cancels when the user answers `n` (or empty)', async () => {
    mockListStacks.mockResolvedValue([{ stackName: 'MyStack', region: 'us-east-1' }]);
    mockIsLocked.mockResolvedValue(false);
    readlineQuestion.mockResolvedValue('');

    await runStateOrphan(['orphan', 'MyStack']);

    expect(mockDeleteState).not.toHaveBeenCalled();
    expect(mockForceReleaseLock).not.toHaveBeenCalled();
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringMatching(/Cancelled removal of state for stack: MyStack/)
    );
  });

  it('accepts `yes` (full word) as confirmation, case-insensitively', async () => {
    mockListStacks.mockResolvedValue([{ stackName: 'MyStack', region: 'us-east-1' }]);
    mockIsLocked.mockResolvedValue(false);
    readlineQuestion.mockResolvedValue('YES');

    await runStateOrphan(['orphan', 'MyStack']);

    expect(mockDeleteState).toHaveBeenCalledWith('MyStack', 'us-east-1');
  });

  it('iterates over multiple stacks, each with its own confirmation', async () => {
    mockListStacks.mockResolvedValue([
      { stackName: 'A', region: 'us-east-1' },
      { stackName: 'B', region: 'us-east-1' },
    ]);
    mockIsLocked.mockResolvedValue(false);
    readlineQuestion.mockResolvedValueOnce('y').mockResolvedValueOnce('n');

    await runStateOrphan(['orphan', 'A', 'B']);

    expect(readlineQuestion).toHaveBeenCalledTimes(2);
    expect(mockDeleteState).toHaveBeenCalledWith('A', 'us-east-1');
    expect(mockDeleteState).not.toHaveBeenCalledWith('B', 'us-east-1');
    expect(mockForceReleaseLock).toHaveBeenCalledWith('A', 'us-east-1');
    expect(mockForceReleaseLock).not.toHaveBeenCalledWith('B', 'us-east-1');
  });


  /**
   * Issue [#2275](https://github.com/go-to-k/cdkd/issues/2275), the ROUTING
   * half. `tests/unit/cli/non-interactive-confirm-guards.test.ts` probes this
   * command's prompt HELPER directly (the `NON_INTERACTIVE_CONFIRM` code, the
   * refusal wording, the never-settling-question hang fence); what a
   * helper-level probe cannot see is whether the COMMAND's own call site
   * still reaches it, or has grown a second `readline.createInterface` of its
   * own. This case drives the real command path with no confirmation flag and
   * a non-TTY stdin, and asserts the refusal surfaces with nothing mutated.
   */
  it('REFUSES a non-interactive run, naming -y / --yes and -f / --force', async () => {
    setStdinIsTty(undefined);
    mockListStacks.mockResolvedValue([{ stackName: 'MyStack', region: 'us-east-1' }]);
    mockIsLocked.mockResolvedValue(false);

    await expect(runStateOrphan(['orphan', 'MyStack'])).rejects.toThrow();

    expect(exitSpy).toHaveBeenCalledWith(1);
    const message = String(errorSpy.mock.calls[0]?.[0] ?? '');
    // `formatError` renders `<name>: <message>`, so the name pins that this is
    // a `CdkdError` rather than a bare `Error` — the shape `gc.ts` and
    // `bootstrap-destroy.ts` established and the one CI branches on.
    expect(message).toContain('CdkdError');
    expect(message).toContain('The cdkd state orphan confirmation prompt cannot run');
    expect(message).toContain('-y / --yes');
    expect(message).toContain('-f / --force');
    // stdin never consulted, and nothing removed.
    expect(readlineQuestion).not.toHaveBeenCalled();
    expect(mockDeleteState).not.toHaveBeenCalled();
    expect(mockForceReleaseLock).not.toHaveBeenCalled();
  });

  describe('live-lock warning before the force-release (issue #2171)', () => {
    // `forceReleaseLock` takes no lock of its own and deletes whatever is
    // there, including an in-flight deploy's. That is deliberate — a stuck
    // lock must not make a state record unremovable — but it was SILENT, and
    // the write it enables has already happened by the time anyone notices.
    it('names the owner and operation when the lock it destroys is still live', async () => {
      mockListStacks.mockResolvedValue([{ stackName: 'MyStack', region: 'us-east-1' }]);
      mockIsLocked.mockResolvedValue(false);
      mockGetLockInfo.mockResolvedValue({
        owner: 'alice@host:4242',
        operation: 'deploy',
        expiresAt: Date.now() + 15 * 60_000,
      });

      await runStateOrphan(['orphan', 'MyStack', '--yes']);

      const warned = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(warned).toMatch(/Force-releasing a LIVE lock/);
      expect(warned).toContain('alice@host:4242');
      expect(warned).toContain('operation: deploy');
      // The removal the user asked for still happens — this is a warning, not
      // a refusal.
      expect(mockForceReleaseLock).toHaveBeenCalledWith('MyStack', 'us-east-1');
      expect(mockDeleteState).toHaveBeenCalledWith('MyStack', 'us-east-1');
    });

    it('passes a plain holder through unchanged', async () => {
      // `LockManager.getLockInfo` sanitizes `owner` / `operation` at the source
      // so all five readers inherit it (issue #2170 round 3), and this reader
      // does not re-spell THAT rule. It adds a different one on top, deliberately:
      // it prints beside `state orphan`'s labelled `Destroy with:` row, where a
      // source-sanitized value keeping its interior spaces still wraps into a
      // counterfeit row, so a value that is not identifier-shaped is described
      // (go-to-k/cdkd#3760; the next case). A genuine `user@host:pid` owner and
      // an operation name render as themselves, which this case pins.
      mockListStacks.mockResolvedValue([{ stackName: 'MyStack', region: 'us-east-1' }]);
      mockIsLocked.mockResolvedValue(false);
      mockGetLockInfo.mockResolvedValue({
        owner: 'alice@host:1',
        operation: 'deploy',
        expiresAt: Date.now() + 60_000,
      });

      await runStateOrphan(['orphan', 'MyStack', '--yes']);

      const warned = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(warned).toContain('held by alice@host:1, operation: deploy.');
    });

    it('describes a padded owner or operation, so neither can wrap into a counterfeit Destroy with: row (go-to-k/cdkd#3760)', async () => {
      const wrap = `${' '.repeat(80)}Destroy with: cdkd destroy --all --force #`;
      for (const [field, lock, expected] of [
        [
          'owner',
          { owner: `alice@host:1${wrap}`, operation: 'deploy' },
          'held by a lock owner that is not a plain identifier, operation: deploy.',
        ],
        [
          'operation',
          { owner: 'alice@host:1', operation: `deploy${wrap}` },
          'held by alice@host:1, operation: a lock operation that is not a plain identifier.',
        ],
      ] as const) {
        warnSpy.mockClear();
        mockListStacks.mockResolvedValue([{ stackName: 'MyStack', region: 'us-east-1' }]);
        mockIsLocked.mockResolvedValue(false);
        mockGetLockInfo.mockResolvedValue({ ...lock, expiresAt: Date.now() + 60_000 });

        // eslint-disable-next-line no-await-in-loop
        await runStateOrphan(['orphan', 'MyStack', '--yes']);

        const warned = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
        expect(warned, field).toContain(expected);
        expect(warned, field).not.toContain('Destroy with:');
        expect(warned, field).not.toContain('--all --force');
      }
    });

    it("describes an owner or operation that is displayIdent's own cut output, which renders unchanged (go-to-k/cdkd#4109)", async () => {
      const suffix = ' [cut: 35 more characters withheld]';
      const forged = 'a'.repeat(IDENT_MAX_CODE_POINTS) + suffix;
      expect(displayIdent(forged)).toBe(forged);
      for (const [field, lock, expected] of [
        [
          'owner',
          { owner: forged, operation: 'deploy' },
          'held by a lock owner that is not a plain identifier, operation: deploy.',
        ],
        [
          'operation',
          { owner: 'alice@host:1', operation: forged },
          'held by alice@host:1, operation: a lock operation that is not a plain identifier.',
        ],
      ] as const) {
        warnSpy.mockClear();
        mockListStacks.mockResolvedValue([{ stackName: 'MyStack', region: 'us-east-1' }]);
        mockIsLocked.mockResolvedValue(false);
        mockGetLockInfo.mockResolvedValue({ ...lock, expiresAt: Date.now() + 60_000 });

        // eslint-disable-next-line no-await-in-loop
        await runStateOrphan(['orphan', 'MyStack', '--yes']);

        const warned = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
        expect(warned, field).toContain(expected);
        expect(warned, field).not.toContain(suffix);
      }
    });

    it('no pasted span of the live-lock warning runs, whatever the owner or operation carries', async () => {
      const messages: Array<{ value: string; message: string }> = [];
      for (const { value } of PASTE_PAYLOADS) {
        for (const lock of [
          { owner: value, operation: 'deploy' },
          { owner: 'alice@host:1', operation: value },
        ]) {
          warnSpy.mockClear();
          mockListStacks.mockResolvedValue([{ stackName: 'MyStack', region: 'us-east-1' }]);
          mockIsLocked.mockResolvedValue(false);
          mockGetLockInfo.mockResolvedValue({ ...lock, expiresAt: Date.now() + 60_000 });
          // eslint-disable-next-line no-await-in-loop
          await runStateOrphan(['orphan', 'MyStack', '--yes']);
          messages.push({ value, message: warnSpy.mock.calls.map((c) => String(c[0])).join('\n') });
        }
      }
      withPasteDir((dir) => {
        for (const { value, message } of messages) {
          expect(message, value).toContain('Force-releasing a LIVE lock on MyStack (us-east-1)');
          expect(message, value).not.toContain(value);
          expect(spansThatRun(message, dir), value).toEqual([]);
        }
      });
    }, 120_000);

    it('sanitizes the REGION too — it is an S3 key segment', async () => {
      // Round 4: the region was still hand-interpolated raw, one clause from a
      // sanitized stack name in the same sentence. `listStacks` derives it from
      // an S3 key, and S3 keys admit newlines.
      mockListStacks.mockResolvedValue([{ stackName: 'MyStack', region: 'us-east-1\nFORGED' }]);
      mockIsLocked.mockResolvedValue(false);
      mockGetLockInfo.mockResolvedValue({
        owner: 'alice@host:1',
        expiresAt: Date.now() + 60_000,
      });

      await runStateOrphan(['orphan', 'MyStack', '--yes']);

      const lines = warnSpy.mock.calls.map((c) => String(c[0]));
      const warned = lines.find((l) => l.includes('Force-releasing'));
      expect(warned, 'the live-lock warning did not fire').toBeDefined();
      expect(warned).not.toContain('\n');
      // Since go-to-k/cdkd#3760 a non-plain region beside this run's
      // `Destroy with:` row is DESCRIBED rather than shown, so the planted
      // text does not reach the line at all.
      expect(warned).toContain('MyStack (a region that is not a plain identifier)');
      expect(warned).not.toContain('FORGED');
    });

    it('withholds the still-running claim for an unnamed holder, keeping the rest', async () => {
      // Agrees with lock-contention-message.ts: an unusable owner withholds
      // the CERTIFICATION, not the fact that the lock has not expired.
      mockListStacks.mockResolvedValue([{ stackName: 'MyStack', region: 'us-east-1' }]);
      mockIsLocked.mockResolvedValue(false);
      mockGetLockInfo.mockResolvedValue({ owner: '', expiresAt: Date.now() + 60_000 });

      await runStateOrphan(['orphan', 'MyStack', '--yes']);

      const warned = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(warned).toContain('held by an unnamed holder');
      expect(warned).not.toContain('That process is still running');
      expect(warned).toContain('has not expired');
    });

    it('stays quiet for an EXPIRED lock', async () => {
      // An expired lock is exactly what force-unlock exists for; warning about
      // it would train the user to ignore the line that matters.
      mockListStacks.mockResolvedValue([{ stackName: 'MyStack', region: 'us-east-1' }]);
      mockIsLocked.mockResolvedValue(false);
      mockGetLockInfo.mockResolvedValue({ owner: 'bob@host:1', expiresAt: Date.now() - 60_000 });

      await runStateOrphan(['orphan', 'MyStack', '--yes']);

      const warned = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(warned).not.toMatch(/Force-releasing a LIVE lock/);
      expect(mockForceReleaseLock).toHaveBeenCalledWith('MyStack', 'us-east-1');
    });

    it('stays quiet when there is no lock at all', async () => {
      mockListStacks.mockResolvedValue([{ stackName: 'MyStack', region: 'us-east-1' }]);
      mockIsLocked.mockResolvedValue(false);
      mockGetLockInfo.mockResolvedValue(null);

      await runStateOrphan(['orphan', 'MyStack', '--yes']);

      expect(warnSpy.mock.calls.map((c) => String(c[0])).join('\n')).not.toMatch(
        /Force-releasing a LIVE lock/
      );
    });

    it('never blocks the removal on a failing lock read', async () => {
      // Best-effort in both directions: the user asked for the record to go.
      mockListStacks.mockResolvedValue([{ stackName: 'MyStack', region: 'us-east-1' }]);
      mockIsLocked.mockResolvedValue(false);
      mockGetLockInfo.mockRejectedValue(new Error('AccessDenied'));

      await runStateOrphan(['orphan', 'MyStack', '--yes']);

      expect(mockDeleteState).toHaveBeenCalledWith('MyStack', 'us-east-1');
      expect(mockForceReleaseLock).toHaveBeenCalledWith('MyStack', 'us-east-1');
    });
  });

  describe('a legacy record that names no region (issue #2537)', () => {
    // `listStacks` yields a region-less ref ONLY for a legacy key whose body
    // carries no `region` field. That branch used to call `forceReleaseLock`
    // and nothing else — which deletes `{prefix}/{stack}/lock.json`, the LOCK,
    // not `{prefix}/{stack}/state.json` — and then printed the success line
    // anyway.
    it('deletes the state file, not just the lock', async () => {
      mockListStacks.mockResolvedValue([{ stackName: 'LegacyStack' }]);
      mockIsLocked.mockResolvedValue(false);

      await runStateOrphan(['orphan', 'LegacyStack', '--yes']);

      expect(mockDeleteLegacyState).toHaveBeenCalledWith('LegacyStack');
      // The regression's exact shape: the lock released, the record left, and
      // a success line regardless. Asserting the success line WITHOUT the
      // delete is what used to pass, so both halves are pinned together.
      expect(mockForceReleaseLock).toHaveBeenCalledWith('LegacyStack', undefined);
      const printed = infoSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(printed).toContain('Removed state for stack: LegacyStack');
    });

    it('does not route the region-less record through the region-scoped delete', async () => {
      mockListStacks.mockResolvedValue([{ stackName: 'LegacyStack' }]);
      mockIsLocked.mockResolvedValue(false);

      await runStateOrphan(['orphan', 'LegacyStack', '--yes']);

      // `deleteState` would need a region to key its DeleteObject off; calling
      // it with `undefined` would target a literal 'undefined' path segment.
      expect(mockDeleteState).not.toHaveBeenCalled();
    });

    it('reports no removal when the state delete fails', async () => {
      // The point of the fix is that the success line follows the delete. Make
      // the delete throw and the line must not appear.
      mockListStacks.mockResolvedValue([{ stackName: 'LegacyStack' }]);
      mockIsLocked.mockResolvedValue(false);
      mockDeleteLegacyState.mockRejectedValue(
        new StateError("Failed to delete legacy state for stack 'LegacyStack': AccessDenied")
      );

      await expect(runStateOrphan(['orphan', 'LegacyStack', '--yes'])).rejects.toThrow();

      const printed = infoSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(printed).not.toContain('Removed state for stack: LegacyStack');
      // And the lock is not released either — the record still exists.
      expect(mockForceReleaseLock).not.toHaveBeenCalled();
      // The backend's message reaches the user rather than being swallowed.
      // Its exact format is pinned in the backend suite; here the point is
      // that the run fails instead of printing a removal.
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(String(errorSpy.mock.calls[0]?.[0] ?? '')).toContain(
        'Failed to delete legacy state'
      );
    });

    it('refuses a LOCKED region-less record, labelling it legacy', async () => {
      // The lock guard labels a ref with no region `legacy`, and it must
      // refuse BEFORE the new delete — a locked record stays put.
      mockListStacks.mockResolvedValue([{ stackName: 'LegacyStack' }]);
      mockIsLocked.mockResolvedValue(true);

      await expect(runStateOrphan(['orphan', 'LegacyStack', '--yes'])).rejects.toThrow();

      const msg = String(errorSpy.mock.calls[0]?.[0] ?? '');
      expect(msg).toContain('Stack LegacyStack (legacy) is locked');
      // Not '((legacy))': the message template supplies the parentheses.
      expect(msg).not.toContain('((legacy))');
      expect(mockDeleteLegacyState).not.toHaveBeenCalled();
    });

    it('--force removes a locked region-less record', async () => {
      mockListStacks.mockResolvedValue([{ stackName: 'LegacyStack' }]);
      mockIsLocked.mockResolvedValue(true);
      mockGetLockInfo.mockResolvedValue({
        owner: 'bob@host:99',
        operation: 'deploy',
        expiresAt: Date.now() + 10 * 60_000,
      });

      await runStateOrphan(['orphan', 'LegacyStack', '--force']);

      // The live-lock warning fires for the region-less arm too (it is passed
      // `undefined`, not a region), and the removal still happens.
      expect(warnSpy.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(
        /Force-releasing a LIVE lock/
      );
      expect(mockDeleteLegacyState).toHaveBeenCalledWith('LegacyStack');
    });

    it('routes each stack of a mixed invocation to its own arm', async () => {
      mockListStacks.mockResolvedValue([
        { stackName: 'LegacyStack' },
        { stackName: 'ModernStack', region: 'us-east-1' },
      ]);
      mockIsLocked.mockResolvedValue(false);

      await runStateOrphan(['orphan', 'LegacyStack', 'ModernStack', '--yes']);

      expect(mockDeleteLegacyState).toHaveBeenCalledTimes(1);
      expect(mockDeleteLegacyState).toHaveBeenCalledWith('LegacyStack');
      expect(mockDeleteState).toHaveBeenCalledTimes(1);
      expect(mockDeleteState).toHaveBeenCalledWith('ModernStack', 'us-east-1');
    });

    it('--stack-region excludes a region-less record rather than matching it', async () => {
      // The target filter is `r.region === options.stackRegion`, so a ref with
      // no region cannot match — the run errors instead of silently deleting
      // the record the user did not name.
      mockListStacks.mockResolvedValue([{ stackName: 'LegacyStack' }]);
      mockIsLocked.mockResolvedValue(false);

      await expect(
        runStateOrphan(['orphan', 'LegacyStack', '--stack-region', 'us-east-1', '--yes'])
      ).rejects.toThrow();

      expect(String(errorSpy.mock.calls[0]?.[0] ?? '')).toContain('(legacy)');
      expect(mockDeleteLegacyState).not.toHaveBeenCalled();
    });

    it("the remedy `cdkd orphan`'s properties refusal prints selects the record (go-to-k/cdkd#3359)", async () => {
      // Driven with the text the REAL builder renders for the identity `cdkd
      // orphan` hands it for this record shape — no region, the one it is
      // listed under (pinned in `tests/unit/cli/orphan.test.ts`) — AND the
      // recovery context the binary always threads, so the argv is the one
      // production prints rather than a bare form it never emits. The stack
      // name carries a SPACE and a QUOTE, so an unquoted rendering splits into
      // different argv and names a different stack, and the quote exercises
      // `shellQuote`'s `'\\''` spelling; the argv is split the way a shell would
      // (m9 of go-to-k/cdkd#3363's review). The case above is the other half: the
      // synthesized region the refusal used to print selects nothing.
      const message = malformedOrphanResourcePropertiesRefusalMessage(
        "It's Legacy",
        undefined,
        ['Other'],
        { profile: 'prod', stateBucket: 'test-bucket', statePrefix: 'custom' }
      );
      const m = /^Drop the record: (cdkd state orphan .*)$/m.exec(message);
      expect(m, 'the drop remedy is no longer rendered in the expected shape').not.toBeNull();
      expect(m![1]!).toContain("cdkd state orphan 'It'\\''s Legacy' --profile prod");
      const argv = shellWords(m![1]!);
      expect(argv).toEqual([
        'cdkd', 'state', 'orphan', "It's Legacy",
        '--profile', 'prod', '--state-bucket', 'test-bucket', '--state-prefix', 'custom',
      ]);
      mockListStacks.mockResolvedValue([{ stackName: "It's Legacy" }]);
      mockIsLocked.mockResolvedValue(false);

      await runStateOrphan([...argv.slice(2), '--yes']);

      expect(mockDeleteLegacyState).toHaveBeenCalledWith("It's Legacy");
      expect(mockDeleteState).not.toHaveBeenCalled();
      // The prefix the pasted flags carried is the one the backend was built with.
      const config = vi.mocked(S3StateBackend).mock.calls.at(-1)?.[1] as { prefix?: string };
      expect(config?.prefix).toBe('custom');
    });

    it('treats an EMPTY --stack-region as a value, not as absent', async () => {
      // `--stack-region ''` is falsy. A truthy test skipped the region filter
      // outright, so the flag the user passed to NARROW a destructive command
      // silently widened it to every region.
      //
      // The guard moved to parse time (issue #2556) once the same defect was
      // found at fourteen more declarations, so the run now fails before any
      // ref is read. No `listStacks` result is primed on purpose: priming one
      // would suggest the walk happens, and the assertion below is that it
      // does not. What the case pins is unchanged — an empty value never
      // reaches a delete.
      await expect(
        runStateOrphan(['orphan', 'LegacyStack', '--stack-region', '', '--yes'])
      ).rejects.toThrow(/is invalid/);

      expect(mockDeleteLegacyState).not.toHaveBeenCalled();
      expect(mockDeleteState).not.toHaveBeenCalled();
      // Rejected before the bucket was even listed.
      expect(mockListStacks).not.toHaveBeenCalled();
    });

    it('still uses the region-scoped delete when the ref carries a region', async () => {
      // The opposite polarity: a legacy key whose body DOES name a region is
      // handed to `listStacks` as a region-carrying ref and must keep taking
      // the existing path, whose legacy sweep is region-conditional.
      mockListStacks.mockResolvedValue([{ stackName: 'LegacyStack', region: 'eu-west-1' }]);
      mockIsLocked.mockResolvedValue(false);

      await runStateOrphan(['orphan', 'LegacyStack', '--yes']);

      expect(mockDeleteState).toHaveBeenCalledWith('LegacyStack', 'eu-west-1');
      expect(mockDeleteLegacyState).not.toHaveBeenCalled();
    });
  });
});
