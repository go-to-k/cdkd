/**
 * Unit tests for the two shared confirmation-prompt helpers.
 *
 * `promptYesNo` pins the default-YES `[Y/n]` semantics backing the issue
 * #1007 asset-storage auto-create prompt: empty input / `y` / `yes` (any case)
 * accept, everything else declines, and the readline interface is closed on
 * every path.
 *
 * `confirmOrRefuse` pins the default-NO `[y/N]` semantics AND the
 * non-interactive guard issue
 * [#2275](https://github.com/go-to-k/cdkd/issues/2275) added — the class issue
 * #2259 fixed for `cdkd destroy` alone. The refusal cases follow the shape
 * `tests/unit/cli/destroy-runner-sigint.test.ts` established for that fix:
 * the mocked `question` NEVER SETTLES, because a question that never settles
 * is what an EOF stdin actually produces. With the guard removed those cases
 * do not fail an assertion — they HANG, and the 5 s per-case timeout is the
 * fence. That is the only shape that distinguishes the production hang from a
 * proxy for it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { setStdinIsTty } from '../../../stdin-tty.js';

const readlineQuestion = vi.hoisted(() => vi.fn<(prompt: string) => Promise<string>>());
const readlineClose = vi.hoisted(() => vi.fn());
const createInterfaceMock = vi.hoisted(() =>
  // The parameter is TYPED rather than inferred: `vi.fn(() => ...)` gives
  // `mock.calls` an empty-tuple element type, so reading `calls[0][0]` — how
  // the `output` cases below assert which stream the prompt was attached to —
  // does not type-check.
  vi.fn((_opts: { input: unknown; output: unknown }) => ({
    question: readlineQuestion,
    close: readlineClose,
  }))
);
// BOTH shapes. `confirm-prompt.ts` uses a namespace import (`import * as
// readline`), which the named export answers; the `default` key is kept so
// this factory stays valid for a default-importing consumer too.
vi.mock('node:readline/promises', () => ({
  default: { createInterface: createInterfaceMock },
  createInterface: createInterfaceMock,
}));

const { promptYesNo, confirmOrRefuse, DEFAULT_CONFIRM_SUFFIX } = await import(
  '../../../../src/cli/commands/confirm-prompt.js'
);
const { CdkdError } = await import('../../../../src/utils/error-handler.js');

let originalIsTTY: boolean | undefined;

beforeEach(() => {
  originalIsTTY = process.stdin.isTTY;
  vi.clearAllMocks();
});

afterEach(() => {
  setStdinIsTty(originalIsTTY);
});

describe('promptYesNo', () => {
  beforeEach(() => {
    // `promptYesNo` is deliberately UNGUARDED (its only caller, `deploy.ts`,
    // short-circuits on a non-TTY stdin before reaching it), so these cases
    // must not depend on the TTY state either way. Pinned to `true` so a
    // future guard added here would red them rather than silently changing
    // which branch is under test.
    setStdinIsTty(true);
  });

  it.each([
    ['', true],
    ['y', true],
    ['Y', true],
    ['yes', true],
    ['YES', true],
    ['  y  ', true],
    ['n', false],
    ['no', false],
    ['nope', false],
    ['yess', false],
  ])('input %j -> %s', async (input, expected) => {
    readlineQuestion.mockResolvedValue(input);
    await expect(promptYesNo('Create it?')).resolves.toBe(expected);
    expect(readlineClose).toHaveBeenCalledTimes(1);
  });

  it('renders the [Y/n] default-yes suffix', async () => {
    readlineQuestion.mockResolvedValue('');
    await promptYesNo('Create it?');
    expect(readlineQuestion).toHaveBeenCalledWith('Create it? [Y/n] ');
  });

  it('closes the interface even when question rejects', async () => {
    readlineQuestion.mockRejectedValue(new Error('stdin closed'));
    await expect(promptYesNo('Create it?')).rejects.toThrow('stdin closed');
    expect(readlineClose).toHaveBeenCalledTimes(1);
  });

  it('still prompts on a NON-TTY stdin — the deliberate unguarded carve-out', async () => {
    // The one prompt in the CLI that must NOT refuse: `deploy.ts` reaches it
    // only from `!(options.yes || !process.stdin.isTTY)`, and issue #2275's
    // guard would change the asset-storage auto-create's contract if it were
    // applied here. A copy-paste of the guard into this helper reds this case.
    setStdinIsTty(undefined);
    readlineQuestion.mockResolvedValue('y');
    await expect(promptYesNo('Create it?')).resolves.toBe(true);
    expect(createInterfaceMock).toHaveBeenCalledTimes(1);
  });
});

const REFUSAL = 'The cdkd probe confirmation prompt cannot run non-interactively. Pass --probe-flag.';

describe('confirmOrRefuse (issue #2275)', () => {
  it(
    'REFUSES on a non-TTY stdin instead of hanging on a question that never settles',
    async () => {
      setStdinIsTty(undefined);
      // See the file header: with the guard removed this case HANGS rather
      // than failing an assertion, and the 5 s timeout is the fence.
      readlineQuestion.mockImplementation(async () => await new Promise<string>(() => {}));

      await expect(confirmOrRefuse('Proceed?', { refusal: REFUSAL })).rejects.toThrow(
        /cannot run non-interactively/
      );

      // Refused BEFORE the interface exists, which is the whole point: there
      // is no window in which a never-settling question could be awaited.
      expect(createInterfaceMock).not.toHaveBeenCalled();
      expect(readlineQuestion).not.toHaveBeenCalled();
    },
    5000
  );

  it('throws CdkdError with the NON_INTERACTIVE_CONFIRM code so CI can branch on it', async () => {
    // Only `gc.ts` and `bootstrap-destroy.ts` carry this code among the five
    // originally guarded prompts; the other three throw a bare `Error` /
    // `LocalMigrateError`. Matching the two that carry it is deliberate, so
    // asserting the CODE (not merely that something threw) is what keeps a
    // later refactor from silently downgrading the shape.
    setStdinIsTty(undefined);

    const error = await confirmOrRefuse('Proceed?', { refusal: REFUSAL }).catch(
      (e: unknown) => e
    );

    expect(error).toBeInstanceOf(CdkdError);
    expect((error as InstanceType<typeof CdkdError>).code).toBe('NON_INTERACTIVE_CONFIRM');
  });

  it('throws the caller-supplied refusal VERBATIM, so each site names its own flag', async () => {
    // The refusal is the only thing a CI user sees, so it has to carry the
    // remedy — and the remedy differs per command (`--force` on `cdkd
    // rollback`, `-y / --yes` on most, plus `-f / --force` on the two orphan
    // commands). A helper that built one generic message here would make
    // every per-site case in the sibling suites vacuous.
    setStdinIsTty(false);

    await expect(confirmOrRefuse('Proceed?', { refusal: REFUSAL })).rejects.toThrow(REFUSAL);
  });

  it.each([
    ['y', true],
    ['Y', true],
    ['yes', true],
    ['YES', true],
    ['  yes  ', true],
    ['', false],
    ['n', false],
    ['no', false],
    ['nope', false],
    ['yess', false],
  ])('TTY input %j -> %s (default-NO, empty declines)', async (input, expected) => {
    setStdinIsTty(true);
    readlineQuestion.mockResolvedValue(input);
    await expect(confirmOrRefuse('Proceed?', { refusal: REFUSAL })).resolves.toBe(expected);
    expect(readlineClose).toHaveBeenCalledTimes(1);
  });

  it('renders the [y/N] default-no suffix when none is given', async () => {
    setStdinIsTty(true);
    readlineQuestion.mockResolvedValue('y');
    await confirmOrRefuse('Proceed?', { refusal: REFUSAL });
    expect(readlineQuestion).toHaveBeenCalledWith('Proceed? [y/N] ');
    expect(DEFAULT_CONFIRM_SUFFIX).toBe(' [y/N] ');
  });

  it('renders a caller-supplied suffix verbatim, so the (y/N): sites keep their wording', async () => {
    // `cdkd rollback` and `cdkd state orphan` shipped `(y/N): ` and the other
    // seven sites shipped ` [y/N] `. Normalising them inside the helper would
    // be a user-visible output change nobody asked for.
    setStdinIsTty(true);
    readlineQuestion.mockResolvedValue('y');
    await confirmOrRefuse('Proceed?', { refusal: REFUSAL, suffix: ' (y/N): ' });
    expect(readlineQuestion).toHaveBeenCalledWith('Proceed? (y/N): ');
  });

  it('attaches the interface to process.stdout by default', async () => {
    setStdinIsTty(true);
    readlineQuestion.mockResolvedValue('y');
    await confirmOrRefuse('Proceed?', { refusal: REFUSAL });
    expect(createInterfaceMock.mock.calls[0]?.[0]?.output).toBe(process.stdout);
  });

  it('attaches the interface to a caller-supplied stream, which is how drift --json works', async () => {
    // `drift.ts` passes its `HumanTextSink.stream` — `process.stderr` under
    // `--json`, so the prompt cannot land in the payload. The identity of the
    // stream handed to `createInterface` is the only observable: the
    // interface takes a sink ONCE and holds it, so there are no bytes to
    // capture (see the `HumanTextSink` doc in `drift.ts`).
    setStdinIsTty(true);
    readlineQuestion.mockResolvedValue('y');
    await confirmOrRefuse('Proceed?', { refusal: REFUSAL, output: process.stderr });
    expect(createInterfaceMock.mock.calls[0]?.[0]?.output).toBe(process.stderr);
    expect(createInterfaceMock.mock.calls[0]?.[0]?.input).toBe(process.stdin);
  });

  it('closes the interface even when question rejects', async () => {
    setStdinIsTty(true);
    readlineQuestion.mockRejectedValue(new Error('stdin closed'));
    await expect(confirmOrRefuse('Proceed?', { refusal: REFUSAL })).rejects.toThrow(
      'stdin closed'
    );
    expect(readlineClose).toHaveBeenCalledTimes(1);
  });
});
