/**
 * SDK Provider property-coverage check (issue #391).
 *
 * For every type registered via `registerAllProviders`, this test compares
 * the provider's declared `handledProperties` set against the canonical CFn
 * schema snapshot in `tests/fixtures/cfn-schemas/<sanitized-type>.json` and
 * fails when a schema property is neither:
 *   (a) in `provider.handledProperties.get(type)`, or
 *   (b) in `provider.unhandledByDesign.get(type)` (with a one-line rationale), or
 *   (c) in the per-type backfill TODO at
 *       `tests/fixtures/cfn-schemas/_todo-backfill.json` (allowed for
 *       incremental rollout — must be migrated to (a) or (b) over time), or
 *   (d) marked read-only in the schema (AWS-managed; cannot be wired to
 *       Create/Update by definition).
 *
 * Also enforces:
 *   - No "bogus" entries (properties in handledProperties / unhandledByDesign /
 *     backfill that are NOT in the schema → typos or since-removed fields).
 *   - No stale fixtures on disk (a fixture file whose type is no longer
 *     registered surfaces as a soft warning via a separate test).
 *
 * The bug class this prevents: PR #370 series — `ApiGatewayProvider.createMethod`
 * silently dropped 15+ properties from `PutMethodCommand` / `PutIntegrationCommand`
 * input because the field was simply missing from the input builder AND from
 * `handledProperties`. Users hit `Invalid ResponseTransferMode` on real AWS —
 * only fixed reactively after a user report.
 *
 * Schemas are refreshed via `node scripts/refresh-cfn-schemas.mjs` (requires
 * AWS credentials with `cloudformation:DescribeType`). The fixtures commit
 * only the property name list (not the full schema body) so each is ~1KB.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vite-plus/test';
import { ProviderRegistry } from '../../../src/provisioning/provider-registry.js';
import { registerAllProviders } from '../../../src/provisioning/register-providers.js';
import {
  classifyCoverage,
  fixtureFilename,
  formatClassification,
  listFixtureFilenames,
  loadBackfillMap,
  loadBogusToleranceMap,
  loadSchemaFixture,
} from './_property-coverage-utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const BACKFILL_PATH = join(__dirname, '..', '..', 'fixtures', 'cfn-schemas', '_todo-backfill.json');

const registry = new ProviderRegistry();
registerAllProviders(registry);
const registeredTypes = registry.getRegisteredTypes().sort();

// Dev-time generator: when `CDKD_GENERATE_BACKFILL=true`, the test computes
// the per-type unaccounted-property set and writes it to the backfill TODO
// file. Used to bootstrap the file on day 1 of issue #391 and to regenerate
// it after AWS publishes new properties.
//
// In normal test runs the env var is unset, so this branch is skipped and
// the tests below enforce the coverage rule against the committed backfill.
if (process.env.CDKD_GENERATE_BACKFILL === 'true') {
  const backfillTypes: Record<string, string[]> = {};
  let totalGap = 0;
  for (const resourceType of registeredTypes) {
    const fixture = loadSchemaFixture(resourceType);
    if (!fixture) continue;
    const provider = registry.getProvider(resourceType);
    const handled = provider.handledProperties?.get(resourceType);
    const byDesign = provider.unhandledByDesign?.get(resourceType);
    const readOnly = new Set(fixture.readOnlyProperties);
    const gap: string[] = [];
    for (const prop of fixture.properties) {
      if (handled?.has(prop)) continue;
      if (byDesign?.has(prop)) continue;
      if (readOnly.has(prop)) continue;
      gap.push(prop);
    }
    if (gap.length > 0) {
      backfillTypes[resourceType] = gap.sort();
      totalGap += gap.length;
    }
  }
  // Preserve any existing bogusTolerated block — those entries are manually
  // curated (each carries a one-line rationale string) and the generator
  // never touches them. If the file does not exist yet, start with an empty
  // tolerance block.
  let existingBogusTolerated: Record<string, Record<string, string>> = {};
  if (existsSync(BACKFILL_PATH)) {
    try {
      const existing = JSON.parse(readFileSync(BACKFILL_PATH, 'utf8')) as {
        bogusTolerated?: Record<string, Record<string, string>>;
      };
      existingBogusTolerated = existing.bogusTolerated ?? {};
    } catch {
      // Malformed file — ignore and regenerate fresh.
    }
  }
  const file = {
    _comment: [
      'Per-type backfill TODO for the SDK Provider property-coverage test',
      '(`tests/unit/provisioning/property-coverage.test.ts`, issue #391).',
      '',
      '`types` lists CFn schema properties NOT yet covered by the provider\'s',
      'handledProperties or unhandledByDesign for that type. Auto-generated:',
      '  CDKD_GENERATE_BACKFILL=true vp test run property-coverage',
      '',
      'How to retire a `types` entry:',
      "  1. If the provider's create()/update() ALREADY wires the property",
      '     to the SDK call, add it to handledProperties.get(type).',
      '  2. If the provider intentionally does NOT wire it (create-only,',
      '     deprecated, covered by a separate resource, etc.), add it to',
      '     unhandledByDesign.get(type) with a one-line rationale.',
      '  3. Remove the entry from this file.',
      '',
      '`bogusTolerated` lists properties the provider DECLARES in',
      'handledProperties (or unhandledByDesign) but that the CFn schema does',
      'NOT have. Typically SDK-only request fields (e.g. ClientToken) or',
      "stale aliases the provider author predated the schema rename. Each",
      'entry MUST carry a one-line rationale; the section is preserved across',
      'regenerations of the `types` block.',
    ],
    types: backfillTypes,
    bogusTolerated: existingBogusTolerated,
  };
  writeFileSync(BACKFILL_PATH, JSON.stringify(file, null, 2) + '\n', 'utf8');
  // Use console.log directly so the message survives vitest's stdout
  // filtering; the user invokes this branch explicitly so the chatter is
  // intentional.
  console.log(
    `[property-coverage] wrote ${BACKFILL_PATH}: ${Object.keys(backfillTypes).length} type(s), ${totalGap} property/ies`
  );
}

const backfill = loadBackfillMap();
const bogusTolerance = loadBogusToleranceMap();

describe('SDK Provider property coverage', () => {
  // Sanity: every registered type must have a schema fixture on disk.
  // Missing fixture → run `node scripts/refresh-cfn-schemas.mjs --only-missing`.
  it('every registered type has a schema fixture', () => {
    const missing = registeredTypes.filter((t) => loadSchemaFixture(t) === undefined);
    expect(
      missing,
      missing.length > 0
        ? `Missing schema fixtures for ${missing.length} type(s): ${missing.join(', ')}.\n` +
            `Run: node scripts/refresh-cfn-schemas.mjs --only-missing`
        : ''
    ).toEqual([]);
  });

  // Per-type gap classification.
  for (const resourceType of registeredTypes) {
    it(`${resourceType}: every CFn schema property is accounted for`, () => {
      const fixture = loadSchemaFixture(resourceType);
      if (!fixture) {
        // Covered by the sanity test above; skip the assertion here so the
        // failure points at the right place.
        return;
      }
      const provider = registry.getProvider(resourceType);
      const handled = provider.handledProperties?.get(resourceType);
      const byDesign = provider.unhandledByDesign?.get(resourceType);
      const backfillProps = backfill[resourceType];

      const c = classifyCoverage({
        resourceType,
        schemaProperties: fixture.properties,
        readOnlyProperties: fixture.readOnlyProperties,
        handledProperties: handled,
        unhandledByDesign: byDesign,
        backfillProperties: backfillProps,
        bogusTolerated: bogusTolerance[resourceType],
      });

      const failed = c.unaccounted.length > 0 || c.bogus.length > 0;
      expect(failed, formatClassification(c)).toBe(false);
    });
  }

  // Stale fixture detection — a file on disk for a since-removed provider.
  // Soft: report at most so the operator can clean up; do not fail the suite
  // because the fixture is still parseable and harmless.
  it('no stale fixture files for unregistered types', () => {
    const registeredFilenames = new Set(registeredTypes.map(fixtureFilename));
    const onDisk = listFixtureFilenames();
    const stale = onDisk.filter((f) => !registeredFilenames.has(f));
    expect(
      stale,
      stale.length > 0
        ? `Stale schema fixtures (provider unregistered): ${stale.join(', ')}.\n` +
            `Delete from tests/fixtures/cfn-schemas/ if the provider is intentionally gone.`
        : ''
    ).toEqual([]);
  });

  // Backfill scope guard — every entry in the TODO file must correspond to
  // an actually-registered type. Catches typos and types renamed without
  // updating the TODO file.
  it('every backfill entry corresponds to a registered type', () => {
    const registeredSet = new Set(registeredTypes);
    const unknown = Object.keys(backfill).filter((t) => !registeredSet.has(t));
    expect(
      unknown,
      unknown.length > 0
        ? `Backfill TODO references ${unknown.length} unregistered type(s): ${unknown.join(', ')}.\n` +
            `Remove these entries from tests/fixtures/cfn-schemas/_todo-backfill.json.`
        : ''
    ).toEqual([]);
  });

  // Guard against silent backfill-bloat: the TODO file is meant to shrink
  // over time. This test does not enforce a numeric ceiling (would create
  // merge conflicts on every covered property), but does require any
  // newly-added type to start with `unhandledByDesign` rationales unless
  // explicitly added to the backfill via this test's caller.
  // The actual enforcement is the classifyCoverage check above — unaccounted
  // = fail. This is just a sanity test that the backfill file is parseable.
  it('backfill TODO file is a valid {types: {type: [props]}} shape', () => {
    for (const [type, props] of Object.entries(backfill)) {
      expect(Array.isArray(props), `backfill[${type}] must be a string array`).toBe(true);
      for (const prop of props) {
        expect(typeof prop, `backfill[${type}] entries must be strings`).toBe('string');
      }
    }
  });

  // Bogus-tolerance entries must (a) reference a registered type and
  // (b) carry a non-empty rationale. The rationale is what makes the
  // tolerance auditable — without it the entry is indistinguishable
  // from a bug nobody investigated.
  it('every bogus-tolerated entry is well-formed', () => {
    const registeredSet = new Set(registeredTypes);
    const problems: string[] = [];
    for (const [type, entries] of Object.entries(bogusTolerance)) {
      if (!registeredSet.has(type)) {
        problems.push(`bogusTolerated.${type}: not a registered type`);
        continue;
      }
      if (entries === null || typeof entries !== 'object') {
        problems.push(`bogusTolerated.${type}: must be an object`);
        continue;
      }
      for (const [propName, rationale] of Object.entries(entries)) {
        if (typeof rationale !== 'string' || rationale.trim().length === 0) {
          problems.push(`bogusTolerated.${type}.${propName}: rationale must be a non-empty string`);
        }
      }
    }
    expect(problems, problems.join('\n')).toEqual([]);
  });

  // Staleness guard: when AWS later adds a property previously listed in
  // `bogusTolerated[type][prop]`, the entry silently sits in the JSON unused —
  // the schema now has the property, so the coverage classifier finds it via
  // `handled` / `unaccounted` paths, and the `bogusTolerated` rationale is
  // never consulted again. The rationale becomes a lie and should be removed.
  // This surfaces those dead rationales explicitly so they get cleaned up.
  it('no bogus-tolerated entry has become stale (schema now contains the property)', () => {
    const stale: string[] = [];
    for (const [type, entries] of Object.entries(bogusTolerance)) {
      const fixture = loadSchemaFixture(type);
      if (!fixture) continue; // covered by an earlier test
      const schemaSet = new Set(fixture.properties);
      for (const prop of Object.keys(entries)) {
        if (schemaSet.has(prop)) {
          stale.push(
            `bogusTolerated.${type}.${prop} — property is NOW in the CFn schema; remove the tolerance entry`
          );
        }
      }
    }
    expect(stale, stale.join('\n')).toEqual([]);
  });
});
