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
 *   - Cloud-Control-only types are classified by RULE ({@link classifyByRule}),
 *     each rule claiming only `never moves in place`. A pair no rule settles is
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
  return { type, attributes, properties };
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
// Cloud Control rules. Each one claims ONLY "never moves in place".
// ---------------------------------------------------------------------------

export type RuleName = 'no-in-place-update' | 'creation-timestamp' | 'own-identity';

const CREATION_TIMESTAMP = /^(Create|Created|Creation)(At|Time|Date|Timestamp|DateTime|On)?$/;
const UPDATE_TIMESTAMP = /Update|Modif/;
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
 *   Another resource's id or ARN (`VpcId`, `SnsTopicArn`) is not own identity.
 */
export function classifyByRule(input: TypeInput, attribute: string): RuleName | undefined {
  const writable = Object.entries(input.properties).filter(
    ([name, replaces]) => name !== 'Tags' && replaces !== 'yes'
  );
  if (writable.length === 0 && !UPDATE_TIMESTAMP.test(attribute)) return 'no-in-place-update';
  if (attribute.includes('.')) return undefined;
  if (CREATION_TIMESTAMP.test(attribute)) return 'creation-timestamp';
  const m = OWN_IDENTITY.exec(attribute);
  if (m === null) return undefined;
  const typeName = input.type.split('::')[2]!.toLowerCase();
  const prefix = m[1]!.toLowerCase();
  if (prefix !== '' && !typeName.endsWith(prefix)) return undefined;
  const mutableName = writable.some(([name]) => name.endsWith('Name') || name === 'Path');
  return mutableName ? undefined : 'own-identity';
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
  const ccByRule: Record<RuleName, number> = {
    'no-in-place-update': 0,
    'creation-timestamp': 0,
    'own-identity': 0,
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
  if (!process.argv.includes('--check')) {
    mkdirSync(dirname(OUT_JSON), { recursive: true });
    atomicWrite(OUT_JSON, json);
    atomicWrite(OUT_MD, md);
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
      readFileSync(OUT_MD, 'utf8') !== md;
    if (stale) {
      problems.push(
        'docs/_generated/in-place-attr-coverage.{json,md} are stale — run `vp run gen:in-place-attr-coverage` and commit.'
      );
    }
  }
  if (problems.length > 0) {
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
