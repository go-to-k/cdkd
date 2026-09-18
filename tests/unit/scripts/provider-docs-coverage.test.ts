import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';

/**
 * Every registered SDK provider must be documented in BOTH user-facing
 * coverage pages.
 *
 * WHY. `docs/supported-resources.md` is what a user reads to find out whether
 * cdkd can deploy their resource type, and `docs/import.md` is what they read
 * to find out whether `cdkd import` can adopt it. A type that is registered but
 * absent from either page works and is invisible: the v2 drift-coverage push
 * (PRs #210-#216) shipped seven new resource types — Glue Job / Crawler /
 * Connection / Trigger / Workflow / SecurityConfiguration plus Kinesis
 * StreamConsumer — and missed BOTH pages, caught only by a post-merge audit
 * (#219). This is a PRODUCT property, not a process one: the shipped
 * documentation is wrong until someone notices.
 *
 * This replaces `.claude/hooks/provider-docs-gate.sh`, which asserted the same
 * thing at `git commit` time by diffing the staged index. A PreToolUse hook is
 * the wrong place for it — the harm is a stale docs page, which is reversible
 * and lands on nobody until a release, so by the repo's blocking criterion
 * (`.claude/rules/hooks.md`) it belongs in CI. A tree scan is also strictly
 * stronger than the hook was: the hook only looked at registrations the CURRENT
 * commit ADDED, so a type that slipped through once was never re-examined.
 *
 * The match is on the type STRING, so the shape of either page is free to
 * change; only the exact `AWS::Service::Type` spelling has to appear.
 */

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const REGISTER = join(REPO_ROOT, 'src/provisioning/register-providers.ts');

/**
 * Anti-vacuity floor. A refactor that renames `registry.register(` or moves the
 * calls out of this file would make every assertion below pass over an empty
 * set. The floor is well under the current count so ordinary churn does not
 * touch it; it exists to turn "found nothing" into a failure.
 */
const MIN_REGISTERED_TYPES = 100;

/**
 * Pre-existing `docs/import.md` gaps, found the moment this scan replaced the
 * commit-time hook — which is the point: the hook only ever looked at
 * registrations the CURRENT commit added, so these ten were registered once and
 * never re-examined.
 *
 * The list is **DOWN-ONLY**. It records what was already wrong on the day the
 * fence arrived; a NEWLY registered type may never be added to it. Writing the
 * import-side entry for one of these needs a judgement this test cannot make
 * (auto-lookup vs override-only vs sub-resource), which is why they are
 * declared rather than silently papered over — deleting a row here is the fix.
 */
const IMPORT_DOC_GAPS = [
  'AWS::ApiGateway::Account',
  'AWS::EC2::Instance',
  'AWS::EC2::InternetGateway',
  'AWS::EC2::NetworkAcl',
  'AWS::EC2::NetworkAclEntry',
  'AWS::EC2::Route',
  'AWS::EC2::RouteTable',
  'AWS::EC2::SubnetNetworkAclAssociation',
  'AWS::EC2::SubnetRouteTableAssociation',
  'AWS::EC2::VPCGatewayAttachment',
] as const;

const registeredTypes = (): string[] => {
  const src = readFileSync(REGISTER, 'utf8');
  const out = new Set<string>();
  for (const m of src.matchAll(/registry\.register\(\s*'(AWS::[^']+)'/g)) {
    out.add(m[1]!);
  }
  return [...out].sort();
};

describe('registered provider types are documented', () => {
  const types = registeredTypes();

  it('parses a plausible number of registrations', () => {
    expect(types.length).toBeGreaterThanOrEqual(MIN_REGISTERED_TYPES);
  });

  it('docs/supported-resources.md names every registered type', () => {
    const body = readFileSync(join(REPO_ROOT, 'docs/supported-resources.md'), 'utf8');
    const missing = types.filter((t) => !body.includes(t));
    expect(
      missing,
      `add these resource types to docs/supported-resources.md:\n  ${missing.join('\n  ')}`,
    ).toEqual([]);
  });

  it('docs/import.md names every registered type except the declared gaps', () => {
    const body = readFileSync(join(REPO_ROOT, 'docs/import.md'), 'utf8');
    const missing = types.filter(
      (t) => !body.includes(t) && !(IMPORT_DOC_GAPS as readonly string[]).includes(t),
    );
    expect(
      missing,
      `add these resource types to docs/import.md:\n  ${missing.join('\n  ')}`,
    ).toEqual([]);
  });

  // A cap, paired with the staleness check below. Without it the list is
  // down-only in ONE direction only: a fixed row must be deleted, but nothing
  // stopped a future lane APPENDING a newly registered undocumented type and
  // staying green -- the one-sided fence that rewards the inverse regression.
  // The number is the size on the day the list was recorded; it may only go
  // DOWN, and it goes down in the same commit that documents a type.
  it('IMPORT_DOC_GAPS never grows', () => {
    expect(
      IMPORT_DOC_GAPS.length,
      'a NEWLY registered type may not join IMPORT_DOC_GAPS -- document it in ' +
        'docs/import.md instead. This cap only ever moves DOWN.',
    ).toBeLessThanOrEqual(10);
  });

  // The other direction, which is what keeps IMPORT_DOC_GAPS down-only: a row
  // whose type IS documented now, or is no longer registered at all, must be
  // deleted rather than left as permanent noise that hides the next omission.
  it('every declared import-doc gap is still a real, still-registered gap', () => {
    const body = readFileSync(join(REPO_ROOT, 'docs/import.md'), 'utf8');
    const stale = IMPORT_DOC_GAPS.filter((t) => body.includes(t) || !types.includes(t));
    expect(
      stale,
      `delete these rows from IMPORT_DOC_GAPS — they are documented or unregistered:\n  ${stale.join('\n  ')}`,
    ).toEqual([]);
  });
});
