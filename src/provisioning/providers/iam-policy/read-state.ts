import { isDeepStrictEqual } from 'node:util';
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
import { RESOURCE_NOT_FOUND } from '../../../types/resource.js';
import { readPolicyTargetLists } from './shared.js';

type PolicyTarget = { kind: 'role' | 'group' | 'user'; name: string };

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
 *   - Every copy agrees: that document.
 *   - The copies differ: one that differs from the recorded document, so the
 *     comparator reports the edit whichever target holds it.
 *   - A target lacks the policy (removed, or the principal deleted): it drops
 *     out of the echoed `Roles` / `Groups` / `Users`, which reports as drift
 *     on that list. Every target lacking it is `RESOURCE_NOT_FOUND`.
 *   - A target ADDED out of band is NOT caught: no API enumerates every
 *     principal holding an inline policy of a given name.
 *
 * The deploy's own post-write capture (`context.afterOwnWrite`) reads the
 * FIRST target only, as before: cdkd has just written the same document to
 * every target, and a deploy pays no call per extra principal. A
 * single-target policy makes exactly the one call it always did.
 */
export async function readCurrentState(
  this: IAMPolicyProvider,
  physicalId: string,
  _logicalId: string,
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

  const reads = await Promise.all(
    readTargets.map(async (target) => {
      try {
        const raw = await getTargetPolicyDocument.call(this, target, policyName);
        return { target, document: this.decodePolicyDocument(raw) };
      } catch (err) {
        if (err instanceof NoSuchEntityException) return { target, missing: true as const };
        throw err;
      }
    })
  );

  const present = reads.filter((r): r is { target: PolicyTarget; document: unknown } => 'document' in r);
  if (present.length === 0) return RESOURCE_NOT_FOUND;
  const documents = present.map((r) => r.document);
  if (documents.some((d) => d === undefined)) return undefined;

  let liveDocument = documents[0];
  if (documents.some((d) => !isDeepStrictEqual(d, liveDocument))) {
    // At most one of the differing copies can equal the recorded document,
    // so this always finds an edited one.
    const recorded = parseRecordedDocument(policyDocument);
    liveDocument = documents.find((d) => !isDeepStrictEqual(d, recorded)) ?? liveDocument;
  }

  const result: Record<string, unknown> = {
    PolicyName: policyName,
    PolicyDocument: liveDocument,
  };
  // Echo the recorded targets back (AWS has no API to enumerate the full
  // target set for a named inline policy — see method docstring), less any
  // target that was read and lacks the policy: that absence IS the drift.
  const missing = new Set(
    reads.filter((r) => 'missing' in r).map((r) => `${r.target.kind}\0${r.target.name}`)
  );
  const echo = (kind: PolicyTarget['kind'], names: string[]): string[] =>
    names.filter((name) => !missing.has(`${kind}\0${name}`));
  if (roles) result['Roles'] = echo('role', roles);
  if (groups) result['Groups'] = echo('group', groups);
  if (users) result['Users'] = echo('user', users);
  return result;
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
 */
// eslint-disable-next-line @typescript-eslint/require-await -- explicit-override-only intentionally has no AWS calls
export async function importImpl(
  this: IAMPolicyProvider,
  input: ResourceImportInput
): Promise<ResourceImportResult | null> {
  if (input.knownPhysicalId) {
    return { physicalId: input.knownPhysicalId, attributes: {} };
  }
  return null;
}
