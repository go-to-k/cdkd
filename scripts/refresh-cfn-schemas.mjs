#!/usr/bin/env node
// @ts-check

/**
 * Refresh CFn schema property-name fixtures for the SDK Provider coverage test.
 *
 * For each resource type registered via `registerAllProviders` in
 * `src/provisioning/register-providers.ts`, this script:
 *   1. Calls `cloudformation:DescribeType` (RESOURCE) to fetch the canonical
 *      AWS-published schema.
 *   2. Extracts the top-level `properties` keys (mirrors what the deploy
 *      engine's `selectProviderWithSafetyNet` compares against).
 *   3. Writes a small JSON fixture at
 *      `tests/fixtures/cfn-schemas/<sanitized-type>.json` containing the
 *      property name array — NOT the full schema. Keeps fixtures < 2KB each.
 *
 * Re-run on demand when:
 *   - A new provider is added → fetches the new type's schema.
 *   - AWS publishes new properties on an existing type → diff surfaces as a
 *     gap in `tests/unit/provisioning/property-coverage.test.ts`.
 *
 * Requires AWS credentials with `cloudformation:DescribeType` permission
 * (read-only). Defaults to `us-east-1` since `AWS::*` schemas are
 * region-agnostic; override with `AWS_REGION` if your credentials are pinned
 * elsewhere.
 *
 * Concurrency is capped at 8 in-flight DescribeType calls to be polite to
 * the CFn registry; the full sweep typically completes in 30-60 seconds.
 */

import {
  CloudFormationClient,
  DescribeTypeCommand,
} from '@aws-sdk/client-cloudformation';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const REGISTER_PROVIDERS_PATH = join(
  REPO_ROOT,
  'src/provisioning/register-providers.ts'
);
const FIXTURES_DIR = join(REPO_ROOT, 'tests/fixtures/cfn-schemas');
// CloudFormation DescribeType is aggressively throttled per-account
// (~10 RPS measured); keep concurrency low and let withRetry handle the rest.
const CONCURRENCY = 3;
const MAX_RETRIES = 6;

/**
 * Convert a CFn resource type to a filesystem-safe filename.
 * `AWS::Lambda::Function` → `AWS-Lambda-Function.json`
 *
 * @param {string} type
 * @returns {string}
 */
export function fixtureFilename(type) {
  return type.replace(/::/g, '-') + '.json';
}

/**
 * Statically scan `register-providers.ts` for `registry.register('AWS::...')`
 * patterns. Avoids importing the TS source (no tsx dep) and avoids requiring
 * a prior `vp run build` step.
 *
 * @param {string} source
 * @returns {string[]}
 */
export function extractRegisteredTypes(source) {
  const re = /registry\.register\(\s*['"]([A-Z][\w:]+)['"]/g;
  const types = new Set();
  let m;
  while ((m = re.exec(source)) !== null) {
    types.add(m[1]);
  }
  return Array.from(types).sort();
}

/**
 * Parse the CFn schema JSON returned by DescribeType and pull the top-level
 * property name list. The deploy engine's safety net compares against the
 * template's top-level property keys, so that is the right level of
 * granularity for this fixture.
 *
 * @param {string} schemaJson
 * @returns {string[]}
 */
export function extractTopLevelProperties(schemaJson) {
  /** @type {{properties?: Record<string, unknown>, readOnlyProperties?: string[]}} */
  const schema = JSON.parse(schemaJson);
  if (!schema.properties || typeof schema.properties !== 'object') {
    return [];
  }
  return Object.keys(schema.properties).sort();
}

/**
 * Extract the per-type read-only property list (CFn-side: properties AWS
 * computes and returns but never accepts as input). Saved alongside the
 * full property list so the coverage test can EXCLUDE them from the "gap"
 * — providers cannot wire a read-only property to a Create/Update call by
 * definition.
 *
 * Schema entries are JSON-pointer paths like `/properties/Arn`; we strip
 * the prefix and filter to top-level paths only.
 *
 * @param {string} schemaJson
 * @returns {string[]}
 */
export function extractReadOnlyProperties(schemaJson) {
  /** @type {{readOnlyProperties?: string[]}} */
  const schema = JSON.parse(schemaJson);
  if (!Array.isArray(schema.readOnlyProperties)) {
    return [];
  }
  return schema.readOnlyProperties
    .filter((p) => typeof p === 'string' && p.startsWith('/properties/'))
    .map((p) => p.replace(/^\/properties\//, ''))
    .filter((p) => !p.includes('/')) // top-level only
    .sort();
}

/**
 * Extract the per-type create-only property list (immutable on update —
 * AWS rejects modify calls). Surfaced so the coverage test report can
 * annotate them in the gap output.
 *
 * @param {string} schemaJson
 * @returns {string[]}
 */
export function extractCreateOnlyProperties(schemaJson) {
  /** @type {{createOnlyProperties?: string[]}} */
  const schema = JSON.parse(schemaJson);
  if (!Array.isArray(schema.createOnlyProperties)) {
    return [];
  }
  return schema.createOnlyProperties
    .filter((p) => typeof p === 'string' && p.startsWith('/properties/'))
    .map((p) => p.replace(/^\/properties\//, ''))
    .filter((p) => !p.includes('/'))
    .sort();
}

/**
 * Extract the per-type primary-identifier property list (the property names
 * whose values together form the CC-API physicalId). cdkd's intrinsic resolver
 * resolves a `Fn::GetAtt` against the primaryIdentifier correctly via the
 * physicalId fallback, so a readOnly attribute that IS the primaryIdentifier
 * does NOT need enrichment — consumed by scripts/gen-enrichment-coverage.ts to
 * auto-classify those as not-a-gap instead of requiring a hand-written
 * ENRICHMENT_ALLOW_LIST entry per type. Same top-level JSON-pointer stripping
 * as the read-only / create-only extractors above.
 *
 * @param {string} schemaJson
 * @returns {string[]}
 */
export function extractPrimaryIdentifier(schemaJson) {
  /** @type {{primaryIdentifier?: string[]}} */
  const schema = JSON.parse(schemaJson);
  if (!Array.isArray(schema.primaryIdentifier)) {
    return [];
  }
  return schema.primaryIdentifier
    .filter((p) => typeof p === 'string' && p.startsWith('/properties/'))
    .map((p) => p.replace(/^\/properties\//, ''))
    .filter((p) => !p.includes('/'))
    .sort();
}

/**
 * Retry on CloudFormation's throttling shape ("Rate exceeded" / HTTP 429).
 * Exponential backoff with jitter, 1s -> 2s -> 4s -> 8s -> 16s -> 32s.
 *
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withRetry(fn) {
  let lastErr;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      const code =
        err && typeof err === 'object' && 'name' in err ? String(err.name) : '';
      const status =
        err && typeof err === 'object' && '$metadata' in err
          ? /** @type {{httpStatusCode?: number}} */ (err.$metadata)?.httpStatusCode
          : undefined;
      const retryable =
        /Rate exceeded|Throttl|TooManyRequests/i.test(msg) ||
        /Throttl/i.test(code) ||
        status === 429 ||
        status === 503;
      if (!retryable || attempt === MAX_RETRIES - 1) {
        throw err;
      }
      const baseMs = 1000 * 2 ** attempt;
      const jitterMs = Math.floor(Math.random() * 500);
      await new Promise((r) => setTimeout(r, baseMs + jitterMs));
    }
  }
  throw lastErr;
}

/**
 * Process a single resource type: fetch schema, parse, write fixture.
 * Returns the outcome for the summary report.
 *
 * @param {CloudFormationClient} client
 * @param {string} resourceType
 * @returns {Promise<{type: string, ok: true, propertyCount: number} | {type: string, ok: false, error: string}>}
 */
async function processType(client, resourceType) {
  try {
    const resp = await withRetry(() =>
      client.send(new DescribeTypeCommand({ Type: 'RESOURCE', TypeName: resourceType }))
    );
    if (!resp.Schema) {
      return { type: resourceType, ok: false, error: 'DescribeType returned no Schema field' };
    }
    const properties = extractTopLevelProperties(resp.Schema);
    const readOnlyProperties = extractReadOnlyProperties(resp.Schema);
    const createOnlyProperties = extractCreateOnlyProperties(resp.Schema);
    const primaryIdentifier = extractPrimaryIdentifier(resp.Schema);
    const fixture = {
      resourceType,
      // YYYY-MM-DD only so an unchanged schema produces an unchanged fixture
      // (full timestamp would churn the git diff on every refresh).
      generatedAt: new Date().toISOString().split('T')[0],
      properties,
      readOnlyProperties,
      createOnlyProperties,
      primaryIdentifier,
    };
    const path = join(FIXTURES_DIR, fixtureFilename(resourceType));
    await writeFile(path, JSON.stringify(fixture, null, 2) + '\n', 'utf8');
    return { type: resourceType, ok: true, propertyCount: properties.length };
  } catch (err) {
    return {
      type: resourceType,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Pool-based concurrent processor. Lighter than p-limit for a one-off script.
 *
 * @template T
 * @template R
 * @param {T[]} items
 * @param {number} concurrency
 * @param {(item: T) => Promise<R>} worker
 * @returns {Promise<R[]>}
 */
async function pooled(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function next() {
    while (cursor < items.length) {
      const idx = cursor++;
      results[idx] = await worker(items[idx]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, next));
  return results;
}

async function main() {
  const args = process.argv.slice(2);
  const typeFilter = args.find((a) => !a.startsWith('--'));
  const onlyMissing = args.includes('--only-missing');

  const source = await readFile(REGISTER_PROVIDERS_PATH, 'utf8');
  const allRegisteredTypes = extractRegisteredTypes(source);
  let types = allRegisteredTypes;
  if (typeFilter) {
    types = types.filter((t) => t === typeFilter || t.includes(typeFilter));
    if (types.length === 0) {
      console.error(`No registered type matched "${typeFilter}".`);
      process.exit(1);
    }
  }

  await mkdir(FIXTURES_DIR, { recursive: true });

  if (onlyMissing) {
    const existing = new Set(await readdir(FIXTURES_DIR));
    const before = types.length;
    types = types.filter((t) => !existing.has(fixtureFilename(t)));
    console.log(`--only-missing: ${before - types.length} fixture(s) already exist, fetching ${types.length}`);
  }

  console.log(`Refreshing CFn schemas for ${types.length} resource type(s)`);
  if (types.length === 0) {
    console.log('Nothing to do.');
    return;
  }

  const client = new CloudFormationClient({
    region: process.env.AWS_REGION || 'us-east-1',
  });

  const results = await pooled(types, CONCURRENCY, (type) => processType(client, type));

  const ok = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);

  console.log('');
  console.log(`✓ ${ok.length} schema(s) refreshed`);
  if (failed.length > 0) {
    console.error(`✗ ${failed.length} schema(s) failed:`);
    for (const f of failed) {
      console.error(`  - ${f.type}: ${'error' in f ? f.error : 'unknown'}`);
    }
    process.exit(2);
  }

  // Diff helper: list fixture files that exist on disk but are no longer
  // registered. The script does NOT delete them automatically — a fixture
  // file lingering for a since-removed provider is a signal worth surfacing
  // to the operator, not silently swept.
  // Files starting with `_` (e.g. `_todo-backfill.json`) are control
  // files maintained by the property-coverage test, not per-type fixtures.
  const onDisk = (await readdir(FIXTURES_DIR)).filter(
    (f) => f.endsWith('.json') && !f.startsWith('_')
  );
  const expected = new Set(allRegisteredTypes.map(fixtureFilename));
  const stale = onDisk.filter((f) => !expected.has(f));
  if (stale.length > 0) {
    console.log('');
    console.log('Stale fixture(s) — provider was unregistered. Delete manually:');
    for (const f of stale) {
      console.log(`  ${join('tests/fixtures/cfn-schemas', f)}`);
    }
  }
}

// Allow `import { extractRegisteredTypes } from '../../scripts/refresh-cfn-schemas.mjs'`
// in tests without running main().
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
