import { getLogger } from '../../../utils/logger.js';
import { displayIdent, ROLE_ARN_MAX_CODE_POINTS, safeMsg } from '../../../utils/display-safe.js';
import { quotedOrDescribed, shellBoundedDisplay } from '../../../utils/pasteable-command.js';
import { isIamRoleArn } from '../../../utils/role-arn.js';
import type { StackState } from '../../../types/state.js';

/**
 * When `--from-state` is set but `--assume-role` was NOT passed (not even
 * bare), log the function's deployed execution role ARN once as a hint.
 * This is the pre-(#442) behavior — kept for backward compatibility with
 * users who don't want auto-assume. The bare-`--assume-role` path opts
 * in to actually assuming the resolved ARN; this hint path stays
 * informational only.
 */
function suggestAssumeRoleFromState(state: StackState, logicalId: string): void {
  const logger = getLogger();
  const roleArn = resolveExecutionRoleArnFromState(state, logicalId);
  if (roleArn) {
    logger.info(
      `Hint: the deployed function uses execution role ${displayIdent(roleArn, { maxCodePoints: ROLE_ARN_MAX_CODE_POINTS })}. ` +
        `Re-run with --assume-role to invoke under the deployed function's narrow permissions.`
    );
  }
}

/**
 * Emit the "re-run with `--assume-role`" hint, if it applies.
 *
 * This is the ONE place where `--no-assume-role` (`false`) behaves differently
 * from omitting the flag (`undefined`), and therefore the whole behavioural
 * payoff of registering the negation
 * ([#2523](https://github.com/go-to-k/cdkd/issues/2523)): both forward the
 * caller's ambient credentials, but only the absent flag prints the hint.
 * Everywhere else the two collapse onto the same credential path.
 *
 * The DECISION and the EMISSION are deliberately in the same function, and
 * that shape was bought by a review probe. An earlier cut exported only the
 * predicate and left the `logger` call at the call site; the probe replaced
 * the handler's condition with the pre-fix `stateForRoleHint &&
 * options.fromState` — reintroducing the defect in full — and all 3217 tests
 * stayed green, because nothing pinned that the handler still consulted the
 * predicate. Split like that, the extraction moves the untested part rather
 * than removing it. Together, the only way to reintroduce the defect is to
 * edit this function, which the cases in
 * `tests/unit/cli/local-assume-role-negation.test.ts` read directly.
 *
 * `state` is `undefined` when no state source was loaded, which is its own
 * reason not to hint: there is no deployed role ARN to name.
 *
 * Returns whether it hinted, so a caller (and a test) can assert the decision
 * without having to scrape the log.
 */
export function maybeSuggestAssumeRole(
  options: { assumeRole?: string | boolean | undefined; fromState: boolean },
  state: StackState | undefined,
  logicalId: string
): boolean {
  if (options.assumeRole !== undefined) return false;
  if (!options.fromState || !state) return false;
  suggestAssumeRoleFromState(state, logicalId);
  return true;
}

/**
 * Resolve the execution-role ARN for a Lambda from cdkd state. Used by
 * both the `--assume-role` auto-resolve path and the legacy hint path.
 *
 * Resolution rules (mirrors the v1 scope spelled out in (#442)):
 *
 *   - Literal-string `Role` that `isIamRoleArn` accepts → returned verbatim.
 *   - `{ Fn::GetAtt: [<RoleId>, 'Arn'] }` or `{ Ref: <RoleId> }` → looked up
 *     against the sibling IAM Role resource's `attributes.Arn` (recorded
 *     at deploy time by `IAMRoleProvider.create` / drift refresh).
 *   - Any other shape (`Fn::Sub` / `Fn::Join` / cross-stack imports) → not
 *     resolved in v1; the caller surfaces a warn and falls back to dev
 *     creds. Once real CDK apps emit those shapes for `Role` we can
 *     extend the resolver per `feedback_verify_cdk_synth_shape_before_resolver.md`.
 *
 * Returns `undefined` when state has no entry for the Lambda, the `Role`
 * is missing entirely, the referenced sibling has no `Arn` attribute
 * captured, or the shape is one we don't try to resolve.
 *
 * Every string it returns has passed `isIamRoleArn` (issue
 * [#2348](https://github.com/go-to-k/cdkd/issues/2348)): a state record is
 * read from S3 or CloudFormation, and this used to accept anything beginning
 * `arn:` — a value that is then both printed and SENT to STS. A string it
 * refuses is warned about (so a broken record is visible) and ignored.
 *
 * Exported for unit testing.
 */
export function resolveExecutionRoleArnFromState(
  state: Pick<StackState, 'resources'>,
  logicalId: string,
  roleProperty = 'Role'
): string | undefined {
  const found = classifyExecutionRoleArnFromState(state, logicalId, roleProperty);
  if (found.kind === 'ok') return found.arn;
  if (found.kind === 'malformed') getLogger().warn(`${found.description}. Ignoring it.`);
  return undefined;
}

/**
 * Bare `--assume-role` with cdkd state loaded: resolve the function's execution
 * role from state and say which way it went -- the ARN on success, or a warn
 * and `undefined` (the caller falls back to the developer's shell
 * credentials). Split out of the handler so the lines it emits are testable
 * without synthesis or docker; the logical id is template-supplied text, so it
 * is quoted only when it is a plain identifier and described otherwise: a `'`
 * in it would close the quote, and a JSON-quoted `$( )` still runs in the
 * sentence that names `cdkd state` (issues #2348, go-to-k/cdkd#3950).
 */
export function resolveBareAssumeRoleFromState(
  state: Pick<StackState, 'resources'>,
  logicalId: string
): string | undefined {
  const logger = getLogger();
  const arn = resolveExecutionRoleArnFromState(state, logicalId);
  if (arn) {
    logger.info(
      safeMsg`--assume-role: auto-resolved execution role from cdkd state: ${shellBoundedDisplay(displayIdent(arn, { maxCodePoints: ROLE_ARN_MAX_CODE_POINTS }))}`
    );
    return arn;
  }
  logger.warn(
    safeMsg`--assume-role: could not resolve the execution role ARN from cdkd state for ${quotedOrDescribed(logicalId, 'logical id')}. ` +
      "Pass the ARN explicitly: --assume-role '<arn>'. Falling back to the developer's shell credentials."
  );
  return undefined;
}

/**
 * What {@link resolveExecutionRoleArnFromState} found, WITHOUT deciding what a
 * malformed value means (issue #2348). That function warns and treats it as a
 * miss, which is what `local invoke` and the hint path have always ended up
 * doing (an unusable ARN failed at STS and fell back). `local start-api
 * --assume-role-auto` refuses at startup instead, because there a failed
 * assume was never a fallback: an ARN that EXISTS but is malformed is not the
 * same as no ARN.
 *
 * Only a value that LOOKS like it was meant as an ARN (`arn:` prefix) is
 * `malformed`; any other string was never a candidate under the old
 * `startsWith` rule and stays a `miss`.
 */
export type ExecutionRoleArnLookup =
  | { kind: 'ok'; arn: string }
  | { kind: 'malformed'; description: string }
  | { kind: 'miss' };

export function classifyExecutionRoleArnFromState(
  state: Pick<StackState, 'resources'>,
  logicalId: string,
  roleProperty = 'Role'
): ExecutionRoleArnLookup {
  const lambda = state.resources[logicalId];
  if (!lambda) return { kind: 'miss' };

  const roleRef = lambda.properties?.[roleProperty] ?? lambda.observedProperties?.[roleProperty];
  if (typeof roleRef === 'string') {
    if (isIamRoleArn(roleRef)) return { kind: 'ok', arn: roleRef };
    if (roleRef.startsWith('arn:')) {
      return {
        kind: 'malformed',
        description:
          // The logical id through `quotedOrDescribed`, never inside a
          // hand-written `'...'` its own `'` would close, and the ARN through
          // `shellBoundedDisplay`, since the sentences these descriptions land
          // in name `--assume-role` (go-to-k/cdkd#3950).
          `Deployed state for ${quotedOrDescribed(logicalId, 'logical id')} carries a ${displayIdent(roleProperty)} that is not ` +
          `a well-formed IAM role ARN: ${shellBoundedDisplay(displayIdent(roleRef, { maxCodePoints: ROLE_ARN_MAX_CODE_POINTS }))}`,
      };
    }
    return { kind: 'miss' };
  }
  if (typeof roleRef === 'object' && roleRef !== null) {
    const refLogicalId = pickReferencedLogicalId(roleRef as Record<string, unknown>);
    if (refLogicalId) {
      const roleResource = state.resources[refLogicalId];
      const cached = roleResource?.attributes?.['Arn'];
      if (typeof cached === 'string' && isIamRoleArn(cached)) return { kind: 'ok', arn: cached };
      if (typeof cached === 'string' && cached.startsWith('arn:')) {
        return {
          kind: 'malformed',
          description:
            `The cached Arn attribute of ${quotedOrDescribed(refLogicalId, 'logical id')} is not a well-formed IAM role ARN: ` +
            `${shellBoundedDisplay(displayIdent(cached, { maxCodePoints: ROLE_ARN_MAX_CODE_POINTS }))}`,
        };
      }
    }
  }
  return { kind: 'miss' };
}

/**
 * Walk a single-key intrinsic and return the referenced logical ID, or
 * `undefined` for shapes we don't try to resolve in v1 (multi-key
 * intrinsics, nested intrinsics, etc.). Mirrors the narrow handling used
 * by `state-resolver.ts`.
 */
function pickReferencedLogicalId(intrinsic: Record<string, unknown>): string | undefined {
  if ('Ref' in intrinsic && typeof intrinsic['Ref'] === 'string') return intrinsic['Ref'];
  if ('Fn::GetAtt' in intrinsic) {
    const arg = intrinsic['Fn::GetAtt'];
    if (Array.isArray(arg) && typeof arg[0] === 'string') return arg[0];
    if (typeof arg === 'string') return arg.split('.')[0];
  }
  return undefined;
}
