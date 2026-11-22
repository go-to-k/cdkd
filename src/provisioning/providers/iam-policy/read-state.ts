import type { IAMPolicyProvider } from '../iam-policy-provider.js';
import {
  GetRolePolicyCommand,
  GetGroupPolicyCommand,
  GetUserPolicyCommand,
  NoSuchEntityException,
} from '@aws-sdk/client-iam';
import type {
  ReadCurrentStateContext,
  ResourceImportInput,
  ResourceImportResult,
  ResourceNotFound,
} from '../../../types/resource.js';
import { DriftReadRefusedError, RESOURCE_NOT_FOUND } from '../../../types/resource.js';
import { safeMsg } from '../../../utils/display-safe.js';
import { logicalIdShown } from '../../composite-id.js';
import { calculateResourceDrift } from '../../../analyzer/drift-calculator.js';
import { verbatimEchoDriftKeys } from '../../../analyzer/drift-verbatim-paths.js';
import { IAM_POLICY_NAME, readPolicyTargetLists } from './shared.js';
import { markCopiesAgreed } from './agreeing-copies.js';
import { isStoredExpression } from '../../iam-sibling-managed-policies.js';
import {
  type MemberRead,
  declaredMemberDocument,
  memberReadFailure,
  policyDocumentMatchesDeclared,
  settleDeclaredMember,
  warnUnsettledMember,
} from '../../settle-after-own-write.js';

type PolicyTarget = { kind: 'role' | 'group' | 'user'; name: string };

/** How many targets' `Get*Policy` calls run at once on a drift read. */
const TARGET_READ_CONCURRENCY = 5;

/**
 * Read the AWS-current IAM inline policy in CFn-property shape.
 *
 * `AWS::IAM::Policy` is an inline policy attached to one or more roles /
 * groups / users via `PutRolePolicy` / `PutGroupPolicy` / `PutUserPolicy`.
 * Each attachment is a separate API call and a separate copy of the
 * `PolicyDocument`, so each copy can be edited out of band on its own.
 *
 * Strategy: call `Get*Policy(target, policyName)` for EVERY recorded target
 * (`Roles`, then `Groups`, then `Users`) and surface the URL-decoded +
 * JSON-parsed `PolicyDocument` (go-to-k/cdkd#6616: reading only the first
 * target hid an edit, a widened `Action` included, on any other one):
 *   - Every copy agrees (by the drift comparator's own equality): that document.
 *   - The copies differ: the first one the comparator reports against the
 *     drift baseline (`context.driftBaseline`, else the recorded document),
 *     whichever target holds it. When that baseline holds a secret leaf, the
 *     clean copy is unknown and the read is refused
 *     (`DriftReadRefusedError`), which drift reports as not fully compared.
 *   - A target lacks the policy (removed, or the principal deleted): it drops
 *     out of the echoed `Roles` / `Groups` / `Users`, which reports as drift
 *     on that list. Every target lacking it is `RESOURCE_NOT_FOUND`.
 *   - A target ADDED out of band is NOT caught: no API enumerates every
 *     principal holding an inline policy of a given name.
 *
 * The deploy's own post-write capture (`context.afterOwnWrite`) reads the
 * FIRST target only, as before: cdkd has just written the same document to
 * every target, and a deploy pays no call per extra principal. A
 * single-target policy makes exactly the one call it always did. Every other
 * target is echoed from the declared lists, so a lagging one cannot freeze
 * anything into the baseline.
 *
 * IAM can answer that read eventually consistently (go-to-k/cdkd#6609), so a
 * copy that is not the declared document is re-read alone
 * ({@link settleDeclaredMember}, `ownWriteRereadDelaysMs`): settled, it is
 * recorded as read; still absent after the schedule, the DECLARED document is
 * kept and the target stays in its list (the write just succeeded; the single
 * read left the policy with no baseline at all); another document is
 * recorded as read, with one value-free warning. A deterministic failure is
 * not re-read, and a read that never answered throws what the single read
 * threw. Every other read takes the first answer.
 */
export async function readCurrentState(
  this: IAMPolicyProvider,
  physicalId: string,
  logicalId: string,
  _resourceType: string,
  properties?: Record<string, unknown>,
  context?: ReadCurrentStateContext
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  if (!properties) return undefined;

  const policyDocument = properties['PolicyDocument'];
  if (!policyDocument) return undefined;

  // physicalId may be in legacy "policyName:roleName" format
  const policyName = physicalId.includes(':') ? physicalId.split(':')[0]! : physicalId;

  // A malformed recorded list is drift UNKNOWN: reading its first "name"
  // would read ANOTHER principal's same-named policy (go-to-k/cdkd#3878).
  const targets = readPolicyTargetLists(properties);
  if ('malformed' in targets) return undefined;
  const { roles, groups, users } = targets;

  const allTargets: PolicyTarget[] = [
    ...(roles ?? []).map((name) => ({ kind: 'role' as const, name })),
    ...(groups ?? []).map((name) => ({ kind: 'group' as const, name })),
    ...(users ?? []).map((name) => ({ kind: 'user' as const, name })),
  ];
  // No targets in state — cannot resolve; skip.
  if (allTargets.length === 0) return undefined;
  const readTargets = context?.afterOwnWrite === true ? allTargets.slice(0, 1) : allTargets;

  const readOne = async (
    target: PolicyTarget
  ): Promise<
    { target: PolicyTarget; document: unknown } | { target: PolicyTarget; missing: true }
  > => {
    try {
      const raw = await getTargetPolicyDocument.call(this, target, policyName);
      return { target, document: this.decodePolicyDocument(raw) };
    } catch (err) {
      if (err instanceof NoSuchEntityException) return { target, missing: true };
      throw err;
    }
  };
  const declared =
    context?.afterOwnWrite === true ? declaredMemberDocument(policyDocument) : undefined;
  // A few at a time: a policy on many principals must not burst IAM's
  // throttle, which would fail the whole read.
  const reads: Awaited<ReturnType<typeof readOne>>[] = [];
  if (declared !== undefined) {
    // The capture reads one target (above), so this warns at most once.
    const unsettled = (): void =>
      warnUnsettledMember(this.logger, logicalId, 'AWS::IAM::Policy', 'PolicyDocument');
    reads.push(
      ...(await Promise.all(
        readTargets.map((target) =>
          settleTargetCopy.call(this, target, policyName, declared, unsettled)
        )
      ))
    );
  } else {
    for (let i = 0; i < readTargets.length; i += TARGET_READ_CONCURRENCY) {
      reads.push(
        ...(await Promise.all(readTargets.slice(i, i + TARGET_READ_CONCURRENCY).map(readOne)))
      );
    }
  }

  const documents = reads.flatMap((r) => ('document' in r ? [r.document] : []));
  if (documents.length === 0) return RESOURCE_NOT_FOUND;
  const anyMissing = reads.some((r) => 'missing' in r);
  // Every copy empty and none missing: nothing to compare. With a missing
  // target the list drift below still reports; one empty copy among readable
  // ones is a differing copy.
  if (!anyMissing && documents.every((d) => d === undefined)) return undefined;

  // Every "equal" below is the drift COMPARATOR's own verdict
  // (`calculateResourceDrift`, which canonicalizes ARN / id arrays and tag
  // lists, union-walking objects exactly when a baseline is recorded), never a
  // stricter one: a copy this read calls "differing" that the comparator calls
  // equal would be reported, read clean, and hide an edited copy beside it.
  // The baseline is what `compare.ts` compares against: the recorded
  // `observedProperties` when present, else `properties`. A recorded baseline
  // lacking `PolicyDocument` has it compared against nothing, so any copy
  // does; the recorded document then stands in. The document is a
  // verbatim-echo path, union-walked on either baseline (go-to-k/cdkd#6622),
  // so a key one copy alone holds differs here as it drifts there.
  const union = context?.driftBaseline !== undefined;
  const unionWalkPaths = verbatimEchoDriftKeys('AWS::IAM::Policy');
  const comparatorEqual = (a: unknown, b: unknown): boolean =>
    calculateResourceDrift(
      { PolicyDocument: a },
      { PolicyDocument: b },
      { unionWalkObjects: union, unionWalkPaths }
    ).length === 0;
  const baseline =
    context?.driftBaseline?.['PolicyDocument'] !== undefined
      ? context.driftBaseline['PolicyDocument']
      : parseRecordedDocument(policyDocument);

  let liveDocument = documents[0];
  const copiesDiffer = documents.some(
    (d) => !comparatorEqual(liveDocument, d) || !comparatorEqual(d, liveDocument)
  );
  if (copiesDiffer) {
    // A baseline holding a `{{resolve:...}}` or `***` leaf equals no live
    // copy (each holds the value resolved), so the clean copy is unknown and
    // a pick could be the unedited one, reading clean. A THROW, not
    // `undefined`: drift reports a failed read as NOT fully compared (exit 2),
    // while `undefined` reads as unsupported on a green stack line. The
    // message names the policy only, never a document.
    if (holdsSecretLeaf(baseline)) {
      throw new DriftReadRefusedError(
        `the copies of inline policy ${policyName} differ across its principals and its ` +
          `recorded document holds a secret reference, so cdkd cannot tell which copy was ` +
          `edited — inspect each principal's copy by hand`
      );
    }
    // The first copy the comparator reports against the baseline. By index:
    // an empty copy (`undefined`) is a valid pick, which `??` would drop.
    const edited = documents.findIndex((d) => !comparatorEqual(baseline, d));
    if (edited !== -1) liveDocument = documents[edited];
  }

  const result: Record<string, unknown> = {
    PolicyName: policyName,
    PolicyDocument: liveDocument,
  };
  // Echo the recorded targets back (AWS has no API to enumerate the full
  // target set for a named inline policy — see method docstring), less any
  // target that was read and lacks the policy: that absence IS the drift.
  const echo = (kind: PolicyTarget['kind'], names: string[]): string[] => {
    const missing = new Set(
      reads.flatMap((r) => ('missing' in r && r.target.kind === kind ? [r.target.name] : []))
    );
    return names.filter((name) => !missing.has(name));
  };
  if (roles) result['Roles'] = echo('role', roles);
  if (groups) result['Groups'] = echo('group', groups);
  if (users) result['Users'] = echo('user', users);
  // A drift read of EVERY principal whose copies all agree: the only bag the
  // drift heal may skip PolicyDocument on (a lost mark keeps it compared).
  if (!copiesDiffer && readTargets.length === allTargets.length) markCopiesAgreed(result);
  return result;
}

/**
 * One target's copy on the post-write capture, settled on the declared
 * document (`readCurrentState`'s comment has the outcomes). A copy that
 * matches on the first read makes no extra call.
 */
async function settleTargetCopy(
  this: IAMPolicyProvider,
  target: PolicyTarget,
  policyName: string,
  declared: unknown,
  unsettled: () => void
): Promise<{ target: PolicyTarget; document: unknown }> {
  const read = async (): Promise<MemberRead<unknown>> => {
    try {
      return {
        value: this.decodePolicyDocument(
          await getTargetPolicyDocument.call(this, target, policyName)
        ),
      };
    } catch (err) {
      if (err instanceof NoSuchEntityException) return 'absent';
      throw err;
    }
  };
  let first: MemberRead<unknown>;
  let firstError: unknown;
  try {
    first = await read();
  } catch (err) {
    firstError = err;
    first = memberReadFailure(err);
  }
  const settled = await settleDeclaredMember(
    first,
    read,
    (value) => policyDocumentMatchesDeclared(value, declared),
    declared,
    this.ownWriteRereadDelaysMs,
    unsettled
  );
  // No read answered: what the single read always did.
  if (typeof settled !== 'object') throw firstError;
  return { target, document: settled.value };
}

/** One target's raw (URL-encoded) copy of the inline policy document. */
async function getTargetPolicyDocument(
  this: IAMPolicyProvider,
  target: PolicyTarget,
  policyName: string
): Promise<string | undefined> {
  switch (target.kind) {
    case 'role':
      return (
        await this.iamClient.send(
          new GetRolePolicyCommand({ RoleName: target.name, PolicyName: policyName })
        )
      ).PolicyDocument;
    case 'group':
      return (
        await this.iamClient.send(
          new GetGroupPolicyCommand({ GroupName: target.name, PolicyName: policyName })
        )
      ).PolicyDocument;
    case 'user':
      return (
        await this.iamClient.send(
          new GetUserPolicyCommand({ UserName: target.name, PolicyName: policyName })
        )
      ).PolicyDocument;
  }
}

/** Does the value hold a dynamic reference or cdkd's `***` mask in a string leaf? */
function holdsSecretLeaf(value: unknown, depth = 0): boolean {
  if (depth > 64) return true;
  if (typeof value === 'string') return isStoredExpression(value);
  if (Array.isArray(value)) return value.some((v) => holdsSecretLeaf(v, depth + 1));
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).some(
      ([k, v]) => holdsSecretLeaf(k, depth + 1) || holdsSecretLeaf(v, depth + 1)
    );
  }
  return false;
}

/** The recorded document as an object; `update` accepts a JSON string too. */
function parseRecordedDocument(recorded: unknown): unknown {
  if (typeof recorded !== 'string') return recorded;
  try {
    return JSON.parse(recorded) as unknown;
  } catch {
    return recorded;
  }
}

/**
 * IAM Get*Policy returns the policy document as a URL-encoded JSON string
 * (per RFC 3986). Decode and parse it back into the object shape cdkd
 * state holds, so the drift comparator sees apples-to-apples.
 */
export function decodePolicyDocument(this: IAMPolicyProvider, raw: string | undefined): unknown {
  if (!raw) return undefined;
  try {
    return JSON.parse(decodeURIComponent(raw));
  } catch {
    // Defensive: if decoding fails, surface the raw string and let the
    // comparator show the divergence rather than swallowing the error.
    return raw;
  }
}

/**
 * Adopt an existing IAM inline policy into cdkd state.
 *
 * **Explicit override only.** `AWS::IAM::Policy` in CloudFormation is an
 * inline policy attached to roles / groups / users — not a standalone
 * resource. Inline policies are not taggable and have no global identity,
 * so tag-based auto-lookup via `aws:cdk:path` is not feasible. Users
 * adopting inline policies must pass `--resource <logicalId>=<policyName>`
 * (the physical id is the policy name itself).
 *
 * For standalone managed policies (`AWS::IAM::ManagedPolicy`), the
 * Cloud Control API fallback handles import via the same explicit
 * override mode.
 *
 * **A CloudFormation-supplied id is recorded as the `PolicyName` it names**
 * (go-to-k/cdkd#6841), once IAM confirms it. The name is what `create()`
 * records and what every reader (`readCurrentState`, `delete()`) addresses the
 * policy by, while `--migrate-from-cloudformation`, auto mode and a nested
 * child hand this import CloudFormation's `PhysicalResourceId`, which for this
 * type is a generated id (`main--Cover-LxKVLoikcQa9`) naming no IAM object, so
 * the record read as DELETED on the first `cdkd drift`.
 *
 * The `PolicyName` in the properties is not proof of what AWS holds: auto mode
 * and a migrated resource the deployed template could not vouch for hand over
 * the SYNTHESIZED one, which may name no policy yet (renamed in the code) or,
 * worse, ANOTHER inline policy of that name on the same role, which a later
 * `delete()` would then remove. So the name is adopted only when one of the
 * recorded roles / groups / users holds an inline policy of that name
 * (`Get*Policy`); otherwise, including any read failure or an unreadable
 * principal list, the handed id is kept and a value-free warning names the
 * logical id. An id the operator passed with `--resource` is kept as given,
 * and so is any id when `PolicyName` is not a plain IAM policy name (an
 * unresolved intrinsic, a `{{resolve:...}}` reference, whose value must never
 * become a physical id, or a `:` that `delete()` would split as the legacy
 * `policy:role` form).
 */
export async function importImpl(
  this: IAMPolicyProvider,
  input: ResourceImportInput
): Promise<ResourceImportResult | null> {
  if (input.knownPhysicalId) {
    const policyName = input.properties['PolicyName'];
    if (
      input.knownPhysicalIdFromCloudFormation === true &&
      typeof policyName === 'string' &&
      IAM_POLICY_NAME.test(policyName) &&
      policyName !== input.knownPhysicalId
    ) {
      if (await inlinePolicyIsAttached.call(this, policyName, input.properties)) {
        this.logger.debug(
          safeMsg`Import of ${input.logicalId}: recording the template's PolicyName as the physical id ` +
            `(an inline policy is addressed by its name; the id handed to the import is not it)`
        );
        return { physicalId: policyName, attributes: {} };
      }
      this.logger.warn(
        safeMsg`Import of ${logicalIdShown(input.logicalId)}: none of its roles, groups or users holds an ` +
          `inline policy under the template's PolicyName, so the id CloudFormation supplied is recorded ` +
          `as it is; 'cdkd drift' may report it missing until the next 'cdkd deploy' writes the policy.`
      );
    }
    return { physicalId: input.knownPhysicalId, attributes: {} };
  }
  return null;
}

/**
 * Whether one of the principals `properties` lists holds an inline policy
 * named `policyName`. `false` for an unreadable list, no principal, or any read
 * failure: the caller then keeps the id it was handed.
 */
async function inlinePolicyIsAttached(
  this: IAMPolicyProvider,
  policyName: string,
  properties: Record<string, unknown>
): Promise<boolean> {
  const targets = readPolicyTargetLists(properties);
  if ('malformed' in targets) return false;
  const all: PolicyTarget[] = [
    ...(targets.roles ?? []).map((name) => ({ kind: 'role' as const, name })),
    ...(targets.groups ?? []).map((name) => ({ kind: 'group' as const, name })),
    ...(targets.users ?? []).map((name) => ({ kind: 'user' as const, name })),
  ];
  for (const target of all) {
    try {
      await getTargetPolicyDocument.call(this, target, policyName);
      return true;
    } catch (err) {
      if (err instanceof NoSuchEntityException) continue;
      this.logger.debug(
        safeMsg`Inline policy lookup on a ${target.kind} failed (${err instanceof Error ? err.name : typeof err}).`
      );
      return false;
    }
  }
  return false;
}
