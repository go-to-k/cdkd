/**
 * The run's EXPLICIT account / bucket flags, carried into every pasteable
 * `cdkd ...` hint (go-to-k/cdkd#4177).
 *
 * A hint such as `cdkd state orphan MyStack --stack-region us-east-1`, printed
 * after `cdkd destroy MyStack --profile prod --state-bucket b`, used to resolve
 * the DEFAULT profile and the default bucket when pasted, so a destructive hint
 * could act on a same-named record in another account or bucket. The flags are
 * one value per process, set before any command action runs, so they are held
 * HERE (`src/cli/program.ts`'s `preAction` hook) and `pasteableCommand`
 * (`pasteable-command.ts`) appends the ones the hinted subcommand accepts. It is
 * the `cdkd` sibling of `pasteable-aws-profile.ts`.
 *
 * Only values the operator TYPED are recorded: `--profile`, `--state-bucket`,
 * a `--state-prefix` given on the command line, and whether `--role-arn` was
 * given. An inherited `AWS_PROFILE`, `CDKD_STATE_BUCKET` or `CDKD_ROLE_ARN`
 * reaches the pasted command from the same shell, and a default bucket
 * re-resolves to the same name under the same profile, so none of those is
 * printed (the default name also carries the account id, which cdkd keeps off
 * default-level output).
 *
 * IMPORT-FREE on purpose: `pasteable-command.ts` reads it, and
 * `pasteable-command.ts` is itself imported almost everywhere.
 */

/** What the operator typed for the four flags, or `undefined` when absent. */
export interface PasteableRunFlags {
  readonly profile?: string | undefined;
  readonly stateBucket?: string | undefined;
  /** Set only when `--state-prefix` came from the command line, not its default. */
  readonly statePrefix?: string | undefined;
  /** True when `--role-arn` was passed on the command line. */
  readonly roleArn?: boolean | undefined;
}

let runFlags: PasteableRunFlags = {};
let verbFlags: ReadonlyMap<string, ReadonlySet<string>> | undefined;

/** Record the run's flags; `{}` clears them. Called once per command by `preAction`. */
export function setPasteableRunFlags(flags: PasteableRunFlags): void {
  runFlags = { ...flags };
}

/** The flags recorded by {@link setPasteableRunFlags}. */
export function pasteableRunFlags(): PasteableRunFlags {
  return runFlags;
}

/**
 * Record, per full verb (`'cdkd state orphan'`), the long option names that
 * subcommand accepts. `buildProgram()` derives it from the real Commander tree,
 * so a hint only ever gains a flag its command parses; `undefined` (no program
 * built) means no flag is appended anywhere.
 */
export function setPasteableVerbFlags(
  map: ReadonlyMap<string, ReadonlySet<string>> | undefined
): void {
  verbFlags = map;
}

/** The long options `verb` accepts, or `undefined` when unknown. */
export function pasteableVerbFlags(verb: string): ReadonlySet<string> | undefined {
  return verbFlags?.get(verb);
}
