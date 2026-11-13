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
 * The partition segment's placeholder in the same ARN (go-to-k/cdkd#6189): the
 * CLI fills it in from the same `GetCallerIdentity` answer, whose ARN carries
 * the partition, so an `aws-cn` / `aws-us-gov` role is not named `arn:aws:`.
 */
export const TASK_ROLE_PARTITION_PLACEHOLDER = '${AWS::Partition}';

/** `arn:${partition}:iam::${account}:role<path><name>`, both placeholders unfilled. */
function placeholderRoleArn(pathAndName: string): string {
  return `arn:${TASK_ROLE_PARTITION_PLACEHOLDER}:iam::${TASK_ROLE_ACCOUNT_PLACEHOLDER}:role${pathAndName}`;
}

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
 * Why a same-stack role's ARN is the placeholder built from its LOGICAL id
 * rather than its deployed name (go-to-k/cdkd#6189):
 *
 * - `no-state` — no state record was supplied for the lookup.
 * - `no-record` — the record has no entry for the role (or one carrying
 *   neither an `Arn` nor a physical id).
 * - `path-not-literal` — the record holds only the role's name
 *   (`--from-cfn-stack`) and the template's `Path` is not a literal IAM path,
 *   so the ARN cannot be built from it.
 */
export type TaskRoleUnresolvedReason = 'no-state' | 'no-record' | 'path-not-literal';

/** A resolved role ARN plus, for the logical-id placeholder, why it was used. */
export interface RoleArnResolution {
  arn?: string;
  unresolved?: { logicalId: string; reason: TaskRoleUnresolvedReason };
}

/**
 * The deployed ARN of a same-stack role, read from the state source's record
 * of it (go-to-k/cdkd#6189). A role CDK creates without `roleName` is
 * deployed as `<Stack>-<LogicalId>-<suffix>`, so only the record knows it.
 *
 *   - `--from-state` records the role's `Arn` attribute: returned verbatim.
 *   - `--from-cfn-stack` records only the physical id, which for an
 *     `AWS::IAM::Role` is the role NAME: the ARN is built from it plus the
 *     template's `Path` (absent means `/`; anything but a literal IAM path is
 *     refused, as the ARN would name another role), with the partition and
 *     account left as the placeholders the CLI fills in.
 */
function roleArnFromStateRecord(
  logicalId: string,
  role: TemplateResource,
  subContext: SubstitutionContext | undefined
): { arn: string } | { reason: TaskRoleUnresolvedReason } {
  if (!subContext) return { reason: 'no-state' };
  const record = subContext.resources[logicalId];
  if (!record) return { reason: 'no-record' };
  const arn = record.attributes?.['Arn'];
  if (typeof arn === 'string' && arn.length > 0) return { arn };
  const name = record.physicalId;
  if (typeof name !== 'string' || name.length === 0) return { reason: 'no-record' };
  const rawPath = role.Properties?.['Path'];
  if (rawPath === undefined) return { arn: placeholderRoleArn(`/${name}`) };
  // IAM paths start and end with `/`.
  if (typeof rawPath !== 'string' || !/^\/(?:.*\/)?$/.test(rawPath)) {
    return { reason: 'path-not-literal' };
  }
  return { arn: placeholderRoleArn(`${rawPath}${name}`) };
}

/**
 * Resolve a Task / Execution role ARN reference. Accepts:
 *
 *   - A flat string ARN — returned verbatim.
 *   - `Ref` / `Fn::GetAtt[..., 'Arn']` against an `AWS::IAM::Role` in
 *     the same stack — with a state source whose record holds the role, its
 *     DEPLOYED ARN (go-to-k/cdkd#6189, see `roleArnFromStateRecord`);
 *     otherwise a synth-time placeholder ARN of the shape
 *     `arn:${AWS::Partition}:iam::${AWS::AccountId}:role/<RoleLogicalId>`,
 *     which names the deployed role only when its name IS the logical id
 *     (`unresolved` says why it was used; the CLI warns on
 *     the bare `--assume-task-role` path). The CLI fills the placeholders in
 *     lazily via STS when the bare `--assume-task-role` form is used.
 *   - `Fn::Join` / `Fn::Sub` — when the supplied substitution context
 *     can resolve every nested intrinsic to a literal (state + pseudo
 *     parameters via `--from-state` flow), the resulting flat ARN is
 *     returned. This covers the rare `iam.Role.fromRoleArn(scope, id,
 *     cdk.Fn.join(...))` pattern verified via real `cdk synth` on
 *     2026-05-12 against `iam.Role.fromRoleArn(stack, 'X', Fn.join(':',
 *     ['arn','aws','iam','',cdk.Aws.ACCOUNT_ID,'role/Name']))`.
 *     Closes Gap 5 of #286.
 *
 * The `arn` is `undefined` when the reference cannot be resolved (logical id
 * missing, non-IAM-Role target, unsupported intrinsic shape, or
 * intrinsic shape whose nested refs cannot be resolved without
 * `--from-state`).
 */
export function resolveRoleArn(
  value: unknown,
  resources: Record<string, TemplateResource>,
  subContext?: SubstitutionContext
): RoleArnResolution {
  if (value === undefined || value === null) return {};
  if (typeof value === 'string') return { arn: value };
  if (typeof value !== 'object') return {};
  const obj = value as Record<string, unknown>;

  if ('Ref' in obj || 'Fn::GetAtt' in obj) {
    const logicalId = sameStackRoleLogicalId(value, resources);
    if (logicalId === undefined) return {};
    const fromState = roleArnFromStateRecord(logicalId, resources[logicalId]!, subContext);
    if ('arn' in fromState) return { arn: fromState.arn };
    return {
      arn: placeholderRoleArn(`/${logicalId}`),
      unresolved: { logicalId, reason: fromState.reason },
    };
  }

  // `Fn::Join` / `Fn::Sub` — `iam.Role.fromRoleArn(stack, id,
  // cdk.Fn.join(...))` shape. Resolve via state + pseudo parameters if
  // available; fall back to undefined (silent-drop, pre-PR behavior)
  // when the context can't fully resolve the intrinsic — same posture
  // as the existing Ref-to-missing-resource path.
  if ('Fn::Join' in obj || 'Fn::Sub' in obj) {
    if (!subContext) return {};
    const sub = substituteAgainstState(value, subContext);
    if (sub.kind === 'literal' && typeof sub.value === 'string' && sub.value.length > 0) {
      return { arn: sub.value };
    }
    return {};
  }

  return {};
}
