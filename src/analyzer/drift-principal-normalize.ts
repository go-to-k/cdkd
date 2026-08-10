/**
 * IAM principal-form canonicalization for the drift comparator (issue #1515).
 *
 * AWS renders an IAM role / user principal inside a resource policy in TWO
 * forms and picks between them on its own schedule:
 *
 *   - the ARN — `arn:aws:iam::<acct>:role/<name>`
 *   - the principal's UNIQUE ID — `AROA…` (role) / `AIDA…` (user)
 *
 * The unique-id form is substituted when the referenced principal is
 * transiently unresolvable at write time (it is being created or replaced) and
 * AWS re-renders the ARN once it resolves. cdkd's deploy-time
 * `observedProperties` capture stores whichever form the read returned at that
 * moment, so a later `cdkd drift` can compare `AROA…` against the ARN for the
 * very same principal and report PERMANENT phantom drift — `--revert` writes
 * the recorded form back, AWS re-canonicalizes on write, and the next run
 * reports the identical difference (the class of issues #1096 / #1498, on a
 * different property).
 *
 * Unlike the order-normalization passes in `drift-normalize.ts`, this one
 * CANNOT be pure: the mapping between the two forms is not derivable from the
 * string. So the shape detection here is pure and an injected
 * {@link PrincipalUniqueIdResolver} does the one lookup, which lets the whole
 * pass be unit-tested without AWS and keeps the API cost at zero for the
 * overwhelmingly common case — a policy with no unique-id principal makes NO
 * AWS call at all.
 *
 * Both sides are rewritten to the ARN form, never one side only. The race that
 * produces the mismatch is symmetric (the 2026-08-10 evidence on the
 * `drift-revert` fixture had the baseline holding `AROA…` and AWS the ARN, but
 * the reverse ordering is equally reachable), and normalizing a single side is
 * the mistake `drift-normalize.ts`'s header already records for the unordered
 * passes — it manufactures drift on the `properties`-fallback baseline.
 *
 * FAILING IS VISIBLE, never silent: when the resolver cannot answer (the role
 * was deleted — which is exactly when AWS keeps the unique id forever — the
 * caller lacks `iam:GetRole`, or the ARN names another ACCOUNT / IAM PATH, for
 * which the name-only `GetRole` API would otherwise answer about the caller's
 * own same-named role), both sides are left untouched and the drift is still
 * reported. This pass only ever removes a difference it has PROVEN to be two
 * spellings of one principal; it can never hide a real principal change.
 *
 * One downstream note: because the comparator's inputs are canonicalized,
 * `cdkd drift --accept` records the ARN form for a policy subtree that drifts
 * for some OTHER reason while also carrying a canonicalized principal — i.e.
 * the accepted baseline can hold a spelling AWS did not literally return. That
 * is benign (it is the form AWS re-canonicalizes to, and a later run
 * normalizes either way) but it is a real difference from "state records
 * exactly what AWS said", so it is written down rather than left to be
 * rediscovered.
 *
 * Known bound: a policy carried as a JSON STRING rather than a parsed object is
 * not walked. Re-serializing a parsed string would risk changing its formatting
 * and manufacturing a different phantom drift, so the pass is scoped to the
 * object shape — which is what `AWS::S3::BucketPolicy` and the other
 * `PolicyDocument`-typed properties carry in cdkd state.
 */

/**
 * An IAM unique id as it appears in a rendered policy. The prefix set is
 * deliberately narrow — `AROA` (role) and `AIDA` (user) are the only two that
 * can stand in for an ARN at a `Principal.AWS` position; `AGPA` (group),
 * `AKIA` (access key) and friends are never rendered there.
 */
const PRINCIPAL_UNIQUE_ID_RE = /^A(?:ROA|IDA)[A-Z0-9]{6,}$/;

/** An IAM role / user ARN — the two shapes a unique id can stand in for. */
const IAM_PRINCIPAL_ARN_RE = /^arn:[a-z0-9-]+:iam::\d{12}:(role|user)\/(.+)$/;

/**
 * Split an IAM role / user principal ARN into what the lookup API needs, or
 * `undefined` when the string is not one (a service principal, an
 * `assumed-role` STS ARN, `*`, …).
 *
 * Exported so the resolver in `drift.ts` recognizes exactly the ARNs
 * {@link collectPrincipalArns} collects — one regex, so the collector and the
 * lookup cannot drift apart and leave an ARN gathered but never resolvable.
 */
export function parseIamPrincipalArn(
  arn: string
): { kind: 'role' | 'user'; name: string } | undefined {
  const match = IAM_PRINCIPAL_ARN_RE.exec(arn);
  if (!match) return undefined;
  // The remainder after `role/` can carry an IAM PATH (`role/some/path/Name`);
  // the API wants the name only.
  const name = match[2]!.split('/').pop();
  if (!name) return undefined;
  return { kind: match[1] as 'role' | 'user', name };
}

/**
 * Resolve an IAM role / user ARN to that principal's unique id (`AROA…` /
 * `AIDA…`), or `undefined` when it cannot be determined (deleted principal,
 * missing permission, malformed ARN).
 *
 * Injected rather than imported so this module stays free of an AWS client and
 * the whole pass is unit-testable; the real implementation lives in
 * `drift.ts`, which owns the clients and the per-run cache.
 */
export type PrincipalUniqueIdResolver = (arn: string) => Promise<string | undefined>;

/** Every string at a `Principal` / `NotPrincipal` position, at any depth. */
function collectPrincipalStrings(value: unknown, out: string[]): void {
  if (Array.isArray(value)) {
    for (const element of value) collectPrincipalStrings(element, out);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, member] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'Principal' || key === 'NotPrincipal') {
      pushPrincipalValue(member, out);
      // A principal block can legitimately nest nothing, but keep walking it
      // anyway: an `Fn::If`-shaped leftover or a deeper policy structure must
      // not stop the descent.
    }
    collectPrincipalStrings(member, out);
  }
}

/**
 * The strings a `Principal` / `NotPrincipal` value contributes: the bare string
 * form, and the `AWS` member of the object form (string or array). `Service` /
 * `Federated` / `CanonicalUser` are deliberately NOT read — none of them can
 * carry an IAM unique id or a role ARN.
 */
function pushPrincipalValue(value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const element of value) if (typeof element === 'string') out.push(element);
    return;
  }
  if (!value || typeof value !== 'object') return;
  const awsMember = (value as Record<string, unknown>)['AWS'];
  if (typeof awsMember === 'string') out.push(awsMember);
  else if (Array.isArray(awsMember))
    for (const element of awsMember) if (typeof element === 'string') out.push(element);
}

/**
 * Both interesting principal kinds in ONE walk — the pass runs per resource on
 * both comparison sides, so walking the bag twice to answer two questions about
 * the same strings is pure cost.
 */
export function collectPrincipalForms(value: unknown): {
  uniqueIds: Set<string>;
  arns: Set<string>;
} {
  const strings: string[] = [];
  collectPrincipalStrings(value, strings);
  const uniqueIds = new Set<string>();
  const arns = new Set<string>();
  for (const s of strings) {
    if (PRINCIPAL_UNIQUE_ID_RE.test(s)) uniqueIds.add(s);
    else if (IAM_PRINCIPAL_ARN_RE.test(s)) arns.add(s);
  }
  return { uniqueIds, arns };
}

/** The IAM unique ids used as principals anywhere in `value`. */
export function collectPrincipalUniqueIds(value: unknown): Set<string> {
  return collectPrincipalForms(value).uniqueIds;
}

/** The IAM role / user ARNs used as principals anywhere in `value`. */
export function collectPrincipalArns(value: unknown): Set<string> {
  return collectPrincipalForms(value).arns;
}

/**
 * Replace every principal string that is a KNOWN unique id with the ARN it was
 * proven to stand for. Only `Principal` / `NotPrincipal` positions are touched
 * — a unique id appearing in, say, a `Condition` value is left alone, where the
 * two forms are NOT interchangeable.
 */
export function rewritePrincipalUniqueIds(
  value: unknown,
  arnByUniqueId: ReadonlyMap<string, string>
): unknown {
  if (Array.isArray(value)) return value.map((el) => rewritePrincipalUniqueIds(el, arnByUniqueId));
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, member] of Object.entries(value as Record<string, unknown>)) {
    out[key] =
      key === 'Principal' || key === 'NotPrincipal'
        ? rewritePrincipalValue(member, arnByUniqueId)
        : rewritePrincipalUniqueIds(member, arnByUniqueId);
  }
  return out;
}

function rewritePrincipalValue(
  value: unknown,
  arnByUniqueId: ReadonlyMap<string, string>
): unknown {
  const swap = (s: unknown): unknown =>
    typeof s === 'string'
      ? (arnByUniqueId.get(s) ?? s)
      : rewritePrincipalUniqueIds(s, arnByUniqueId);
  if (typeof value === 'string') return swap(value);
  if (Array.isArray(value)) return value.map(swap);
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, member] of Object.entries(value as Record<string, unknown>)) {
    if (key !== 'AWS') {
      out[key] = rewritePrincipalUniqueIds(member, arnByUniqueId);
      continue;
    }
    out[key] = Array.isArray(member) ? member.map(swap) : swap(member);
  }
  return out;
}

/**
 * Canonicalize the two comparison sides so that a principal AWS rendered as a
 * unique id on one side and as an ARN on the other stops reading as drift.
 *
 * Short-circuits — with NO resolver call — unless BOTH a unique id and an IAM
 * ARN are present across the two sides, since a unique id with no candidate ARN
 * opposite it has nothing to be equal to.
 */
export async function canonicalizePrincipalUniqueIds(
  baseline: Record<string, unknown>,
  aws: Record<string, unknown>,
  resolve: PrincipalUniqueIdResolver
): Promise<{ baseline: Record<string, unknown>; aws: Record<string, unknown> }> {
  const baselineForms = collectPrincipalForms(baseline);
  const awsForms = collectPrincipalForms(aws);
  const uniqueIds = new Set([...baselineForms.uniqueIds, ...awsForms.uniqueIds]);
  if (uniqueIds.size === 0) return { baseline, aws };
  const arns = new Set([...baselineForms.arns, ...awsForms.arns]);
  if (arns.size === 0) return { baseline, aws };

  const arnByUniqueId = new Map<string, string>();
  for (const arn of arns) {
    const uniqueId = await resolve(arn);
    // Only a PROVEN pair is recorded: the resolved id has to be one actually
    // present in the compared values.
    if (uniqueId !== undefined && uniqueIds.has(uniqueId)) arnByUniqueId.set(uniqueId, arn);
  }
  if (arnByUniqueId.size === 0) return { baseline, aws };

  return {
    baseline: rewritePrincipalUniqueIds(baseline, arnByUniqueId) as Record<string, unknown>,
    aws: rewritePrincipalUniqueIds(aws, arnByUniqueId) as Record<string, unknown>,
  };
}
