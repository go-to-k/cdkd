/**
 * Shared helpers for the SDK Provider property-coverage test
 * (`property-coverage.test.ts`).
 *
 * The test compares every registered SDK provider's `handledProperties` set
 * against the canonical CFn schema property list snapshot in
 * `tests/fixtures/cfn-schemas/<sanitized-type>.json`, classifying every
 * schema property into one of:
 *
 *   - handled         — in provider.handledProperties.get(type)
 *   - by-design       — in provider.unhandledByDesign.get(type) (with rationale)
 *   - backfill        — in tests/fixtures/cfn-schemas/_todo-backfill.json
 *                       (per-type opt-in for incremental rollout)
 *   - read-only       — flagged read-only in the schema (AWS-managed,
 *                       not user-controllable on Create/Update)
 *   - unaccounted     — none of the above → test fails
 *
 * The TODO backfill exists so the rule is enforceable on day 1 without a
 * massive coordinated cleanup. As `unhandledByDesign` entries are added
 * (with rationales), the corresponding backfill entries shrink.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURES_DIR = join(__dirname, '..', '..', 'fixtures', 'cfn-schemas');
const BACKFILL_PATH = join(FIXTURES_DIR, '_todo-backfill.json');

export interface SchemaFixture {
  resourceType: string;
  generatedAt: string;
  properties: string[];
  readOnlyProperties: string[];
  createOnlyProperties: string[];
}

export type BackfillMap = Record<string, string[]>;

/**
 * Per-type rationale map for `unhandledByDesign`-like entries that the
 * coverage test should NOT report as "bogus" even though they don't appear
 * in the CFn schema. Common reasons:
 *   - SDK-only request-shaping field (e.g. `ClientToken`) that the provider
 *     intentionally passes to the API but is never user-facing on the
 *     template.
 *   - Provider author predates the schema property rename (e.g. `Cooldown`
 *     was once `DefaultCooldown`); fix is queued as a separate PR.
 *   - Schema lists the field as nested while the provider keeps the
 *     flattened name from the SDK; ditto.
 *
 * Each entry is a one-line rationale string explaining why it stays
 * tolerated rather than fixed in this PR. Investigate + retire over time.
 */
export type BogusToleranceMap = Record<string, Record<string, string>>;

/**
 * Sanitize a CFn type name to its fixture filename. Mirror of the
 * `fixtureFilename` function in `scripts/refresh-cfn-schemas.mjs`.
 */
export function fixtureFilename(resourceType: string): string {
  return resourceType.replace(/::/g, '-') + '.json';
}

/**
 * Load the schema fixture for a resource type. Returns `undefined` when the
 * fixture file is missing — caller decides whether that's a hard error.
 */
export function loadSchemaFixture(resourceType: string): SchemaFixture | undefined {
  const path = join(FIXTURES_DIR, fixtureFilename(resourceType));
  if (!existsSync(path)) {
    return undefined;
  }
  const raw = readFileSync(path, 'utf8');
  return JSON.parse(raw) as SchemaFixture;
}

/**
 * Load the per-type backfill TODO map. Missing file → empty.
 */
export function loadBackfillMap(): BackfillMap {
  if (!existsSync(BACKFILL_PATH)) {
    return {};
  }
  const raw = readFileSync(BACKFILL_PATH, 'utf8');
  const parsed = JSON.parse(raw) as { _comment?: unknown; types?: BackfillMap };
  return parsed.types ?? {};
}

/**
 * Load the per-type bogus-tolerance map. Missing file → empty.
 * See `BogusToleranceMap` doc for what counts as a tolerable bogus entry.
 */
export function loadBogusToleranceMap(): BogusToleranceMap {
  if (!existsSync(BACKFILL_PATH)) {
    return {};
  }
  const raw = readFileSync(BACKFILL_PATH, 'utf8');
  const parsed = JSON.parse(raw) as { bogusTolerated?: BogusToleranceMap };
  return parsed.bogusTolerated ?? {};
}

/**
 * Diagnostic shape returned by `classifyCoverage` so the test can format a
 * single clear error message per offending type.
 */
export interface CoverageClassification {
  resourceType: string;
  handled: string[];
  byDesign: string[];
  backfill: string[];
  readOnly: string[];
  unaccounted: string[];
  /** Entries in handledProperties / unhandledByDesign that AREN'T in the schema. */
  bogus: string[];
}

/**
 * Classify every schema property for a given (provider, resourceType) pair.
 * The four "OK" buckets are non-overlapping by construction (handled wins
 * over by-design wins over backfill wins over read-only); unaccounted is
 * whatever's left.
 */
export function classifyCoverage(args: {
  resourceType: string;
  schemaProperties: string[];
  readOnlyProperties: string[];
  handledProperties: ReadonlySet<string> | undefined;
  unhandledByDesign: ReadonlyMap<string, string> | undefined;
  backfillProperties: string[] | undefined;
  bogusTolerated: Record<string, string> | undefined;
}): CoverageClassification {
  const {
    resourceType,
    schemaProperties,
    readOnlyProperties,
    handledProperties,
    unhandledByDesign,
    backfillProperties,
    bogusTolerated,
  } = args;

  const schemaSet = new Set(schemaProperties);
  const readOnlySet = new Set(readOnlyProperties);
  const backfillSet = new Set(backfillProperties ?? []);
  const toleratedBogusSet = new Set(Object.keys(bogusTolerated ?? {}));

  const handled: string[] = [];
  const byDesign: string[] = [];
  const backfill: string[] = [];
  const readOnly: string[] = [];
  const unaccounted: string[] = [];

  for (const prop of schemaProperties) {
    if (handledProperties?.has(prop)) {
      handled.push(prop);
    } else if (unhandledByDesign?.has(prop)) {
      byDesign.push(prop);
    } else if (backfillSet.has(prop)) {
      backfill.push(prop);
    } else if (readOnlySet.has(prop)) {
      readOnly.push(prop);
    } else {
      unaccounted.push(prop);
    }
  }

  // "Bogus" entries: provider declared a property name that doesn't appear
  // in the CFn schema (typo / since-removed / made-up). The test surfaces
  // these so they get cleaned up. Entries listed in `bogusTolerated` (with
  // a rationale) are excluded so the test stays green while a separate
  // follow-up addresses each properly.
  const bogus: string[] = [];
  if (handledProperties) {
    for (const p of handledProperties) {
      if (!schemaSet.has(p) && !toleratedBogusSet.has(p)) {
        bogus.push(`handledProperties:${p}`);
      }
    }
  }
  if (unhandledByDesign) {
    for (const p of unhandledByDesign.keys()) {
      if (!schemaSet.has(p) && !toleratedBogusSet.has(p)) {
        bogus.push(`unhandledByDesign:${p}`);
      }
    }
  }
  for (const p of backfillSet) {
    if (!schemaSet.has(p) && !toleratedBogusSet.has(p)) {
      bogus.push(`backfill:${p}`);
    }
  }

  return {
    resourceType,
    handled,
    byDesign,
    backfill,
    readOnly,
    unaccounted,
    bogus,
  };
}

/**
 * List the fixture filenames present on disk. Used by the test to detect
 * stale fixtures (fixture file but no longer registered as a provider).
 */
export function listFixtureFilenames(): string[] {
  if (!existsSync(FIXTURES_DIR)) return [];
  return readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
    .sort();
}

/**
 * Format a CoverageClassification for the test failure message. Compact
 * enough to scan, detailed enough to act on without re-running.
 */
export function formatClassification(c: CoverageClassification): string {
  const lines: string[] = [];
  lines.push(`Coverage gap on ${c.resourceType}:`);
  if (c.unaccounted.length > 0) {
    lines.push(`  unaccounted (${c.unaccounted.length}): ${c.unaccounted.join(', ')}`);
    lines.push(
      `    Add each to either:`,
      `      (a) provider.handledProperties (if create/update actually wires the field), or`,
      `      (b) provider.unhandledByDesign (with a one-line rationale), or`,
      `      (c) tests/fixtures/cfn-schemas/_todo-backfill.json under "${c.resourceType}"`,
      `          (allowed only for incremental backfill — must be migrated to (a) or (b) eventually)`
    );
  }
  if (c.bogus.length > 0) {
    lines.push(`  bogus (${c.bogus.length}): ${c.bogus.join(', ')}`);
    lines.push(`    Each entry was declared by the provider/backfill but is NOT in the CFn schema.`);
    lines.push(`    Either fix the typo or remove the stale entry.`);
  }
  return lines.join('\n');
}
