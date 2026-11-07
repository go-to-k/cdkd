/**
 * `--assume-role` parsing and resolution for `cdkd local start-api`.
 * Split out of `../options.ts`, which re-exports the public names.
 */
import { displayIdent, ROLE_ARN_MAX_CODE_POINTS } from '../../utils/display-safe.js';
import { isIamRoleArn } from '../../utils/role-arn.js';
import { shellBoundedDisplay } from '../../utils/pasteable-command.js';
import { nullPrototypeRecord } from '../../utils/own-keys.js';

/**
 * Per-Lambda + global `--assume-role` parser used by `cdkd local
 * start-api` (D8.2). Mirrors the `--resource-timeout` parser shape:
 * each invocation is either a bare ARN (sets / overwrites the global
 * default) or `<LogicalId>=<arn>` (per-Lambda override). Per-Lambda
 * always wins over global; global is the fallback when no per-Lambda
 * entry exists.
 */
export interface AssumeRoleOption {
  /** Global ARN — last bare-arn token wins. */
  globalArn?: string;
  /** Per-Lambda override map (`LogicalId` -> ARN). */
  perLambda: Record<string, string>;
  /**
   * Issue #256 Option 1 - `--assume-role-auto` means auto-resolve EACH
   * routed Lambda's own execution role per-Lambda. Mutually exclusive
   * with `globalArn`; the per-Lambda map still wins for the named
   * Lambda. Set by normalizeStartApiAssumeRole from the separate
   * `--assume-role-auto` boolean flag - never set directly by
   * parseAssumeRoleToken.
   */
  bareAutoResolve?: boolean;
}

/**
 * Argparse for the repeatable `--assume-role` flag.
 *
 * Validates that:
 *   - bare values look like an IAM role ARN;
 *   - `<LogicalId>=<arn>` left-hand sides look like a CFn logical ID
 *     (alphanumeric, no separators);
 *   - the right-hand side ARN is well-shaped.
 *
 * Both ARN forms are checked by `isIamRoleArn` (`src/utils/role-arn.ts`), the
 * one predicate every `AssumeRoleCommand` send site also enforces (issue
 * [#2348](https://github.com/go-to-k/cdkd/issues/2348)). This file used to own a
 * START-anchored `/^arn:[^:]+:iam::\d+:role\//`, which passed anything after
 * `role/` — an ESC, a newline, or megabytes. Both forms are `.trim()`med before
 * the check: the `LogicalId=<arn>` form always was, and the bare form now is
 * too, because the anchored pattern would otherwise start refusing a
 * copy-pasted ARN with trailing whitespace.
 */
export function parseAssumeRoleToken(
  raw: string,
  previous: AssumeRoleOption | undefined
): AssumeRoleOption {
  // Null-prototype map (issue #2348 security review): `constructor` /
  // `toString` are legal CloudFormation logical ids, and a plain `{}` answered
  // them with an inherited FUNCTION in `effectiveAssumeRoleArn`.
  const acc: AssumeRoleOption = previous ?? { perLambda: nullPrototypeRecord<string>() };
  if (!acc.perLambda) acc.perLambda = nullPrototypeRecord<string>();

  // Every render below is ARGV — the most untrusted text cdkd handles — and all
  // three are REFUSALS, so the value reaching them is by construction one no
  // shape test accepted (issue go-to-k/cdkd#3397, the same argument issue
  // [#3377](https://github.com/go-to-k/cdkd/issues/3377) made about
  // `writeProfileCredentialsFile` interpolating the name it was refusing).
  // `shownRaw` is bound once so the three cannot drift.
  //
  // ALL THREE, not just the ARN-shaped one: `raw` and `logicalId` are the same
  // argv with different substrings taken, so sanitizing the operand that
  // happens to be called `arn` and leaving its neighbours raw would be the
  // "guard defeated by its own neighbour" shape on one line.
  //
  // Each goes through `quotedArgv`, never inside a hand-written `"..."`
  // (go-to-k/cdkd#3950): `displayIdent`'s JSON boundary does not survive a
  // quote around it, so a `"` in the argv closed cdkd's, and `$( )` or a
  // backtick runs inside double quotes regardless when the sentence is pasted.
  const shownRaw = quotedArgv(raw, ROLE_ARN_MAX_CODE_POINTS);
  // A value that STARTS as an ARN is the bare form even when it contains `=`:
  // IAM role names allow `=` (`role/a=b`), and a logical id can never start
  // with `arn:` (no `:` in one), so the two forms cannot be confused.
  const eqIndex = raw.trim().startsWith('arn:') ? -1 : raw.indexOf('=');
  if (eqIndex === -1) {
    const bare = raw.trim();
    if (!isIamRoleArn(bare)) {
      throw new Error(
        `Invalid --assume-role value ${shownRaw}: expected an IAM role ARN like arn:aws:iam::123456789012:role/MyRole, or LogicalId='<arn>'.`
      );
    }
    acc.globalArn = bare;
    return acc;
  }

  const logicalId = raw.substring(0, eqIndex).trim();
  const arn = raw.substring(eqIndex + 1).trim();
  if (!/^[A-Za-z][A-Za-z0-9]*$/.test(logicalId)) {
    throw new Error(
      `Invalid --assume-role value ${shownRaw}: left-hand side ${quotedArgv(logicalId)} must be a CloudFormation logical ID (alphanumeric, leading letter).`
    );
  }
  if (!isIamRoleArn(arn)) {
    throw new Error(
      `Invalid --assume-role value ${shownRaw}: right-hand side ${quotedArgv(arn, ROLE_ARN_MAX_CODE_POINTS)} must be an IAM role ARN like arn:aws:iam::123456789012:role/MyRole.`
    );
  }
  acc.perLambda[logicalId] = arn;
  return acc;
}

/**
 * An `--assume-role` operand for its refusal: `"value"` when it has no
 * whitespace and `displayIdent` renders it unchanged, which prints the parse
 * refusals' operands exactly as before (the auto-resolve refusal's global ARN,
 * bare before, is now quoted), and otherwise
 * `shellBoundedDisplay` over that render (go-to-k/cdkd#3950). The operator
 * needs the value to correct it, so it is shown shell-quoted rather than
 * described, the way the resolver shows a refused `Fn::GetStackOutput`
 * `RoleArn`. `shellBoundedDisplay` itself describes a render holding a clause
 * break (a tab or a cut marker included), and quotes `'<unrenderable>'`.
 */
function quotedArgv(value: string, maxCodePoints?: number): string {
  const shown = displayIdent(value, maxCodePoints === undefined ? undefined : { maxCodePoints });
  // Whitespace FIRST: a value that IS `displayIdent`'s own cut output is then
  // refused without resting on the marker's tail digest, the only thing
  // keeping the round-trip from admitting it (go-to-k/cdkd#4002).
  return !/\s/.test(value) && shown === value ? `"${value}"` : shellBoundedDisplay(shown);
}

/**
 * Compose `--assume-role` (value-form accumulator) and the separate
 * `--assume-role-auto` boolean flag into the in-process
 * representation `cdkd local start-api` consumes downstream.
 *
 *   - both unset -> `undefined` (pass dev creds through)
 *   - only `--assume-role-auto` -> `{ perLambda: {}, bareAutoResolve: true }`
 *     (per-Lambda auto-resolve for every routed Lambda)
 *   - only `--assume-role` -> the value-form accumulator (global ARN
 *     and/or per-Lambda map) as-is
 *   - both -> accumulator with `bareAutoResolve = true` overlaid;
 *     the per-Lambda map still wins for named Lambdas, auto-resolve
 *     fills in for every Lambda the map does NOT name
 *
 * Enforces the mutual-exclusion guard: `--assume-role-auto` and a
 * global ARN (`--assume-role <arn>`) both occupy the "default for
 * every other Lambda" slot, so the combination is ambiguous and
 * rejected at boot with a clear error. The per-Lambda map IS
 * compatible with either side.
 */
export function normalizeStartApiAssumeRole(
  raw: AssumeRoleOption | undefined,
  autoResolve: boolean
): AssumeRoleOption | undefined {
  if (raw === undefined) {
    return autoResolve
      ? { perLambda: nullPrototypeRecord<string>(), bareAutoResolve: true }
      : undefined;
  }
  if (autoResolve && raw.globalArn) {
    throw new Error(
      // `globalArn` CLEARED `isIamRoleArn` (issue #2348), which bounds it to
      // printable ASCII of at most 2048 characters, yet `role/[!-~]+` still
      // admits `$`, `(`, a backtick and `"`. So it goes through `quotedArgv`,
      // like the refusals above (go-to-k/cdkd#3950): a JSON render beside
      // `--assume-role` would let a pasted `$( )` run.
      `--assume-role-auto auto-resolves EACH routed Lambda's own execution role, ` +
        `but --assume-role ${quotedArgv(raw.globalArn, ROLE_ARN_MAX_CODE_POINTS)} also names a single global default. ` +
        `These are mutually exclusive on the global slot. Either drop the global ARN ` +
        `to keep --assume-role-auto for every Lambda, or drop --assume-role-auto to keep the global default. ` +
        `Per-Lambda overrides (--assume-role '<LogicalId>'='<arn>') are compatible with either side.`
    );
  }
  if (autoResolve) raw.bareAutoResolve = true;
  return raw;
}

/**
 * Resolve the effective IAM role ARN for a given Lambda. Per-Lambda
 * override wins; otherwise the global default; otherwise `undefined`
 * (no role to assume — pass developer creds through).
 */
export function effectiveAssumeRoleArn(
  logicalId: string,
  opt: AssumeRoleOption | undefined
): string | undefined {
  if (!opt) return undefined;
  // OWN keys only, whatever prototype the map was built with.
  const perLambda = opt.perLambda;
  if (perLambda && Object.hasOwn(perLambda, logicalId)) return perLambda[logicalId];
  return opt.globalArn;
}
