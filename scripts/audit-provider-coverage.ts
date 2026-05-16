/**
 * Provider coverage audit (closes go-to-k/cdkd#390).
 *
 * Enumerates every public AWS CloudFormation resource type and partitions
 * them into three tiers based on how cdkd would provision the type today:
 *
 *   Tier 1 — SDK Provider registered in `src/provisioning/register-providers.ts`.
 *            Direct synchronous API calls; preferred path.
 *   Tier 2 — No SDK Provider, but `ProvisioningType` is `FULLY_MUTABLE` or
 *            `IMMUTABLE`. cdkd would route this through Cloud Control API
 *            today — deployable, but slower and shape-divergent on reads.
 *   Tier 3 — `ProvisioningType` is `NON_PROVISIONABLE`. CC API cannot
 *            create / update / delete this type at all; a dedicated SDK
 *            Provider would be required for cdkd to support it.
 *
 * Outputs (atomic write via `.tmp` + rename):
 *   docs/_generated/provider-coverage.json — machine-readable cache.
 *   docs/_generated/provider-coverage.md   — human-readable review.
 *
 * Usage:
 *   node scripts/audit-provider-coverage.ts          # offline: print summary from cache
 *   node scripts/audit-provider-coverage.ts --regenerate  # call AWS; rewrite cache
 *
 * Regeneration walks ~1500 public CFn types via `cloudformation:ListTypes`,
 * then issues a `cloudformation:DescribeType` per non-Tier-1 type. AWS
 * throttles `DescribeType` aggressively; budget 10-30 minutes for a cold
 * run at 3 concurrent calls with exponential backoff on
 * `ThrottlingException`. Cached output is the source of truth for offline
 * consumers (the default mode).
 */

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DescribeTypeCommand,
  ListTypesCommand,
  type DeprecatedStatus,
  type ProvisioningType,
  type Visibility,
} from '@aws-sdk/client-cloudformation';
import pLimit from 'p-limit';
// NOTE: Node 24 native TS strip resolves imports literally — it does NOT
// rewrite `.js` to `.ts` the way TypeScript's `rewriteRelativeImportExtensions`
// does at emit time. Importing un-built `src/**` via `.js` would fail with
// `ERR_MODULE_NOT_FOUND` because the script runs directly via `node
// scripts/audit-provider-coverage.ts`, not through a bundler. Using `.ts`
// here keeps both the runtime and `tsconfig.test.json`'s type-check happy.
import { getAwsClients } from '../src/utils/aws-clients.ts';

const SCHEMA_VERSION = 1;

// Throttling defaults. AWS CFn DescribeType has a low per-account quota
// (anecdotally a few TPS sustained); 3 concurrent calls + a fairly long
// retry budget is calibrated against real runs that saw spurious Tier 3
// classifications when the per-type retry tail was shorter. The total
// per-call budget (~63s of sleep) is well below the per-resource
// `--resource-timeout` philosophy applied elsewhere in the repo, and the
// audit is offline-cached so the cost is amortised across many CI/PR
// runs.
const DEFAULT_CONCURRENCY = 3;
const DEFAULT_RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 16000, 16000, 16000] as const;

/** Three-tier classification result for a single CFn resource type. */
export type CoverageTier = 'tier1-sdk-provider' | 'tier2-cc-api-fallback' | 'tier3-unsupported';

/** Machine-readable output shape. Bumped via SCHEMA_VERSION on breaking changes. */
export interface CoverageReport {
  readonly schemaVersion: number;
  readonly generatedAt: string;
  readonly summary: {
    readonly tier1Count: number;
    readonly tier2Count: number;
    readonly tier3Count: number;
    readonly totalCount: number;
  };
  readonly tier1: readonly string[];
  readonly tier2: readonly string[];
  readonly tier3: readonly string[];
}

/**
 * Static parse of `src/provisioning/register-providers.ts`.
 *
 * Returns the set of CFn resource type names passed to `registry.register(...)`
 * calls. Static parse is preferred over a dynamic import because
 * `registerAllProviders()` constructs real AWS SDK clients on import,
 * which is unnecessary and brittle in this audit context.
 */
export function parseRegisteredTypes(source: string): Set<string> {
  const result = new Set<string>();
  // Match `registry.register('AWS::...', ...)` — both single and double quotes.
  const pattern = /registry\.register\(\s*['"](AWS::[A-Za-z0-9:]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const typeName = match[1];
    if (typeName !== undefined) {
      result.add(typeName);
    }
  }
  return result;
}

/**
 * Map a CFn `ProvisioningType` to the corresponding non-Tier-1 coverage tier.
 *
 * AWS returns one of `FULLY_MUTABLE` / `IMMUTABLE` / `NON_PROVISIONABLE`.
 * Anything cdkd would route through Cloud Control API is Tier 2;
 * `NON_PROVISIONABLE` (handlers list missing or sentinel value) is Tier 3.
 * Unknown values default to Tier 3 — safer to flag a type as needing a
 * dedicated provider than to silently classify it as deployable.
 */
export function classifyProvisioningType(
  provisioningType: ProvisioningType | string | undefined
): CoverageTier {
  if (provisioningType === 'FULLY_MUTABLE' || provisioningType === 'IMMUTABLE') {
    return 'tier2-cc-api-fallback';
  }
  return 'tier3-unsupported';
}

/** Public surface of a CloudFormation client used by this script. */
export interface CfnClientLike {
  send(command: ListTypesCommand): Promise<{
    TypeSummaries?: Array<{ TypeName?: string }>;
    NextToken?: string;
  }>;
  send(command: DescribeTypeCommand): Promise<{
    ProvisioningType?: ProvisioningType | string;
  }>;
}

/**
 * Enumerate every PUBLIC AWS-owned CFn resource type.
 *
 * `Filters.Category = 'AWS_TYPES'` excludes third-party `Visibility=PUBLIC`
 * registry extensions — out of scope per the issue, and the long tail
 * would balloon the audit runtime past usefulness.
 */
export async function* paginateListTypes(client: CfnClientLike): AsyncGenerator<string> {
  let nextToken: string | undefined;
  do {
    const resp = await client.send(
      new ListTypesCommand({
        Type: 'RESOURCE',
        Visibility: 'PUBLIC' satisfies Visibility,
        Filters: { Category: 'AWS_TYPES' },
        DeprecatedStatus: 'LIVE' satisfies DeprecatedStatus,
        MaxResults: 100,
        ...(nextToken !== undefined && { NextToken: nextToken }),
      })
    );
    const summaries = resp.TypeSummaries ?? [];
    for (const summary of summaries) {
      if (summary.TypeName) {
        yield summary.TypeName;
      }
    }
    nextToken = resp.NextToken;
  } while (nextToken);
}

/**
 * Match AWS SDK throttling errors. AWS returns one of two error names
 * for over-quota DescribeType calls — match both to keep the retry loop
 * future-proof if the SDK ever standardizes.
 */
function isThrottlingError(err: unknown): boolean {
  if (err instanceof Error) {
    const name = err.name;
    return name === 'Throttling' || name === 'ThrottlingException';
  }
  return false;
}

/**
 * Sleep for `ms` milliseconds. Replaceable by tests to skip real delays.
 */
export type Sleep = (ms: number) => Promise<void>;
const defaultSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export interface DescribeTypeRetryOptions {
  readonly retryDelaysMs?: readonly number[];
  readonly sleep?: Sleep;
}

/**
 * Wrap `DescribeType` with exponential backoff on `ThrottlingException`.
 *
 * Returns the raw `ProvisioningType` string (or `undefined` if AWS responded
 * without one — treated as Tier 3 upstream). Non-throttling errors propagate
 * to the caller, which decides whether to fail the whole audit or flag the
 * single type as Tier 3.
 */
export async function describeTypeWithRetry(
  client: CfnClientLike,
  typeName: string,
  options: DescribeTypeRetryOptions = {}
): Promise<string | undefined> {
  const delays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const sleep = options.sleep ?? defaultSleep;
  let attempt = 0;
  while (true) {
    try {
      const resp = await client.send(
        new DescribeTypeCommand({ Type: 'RESOURCE', TypeName: typeName })
      );
      return resp.ProvisioningType;
    } catch (err) {
      if (isThrottlingError(err) && attempt < delays.length) {
        // Guard above ensures delays[attempt] is defined for a non-empty
        // number[]; the `?? 1000` fallback covers the `retryDelaysMs: []`
        // case where attempt < 0 is impossible but TS still narrows
        // delays[attempt] to `number | undefined` under
        // noUncheckedIndexedAccess.
        const delayMs = delays[attempt] ?? 1000;
        await sleep(delayMs);
        attempt++;
        continue;
      }
      throw err;
    }
  }
}

export interface PartitionOptions {
  readonly concurrency?: number;
  readonly retryDelaysMs?: readonly number[];
  readonly sleep?: Sleep;
  /**
   * Optional progress reporter. Called after each DescribeType result
   * (success or unrecoverable failure). Used by the CLI to render a
   * compact progress line; tests can leave this unset.
   */
  readonly onProgress?: (
    done: number,
    total: number,
    typeName: string,
    tier: CoverageTier
  ) => void;
  /**
   * Optional per-type error handler. Defaults to logging the error to
   * stderr and classifying the type as Tier 3 (safer than silently
   * dropping it). Throws bubble up to abort the whole audit.
   */
  readonly onError?: (typeName: string, err: unknown) => CoverageTier;
}

/**
 * Cross-check every CFn type against the registered SDK Provider set
 * and classify into the three tiers. Returns a finalised `CoverageReport`
 * with the type lists sorted alphabetically for diff-friendly output.
 */
export async function partitionCoverage(
  client: CfnClientLike,
  registeredTypes: Set<string>,
  allTypes: Iterable<string>,
  options: PartitionOptions = {}
): Promise<CoverageReport> {
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  const limit = pLimit(concurrency);
  const onError =
    options.onError ??
    ((typeName: string, err: unknown): CoverageTier => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[audit] DescribeType failed for ${typeName}: ${msg}; treating as Tier 3`);
      return 'tier3-unsupported';
    });

  const tier1: string[] = [];
  const nonTier1: string[] = [];
  for (const typeName of allTypes) {
    if (registeredTypes.has(typeName)) {
      tier1.push(typeName);
    } else {
      nonTier1.push(typeName);
    }
  }

  const tier2: string[] = [];
  const tier3: string[] = [];
  let done = 0;
  await Promise.all(
    nonTier1.map((typeName) =>
      limit(async () => {
        let tier: CoverageTier;
        try {
          const provisioningType = await describeTypeWithRetry(client, typeName, {
            ...(options.retryDelaysMs && { retryDelaysMs: options.retryDelaysMs }),
            ...(options.sleep && { sleep: options.sleep }),
          });
          tier = classifyProvisioningType(provisioningType);
        } catch (err) {
          tier = onError(typeName, err);
        }
        if (tier === 'tier2-cc-api-fallback') {
          tier2.push(typeName);
        } else {
          tier3.push(typeName);
        }
        done++;
        options.onProgress?.(done, nonTier1.length, typeName, tier);
      })
    )
  );

  tier1.sort();
  tier2.sort();
  tier3.sort();

  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    summary: {
      tier1Count: tier1.length,
      tier2Count: tier2.length,
      tier3Count: tier3.length,
      totalCount: tier1.length + tier2.length + tier3.length,
    },
    tier1,
    tier2,
    tier3,
  };
}

/**
 * Render a human-readable Markdown report. Intentionally simple — the
 * JSON file is the machine source-of-truth and tooling should read that;
 * this view is for at-a-glance review in PRs and on GitHub.
 */
export function renderMarkdown(report: CoverageReport): string {
  const lines: string[] = [];
  lines.push('# Provider Coverage Report');
  lines.push('');
  lines.push(
    'Auto-generated by `scripts/audit-provider-coverage.ts`. Do not edit by hand; ' +
      're-run the script to regenerate.'
  );
  lines.push('');
  lines.push(`- Generated: \`${report.generatedAt}\``);
  lines.push(`- Schema version: ${report.schemaVersion}`);
  lines.push(`- Total CFn resource types audited: **${report.summary.totalCount}**`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push('| Tier | Provisioning path | Count |');
  lines.push('|------|-------------------|-------|');
  lines.push(`| **Tier 1** | SDK Provider (preferred) | ${report.summary.tier1Count} |`);
  lines.push(`| **Tier 2** | Cloud Control API fallback | ${report.summary.tier2Count} |`);
  lines.push(`| **Tier 3** | Not provisionable by cdkd today | ${report.summary.tier3Count} |`);
  lines.push('');
  lines.push('## Tier 1 — SDK Provider registered');
  lines.push('');
  lines.push(
    'Direct SDK calls via `src/provisioning/register-providers.ts`. Fastest, ' +
      'drift-aware, and shape-stable on reads. This is the canonical path; new ' +
      'high-traffic types should land here.'
  );
  lines.push('');
  for (const type of report.tier1) {
    lines.push(`- \`${type}\``);
  }
  lines.push('');
  lines.push('## Tier 2 — Cloud Control API fallback');
  lines.push('');
  lines.push(
    'No dedicated SDK Provider, but `ProvisioningType` is `FULLY_MUTABLE` or ' +
      '`IMMUTABLE`. cdkd routes these through the generic Cloud Control API today ' +
      '— deployable, but slower (async polling) and shape-divergent on reads ' +
      '(see `CC_API_FALLBACK_DENY_LIST` for known drift offenders). Frequency-' +
      'weighted picks from this list are the next candidates for dedicated providers.'
  );
  lines.push('');
  for (const type of report.tier2) {
    lines.push(`- \`${type}\``);
  }
  lines.push('');
  lines.push('## Tier 3 — Not provisionable by cdkd today');
  lines.push('');
  lines.push(
    '`ProvisioningType` is `NON_PROVISIONABLE` (or DescribeType failed). ' +
      'Cloud Control API cannot create / update / delete these types; cdkd ' +
      'cannot support them at all without a dedicated SDK Provider. Most entries ' +
      'here are inherently read-only or registry-only types (`AWS::*::*Type`, ' +
      'data-only resources, etc.) and are NOT realistic targets for a provider.'
  );
  lines.push('');
  for (const type of report.tier3) {
    lines.push(`- \`${type}\``);
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Atomic write: stage to `<path>.tmp`, fsync via rename. Prevents the
 * audit's output from being half-written if the process is killed
 * mid-write (the CFn API calls take long enough for ^C to be plausible).
 */
export function atomicWriteFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  try {
    writeFileSync(tmp, content);
    renameSync(tmp, path);
  } catch (err) {
    // Best-effort cleanup of the partial .tmp so a half-written file
    // doesn't sit next to the canonical path masquerading as something
    // legitimate. Cleanup failure (e.g. file never created because
    // writeFileSync failed on EACCES) is swallowed — the original error
    // is what the caller needs to see.
    try {
      unlinkSync(tmp);
    } catch {
      // ignore
    }
    throw err;
  }
}

/** Read the cached report from `docs/_generated/provider-coverage.json`. */
export function loadCachedReport(path: string): CoverageReport {
  const raw = readFileSync(path, 'utf8');
  const parsed = JSON.parse(raw) as CoverageReport;
  if (parsed.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(
      `cached report schema version ${parsed.schemaVersion} does not match ` +
        `expected ${SCHEMA_VERSION}; re-run with --regenerate`
    );
  }
  return parsed;
}

/**
 * Render a one-screen summary of a CoverageReport. Used by the default
 * (offline) CLI mode so users get an immediate view without scrolling
 * through hundreds of type names.
 */
export function renderSummaryToStdout(report: CoverageReport): string {
  const lines: string[] = [];
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Total CFn resource types: ${report.summary.totalCount}`);
  lines.push(`  Tier 1 (SDK Provider):       ${report.summary.tier1Count}`);
  lines.push(`  Tier 2 (CC API fallback):    ${report.summary.tier2Count}`);
  lines.push(`  Tier 3 (no support):         ${report.summary.tier3Count}`);
  return lines.join('\n');
}

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), '..');
const REGISTER_PROVIDERS_PATH = resolve(REPO_ROOT, 'src/provisioning/register-providers.ts');
const OUTPUT_JSON = resolve(REPO_ROOT, 'docs/_generated/provider-coverage.json');
const OUTPUT_MARKDOWN = resolve(REPO_ROOT, 'docs/_generated/provider-coverage.md');

async function regenerate(): Promise<void> {
  const source = readFileSync(REGISTER_PROVIDERS_PATH, 'utf8');
  const registered = parseRegisteredTypes(source);
  console.error(`[audit] parsed ${registered.size} registered SDK Providers`);

  // Route through the project's `getAwsClients()` factory rather than
  // instantiating `new CloudFormationClient({})` directly, so the audit
  // picks up the same region resolution / credential chain / future
  // `--role-arn` env-var plumbing as the rest of cdkd. The `.destroy()`
  // in the finally block releases the HTTP keep-alive sockets so a
  // short-lived script exits promptly under Node 24 (the SDK's default
  // Agent otherwise holds the event loop open for a few seconds).
  const client = getAwsClients().cloudFormation;
  try {
    console.error('[audit] enumerating public AWS CFn resource types via ListTypes...');
    const allTypes: string[] = [];
    for await (const typeName of paginateListTypes(client)) {
      allTypes.push(typeName);
      if (allTypes.length % 100 === 0) {
        console.error(`[audit] ListTypes: ${allTypes.length} types so far...`);
      }
    }
    console.error(`[audit] ListTypes complete: ${allTypes.length} total types`);

    const report = await partitionCoverage(client, registered, allTypes, {
      onProgress: (done, total) => {
        if (done % 25 === 0 || done === total) {
          console.error(`[audit] DescribeType: ${done}/${total}`);
        }
      },
    });

    atomicWriteFile(OUTPUT_JSON, JSON.stringify(report, null, 2) + '\n');
    atomicWriteFile(OUTPUT_MARKDOWN, renderMarkdown(report));
    console.error('[audit] wrote:');
    console.error(`  ${OUTPUT_JSON}`);
    console.error(`  ${OUTPUT_MARKDOWN}`);
    console.error(renderSummaryToStdout(report));
  } finally {
    client.destroy();
  }
}

export interface CliIO {
  readonly log: (msg: string) => void;
  readonly error: (msg: string) => void;
  /** Set when a check fails. The script's main process honours this via `process.exitCode`. */
  setExitCode(code: number): void;
}

const consoleIO: CliIO = {
  log: (msg) => console.log(msg),
  error: (msg) => console.error(msg),
  setExitCode: (code) => {
    process.exitCode = code;
  },
};

export function summarizeCachedReport(
  io: CliIO = consoleIO,
  jsonPath: string = OUTPUT_JSON
): void {
  let report: CoverageReport;
  try {
    report = loadCachedReport(jsonPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    io.error(`[audit] cannot read cached report: ${msg}`);
    io.error(`[audit] run \`node scripts/audit-provider-coverage.ts --regenerate\` first`);
    io.setExitCode(1);
    return;
  }
  io.log(renderSummaryToStdout(report));
}

/**
 * Cross-check the cached Tier 1 set against `register-providers.ts`.
 *
 * Fails (exit 1) when a contributor added a new provider without
 * regenerating the audit, or vice versa — the cached JSON would be
 * stale and the user-facing tier list would diverge from reality.
 * Offline by design: no AWS calls needed.
 */
export function checkCachedAgainstSource(
  cachedTier1: readonly string[],
  registeredFromSource: Set<string>
): { ok: boolean; missingFromCache: string[]; extraInCache: string[] } {
  const cacheSet = new Set(cachedTier1);
  const missingFromCache: string[] = [];
  const extraInCache: string[] = [];
  for (const t of registeredFromSource) {
    if (!cacheSet.has(t)) missingFromCache.push(t);
  }
  for (const t of cacheSet) {
    if (!registeredFromSource.has(t)) extraInCache.push(t);
  }
  missingFromCache.sort();
  extraInCache.sort();
  return { ok: missingFromCache.length === 0 && extraInCache.length === 0, missingFromCache, extraInCache };
}

export function runCheck(
  io: CliIO = consoleIO,
  jsonPath: string = OUTPUT_JSON,
  sourcePath: string = REGISTER_PROVIDERS_PATH
): void {
  let report: CoverageReport;
  try {
    report = loadCachedReport(jsonPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    io.error(`[audit] cannot read cached report: ${msg}`);
    io.error(`[audit] run \`node scripts/audit-provider-coverage.ts --regenerate\` first`);
    io.setExitCode(1);
    return;
  }
  const source = readFileSync(sourcePath, 'utf8');
  const registered = parseRegisteredTypes(source);
  const result = checkCachedAgainstSource(report.tier1, registered);
  if (result.ok) {
    io.log(
      `Cached Tier 1 (${report.tier1.length} types) matches register-providers.ts (${registered.size} types).`
    );
    return;
  }
  if (result.missingFromCache.length > 0) {
    io.error('[audit] register-providers.ts registers types NOT in the cached Tier 1:');
    for (const t of result.missingFromCache) io.error(`  - ${t}`);
  }
  if (result.extraInCache.length > 0) {
    io.error('[audit] cached Tier 1 contains types NOT in register-providers.ts:');
    for (const t of result.extraInCache) io.error(`  - ${t}`);
  }
  io.error('[audit] regenerate the audit to resolve:');
  io.error('         node scripts/audit-provider-coverage.ts --regenerate');
  io.setExitCode(1);
}

/**
 * Parse CLI args into a discriminated mode. Mutually-exclusive flags
 * (`--regenerate` + `--check`) are rejected at parse time rather than
 * silently picking one — pre-PR-#401-follow-up the precedence was
 * undocumented and `--check` was simply swallowed when both were set.
 *
 * Exported for unit testing.
 */
export type CliMode =
  | { kind: 'help' }
  | { kind: 'summary' }
  | { kind: 'regenerate' }
  | { kind: 'check' }
  | { kind: 'error'; message: string };

export function parseCliArgs(args: readonly string[]): CliMode {
  if (args.includes('--help') || args.includes('-h')) return { kind: 'help' };
  const wantRegenerate = args.includes('--regenerate');
  const wantCheck = args.includes('--check');
  if (wantRegenerate && wantCheck) {
    return {
      kind: 'error',
      message: '--regenerate and --check are mutually exclusive; pass at most one',
    };
  }
  if (wantRegenerate) return { kind: 'regenerate' };
  if (wantCheck) return { kind: 'check' };
  return { kind: 'summary' };
}

const HELP_TEXT = [
  'Usage: node scripts/audit-provider-coverage.ts [--regenerate | --check]',
  '',
  '  (no flags)     Read the cached report and print a summary.',
  '  --regenerate   Call AWS to enumerate every public CFn resource type,',
  '                 cross-check against cdkd-registered SDK Providers, and',
  '                 rewrite docs/_generated/provider-coverage.{json,md}.',
  '                 Requires AWS credentials with cloudformation:ListTypes',
  '                 and cloudformation:DescribeType. ~10-30 minutes cold.',
  '  --check        Verify the cached Tier 1 list matches the current',
  '                 src/provisioning/register-providers.ts. Exits 1 on',
  '                 drift; intended for CI gates / pre-commit hooks.',
  '                 Offline (no AWS calls).',
].join('\n');

async function main(): Promise<void> {
  const mode = parseCliArgs(process.argv.slice(2));
  switch (mode.kind) {
    case 'help':
      console.log(HELP_TEXT);
      return;
    case 'error':
      console.error(`[audit] ${mode.message}`);
      console.error(HELP_TEXT);
      process.exitCode = 1;
      return;
    case 'regenerate':
      await regenerate();
      return;
    case 'check':
      runCheck();
      return;
    case 'summary':
      summarizeCachedReport();
      return;
  }
}

/**
 * Detect whether this module is the CLI entry point (vs imported from
 * a test). Exported for unit testing so the CLI dispatch can be
 * exercised without spawning a subprocess.
 */
export function isMainModule(argv1: string | undefined, scriptPath: string): boolean {
  if (!argv1) return false;
  return resolve(argv1) === scriptPath;
}

if (isMainModule(process.argv[1], __filename)) {
  main().catch((err) => {
    console.error('[audit] fatal:', err);
    process.exit(1);
  });
}
