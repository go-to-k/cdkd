/**
 * Codegen + CI critic: is every read-only `Fn::GetAtt` attribute classified for
 * whether an IN-PLACE update moves it? (issue #7001)
 *
 * THE GAP THIS CLOSES
 * -------------------
 * An in-place update can move a read-only attribute another resource reads
 * through `Fn::GetAtt` / `Fn::Sub` (a DynamoDB stream's `StreamArn`, a launch
 * template's `LatestVersionNumber`). `cdkd diff` resolves the reader against
 * the RECORDED value, so the reader stays `NO_CHANGE` and keeps the stale value
 * after a successful deploy — unless the attribute is listed in the hand tables
 * of `src/analyzer/diff-calculator/shared.ts` (`IN_PLACE_UPDATE_DERIVED_ATTRS`,
 * `IN_PLACE_UPDATE_ATTRS_MOVED_BY`, `IN_PLACE_UPDATE_DERIVED_ATTR_PREFIXES`).
 * A type missing from them fails open. CloudFormation re-resolves every reader,
 * so it never has this gap.
 *
 * THE POPULATION
 * --------------
 * Every (type, attribute) pair of the pinned `@aws-cdk/aws-service-spec`
 * database (what CDK's L1 `attr*` getters are generated from) whose attribute
 * is not also a property of the type: an attribute naming a property is
 * already promoted by the in-place pass's arm 1. An SDK-provider type the
 * database does not carry yet falls back to its CFn schema fixture's
 * `readOnlyProperties`.
 *
 * CLASSIFICATION
 * --------------
 *   - SDK-provider types (registered in `src/provisioning/register-providers.ts`)
 *     are classified BY HAND in `scripts/in-place-attr-classification.ts`:
 *     `never`, `moved-by <properties>`, `any-update` or `prefix`. A moving
 *     verdict must match its shared.ts row; `in-place-attr-coverage.test.ts`
 *     holds that parity (this script cannot import `src/`).
 *   - Cloud-Control-only types are classified by RULE ({@link classifyByRule}).
 *     A rule claims `never moves in place`, or, for a MOVING rule
 *     ({@link MOVING_RULES}), `any in-place update may move it`: those pairs are
 *     written to OUT_SRC, which shared.ts merges into
 *     `IN_PLACE_UPDATE_DERIVED_ATTRS`. A pair no rule settles is
 *     in the committed baseline (`ccBaseline` in the generated JSON), which the
 *     writer only SHRINKS: it drops entries a rule now settles or the database
 *     no longer has, and never adds one.
 *
 * `--check` FAILS on an unclassified SDK pair, a classification entry naming no
 * pair, a Cloud Control pair neither a rule nor the baseline settles, a stale
 * baseline entry, and stale generated files.
 *
 * Usage:
 *   node --experimental-strip-types scripts/gen-in-place-attr-coverage.ts          # write
 *   node --experimental-strip-types scripts/gen-in-place-attr-coverage.ts --check  # critic
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSpec, type SpecResource } from './gen-getatt-attributes.ts';
import {
  SDK_IN_PLACE_ATTR_CLASSIFICATION,
  type InPlaceAttrVerdict,
} from './in-place-attr-classification.ts';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(__filename), '..');
export const OUT_JSON = resolve(repoRoot, 'docs/_generated/in-place-attr-coverage.json');
export const OUT_MD = resolve(repoRoot, 'docs/_generated/in-place-attr-coverage.md');
/** The MOVING rules' rows, merged into shared.ts `IN_PLACE_UPDATE_DERIVED_ATTRS`. */
export const OUT_SRC = resolve(
  repoRoot,
  'src/analyzer/diff-calculator/in-place-cc-derived-attrs.generated.ts'
);
const REGISTER_PROVIDERS = resolve(repoRoot, 'src/provisioning/register-providers.ts');
const FIXTURE_DIR = resolve(repoRoot, 'tests/fixtures/cfn-schemas');

/** The CFn types passed to `registry.register(...)` (whitespace-tolerant). */
export function parseRegisteredTypes(source: string): Set<string> {
  const out = new Set<string>();
  for (const m of source.matchAll(/registry\.register\(\s*['"](AWS::[A-Za-z0-9:]+)['"]/g)) {
    out.add(m[1]!);
  }
  return out;
}

/** One spec resource reduced to what the classification reads. */
export interface TypeInput {
  readonly type: string;
  /** Attributes that are not also properties. */
  readonly attributes: readonly string[];
  /** Top-level property name -> the spec's `causesReplacement` (`yes` / `maybe` / absent). */
  readonly properties: Readonly<Record<string, string | undefined>>;
  /** The CFn schema's `primaryIdentifier` members (property or attribute names). */
  readonly primaryIdentifier?: readonly string[];
  /** The spec's `arnTemplate` (the service's documented ARN format), if any. */
  readonly arnTemplate?: string;
}

export function typeInputFromSpec(resource: SpecResource): TypeInput | undefined {
  const type = resource.cloudFormationType;
  if (typeof type !== 'string') return undefined;
  const rawProps = (resource.properties ?? {}) as Record<string, { causesReplacement?: unknown }>;
  const properties: Record<string, string | undefined> = {};
  for (const [name, prop] of Object.entries(rawProps)) {
    properties[name] =
      typeof prop?.causesReplacement === 'string' ? prop.causesReplacement : undefined;
  }
  const attributes = Object.keys((resource.attributes ?? {}) as object)
    .filter((a) => !Object.hasOwn(properties, a))
    .sort();
  const rawPid = (resource as { primaryIdentifier?: unknown }).primaryIdentifier;
  const primaryIdentifier = Array.isArray(rawPid)
    ? rawPid.filter((p): p is string => typeof p === 'string')
    : [];
  const rawTemplate = (resource as { arnTemplate?: unknown }).arnTemplate;
  return {
    type,
    attributes,
    properties,
    primaryIdentifier,
    ...(typeof rawTemplate === 'string' && { arnTemplate: rawTemplate }),
  };
}

/** A type the database lacks: its fixture's read-only properties. */
function typeInputFromFixture(type: string): TypeInput | undefined {
  const path = resolve(FIXTURE_DIR, `${type.replaceAll('::', '-')}.json`);
  if (!existsSync(path)) return undefined;
  const fixture = JSON.parse(readFileSync(path, 'utf8')) as { readOnlyProperties?: unknown };
  const ro = Array.isArray(fixture.readOnlyProperties) ? fixture.readOnlyProperties : [];
  return {
    type,
    attributes: ro.filter((a): a is string => typeof a === 'string').sort(),
    properties: {},
  };
}

// ---------------------------------------------------------------------------
// Cloud Control rules. Each claims "never moves in place", bar the MOVING
// rules, which claim "any in-place update may move it" and are emitted as
// shared.ts rows (`IN_PLACE_UPDATE_DERIVED_ATTRS`) through OUT_SRC.
// ---------------------------------------------------------------------------

export type RuleName =
  | 'no-in-place-update'
  | 'creation-timestamp'
  | 'own-identity'
  | 'primary-identifier'
  | 'arn-template'
  | 'update-timestamp';

/** Rules whose verdict is `any-update`; every other rule's is `never`. */
export const MOVING_RULES: ReadonlySet<RuleName> = new Set(['update-timestamp']);

const CREATION_TIMESTAMP = /^(Create|Created|Creation)(At|Time|Date|Timestamp|DateTime|On)?$/;
const UPDATE_TIMESTAMP = /Update|Modif/;
/** An undotted last-update time: `UpdatedAt`, `LastModifiedTime`, `LastUpdated`. */
const UPDATE_TIME =
  /^(Last)?(Update|Updated|Modified|Modification)(At|Time|Date|DateTime|Timestamp|TimeStamp|On|TimeSeconds)?$/;
const VERSIONED = /Version|Revision/;
/** An identity-shaped name: what a service mints or the ARN it builds. */
const IDENTITY_SHAPED = /(Arn|ARN|Id|ID|Identifier|Uuid|UUID)$/;
/** ARN template placeholders filled by the stack's environment. */
const PSEUDO_PLACEHOLDERS: ReadonlySet<string> = new Set(['Partition', 'Region', 'Account']);

/**
 * Pairs no rule settles because a live probe of them is pending (go-to-k/cdkd#7007:
 * an outside contributor's VpcLink rename probe holds this pair's verdict).
 */
export const RULE_HELD_OUT: ReadonlySet<string> = new Set([
  'AWS::ApiGatewayV2::VpcLink.VpcLinkId',
]);

/**
 * Cloud Control types whose in-place update registers a new revision that
 * the ARN carries, although no attribute or property name says so. Their
 * own identity is never rule-settled.
 */
export const REVISIONED_ARN_TYPES: ReadonlySet<string> = new Set([
  // `job-definition/<name>:<revision>`; an update registers the next revision.
  'AWS::Batch::JobDefinition',
]);
const OWN_IDENTITY = /^(.*?)(Arn|ARN|Id|ID|Uuid|UUID)$/;

/**
 * The rule settling `attribute` of `input` as never moving in place, or
 * `undefined` for a pair no rule settles (it goes to the baseline).
 *
 * - `no-in-place-update`: every property but `Tags` replaces the resource
 *   (`causesReplacement: yes`), so the only in-place update is a tag edit.
 *   An update timestamp is left out: a tag edit may stamp it.
 * - `creation-timestamp`: an undotted creation time. A dotted one is a member
 *   of a nested object an update can re-create (an MSK configuration's
 *   `LatestRevision.CreationTime`).
 * - `own-identity`: an undotted `Arn` / `Id` / `Uuid`, bare or prefixed by a
 *   tail of the type's own name (`AWS::ECS::Service` `ServiceArn`, a
 *   `GraphQLApi`'s `ApiId`), on a type with NO in-place-updatable property
 *   named `...Name` or `Path`: an ARN or id embeds the resource's name or path
 *   when it embeds anything mutable (a CodeCommit rename, an IAM user's path).
 *   Another resource's id or ARN (`VpcId`, `SnsTopicArn`) is not own identity,
 *   and neither is one of a VERSIONED type (a `Version...` attribute or an
 *   in-place `Version...` property): its ARN can carry the version an update
 *   mints (`AWS::GameLift::ContainerGroupDefinition` `.../<name>:<version>`).
 *   A type whose ARN carries a revision no attribute or property names is
 *   listed by hand in {@link REVISIONED_ARN_TYPES}.
 * - `primary-identifier`: an identity-shaped (`...Arn` / `...Id` /
 *   `...Identifier` / `...Uuid`) member of the CFn `primaryIdentifier`. The
 *   resource type handler contract: "The primaryIdentifier returned in every
 *   progress event must match the primaryIdentifier passed into the request"
 *   of an update. A member of another shape can be derived from writable
 *   input despite the contract (`AWS::EC2::VPCGatewayAttachment`
 *   `AttachmentType`, which an internet / VPN gateway swap moves). Neither is
 *   a `Version...` / `Revision...` member (an update can mint one), nor an
 *   ARN whose `arnTemplate` names an in-place property.
 * - `arn-template`: the type's own `Arn`, on an unversioned type (as for
 *   `own-identity`), whose documented `arnTemplate` is built only from the
 *   environment and from values fixed for the resource's life: a
 *   primary-identifier member or a create-only property, named as-is or as
 *   `<TypeName><Id|Name|Identifier>` for the bare member (`fleet/${FleetName}`
 *   over a create-only `Name`). A placeholder naming anything else
 *   (`${ResourceId}`, a writable name) settles nothing.
 * - `update-timestamp` (MOVING): an undotted last-update time. Whether a
 *   Cloud Control update, a tag edit included, stamps it is the handler's
 *   choice, so any in-place update may move it.
 */
export function classifyByRule(input: TypeInput, attribute: string): RuleName | undefined {
  if (RULE_HELD_OUT.has(`${input.type}.${attribute}`)) return undefined;
  const writable = Object.entries(input.properties).filter(
    ([name, replaces]) => name !== 'Tags' && replaces !== 'yes'
  );
  if (writable.length === 0 && !UPDATE_TIMESTAMP.test(attribute)) return 'no-in-place-update';
  if (attribute.includes('.')) return undefined;
  if (UPDATE_TIME.test(attribute)) return 'update-timestamp';
  if (CREATION_TIMESTAMP.test(attribute)) return 'creation-timestamp';
  const primaryIdentifier = input.primaryIdentifier ?? [];
  const typeName = input.type.split('::')[2]!;
  const placeholders = [...(input.arnTemplate ?? '').matchAll(/\$\{([^}]*)\}/g)].map(
    (x) => x[1]!
  );
  const writableNamed = (name: string): boolean =>
    Object.hasOwn(input.properties, name) && input.properties[name] !== 'yes';
  const templateNamesWritable = placeholders.some(
    (ph) =>
      writableNamed(ph) ||
      ['Id', 'Name', 'Identifier'].some((s) => ph === `${typeName}${s}` && writableNamed(s))
  );
  // A versioned id (`MessageTemplateVersionArn`) can be minted by the update
  // itself, and an ARN whose documented template names an in-place property
  // (`segment/${SegmentName}`) contradicts the contract: neither is settled.
  const isPrimaryIdentifier =
    IDENTITY_SHAPED.test(attribute) &&
    !VERSIONED.test(attribute) &&
    primaryIdentifier.includes(attribute) &&
    !(/(Arn|ARN)$/.test(attribute) && templateNamesWritable);
  const m = OWN_IDENTITY.exec(attribute);
  const prefix = m?.[1]!.toLowerCase();
  const own = prefix !== undefined && (prefix === '' || typeName.toLowerCase().endsWith(prefix));
  if (!own) return isPrimaryIdentifier ? 'primary-identifier' : undefined;
  const versioned =
    REVISIONED_ARN_TYPES.has(input.type) ||
    input.attributes.some((a) => VERSIONED.test(a)) ||
    writable.some(([name]) => VERSIONED.test(name));
  const mutableName = writable.some(([name]) => name.endsWith('Name') || name === 'Path');
  if (!versioned && !mutableName) return 'own-identity';
  if (isPrimaryIdentifier) return 'primary-identifier';
  if (versioned || !/(Arn|ARN)$/.test(attribute) || input.arnTemplate === undefined) {
    return undefined;
  }
  const fixed = (name: string): boolean =>
    primaryIdentifier.includes(name) || input.properties[name] === 'yes';
  const placeholderFixed = (ph: string): boolean =>
    PSEUDO_PLACEHOLDERS.has(ph) ||
    fixed(ph) ||
    ['Id', 'Name', 'Identifier'].some((s) => ph === `${typeName}${s}` && fixed(s));
  return placeholders.every(placeholderFixed) ? 'arn-template' : undefined;
}

// ---------------------------------------------------------------------------
// Hand classification lookup (SDK-provider types).
// ---------------------------------------------------------------------------

/** The classification key covering `attribute`: itself, else a `Family.*` key. */
export function classificationKeyFor(
  byAttr: Readonly<Record<string, InPlaceAttrVerdict>>,
  attribute: string
): string | undefined {
  if (Object.hasOwn(byAttr, attribute)) return attribute;
  const segments = attribute.split('.');
  for (let i = segments.length - 1; i >= 1; i--) {
    const key = `${segments.slice(0, i).join('.')}.*`;
    if (Object.hasOwn(byAttr, key)) return key;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// The report.
// ---------------------------------------------------------------------------

export interface SdkRow {
  readonly type: string;
  readonly attribute: string;
  readonly verdict: InPlaceAttrVerdict['kind'];
  readonly properties?: readonly string[];
  readonly prefix?: string;
  readonly reason: string;
}

export interface Report {
  readonly specVersion: string;
  readonly summary: {
    readonly sdkTypes: number;
    readonly sdkPairs: number;
    readonly sdkMoving: number;
    readonly ccTypes: number;
    readonly ccPairs: number;
    readonly ccByRule: Readonly<Record<RuleName, number>>;
    readonly ccBaseline: number;
  };
  readonly sdk: readonly SdkRow[];
  /** Cloud Control pairs a MOVING rule settles (`any-update`): type -> attributes. */
  readonly ccMoving: Readonly<Record<string, readonly string[]>>;
  /** Cloud Control pairs no rule settles, frozen: type -> attributes. */
  readonly ccBaseline: Readonly<Record<string, readonly string[]>>;
}

export interface Findings {
  /** SDK pairs with no hand verdict: `Type.Attr`. */
  readonly unclassifiedSdk: string[];
  /** Hand classification keys covering no pair: `Type.Key`. */
  readonly staleClassification: string[];
  /** Cloud Control pairs neither a rule nor the baseline settles. */
  readonly unclassifiedCc: string[];
  /** Baseline entries no longer an unsettled Cloud Control pair. */
  readonly staleBaseline: string[];
}

export interface BuildInput {
  readonly types: readonly TypeInput[];
  readonly registered: ReadonlySet<string>;
  readonly classification: Readonly<Record<string, Readonly<Record<string, InPlaceAttrVerdict>>>>;
  readonly baseline: Readonly<Record<string, readonly string[]>>;
  readonly specVersion: string;
}

export function buildReport(input: BuildInput): { report: Report; findings: Findings } {
  const findings: Findings = {
    unclassifiedSdk: [],
    staleClassification: [],
    unclassifiedCc: [],
    staleBaseline: [],
  };
  const sdk: SdkRow[] = [];
  const ccBaseline: Record<string, string[]> = {};
  const ccMoving: Record<string, string[]> = {};
  const ccByRule: Record<RuleName, number> = {
    'no-in-place-update': 0,
    'creation-timestamp': 0,
    'own-identity': 0,
    'primary-identifier': 0,
    'arn-template': 0,
    'update-timestamp': 0,
  };
  let ccTypes = 0;
  let ccPairs = 0;
  const sdkTypes = new Set<string>();
  const usedKeys = new Set<string>();
  const unsettledCc = new Set<string>();

  for (const t of [...input.types].sort((a, b) => (a.type < b.type ? -1 : 1))) {
    if (t.attributes.length === 0) continue;
    if (input.registered.has(t.type)) {
      sdkTypes.add(t.type);
      const byAttr = Object.hasOwn(input.classification, t.type)
        ? input.classification[t.type]!
        : {};
      for (const attribute of t.attributes) {
        const key = classificationKeyFor(byAttr, attribute);
        if (key === undefined) {
          findings.unclassifiedSdk.push(`${t.type}.${attribute}`);
          continue;
        }
        usedKeys.add(`${t.type}\0${key}`);
        const v = byAttr[key]!;
        sdk.push({
          type: t.type,
          attribute,
          verdict: v.kind,
          ...(v.kind === 'moved-by' && { properties: [...v.properties] }),
          ...(v.kind === 'prefix' && { prefix: v.prefix }),
          reason: v.reason,
        });
      }
      continue;
    }
    ccTypes++;
    for (const attribute of t.attributes) {
      ccPairs++;
      const rule = classifyByRule(t, attribute);
      if (rule !== undefined) {
        ccByRule[rule]++;
        if (MOVING_RULES.has(rule)) (ccMoving[t.type] ??= []).push(attribute);
        continue;
      }
      unsettledCc.add(`${t.type}\0${attribute}`);
      if (Object.hasOwn(input.baseline, t.type) && input.baseline[t.type]!.includes(attribute)) {
        (ccBaseline[t.type] ??= []).push(attribute);
      } else {
        findings.unclassifiedCc.push(`${t.type}.${attribute}`);
      }
    }
  }

  for (const [type, byAttr] of Object.entries(input.classification)) {
    for (const key of Object.keys(byAttr)) {
      if (!usedKeys.has(`${type}\0${key}`)) findings.staleClassification.push(`${type}.${key}`);
    }
  }
  for (const [type, attrs] of Object.entries(input.baseline)) {
    for (const attribute of attrs) {
      if (!unsettledCc.has(`${type}\0${attribute}`)) {
        findings.staleBaseline.push(`${type}.${attribute}`);
      }
    }
  }
  for (const list of Object.values(findings)) list.sort();

  const baselineCount = Object.values(ccBaseline).reduce((n, a) => n + a.length, 0);
  const report: Report = {
    specVersion: input.specVersion,
    summary: {
      sdkTypes: sdkTypes.size,
      sdkPairs: sdk.length,
      sdkMoving: sdk.filter((r) => r.verdict !== 'never').length,
      ccTypes,
      ccPairs,
      ccByRule,
      ccBaseline: baselineCount,
    },
    sdk,
    ccMoving,
    ccBaseline,
  };
  return { report, findings };
}

export function renderMarkdown(report: Report): string {
  const s = report.summary;
  const lines = [
    '---',
    'title: "In-place attribute coverage"',
    'unlisted: true',
    '---',
    '',
    '# In-place attribute coverage',
    '',
    '<!-- AUTO-GENERATED by scripts/gen-in-place-attr-coverage.ts — DO NOT EDIT BY HAND. -->',
    '<!-- Regenerate: `vp run gen:in-place-attr-coverage`. -->',
    '',
    'Whether an in-place update moves each read-only `Fn::GetAtt` attribute (issue ' +
      '[#7001](https://github.com/go-to-k/cdkd/issues/7001)). A moving attribute ' +
      'needs its row in `src/analyzer/diff-calculator/shared.ts`, or a reader of it ' +
      'keeps the old value after the deploy.',
    '',
    `Source: \`@aws-cdk/aws-service-spec\` ${report.specVersion}.`,
    '',
    `- SDK-provider types: **${s.sdkTypes}**, pairs classified by hand: **${s.sdkPairs}** ` +
      `(moving: **${s.sdkMoving}**)`,
    `- Cloud Control types: **${s.ccTypes}**, pairs: **${s.ccPairs}** — by rule: ` +
      Object.entries(s.ccByRule)
        .map(([rule, n]) => `\`${rule}\` ${n}`)
        .join(', ') +
      `; in the baseline: **${s.ccBaseline}**`,
    '',
    '## SDK-provider types (hand classification)',
  ];
  let lastType = '';
  for (const r of report.sdk) {
    if (r.type !== lastType) {
      lines.push('', `### \`${r.type}\``, '');
      lastType = r.type;
    }
    const verdict =
      r.verdict === 'moved-by'
        ? `moved by ${r.properties!.map((p) => `\`${p}\``).join(', ')}`
        : r.verdict === 'prefix'
          ? `family \`${r.prefix}*\``
          : r.verdict;
    lines.push(`- \`${r.attribute}\`: ${verdict} — ${r.reason.replaceAll('\n', ' ')}`);
  }
  lines.push(
    '',
    '## Cloud Control pairs a moving rule settles',
    '',
    'Each is a row of `IN_PLACE_UPDATE_DERIVED_ATTRS` (any in-place update promotes ' +
      'its reader), emitted to `src/analyzer/diff-calculator/in-place-cc-derived-attrs.generated.ts`.',
    '',
    '| Type | Attributes |',
    '| --- | --- |'
  );
  for (const [type, attrs] of Object.entries(report.ccMoving)) {
    lines.push(`| \`${type}\` | ${attrs.map((a) => `\`${a}\``).join(', ')} |`);
  }
  lines.push(
    '',
    '## Cloud Control baseline',
    '',
    'Pairs no rule settles, per type (the list is in the JSON). Shrinking it is ' +
      'tracked as a follow-up; a new pair outside it fails CI.',
    '',
    '| Type | Unsettled pairs |',
    '| --- | --- |'
  );
  for (const [type, attrs] of Object.entries(report.ccBaseline)) {
    lines.push(`| \`${type}\` | ${attrs.length} |`);
  }
  lines.push('');
  return lines.join('\n');
}

/** The MOVING rules' rows as a `src/` module (formatted as `vp fmt` leaves it). */
export function renderSrc(report: Report): string {
  const lines = [
    '/**',
    ' * AUTO-GENERATED by scripts/gen-in-place-attr-coverage.ts — DO NOT EDIT BY HAND.',
    ' * Regenerate: `vp run gen:in-place-attr-coverage`.',
    ' *',
    ' * Cloud Control (type, attribute) pairs a MOVING rule of the in-place',
    ' * attribute audit settles (go-to-k/cdkd#7007): any in-place update may move',
    ' * them, so `IN_PLACE_UPDATE_DERIVED_ATTRS` in `shared.ts` merges them in.',
    ' */',
    '',
    'export const CC_IN_PLACE_UPDATE_DERIVED_ATTRS: Readonly<Record<string, readonly string[]>> = {',
  ];
  for (const [type, attrs] of Object.entries(report.ccMoving)) {
    const one = `  '${type}': [${attrs.map((a) => `'${a}'`).join(', ')}],`;
    if (one.length <= 100) {
      lines.push(one);
      continue;
    }
    lines.push(`  '${type}': [`, ...attrs.map((a) => `    '${a}',`), '  ],');
  }
  lines.push('};', '');
  return lines.join('\n');
}

export function renderJson(report: Report): string {
  return JSON.stringify(report, null, 2) + '\n';
}

function readCommittedBaseline(): Record<string, readonly string[]> {
  if (!existsSync(OUT_JSON)) return {};
  const parsed = JSON.parse(readFileSync(OUT_JSON, 'utf8')) as { ccBaseline?: unknown };
  const raw = parsed.ccBaseline;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${OUT_JSON}: ccBaseline is missing or not an object`);
  }
  const out: Record<string, readonly string[]> = {};
  for (const [type, attrs] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(attrs) || attrs.some((a) => typeof a !== 'string')) {
      throw new Error(`${OUT_JSON}: ccBaseline["${type}"] is not a string list`);
    }
    out[type] = attrs as string[];
  }
  return out;
}

export function loadInputs(): Omit<BuildInput, 'baseline' | 'classification'> {
  const { resources, version } = loadSpec();
  const registered = parseRegisteredTypes(readFileSync(REGISTER_PROVIDERS, 'utf8'));
  if (registered.size === 0) throw new Error(`${REGISTER_PROVIDERS}: no registered types parsed`);
  const types: TypeInput[] = [];
  const seen = new Set<string>();
  for (const r of resources) {
    const t = typeInputFromSpec(r);
    if (t === undefined || seen.has(t.type)) continue;
    seen.add(t.type);
    types.push(t);
  }
  for (const type of registered) {
    if (seen.has(type)) continue;
    const t = typeInputFromFixture(type);
    if (t === undefined) {
      throw new Error(`${type}: registered, but neither the spec nor a schema fixture has it`);
    }
    types.push(t);
  }
  return { types, registered, specVersion: version };
}

function atomicWrite(path: string, content: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

function main(): void {
  const { report, findings } = buildReport({
    ...loadInputs(),
    classification: SDK_IN_PLACE_ATTR_CLASSIFICATION,
    baseline: readCommittedBaseline(),
  });
  const json = renderJson(report);
  const md = renderMarkdown(report);
  const src = renderSrc(report);
  if (!process.argv.includes('--check')) {
    mkdirSync(dirname(OUT_JSON), { recursive: true });
    atomicWrite(OUT_JSON, json);
    atomicWrite(OUT_MD, md);
    atomicWrite(OUT_SRC, src);
  }
  const problems: string[] = [];
  const section = (head: string, items: readonly string[]): void => {
    if (items.length > 0) problems.push(head, ...items.map((i) => `  ${i}`));
  };
  section(
    'SDK-provider attributes with no verdict — classify each in scripts/in-place-attr-classification.ts ' +
      '(a moving one also needs its row in src/analyzer/diff-calculator/shared.ts):',
    findings.unclassifiedSdk
  );
  section(
    'Classification entries naming no attribute — delete them:',
    findings.staleClassification
  );
  section(
    'Cloud Control attributes no rule settles — teach classifyByRule a sound rule, ' +
      'or add the pair to ccBaseline in docs/_generated/in-place-attr-coverage.json:',
    findings.unclassifiedCc
  );
  if (process.argv.includes('--check')) {
    section(
      'ccBaseline entries no longer unsettled — run `vp run gen:in-place-attr-coverage`:',
      findings.staleBaseline
    );
    const stale =
      !existsSync(OUT_JSON) ||
      readFileSync(OUT_JSON, 'utf8') !== json ||
      !existsSync(OUT_MD) ||
      readFileSync(OUT_MD, 'utf8') !== md ||
      !existsSync(OUT_SRC) ||
      readFileSync(OUT_SRC, 'utf8') !== src;
    if (stale) {
      problems.push(
        'docs/_generated/in-place-attr-coverage.{json,md} or ' +
          'src/analyzer/diff-calculator/in-place-cc-derived-attrs.generated.ts are stale — ' +
          'run `vp run gen:in-place-attr-coverage` and commit.'
      );
    }
  }
  if (problems.length > 0) {
    // Write mode WARNS and exits 0, as the generators beside it in
    // `gen:all-matrices` do: the schema-refresh workflow runs that chain under
    // `set -e`, and its PR must still open for the `:check` step to red.
    if (!process.argv.includes('--check')) {
      process.stderr.write(`in-place-attr-coverage: WARN\n${problems.join('\n')}\n`);
      return;
    }
    process.stderr.write(`in-place-attr-coverage: FAIL\n${problems.join('\n')}\n`);
    process.exit(1);
  }
  const s = report.summary;
  process.stderr.write(
    `in-place-attr-coverage: OK — ${s.sdkPairs} SDK pairs by hand (${s.sdkMoving} moving), ` +
      `${s.ccPairs} Cloud Control pairs (${s.ccBaseline} in the baseline).\n`
  );
}

if (Boolean(process.argv[1]) && resolve(process.argv[1]!) === __filename) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`in-place-attr-coverage: failed — ${(err as Error).message}\n`);
    process.exit(1);
  }
}
