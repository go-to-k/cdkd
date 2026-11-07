import { isDeepStrictEqual } from 'node:util';
import type { Rule, ApplicationConfig } from '@aws-sdk/client-wafv2';

/**
 * Translate the empty-string placeholder `readCurrentState` emits for an
 * absent `Description` to `undefined` before shipping it to AWS.
 *
 * `readCurrentState` always-emits `Description: ''` on a WebACL with no
 * description (the comparator's top-level walk is state-keys-only, so
 * the placeholder is required to detect a console-side description add).
 * AWS WAFv2 `CreateWebACL` / `UpdateWebACL` reject `Description: ''`
 * with `Member must have length greater than or equal to 1` (min 1 / max
 * 256). On `cdkd drift --revert` the placeholder would round-trip
 * through `update()` and surface as a hard AWS rejection, so we sanitize
 * the wire-layer payload while keeping the read-side placeholder
 * intact. This is the Class 2 pattern from
 * `docs/provider-rules.md#readcurrentstate-for-drift-detection`.
 */
export function sanitizeDescription(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string' && value.length === 0) return undefined;
  return value as string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The two `DataProtection` booleans AWS documents as `Default: FALSE`.
 */
const DATA_PROTECTION_FALSE_DEFAULTS: readonly string[] = [
  'ExcludeRuleMatchDetails',
  'ExcludeRateBasedDetails',
];

/**
 * Re-shape an AWS `DataProtectionConfig` against the state baseline (issue
 * #2762): a `false` for one of {@link DATA_PROTECTION_FALSE_DEFAULTS} is
 * dropped when the baseline entry at the same position does not declare that
 * key, because `false` is the documented default and so equals what the
 * template left out. `DataProtections` is compared as a whole array, so
 * without this an echoed default would read as drift against a baseline that
 * holds only the template's `properties`. A `true`, or a key the baseline
 * declares, is kept, so a real change still shows. Entries are matched by
 * position, as the comparator matches them.
 */
export function toCfnDataProtectionConfig(
  config: Record<string, unknown>,
  baseline: unknown
): Record<string, unknown> {
  const entries = config['DataProtections'];
  if (!Array.isArray(entries)) return config;
  const baseEntries =
    isPlainObject(baseline) && Array.isArray(baseline['DataProtections'])
      ? (baseline['DataProtections'] as unknown[])
      : [];
  return {
    ...config,
    DataProtections: entries.map((entry, i) => {
      if (!isPlainObject(entry)) return entry;
      const base = baseEntries[i];
      const converted: Record<string, unknown> = { ...entry };
      for (const key of DATA_PROTECTION_FALSE_DEFAULTS) {
        if (converted[key] === false && !(isPlainObject(base) && key in base)) {
          delete converted[key];
        }
      }
      return converted;
    }),
  };
}

/**
 * The `ApplicationConfig` an `UpdateWebACL` carries (issue #2762).
 *
 * `UpdateWebACL` treats this one member unlike the rest of the request, which
 * replaces the web ACL whole: an OMITTED `ApplicationConfig` keeps every stored
 * entry, and an INCLUDED one must match the stored entries exactly, any change
 * being refused (`@aws-sdk/client-wafv2` `UpdateWebACLRequest.ApplicationConfig`).
 * So it is sent only when the template changed it, and then AWS's refusal of a
 * modification is the outcome, as for any update CloudFormation would send.
 * Unchanged, it is left out: AWS keeps the same value, and the update never
 * depends on the stored entries comparing equal to the template's spelling.
 * Removed from the template, it is left out too, which keeps the stored value
 * exactly as AWS documents for an omission.
 */
export function applicationConfigForUpdate(
  next: unknown,
  previous: unknown
): ApplicationConfig | undefined {
  if (next === undefined || next === null) return undefined;
  if (isDeepStrictEqual(next, previous)) return undefined;
  return next as ApplicationConfig;
}

/**
 * Convert a CFn `ByteMatchStatement` into the SDK shape.
 *
 * `SearchStringBase64` exists ONLY in CloudFormation — the SDK models
 * carry a single `SearchString: Uint8Array | undefined` blob member
 * (`@aws-sdk/client-wafv2/dist-types/models/models_0.d.ts:1034`).
 * Forwarding the CFn blob raw made the serializer drop the unknown key
 * and `CreateWebACL` then failed validation on the missing required
 * `SearchString` (issue #1389).
 *
 * The decoded bytes are passed as a `Uint8Array`, matching the declared
 * member type: the JSON serializer base64-encodes a blob member on the
 * wire, so decoding here reproduces byte-for-byte what CloudFormation
 * sends. Plain `SearchString` values are deliberately left untouched —
 * the same serializer accepts a string at a blob member and UTF-8 +
 * base64 encodes it, which is exactly the existing (working) behavior.
 *
 * Precedence when a template carries BOTH keys: `SearchStringBase64`
 * wins. CloudFormation treats them as mutually exclusive and rejects
 * such a template, so any choice is arbitrary; the explicit-encoding
 * form is preferred because it is the only one that can express
 * non-UTF-8 bytes, so honoring it never loses information.
 */
function toSdkByteMatchStatement(
  byteMatchStatement: Record<string, unknown>
): Record<string, unknown> {
  const encoded = byteMatchStatement['SearchStringBase64'];
  if (typeof encoded !== 'string') return byteMatchStatement;

  const converted: Record<string, unknown> = { ...byteMatchStatement };
  delete converted['SearchStringBase64'];
  converted['SearchString'] = Uint8Array.from(Buffer.from(encoded, 'base64'));
  return converted;
}

/**
 * CFn `Statement` members that carry a reference ARN.
 *
 * CloudFormation spells the member `Arn`; every one of these SDK types
 * declares it `ARN` (and marks it REQUIRED) — verified against
 * `@aws-sdk/client-wafv2` `models_0.d.ts` (`IPSetReferenceStatement` /
 * `RegexPatternSetReferenceStatement` / `RuleGroupReferenceStatement`),
 * whose schema serde carries a single `_ARN = "ARN"` alias and no `Arn`.
 * The serializer drops the CFn spelling, so `CreateWebACL` fails
 * validation on the missing required `ARN` — the same silent-drop class
 * as `SearchStringBase64`, and the only other one in the whole `Rules`
 * tree (all 154 CFn keys were diffed against the SDK member set).
 */
const ARN_REFERENCE_STATEMENT_KEYS: readonly string[] = [
  'IPSetReferenceStatement',
  'RegexPatternSetReferenceStatement',
  'RuleGroupReferenceStatement',
];

/**
 * Recursively convert a CFn `Statement` tree into the SDK shape.
 *
 * Two conversions ride this walk: the `ByteMatchStatement`
 * `SearchStringBase64` decode and the reference-statement `Arn` -> `ARN`
 * rename (see {@link ARN_REFERENCE_STATEMENT_KEYS}). Both leaves are
 * nestable, so the walk has to cover every recursion point the SDK
 * `Statement` union declares:
 *   - `NotStatement.Statement`            (single nested Statement)
 *   - `AndStatement.Statements[]`         (Statement array)
 *   - `OrStatement.Statements[]`          (Statement array)
 *   - `RateBasedStatement.ScopeDownStatement`
 *   - `ManagedRuleGroupStatement.ScopeDownStatement`
 *
 * That list mirrors the SDK model exactly — those are the only members
 * typed `Statement` / `Statement[]`. `RuleGroupReferenceStatement` is
 * NOT a recursion point (it declares no nested statement member, only
 * `ARN` / `ExcludedRules` / `RuleActionOverrides`); it appears in the
 * ARN list above for the rename alone. Extend either list if AWS adds a
 * member.
 *
 * The caller's object is never mutated — every level is rebuilt.
 */
function toSdkStatement(statement: Record<string, unknown>): Record<string, unknown> {
  const converted: Record<string, unknown> = { ...statement };

  const byteMatchStatement = converted['ByteMatchStatement'];
  if (isPlainObject(byteMatchStatement)) {
    converted['ByteMatchStatement'] = toSdkByteMatchStatement(byteMatchStatement);
  }

  for (const key of ARN_REFERENCE_STATEMENT_KEYS) {
    const reference = converted[key];
    if (!isPlainObject(reference) || !('Arn' in reference)) continue;
    const { Arn: arn, ...rest } = reference;
    converted[key] = { ...rest, ARN: arn };
  }

  const notStatement = converted['NotStatement'];
  if (isPlainObject(notStatement)) {
    const nested = notStatement['Statement'];
    if (isPlainObject(nested)) {
      converted['NotStatement'] = { ...notStatement, Statement: toSdkStatement(nested) };
    }
  }

  for (const key of ['AndStatement', 'OrStatement']) {
    const combined = converted[key];
    if (!isPlainObject(combined)) continue;
    const nested = combined['Statements'];
    if (!Array.isArray(nested)) continue;
    converted[key] = {
      ...combined,
      Statements: nested.map((item) => (isPlainObject(item) ? toSdkStatement(item) : item)),
    };
  }

  for (const key of ['RateBasedStatement', 'ManagedRuleGroupStatement']) {
    const scoping = converted[key];
    if (!isPlainObject(scoping)) continue;
    const nested = scoping['ScopeDownStatement'];
    if (!isPlainObject(nested)) continue;
    converted[key] = { ...scoping, ScopeDownStatement: toSdkStatement(nested) };
  }

  return converted;
}

/**
 * Convert the CFn `Rules` blob into the SDK `Rule[]` shape.
 *
 * Falsy input degrades to `[]`, matching the previous
 * `(properties['Rules'] as Rule[]) || []` behavior exactly. A truthy NON-array
 * (an unresolved intrinsic) is deliberately passed through instead:
 * defaulting it to `[]` would make `update()` a silent `UpdateWebACL`
 * that wipes every rule and still reports success, where the old code
 * handed the value to the SDK and failed loudly.
 */
export function toSdkRules(rules: unknown): Rule[] {
  // Falsy (absent / null / '' / 0 / false) degrades to `[]` for EXACT parity
  // with the previous `(properties['Rules'] as Rule[]) || []`. Only a TRUTHY
  // non-array passes through.
  if (!rules) return [];
  if (!Array.isArray(rules)) return rules as unknown as Rule[];
  return rules.map((rule) => {
    if (!isPlainObject(rule)) return rule as unknown as Rule;
    const statement = rule['Statement'];
    if (!isPlainObject(statement)) return rule as unknown as Rule;
    return { ...rule, Statement: toSdkStatement(statement) } as unknown as Rule;
  });
}

/**
 * Inverse of {@link toSdkByteMatchStatement}.
 *
 * `GetWebACL` returns `SearchString` as the SDK blob type (a `Uint8Array`),
 * but the template — and therefore cdkd state — carries EITHER a plain
 * `SearchString` string OR a `SearchStringBase64` string. The bytes are
 * identical for both spellings, so the AWS value alone cannot say which
 * one to emit: only the BASELINE can. That is why every function on this
 * side takes the corresponding state node alongside the AWS node.
 *
 * Whenever the baseline string RE-ENCODES to exactly the AWS bytes, it is
 * emitted VERBATIM rather than re-derived. That is what keeps two otherwise
 * permanent false positives from appearing:
 *
 *   - a non-canonical `SearchStringBase64` (whitespace / newlines, missing
 *     padding, base64url) would never equal a canonically re-encoded string,
 *     so the WebACL would drift forever;
 *   - `Buffer.toString('utf8')` is LOSSY for non-UTF-8 bytes (U+FFFD), so a
 *     binary needle under a plain-`SearchString` baseline would both drift
 *     and — via `drift --accept`, which writes the AWS value into
 *     `observedProperties`, then `--revert` — push a mangled needle to AWS.
 *
 * When the bytes genuinely differ from the baseline (REAL drift) or no usable
 * baseline exists, the value is derived: base64 if the baseline used base64,
 * otherwise plain UTF-8 but ONLY when that round-trips losslessly, falling
 * back to base64 so binary content is never corrupted.
 */
function toCfnByteMatchStatement(
  byteMatchStatement: Record<string, unknown>,
  baseline: unknown
): Record<string, unknown> {
  const raw = byteMatchStatement['SearchString'];
  if (raw === undefined) return byteMatchStatement;

  const bytes =
    raw instanceof Uint8Array
      ? Buffer.from(raw)
      : typeof raw === 'string'
        ? Buffer.from(raw, 'utf8')
        : undefined;
  if (!bytes) return byteMatchStatement;

  const base = isPlainObject(baseline) ? baseline : undefined;
  const baseEncoded = base?.['SearchStringBase64'];
  const basePlain = base?.['SearchString'];

  const converted: Record<string, unknown> = { ...byteMatchStatement };
  delete converted['SearchString'];
  delete converted['SearchStringBase64'];

  // Undrifted: hand back the baseline's own string, byte-for-byte.
  if (typeof baseEncoded === 'string' && Buffer.from(baseEncoded, 'base64').equals(bytes)) {
    converted['SearchStringBase64'] = baseEncoded;
    return converted;
  }
  if (typeof basePlain === 'string' && Buffer.from(basePlain, 'utf8').equals(bytes)) {
    converted['SearchString'] = basePlain;
    return converted;
  }

  // Real drift, or no baseline to follow.
  if (typeof baseEncoded === 'string') {
    converted['SearchStringBase64'] = bytes.toString('base64');
    return converted;
  }
  const utf8 = bytes.toString('utf8');
  if (Buffer.from(utf8, 'utf8').equals(bytes)) {
    converted['SearchString'] = utf8;
  } else {
    converted['SearchStringBase64'] = bytes.toString('base64');
  }
  return converted;
}

/**
 * Inverse of {@link toSdkStatement}: re-shape an AWS-returned `Statement`
 * tree back into the CFn spelling, walking the state baseline in lockstep
 * so the per-`ByteMatchStatement` spelling choice is baseline-driven.
 *
 * Recursion points are IDENTICAL to the forward walk by construction — if
 * one gains a member, so must the other, or drift silently reappears at
 * the new nesting depth. When the baseline diverges structurally (a real
 * drift, or a rule added console-side) the walk simply passes `undefined`
 * down and the defaults apply; the resulting difference is exactly the
 * drift the user should see.
 */
function toCfnStatement(
  statement: Record<string, unknown>,
  baseline: unknown
): Record<string, unknown> {
  const converted: Record<string, unknown> = { ...statement };
  const base = isPlainObject(baseline) ? baseline : undefined;

  const byteMatchStatement = converted['ByteMatchStatement'];
  if (isPlainObject(byteMatchStatement)) {
    converted['ByteMatchStatement'] = toCfnByteMatchStatement(
      byteMatchStatement,
      base?.['ByteMatchStatement']
    );
  }

  // CFn spells the reference ARN `Arn`; AWS returns `ARN`. Unconditional —
  // unlike the search string there is no ambiguity about the CFn spelling.
  for (const key of ARN_REFERENCE_STATEMENT_KEYS) {
    const reference = converted[key];
    if (!isPlainObject(reference) || !('ARN' in reference)) continue;
    const { ARN: arn, ...rest } = reference;
    converted[key] = { ...rest, Arn: arn };
  }

  const notStatement = converted['NotStatement'];
  if (isPlainObject(notStatement)) {
    const nested = notStatement['Statement'];
    if (isPlainObject(nested)) {
      const baseNot = base?.['NotStatement'];
      converted['NotStatement'] = {
        ...notStatement,
        Statement: toCfnStatement(
          nested,
          isPlainObject(baseNot) ? baseNot['Statement'] : undefined
        ),
      };
    }
  }

  for (const key of ['AndStatement', 'OrStatement']) {
    const combined = converted[key];
    if (!isPlainObject(combined)) continue;
    const nested = combined['Statements'];
    if (!Array.isArray(nested)) continue;
    const baseCombined = base?.[key];
    const baseList =
      isPlainObject(baseCombined) && Array.isArray(baseCombined['Statements'])
        ? (baseCombined['Statements'] as unknown[])
        : undefined;
    converted[key] = {
      ...combined,
      Statements: nested.map((item, i) =>
        isPlainObject(item) ? toCfnStatement(item, baseList?.[i]) : item
      ),
    };
  }

  for (const key of ['RateBasedStatement', 'ManagedRuleGroupStatement']) {
    const scoping = converted[key];
    if (!isPlainObject(scoping)) continue;
    const nested = scoping['ScopeDownStatement'];
    if (!isPlainObject(nested)) continue;
    const baseScoping = base?.[key];
    converted[key] = {
      ...scoping,
      ScopeDownStatement: toCfnStatement(
        nested,
        isPlainObject(baseScoping) ? baseScoping['ScopeDownStatement'] : undefined
      ),
    };
  }

  return converted;
}

/**
 * Inverse of {@link toSdkRules}: re-shape the AWS `Rules` array back into
 * the CFn spelling so `cdkd drift` compares like with like.
 *
 * Without this every WebACL carrying a `ByteMatchStatement` or a reference
 * statement reported permanent phantom drift, because `drift-calculator`
 * compares `Rules` wholesale via `deepEqual` (issue #1403).
 *
 * Rules are matched to the baseline POSITIONALLY, which is what the
 * comparator itself does — a reordered or console-added rule therefore
 * still surfaces as drift, correctly.
 */
export function toCfnRules(rules: unknown, baselineRules: unknown): unknown[] {
  // `GetWebACL` always returns an array (or nothing), so unlike the forward
  // walk there is no unresolved-intrinsic case to pass through here.
  if (!Array.isArray(rules)) return [];
  const baseList = Array.isArray(baselineRules) ? (baselineRules as unknown[]) : undefined;
  return rules.map((rule, i) => {
    // A non-object entry is not a rule cdkd can re-shape; hand it back
    // untouched rather than casting a lie onto it.
    if (!isPlainObject(rule)) return rule;
    const statement = rule['Statement'];
    if (!isPlainObject(statement)) return rule;
    const baseRule = baseList?.[i];
    return {
      ...rule,
      Statement: toCfnStatement(
        statement,
        isPlainObject(baseRule) ? baseRule['Statement'] : undefined
      ),
    };
  });
}
