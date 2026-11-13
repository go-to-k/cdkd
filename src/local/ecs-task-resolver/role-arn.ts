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
 * The logical id of the same-stack `AWS::IAM::Role` a role-ARN value points
 * at (`Ref` or `Fn::GetAtt [<LogicalId>, 'Arn']`), or `undefined` when the
 * value is any other shape or names no `AWS::IAM::Role` in `resources`.
 */
export function sameStackRoleLogicalId(
  value: unknown,
  resources: Record<string, TemplateResource>
): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const obj = value as Record<string, unknown>;
  let refLogicalId: string | undefined;
  if ('Ref' in obj && typeof obj['Ref'] === 'string') {
    refLogicalId = obj['Ref'];
  } else if ('Fn::GetAtt' in obj) {
    const arg = obj['Fn::GetAtt'];
    if (Array.isArray(arg) && typeof arg[0] === 'string') {
      // Accept `[<LogicalId>, 'Arn']`; other attribute names (rare on IAM
      // Role refs) fall through to undefined since the ARN we emit is always
      // the role ARN shape.
      const attr = typeof arg[1] === 'string' ? arg[1] : '';
      if (attr === '' || attr === 'Arn') refLogicalId = arg[0];
    }
  }
  if (refLogicalId === undefined) return undefined;
  return resources[refLogicalId]?.Type === 'AWS::IAM::Role' ? refLogicalId : undefined;
}

/**
 * The deployed ARN of a same-stack role, read from the state source's record
 * of it (go-to-k/cdkd#6189). A role CDK creates without `roleName` is
 * deployed as `<Stack>-<LogicalId>-<suffix>`, so only the record knows it.
 *
 *   - `--from-state` records the role's `Arn` attribute: returned verbatim.
 *   - `--from-cfn-stack` records only the physical id, which for an
 *     `AWS::IAM::Role` is the role NAME: the ARN is built from it plus the
 *     template's literal `Path`, with the account left as the placeholder the
 *     CLI fills in (the stack's account is not in the record).
 *
 * `undefined` when there is no record or it carries neither.
 */
function roleArnFromStateRecord(
  logicalId: string,
  role: TemplateResource,
  subContext: SubstitutionContext | undefined
): string | undefined {
  const record = subContext?.resources[logicalId];
  if (!record) return undefined;
  const arn = record.attributes?.['Arn'];
  if (typeof arn === 'string' && arn.length > 0) return arn;
  const name = record.physicalId;
  if (typeof name !== 'string' || name.length === 0) return undefined;
  // IAM paths start and end with `/`; anything else (an intrinsic, a
  // malformed literal) is read as the default `/`.
  const rawPath = role.Properties?.['Path'];
  const path = typeof rawPath === 'string' && /^\/(?:.*\/)?$/.test(rawPath) ? rawPath : '/';
  return `arn:aws:iam::${TASK_ROLE_ACCOUNT_PLACEHOLDER}:role${path}${name}`;
}

/**
 * Resolve a Task / Execution role ARN reference. Accepts:
 *
 *   - A flat string ARN — returned verbatim.
 *   - `Ref` / `Fn::GetAtt[..., 'Arn']` against an `AWS::IAM::Role` in
 *     the same stack — with a state source whose record holds the role, its
 *     DEPLOYED ARN (go-to-k/cdkd#6189, see `roleArnFromStateRecord`);
 *     otherwise a synth-time placeholder ARN of the shape
 *     `arn:aws:iam::${AWS::AccountId}:role/<RoleLogicalId>`, which names the
 *     deployed role only when its name IS the logical id (the CLI warns about
 *     that on the bare `--assume-task-role` path). Either way the CLI fills
 *     the account segment in lazily via STS when the bare
 *     `--assume-task-role` form is used.
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

  if ('Ref' in obj || 'Fn::GetAtt' in obj) {
    const logicalId = sameStackRoleLogicalId(value, resources);
    if (logicalId === undefined) return undefined;
    const fromState = roleArnFromStateRecord(logicalId, resources[logicalId]!, subContext);
    if (fromState !== undefined) return fromState;
    return `arn:aws:iam::${TASK_ROLE_ACCOUNT_PLACEHOLDER}:role/${logicalId}`;
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
