import { describe, it, expect } from 'vite-plus/test';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Enforce that every SDK provider whose stabilization wait is gated on
 * `CDKD_NO_WAIT` is documented in the per-type wait table of
 * `docs/cli-deploy.md`. When a new provider adds a `--no-wait`-eligible
 * async resource, its resource type MUST appear in that table — otherwise the
 * user-facing "which resources does --no-wait skip" list silently rots.
 *
 * This is the mechanical backstop for the checklist in
 * `.claude/rules/providers.md` ("Adding a New SDK Provider") — the
 * `AWS::Lambda::MicrovmImage` provider shipped honoring `--no-wait` but was NOT
 * added to the docs list, which is the miss this test prevents from recurring.
 */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const providersDir = join(repoRoot, 'src', 'provisioning', 'providers');
const deployDocPath = join(repoRoot, 'docs', 'cli-deploy.md');

/** The single H2 holding the per-resource-type wait table. */
const WAIT_TABLE_HEADING = '## Wait behaviour by resource type';

/**
 * The types named in the table's FIRST column, one entry per row.
 *
 * Deliberately parses ROWS rather than the section's text: the section also
 * carries prose that names resource types, and a type mentioned only there
 * would satisfy a substring check while being absent from the table a reader
 * consults. Measured — with a whole-section check, deleting the
 * `AWS::Lambda::MicrovmImage` row left this suite green, because the routing
 * caveat below the table names that type in a sentence.
 */
function waitTableRowTypes(): { type: string; fullWait: string }[] {
  const md = readFileSync(deployDocPath, 'utf8');
  const start = md.indexOf(WAIT_TABLE_HEADING);
  expect(
    start,
    `cli-deploy.md must have a "${WAIT_TABLE_HEADING}" section`
  ).toBeGreaterThanOrEqual(0);
  const rest = md.slice(start + 1);
  const next = rest.indexOf('\n## ');
  const section = next >= 0 ? rest.slice(0, next) : rest;

  const rows: { type: string; fullWait: string }[] = [];
  for (const line of section.split('\n')) {
    if (!line.startsWith('|')) continue;
    // | type | --no-wait | default | --full-wait | CloudFormation | Terraform |
    const cells = line.split('|').slice(1, -1);
    if (cells.length < 4) continue;
    const types = cells[0]!.match(/AWS::[A-Za-z0-9]+::[A-Za-z0-9]+/g) ?? [];
    for (const type of types) rows.push({ type, fullWait: cells[3]!.trim() });
  }
  expect(
    rows.length,
    `parsed no rows out of "${WAIT_TABLE_HEADING}" — the table's shape changed and this fence is measuring nothing`
  ).toBeGreaterThanOrEqual(10);
  return rows;
}

function handledTypes(source: string): string[] {
  const matches = source.match(/'AWS::[A-Za-z0-9]+::[A-Za-z0-9]+'/g) ?? [];
  return [...new Set(matches.map((m) => m.slice(1, -1)))];
}

describe('--no-wait doc coverage', () => {
  const files = readdirSync(providersDir).filter((f) => f.endsWith('-provider.ts'));
  const noWaitProviders = files
    .map((f) => ({ file: f, source: readFileSync(join(providersDir, f), 'utf8') }))
    .filter((p) => p.source.includes("process.env['CDKD_NO_WAIT']"));

  it('finds every CDKD_NO_WAIT-honoring provider (coverage floor)', () => {
    // A parse regression that stops seeing providers must fail loudly, not
    // pass vacuously. As of this test there are 8 such providers (RDS, DocDB,
    // Neptune, ElastiCache, ACM, EC2/NAT, ELBv2, Lambda MicrovmImage).
    // CloudFront left the set with issue #1282: its Deployed wait is now
    // gated on CDKD_FULL_WAIT (see full-wait-doc-coverage.test.ts). (The
    // pre-#1282 floor said 8 while enumerating CloudFront and omitting
    // ELBv2 — the count was accidentally right and the list wrong; both are
    // now audited.)
    expect(noWaitProviders.length).toBeGreaterThanOrEqual(8);
  });

  it('documents each CDKD_NO_WAIT provider in the cli-deploy.md wait table', () => {
    const rowTypes = new Set(waitTableRowTypes().map((r) => r.type));
    const undocumented = noWaitProviders.filter((p) => {
      const types = handledTypes(p.source);
      // At least one of the provider's handled types must have its own ROW in
      // the wait table (a provider like EC2 handles many types but only its NAT
      // Gateway wait is --no-wait-gated, so one documented type suffices).
      return !types.some((t) => rowTypes.has(t));
    });
    expect(
      undocumented.map((p) => p.file),
      'these providers honor --no-wait but no handled type appears in the cli-deploy.md wait table; add a row'
    ).toEqual([]);
  });
});
