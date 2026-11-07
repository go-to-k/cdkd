/**
 * Provisioning-route flags: `--allow-unsupported-types`, `--prefer-sdk-route`
 * (and its deprecated `--allow-unsupported-properties` alias),
 * `--recreate-via-cc-api`, `--pin-cc-api` and `--recreate-via-sdk-provider`.
 * Split out of `../options.ts`, which re-exports the public names.
 */
import { Option } from 'commander';

/**
 * Escape hatch for the pre-flight unsupported-type rejection. Comma-separated
 * (and repeatable) resource types that cdkd will attempt via Cloud Control
 * even though it reports them unsupported (AWS NON_PROVISIONABLE). Shared by
 * `cdkd deploy` and `cdkd destroy` so a stack deployed with the flag can also
 * be destroyed. Per-type (not blanket) so the user explicitly names each type.
 *
 * Format-checks each token against the CFn resource-type shape
 * (`Namespace::Service::Type` / `Custom::Foo`) so a typo like
 * `--allow-unsupported-types AWS::AppMash::Mesh` aborts at parse time
 * instead of silently being added to the allowlist with no effect.
 */
const RESOURCE_TYPE_FORMAT = /^[A-Z][A-Za-z0-9]+(::[A-Z][A-Za-z0-9]+)+$/;

export function parseAllowUnsupportedTypesToken(
  value: string,
  previous: string[] | undefined
): string[] {
  const parsed = value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const token of parsed) {
    if (!RESOURCE_TYPE_FORMAT.test(token)) {
      throw new Error(
        `Invalid --allow-unsupported-types value "${token}": expected a CloudFormation resource type like AWS::Service::Type or Custom::Foo.`
      );
    }
  }
  return [...(previous ?? []), ...parsed];
}

export const allowUnsupportedTypesOption = new Option(
  '--allow-unsupported-types <types>',
  'Comma-separated resource types to attempt via Cloud Control even though cdkd reports ' +
    'them unsupported (AWS NON_PROVISIONABLE). Escape hatch — Cloud Control will likely ' +
    'still fail. Example: --allow-unsupported-types AWS::Foo::Bar,AWS::Baz::Qux'
).argParser(parseAllowUnsupportedTypesToken);

/**
 * Escape hatch for the property-level SDK-unwired pre-flight reject.
 * Comma-separated (and repeatable) `<ResourceType>:<PropertyName>` tokens
 * the user explicitly accepts as left unwritten at deploy time. Per
 * type+property pair (not blanket) so each SDK-unwired property is acknowledged
 * by name.
 *
 * Format-checks each token against `<Namespace>::<Service>::<Type>:<Prop>`
 * with both halves PascalCase, so a typo aborts at parse time instead of
 * being silently added to the allowlist with no effect.
 *
 * The check is Tier-1-only by design (Cloud Control forwards every property
 * to AWS, so there is nothing left unwritten for Tier 2 / Custom). A
 * `Custom::Foo:Bar` token is therefore always a user mistake — it would be
 * added to the allowlist but never consulted at runtime. Reject it at parse
 * time so the user sees the error immediately.
 */
const RESOURCE_PROPERTY_FORMAT = /^[A-Z][A-Za-z0-9]+(::[A-Z][A-Za-z0-9]+)+:[A-Z][A-Za-z0-9]*$/;

/**
 * The flag the errors below name themselves after.
 *
 * Both spellings share one parser, so the message has to say which one the user
 * typed — quoting the canonical name at someone who typed the deprecated alias
 * sends them looking for a flag they did not use.
 */
function parseRouteEntries(value: string, previous: string[] | undefined, flag: string): string[] {
  const parsed = value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const token of parsed) {
    if (!RESOURCE_PROPERTY_FORMAT.test(token)) {
      throw new Error(
        `Invalid ${flag} value "${token}": expected ` +
          `<ResourceType>:<PropertyName> with PascalCase on both halves ` +
          `(e.g. AWS::ApiGatewayV2::Api:Body).`
      );
    }
    if (token.startsWith('Custom::')) {
      throw new Error(
        `Invalid ${flag} value "${token}": Custom:: ` +
          `resources are routed through cfn-response and have no SDK-unwired ` +
          `properties at cdkd, so the flag would have no effect. Use ` +
          `--allow-unsupported-types for type-level escape hatches instead.`
      );
    }
  }
  return [...(previous ?? []), ...parsed];
}

export function parsePreferSdkRouteToken(value: string, previous: string[] | undefined): string[] {
  return parseRouteEntries(value, previous, '--prefer-sdk-route');
}

/**
 * Whether the deprecated alias has already warned this process.
 *
 * Commander calls the parser ONCE PER OCCURRENCE, and this flag is repeatable —
 * so without this a user passing it three times gets the deprecation notice
 * three times, which reads as three separate problems.
 */
let deprecatedAliasWarned = false;

/** Reset between tests; the warning is per-process, not per-parse. */
export function resetDeprecatedAliasWarning(): void {
  deprecatedAliasWarned = false;
}

export function parseAllowUnsupportedPropertiesToken(
  value: string,
  previous: string[] | undefined
): string[] {
  if (!deprecatedAliasWarned) {
    deprecatedAliasWarned = true;
    // STDERR, not the logger: option parsing runs before the logger's verbosity
    // is resolved, and a deprecation the user cannot see is not a deprecation.
    process.stderr.write(
      '--allow-unsupported-properties is deprecated and will be removed in the ' +
        'first minor release after 2026-12-01; use --prefer-sdk-route, which takes the same ' +
        '<ResourceType>:<PropertyName> tokens and does the same thing. The old ' +
        'name reads as the opposite of its behaviour: it does not make the ' +
        'property reach AWS, it keeps the resource on the SDK provider and ' +
        'accepts that the value is NOT written.\n'
    );
  }
  return parseRouteEntries(value, previous, '--allow-unsupported-properties');
}

/**
 * `--prefer-sdk-route` — keep a resource on its SDK provider instead of letting
 * an unwired property auto-route it to Cloud Control (issue
 * [#3000](https://github.com/go-to-k/cdkd/issues/3000)).
 *
 * RENAMED from `--allow-unsupported-properties`, which read as the opposite of
 * what it does and rhymed with `--allow-unsupported-types`, a flag that runs the
 * OTHER way: that one ENABLES a Cloud Control attempt, this one DISABLES the
 * Cloud Control auto-route. Two independent readers took the old name backwards
 * in one session, one of them while writing 44 issue bodies describing it.
 *
 * `prefer`, not a negative or a guarantee, and the reason is mechanical rather
 * than stylistic. The allow set is per `<Type>:<Prop>` while ROUTING is per
 * RESOURCE, so one un-allowed sibling drop on the same resource sends the whole
 * resource to Cloud Control anyway — and Cloud Control then forwards the full
 * map, so the named property reaches AWS after all. A name promising "do not
 * route" would be a promise this flag cannot keep; `prefer` is the one modality
 * that is true in both cases.
 *
 * The help text therefore carries what the name deliberately does not: that the
 * values go UNWRITTEN when the preference is honoured, and that it is ignored
 * when the resource routes to Cloud Control for another reason.
 */
export const preferSdkRouteOption = new Option(
  '--prefer-sdk-route <entries>',
  'Comma-separated <ResourceType>:<PropertyName> tokens to keep on the SDK provider ' +
    'instead of auto-routing the resource to Cloud Control. The named values are then ' +
    'NOT written to AWS — the deployed resource is missing the field. Ignored for a ' +
    'resource that routes to Cloud Control for another reason (a sibling unwired ' +
    'property, or a sticky cc-api state record), where the values are written after all. ' +
    'Example: --prefer-sdk-route AWS::ApiGatewayV2::Api:Body'
).argParser(parsePreferSdkRouteToken);

/**
 * The deprecated spelling. HIDDEN from `--help` so new users meet only the
 * successor, but still parsed so existing scripts keep working; it warns once
 * per process and feeds the SAME option name, so nothing downstream can tell
 * which spelling was used.
 */
export const allowUnsupportedPropertiesOption = new Option(
  '--allow-unsupported-properties <entries>',
  'Deprecated alias for --prefer-sdk-route.'
)
  .argParser(parseAllowUnsupportedPropertiesToken)
  .hideHelp();

/**
 * Issue [#615] — `--recreate-via-cc-api <LogicalId>` (repeatable). Each
 * named resource is destroyed + recreated this deploy via Cloud Control
 * API regardless of whether the existing state stamps it `sdk` or has
 * no `provisionedBy` field (legacy). The new physical id stamps
 * `provisionedBy: 'cc-api'` so all subsequent ops route via CC (sticky).
 *
 * Mirrors `--allow-unsupported-properties` per-resource explicit naming
 * (one flag-instance per logical id), but the argument is a single
 * logical id (no comma split — `MyLambda,Other` would be ambiguous
 * since logical ids do not embed commas anyway).
 *
 * Format-checks each logical id against CFn's `Logical IDs are
 * alphanumeric (A-Z, a-z, 0-9)` rule. A typo aborts at parse time so
 * an unmatched id is surfaced immediately rather than silently
 * skipped at deploy time.
 */
const LOGICAL_ID_FORMAT = /^[A-Za-z][A-Za-z0-9]{0,254}$/;

export function parseRecreateViaCcApiToken(
  value: string,
  previous: string[] | undefined
): string[] {
  const token = value.trim();
  if (!LOGICAL_ID_FORMAT.test(token)) {
    throw new Error(
      `Invalid --recreate-via-cc-api value "${value}": expected a CloudFormation ` +
        `logical id (alphanumeric, starts with a letter, max 255 chars). One ` +
        `--recreate-via-cc-api flag per resource — repeat the flag for additional ` +
        `targets.`
    );
  }
  return [...(previous ?? []), token];
}

export const recreateViaCcApiOption = new Option(
  '--recreate-via-cc-api <logicalId>',
  'Destroy + recreate the named resource (by CloudFormation logical id) via ' +
    'Cloud Control API in this deploy, so a top-level CFn property the SDK ' +
    'provider does not write reaches AWS via CC. Repeatable — pass the flag once ' +
    'per resource. Per-resource opt-in (no bulk / no per-stack shortcut) so the ' +
    'destroy-and-recreate cost is acknowledged for each target. Stateful resource ' +
    'types (RDS, DynamoDB, S3, EFS, ...) refuse unless --force-stateful-recreation ' +
    'is ALSO passed (two-flag protection). Cannot be combined with ' +
    '--prefer-sdk-route on the same resource type and property. Refused, with ' +
    'no bypass, for a type Cloud Control cannot create (NON_PROVISIONABLE).'
).argParser(parseRecreateViaCcApiToken);

/**
 * Issue [#651] — `--recreate-via-sdk-provider <LogicalId>` is the reverse
 * direction of `--recreate-via-cc-api`. Once a resource is sticky on
 * `provisionedBy: 'cc-api'` (e.g. after a #615 SDK→CC migration, or
 * because cdkd auto-routed it via the #614 default-on Cloud Control
 * fallback on a fresh deploy), subsequent SDK Provider backfills
 * (issue #609) do NOT auto-migrate it back — sticky semantics avoid
 * SDK↔CC ping-pong on every backfill release. This flag is the
 * user-initiated CC → SDK migration: destroy + recreate the named
 * resource so the new copy is `provisionedBy: 'sdk'`.
 *
 * Symmetric to `--recreate-via-cc-api`: same per-resource explicit
 * opt-in, same destroy-then-create ordering, same stateful guard,
 * same multi-region refusal, same `Continue? (y/N)` interactive prompt.
 */
export function parseRecreateViaSdkProviderToken(
  value: string,
  previous: string[] | undefined
): string[] {
  const token = value.trim();
  if (!LOGICAL_ID_FORMAT.test(token)) {
    throw new Error(
      `Invalid --recreate-via-sdk-provider value "${value}": expected a CloudFormation ` +
        `logical id (alphanumeric, starts with a letter, max 255 chars). One ` +
        `--recreate-via-sdk-provider flag per resource — repeat the flag for additional ` +
        `targets.`
    );
  }
  return [...(previous ?? []), token];
}

/**
 * Issue [#2719] — `--pin-cc-api <logicalId>` keeps a named resource on the
 * Cloud Control route for this deploy, suppressing the `'sdk-coverage'`
 * sticky-exemption that would otherwise return it to its SDK provider.
 *
 * The lightweight counterpart to `--recreate-via-cc-api`: that one forces the
 * CC layer by DESTROYING and recreating the resource, which is not something a
 * user can do to a stateful resource just to decline a routing change. This
 * one changes only which provider runs the update.
 *
 * Deliberately per-deploy rather than a state field. A persisted pin would be
 * a v10 schema bump plus its migration integ, and nothing has yet shown a user
 * needing the pin to survive a deploy they did not pass it on -- the flip is
 * conditioned on the resource's own coverage, so the case it guards against is
 * "I disagree with this specific deploy's routing", not a standing preference.
 *
 * It does NOT override a `'cc-broken'` exemption: honoring it there would pin
 * the resource to a handler that cannot manage it, which is the bug those
 * entries exist to escape.
 */
export function parsePinCcApiToken(value: string, previous: string[] | undefined): string[] {
  const token = value.trim();
  if (!LOGICAL_ID_FORMAT.test(token)) {
    throw new Error(
      `Invalid --pin-cc-api value "${value}": expected a CloudFormation logical id ` +
        `(alphanumeric, starts with a letter, max 255 chars). One --pin-cc-api flag per ` +
        `resource — repeat the flag for additional targets.`
    );
  }
  return [...(previous ?? []), token];
}

export const pinCcApiOption = new Option(
  '--pin-cc-api <logicalId>',
  'Keep the named resource (by CloudFormation logical id) on the Cloud Control ' +
    'route in this deploy, declining the automatic return to the SDK Provider ' +
    'that a type-level sdk-coverage exemption would otherwise apply to a resource ' +
    'recorded as provisionedBy: cc-api. Repeatable — pass the flag once per ' +
    'resource. Has no effect on a resource already on the SDK path, and does not ' +
    'override an exemption admitted because Cloud Control cannot manage the type.'
).argParser(parsePinCcApiToken);

export const recreateViaSdkProviderOption = new Option(
  '--recreate-via-sdk-provider <logicalId>',
  'Destroy + recreate the named resource (by CloudFormation logical id) via ' +
    "cdkd's SDK Provider in this deploy, so a resource currently sticky on " +
    'provisionedBy: cc-api flips back to provisionedBy: sdk. Used after a ' +
    'release adds SDK coverage for a type the user originally needed CC ' +
    'for (e.g. Lambda LoggingConfig). Repeatable — pass the flag once per resource. ' +
    'Per-resource opt-in. Stateful resource types refuse unless ' +
    '--force-stateful-recreation is ALSO passed.'
).argParser(parseRecreateViaSdkProviderToken);
