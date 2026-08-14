/**
 * Secret redaction for resolved dynamic references (GHSA fix).
 *
 * CloudFormation dynamic references (`{{resolve:secretsmanager:...}}`) are
 * resolved to plaintext by `IntrinsicFunctionResolver.resolveDynamicReferences`
 * so the concrete secret can be handed to the AWS API on create / update. That
 * plaintext must NEVER be persisted to cdkd state or shown in CLI output, or
 * anyone with read access to the state bucket / terminal logs recovers the
 * secret — which defeats the entire point of storing it in Secrets Manager.
 *
 * The resolver records, per resolution pass, every plaintext secret VALUE it
 * substituted together with the original `{{resolve:...}}` expression it came
 * from (a `RecordedSecretValues` map on `ResolverContext`). This module turns
 * that record into two pure operations:
 *
 * - {@link redactSecretsForState} rewrites the bag cdkd is about to PERSIST so
 *   each secret value is replaced by the original unresolved expression. This
 *   is CloudFormation-parity: CFn keeps the `{{resolve:...}}` reference in the
 *   template and resolves it service-side, so the concrete value never lands in
 *   a persisted artifact. Storing the expression (rather than a blind `***`
 *   marker) also means the next `cdkd deploy` diffs expression-vs-expression
 *   and does not spuriously re-apply the resource on every run.
 *
 * - {@link maskSecretsInText} replaces any known secret value inside an
 *   arbitrary string with a fixed marker, for log / error-message paths where
 *   the resolved value would otherwise be echoed (`Fn::Join` / `Fn::Sub` debug
 *   lines, the Cloud Control JSON-patch log, AWS validation errors quoting the
 *   offending value).
 *
 * Both operations work by VALUE match rather than by property path: a resolved
 * secret is a distinctive plaintext string that appears in the resolved bag (or
 * a concatenated `Fn::Join` / `Fn::Sub` result) exactly where it was
 * substituted, so a value scan covers the embedded cases uniformly without
 * threading a path argument through every resolver method. Over-redaction (a
 * coincidental match elsewhere) is harmless and the safe direction; under-
 * redaction would leak a secret, so a match is always replaced.
 *
 * The module is a LEAF — it imports nothing — because both the resolver and the
 * deploy engine consume it and both already sit on a dense import ring.
 */

/**
 * Map of resolved plaintext secret value -> the original `{{resolve:...}}`
 * expression it was substituted from. Populated by the resolver during a
 * resolution pass and read by the persistence / masking helpers below.
 */
export type RecordedSecretValues = Map<string, string>;

/** Fixed marker substituted for a secret value in log / error output. */
export const SECRET_MASK = '***';

/**
 * Every `{{resolve:...}}` expression this process has PROVEN resolves to a
 * secret, as a SET — uncollapsed by resolved value (issue #1910).
 *
 * This is the piece {@link RecordedSecretValues} structurally cannot supply.
 * That map is keyed by the resolved PLAINTEXT, so when two expressions resolve
 * to the same value it keeps only the last, and asking it whether the LOSING
 * expression was a secret answers "no" — for precisely the pair the path-based
 * redaction exists to separate. The losing leaf then falls through to the value
 * scan and is persisted holding its SIBLING's expression: a permanent spurious
 * UPDATE, and on the rollback-journal replay path a re-resolution of the wrong
 * reference against the live resource.
 *
 * Only `ssm` needs an entry. A `secretsmanager` reference is secret by
 * SPELLING (see {@link isKnownSecretExpression}), so it is decidable with no
 * lookup and no memory; an `ssm` one is secret only when its parameter is a
 * `SecureString`, which is knowable only from the `GetParameter` response.
 *
 * It lives in THIS module rather than in the resolver even though the resolver
 * is its only writer, for two reasons. This module is the LEAF — the resolver
 * already imports it, so the store is reachable from the writer without adding
 * an edge, while the reverse (a leaf importing the resolver) would close a
 * cycle. And the READER is {@link isKnownSecretExpression} right here, so
 * homing it here means no call site has to thread it: the four sibling writers
 * #1910 fixes pass a position SOURCE and nothing else.
 *
 * Its lifetime matches the resolver's `cachedDynamicReferences` — the resolver
 * clears both together, and that shared lifetime is the point: this set is the
 * store behind `secureStringSsmReferences`, which already had exactly this
 * scope, so nothing is widened by moving it here.
 *
 * Process-wide is therefore INHERITED, not claimed to be ideal. It is not
 * strictly sound across regions or accounts in one run — the same expression
 * can name a `SecureString` in one region and a plain `String` in another — but
 * `cachedDynamicReferences` caches the resolved VALUE under the same
 * assumption, so a per-region store here would fix nothing on its own. Note
 * which way the imprecision points: an entry only ever GRANTS "persist the
 * source leaf verbatim", and the leaf is the resource's own template
 * expression, so the failure mode is a public reference stored as an expression
 * (a spurious UPDATE, issue #1901's class), never a secret stored as plaintext.
 */
const recordedSecretExpressions = new Set<string>();

/** Remember that `expression` resolves to a secret. Called by the resolver. */
export function recordSecretExpression(expression: string): void {
  recordedSecretExpressions.add(expression);
}

/**
 * Forget a previously recorded expression — the resolver's `SecureString`
 * verdict going the other way (an ssm parameter that turns out to be a plain
 * `String` / `StringList`, i.e. public config that must stay RESOLVED in
 * state).
 */
export function forgetSecretExpression(expression: string): void {
  recordedSecretExpressions.delete(expression);
}

/** Has `expression` been PROVEN to resolve to a secret this process? */
export function isRecordedSecretExpression(expression: string): boolean {
  return recordedSecretExpressions.has(expression);
}

/** Drop every remembered verdict. Paired with the resolver's cache reset. */
export function clearRecordedSecretExpressions(): void {
  recordedSecretExpressions.clear();
}

/**
 * A resolved secret value shorter than this is NOT used as a redaction needle:
 * a 1-2 character plaintext (e.g. a secret whose JSON key holds `"0"`) would
 * match incidental characters everywhere and mangle unrelated state. Such a
 * value is still masked at the exact leaf where it was the WHOLE value (handled
 * by the caller), but is not scanned for as a substring. Real secrets are far
 * longer than this, so the bound only excludes degenerate cases.
 */
const MIN_NEEDLE_LENGTH = 4;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build a single alternation regex matching any recorded secret value, longest
 * first so an overlapping shorter secret cannot pre-empt a longer match. Returns
 * `undefined` when there is nothing worth scanning for.
 */
function buildNeedleRegex(values: Iterable<string>): RegExp | undefined {
  const needles = Array.from(new Set(values))
    .filter((v) => v.length >= MIN_NEEDLE_LENGTH)
    .sort((a, b) => b.length - a.length);
  if (needles.length === 0) return undefined;
  return new RegExp(needles.map(escapeRegExp).join('|'), 'g');
}

/**
 * The two rules the path pass needs, which are ORTHOGONAL — this was one
 * parameter and the conflation was a real defect (found by review, reproduced
 * against the branch tip).
 *
 * They are decided by DIFFERENT bags:
 *
 * - `descendArrays` follows the BAG's provenance. Positional descent is sound
 *   only when the bag was PRODUCED BY resolving the source, so the two have
 *   identical structure. The persisted `properties` is
 *   `effectiveProperties ?? desiredProperties`, so a provider-NARROWED bag can
 *   be walked against the template; every `effectiveProperties` producer today
 *   preserves length and order on an equal-length array, and the length check
 *   below is what makes a producer that stops doing so fall to the value scan
 *   rather than mis-align. An AWS readback may be REORDERED — AWS does not
 *   preserve list order, which is the whole reason
 *   `src/analyzer/drift-normalize.ts` exists — and descending it positionally
 *   would write an expression onto the WRONG element while leaving the real
 *   secret in plaintext.
 * - `trustAnyExpression` follows the SOURCE's provenance. A persisted STATE bag
 *   holds no public expressions (a public ssm reference is stored RESOLVED), so
 *   any `{{resolve:...}}` in one is by construction a secret — which is what
 *   lets an UNCHANGED resource be redacted with no secrets map at all (issue
 *   #1900). One narrow exception exists and is worth knowing rather than
 *   asserting around: `cdkd import` warns and persists the RAW template
 *   intrinsic when it cannot resolve one, so a public expression CAN sit in a
 *   record's `properties`. Trusting it here only copies that same literal into
 *   `observedProperties`, which the record already carried, so this does not
 *   make it reach anything new. A TEMPLATE bag carries public and secret expressions alike, so only
 *   a KNOWN secret may be persisted from it, or a `String` / `StringList`
 *   parameter would be stored as its expression and the diff would compare a
 *   resolved desired side against it forever — the perpetual UPDATE issue #1901
 *   exists to prevent.
 *
 * `observedProperties` is exactly the case that proves they are separate: its
 * bag is an AWS readback (so no array descent) while its source may be the
 * TEMPLATE (so no blanket trust). Answering both from one enum leaked the
 * template's public ssm expression into the drift baseline, which
 * `cdkd drift --revert` then pushes back to AWS as a literal.
 */
export interface PathSourceRules {
  descendArrays: boolean;
  trustAnyExpression: boolean;
}

/** The bag was produced by resolving the source: same shape, template source. */
export const TEMPLATE_DERIVED_RULES: PathSourceRules = {
  descendArrays: true,
  trustAnyExpression: false,
};

/** An AWS readback projected from a persisted STATE bag. */
export const STATE_SOURCED_READBACK_RULES: PathSourceRules = {
  descendArrays: false,
  trustAnyExpression: true,
};

/** An AWS readback projected from the TEMPLATE: neither relaxation applies. */
export const TEMPLATE_SOURCED_READBACK_RULES: PathSourceRules = {
  descendArrays: false,
  trustAnyExpression: false,
};

/**
 * The bag was produced by resolving a STATE source — both relaxations apply.
 *
 * The rollback replay is the case (issue #1910): `resolveReplayProps` resolves
 * the JOURNALED bag and the provider's `effectiveProperties` come back from
 * that, so the two have identical structure and positional array descent is
 * sound exactly as it is for a template-derived bag. And the source is a
 * persisted record, which holds no PUBLIC expressions — a `String` ssm
 * reference is stored resolved — so any `{{resolve:...}}` in it is by
 * construction a secret.
 *
 * Using `STATE_SOURCED_READBACK_RULES` here instead would be wrong in the
 * quiet direction: it turns array descent OFF, so a secret nested in a
 * `Tags[]` / ECS `secrets[]` element falls to the value scan and a colliding
 * pair still collapses there.
 */
export const STATE_DERIVED_RULES: PathSourceRules = {
  descendArrays: true,
  trustAnyExpression: true,
};

function isDynamicReferenceString(value: unknown): value is string {
  return typeof value === 'string' && value.includes('{{resolve:');
}

/**
 * Is this template expression one whose resolved value is a SECRET?
 *
 * Two independent answers, and both are needed:
 *
 * - A `secretsmanager` reference is secret BY DEFINITION, so spelling settles
 *   it with no lookup. This arm is what makes the #1904 fix work at all: when
 *   two expressions resolve to the same value the value-keyed map keeps only the
 *   last, so asking the map whether the LOSING expression was a secret answers
 *   "no" — precisely for the pair the fix exists to separate.
 * - An `ssm` reference is secret only when its parameter is a `SecureString`
 *   (issue #1901), which is not derivable from the string, so that arm consults
 *   what the resolver actually recorded.
 *
 * `secretExpressions` is what closes the ssm/ssm case (issue #1910). Derived
 * from the value-keyed map it is useless for exactly this question — the map
 * already collapsed the pair, so the losing expression is absent from
 * `secrets.values()` — which is why callers pass the resolver's own SET of
 * secret expressions instead. Callers that pass nothing fall back to the map's
 * values, i.e. to the pre-#1910 behavior: the pair still collapses, but nothing
 * leaks (both leaves are redacted, just onto one expression).
 */
function isKnownSecretExpression(
  expression: string,
  secretExpressions: ReadonlySet<string>
): boolean {
  return (
    expression.startsWith('{{resolve:secretsmanager:') ||
    secretExpressions.has(expression) ||
    // The pass's own map collapsed every group of expressions sharing a
    // resolved value down to its last member, so the LOSING members reach this
    // arm and only this arm (issue #1910).
    isRecordedSecretExpression(expression)
  );
}

/**
 * Is this source leaf a SINGLE complete `{{resolve:...}}` token and nothing
 * else?
 *
 * Whole-leaf substitution is only correct for that shape. A MIXED leaf --
 * `pre{{resolve:ssm:/public}}-{{resolve:secretsmanager:x}}post`, i.e. anything
 * the resolver substituted INTO rather than replaced -- must fall to the value
 * scan, which rewrites just the secret substring. Substituting the whole leaf
 * there would re-introduce every other token in it, including a public ssm
 * reference the resolver deliberately left resolved (issue #1901).
 */
function isSingleDynamicReferenceToken(value: string): boolean {
  return /^\{\{resolve:[^{}]*\}\}$/.test(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * PATH-based redaction: walk `bag` alongside a SOURCE bag that still carries the
 * unresolved `{{resolve:...}}` expressions, and wherever the source leaf is such
 * a string, persist THAT string verbatim.
 *
 * This exists because value-keyed redaction cannot answer the question at all
 * when two expressions share one resolved value (issue #1904): the map is keyed
 * by the plaintext, so the two collapse and every site is rewritten to whichever
 * expression was recorded last — state then holds an expression the template
 * does not have at that leaf, and the stack takes a permanent spurious UPDATE.
 * Position is the only disambiguator, and the source bag supplies it.
 *
 * It also covers the case where there is no secrets map to consult at all
 * (issue #1900): an UNCHANGED resource is never resolved during a deploy, so its
 * `perResourceSecrets` entry is empty, and a live readback that echoes a secret
 * would be persisted in plaintext. Projecting from the resource's OWN state
 * record — which already holds the expressions — redacts it with no secret
 * fetch and no value matching.
 *
 * The value scan is still applied wherever the source cannot answer: a source
 * leaf that is an intrinsic OBJECT (`Fn::Join` / `Fn::Sub`) resolves to a string
 * embedding the secret, and only a value match can find it inside. So the two
 * passes are complementary rather than alternatives — path where position is
 * knowable, value where it is not.
 */
function redactByPath(
  bag: unknown,
  source: unknown,
  secrets: RecordedSecretValues,
  rules: PathSourceRules,
  secretExpressions: ReadonlySet<string>
): unknown {
  // The bag leaf is ALREADY a complete `{{resolve:...}}` token, so there is no
  // plaintext here to redact and the source has nothing to contribute. Keep it
  // verbatim (issue #1910 review).
  //
  // Without this the pass would OVERWRITE one expression with a DIFFERENT one
  // whenever the two bags disagree — and they legitimately can, because not
  // every caller's bag was produced by resolving its source. `cdkd scrub` is
  // the case: its bag is PERSISTED STATE and its source is TODAY's template, so
  // for a template edited but not yet deployed (`:AWSPREVIOUS` in state,
  // `:AWSCURRENT` in the template) it would rewrite state onto the undeployed
  // expression, report `recordsChanged` for a record holding no plaintext at
  // all — failing a `--dry-run --fail` CI gate with "plaintext found" — and
  // then make the next deploy compare expression-vs-expression, see NO_CHANGE,
  // and never push the new reference to AWS.
  //
  // Safe at every other caller: if a resolved bag still carries a whole token,
  // the resolver did not substitute it, so the leaf already EQUALS its source
  // and returning it verbatim is what the substitution would have produced.
  if (typeof bag === 'string' && isSingleDynamicReferenceToken(bag)) return bag;
  if (isDynamicReferenceString(source) && typeof bag === 'string') {
    // A TEMPLATE source carries PUBLIC ssm expressions too, and those must stay
    // RESOLVED in state (#1901) or the diff compares a resolved desired side
    // against a stored expression forever. A STATE source cannot hold one.
    if (
      isSingleDynamicReferenceToken(source) &&
      (rules.trustAnyExpression || isKnownSecretExpression(source, secretExpressions))
    ) {
      // The source leaf IS what state should hold — exact, and immune to two
      // expressions sharing one resolved value.
      return source;
    }
    // Public reference: keep the resolved value, but still value-scan it so a
    // secret embedded beside it is redacted.
    return redactSecretsForState(bag, secrets);
  }
  if (
    rules.descendArrays &&
    Array.isArray(bag) &&
    Array.isArray(source) &&
    bag.length === source.length
  ) {
    // Positional descent is sound ONLY because the bag was produced by resolving
    // the source. An AWS readback may be REORDERED, so that kind falls through
    // to the value scan rather than writing an expression onto a wrong element.
    return bag.map((item, i) => redactByPath(item, source[i], secrets, rules, secretExpressions));
  }
  if (isPlainObject(bag) && isPlainObject(source)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(bag)) {
      // `Object.hasOwn`, not `k in source`: the prototype chain would answer for
      // `constructor` / `toString` and hand the walk a function as the source.
      out[k] = Object.hasOwn(source, k)
        ? redactByPath(v, source[k], secrets, rules, secretExpressions)
        : redactSecretsForState(v, secrets);
    }
    return out;
  }
  // Shapes diverged (an array whose length changed, a scalar where the source
  // has an object, a key the source lacks): fall back to the value scan, which
  // is strictly better than leaving the subtree unredacted.
  return redactSecretsForState(bag, secrets);
}

/**
 * Deep-clone `bag`, replacing every occurrence of a recorded secret value with
 * the unresolved `{{resolve:...}}` expression it came from. A string whose WHOLE
 * value equals a secret is replaced by that secret's expression exactly; a
 * string that merely CONTAINS one (an `Fn::Join` / `Fn::Sub` result) has the
 * secret substring replaced in place. Returns the input by identity when there
 * is nothing to redact, so callers can persist the original object unchanged in
 * the common no-secret case.
 */
export function redactSecretsForState<T>(
  bag: T,
  secrets: RecordedSecretValues,
  source?: unknown,
  rules: PathSourceRules = TEMPLATE_DERIVED_RULES
): T {
  // The PATH pass runs even with no recorded secrets — that is the whole point
  // for an UNCHANGED resource, whose `perResourceSecrets` entry is empty
  // because it was never resolved this deploy (issue #1900).
  if (secrets.size === 0 && source === undefined) return bag;
  if (source !== undefined) {
    return redactByPath(bag, source, secrets, rules, new Set(secrets.values())) as T;
  }
  const regex = buildNeedleRegex(secrets.keys());
  // Even below the needle threshold, a NON-EMPTY whole-value match must still be
  // redacted. An empty-string secret is never a needle (it would match every
  // empty leaf and corrupt unrelated properties); a resolved secret of '' is
  // degenerate and the resolver does not record one.
  const wholeValueExpr = (s: string): string | undefined => (s === '' ? undefined : secrets.get(s));

  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') {
      const whole = wholeValueExpr(value);
      if (whole !== undefined) return whole;
      if (!regex) return value;
      regex.lastIndex = 0;
      if (!regex.test(value)) return value;
      regex.lastIndex = 0;
      return value.replace(regex, (m) => secrets.get(m) ?? SECRET_MASK);
    }
    if (Array.isArray(value)) {
      return value.map(walk);
    }
    if (value !== null && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = walk(v);
      }
      return out;
    }
    return value;
  };

  return walk(bag) as T;
}

/**
 * Redact resolved secret plaintext out of one resource state record's
 * `properties` / `attributes` / `observedProperties`, replacing each secret
 * value with its unresolved expression. Returns a NEW record when any field
 * changed, or the input by identity when there are no secrets — so callers can
 * detect a no-op cheaply. Shared by the deploy engine's save choke point and
 * the `cdkd scrub` command so both scrub the same three fields identically.
 */
export function scrubResourceRecord<
  T extends {
    properties: Record<string, unknown>;
    attributes?: Record<string, unknown>;
    observedProperties?: Record<string, unknown>;
  },
>(record: T, secrets: RecordedSecretValues, sourceProperties?: Record<string, unknown>): T {
  // NOT `sourceProperties === undefined`: an UNCHANGED resource has neither a
  // secrets map nor a template bag, and its observed bag is exactly what needs
  // redacting (issue #1900) — so an early return gated on those two alone made
  // that half dead code.
  if (secrets.size === 0 && sourceProperties === undefined && !record.observedProperties) {
    return record;
  }
  const next = { ...record };
  next.properties = redactSecretsForState(record.properties, secrets, sourceProperties);
  if (record.attributes) next.attributes = redactSecretsForState(record.attributes, secrets);
  if (record.observedProperties) {
    // `observedProperties` is a live AWS readback, so its OWN source of truth is
    // the record's (already redacted) `properties` — a member whose stored value
    // is an expression must not be overwritten by the plaintext AWS echoes back
    // (issue #1900). When a `sourceProperties` bag was supplied it is the
    // template, which is the better source; otherwise fall back to the record's
    // own properties, which is what makes an UNCHANGED resource redactable at
    // all.
    // `next.properties`, not `record.properties`: the just-redacted bag is the
    // one that actually holds expressions. On the `cdkd scrub` path the original
    // is still plaintext, so using it would degrade this to the value scan.
    // Marked `aws-readback` because this bag came from AWS — see the kind doc.
    // The RULES differ by which source we ended up with, which is the whole
    // point of them being two flags: a TEMPLATE source carries public ssm
    // expressions (so no blanket trust), while the record's own properties
    // cannot (so the #1900 no-secrets-map path works). Neither descends arrays,
    // because this bag came back from AWS.
    next.observedProperties = redactSecretsForState(
      record.observedProperties,
      secrets,
      sourceProperties ?? next.properties,
      sourceProperties === undefined
        ? STATE_SOURCED_READBACK_RULES
        : TEMPLATE_SOURCED_READBACK_RULES
    );
  }
  return next;
}

/**
 * Replace every recorded secret value inside `text` with {@link SECRET_MASK}.
 * Used on log lines and error messages where a resolved secret could otherwise
 * be echoed. Whole-value and embedded matches are both masked. Returns `text`
 * unchanged when there is nothing to mask.
 */
export function maskSecretsInText(text: string, secrets: RecordedSecretValues): string {
  if (secrets.size === 0) return text;
  // Whole-value masking first (covers below-threshold secrets that are the
  // entire string), then substring masking for the rest. An empty-string secret
  // is never matched (it would mask every empty string).
  if (text !== '' && secrets.has(text)) return SECRET_MASK;
  const regex = buildNeedleRegex(secrets.keys());
  if (!regex) return text;
  return text.replace(regex, SECRET_MASK);
}
