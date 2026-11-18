/**
 * AWS Emulator does not put `aws:SecureTransport` into its policy evaluation
 * context (aws/aws-emulator#369), so the statement CDK's `enforceSSL: true`
 * emits — `Deny` when `Bool aws:SecureTransport` is `false` — matches every
 * request there. EventBridge → SQS delivery, for one, is then dropped silently.
 *
 * The emulator serves HTTPS only, as AWS does to every SDK and service
 * principal, so on a correct evaluator such a statement can never match:
 * conditions in one statement are AND-ed, so its other conditions, principal
 * and action do not matter. Dropping it while `--aws-emulator` is active
 * changes no access decision AWS would make. CloudFormation parity gives way
 * here on purpose: cdkd keeps AWS's semantics, not the template's bytes, and
 * only on the wire — the state record keeps the templated document.
 */
import { awsEndpointOverrideActive } from '../utils/aws-client-defaults.js';
import { getLogger } from '../utils/logger.js';
import { safeMsg } from '../utils/display-safe.js';

/** `false`, `"false"`, or a one-element array of either (case-insensitive). */
function isFalseOnly(value: unknown): boolean {
  const values = Array.isArray(value) ? value : [value];
  if (values.length !== 1) return false;
  const v = values[0];
  return v === false || (typeof v === 'string' && v.toLowerCase() === 'false');
}

/**
 * Whether `statement` is a `Deny` that applies only when the request is not
 * TLS: a `Bool` / `BoolIfExists` condition holding `aws:SecureTransport`
 * (key case-insensitive, as IAM reads it) with the value set exactly `{false}`.
 */
export function isInsecureTransportDeny(statement: unknown): boolean {
  if (statement === null || typeof statement !== 'object' || Array.isArray(statement)) return false;
  const s = statement as Record<string, unknown>;
  if (s['Effect'] !== 'Deny') return false;
  const condition = s['Condition'];
  if (condition === null || typeof condition !== 'object' || Array.isArray(condition)) return false;
  for (const [operator, block] of Object.entries(condition as Record<string, unknown>)) {
    if (operator !== 'Bool' && operator !== 'BoolIfExists') continue;
    if (block === null || typeof block !== 'object' || Array.isArray(block)) continue;
    for (const [key, value] of Object.entries(block as Record<string, unknown>)) {
      if (key.toLowerCase() === 'aws:securetransport' && isFalseOnly(value)) return true;
    }
  }
  return false;
}

/**
 * `document` without its {@link isInsecureTransportDeny} statements, and how
 * many were left out. A string document is parsed first; an unparseable one,
 * one without a `Statement` array (a lone statement object cannot be dropped
 * without emptying the policy), or one the drop would leave with no statement
 * at all (a policy of only that `Deny` grants nothing either way) is returned
 * unchanged, with `dropped: 0`.
 */
function withoutInsecureTransportDenies(document: unknown): { document: unknown; dropped: number } {
  let parsed: unknown = document;
  if (typeof document === 'string') {
    try {
      parsed = JSON.parse(document);
    } catch {
      return { document, dropped: 0 };
    }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { document, dropped: 0 };
  }
  const statements = (parsed as Record<string, unknown>)['Statement'];
  if (!Array.isArray(statements)) return { document, dropped: 0 };
  const kept = statements.filter((statement) => !isInsecureTransportDeny(statement));
  const dropped = statements.length - kept.length;
  if (dropped === 0 || kept.length === 0) return { document, dropped: 0 };
  return { document: { ...(parsed as Record<string, unknown>), Statement: kept }, dropped };
}

/**
 * The policy document cdkd SENDS for `document` in this run: under
 * `--aws-emulator` without its {@link isInsecureTransportDeny} statements,
 * otherwise `document` itself. Silent: for comparing a live policy with a
 * templated or journaled one, which under the emulator holds what was sent.
 */
export function sentPolicyDocument(document: unknown): unknown {
  if (!awsEndpointOverrideActive()) return document;
  return withoutInsecureTransportDenies(document).document;
}

/**
 * {@link sentPolicyDocument}, warning naming the resource and how many
 * statements were left out. Called once per write call, so a retried create
 * warns again.
 */
export function policyDocumentForEmulator(
  document: unknown,
  resourceType: string,
  logicalId: string
): unknown {
  if (!awsEndpointOverrideActive()) return document;
  const { document: sent, dropped } = withoutInsecureTransportDenies(document);
  if (dropped === 0) return document;
  const what = dropped === 1 ? 'a Deny statement' : `${dropped} Deny statements`;
  getLogger().warn(
    safeMsg`--aws-emulator: left ${what} on aws:SecureTransport out of ${logicalId} (${resourceType}): AWS Emulator does not evaluate that key, so the statement would deny every request; on AWS it never matches an HTTPS request. The state record keeps the templated policy.`
  );
  return sent;
}

/**
 * The resource-policy JSON a `QueuePolicy` / `BucketPolicy` / `TopicPolicy`
 * provider sends: {@link policyDocumentForEmulator}, then a string document as
 * given and any other one stringified.
 */
export function serializeResourcePolicy(
  document: unknown,
  resourceType: string,
  logicalId: string
): string {
  const sent = policyDocumentForEmulator(document, resourceType, logicalId);
  return typeof sent === 'string' ? sent : JSON.stringify(sent);
}
