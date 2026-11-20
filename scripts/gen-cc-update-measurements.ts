/**
 * Codegen + CI critic: the measured table of Cloud Control update paths
 * (go-to-k/cdkd#6676, step 3).
 *
 * Cloud Control applies an update patch on top of its read model, and some
 * services' update APIs refuse a read-model value of a key the patch never
 * touched. Each type measured as refusing needs a per-type helper (or a
 * recorded exemption); the input is `scripts/cc-update-measurements.ts`.
 *
 * Writes `docs/_generated/cc-update-measurements.{json,md}`; `--check` fails
 * (naming the type) on:
 *   (a) generated files out of date;
 *   (b) a `refuses` row with neither `fix` nor `exemption`, or with both;
 *   (c) a row whose `fix` module does not REGISTER the type (the parsed table
 *       keys / `*_TYPE` constants; a commented-out key does not count);
 *   (d) a type a helper module registers that lacks a `refuses` row with that
 *       fix (the reverse direction);
 *   (e) a duplicate type;
 *   (f) zero rows, or a helper module with zero parsed types (a parse that
 *       silently found nothing would make (c) and (d) pass vacuously);
 *   (g) a `*-patch` / `cc-read-back-*` module `cloud-control/update.ts`
 *       imports that is neither a fix nor in `NOT_READ_MODEL_FIX_MODULES`.
 * Helper modules are read as TEXT, never imported.
 *
 * Usage:
 *   node --experimental-strip-types scripts/gen-cc-update-measurements.ts          # write
 *   node --experimental-strip-types scripts/gen-cc-update-measurements.ts --check  # verify
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CC_UPDATE_FIX_MODULES,
  CC_UPDATE_MEASUREMENTS,
  type CcUpdateFix,
  type CcUpdateMeasurement,
} from './cc-update-measurements.ts';
import { escapeCell } from './markdown-table.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..');
const PROVISIONING_DIR = resolve(repoRoot, 'src/provisioning');
const OUT_JSON = resolve(repoRoot, 'docs/_generated/cc-update-measurements.json');
const OUT_MD = resolve(repoRoot, 'docs/_generated/cc-update-measurements.md');

export type HelperTexts = Readonly<Record<CcUpdateFix, string>>;

const RESULTS: readonly CcUpdateMeasurement['result'][] = [
  'clean',
  'refuses',
  'no-mutable-property',
  'not-measured',
];

/**
 * The types a helper module registers, read from its text: the quoted keys of
 * `CC_READ_BACK_EMPTY_KEYS` / `CC_READ_BACK_DEFAULT_PATHS`, or the `const X_TYPE = 'AWS::...'` constants.
 */
export function parseHelperTypes(fix: CcUpdateFix, text: string): string[] {
  const table =
    fix === 'cc-read-back-empty-keys'
      ? 'CC_READ_BACK_EMPTY_KEYS'
      : fix === 'cc-read-back-default-paths'
        ? 'CC_READ_BACK_DEFAULT_PATHS'
        : undefined;
  if (table) {
    const start = text.indexOf(`export const ${table}`);
    const open = start < 0 ? -1 : text.indexOf('= {', start);
    // An empty table has no `\n};` of its own: the search would run on into a
    // later object of the same file and read its keys.
    if (open < 0 || text.startsWith('= {}', open)) return [];
    const close = text.indexOf('\n};', open);
    if (close < 0) return [];
    return [...text.slice(open, close).matchAll(/^ {2}'(AWS::[A-Za-z0-9]+::[A-Za-z0-9]+)'\s*:/gm)].map(
      (m) => m[1]!
    );
  }
  return [...text.matchAll(/^const \w+_TYPE\s*=\s*'(AWS::[A-Za-z0-9]+::[A-Za-z0-9]+)'/gm)].map(
    (m) => m[1]!
  );
}

/**
 * Patch helpers `cloud-control/update.ts` imports that are NOT a read-model
 * fix, so they need no measured row. Any other `*-patch` / `cc-read-back-*`
 * module it imports must be a `CcUpdateFix`, so a new per-type helper cannot
 * skip the reverse-direction check.
 */
export const NOT_READ_MODEL_FIX_MODULES: Readonly<Record<string, string>> = {
  'apigwv2-body-import-patch.ts': 'routes an imported HTTP API definition through ReimportApi (#5260)',
  'cc-nested-create-only-patch.ts': 'type-generic nested create-only handling, read from the schema',
};

/**
 * The `../<name>.js` / `./<name>.js` patch-helper modules an `update.ts` text
 * imports, as `<name>.ts` (a helper is named `*-patch` or `cc-read-back-*`).
 */
export function importedPatchModules(updateText: string): string[] {
  return [
    ...updateText.matchAll(/from '\.\.?\/((?:[a-z0-9-]+-patch)|(?:cc-read-back-[a-z0-9-]+))\.js'/g),
  ].map((m) => `${m[1]!}.ts`);
}

/** Every `--check` failure over the rows, helper module texts and `update.ts` (b-g). */
export function findProblems(
  rows: readonly CcUpdateMeasurement[],
  helperTexts: HelperTexts,
  updateText?: string
): string[] {
  const problems: string[] = [];
  if (updateText !== undefined) {
    const imported = importedPatchModules(updateText);
    if (imported.length === 0) problems.push('cloud-control/update.ts: parsed zero patch-helper imports');
    const known = new Set<string>([
      ...Object.values(CC_UPDATE_FIX_MODULES),
      ...Object.keys(NOT_READ_MODEL_FIX_MODULES),
    ]);
    for (const module of imported) {
      if (!known.has(module)) {
        problems.push(
          `cloud-control/update.ts imports ${module}: register it in CC_UPDATE_FIX_MODULES or NOT_READ_MODEL_FIX_MODULES`
        );
      }
    }
  }
  if (rows.length === 0) problems.push('no measurement rows parsed');
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.type)) problems.push(`${row.type}: duplicate row`);
    seen.add(row.type);
    if (row.result === 'refuses') {
      if (!row.fix && !row.exemption) {
        problems.push(`${row.type}: refuses but has neither a fix nor an exemption`);
      }
      if (row.fix && row.exemption) {
        problems.push(`${row.type}: refuses with both a fix and an exemption — keep one`);
      }
    }
    if (row.fix) {
      const text = helperTexts[row.fix];
      if (text === undefined) {
        problems.push(`${row.type}: fix '${row.fix}' is not a registered fix`);
      } else if (!parseHelperTypes(row.fix, text).includes(row.type)) {
        problems.push(`${row.type}: fix module ${CC_UPDATE_FIX_MODULES[row.fix]} does not name the type`);
      }
    }
  }
  for (const fix of Object.keys(CC_UPDATE_FIX_MODULES) as CcUpdateFix[]) {
    const types = parseHelperTypes(fix, helperTexts[fix] ?? '');
    if (types.length === 0) {
      problems.push(`${CC_UPDATE_FIX_MODULES[fix]}: parsed zero types (parser out of date?)`);
    }
    for (const type of types) {
      const row = rows.find((r) => r.type === type);
      if (!row || row.result !== 'refuses' || row.fix !== fix) {
        problems.push(
          `${type}: registered in ${CC_UPDATE_FIX_MODULES[fix]} but has no 'refuses' row with fix '${fix}'`
        );
      }
    }
  }
  return problems;
}

export interface CcUpdateReport {
  readonly summary: Readonly<Record<CcUpdateMeasurement['result'] | 'types', number>>;
  readonly rows: readonly CcUpdateMeasurement[];
}

export function buildReport(rows: readonly CcUpdateMeasurement[]): CcUpdateReport {
  const sorted = [...rows].sort((a, b) => (a.type < b.type ? -1 : a.type > b.type ? 1 : 0));
  const summary = { types: sorted.length } as Record<CcUpdateMeasurement['result'] | 'types', number>;
  for (const result of RESULTS) summary[result] = sorted.filter((r) => r.result === result).length;
  return { summary, rows: sorted };
}

export function renderMarkdown(report: CcUpdateReport): string {
  const lines: string[] = [
    '---',
    'title: "Cloud Control update measurements"',
    'unlisted: true',
    '---',
    '',
    '# Cloud Control update measurements',
    '',
    '<!-- AUTO-GENERATED by scripts/gen-cc-update-measurements.ts — DO NOT EDIT BY HAND. -->',
    '<!-- Regenerate: `vp run gen:cc-update-measurements`. -->',
    '',
    'Cloud Control-routed types measured against real AWS: one property served by the ' +
      "service's main update call changed, plus a `drift --revert`. A `clean` row proves only " +
      "that the probed property's API accepted the read model (go-to-k/cdkd#6676). Edit " +
      '`scripts/cc-update-measurements.ts`.',
    '',
    '## Summary',
    '',
    `- Types: **${report.summary.types}**`,
    ...RESULTS.map((r) => `- ${r}: **${report.summary[r]}**`),
    '',
    '## Table',
    '',
    '| Type | Result | Probe | Fix / exemption | Issue | Measured | Note |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const r of report.rows) {
    const fix = r.fix ? `\`${r.fix}\`` : (r.exemption ?? '');
    lines.push(
      `| ${escapeCell(r.type)} | ${r.result} | ${escapeCell(r.probe)} | ${escapeCell(fix)} | ` +
        `#${r.issue} | ${r.measured} | ${escapeCell(r.note ?? '')} |`
    );
  }
  lines.push('');
  return lines.join('\n');
}

function loadHelperTexts(): HelperTexts {
  const texts = {} as Record<CcUpdateFix, string>;
  for (const [fix, file] of Object.entries(CC_UPDATE_FIX_MODULES) as [CcUpdateFix, string][]) {
    texts[fix] = readFileSync(resolve(PROVISIONING_DIR, file), 'utf-8');
  }
  return texts;
}

function atomicWrite(path: string, content: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

function main(): void {
  const report = buildReport(CC_UPDATE_MEASUREMENTS);
  const json = JSON.stringify(report, null, 2) + '\n';
  const md = renderMarkdown(report) + '\n';
  if (process.argv.includes('--check')) {
    const problems = findProblems(
      CC_UPDATE_MEASUREMENTS,
      loadHelperTexts(),
      readFileSync(resolve(PROVISIONING_DIR, 'cloud-control/update.ts'), 'utf-8')
    );
    for (const [path, want] of [
      [OUT_JSON, json],
      [OUT_MD, md],
    ] as const) {
      if (!existsSync(path) || readFileSync(path, 'utf-8') !== want) {
        problems.push(`${path}: stale — run \`vp run gen:cc-update-measurements\``);
      }
    }
    if (problems.length > 0) {
      process.stderr.write(
        'cc-update-measurements: FAIL\n' + problems.map((p) => `  ${p}\n`).join('')
      );
      process.exit(1);
    }
    process.stderr.write(
      `cc-update-measurements: OK — ${report.summary.types} types, ` +
        `${report.summary.refuses} refusing, all with a registered fix or exemption.\n`
    );
    return;
  }
  mkdirSync(dirname(OUT_JSON), { recursive: true });
  atomicWrite(OUT_JSON, json);
  atomicWrite(OUT_MD, md);
  process.stderr.write(
    `cc-update-measurements: wrote cc-update-measurements.{json,md} — ${report.summary.types} types.\n`
  );
}

const isMainModule = (): boolean =>
  Boolean(process.argv[1]) && resolve(process.argv[1]!) === __filename;

if (isMainModule()) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`cc-update-measurements: failed — ${(err as Error).message}\n`);
    process.exit(1);
  }
}
