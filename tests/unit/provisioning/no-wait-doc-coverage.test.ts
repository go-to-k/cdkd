import { describe, it, expect } from 'vite-plus/test';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Enforce that every SDK provider whose stabilization wait is gated on
 * `CDKD_NO_WAIT` is documented in the `--no-wait` resource table of
 * `docs/cli-reference.md`. When a new provider adds a `--no-wait`-eligible
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
const cliReferencePath = join(repoRoot, 'docs', 'cli-reference.md');

/** Extract the `## `--no-wait`` section (up to the next `## ` heading). */
function noWaitSection(): string {
  const md = readFileSync(cliReferencePath, 'utf8');
  const start = md.indexOf('## `--no-wait`');
  expect(start, 'cli-reference.md must have a `--no-wait` section').toBeGreaterThanOrEqual(0);
  const rest = md.slice(start + 1);
  const next = rest.indexOf('\n## ');
  return next >= 0 ? rest.slice(0, next) : rest;
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
    // Neptune, ElastiCache, CloudFront, ACM, EC2/NAT, Lambda MicrovmImage).
    expect(noWaitProviders.length).toBeGreaterThanOrEqual(8);
  });

  it('documents each CDKD_NO_WAIT provider in the cli-reference --no-wait table', () => {
    const section = noWaitSection();
    const undocumented = noWaitProviders.filter((p) => {
      const types = handledTypes(p.source);
      // At least one of the provider's handled types must appear in the
      // --no-wait table (a provider like EC2 handles many types but only its
      // NAT Gateway wait is --no-wait-gated, so one documented type suffices).
      return !types.some((t) => section.includes(t));
    });
    expect(
      undocumented.map((p) => p.file),
      'these providers honor --no-wait but no handled type appears in the cli-reference --no-wait table; add a row'
    ).toEqual([]);
  });
});
