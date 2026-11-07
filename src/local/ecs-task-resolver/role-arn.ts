import type { TemplateResource } from '../../types/resource.js';
import { substituteAgainstState, type SubstitutionContext } from '../state-resolver.js';

/**
 * Synth-time placeholder marker used in the account-id segment of an ARN
 * when the role's account cannot be known statically (the role is defined
 * inline as an `AWS::IAM::Role` in the same stack). The CLI replaces this
 * with the live account via STS `GetCallerIdentity` lazily — only when
 * `--assume-task-role` is used in its bare form and the resolved ARN
 * still contains this marker.
 */
export const TASK_ROLE_ACCOUNT_PLACEHOLDER = '${AWS::AccountId}';

/**
 * Resolve a Task / Execution role ARN reference. Accepts:
 *
 *   - A flat string ARN — returned verbatim.
 *   - `Ref` / `Fn::GetAtt[..., 'Arn']` against an `AWS::IAM::Role` in
 *     the same stack — returns a synth-time placeholder ARN of the shape
 *     `arn:aws:iam::${AWS::AccountId}:role/<RoleLogicalId>` (the CLI
 *     fills the account segment in lazily via STS when the bare
 *     `--assume-task-role` form is used).
 *   - `Fn::Join` / `Fn::Sub` — when the supplied substitution context
 *     can resolve every nested intrinsic to a literal (state + pseudo
 *     parameters via `--from-state` flow), the resulting flat ARN is
 *     returned. This covers the rare `iam.Role.fromRoleArn(scope, id,
 *     cdk.Fn.join(...))` pattern verified via real `cdk synth` on
 *     2026-05-12 against `iam.Role.fromRoleArn(stack, 'X', Fn.join(':',
 *     ['arn','aws','iam','',cdk.Aws.ACCOUNT_ID,'role/Name']))`.
 *     Closes Gap 5 of #286.
 *
 * Returns `undefined` when the reference cannot be resolved (logical id
 * missing, non-IAM-Role target, unsupported intrinsic shape, or
 * intrinsic shape whose nested refs cannot be resolved without
 * `--from-state`).
 */
export function resolveRoleArn(
  value: unknown,
  resources: Record<string, TemplateResource>,
  subContext?: SubstitutionContext
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value;
  if (typeof value !== 'object') return undefined;
  const obj = value as Record<string, unknown>;

  let refLogicalId: string | undefined;
  if ('Ref' in obj && typeof obj['Ref'] === 'string') {
    refLogicalId = obj['Ref'];
  } else if ('Fn::GetAtt' in obj) {
    const arg = obj['Fn::GetAtt'];
    if (Array.isArray(arg) && typeof arg[0] === 'string') {
      // Accept `[<LogicalId>, 'Arn']`; other attribute names (rare on IAM
      // Role refs) fall through to undefined since the placeholder we emit
      // is always the role ARN shape.
      const attr = typeof arg[1] === 'string' ? arg[1] : '';
      if (attr === '' || attr === 'Arn') refLogicalId = arg[0];
    }
  }
  if (refLogicalId !== undefined) {
    const role = resources[refLogicalId];
    if (role?.Type !== 'AWS::IAM::Role') return undefined;
    return `arn:aws:iam::${TASK_ROLE_ACCOUNT_PLACEHOLDER}:role/${refLogicalId}`;
  }

  // `Fn::Join` / `Fn::Sub` — `iam.Role.fromRoleArn(stack, id,
  // cdk.Fn.join(...))` shape. Resolve via state + pseudo parameters if
  // available; fall back to undefined (silent-drop, pre-PR behavior)
  // when the context can't fully resolve the intrinsic — same posture
  // as the existing Ref-to-missing-resource path.
  if ('Fn::Join' in obj || 'Fn::Sub' in obj) {
    if (!subContext) return undefined;
    const sub = substituteAgainstState(value, subContext);
    if (sub.kind === 'literal' && typeof sub.value === 'string' && sub.value.length > 0) {
      return sub.value;
    }
    return undefined;
  }

  return undefined;
}
