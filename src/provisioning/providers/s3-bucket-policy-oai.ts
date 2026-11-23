/**
 * The CloudFront OAI principal forms S3 returns in a bucket policy, and the
 * helpers `S3BucketPolicyProvider` uses to fold them back to the template's
 * `{ CanonicalUser }` form (issue #872). A sibling of
 * `s3-bucket-policy-provider.ts`, which sits at the source file size cap.
 */
import type { ReadCurrentStateContext } from '../../types/resource.js';

/**
 * Matches a CloudFront Origin Access Identity (OAI) principal ARN, e.g.
 * `arn:aws:iam::cloudfront:user/CloudFront Origin Access Identity E1UREC9EUJDVG5`.
 * The capture group is the OAI id, which resolves to the OAI's S3 canonical
 * user id via `GetCloudFrontOriginAccessIdentity`.
 */
export const OAI_USER_ARN_RE =
  /^arn:aws[a-z-]*:iam::cloudfront:user\/CloudFront Origin Access Identity ([A-Z0-9]+)$/;

/**
 * Matches a bare IAM USER unique id (e.g. `AIDAIBJOSOJSBZ753XCAW`). S3
 * returns an OAI grant's principal in this transient form immediately after
 * `PutBucketPolicy` (before it settles to the friendly cloudfront-user ARN);
 * an OAI is a CloudFront IAM user, so the id carries the `AIDA` user prefix.
 * It carries no recoverable link back to the OAI, so it can only be
 * canonicalized by matching against the template's `{ CanonicalUser }` form.
 * Any other prefix (a role's `AROA`, ...) is never an OAI and is left alone
 * (go-to-k/cdkd#6109).
 */
export const IAM_UNIQUE_ID_RE = /^AIDA[A-Z0-9]{12,}$/;

/**
 * Build an `oaiId -> S3CanonicalUserId` map from the same-stack sibling
 * `AWS::CloudFront::CloudFrontOriginAccessIdentity` resources in the read
 * context. The OAI's `S3CanonicalUserId` is a readOnly attribute cdkd already
 * resolved at deploy time (the bucket-policy grant `Fn::GetAtt`s it), so this
 * lets the bucket-policy drift read reconcile the OAI principal forms with zero
 * extra AWS calls (and no `cloudfront:GetCloudFrontOriginAccessIdentity` IAM
 * grant) whenever the OAI lives in the same stack. The OAI resource's
 * `physicalId` IS the OAI id embedded in the cloudfront-user ARN.
 */
export function buildSiblingOaiCanonicalMap(
  context?: ReadCurrentStateContext
): Map<string, string> {
  const map = new Map<string, string>();
  for (const sib of Object.values(context?.siblings ?? {})) {
    if (sib.resourceType !== 'AWS::CloudFront::CloudFrontOriginAccessIdentity') continue;
    const canonical = sib.attributes?.['S3CanonicalUserId'];
    if (sib.physicalId && typeof canonical === 'string') {
      map.set(sib.physicalId, canonical);
    }
  }
  return map;
}

/**
 * Pull the `Statement` array out of a parsed policy document, tolerating both
 * the single-object and array shapes (and a non-object input). Returns the live
 * statement objects so callers can mutate their `Principal` in place.
 */
export function extractStatements(policyDoc: unknown): Record<string, unknown>[] {
  if (!policyDoc || typeof policyDoc !== 'object') return [];
  const stmt = (policyDoc as Record<string, unknown>)['Statement'];
  const arr = Array.isArray(stmt) ? stmt : stmt ? [stmt] : [];
  return arr.filter(
    (s): s is Record<string, unknown> => !!s && typeof s === 'object' && !Array.isArray(s)
  );
}

/**
 * Find the `CanonicalUser` principal of the template statement that matches a
 * given AWS-side statement by Effect / Action / Resource, used to canonicalize
 * the unresolvable transient `{ AWS: <IAM-unique-id> }` OAI form. Returns
 * `undefined` when no single matching template statement carries one.
 */
export function findTemplateCanonicalUser(
  awsStmt: Record<string, unknown>,
  templateStmts: Record<string, unknown>[]
): string | undefined {
  // S3 reads a one-element `Action` / `Resource` list back as its scalar
  // (go-to-k/cdkd#6109), so both sides compare unwrapped.
  const one = (v: unknown): unknown => (Array.isArray(v) && v.length === 1 ? v[0] : v);
  const key = (s: Record<string, unknown>): string =>
    JSON.stringify([s['Effect'], one(s['Action']), one(s['Resource'])]);
  const want = key(awsStmt);
  const matches = templateStmts.filter((t) => key(t) === want);
  if (matches.length !== 1) return undefined;
  const principal = matches[0]!['Principal'];
  if (!principal || typeof principal !== 'object' || Array.isArray(principal)) return undefined;
  const canonical = (principal as Record<string, unknown>)['CanonicalUser'];
  return typeof canonical === 'string' ? canonical : undefined;
}

/**
 * Whether `policyDoc` holds a bare `AIDA…` principal that the read right after
 * cdkd's own write would fold to a template statement's `CanonicalUser`
 * (go-to-k/cdkd#6854). Any other read compares it as is, so it first re-reads
 * the policy while this holds, for the seconds S3 shows a fresh OAI grant that
 * way; a deleted IAM user's id stays and is then compared.
 */
export function hasTemplateMatchedUniqueId(
  policyDoc: unknown,
  templateProps: Record<string, unknown> | undefined
): boolean {
  const templateStmts = extractStatements(templateProps?.['PolicyDocument']);
  if (templateStmts.length === 0) return false;
  return extractStatements(policyDoc).some((stmt) => {
    const principal = stmt['Principal'];
    if (!principal || typeof principal !== 'object' || Array.isArray(principal)) return false;
    const aws = (principal as Record<string, unknown>)['AWS'];
    return (
      typeof aws === 'string' &&
      IAM_UNIQUE_ID_RE.test(aws) &&
      findTemplateCanonicalUser(stmt, templateStmts) !== undefined
    );
  });
}
