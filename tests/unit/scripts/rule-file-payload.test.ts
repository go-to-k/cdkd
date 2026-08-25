import { describe, it, expect } from 'vite-plus/test';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';

/**
 * `.claude/rules/*.md` files are LAZILY loaded by a native Claude Code feature:
 * a `paths:` glob in the YAML frontmatter injects the WHOLE file into the
 * agent's context the moment a file matching that glob enters context. There is
 * no partial load -- the unit is the file. So a rule file's byte size IS a
 * fixed token toll paid by every session that touches its glob, re-paid on
 * every context compaction, multiplied by every parallel agent.
 *
 * MEASURED on 2026-08-25, immediately before the split this fence guards:
 *
 *   .claude/rules/code-layout.md   394,994 B   paths: src/**\/*.ts      ~99k tokens
 *   .claude/rules/providers.md     166,062 B   paths: src/provisioning/** ~42k tokens
 *
 * i.e. reading ANY `src/**\/*.ts` file cost ~99k tokens before a single line of
 * the file itself was read, and any provider touch cost ~42k more. Both files
 * had accreted PR-by-PR narrative for months with no size feedback anywhere.
 * `code-layout.md` was 128 lines long because each bullet was ONE line: its
 * `- **src/local/** - ...` bullet alone was 47,795 characters.
 *
 * The bullets bucketed by the directory they described (measured, same day):
 *
 *   70,912 B  src/deployment      57,118 B  src/cli        54,602 B  src/provisioning
 *   58,617 B  scripts             47,583 B  src/local      32,946 B  src/utils
 *   24,659 B  src/analyzer         5,692 B  src/assets      4,793 B  src/synthesis
 *
 * The `scripts` bucket is the clearest case: 58 KB describing `scripts/**` and
 * `docs/_generated/**`, loaded on every `src/**` touch and on NO scripts touch,
 * because the glob was `src/**\/*.ts`. Pure waste in both directions.
 *
 * This fence does not try to judge whether a rule file's CONTENT is worth its
 * bytes -- that is a human call. It fences the three mechanical properties that
 * let the two files above get where they got without anyone noticing:
 *
 *   1. no rule file may exceed MAX_RULE_FILE_BYTES;
 *   2. every rule file must declare `paths:` (an always-on file is a toll on
 *      every session, so it must be an explicit, listed decision);
 *   3. long LINES are ratcheted -- both an absolute per-line ceiling and a
 *      repo-wide COUNT of lines over MAX_LINE_BYTES, so the "one bullet per
 *      area, forever" habit cannot re-establish itself silently.
 *
 * Plus 4: a per-touched-path PAYLOAD budget, which is the property anyone
 * actually cares about. Caps 1-3 are per-file and a split can satisfy all three
 * while every satellite still shares one broad glob, which buys nothing. The
 * budgets below sum the matching rule files for a representative path in each
 * area, so widening a satellite's glob back out is what fails.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const RULES_DIR = join(repoRoot, '.claude', 'rules');

/**
 * Headroom over the largest rule file today. Measured 2026-08-25 AFTER the
 * split: `hooks.md` at 105,593 B is the worst and is NOT part of the split (it
 * globs `.claude/**`, not `src/**`, so it is not on the hot path this fence was
 * written for); the largest file the split itself produced is
 * `layout-scripts.md` at 59,193 B. Lower this cap when hooks.md is split.
 */
const MAX_RULE_FILE_BYTES = 120_000;

/**
 * A single line over this is a bullet that has been appended to for months.
 * Not a hard failure on its own -- see LEGACY_LONG_LINE_BUDGET -- because the
 * split preserved every existing line VERBATIM rather than re-wrapping it.
 */
const MAX_LINE_BYTES = 4_000;

/**
 * Ratchet, not a target. Measured 2026-08-25 after the split: 24 lines across
 * all rule files exceed MAX_LINE_BYTES. A repo-wide total rather than a
 * per-file table so that concurrent lanes editing different rule files do not
 * collide on this fence; the cost is that one lane may spend headroom another
 * lane freed. Only ever lower it.
 */
const LEGACY_LONG_LINE_BUDGET = 24;

/**
 * Hard ceiling on any single line. Measured 2026-08-25: the worst line in the
 * repo is the `- **src/local/** - ...` bullet at 47,795 B, preserved verbatim
 * in `layout-local.md`. This cap exists so that line cannot GROW; re-wrap it
 * and lower this number.
 */
const ABSOLUTE_MAX_LINE_BYTES = 48_000;

/**
 * Rule files deliberately loaded into EVERY session (no `paths:` key). Empty on
 * purpose: an always-on rule file is a toll on every session in the repo, so
 * adding one has to be a decision someone writes down here.
 */
const ALWAYS_ON_ALLOWLIST: readonly string[] = [];

/**
 * Per-touched-path payload budgets: the summed bytes of every rule file whose
 * `paths:` globs match that file. Measured 2026-08-25, before -> after the
 * split, with roughly 25-60% headroom left for the rule files this split did
 * not touch (`architecture.md`, `cli-internals.md`, `analyzer.md`, `assets.md`).
 *
 *   src/provisioning/providers/s3-bucket-provider.ts  573,721 ->  239,339
 *   src/deployment/deploy-engine.ts                   407,659 ->   48,937
 *   src/cli/commands/deploy.ts                        418,827 ->   47,570
 *   src/local/docker-runner.ts                        413,288 ->   68,543
 *   src/analyzer/dag-builder.ts                       413,531 ->   29,634
 *   scripts/gen-nested-key-coverage.ts                      0 ->   59,193
 *
 * The scripts row goes UP on purpose and is the only one that does: those notes
 * previously loaded on `src/**` touches and never on a scripts touch, so "0"
 * was the wrong number, not a saving.
 */
const PAYLOAD_BUDGETS: ReadonlyArray<readonly [string, number]> = [
  ['src/provisioning/providers/s3-bucket-provider.ts', 300_000],
  ['src/deployment/deploy-engine.ts', 80_000],
  ['src/cli/commands/deploy.ts', 80_000],
  ['src/local/docker-runner.ts', 100_000],
  ['src/analyzer/dag-builder.ts', 60_000],
  ['scripts/gen-nested-key-coverage.ts', 90_000],
];

const SPLIT_ADVICE =
  'Move the detail into a NEW .claude/rules/<area>.md satellite whose `paths:` glob is as narrow as the content, and leave a one-line pointer behind. Do not summarise or delete the text.';

interface RuleFile {
  name: string;
  text: string;
  bytes: number;
  description: string | undefined;
  paths: string[] | undefined;
  frontmatterError: string | undefined;
  lines: string[];
}

/**
 * The frontmatter is read with the real YAML parser, not a regex, because the
 * failure this catches is a YAML one: an unquoted `description:` whose value
 * itself contains `": "` is a mapping-value-not-allowed error, and a regex
 * reader happily returns a string for a file Claude Code would refuse to load.
 */
function parseRuleFile(name: string): RuleFile {
  const text = readFileSync(join(RULES_DIR, name), 'utf-8');
  const lines = text.split('\n');
  const base = {
    name,
    text,
    bytes: Buffer.byteLength(text, 'utf-8'),
    lines,
    description: undefined,
    paths: undefined,
  };
  if (lines[0]?.trim() !== '---') {
    return { ...base, frontmatterError: 'no leading `---` frontmatter fence' };
  }
  const end = lines.indexOf('---', 1);
  if (end === -1) return { ...base, frontmatterError: 'unterminated frontmatter fence' };
  let doc: unknown;
  try {
    doc = parseYaml(lines.slice(1, end).join('\n'));
  } catch (err) {
    return { ...base, frontmatterError: (err as Error).message };
  }
  if (typeof doc !== 'object' || doc === null) {
    return { ...base, frontmatterError: 'frontmatter is not a YAML mapping' };
  }
  const map = doc as Record<string, unknown>;
  const rawPaths = map['paths'];
  return {
    ...base,
    description: typeof map['description'] === 'string' ? map['description'] : undefined,
    paths:
      Array.isArray(rawPaths) && rawPaths.every((p) => typeof p === 'string')
        ? (rawPaths as string[])
        : undefined,
    frontmatterError: undefined,
  };
}

/**
 * Glob -> RegExp with the semantics the `paths:` frontmatter uses: `**` spans
 * directory separators, `*` does not. `a/**` matches everything under `a/`;
 * `a/**\/*.ts` matches `a/x.ts` as well as `a/b/c/x.ts`.
 */
function globToRegExp(glob: string): RegExp {
  let out = '';
  let i = 0;
  while (i < glob.length) {
    if (glob.startsWith('**/', i)) {
      out += '(?:.*/)?';
      i += 3;
      continue;
    }
    if (glob.startsWith('**', i)) {
      out += '.*';
      i += 2;
      continue;
    }
    const ch = glob[i]!;
    if (ch === '*') out += '[^/]*';
    else if (ch === '?') out += '[^/]';
    else out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    i += 1;
  }
  return new RegExp(`^${out}$`);
}

const ruleFiles: RuleFile[] = readdirSync(RULES_DIR)
  .filter((f) => f.endsWith('.md'))
  .sort()
  .map(parseRuleFile);

describe('.claude/rules payload fence', () => {
  it('finds the rule files at all (guard the guard)', () => {
    // A wrong RULES_DIR would make every assertion below vacuously pass.
    expect(ruleFiles.length).toBeGreaterThanOrEqual(10);
    expect(ruleFiles.map((r) => r.name)).toContain('code-layout.md');
    expect(ruleFiles.map((r) => r.name)).toContain('providers.md');
  });

  it.each(ruleFiles.map((r) => [r.name] as const))(
    '%s stays under the per-file byte cap',
    (name) => {
      const rule = ruleFiles.find((r) => r.name === name)!;
      expect(
        rule.bytes,
        `.claude/rules/${name} is ${rule.bytes} B, over the ${MAX_RULE_FILE_BYTES} B cap. A rule file is loaded WHOLE whenever its \`paths:\` glob matches, so its size is a fixed token toll on every such session. ${SPLIT_ADVICE}`,
      ).toBeLessThanOrEqual(MAX_RULE_FILE_BYTES);
    },
  );

  it.each(ruleFiles.map((r) => [r.name] as const))(
    '%s declares both description and paths',
    (name) => {
      const rule = ruleFiles.find((r) => r.name === name)!;
      expect(
        rule.frontmatterError,
        `.claude/rules/${name} has unparseable YAML frontmatter: ${rule.frontmatterError}. Claude Code cannot read its \`paths:\` glob, so the file either never loads or always loads. The usual cause is an unquoted \`description:\` containing \`": "\` -- quote it or rewrite the value.`,
      ).toBeUndefined();
      expect(
        rule.description,
        `.claude/rules/${name} has no \`description:\` in its frontmatter; match the shape in .claude/rules/analyzer.md.`,
      ).toBeTruthy();
      if (ALWAYS_ON_ALLOWLIST.includes(name)) return;
      expect(
        rule.paths && rule.paths.length > 0,
        `.claude/rules/${name} declares no \`paths:\` globs, so it loads into EVERY session in the repo. Give it a glob as narrow as its content, or add it to ALWAYS_ON_ALLOWLIST with a written reason.`,
      ).toBe(true);
    },
  );

  it.each(ruleFiles.map((r) => [r.name] as const))(
    '%s has no line over the absolute per-line ceiling',
    (name) => {
      const rule = ruleFiles.find((r) => r.name === name)!;
      const worst = rule.lines.reduce(
        (max, line) => Math.max(max, Buffer.byteLength(line, 'utf-8')),
        0,
      );
      expect(
        worst,
        `.claude/rules/${name} has a ${worst} B line, over the ${ABSOLUTE_MAX_LINE_BYTES} B ceiling. This is how a 47,795-char bullet happened: one line per area, appended to PR after PR. Break it into paragraphs or move it to a satellite. ${SPLIT_ADVICE}`,
      ).toBeLessThanOrEqual(ABSOLUTE_MAX_LINE_BYTES);
    },
  );

  it('does not grow the repo-wide count of very long lines', () => {
    const offenders = ruleFiles.flatMap((rule) =>
      rule.lines
        .map((line, idx) => ({
          where: `${rule.name}:${idx + 1}`,
          bytes: Buffer.byteLength(line, 'utf-8'),
        }))
        .filter((l) => l.bytes > MAX_LINE_BYTES),
    );
    expect(
      offenders.length,
      `${offenders.length} lines across .claude/rules/ exceed ${MAX_LINE_BYTES} B, over the ratchet of ${LEGACY_LONG_LINE_BUDGET}. This budget only goes DOWN. Worst offenders: ${offenders
        .sort((a, b) => b.bytes - a.bytes)
        .slice(0, 5)
        .map((l) => `${l.where} (${l.bytes} B)`)
        .join(', ')}. ${SPLIT_ADVICE}`,
    ).toBeLessThanOrEqual(LEGACY_LONG_LINE_BUDGET);
  });

  it.each(PAYLOAD_BUDGETS.map(([p, b]) => [p, b] as const))(
    'touching %s loads at most %d B of rule files',
    (touched, budget) => {
      const matched = ruleFiles.filter((rule) =>
        (rule.paths ?? []).some((glob) => globToRegExp(glob).test(touched)),
      );
      const total = matched.reduce((sum, rule) => sum + rule.bytes, 0);
      expect(
        total,
        `Touching \`${touched}\` now pulls in ${total} B of .claude/rules (budget ${budget} B) from: ${matched
          .sort((a, b) => b.bytes - a.bytes)
          .map((r) => `${r.name} (${r.bytes} B)`)
          .join(', ')}. Either a rule file grew, or a satellite's \`paths:\` glob was widened back out. ${SPLIT_ADVICE}`,
      ).toBeLessThanOrEqual(budget);
    },
  );

  it('the glob matcher itself behaves as the payload budgets assume', () => {
    // Guard the guard: a matcher that matched nothing would make every payload
    // budget above pass with a total of 0.
    expect(globToRegExp('src/**/*.ts').test('src/cli/commands/deploy.ts')).toBe(true);
    expect(globToRegExp('src/**/*.ts').test('src/cli.ts')).toBe(true);
    expect(globToRegExp('src/**/*.ts').test('scripts/gen.ts')).toBe(false);
    expect(globToRegExp('src/provisioning/**').test('src/provisioning/providers/s3.ts')).toBe(true);
    expect(globToRegExp('src/provisioning/**').test('src/deployment/x.ts')).toBe(false);
    expect(globToRegExp('src/analyzer/drift-*.ts').test('src/analyzer/drift-normalize.ts')).toBe(true);
    expect(globToRegExp('src/analyzer/drift-*.ts').test('src/analyzer/dag-builder.ts')).toBe(false);
    expect(globToRegExp('vite.config.ts').test('vite.config.ts')).toBe(true);

    for (const [touched] of PAYLOAD_BUDGETS) {
      const matched = ruleFiles.filter((rule) =>
        (rule.paths ?? []).some((glob) => globToRegExp(glob).test(touched)),
      );
      expect(matched.length, `no rule file matches ${touched}`).toBeGreaterThan(0);
    }
  });
});
