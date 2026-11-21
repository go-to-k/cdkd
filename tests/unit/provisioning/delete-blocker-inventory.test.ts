import { describe, it, expect } from 'vite-plus/test';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ProviderRegistry } from '../../../src/provisioning/provider-registry.js';
import {
  loadProviderClasses,
  registerAllProviders,
} from '../../../src/provisioning/register-providers.js';
import {
  DELETE_BLOCKER_INVENTORY,
  UNAUDITED_DELETE_BLOCKER_TYPES,
  type DeleteBlocker,
} from '../../../src/provisioning/delete-blocker-inventory.js';

/**
 * Issue #6715: every SDK-provider type's CloudFormation delete-handler
 * blockers are inventoried, and each is handled by cdkd's delete() (with a
 * unit test) or refused with a message naming it — or open, under an issue.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * Both lists only SHRINK: auditing a type (or closing an open blocker) lowers
 * the literal, and a new provider cannot join the unaudited list without
 * raising it, which a reviewer sees. Literals, never derived from the lists.
 */
const UNAUDITED_COUNT = 14;
const OPEN_COUNT = 3;

const registry = new ProviderRegistry();
registerAllProviders(registry, await loadProviderClasses());
const registered = new Set(registry.getRegisteredTypes());

function readRepoFile(path: string): string | undefined {
  const full = join(repoRoot, path);
  return existsSync(full) ? readFileSync(full, 'utf8') : undefined;
}

/** Every reason `blocker`'s disposition is not backed by the repo. */
function blockerProblems(blocker: DeleteBlocker): string[] {
  const d = blocker.disposition;
  const problems: string[] = [];
  if (d.kind === 'open') {
    if (!Number.isInteger(d.issue) || d.issue <= 0) problems.push(`bad issue ${d.issue}`);
    return problems;
  }
  const site = readRepoFile(d.site);
  if (site === undefined) return [`${d.site} does not exist`];
  if (d.kind === 'refused') {
    // A short needle would match by accident.
    if (d.message.length < 20) problems.push('refusal text shorter than 20 characters');
    else if (!site.includes(d.message)) problems.push(`${d.site} lacks the refusal "${d.message}"`);
    return problems;
  }
  if (d.call.length < 8 || !codeOnly(site).includes(d.call)) {
    problems.push(`${d.site} lacks "${d.call}" outside comments and imports`);
  }
  const test = readRepoFile(d.test.file);
  if (test === undefined) return [...problems, `${d.test.file} does not exist`];
  for (const needle of [d.test.title, d.test.caseLabel]) {
    if (needle === undefined) continue;
    if (needle.length < 15) problems.push(`"${needle}" is shorter than 15 characters`);
    else if (!['\'', '"', '`'].some((q) => test.includes(`${q}${needle}${q}`))) {
      problems.push(`${d.test.file} has no string literal "${needle}"`);
    }
  }
  return problems;
}

/**
 * `source` without its comments and import statements: a call named only in
 * a doc comment or an unused import is no preparation. A line comment is
 * dropped where it starts a line, or trails code and holds no quote, so a
 * `//` inside a URL string stays.
 */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    // A trailing comment holding no quote: one with a quote may be inside a string.
    .replace(/\s\/\/[^'"`\n]*$/gm, '')
    .replace(/^import\s[\s\S]*?from\s+['"][^'"]+['"];?/gm, '');
}

const allBlockers = DELETE_BLOCKER_INVENTORY.flatMap((row) =>
  row.blockers.map((b) => [row.type, b] as const)
);
const byKind = (kind: DeleteBlocker['disposition']['kind']) =>
  allBlockers.filter(([, b]) => b.disposition.kind === kind);

describe('delete-blocker inventory (#6715)', () => {
  it('sees the registry and every row shape it checks', () => {
    // Floors per shape: an inventory that parsed to nothing passes every
    // per-row check vacuously.
    expect(registered.size).toBeGreaterThanOrEqual(140);
    expect(DELETE_BLOCKER_INVENTORY.filter((r) => r.blockers.length === 0).length).toBeGreaterThanOrEqual(80);
    expect(byKind('handled').length).toBeGreaterThanOrEqual(25);
    expect(allBlockers.some(([, b]) => b.disposition.kind === 'handled' && b.disposition.test.caseLabel)).toBe(true);
  });

  it('accounts for every registered SDK-provider type exactly once', () => {
    const all = [...DELETE_BLOCKER_INVENTORY.map((r) => r.type), ...UNAUDITED_DELETE_BLOCKER_TYPES];
    expect(
      all.filter((t, i) => all.indexOf(t) !== i),
      'a type is listed twice'
    ).toEqual([]);
    expect(
      [...registered].filter((t) => !all.includes(t)).sort(),
      'a registered SDK-provider type is neither inventoried nor unaudited: read its ' +
        'CloudFormation delete handler and add a row to DELETE_BLOCKER_INVENTORY ' +
        '(src/provisioning/delete-blocker-inventory.ts)'
    ).toEqual([]);
  });

  it('names only registered types', () => {
    const stray = [
      ...DELETE_BLOCKER_INVENTORY.map((r) => r.type),
      ...UNAUDITED_DELETE_BLOCKER_TYPES,
    ].filter((t) => !registered.has(t));
    expect(stray, 'a row names a type with no SDK provider').toEqual([]);
  });

  it('keeps the unaudited list and the open blockers shrink-only', () => {
    expect(
      UNAUDITED_DELETE_BLOCKER_TYPES.length,
      'audit a type instead of adding it; after auditing one, lower UNAUDITED_COUNT'
    ).toBe(UNAUDITED_COUNT);
    expect(
      byKind('open').length,
      'meet a blocker in delete() instead of leaving it open; after closing one, lower OPEN_COUNT'
    ).toBe(OPEN_COUNT);
  });

  it('cites a source for every row, and says what each beyond-CloudFormation step is', () => {
    expect(DELETE_BLOCKER_INVENTORY.filter((r) => !/^https:\/\/\S+/.test(r.source)).map((r) => r.type)).toEqual([]);
    expect(
      DELETE_BLOCKER_INVENTORY.filter((r) => r.beyondCfn?.some((s) => s.trim().length < 15)).map((r) => r.type)
    ).toEqual([]);
  });

  it('backs every handled, refused and open blocker with the repo', () => {
    const failures = allBlockers.flatMap(([type, b]) =>
      blockerProblems(b).map((p) => `${type} (${b.blocker}): ${p}`)
    );
    expect(failures).toEqual([]);
  });

  describe('the check rejects what it guards against', () => {
    const site = 'src/provisioning/providers/ec2/igw-eip.ts';
    const test = {
      file: 'tests/unit/provisioning/ec2-eip-delete-disassociate-6715.test.ts',
      title: 'disassociates its own instance association after an InUse refusal, then releases',
    };
    const handled = (over: object): DeleteBlocker => ({
      blocker: 'x',
      disposition: { kind: 'handled', site, call: 'DisassociateAddressCommand', test, ...over },
    });

    it('accepts a real handled row', () => {
      expect(blockerProblems(handled({}))).toEqual([]);
    });

    it.each<[string, object]>([
      ['a missing site', { site: 'src/provisioning/providers/no-such-file.ts' }],
      ['a call the site lacks', { call: 'NoSuchCommandAnywhere' }],
      ['a missing test file', { test: { ...test, file: 'tests/unit/no-such.test.ts' } }],
      ['a title the test lacks', { test: { ...test, title: 'no test is titled like this one' } }],
      ['a case label the test lacks', { test: { ...test, caseLabel: 'no case is labelled like this' } }],
      ['a call named only in a comment', { call: 'go-to-k/cdkd#6715' }],
      [
        'a title the test spells only as a prefix of a longer one',
        { test: { ...test, title: 'disassociates its own instance association after an InUse refusal' } },
      ],
    ])('rejects %s', (_label, over) => {
      expect(blockerProblems(handled(over)).length).toBeGreaterThan(0);
    });

    it('checks a refusal against its site', () => {
      const refused = (message: string): DeleteBlocker => ({
        blocker: 'x',
        disposition: { kind: 'refused', site, message },
      });
      expect(blockerProblems(refused('Disassociating EIP'))).toEqual(['refusal text shorter than 20 characters']);
      expect(blockerProblems(refused('from its instance before release'))).toEqual([]);
      expect(blockerProblems(refused('a refusal no provider spells'))).toHaveLength(1);
    });
  });
});
