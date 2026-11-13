import { effectiveAssumeRoleArn, type AssumeRoleOption } from '../../options.js';
import { getLogger } from '../../../utils/logger.js';
import { isIamRoleArn } from '../../../utils/role-arn.js';
import type { TemplateResource } from '../../../types/resource.js';
import { classifyExecutionRoleArnFromState } from '../local-invoke.js';
import { mixedModeEmulatorRoleWarning } from '../local-invoke/execution-role.js';
import { stateRoleRecordIsEmulatorSide } from '../../../local/local-aws-wiring.js';
import { displayIdent, ROLE_ARN_MAX_CODE_POINTS } from '../../../utils/display-safe.js';
import { isPasteableIdent } from '../state-file-keys.js';
import {
  plainOrDescribed,
  quotedOrDescribed,
  shellBoundedDisplay,
} from '../../../utils/pasteable-command.js';
import type { LocalStartApiOptions } from './types.js';
import type { StackStateBundle } from './state.js';

/**
 * Resolve the effective IAM role ARN to assume for a single routed
 * Lambda, honoring the four `--assume-role` forms of issue #256
 * Option 1 (non-breaking step):
 *
 *   - per-Lambda override (`<LogicalId>=<arn>`) — wins over every other
 *     form for the named Lambda.
 *   - global default (bare ARN) — used when the per-Lambda map misses.
 *   - bare-auto-resolve (`--assume-role-auto`) — when neither the
 *     per-Lambda map nor a global default applies, resolves THIS
 *     Lambda's own `Role` (its `AWS::Lambda::Function`'s `Role`
 *     property -> role ARN). Resolution sources, in order:
 *       1. literal-ARN form of `Properties.Role` in the SYNTHESIZED
 *          template (rare in CDK output but possible);
 *       2. deployed state (`stateBundle.state.resources`) when
 *          `--from-state` / `--from-cfn-stack` is active, via the same
 *          shared helper `cdkd local invoke`'s bare-form uses
 *          (`resolveExecutionRoleArnFromState`).
 *   - flag absent — returns `undefined` (per-Lambda map and global
 *     default already filtered out by the null-check at the top;
 *     bare-auto-resolve = false short-circuits before the state lookup).
 *     There is no `--no-assume-role-auto`: `--assume-role-auto` is a plain
 *     boolean defaulting to `false`, so omitting it IS the off state, and an
 *     earlier revision of this list named a negation commander never
 *     registered (the issue-#2523 shape, one file over).
 *
 * The shape-level mutual exclusion (bare-auto-resolve + global ARN
 * together) is caught at boot by `normalizeStartApiAssumeRole`; this
 * resolver only sees a well-formed `AssumeRoleOption`.
 *
 * Bare-auto-resolve misses (no literal-ARN, no state, state did not
 * carry the role attribute) warn-and-fall-through to the
 * dev-creds-passed-through branch — same trade-off `cdkd local invoke
 * --assume-role` makes when bare auto-resolve cannot find an ARN.
 *
 * Exported for unit testing.
 */
export function resolveStartApiAssumeRoleArn(args: {
  logicalId: string;
  assumeRole: AssumeRoleOption | undefined;
  lambdaResource: TemplateResource;
  stateBundle: StackStateBundle | undefined;
}): string | undefined {
  const { logicalId, assumeRole, lambdaResource, stateBundle } = args;
  if (!assumeRole) return undefined;

  // Per-Lambda override > global default > bare-auto-resolve.
  // `effectiveAssumeRoleArn` already handles the first two.
  const explicit = effectiveAssumeRoleArn(logicalId, assumeRole);
  if (explicit) return explicit;

  if (!assumeRole.bareAutoResolve) return undefined;

  // Bare-auto-resolve: try the synthesized template's literal-ARN
  // `Properties.Role` first (most CDK apps render this as an intrinsic,
  // but explicit-ARN refs DO surface here), then the deployed state.
  //
  // `isIamRoleArn`, not `startsWith('arn:')` (issue #2348): the template and
  // the state record are both off-process text and the value is SENT to STS.
  // A value that EXISTS but is malformed is REFUSED at startup, never read as a
  // miss: a failed assume here has always been a hard error (there is no
  // fallback around `assumeLambdaExecutionRole` below), and quietly handing the
  // container the developer's shell credentials instead would widen what the
  // user asked to narrow. Only a true miss falls through to the warn below.
  const roleProp = (lambdaResource.Properties ?? {})['Role'];
  if (typeof roleProp === 'string' && isIamRoleArn(roleProp)) {
    return roleProp;
  }
  if (typeof roleProp === 'string' && roleProp.startsWith('arn:')) {
    throw malformedAutoRoleError(
      logicalId,
      `the template Role for ${quotedOrDescribed(logicalId, 'logical id')} is not a well-formed IAM role ARN: ` +
        shellBoundedDisplay(displayIdent(roleProp, { maxCodePoints: ROLE_ARN_MAX_CODE_POINTS }))
    );
  }
  // Mixed mode: the record's roles are the emulator's, and the role is
  // assumed in real AWS (go-to-k/cdkd#6252).
  if (stateBundle && stateRoleRecordIsEmulatorSide()) {
    getLogger().warn(mixedModeEmulatorRoleWarning(assumeRolePin(logicalId)));
    return undefined;
  }
  if (stateBundle) {
    const fromState = classifyExecutionRoleArnFromState(stateBundle.state, logicalId);
    if (fromState.kind === 'malformed') {
      throw malformedAutoRoleError(logicalId, fromState.description);
    }
    if (fromState.kind === 'ok') {
      getLogger().info(
        `--assume-role: auto-resolved execution role for ${quotedOrDescribed(logicalId, 'logical id')} from state: ${shellBoundedDisplay(displayIdent(fromState.arn, { maxCodePoints: ROLE_ARN_MAX_CODE_POINTS }))}`
      );
      return fromState.arn;
    }
  }

  // Miss: warn-and-fall-through so the user sees why the container is
  // getting dev creds instead of the deployed function's narrow role.
  // The same shape `cdkd local invoke --assume-role` produces when state /
  // template ARN can't recover the role.
  getLogger().warn(
    `--assume-role: could not auto-resolve the execution role ARN for ${quotedOrDescribed(logicalId, 'logical id')}. ` +
      `Pair --assume-role-auto with --from-state or --from-cfn-stack ` +
      `so the deployed Role's ARN can be looked up, OR pin the ARN explicitly with ` +
      `${assumeRolePin(logicalId)}. ` +
      "Falling back to the developer's shell credentials for this Lambda."
  );
  return undefined;
}

/**
 * The `--assume-role <logicalId>=<arn>` example the two messages above end on.
 *
 * The logical id is template-supplied, so it is NAMED only when
 * `isPasteableIdent` admits it (go-to-k/cdkd#3950). A `displayIdent` render
 * would JSON-quote a non-plain one, and `$( )` or a backtick still runs inside
 * double quotes when the example is pasted. A `<logicalId>` hole is not the
 * answer either: pasted, its `<` reads a file of that name and the `>=` after
 * it then truncates a file called `=`. So the example is dropped and the flag
 * named alone.
 */
function assumeRolePin(logicalId: string): string {
  // `plainOrDescribed` is the value itself on this arm, spelled through the
  // helper so the render names its own gate.
  return isPasteableIdent(logicalId)
    ? `--assume-role ${plainOrDescribed(logicalId, 'logical id')}='<arn>'`
    : "--assume-role, naming this Lambda's logical id";
}

/**
 * The startup refusal for a malformed auto-resolved role ARN (issue #2348).
 * `detail` is already sanitized by its builder.
 */
function malformedAutoRoleError(logicalId: string, detail: string): Error {
  return new Error(
    // cdkd-raw-beside-safe: `detail` is built by this function's two callers
    // entirely from `displayIdent` / `quotedOrDescribed` renders and fixed
    // prose (the template arm here, `classifyExecutionRoleArnFromState`'s
    // `description`), so it is already-sanitized text rather than a raw value.
    `--assume-role-auto: ${detail}. Refusing to start rather than fall back to your shell ` +
      `credentials for this Lambda. Fix the deployed role ARN, or pin one explicitly with ` +
      `${assumeRolePin(logicalId)}.`
  );
}

/**
 * The `{{resolve:...}}` inputs the server boot hands {@link buildContainerSpec}
 * from the command's options (issue #2056): the `--profile` a lookup is made
 * with, and `--stack-region` ahead of the synth region.
 */
export function dynamicReferenceSpecOptions(
  options: Pick<LocalStartApiOptions, 'profile' | 'stackRegion'>
): { profile?: string; stackRegionOverride?: string } {
  return {
    ...(options.profile !== undefined && { profile: options.profile }),
    ...(options.stackRegion !== undefined && { stackRegionOverride: options.stackRegion }),
  };
}
