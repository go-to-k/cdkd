import {
  WAFV2Client,
  CreateWebACLCommand,
  UpdateWebACLCommand,
  DeleteWebACLCommand,
  GetWebACLCommand,
  ListTagsForResourceCommand,
  TagResourceCommand,
  UntagResourceCommand,
  WAFNonexistentItemException,
  type Tag,
  type Rule,
  type DefaultAction,
  type VisibilityConfig,
  type Scope,
  type CaptchaConfig,
  type ChallengeConfig,
  type CustomResponseBody,
  type AssociationConfig,
} from '@aws-sdk/client-wafv2';
import { getLogger } from '../../utils/logger.js';
import { replayWarn, requireConfigString } from '../config-shape.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import { generateResourceName } from '../resource-name.js';
import { normalizeAwsTagsToCfn } from '../import-helpers.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
  CreateContext,
} from '../../types/resource.js';

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
 * `docs/provider-development.md § 3b`.
 */
function sanitizeDescription(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string' && value.length === 0) return undefined;
  return value as string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * CFn `Rules` members that have NO counterpart in the installed
 * `@aws-sdk/client-wafv2` model (verified: zero hits in
 * `dist-types/models/models_0.d.ts`).
 *
 * The AWS SDK v3 serializer drops unknown members, so these silently do
 * not reach AWS no matter what cdkd forwards. There is no mapping cdkd
 * can invent — the fix is an SDK bump, after which the spellings already
 * match and no code here has to change. Until then the drop is made LOUD
 * (`warnOnSdkUnsupportedRuleKeys`) instead of silent.
 *
 * They cannot be declared in `unhandledByDesign` either: that map is
 * TOP-LEVEL CFn property granularity, and all three are nested inside
 * `Rules`, which the provider genuinely handles.
 */
const SDK_UNSUPPORTED_RULE_KEYS: readonly string[] = [
  // TextTransformation.PreParseTextTransformations
  'PreParseTextTransformations',
  // Rule action Monetize / its PriceMultiplier
  'Monetize',
  'PriceMultiplier',
];

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
function toSdkRules(rules: unknown): Rule[] {
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
function toCfnRules(rules: unknown, baselineRules: unknown): unknown[] {
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

/**
 * Collect every {@link SDK_UNSUPPORTED_RULE_KEYS} member present anywhere
 * in the CFn `Rules` blob, so the caller can report the silent drop.
 */
function collectSdkUnsupportedRuleKeys(value: unknown, found: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectSdkUnsupportedRuleKeys(item, found);
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, nested] of Object.entries(value)) {
    if (SDK_UNSUPPORTED_RULE_KEYS.includes(key)) found.add(key);
    collectSdkUnsupportedRuleKeys(nested, found);
  }
}

/**
 * Parse WAFv2 WebACL ARN to extract Id, Name, and Scope.
 *
 * ARN format:
 *   arn:aws:wafv2:{region}:{account}:regional/webacl/{name}/{id}
 *   arn:aws:wafv2:{region}:{account}:global/webacl/{name}/{id}
 *
 * A short / malformed ARN yields `undefined` for `name` / `id` (the path
 * segments simply are not there) — callers must guard. `scope` is always
 * defined (anything not `global` maps to `REGIONAL`).
 */
export function parseWebACLArn(arn: string): {
  id: string | undefined;
  name: string | undefined;
  scope: Scope;
} {
  // Example: arn:aws:wafv2:us-east-1:123456789012:regional/webacl/my-acl/abc-123
  const parts = arn.split(':');
  // parts[5] = "regional/webacl/my-acl/abc-123" or "global/webacl/my-acl/abc-123"
  const resourcePart = parts.slice(5).join(':');
  const segments = resourcePart.split('/');
  // segments: ["regional", "webacl", "my-acl", "abc-123"]
  const scopeRaw = segments[0]; // "regional" or "global"
  const name = segments[2];
  const id = segments[3];

  const scope: Scope = scopeRaw === 'global' ? 'CLOUDFRONT' : 'REGIONAL';

  return { id, name, scope };
}

/**
 * AWS WAFv2 WebACL Provider
 *
 * Implements resource provisioning for AWS::WAFv2::WebACL using the WAFv2 SDK.
 * WHY: WAFv2 CreateWebACL is synchronous - the CC API adds unnecessary polling
 * overhead for an operation that completes immediately.
 * This SDK provider eliminates that polling and returns instantly.
 */
export class WAFv2WebACLProvider implements ResourceProvider {
  private wafv2Client?: WAFV2Client;
  private readonly providerRegion = process.env['AWS_REGION'];
  private logger = getLogger().child('WAFv2WebACLProvider');

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::WAFv2::WebACL',
      new Set([
        'Name',
        'Scope',
        'Tags',
        'DefaultAction',
        'Description',
        'Rules',
        'VisibilityConfig',
        'CustomResponseBodies',
        'CaptchaConfig',
        'ChallengeConfig',
        'TokenDomains',
        'AssociationConfig',
      ]),
    ],
  ]);

  private getClient(): WAFV2Client {
    if (!this.wafv2Client) {
      this.wafv2Client = new WAFV2Client(
        this.providerRegion ? { region: this.providerRegion } : {}
      );
    }
    return this.wafv2Client;
  }

  /**
   * Create a WAFv2 WebACL
   */
  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating WAFv2 WebACL ${logicalId}`);

    const name =
      (properties['Name'] as string | undefined) ||
      generateResourceName(logicalId, { maxLength: 128 });
    // `replayWarn`: the rollback executor's reverse-replacement arm revives
    // the OLD resource from `previousState.properties`, which the user cannot
    // edit from the template — a hard refusal there would leave the resource
    // unrestorable (issue #1544). Template-path creates keep the refusal.
    const scope = requireConfigString(
      properties['Scope'],
      'REGIONAL',
      'AWS::WAFv2::WebACL Scope',
      replayWarn(this.logger, context)
    ) as Scope;

    this.warnOnSdkUnsupportedRuleKeys(logicalId, properties['Rules']);

    try {
      // Build tags
      const tags: Tag[] = [];
      if (properties['Tags']) {
        const tagList = properties['Tags'] as Array<{ Key: string; Value: string }>;
        for (const tag of tagList) {
          tags.push({ Key: tag.Key, Value: tag.Value });
        }
      }

      const response = await this.getClient().send(
        new CreateWebACLCommand({
          Name: name,
          Scope: scope,
          DefaultAction: properties['DefaultAction'] as DefaultAction,
          Description: sanitizeDescription(properties['Description']),
          Rules: toSdkRules(properties['Rules']),
          VisibilityConfig: properties['VisibilityConfig'] as VisibilityConfig,
          ...(tags.length > 0 && { Tags: tags }),
          CustomResponseBodies: properties['CustomResponseBodies'] as
            | Record<string, CustomResponseBody>
            | undefined,
          CaptchaConfig: properties['CaptchaConfig'] as CaptchaConfig | undefined,
          ChallengeConfig: properties['ChallengeConfig'] as ChallengeConfig | undefined,
          TokenDomains: properties['TokenDomains'] as string[] | undefined,
          AssociationConfig: properties['AssociationConfig'] as AssociationConfig | undefined,
        })
      );

      const summary = response.Summary;
      if (!summary?.ARN || !summary?.Id) {
        throw new Error('CreateWebACL did not return Summary with ARN and Id');
      }

      this.logger.debug(`Successfully created WAFv2 WebACL ${logicalId}: ${summary.ARN}`);

      return {
        physicalId: summary.ARN,
        attributes: {
          Arn: summary.ARN,
          Id: summary.Id,
          LabelNamespace: (summary as Record<string, unknown>)['LabelNamespace'],
        },
      };
    } catch (error) {
      if (error instanceof ProvisioningError) throw error;
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create WAFv2 WebACL ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
      );
    }
  }

  /**
   * Update a WAFv2 WebACL
   *
   * Name and Scope are immutable - changes to those require replacement.
   * UpdateWebACL requires LockToken obtained from GetWebACL.
   */
  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating WAFv2 WebACL ${logicalId}: ${physicalId}`);

    this.warnOnSdkUnsupportedRuleKeys(logicalId, properties['Rules']);

    try {
      const { id, name, scope } = parseWebACLArn(physicalId);

      // Get current WebACL to obtain LockToken
      const getResponse = await this.getClient().send(
        new GetWebACLCommand({
          Name: name,
          Scope: scope,
          Id: id,
        })
      );

      const lockToken = getResponse.LockToken;
      if (!lockToken) {
        throw new Error('GetWebACL did not return LockToken');
      }

      await this.getClient().send(
        new UpdateWebACLCommand({
          Name: name,
          Scope: scope,
          Id: id,
          LockToken: lockToken,
          DefaultAction: properties['DefaultAction'] as DefaultAction,
          Description: sanitizeDescription(properties['Description']),
          Rules: toSdkRules(properties['Rules']),
          VisibilityConfig: properties['VisibilityConfig'] as VisibilityConfig,
          CustomResponseBodies: properties['CustomResponseBodies'] as
            | Record<string, CustomResponseBody>
            | undefined,
          CaptchaConfig: properties['CaptchaConfig'] as CaptchaConfig | undefined,
          ChallengeConfig: properties['ChallengeConfig'] as ChallengeConfig | undefined,
          TokenDomains: properties['TokenDomains'] as string[] | undefined,
          AssociationConfig: properties['AssociationConfig'] as AssociationConfig | undefined,
        })
      );

      // Apply tag diff. WAFv2 uses TagResource / UntagResource keyed by
      // ResourceARN (the physicalId is the WebACL ARN).
      await this.applyTagDiff(
        physicalId,
        previousProperties['Tags'] as Array<{ Key?: string; Value?: string }> | undefined,
        properties['Tags'] as Array<{ Key?: string; Value?: string }> | undefined
      );

      this.logger.debug(`Successfully updated WAFv2 WebACL ${logicalId}`);

      return {
        physicalId,
        wasReplaced: false,
        attributes: {
          Arn: physicalId,
          Id: id,
          LabelNamespace: getResponse.WebACL?.LabelNamespace,
        },
      };
    } catch (error) {
      if (error instanceof ProvisioningError) throw error;
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update WAFv2 WebACL ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Delete a WAFv2 WebACL
   *
   * DeleteWebACL requires LockToken obtained from GetWebACL.
   * WAFNonexistentItemException is treated as success (idempotent delete).
   */
  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting WAFv2 WebACL ${logicalId}: ${physicalId}`);

    try {
      const { id, name, scope } = parseWebACLArn(physicalId);

      // Get LockToken
      const getResponse = await this.getClient().send(
        new GetWebACLCommand({
          Name: name,
          Scope: scope,
          Id: id,
        })
      );

      const lockToken = getResponse.LockToken;
      if (!lockToken) {
        throw new Error('GetWebACL did not return LockToken');
      }

      await this.getClient().send(
        new DeleteWebACLCommand({
          Name: name,
          Scope: scope,
          Id: id,
          LockToken: lockToken,
        })
      );

      this.logger.debug(`Successfully deleted WAFv2 WebACL ${logicalId}`);
    } catch (error) {
      if (error instanceof WAFNonexistentItemException) {
        const clientRegion = await this.getClient().config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`WAFv2 WebACL ${physicalId} does not exist, skipping deletion`);
        return;
      }

      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete WAFv2 WebACL ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Report every CFn `Rules` member the installed `@aws-sdk/client-wafv2`
   * model has no counterpart for, so the drop is visible instead of
   * silent. See {@link SDK_UNSUPPORTED_RULE_KEYS} for why cdkd cannot map
   * them and what makes them work (an SDK bump).
   */
  private warnOnSdkUnsupportedRuleKeys(logicalId: string, rules: unknown): void {
    const found = new Set<string>();
    collectSdkUnsupportedRuleKeys(rules, found);
    if (found.size === 0) return;

    const sorted = [...found].sort();
    const names = sorted.join(', ');
    const subject = sorted.length === 1 ? 'property' : 'properties';
    const verb = sorted.length === 1 ? 'has' : 'have';
    this.logger.warn(
      `WAFv2 WebACL ${logicalId}: rule ${subject} ${names} ${verb} no member in the installed AWS SDK WAFv2 model and will NOT be sent to AWS. Upgrade cdkd once its @aws-sdk/client-wafv2 dependency carries the ${subject}.`
    );
  }

  /**
   * Apply a diff between old and new CFn-shape Tags arrays via WAFv2's
   * `TagResource` / `UntagResource` APIs (keyed by `ResourceARN`).
   */
  private async applyTagDiff(
    arn: string,
    oldTagsRaw: Array<{ Key?: string; Value?: string }> | undefined,
    newTagsRaw: Array<{ Key?: string; Value?: string }> | undefined
  ): Promise<void> {
    const toMap = (
      tags: Array<{ Key?: string; Value?: string }> | undefined
    ): Map<string, string> => {
      const m = new Map<string, string>();
      for (const t of tags ?? []) {
        if (t.Key !== undefined && t.Value !== undefined) m.set(t.Key, t.Value);
      }
      return m;
    };

    const oldMap = toMap(oldTagsRaw);
    const newMap = toMap(newTagsRaw);

    const tagsToAdd: Tag[] = [];
    for (const [k, v] of newMap) {
      if (oldMap.get(k) !== v) tagsToAdd.push({ Key: k, Value: v });
    }
    const tagsToRemove: string[] = [];
    for (const k of oldMap.keys()) {
      if (!newMap.has(k)) tagsToRemove.push(k);
    }

    if (tagsToRemove.length > 0) {
      await this.getClient().send(
        new UntagResourceCommand({ ResourceARN: arn, TagKeys: tagsToRemove })
      );
      this.logger.debug(`Removed ${tagsToRemove.length} tag(s) from WAFv2 WebACL ${arn}`);
    }
    if (tagsToAdd.length > 0) {
      await this.getClient().send(new TagResourceCommand({ ResourceARN: arn, Tags: tagsToAdd }));
      this.logger.debug(`Added/updated ${tagsToAdd.length} tag(s) on WAFv2 WebACL ${arn}`);
    }
  }

  /**
   * Read the AWS-current WAFv2 WebACL configuration in CFn-property shape.
   *
   * The cdkd physicalId is the WebACL ARN; we parse it back to
   * `(id, name, scope)` and call `GetWebACL`. The response holds Name,
   * Description, DefaultAction, Rules, VisibilityConfig,
   * CustomResponseBodies, CaptchaConfig, ChallengeConfig, TokenDomains,
   * and AssociationConfig — every key cdkd state declares as
   * `handledProperties`. `Scope` is recovered from the ARN parse.
   *
   * Tags are surfaced via a follow-up `ListTagsForResource(ResourceARN)`
   * call. CDK's `aws:*` auto-tags are filtered out and the result key is
   * omitted when AWS reports no user tags. Returns `undefined`
   * when the ARN can't be parsed or the WebACL is gone
   * (`WAFNonexistentItemException`).
   */
  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    _resourceType: string,
    // The state-recorded baseline. Load-bearing, not decoration: the AWS
    // `Rules` blob cannot say whether the template spelled a byte-match
    // needle `SearchString` or `SearchStringBase64` (identical bytes), so
    // the reverse mapping is baseline-driven. See {@link toCfnRules}.
    properties?: Record<string, unknown>
  ): Promise<Record<string, unknown> | undefined> {
    const { id, name, scope } = parseWebACLArn(physicalId);
    if (!id || !name) return undefined;

    let webACL;
    try {
      const resp = await this.getClient().send(
        new GetWebACLCommand({ Id: id, Name: name, Scope: scope })
      );
      webACL = resp.WebACL;
    } catch (err) {
      if (err instanceof WAFNonexistentItemException) return undefined;
      throw err;
    }
    if (!webACL) return undefined;

    const result: Record<string, unknown> = {};
    if (webACL.Name !== undefined) result['Name'] = webACL.Name;
    result['Scope'] = scope;
    result['Description'] = webACL.Description ?? '';
    if (webACL.DefaultAction) {
      result['DefaultAction'] = webACL.DefaultAction as unknown as Record<string, unknown>;
    }
    result['Rules'] = toCfnRules(webACL.Rules ?? [], properties?.['Rules']);
    if (webACL.VisibilityConfig) {
      result['VisibilityConfig'] = webACL.VisibilityConfig as unknown as Record<string, unknown>;
    }
    result['CustomResponseBodies'] = (webACL.CustomResponseBodies ?? {}) as Record<string, unknown>;
    if (webACL.CaptchaConfig) {
      result['CaptchaConfig'] = webACL.CaptchaConfig as unknown as Record<string, unknown>;
    }
    if (webACL.ChallengeConfig) {
      result['ChallengeConfig'] = webACL.ChallengeConfig as unknown as Record<string, unknown>;
    }
    result['TokenDomains'] = webACL.TokenDomains ? [...webACL.TokenDomains] : [];
    if (webACL.AssociationConfig) {
      result['AssociationConfig'] = webACL.AssociationConfig as unknown as Record<string, unknown>;
    }

    // Tags via ListTagsForResource (the WebACL ARN is the physicalId).
    try {
      const tagsResp = await this.getClient().send(
        new ListTagsForResourceCommand({ ResourceARN: physicalId })
      );
      const tags = normalizeAwsTagsToCfn(tagsResp.TagInfoForResource?.TagList);
      result['Tags'] = tags;
    } catch (err) {
      this.logger.debug(
        `WAFv2 ListTagsForResource(${physicalId}) failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    return result;
  }

  /**
   * Adopt an existing WAFv2 WebACL into cdkd state.
   *
   * Lookup order:
   *  1. `--resource <id>=<arn>` override → verify with `GetWebACL` (parses
   *     Name/Id/Scope back out of the ARN).
   */
  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    if (input.knownPhysicalId) {
      try {
        const { id, name, scope } = parseWebACLArn(input.knownPhysicalId);
        await this.getClient().send(new GetWebACLCommand({ Id: id, Name: name, Scope: scope }));
        return { physicalId: input.knownPhysicalId, attributes: {} };
      } catch (err) {
        if (err instanceof WAFNonexistentItemException) return null;
        throw err;
      }
    }

    // No `aws:cdk:path` tag walk: AWS rejects `aws:`-prefixed tag writes, so
    // that tag never exists on a real resource and the walk could not match
    // (issue #1134). Auto-mode import resolves ids from CloudFormation's
    // DescribeStackResources or the template's physical-name property; a WebACL
    // reaching here needs an explicit `--resource <id>=<arn>` override.
    return null;
  }
}
