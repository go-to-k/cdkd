import { describe, it, expect } from 'vite-plus/test';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  ProviderRegistry,
  STICKY_CC_MIGRATION_EXEMPT,
  type StickyExemptEntry,
} from '../../../src/provisioning/provider-registry.js';
import { registerAllProviders } from '../../../src/provisioning/register-providers.js';

/**
 * Hygiene fence over the sticky-CC exemption table (issue #2719).
 *
 * The table's whole claim is that a type was admitted on EVIDENCE rather than
 * on an argument: physicalId parity between the Cloud Control handler and the
 * SDK provider is an empirical, per-type fact -- what CC mints as `Identifier`
 * versus what the provider stores as `physicalId` -- and it is false in
 * general. Asserting it from provider source is not the same as observing it
 * on a live resource.
 *
 * The `integFixture` assertions are what make that claim cost something. A
 * comment saying "parity verified" is free; an entry naming a fixture that
 * must EXIST and must have RUN cannot be added before its parity arm was
 * actually run against real AWS. That is the difference between a rule and a
 * request.
 *
 * What this deliberately does NOT do: judge freshness. A fixture that ran
 * eight months ago satisfies these assertions. Freshness is the `integ-destroy`
 * marker's 14-day TTL, and duplicating it here would red the unit suite for a
 * reason no code change caused.
 */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const LEDGER = join(repoRoot, 'docs', '_generated', 'integ-last-run.tsv');

/** Test names with at least one recorded run, from the committed ledger. */
function ledgerTestNames(): Set<string> {
  const rows = readFileSync(LEDGER, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '' && !l.startsWith('#'));
  // A floor, because "the ledger stopped parsing" and "no entry has run" are
  // the same green without it -- the failure this whole file exists to avoid.
  expect(
    rows.length,
    `${LEDGER}: parsed ${rows.length} rows. The ledger is a committed file with hundreds of ` +
      `rows, so a low count means the parse broke, not that runs stopped.`,
  ).toBeGreaterThan(50);
  return new Set(rows.map((l) => l.split('\t')[0]!.trim()));
}

const entries = (): Array<[string, StickyExemptEntry]> => [...STICKY_CC_MIGRATION_EXEMPT];

describe('sticky-CC exemption table', () => {
  it('is not empty (a vacuous table would satisfy every assertion below)', () => {
    expect(entries().length).toBeGreaterThan(0);
  });

  it('every entry names a resource type, not a bare service or a typo', () => {
    for (const [type] of entries()) {
      expect(type, `${type} is not an AWS::Service::Type literal`).toMatch(
        /^AWS::[A-Za-z0-9]+::[A-Za-z0-9]+$/,
      );
    }
  });

  it('every entry declares a known mode', () => {
    for (const [type, e] of entries()) {
      expect(['cc-broken', 'sdk-coverage'], `${type} has mode ${e.mode}`).toContain(e.mode);
    }
  });

  it('every entry cites the issue that admitted it', () => {
    for (const [type, e] of entries()) {
      expect(e.issue, `${type} must cite the admitting issue as a URL`).toMatch(
        /^https:\/\/github\.com\/go-to-k\/cdkd\/issues\/\d+$/,
      );
    }
  });

  it('every entry states what BOTH layers store as physicalId', () => {
    for (const [type, e] of entries()) {
      // Prose, so this can only check that a human wrote something specific.
      // The real check is the fixture below: a claim nobody ran is refused.
      expect(
        e.physicalIdForm.length,
        `${type}: physicalIdForm must say what the id actually IS, for a reviewer`,
      ).toBeGreaterThan(30);
    }
  });

  it('every entry names an integ fixture DIRECTORY that exists', () => {
    for (const [type, e] of entries()) {
      // A DIRECTORY, not merely a path. `existsSync` was the first spelling and
      // it accepts a file: `tests/integration/s3-versions.sh` is a loose script
      // sitting beside the fixture dirs, and it satisfied "exists" while being
      // nothing a run could name. Found by probing this fence with the only
      // path in the tree that is present here but absent from the ledger.
      let isDir = false;
      try {
        isDir = statSync(join(repoRoot, 'tests', 'integration', e.integFixture)).isDirectory();
      } catch {
        isDir = false;
      }
      expect(
        isDir,
        `${type} names integ fixture "${e.integFixture}", which is not a directory under ` +
          `tests/integration/. The fixture is the evidence for physicalId parity; an entry ` +
          `naming one that does not exist is an unverified claim with a citation stapled to it.`,
      ).toBe(true);
    }
  });

  it('every entry names a type that actually HAS an SDK provider', () => {
    // The third leg of the admission bar, and the one the first revision of
    // this file left out. An exemption's entire purpose is to send a resource
    // BACK to its SDK provider; for a type with none registered, rule 2 falls
    // through and rules 3-7 route it to Cloud Control anyway. The entry then
    // does nothing, silently, while reading as a shipped capability -- and
    // `physicalIdForm` would be describing a provider that does not exist.
    const registry = new ProviderRegistry();
    registerAllProviders(registry);
    for (const [type] of entries()) {
      expect(
        registry.getProviderType(type),
        `${type} carries a sticky-CC exemption but has no registered SDK provider, so the ` +
          `exemption can never route it anywhere new — rule 2 falls through and the type ` +
          `lands back on Cloud Control by another door.`,
      ).toBe('sdk');
    }
  });

  it('every entry names an integ fixture that has actually RUN', () => {
    const ran = ledgerTestNames();
    for (const [type, e] of entries()) {
      expect(
        ran.has(e.integFixture),
        `${type} names integ fixture "${e.integFixture}", which has no row in ` +
          `docs/_generated/integ-last-run.tsv. Existing is not running: this is the assertion ` +
          `that stops an entry being added before its parity arm was ever run against real AWS.`,
      ).toBe(true);
    }
  });
});
