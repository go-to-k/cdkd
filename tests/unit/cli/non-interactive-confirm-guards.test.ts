/**
 * Issue [#2275](https://github.com/go-to-k/cdkd/issues/2275): the NINE
 * confirmation prompts that still hung forever on an EOF stdin — the class
 * issue #2259 fixed for `cdkd destroy` alone.
 *
 * `rl.question` never settles once stdin is at EOF, and EOF delivers no
 * signal, so a command that prompts without a non-TTY guard parks FOREVER in
 * CI rather than failing, burning the job's whole timeout budget. All nine
 * sites now route through the ONE shared `confirmOrRefuse` helper
 * (`src/cli/commands/confirm-prompt.ts`), which refuses before the interface
 * exists.
 *
 * THIS FILE PROBES EACH SITE'S OWN PROMPT HELPER, one row per site, because
 * what varies per site is not the guard (there is only one now) but the two
 * things a shared helper cannot fix by itself:
 *
 *  - the REFUSAL TEXT, which must name that command and the flag that avoids
 *    the prompt — `--force` on `cdkd rollback`, `-y / --yes` on most, plus
 *    `-f / --force` on the two orphan commands. It is the only thing a CI
 *    user sees, so a site naming the wrong flag is a real defect a
 *    helper-level test cannot see;
 *  - the PROMPT STRING, whose suffix differs by site (`(y/N): ` on
 *    `cdkd rollback` and `cdkd state orphan`, ` [y/N] ` on the other seven).
 *    Folding nine copies into one helper is exactly where those would have
 *    been silently normalised.
 *
 * The refusal cases mock `question` to NEVER SETTLE, following
 * `tests/unit/cli/destroy-runner-sigint.test.ts`: with the guard removed they
 * do not fail an assertion, they HANG, and the 5 s per-case timeout is the
 * fence. That is the only shape that distinguishes the production hang from a
 * proxy for it.
 *
 * The COMMAND-LEVEL half — that each command's call site actually reaches its
 * helper, and that the refusal surfaces to the user with nothing mutated —
 * lives in each command's own suite (`state-orphan.test.ts`,
 * `orphan.test.ts`, `import.test.ts`, `state-migrate.test.ts`,
 * `retire-cfn-stack.test.ts`, `export-nested-loop.test.ts`,
 * `drift-json-stream.test.ts`), where the AWS mocks that reach the prompt
 * already exist.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { setStdinIsTty } from '../../stdin-tty.js';

const readlineQuestion = vi.hoisted(() => vi.fn<(prompt: string) => Promise<string>>());
const readlineClose = vi.hoisted(() => vi.fn());
const createInterfaceMock = vi.hoisted(() =>
  vi.fn((_opts: { input: unknown; output: unknown }) => ({
    question: readlineQuestion,
    close: readlineClose,
  }))
);
vi.mock('node:readline/promises', () => ({
  default: { createInterface: createInterfaceMock },
  createInterface: createInterfaceMock,
}));

import { CdkdError } from '../../../src/utils/error-handler.js';
import { confirm as rollbackConfirm } from '../../../src/cli/commands/rollback.js';
import {
  confirmStateOrphanRemoval,
  confirmRefresh,
} from '../../../src/cli/commands/state.js';
import { confirmPrompt as orphanConfirm } from '../../../src/cli/commands/orphan.js';
import { confirmPrompt as importConfirm } from '../../../src/cli/commands/import.js';
import { confirmPrompt as exportConfirm } from '../../../src/cli/commands/export.js';
import { confirmPrompt as driftConfirm } from '../../../src/cli/commands/drift.js';
import { confirmPrompt as retireConfirm } from '../../../src/cli/commands/retire-cfn-stack.js';
import { confirmPrompt as stateMigrateConfirm } from '../../../src/cli/commands/state-migrate.js';
import { confirmPrompt as eventsPruneConfirm } from '../../../src/cli/commands/events.js';

/** The `HumanTextSink` shape `drift.ts`'s prompt takes. */
const DRIFT_SINK = { write: (): void => {}, stream: process.stderr };

interface Site {
  /** How `cdkd --help` spells the command that reaches this prompt. */
  readonly command: string;
  readonly call: (prompt: string) => Promise<boolean>;
  /** The exact string handed to `rl.question` for the prompt `'Proceed?'`. */
  readonly rendered: string;
  /** Substrings the refusal must carry: the command, then every way through. */
  readonly names: readonly string[];
  /**
   * Substrings the refusal must NOT carry.
   *
   * `names` is `toContain`-only, so DELETING an entry from it asserts nothing
   * — which is how a refusal can go on advertising a command that no longer
   * exists. Measured while removing `cdkd migrate` (issue
   * go-to-k/cdkd#2572): re-adding `or cdkd migrate --retire-cfn-stack` to the
   * refusal string left all 42 cases green. The removal of a name is a claim,
   * and a claim needs its own assertion.
   */
  readonly absentNames?: readonly string[];
}

/**
 * One row per site, written out by hand rather than derived from the source —
 * a table generated from the code under test cannot notice a site that
 * disappeared, and the `rendered` / `names` columns are the SPEC, not an
 * observation.
 */
const SITES: readonly Site[] = [
  {
    command: 'cdkd rollback',
    call: rollbackConfirm,
    rendered: 'Proceed? (y/N): ',
    names: ['cdkd rollback', '--force', '-y / --yes'],
  },
  {
    command: 'cdkd state orphan',
    call: confirmStateOrphanRemoval,
    rendered: 'Proceed? (y/N): ',
    names: ['cdkd state orphan', '-y / --yes', '-f / --force'],
  },
  {
    command: 'cdkd state refresh-observed',
    call: confirmRefresh,
    rendered: 'Proceed? [y/N] ',
    names: ['cdkd state refresh-observed', '-y / --yes'],
  },
  {
    command: 'cdkd orphan',
    call: orphanConfirm,
    rendered: 'Proceed? [y/N] ',
    names: ['cdkd orphan', '-y / --yes', '-f / --force'],
  },
  {
    command: 'cdkd import',
    call: importConfirm,
    rendered: 'Proceed? [y/N] ',
    names: ['cdkd import', '-y / --yes'],
  },
  {
    command: 'cdkd export',
    call: exportConfirm,
    rendered: 'Proceed? [y/N] ',
    names: ['cdkd export', '-y / --yes'],
  },
  {
    command: 'cdkd drift --accept / --revert',
    call: (prompt: string) => driftConfirm(prompt, DRIFT_SINK),
    rendered: 'Proceed? [y/N] ',
    names: ['cdkd drift', '-y / --yes'],
  },
  {
    command: 'cdkd import --migrate-from-cloudformation (CFn stack retirement)',
    call: retireConfirm,
    rendered: 'Proceed? [y/N] ',
    // Reachable from ONE command since `cdkd migrate --retire-cfn-stack` was
    // removed with its command (issue #2572), so the refusal names that one —
    // a CI user who has just been told a flag is missing still has to know
    // which invocation to put it on. It is also the only site that fires
    // AFTER its command's state write, so the refusal states that too —
    // `confirmOrRefuse`'s contract is that the refusal is the only thing that
    // user sees.
    names: [
      'CloudFormation stack retirement',
      '-y / --yes',
      'cdkd import --migrate-from-cloudformation',
      'cdkd state has already been written',
    ],
    // The one user-visible claim of issue go-to-k/cdkd#2572: this refusal
    // named `cdkd migrate --retire-cfn-stack` as a second way through, and
    // must not any more.
    //
    // NO trailing space. A first draft had one, on the theory that it stopped
    // an over-match; the only nearby command is `cdkd state migrate`, which
    // does not contain the substring `cdkd migrate` at all (it has `state `
    // between), so nothing was being guarded against -- while the space DID
    // miss a sentence-final `... cdkd migrate.`, which is the exact shape this
    // refusal now uses one clause earlier.
    absentNames: ['cdkd migrate'],
  },
  {
    command: 'cdkd state migrate',
    call: stateMigrateConfirm,
    rendered: 'Proceed? [y/N] ',
    names: ['cdkd state migrate', '-y / --yes'],
  },
  // The TENTH, folded by issue #2454 rather than #2275. It was already
  // guarded — at its CALLER, not in a helper — so it never hung; what it did
  // was refuse with `logger.info` and RETURN, i.e. exit 0, leaving a CI job
  // unable to tell "cdkd refused" from "cdkd pruned nothing". Folding it here
  // gives it the same exit-1 contract as the nine and removes the last copy
  // of the byte-identical helper.
  {
    command: 'cdkd events prune',
    call: eventsPruneConfirm,
    rendered: 'Proceed? [y/N] ',
    names: ['cdkd events prune', '-y / --yes', 'Nothing has been deleted'],
  },
];

let originalIsTTY: boolean | undefined;

beforeEach(() => {
  originalIsTTY = process.stdin.isTTY;
  vi.clearAllMocks();
});

afterEach(() => {
  setStdinIsTty(originalIsTTY);
});

describe('every mutating confirmation prompt refuses a non-interactive stdin (issue #2275)', () => {
  it('covers all ten sites that route through the guarded helper', () => {
    // A floor written as a LITERAL, so a row silently dropped from `SITES`
    // reds this rather than shrinking both sides of a derived comparison
    // together. TEN sites, nine modules: `state.ts` holds two. Issue #2275
    // enumerated nine; `cdkd events prune` was folded in later by issue
    // #2454, and the literal below has counted ten since — the title and this
    // sentence had not caught up.
    expect(SITES).toHaveLength(10);
    expect(new Set(SITES.map((s) => s.command)).size).toBe(10);
  });

  it.each(SITES.map((s) => [s.command, s] as const))(
    '%s REFUSES instead of hanging on a question that never settles',
    async (_command, site) => {
      setStdinIsTty(undefined);
      // A question that never settles is what an EOF stdin actually produces.
      // With the guard removed this case does not fail an assertion — it
      // HANGS, and the 5 s timeout below is the fence.
      readlineQuestion.mockImplementation(async () => await new Promise<string>(() => {}));

      const error = await site.call('Proceed?').catch((e: unknown) => e);

      // The CODE, not merely that something threw: only `gc.ts` and
      // `bootstrap-destroy.ts` carried it among the four originally guarded
      // prompts, and matching them is what lets CI branch on the refusal.
      expect(error).toBeInstanceOf(CdkdError);
      expect((error as CdkdError).code).toBe('NON_INTERACTIVE_CONFIRM');

      // Refused BEFORE the interface exists, which is the whole point: there
      // is no window in which a never-settling question could be awaited.
      expect(createInterfaceMock).not.toHaveBeenCalled();
      expect(readlineQuestion).not.toHaveBeenCalled();
    },
    5000
  );

  it.each(SITES.map((s) => [s.command, s] as const))(
    '%s names itself and every flag that avoids the prompt',
    async (_command, site) => {
      setStdinIsTty(undefined);

      const error = await site.call('Proceed?').catch((e: unknown) => e);
      const message = (error as Error).message;

      for (const needle of site.names) {
        expect(message, `refusal did not name ${needle}`).toContain(needle);
      }
      for (const needle of site.absentNames ?? []) {
        expect(
          message,
          `refusal still advertises "${needle}", which no longer exists`
        ).not.toContain(needle);
      }
      expect(message).toContain('non-interactive environment');
    }
  );

  it.each(SITES.map((s) => [s.command, s] as const))(
    '%s still prompts on a TTY, with its shipped prompt string byte-exact',
    async (_command, site) => {
      // The negative control, and the fence on the SUFFIX. Without it a guard
      // that refused unconditionally — or a fold that normalised `(y/N): ` to
      // ` [y/N] ` — would satisfy every case above while changing what the
      // operator sees.
      setStdinIsTty(true);
      readlineQuestion.mockResolvedValue('y');

      await expect(site.call('Proceed?')).resolves.toBe(true);

      expect(readlineQuestion).toHaveBeenCalledTimes(1);
      expect(readlineQuestion).toHaveBeenCalledWith(site.rendered);
      expect(readlineClose).toHaveBeenCalledTimes(1);
    }
  );

  it.each(SITES.map((s) => [s.command, s] as const))(
    '%s still DECLINES on a TTY when the user says no',
    async (_command, site) => {
      // The other half of the negative control: the guard must not have eaten
      // the decline path on its way past. A refusal and a user-declined `false`
      // are different outcomes reached through the same code.
      setStdinIsTty(true);
      readlineQuestion.mockResolvedValue('n');

      await expect(site.call('Proceed?')).resolves.toBe(false);
    }
  );

  it('drift attaches its prompt to the sink stream, not to stdout', async () => {
    // The one site with a non-default `output`: under `--json` the sink is
    // `process.stderr`, so the prompt cannot land in the payload. The
    // interface takes a sink ONCE and holds it, so the identity handed to
    // `createInterface` is the only observable (see `HumanTextSink` in
    // `drift.ts`).
    setStdinIsTty(true);
    readlineQuestion.mockResolvedValue('y');

    await driftConfirm('Proceed?', { write: (): void => {}, stream: process.stderr });

    expect(createInterfaceMock.mock.calls[0]?.[0]?.output).toBe(process.stderr);
  });
});
