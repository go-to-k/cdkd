/**
 * The CLI's two shared confirmation-prompt helpers.
 *
 * They have OPPOSITE defaults and opposite non-interactive behaviour, which is
 * why both live here rather than one being expressed in terms of the other:
 *
 *  - {@link promptYesNo} — default-YES (`[Y/n]`, empty input accepts). Used by
 *    the issue #1007 asset-storage auto-create on interactive TTY deploys
 *    without `--yes`. It deliberately carries NO non-interactive guard: its
 *    only caller (`deploy.ts`, at the `options.yes || !process.stdin.isTTY`
 *    short-circuit) never reaches it on a non-TTY stdin, and a deploy that
 *    assumes "yes" is the one place in the CLI where auto-confirming is the
 *    documented choice.
 *  - {@link confirmOrRefuse} — default-NO (`[y/N]`), and REFUSES outright on a
 *    non-interactive stdin. This is the one every MUTATING command uses.
 *
 * Kept in its own module (mirrors `recreate-confirm-prompt.ts`) so the
 * accept/decline parsing is unit-testable without importing whole command
 * files.
 */

// Namespace import, not `import readline from`: every caller of
// `confirmOrRefuse` is a command file whose unit suite already mocks
// `node:readline/promises` with a NAMED `createInterface` and no `default`
// key. A default import (what this module used before issue #2275 folded the
// nine prompts into it) resolves to `undefined` under those mocks and fails as
// "No 'default' export is defined" in suites this module never used to be part
// of.
import * as readline from 'node:readline/promises';
import { CdkdError } from '../../utils/error-handler.js';

/**
 * Default-YES confirmation prompt (`[Y/n]`, empty input = yes).
 *
 * See the module doc for why this one is deliberately unguarded.
 */
export async function promptYesNo(prompt: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const ans = await rl.question(`${prompt} [Y/n] `);
    return /^(y(es)?)?$/i.test(ans.trim());
  } finally {
    rl.close();
  }
}

/** Suffix appended to a {@link confirmOrRefuse} prompt when none is given. */
export const DEFAULT_CONFIRM_SUFFIX = ' [y/N] ';

export interface ConfirmOrRefuseOptions {
  /**
   * The message thrown when stdin is not interactive. Per-site, because the
   * flag that avoids the prompt differs per command (`--force` on
   * `cdkd rollback`, `-y / --yes` on most, plus `-f / --force` on
   * `cdkd orphan` and `cdkd state orphan`). It MUST name the command and that
   * flag: the refusal is the only thing a CI user sees, so it has to carry
   * the remedy.
   */
  refusal: string;
  /**
   * Appended to `prompt` verbatim. Defaults to {@link DEFAULT_CONFIRM_SUFFIX}.
   * Parameterised rather than normalised because these strings are
   * user-visible: `cdkd rollback` and `cdkd state orphan` shipped `(y/N): `
   * and the other seven sites shipped ` [y/N] `, and collapsing them here
   * would be an output change nobody asked for.
   */
  suffix?: string;
  /**
   * Stream the prompt is rendered to. Defaults to `process.stdout`.
   * `drift.ts` passes its `HumanTextSink.stream`, which is `process.stderr`
   * under `--json` so the prompt cannot land in the payload.
   */
  output?: NodeJS.WritableStream;
}

/**
 * Default-NO confirmation prompt that REFUSES a non-interactive run instead of
 * hanging on it (issue #2275, the class issue #2259 fixed for `cdkd destroy`).
 *
 * `rl.question` never settles when stdin is already at EOF, and EOF delivers
 * no signal, so nothing wakes it: a command that prompts without this guard
 * parks FOREVER in CI rather than failing, burning the job's whole timeout
 * budget. Measured on Node 24.15.0, the version `.node-version` pins, against
 * real `node:readline/promises`: `echo y |` resolves `"y"`, while both
 * `printf 'y' |` (a real answer with no trailing newline) and `< /dev/null`
 * stay pending indefinitely.
 *
 * REFUSE rather than auto-confirm, at every one of the nine sites this helper
 * replaced. Every one of them guards a MUTATION — a rollback replay, a state
 * record removal, an observed-property refresh, an orphan, an import, an
 * export-then-delete-state, a drift accept/revert, a CloudFormation stack
 * retirement, a state-bucket migration — so silently answering "yes" on
 * behalf of an absent operator is never the safe reading. `deploy.ts`'s
 * auto-confirm (`options.yes || !process.stdin.isTTY` -> proceed) stays the
 * deliberate exception, because a deploy that assumes "yes" is recoverable.
 *
 * A first cut of this guard (in `state.ts`, see the long comment at the
 * `state destroy --all` prompt) raced the question against readline's `close`
 * event and turned EOF into a decline. That lost three measured ways — a real
 * answer with no trailing newline was silently discarded, a delayed answer
 * lost the race, and an interactive Ctrl-C landed on the EOF arm — so do not
 * reintroduce it. A refusal has none of those.
 *
 * POSITION IS LOAD-BEARING, and this helper gets it for free: every call site
 * sits INSIDE the caller's `--yes` / `--force` short-circuit
 * (`if (!options.yes && !options.force) { ... }`), so a flagged
 * non-interactive run never reaches this function and never consults stdin at
 * all. Keep it that way — hoisting a call above its flag check would make
 * `--yes` refuse instead of proceed, which is the inverse bug.
 *
 * Throws {@link CdkdError} with the `NON_INTERACTIVE_CONFIRM` code, matching
 * `gc.ts` and `bootstrap-destroy.ts` — the only two of the five originally
 * guarded prompts that carry a code (the other three throw a bare `Error` or
 * a `LocalMigrateError`). `handleError` maps it to exit 1, so CI can branch on
 * it.
 *
 * TWO GUARDED PROMPTS DELIBERATELY DO NOT ROUTE THROUGH HERE:
 * `destroy-runner.ts`'s per-stack prompt (the issue #2259 fix) and
 * `state.ts`'s `state destroy --all` batch prompt (issue #2247). Both already
 * carry this exact guard inline, and both differ in ways a shared helper would
 * have to grow parameters for — `destroy-runner.ts` has a default-YES bare
 * form alongside a default-NO `--remove-protection` form, and `state.ts`
 * passes an abort `signal` for the issue #2117 Ctrl-C handling. Folding them
 * in would also drag `destroy-runner.ts` (in the `integ-destroy` AND
 * `integ-broad` gate scopes) into a pure refactor's blast radius, buying a
 * real-AWS run for no behaviour change. The other five pre-existing guarded
 * prompts (`gc.ts`, `bootstrap-destroy.ts`, `recreate-confirm-prompt.ts`,
 * `prefix-migration-check.ts`, `migrate-command.ts`) stay put for the same
 * reason: each guards its own flow with its own error type.
 *
 * @param prompt the question, WITHOUT its trailing `[y/N]` marker
 * @returns `true` only for `y` / `yes` (any case, trimmed)
 */
export async function confirmOrRefuse(
  prompt: string,
  options: ConfirmOrRefuseOptions
): Promise<boolean> {
  // BEFORE `createInterface`, which is the whole point: there is no window in
  // which a never-settling question could be awaited.
  if (process.stdin.isTTY !== true) {
    throw new CdkdError(options.refusal, 'NON_INTERACTIVE_CONFIRM');
  }
  const rl = readline.createInterface({
    input: process.stdin,
    output: options.output ?? process.stdout,
  });
  try {
    const ans = await rl.question(`${prompt}${options.suffix ?? DEFAULT_CONFIRM_SUFFIX}`);
    // Seven of the nine folded sites spelled the accept test this way and the
    // other two used `t === 'y' || t === 'yes'` on a lower-cased trim. They
    // are equivalent (`/^y(es)?$/i` matches exactly `y` and `yes`, any case);
    // the regex is the majority spelling, so it is the one that survived.
    return /^y(es)?$/i.test(ans.trim());
  } finally {
    rl.close();
  }
}
