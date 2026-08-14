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

/** Does this string carry a dynamic reference cdkd would have resolved? */
function carriesDynamicReference(value: unknown): value is string {
  return typeof value === 'string' && value.includes('{{resolve:');
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
function redactByPath(bag: unknown, source: unknown, secrets: RecordedSecretValues): unknown {
  if (carriesDynamicReference(source) && typeof bag === 'string') {
    // The source leaf IS what state should hold — exact, and immune to two
    // expressions sharing one resolved value.
    return source;
  }
  if (Array.isArray(bag) && Array.isArray(source) && bag.length === source.length) {
    return bag.map((item, i) => redactByPath(item, source[i], secrets));
  }
  if (isPlainObject(bag) && isPlainObject(source)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(bag)) {
      out[k] =
        k in source ? redactByPath(v, source[k], secrets) : redactSecretsForState(v, secrets);
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
  source?: unknown
): T {
  // The PATH pass runs even with no recorded secrets — that is the whole point
  // for an UNCHANGED resource, whose `perResourceSecrets` entry is empty
  // because it was never resolved this deploy (issue #1900).
  if (secrets.size === 0 && source === undefined) return bag;
  if (source !== undefined) return redactByPath(bag, source, secrets) as T;
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
  if (secrets.size === 0 && sourceProperties === undefined) return record;
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
    next.observedProperties = redactSecretsForState(
      record.observedProperties,
      secrets,
      sourceProperties ?? record.properties
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
