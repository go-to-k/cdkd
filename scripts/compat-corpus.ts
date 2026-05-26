/**
 * scripts/compat-corpus.ts
 *
 * Offline cdkd compatibility verdict over a corpus of CloudFormation
 * `*.template.json` files.
 *
 * For every template it scans, the tool computes two verdicts per stack:
 *
 *   RUNTIME = what cdkd's pre-flight does TODAY. `CloudControlProvider.
 *             isSupportedResourceType` is OPTIMISTIC: it blocklists ~17
 *             resource types and lets every other `AWS::*` through. So a
 *             genuinely-unsupported type passes pre-flight and then fails
 *             mid-deploy with a confusing Cloud Control error.
 *   TRUTH   = what will actually deploy. The authoritative unsupported set
 *             is `docs/_generated/provider-coverage.json` -> `tier3`
 *             (AWS `ProvisioningType: NON_PROVISIONABLE` per DescribeType).
 *             SDK-registered types (tier1) and real Cloud Control types
 *             (tier2) deploy; tier3 does not.
 *
 * The DELTA between the two — types that pass pre-flight but are tier3 —
 * is the headline insight: the "silent tier-3 surface" where cdkd accepts
 * a template at pre-flight and then breaks partway through a deploy.
 *
 * Inputs to the verdict (all read locally, no AWS calls):
 *   - SDK-registered types: parsed from
 *     `src/provisioning/register-providers.ts` (explicit
 *     `registry.register('AWS::X::Y', ...)` calls). Static parse over a
 *     dynamic import — importing the module constructs real AWS SDK
 *     clients, which is unnecessary and brittle here. Mirrors the parser
 *     in `scripts/audit-provider-coverage.ts`.
 *   - The tier3 set: read from the cached provider-coverage JSON.
 *   - The runtime blocklist: replicated from
 *     `CloudControlProvider.isSupportedResourceType` (see
 *     `RUNTIME_UNSUPPORTED_TYPES` below). Replicating the ~17-entry set is
 *     cleaner than importing the built `dist/index.js` (which would force a
 *     fresh `vp run build` before every measurement); a unit test guards
 *     the replica against drift from the source.
 *   - Intrinsics: the resolver in `src/deployment/intrinsic-function-
 *     resolver.ts` handles `Ref` + 16 `Fn::*`. Any OTHER `Fn::*` key in a
 *     template is a compat blocker (the resolver would leave it unresolved).
 *
 * `AWS::CDK::Metadata` is excluded before judging (mirrors
 * `deploy-engine.ts` — it's a skipped sentinel, never deployed).
 *
 * Usage:
 *   node scripts/compat-corpus.ts <dir> [<dir> ...]
 *   node scripts/compat-corpus.ts --json <dir> [<dir> ...]
 *   (or: vp run compat-corpus <dir> ...)
 *
 * Each `<dir>` is scanned recursively for `*.template.json` files
 * (`node_modules` directories are skipped). Missing dirs, empty dirs, and
 * malformed JSON files are reported and skipped, not fatal.
 *
 * Exit codes:
 *   0  the run completed (regardless of how many templates were judged
 *      incompatible — incompatibility is a finding, not a tool failure).
 *   1  no valid template was found across every input dir, or a usage /
 *      argument error.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), '..');
const REGISTER_PROVIDERS_PATH = resolve(REPO_ROOT, 'src/provisioning/register-providers.ts');
const PROVIDER_COVERAGE_PATH = resolve(REPO_ROOT, 'docs/_generated/provider-coverage.json');

/**
 * The CDK sentinel resource type. Never deployed by cdkd — excluded
 * before any verdict. Mirrors `src/deployment/deploy-engine.ts`, which
 * filters it out before validating resource types.
 */
export const CDK_METADATA_TYPE = 'AWS::CDK::Metadata';

/**
 * Resource types cdkd's runtime pre-flight blocklists.
 *
 * Replicated VERBATIM from `CloudControlProvider.isSupportedResourceType`
 * in `src/provisioning/cloud-control-provider.ts`. A unit test cross-checks
 * this set against the source so the two cannot silently drift.
 *
 * The pre-flight is intentionally optimistic: anything NOT in this set and
 * NOT a custom resource passes if it starts with `AWS::`. That optimism is
 * exactly what creates the silent tier-3 surface this tool measures.
 */
export const RUNTIME_UNSUPPORTED_TYPES: ReadonlySet<string> = new Set([
  // IAM (most types not supported)
  'AWS::IAM::Role',
  'AWS::IAM::Policy',
  'AWS::IAM::ManagedPolicy',
  'AWS::IAM::User',
  'AWS::IAM::Group',
  'AWS::IAM::InstanceProfile',
  // Lambda layers
  'AWS::Lambda::LayerVersion',
  // S3 bucket policies (use SDK instead)
  'AWS::S3::BucketPolicy',
  // CloudFormation-specific resources
  'AWS::CloudFormation::Stack',
  'AWS::CloudFormation::WaitCondition',
  'AWS::CloudFormation::WaitConditionHandle',
  'AWS::CloudFormation::CustomResource',
  // CDK-specific resources
  'AWS::CDK::Metadata',
  'Custom::CDKBucketDeployment',
  'Custom::S3AutoDeleteObjects',
  // Route53 hosted zones (complex)
  'AWS::Route53::HostedZone',
  // ACM certificates (validation complexity)
  'AWS::CertificateManager::Certificate',
]);

/**
 * The intrinsic functions cdkd's resolver handles: `Ref` plus 16 `Fn::*`.
 * Mirrors `src/deployment/intrinsic-function-resolver.ts`. Any other
 * `Fn::*` key encountered in a template is an unresolved-intrinsic compat
 * blocker. `Fn::Transform` is treated separately (macro expansion, handled
 * by the synthesis layer) and is NOT flagged here.
 */
export const HANDLED_FN: ReadonlySet<string> = new Set([
  'Fn::GetAtt',
  'Fn::Join',
  'Fn::Sub',
  'Fn::Select',
  'Fn::Split',
  'Fn::If',
  'Fn::Equals',
  'Fn::And',
  'Fn::Or',
  'Fn::Not',
  'Fn::ImportValue',
  'Fn::GetStackOutput',
  'Fn::FindInMap',
  'Fn::Base64',
  'Fn::GetAZs',
  'Fn::Cidr',
]);

/** A custom resource — handled by cdkd outside the provider registry. */
export function isCustomResource(resourceType: string): boolean {
  return (
    resourceType.startsWith('Custom::') ||
    resourceType.startsWith('AWS::CloudFormation::CustomResource')
  );
}

/**
 * Replicate the RUNTIME pre-flight verdict — `ProviderRegistry.hasProvider`,
 * NOT `isSupportedResourceType` alone. The real registry checks the SDK
 * provider map FIRST and the custom-resource path LAST, so a type that is
 * Cloud-Control-blocklisted but SDK-registered (IAM::Role, S3::BucketPolicy,
 * Lambda::LayerVersion, Route53::HostedZone) still passes pre-flight, and so
 * does any custom resource. Mirroring only the blocklist (ignoring the SDK
 * map + custom path) under-counts RUNTIME badly.
 */
export function isRuntimeSupported(
  resourceType: string,
  sdkTypes: ReadonlySet<string>
): boolean {
  if (sdkTypes.has(resourceType)) return true; // SDK provider wins first
  if (isCustomResource(resourceType)) return true; // custom-resource path
  if (resourceType === CDK_METADATA_TYPE) return true; // skipped sentinel
  if (RUNTIME_UNSUPPORTED_TYPES.has(resourceType)) return false;
  return resourceType.startsWith('AWS::'); // Cloud Control optimistic fallthrough
}

/**
 * The TRUTH verdict for a single resource type: will cdkd actually be able
 * to deploy it?
 *
 * - SDK-registered types (tier1) always deploy.
 * - Custom resources are handled by cdkd's custom-resource path.
 * - `AWS::CDK::Metadata` is a skipped sentinel (never reaches here in
 *   practice, but defended for safety).
 * - tier3 (AWS `NON_PROVISIONABLE`) types cannot deploy.
 * - Everything else (tier1 + tier2) deploys.
 */
export function isTrulySupported(
  resourceType: string,
  sdkTypes: ReadonlySet<string>,
  tier3: ReadonlySet<string>
): boolean {
  if (sdkTypes.has(resourceType)) return true;
  if (isCustomResource(resourceType)) return true;
  if (resourceType === CDK_METADATA_TYPE) return true;
  // Mirror hasProvider's final fallthrough: a non-SDK, non-custom type only
  // deploys via Cloud Control, which cdkd only attempts for AWS:: namespaces
  // (third-party CFN registry types like MyOrg::Svc::Type are rejected at
  // pre-flight). A tier2 (real-CC) type is exactly "AWS:: and not tier3".
  return resourceType.startsWith('AWS::') && !tier3.has(resourceType);
}

/**
 * Recursively collect every intrinsic key (`Ref` and `Fn::*`) used
 * anywhere in a JSON node. `Ref` only counts when it is the SOLE key of an
 * object (the CFn intrinsic shape) so a property literally named "Ref"
 * does not produce a false positive.
 */
export function collectIntrinsics(node: unknown, found: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) collectIntrinsics(item, found);
    return;
  }
  if (node !== null && typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    const keys = Object.keys(obj);
    for (const key of keys) {
      if (key.startsWith('Fn::')) found.add(key);
      if (key === 'Ref' && keys.length === 1) found.add('Ref');
    }
    for (const key of keys) collectIntrinsics(obj[key], found);
  }
}

/**
 * Find every `Fn::*` intrinsic in a template that cdkd's resolver does NOT
 * handle. `Ref` is always handled; `Fn::Transform` is macro-expansion (out
 * of the resolver's scope, handled upstream) and is not flagged.
 */
export function findUnknownIntrinsics(template: TemplateShape): string[] {
  const found = new Set<string>();
  collectIntrinsics(template.Resources ?? {}, found);
  collectIntrinsics(template.Outputs ?? {}, found);
  collectIntrinsics(template.Conditions ?? {}, found);
  return [...found].filter(
    (key) => key.startsWith('Fn::') && key !== 'Fn::Transform' && !HANDLED_FN.has(key)
  );
}

/** Minimal structural view of a CFn template the verdict needs. */
export interface TemplateShape {
  Resources?: Record<string, { Type?: unknown } | null>;
  Outputs?: Record<string, unknown>;
  Conditions?: Record<string, unknown>;
}

/**
 * Extract the deployable resource types of a template: the distinct
 * `Type` values, excluding the `AWS::CDK::Metadata` sentinel and any
 * resource lacking a string `Type`.
 */
export function extractResourceTypes(template: TemplateShape): string[] {
  const resources = template.Resources;
  if (!resources || typeof resources !== 'object') return [];
  const types = new Set<string>();
  for (const resource of Object.values(resources)) {
    const type = resource?.Type;
    if (typeof type === 'string' && type !== CDK_METADATA_TYPE) {
      types.add(type);
    }
  }
  return [...types];
}

/** Per-template verdict produced by {@link judgeTemplate}. */
export interface TemplateVerdict {
  /** Resource types that fail cdkd's RUNTIME pre-flight. */
  readonly runtimeBad: string[];
  /** Resource types that will fail to deploy (TRUTH). */
  readonly truthBad: string[];
  /**
   * The silent tier-3 surface: types that PASS pre-flight but will FAIL
   * mid-deploy. The headline insight.
   */
  readonly silentTier3: string[];
  /** `Fn::*` intrinsics in the template cdkd's resolver cannot handle. */
  readonly unknownIntrinsics: string[];
  /** True when the template passes RUNTIME pre-flight (optimistic). */
  readonly runtimePass: boolean;
  /** True when the template will actually deploy (TRUTH). */
  readonly truthPass: boolean;
}

/**
 * Judge a single template against both verdicts. Pure function — all
 * inputs are explicit, no filesystem access. The verdict-defining helper
 * worth unit-testing.
 */
export function judgeTemplate(
  template: TemplateShape,
  sdkTypes: ReadonlySet<string>,
  tier3: ReadonlySet<string>
): TemplateVerdict {
  const types = extractResourceTypes(template);
  const runtimeBad = types.filter((t) => !isRuntimeSupported(t, sdkTypes));
  const truthBad = types.filter((t) => !isTrulySupported(t, sdkTypes, tier3));
  const silentTier3 = types.filter(
    (t) => isRuntimeSupported(t, sdkTypes) && !isTrulySupported(t, sdkTypes, tier3)
  );
  const unknownIntrinsics = findUnknownIntrinsics(template);
  const runtimePass = runtimeBad.length === 0 && unknownIntrinsics.length === 0;
  const truthPass = truthBad.length === 0 && unknownIntrinsics.length === 0;
  return { runtimeBad, truthBad, silentTier3, unknownIntrinsics, runtimePass, truthPass };
}

/**
 * Parse `registry.register('AWS::Service::Type', ...)` calls out of the
 * provider-registration source. Mirrors the parser in
 * `scripts/audit-provider-coverage.ts` (and the matrix builder); the
 * static parse avoids constructing real SDK clients.
 */
export function parseRegisteredTypes(source: string): Set<string> {
  const result = new Set<string>();
  const pattern = /registry\.register\(\s*['"](AWS::[A-Za-z0-9:]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const typeName = match[1];
    if (typeName !== undefined) result.add(typeName);
  }
  return result;
}

/** Shape of the cached provider-coverage JSON this tool consumes. */
interface ProviderCoverage {
  tier3?: unknown;
}

/**
 * Read the tier3 (genuinely-unsupported) set from the cached
 * provider-coverage JSON. Tolerates the entries being plain strings or
 * `{type}`-shaped objects (the spike defended both shapes).
 */
export function extractTier3(coverage: ProviderCoverage): Set<string> {
  const raw = Array.isArray(coverage.tier3) ? coverage.tier3 : [];
  const out = new Set<string>();
  for (const entry of raw) {
    if (typeof entry === 'string') {
      out.add(entry);
    } else if (entry && typeof entry === 'object') {
      const obj = entry as Record<string, unknown>;
      // Pick the first value that is actually a string — `??` would stop at a
      // non-string (e.g. numeric `type`) and drop a valid `typeName`/`name`.
      const name = [obj.type, obj.typeName, obj.name].find((v) => typeof v === 'string');
      if (typeof name === 'string') out.add(name);
    }
  }
  return out;
}

/**
 * Recursively collect every `*.template.json` path under `dir`, skipping
 * `node_modules` directories. Unreadable entries are skipped (best-effort
 * walk). Returns `{ files, missing }` so a missing top-level dir can be
 * reported distinctly from an empty one.
 */
function findTemplates(dir: string): { files: string[]; missing: boolean } {
  let entries: string[];
  try {
    const st = statSync(dir);
    if (!st.isDirectory()) {
      // A file passed directly: accept it if it looks like a template.
      return { files: dir.endsWith('.template.json') ? [dir] : [], missing: false };
    }
    entries = readdirSync(dir);
  } catch {
    return { files: [], missing: true };
  }
  const files: string[] = [];
  for (const entry of entries) {
    if (entry === 'node_modules') continue;
    const full = join(dir, entry);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      files.push(...findTemplates(full).files);
    } else if (entry.endsWith('.template.json')) {
      files.push(full);
    }
  }
  return { files, missing: false };
}

/** Rank a frequency map as `[type, count]` pairs, most-frequent first. */
export function rankFrequency(map: Map<string, number>): Array<[string, number]> {
  return [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/** Aggregated corpus measurement produced by {@link measureCorpus}. */
export interface CorpusReport {
  readonly dirs: string[];
  readonly missingDirs: string[];
  readonly totalFiles: number;
  readonly malformedFiles: string[];
  /** Templates with a parseable `Resources` block (the judged denominator). */
  readonly total: number;
  readonly runtimePass: number;
  readonly truthPass: number;
  /**
   * The headline metric: # of templates that PASS the optimistic runtime
   * pre-flight yet contain at least one tier-3 type that will fail
   * mid-deploy. Counted per-template (not `runtimePass - truthPass`, which
   * can go negative when blocklisted-but-supported types like IAM::Role
   * make runtime stricter than truth).
   */
  readonly silentTier3Templates: number;
  /** type -> # of templates where it passes pre-flight but is tier3. */
  readonly silentTier3: Array<[string, number]>;
  /** type -> # of templates where it genuinely cannot deploy. */
  readonly trulyUnsupported: Array<[string, number]>;
  /** unknown `Fn::*` -> # of templates containing it. */
  readonly unknownIntrinsics: Array<[string, number]>;
}

/**
 * Walk every input dir, judge each template, and aggregate. This is the
 * IO-bearing orchestrator; the per-template verdict logic lives in the
 * pure {@link judgeTemplate}.
 */
export function measureCorpus(
  dirs: string[],
  sdkTypes: ReadonlySet<string>,
  tier3: ReadonlySet<string>
): CorpusReport {
  const files: string[] = [];
  const missingDirs: string[] = [];
  for (const dir of dirs) {
    const { files: found, missing } = findTemplates(dir);
    if (missing) missingDirs.push(dir);
    files.push(...found);
  }

  let total = 0;
  let runtimePass = 0;
  let truthPass = 0;
  let silentTier3Templates = 0;
  const malformed: string[] = [];
  const silentTier3 = new Map<string, number>();
  const trulyUnsupported = new Map<string, number>();
  const unknownIntrinsics = new Map<string, number>();

  for (const file of files) {
    let template: TemplateShape;
    try {
      template = JSON.parse(readFileSync(file, 'utf8')) as TemplateShape;
    } catch {
      malformed.push(file);
      continue;
    }
    if (!template || typeof template !== 'object') {
      malformed.push(file);
      continue;
    }
    if (!template.Resources || typeof template.Resources !== 'object') {
      // Not a deployable CFn template (no Resources block) — skip silently;
      // CDK emits asset/manifest JSON that happens to share the suffix only
      // for real stacks, but defensive against odd inputs.
      continue;
    }
    total++;
    const verdict = judgeTemplate(template, sdkTypes, tier3);
    if (verdict.runtimePass) runtimePass++;
    if (verdict.truthPass) truthPass++;
    if (verdict.runtimePass && !verdict.truthPass && verdict.silentTier3.length > 0) {
      silentTier3Templates++;
    }
    for (const t of verdict.truthBad) {
      trulyUnsupported.set(t, (trulyUnsupported.get(t) ?? 0) + 1);
    }
    for (const t of verdict.silentTier3) {
      silentTier3.set(t, (silentTier3.get(t) ?? 0) + 1);
    }
    for (const fn of new Set(verdict.unknownIntrinsics)) {
      unknownIntrinsics.set(fn, (unknownIntrinsics.get(fn) ?? 0) + 1);
    }
  }

  return {
    dirs,
    missingDirs,
    totalFiles: files.length,
    malformedFiles: malformed,
    total,
    runtimePass,
    truthPass,
    silentTier3Templates,
    silentTier3: rankFrequency(silentTier3),
    trulyUnsupported: rankFrequency(trulyUnsupported),
    unknownIntrinsics: rankFrequency(unknownIntrinsics),
  };
}

function pct(n: number, total: number): string {
  if (total === 0) return '0.0';
  return ((100 * n) / total).toFixed(1);
}

/** Render the human-readable report to a string (one block per corpus run). */
export function renderReport(report: CorpusReport, sdkTypes: ReadonlySet<string>): string {
  const lines: string[] = [];
  const { total } = report;

  lines.push('');
  lines.push(`=== cdkd compatibility over ${total} template(s) ===`);
  lines.push(`Scanned dirs : ${report.dirs.join(', ')}`);
  if (report.missingDirs.length > 0) {
    lines.push(`Missing dirs : ${report.missingDirs.join(', ')} (skipped)`);
  }
  if (report.malformedFiles.length > 0) {
    lines.push(`Malformed    : ${report.malformedFiles.length} file(s) skipped (invalid JSON)`);
  }
  lines.push('');
  lines.push(
    `RUNTIME pre-flight passes : ${report.runtimePass}/${total}  (${pct(report.runtimePass, total)}%)   <- optimistic isSupportedResourceType`
  );
  lines.push(
    `TRUTH  will-deploy        : ${report.truthPass}/${total}  (${pct(report.truthPass, total)}%)   <- provider-coverage tier3 oracle`
  );
  lines.push(
    `SILENT tier-3 surface     : ${report.silentTier3Templates}/${total}  (${pct(report.silentTier3Templates, total)}%)   <- pass pre-flight but contain a tier-3 will-fail type (the headline gap)`
  );

  lines.push('');
  lines.push('--- silent tier-3 surface: types that PASS pre-flight but FAIL mid-deploy ---');
  if (report.silentTier3.length === 0) {
    lines.push('  (none in this corpus)');
  } else {
    for (const [type, count] of report.silentTier3) {
      lines.push(`  ${String(count).padStart(4)}  ${type}`);
    }
  }

  lines.push('');
  lines.push('--- all genuinely-unsupported types in corpus (TRUTH oracle) ---');
  if (report.trulyUnsupported.length === 0) {
    lines.push('  (none)');
  } else {
    for (const [type, count] of report.trulyUnsupported) {
      const tag = sdkTypes.has(type) ? '' : ' [tier3]';
      lines.push(`  ${String(count).padStart(4)}  ${type}${tag}`);
    }
  }

  lines.push('');
  lines.push('--- unknown intrinsics (Fn::* the resolver cannot handle, silently passed today) ---');
  if (report.unknownIntrinsics.length === 0) {
    lines.push('  (none)');
  } else {
    for (const [fn, count] of report.unknownIntrinsics) {
      lines.push(`  ${String(count).padStart(4)}  ${fn}`);
    }
  }
  lines.push('');

  return lines.join('\n');
}

/** Parsed CLI args. */
export interface CliArgs {
  readonly json: boolean;
  readonly help: boolean;
  readonly dirs: string[];
}

export function parseCliArgs(argv: readonly string[]): CliArgs {
  let json = false;
  let help = false;
  const dirs: string[] = [];
  for (const arg of argv) {
    if (arg === '--json') json = true;
    else if (arg === '--help' || arg === '-h') help = true;
    else dirs.push(arg);
  }
  return { json, help, dirs };
}

const HELP_TEXT = [
  'Usage: node scripts/compat-corpus.ts [--json] <dir> [<dir> ...]',
  '',
  'Measure cdkd compatibility over a corpus of CloudFormation',
  '*.template.json files (scanned recursively; node_modules skipped).',
  '',
  '  --json   Emit the aggregated report as JSON instead of human text.',
  '  --help   Show this help.',
  '',
  'Two verdicts per template:',
  '  RUNTIME  what cdkd pre-flight accepts today (optimistic).',
  '  TRUTH    what will actually deploy (provider-coverage tier3 oracle).',
  'The DELTA is the silent tier-3 surface — the headline finding.',
].join('\n');

export interface CliIO {
  readonly log: (msg: string) => void;
  readonly error: (msg: string) => void;
  setExitCode(code: number): void;
}

const consoleIO: CliIO = {
  log: (msg) => console.log(msg),
  error: (msg) => console.error(msg),
  setExitCode: (code) => {
    process.exitCode = code;
  },
};

export function run(argv: readonly string[], io: CliIO = consoleIO): void {
  const args = parseCliArgs(argv);
  if (args.help) {
    io.log(HELP_TEXT);
    return;
  }
  if (args.dirs.length === 0) {
    io.error('[compat-corpus] no input directory supplied');
    io.error(HELP_TEXT);
    io.setExitCode(1);
    return;
  }

  let sdkTypes: Set<string>;
  let tier3: Set<string>;
  try {
    sdkTypes = parseRegisteredTypes(readFileSync(REGISTER_PROVIDERS_PATH, 'utf8'));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    io.error(`[compat-corpus] cannot read register-providers.ts: ${msg}`);
    io.setExitCode(1);
    return;
  }
  try {
    const coverage = JSON.parse(readFileSync(PROVIDER_COVERAGE_PATH, 'utf8')) as ProviderCoverage;
    tier3 = extractTier3(coverage);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    io.error(`[compat-corpus] cannot read provider-coverage.json: ${msg}`);
    io.error('[compat-corpus] run `vp run audit:coverage:regenerate` to (re)build it');
    io.setExitCode(1);
    return;
  }

  const report = measureCorpus(args.dirs, sdkTypes, tier3);

  if (report.total === 0) {
    io.error('[compat-corpus] no valid CloudFormation templates found in input dir(s)');
    if (report.missingDirs.length > 0) {
      io.error(`[compat-corpus] missing dir(s): ${report.missingDirs.join(', ')}`);
    }
    io.setExitCode(1);
    return;
  }

  if (args.json) {
    io.log(
      JSON.stringify(
        {
          dirs: report.dirs,
          missingDirs: report.missingDirs,
          totalFiles: report.totalFiles,
          malformedFiles: report.malformedFiles,
          total: report.total,
          runtimePass: report.runtimePass,
          truthPass: report.truthPass,
          silentTier3Templates: report.silentTier3Templates,
          silentTier3: report.silentTier3.map(([type, count]) => ({ type, count })),
          trulyUnsupported: report.trulyUnsupported.map(([type, count]) => ({ type, count })),
          unknownIntrinsics: report.unknownIntrinsics.map(([fn, count]) => ({ fn, count })),
        },
        null,
        2
      )
    );
    return;
  }

  io.log(renderReport(report, sdkTypes));
}

/** True when run directly (`node scripts/compat-corpus.ts`), not imported. */
export function isMainModule(argv1: string | undefined, scriptPath: string): boolean {
  if (!argv1) return false;
  return resolve(argv1) === scriptPath;
}

if (isMainModule(process.argv[1], __filename)) {
  run(process.argv.slice(2));
}
