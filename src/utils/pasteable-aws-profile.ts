/**
 * The run's explicit `--profile`, carried into every pasteable `aws ...`
 * command cdkd prints (go-to-k/cdkd#3959).
 *
 * A remediation command such as `aws rds modify-db-instance ...
 * --deletion-protection` is only printed, never run by cdkd. Pasted into a
 * shell after `cdkd destroy --profile prod`, it resolves the operator's DEFAULT
 * profile, so it answers NotFound at best and at worst acts on a same-named
 * resource in another account. `lock-contention-message.ts` closed the same
 * hole for `cdkd force-unlock` by threading the profile through its context;
 * the `aws ...` commands are printed from dozens of provider sites on create,
 * update, delete and import paths, most of which receive no context at all.
 * `--profile` is one value per process, set before any command action runs, so
 * it is held HERE and the shared renderers (`pasteableAwsCommand` /
 * `renderDisableCommand` in `src/provisioning/replacement-protection-advice.ts`)
 * insert it after every `aws` command word they emit. A new renderer site gets
 * it without doing anything.
 *
 * Only an EXPLICIT `--profile` is recorded (`src/cli/program.ts`'s preAction
 * hook). An inherited `AWS_PROFILE` is deliberately not: a shell that exported
 * it passes it to the pasted command as well.
 *
 * It imports only from `src/utils/**`, so `src/cli/**`, `src/provisioning/**`
 * and `src/utils/**` can all import it.
 */
import { getAssumedRoleCredentials } from './aws-client-defaults.js';
import { displaySafe } from './display-safe.js';
import { commandHole, hasClauseBreak, shellQuote } from './pasteable-command.js';

let explicitProfile: string | undefined;

/**
 * Record the run's explicit `--profile` (`undefined` clears it). Called once
 * per command by the CLI's preAction hook; tests reset it through the same
 * function.
 */
export function setPasteableAwsProfile(profile: string | undefined): void {
  explicitProfile = profile;
}

/**
 * The `--profile ...` words a pasteable `aws` command must carry, WITHOUT
 * surrounding spaces, or `''` when the run named no profile.
 *
 * - No explicit profile (or an empty one): `''`, so the command is byte-for-byte
 *   what it was before go-to-k/cdkd#3959.
 * - A profile that renders exactly: `--profile <shellQuote(profile)>`.
 * - A profile `displaySafe` would ALTER, that starts with `-`, or that holds a
 *   clause break a selection could start inside: the quoted
 *   `'<profile>'` hole. Never the altered spelling (a different profile) and
 *   never nothing (the ambient default, the very mis-target this closes); an
 *   unfilled hole makes the AWS CLI refuse the profile before any call.
 * - A run that ALSO assumed a role (`--role-arn` / `CDKD_ROLE_ARN`): every
 *   cdkd call ran as that role, possibly in another account, while
 *   `--profile X` pasted runs as the BASE profile's principal. The
 *   `'<role-profile>'` hole says so and fails closed the same way.
 */
export function pasteableAwsProfileFlag(): string {
  const profile = explicitProfile;
  if (profile === undefined || profile === '') return '';
  if (getAssumedRoleCredentials() !== undefined) {
    // cdkd-profile-display: a literal hole; the profile's value is not printed.
    return `--profile ${commandHole('role-profile')}`;
  }
  const safe = displaySafe(profile);
  if (safe !== profile || profile.startsWith('-') || hasClauseBreak(profile)) {
    // cdkd-profile-display: a literal hole; the profile's value is not printed.
    return `--profile ${commandHole('profile')}`;
  }
  // cdkd-profile-display: gated above, the way `recoveryCommandFlags` gates the
  // force-unlock hint's profile rather than by `isPasteableIdent`, which would
  // refuse a legitimate non-ASCII profile name (go-to-k/cdkd#3377). Printed only
  // when `displaySafe` leaves it byte-identical, never with a leading `-` (an
  // option) or a clause break (a selection starting inside the quotes), and
  // `shellQuote` quotes a `~` or any other shell-active character.
  return `--profile ${shellQuote(profile)}`;
}

/**
 * Insert {@link pasteableAwsProfileFlag} after every `aws` COMMAND word in a
 * cdkd-authored literal span: at the span's start, or after whitespace, `;`,
 * `&`, `|` or `(`, and followed by a space and then a lowercase service name or
 * the END of the span (`` aws`aws ${service} describe-db-clusters ...` `` splices
 * the service as a fragment, so its first span is `aws ` alone). The AWS CLI accepts a global option
 * before the service name, so this is correct for every service, and a span
 * chaining several invocations (`... && aws ec2 associate-address ...`,
 * `... | xargs aws events remove-targets ...`) gets the flag on each.
 *
 * NEVER pass it a value from state or a template: only cdkd-authored literal
 * text, where `aws ` can only be a command word.
 */
export function withPasteableAwsProfile(literal: string): string {
  const flag = pasteableAwsProfileFlag();
  if (flag === '') return literal;
  return literal.replace(/(^|[\s;&|(])aws (?=[a-z]|$)/g, `$1aws ${flag} `);
}
