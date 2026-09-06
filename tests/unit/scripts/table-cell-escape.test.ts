import { describe, it, expect } from 'vite-plus/test';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import ts from 'typescript-v6';

/**
 * Every FREE-TEXT cell a `scripts/` generator writes into a Markdown table row
 * must go through `escapeCell` (issue #2636).
 *
 * WHY THIS EXISTS ALONGSIDE `docs-table-shape.test.ts`
 * ----------------------------------------------------
 * That test scans the COMMITTED pages, and it measured zero violations across
 * all five generators this issue named while every one of them was defective.
 * It could not do otherwise: no allow-list rationale carries a `|` today, so
 * the emitted rows are well-formed and the defect is LATENT. The page-level
 * scan reds only once someone writes a pipe-bearing rationale, regenerates and
 * commits — and then it names the generated PAGE, not the generator that wrote
 * it. This one reads the GENERATORS, so it reds at the moment the unescaped
 * interpolation is written, and its message is a file and line you can edit.
 *
 * The two are complementary, not redundant: a row can go ragged for reasons no
 * source scan sees (a hand-written table, a header changing width), and a
 * source defect can sit latent for a year with every page clean.
 *
 * WHAT IT CHECKS, AND WHAT IT DELIBERATELY DOES NOT
 * -------------------------------------------------
 * Not every cell is free text. A row also carries a resource type, a file
 * name, a count, a `yes` / `**no**` marker and composed `<br>`-joined link
 * lists — escaping those is a no-op that would only obscure which cells
 * actually needed it, and the issue's own analysis is that the fix is per-cell
 * judgment rather than a blanket `sed`. So the rule is scoped to cells whose
 * value is author-written or composed PROSE, recognised by the FIELD NAME they
 * read (`rationale`, `detail`, `description`, …).
 *
 * The residual that scoping leaves is a prose field named outside
 * `FREE_TEXT_WORDS`. Two things bound it: `FREE_TEXT_SITES_BY_FILE` pins the
 * per-file site counts, so a rename that makes the vocabulary miss a whole
 * generator reds here rather than going quietly inert; and
 * `docs-table-shape.test.ts` still backstops the page. Widening the vocabulary
 * is a one-line edit when a new prose field name appears.
 *
 * THE POPULATION IS DERIVED FROM THE TREE, NOT LISTED HERE — a hand-written
 * list is the failure mode that let five siblings of the #2545 defect ship.
 *
 * WHAT IT SEES, EXACTLY — and the narrowness is deliberate
 * --------------------------------------------------------
 * A row built as a TEMPLATE, or as a `+` chain of templates and strings whose
 * first literal opens with `|`; and inside such a row, a prose-named value read
 * DIRECTLY. That is all. A generator emitting rows that way joins this fence
 * the day it is written.
 *
 * It does NOT see a value reached through a method call
 * (`e.rationales.map(f).join(', ')`), a value passed through a local alias
 * (`const r = e.rationale`), or a row built by joining an array on a pipe
 * separator. Those three detections were WRITTEN and then DELETED, which is
 * worth recording because the deletion is the finding: each needed an
 * exemption, then an exemption to the exemption. The method-call arm reported
 * correct PER-ELEMENT escaping (`e.notes.map((n) => escapeCell(n))`) as a
 * violation whose only remedy — a second whole-cell wrap — double-escapes the
 * value and renders literal backslashes; and it made structural reads over a
 * prose collection (`e.notes.filter(Boolean).length`, `report.summary.toFixed(0)`)
 * score as unescaped prose, which is precisely what `isIntermediateRead`'s own
 * docstring says teaches the next author to widen the exemption rather than
 * escape a rationale. A fence that tells an author to corrupt a value is worse
 * than one that stays quiet, so the narrow rule is the shipped one.
 *
 * `docs-table-shape.test.ts` covers every shape this does not: it reads the
 * rendered page, so it is indifferent to how the row was built. The two are
 * complementary, and neither alone is a claim of total coverage. An over-broad
 * claim in a fence header is worse than a narrow fence, because it stops the
 * next author looking — `known blind spots` below asserts these gaps so that
 * closing one has to be a deliberate edit rather than an accident.
 */

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const SCRIPTS_DIR = join(REPO_ROOT, 'scripts');

/**
 * Field-name words that mark a cell as author-written or composed prose.
 *
 * Matched per camelCase WORD, so `sdkDetail` and `allowRationale` both hit.
 * These are the names the repo actually uses for the shape (`rationale` on
 * every allow-list entry type, `detail` / `sdkDetail` on a divergence,
 * `description` on a scenario) plus the near synonyms an author would reach
 * for next.
 */
const FREE_TEXT_WORDS = new Set([
  'rationale',
  'rationales',
  'detail',
  'details',
  'description',
  // `desc` and the plurals are not padding, and this comment states only what
  // is true of THE TREE THIS SHIPS ON — an earlier draft asserted a measurement
  // taken before a later change in the same commit falsified it.
  //
  // Measured here: `build-scenario-coverage-matrix.ts` renders a
  // `KNOWN_SCENARIOS` description through a local named `desc`, `wordsOf('desc')`
  // is `['desc']`, and deleting these three words takes that file's pinned count
  // from 2 to 1 — the count case below is what dies without them. That cell is
  // the one in this repository demonstrably carrying a pipe today
  // (`invoke|start-api`, the value class that caused go-to-k/cdkd#2545), so a
  // vocabulary knowing only the long form is one that misses the live instance.
  'descriptions',
  'desc',
  'descs',
  'explanation',
  'justification',
  'reason',
  'note',
  'notes',
  'remark',
  'remarks',
  'summary',
  'caption',
  'prose',
]);

interface CellSite {
  readonly file: string;
  readonly line: number;
  readonly expression: string;
  /** The free-text identifier(s) this cell reads. */
  readonly freeTextNames: readonly string[];
  readonly escaped: boolean;
}

/**
 * Is this identifier an INTERMEDIATE of a read rather than the value read?
 *
 * `report.summary.candidateCount` reads a COUNT; `summary` is the container it
 * is reached through, and `report` the container of that. Testing every
 * identifier in the expression made all nine of `audit-stateful-candidates.ts`'s
 * numeric summary cells "free text" — a fence that fires on a count teaches the
 * next author to widen the exemption, not to escape a rationale.
 */
const isIntermediateRead = (n: ts.Node): boolean => {
  const p = n.parent;
  if (!p) return false;
  // Object position: `report` in `report.summary`.
  if (ts.isPropertyAccessExpression(p) && p.expression === n) return true;
  // The NAME of an access that is itself in object position: `summary` above.
  if (ts.isPropertyAccessExpression(p) && p.name === n) return isIntermediateRead(p);
  // A callee is a function name, not a value.
  if (ts.isCallExpression(p) && p.expression === n) return true;
  return false;
};

/**
 * The free-text values a cell expression READS.
 *
 * An ElementAccess's object is deliberately NOT intermediate — `e.rationales[i]`
 * reads out of a prose collection, and skipping the container would lose it.
 */
const freeTextReads = (expr: ts.Expression): ts.Node[] => {
  const hits: ts.Node[] = [];
  const visit = (n: ts.Node): void => {
    if ((ts.isIdentifier(n) || ts.isStringLiteral(n)) && !isIntermediateRead(n)) {
      if (isFreeTextName(n.text)) hits.push(n);
    }
    ts.forEachChild(n, visit);
  };
  visit(expr);
  return hits;
};

/** camelCase / PascalCase / snake_case -> lowercased words. */
const wordsOf = (name: string): string[] =>
  name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .flatMap((part) => part.split(/(?=[A-Z][a-z])/))
    .filter(Boolean)
    .map((w) => w.toLowerCase());

const isFreeTextName = (name: string): boolean => wordsOf(name).some((w) => FREE_TEXT_WORDS.has(w));

/**
 * The leaves of a `+` chain, left to right.
 *
 * A row is not always ONE template: `gen-nested-key-coverage.ts` builds its
 * widest row by concatenating three fragments, and only the FIRST starts with
 * a `|`. Scanning templates in isolation would classify the other two as
 * non-rows and stop looking at the cells inside them — a hole exactly where the
 * longest rows are.
 */
const additiveLeaves = (node: ts.Expression): ts.Expression[] => {
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return [...additiveLeaves(node.left), ...additiveLeaves(node.right)];
  }
  if (ts.isParenthesizedExpression(node)) return additiveLeaves(node.expression);
  return [node];
};

const literalText = (node: ts.Expression): string | undefined => {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    return [node.head.text, ...node.templateSpans.map((s) => s.literal.text)].join(' ');
  }
  return undefined;
};

/**
 * Is this `+` chain (or lone template) a Markdown table ROW?
 *
 * Both halves are needed. Starting with `|` alone matches a `| --- |` separator
 * being built, and any string mentioning a pipe alone matches half the shell
 * snippets these scripts embed in their prose paragraphs.
 */
const isRowChain = (leaves: readonly ts.Expression[]): boolean => {
  // The FIRST LITERAL leaf, not the first leaf. `indent + \`| a | b |\`` opens
  // with a non-literal, and reading `leaves[0]` gave `undefined` — a silent
  // "not a row" that skipped every cell in it. Failing that direction is the
  // expensive one: it produces no message at all.
  const texts = leaves.map(literalText).filter((x): x is string => x !== undefined);
  const first = texts[0];
  if (first === undefined || !/^\s*\|/.test(first)) return false;
  return (texts.join('').match(/\|/g) ?? []).length >= 2;
};

/**
 * Every VALUE binding of the local name `escapeCell` in one file.
 *
 * Keyed on the BINDING, not on a spelling. The regex this replaces enumerated
 * declaration keywords, so each newly-imagined decoy — a `function` decoy, an
 * aliased named import, a default import, a destructured `await import(...)` or
 * `require(...)` — needed the pattern widened again. Enumerating bad shapes
 * loses that race by construction; asking "what introduces this name here?"
 * does not, because a binding is the only way a call site can resolve
 * `escapeCell` to anything at all.
 *
 * `import type` is excluded on both the clause and the specifier: a type
 * binding is erased and can never be the function a row calls.
 *
 * Each entry is `kind: detail`, so the failure message names WHAT was found and
 * not merely that something was.
 */
const escapeCellBindings = (source: string, file: string): string[] => {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const named = (n: ts.Node): boolean => ts.isIdentifier(n) && n.text === 'escapeCell';

  /**
   * Does this specifier name the owning module, from where it was written?
   *
   * A string compare against `'./markdown-table.ts'` was wrong in two ways the
   * moment the walk became recursive: a future `scripts/sub/gen-x.ts` must write
   * `'../markdown-table.ts'`, and CLAUDE.md's ESM rule prescribes the `.js`
   * extension for a TypeScript import in the first place. Both were reported as
   * decoys. Resolve relative to the IMPORTER and compare without the extension.
   */
  const ownsModule = (spec: string): boolean =>
    join(dirname(file), spec).replace(/\.(?:ts|mts|cts|js|mjs|cjs)$/, '') === 'markdown-table';

  const bindingNames = (name: ts.BindingName): ts.Identifier[] => {
    if (ts.isIdentifier(name)) return [name];
    return name.elements.flatMap((el) =>
      ts.isBindingElement(el) ? bindingNames(el.name) : []
    );
  };

  const walk = (n: ts.Node): void => {
    if (ts.isImportDeclaration(n) && n.importClause && !n.importClause.isTypeOnly) {
      const spec = ts.isStringLiteral(n.moduleSpecifier) ? n.moduleSpecifier.text : '<computed>';
      const clause = n.importClause;
      if (clause.name && named(clause.name)) {
        found.push(`default import from ${spec}`);
      }
      if (clause.namedBindings) {
        if (ts.isNamespaceImport(clause.namedBindings) && named(clause.namedBindings.name)) {
          found.push(`namespace import from ${spec}`);
        } else if (ts.isNamedImports(clause.namedBindings)) {
          for (const el of clause.namedBindings.elements) {
            if (!named(el.name) || el.isTypeOnly) continue;
            if (el.propertyName) found.push(`import of ${el.propertyName.text} aliased from ${spec}`);
            else if (!ownsModule(spec)) found.push(`named import from ${spec}`);
            else found.push('OWNED');
          }
        }
      }
    }
    // `const escapeCell = …`, `const { escapeCell } = await import(…)`,
    // `const { escapeCell } = require(…)` — all one shape at the binding.
    if (ts.isVariableDeclaration(n)) {
      for (const id of bindingNames(n.name)) {
        if (named(id)) found.push('local variable declaration');
      }
    }
    if (
      (ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n)) &&
      n.name !== undefined &&
      named(n.name)
    ) {
      found.push('local declaration');
    }
    // A PARAMETER is a binding, and this walk once omitted it — the omission
    // contradicted this function's own docstring and was exploitable end to end:
    // `const render = (e, escapeCell) => …` called with `(v) => v` cleared BOTH
    // halves of the fence, because `isWrappedInEscapeCell` matches the callee's
    // TEXT and has no idea what that name resolves to. Enumerating declaration
    // KEYWORDS is what missed it; asking what binds the name is what does not.
    if (ts.isParameter(n)) {
      for (const id of bindingNames(n.name)) {
        if (named(id)) found.push('parameter binding');
      }
    }
    // `import escapeCell = require('./decoy.ts')` — legal TypeScript, callable,
    // and reachable: the walk admits `.cts`.
    if (ts.isImportEqualsDeclaration(n) && !n.isTypeOnly && named(n.name)) {
      found.push('import-equals declaration');
    }
    ts.forEachChild(n, walk);
  };
  walk(sf);
  return found;
};

/** Is `node` inside an `escapeCell(...)` call that stops at `stopAt`? */
const isWrappedInEscapeCell = (node: ts.Node, stopAt: ts.Node): boolean => {
  for (let cur: ts.Node | undefined = node; cur && cur !== stopAt.parent; cur = cur.parent) {
    if (
      ts.isCallExpression(cur) &&
      ts.isIdentifier(cur.expression) &&
      cur.expression.text === 'escapeCell'
    ) {
      return true;
    }
  }
  return false;
};

/**
 * Every cell expression of every table row in one source file.
 *
 * A "cell expression" is a template span's expression, or a non-literal leaf of
 * a `+`-built row. Only the ones reading a free-text field are returned — the
 * rest are structural by the analysis above.
 */
const scanFreeTextCells = (source: string, file: string): CellSite[] => {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const out: CellSite[] = [];

  const recordCell = (expr: ts.Expression): void => {
    const hits = freeTextReads(expr);
    if (hits.length === 0) return;
    out.push({
      file,
      line: sf.getLineAndCharacterOfPosition(expr.getStart(sf)).line + 1,
      expression: expr.getText(sf).replace(/\s+/g, ' '),
      freeTextNames: [...new Set(hits.map((h) => (h as ts.Identifier | ts.StringLiteral).text))],
      // EVERY read must be wrapped, not any: a cell composing two prose values
      // with one of them escaped is still a defect, and a whole-cell
      // "is anything wrapped?" test clears it.
      escaped: hits.every((h) => isWrappedInEscapeCell(h, expr)),
    });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isExpression(node)) {
      const isChainRoot = !(
        node.parent &&
        ts.isBinaryExpression(node.parent) &&
        node.parent.operatorToken.kind === ts.SyntaxKind.PlusToken
      );
      if (isChainRoot) {
        const leaves = additiveLeaves(node);
        if (isRowChain(leaves)) {
          for (const leaf of leaves) {
            if (ts.isTemplateExpression(leaf)) {
              for (const span of leaf.templateSpans) recordCell(span.expression);
            } else if (literalText(leaf) === undefined) {
              // A `+`-built row's non-literal leaf IS a cell (or part of one).
              recordCell(leaf);
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
};

/**
 * Every script module — the population, derived from the tree, never listed.
 *
 * RECURSIVE and multi-extension on purpose. `scripts/` is flat and all-`.ts`
 * today, but `refresh-cfn-schemas.mjs` already sits there, so a `.ts`-only
 * non-recursive read would silently exclude the next `.mjs` generator and any
 * generator moved into a subdirectory — the same "derived list that quietly
 * stops covering a member" failure a hand-list has, arriving through the walk
 * instead. Declaration files carry no emitter and are dropped.
 */
const scriptFiles = (dir: string = SCRIPTS_DIR, prefix = ''): string[] =>
  readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      // `withFileTypes`, not `statSync`: `stat` FOLLOWS symlinks, so a link back
      // up the tree recurses until the stack goes and a broken link throws
      // ENOENT — killing the suite rather than failing a case. A `Dirent` reports
      // the link itself, so neither happens and a symlinked directory is simply
      // not descended into.
      if (entry.isDirectory()) {
        // `node_modules` is gitignored slash-free in this repo, so it can appear
        // at any depth; parsing one would be minutes of work for no coverage.
        return entry.name === 'node_modules' ? [] : scriptFiles(join(dir, entry.name), rel);
      }
      if (!entry.isFile()) return [];
      return /\.(?:ts|mts|cts|js|mjs|cjs)$/.test(entry.name) && !/\.d\.[cm]?ts$/.test(entry.name)
        ? [rel]
        : [];
    })
    .sort();

/**
 * Per-file free-text cell counts, measured 2026-09-06 against the fixed tree.
 *
 * This is the fence's floor and it is written as a LITERAL taken from a source
 * the scanner does not read. Its job is not to police the total: it is to
 * notice a scanner or a vocabulary that stops SEEING a generator. A rename of
 * `rationale` to something outside `FREE_TEXT_WORDS`, an AST walk that stops
 * recursing, a row builder switching to a shape `isRowChain` does not
 * recognise — each drops a file's count and reds here, where "no violations"
 * on its own would read as a clean tree.
 */
const FREE_TEXT_SITES_BY_FILE: Readonly<Record<string, number>> = {
  'audit-stateful-candidates.ts': 1,
  'build-integ-coverage-matrix.ts': 1,
  // TWO: `entry.description` in the per-scenario table, and the `desc` local the
  // orphan table renders. The second is reached only because `desc` is in
  // FREE_TEXT_WORDS — remove those words and this number goes to 1, which is the
  // case that keeps that half of the vocabulary load-bearing. It is also the
  // cell that actually carries `invoke|start-api`.
  'build-scenario-coverage-matrix.ts': 2,
  'gen-handled-property-wiring.ts': 1,
  'gen-nested-key-coverage.ts': 3,
  'gen-update-wrap-coverage.ts': 1,
};

describe('generated Markdown table cells (#2636)', () => {
  const sites = scriptFiles().flatMap((f) =>
    scanFreeTextCells(readFileSync(join(SCRIPTS_DIR, f), 'utf8'), f)
  );

  it('routes every free-text table cell through escapeCell', () => {
    expect(
      sites
        .filter((s) => !s.escaped)
        .map(
          (s) =>
            `scripts/${s.file}:${s.line} interpolates ${s.freeTextNames.join('/')} into a table ` +
            `row unescaped — wrap it in escapeCell() from scripts/markdown-table.ts: ${s.expression}`
        )
    ).toEqual([]);
  });

  it('still SEES every generator it used to — per-file counts, not a total', () => {
    const byFile: Record<string, number> = {};
    for (const s of sites) byFile[s.file] = (byFile[s.file] ?? 0) + 1;
    expect(
      byFile,
      'A count that GREW: you added a free-text cell — escape it, then bump the number here. ' +
        'A count that SHRANK or a file that vanished: the scanner or FREE_TEXT_WORDS stopped ' +
        'seeing that generator, which is the failure this floor exists to catch — fix the ' +
        'scanner, do not lower the number.'
    ).toEqual(FREE_TEXT_SITES_BY_FILE);
  });

  it('parses a plausible number of row-emitting scripts', () => {
    // The population floor. A `readdirSync` that stopped matching, or a
    // `createSourceFile` failing across the board, yields zero sites and an
    // empty violation list — the vacuous pass this floor refuses. Measured
    // 2026-09-06 on the tree this ships with: 37 script modules, 10 of which
    // emit a table row. (37, not 36: the walk matches `.mjs`/`.cjs` too, so
    // `refresh-cfn-schemas.mjs` is in the population even though it emits no
    // row.)
    const emitters = scriptFiles().filter((f) => {
      const src = readFileSync(join(SCRIPTS_DIR, f), 'utf8');
      return /\n\s*(?:lines\.push\(|`\| )/.test(src) && /`\s*\|[^`]*\$\{/.test(src);
    });
    expect(emitters.length).toBeGreaterThanOrEqual(9);
    expect(scriptFiles().length).toBeGreaterThanOrEqual(30);
  });

  it('lets exactly ONE module bind escapeCell as a value, and refuses every decoy', () => {
    // A second binding of this name would satisfy the escaped-cell check above
    // while calling something that escapes nothing, so the check is on the
    // BINDING, never on the call.
    const offenders: string[] = [];
    for (const f of scriptFiles()) {
      const src = readFileSync(join(SCRIPTS_DIR, f), 'utf8');
      for (const b of escapeCellBindings(src, f)) {
        if (b === 'OWNED') continue;
        if (f === 'markdown-table.ts' && b === 'local variable declaration') continue;
        offenders.push(`scripts/${f}: ${b}`);
      }
    }
    expect(offenders).toEqual([]);

    // The POSITIVE CONTROL this assertion needs: the real tree is permanently
    // clean, so a scanner degraded to always-empty would pass it forever.
    //
    // An earlier version of this control listed exactly the eight forms the walk
    // already handled, so it RESTATED the rule instead of constraining it — and
    // it passed while two callable bindings went unseen. The first two cases
    // below are those two, kept first because they are the ones the control
    // failed to demand: each dies if its arm is removed.
    const seen = (src: string, file = 'probe.ts'): string[] =>
      escapeCellBindings(src, file).filter((b) => b !== 'OWNED');

    // S-M1: a PARAMETER is a binding. This decoy cleared BOTH halves of the
    // fence — no binding reported, and `scanFreeTextCells` scored the row
    // `escaped: true`, because `isWrappedInEscapeCell` matches the callee's TEXT
    // and cannot know what the name resolves to at the call site.
    expect(
      seen('const render = (e, escapeCell) => { lines.push(`| ${e.t} | ${escapeCell(e.rationale)} |`); };')
    ).toHaveLength(1);
    expect(seen('function render(escapeCell) { return escapeCell; }')).toHaveLength(1);
    // S-M2: legal TypeScript, callable, and reachable — the walk admits `.cts`.
    expect(seen("import escapeCell = require('./decoy.ts');")).toHaveLength(1);

    expect(seen('function escapeCell(v) { return v; }')).toHaveLength(1);
    expect(seen("import { identity as escapeCell } from './decoy.ts';")).toHaveLength(1);
    expect(seen("import escapeCell from './decoy.ts';")).toHaveLength(1);
    expect(seen("import * as escapeCell from './decoy.ts';")).toHaveLength(1);
    expect(seen("import { escapeCell } from './decoy.ts';")).toHaveLength(1);
    expect(seen("const { escapeCell } = await import('./decoy.ts');")).toHaveLength(1);
    expect(seen("const { escapeCell } = require('./decoy.ts');")).toHaveLength(1);
    expect(seen('const escapeCell = (v) => v;')).toHaveLength(1);

    // ...and what must stay CLEAN — an over-eager scanner is the other failure.
    // A type-only binding is erased and can never be the function a row calls.
    expect(seen("import { escapeCell } from './markdown-table.ts';")).toEqual([]);
    expect(seen("import type { escapeCell } from './decoy.ts';")).toEqual([]);
    expect(seen("import { type escapeCell } from './decoy.ts';")).toEqual([]);
    // S-n1: the owning module named from where the import was WRITTEN. Both of
    // these were reported as decoys by an exact specifier compare — the second
    // is the spelling CLAUDE.md's ESM rule prescribes, and the first is what the
    // recursive walk makes possible.
    expect(seen("import { escapeCell } from '../markdown-table.ts';", 'sub/gen-x.ts')).toEqual([]);
    expect(seen("import { escapeCell } from './markdown-table.js';")).toEqual([]);
    // ...but resolving must not turn into "any path ending in the right name":
    // a sibling directory's look-alike is still a decoy.
    expect(seen("import { escapeCell } from './sub/markdown-table.ts';")).toHaveLength(1);

    for (const file of Object.keys(FREE_TEXT_SITES_BY_FILE)) {
      expect(
        readFileSync(join(SCRIPTS_DIR, file), 'utf8'),
        `${file} uses escapeCell but does not import it`
      ).toContain("from './markdown-table.ts'");
    }
  });

  it('escapes the cells whose value comes from an AWS API, not from this repo', () => {
    // The free-text rule keys on a field NAME, which is right for prose written
    // in this repository and wrong for a value an API hands back: a type name
    // and a JSON-pointer property name are structural in ROLE, but they arrive
    // from `cloudformation:DescribeType` — including third-party
    // public-registry schemas — and nothing local bounds their characters.
    //
    // A short pinned list rather than a derived rule, because PROVENANCE is not
    // visible in the AST. Two entries; a third means the rule needs stating
    // somewhere the scanner can read.
    const EXTERNALLY_SOURCED: ReadonlyArray<readonly [string, string]> = [
      ['audit-stateful-candidates.ts', 'c.typeName'],
      ['audit-stateful-candidates.ts', 'createOnly'],
    ];
    for (const [file, expr] of EXTERNALLY_SOURCED) {
      const src = readFileSync(join(SCRIPTS_DIR, file), 'utf8');
      // Both directions: the wrapped form must be present AND the bare form
      // must not appear in a row. A presence check alone passes while a SECOND,
      // unwrapped occurrence renders next to it.
      expect(src, `${file}: ${expr} is no longer wrapped in escapeCell`).toContain(
        `escapeCell(${expr})`
      );
      // Match the INTERPOLATION, not the bare word: a prose row label reading
      // "...of which declare a createOnly property" contains the identifier and
      // is not a render of it, and a substring filter failed on exactly that.
      const bare = `\${${expr}}`;
      const wrapped = `\${escapeCell(${expr})}`;
      const lines = src.split('\n').filter((l) => l.includes(bare) || l.includes(wrapped));
      expect(
        lines.filter((l) => l.includes(bare)),
        `${file}: an unwrapped \${${expr}} still reaches a row`
      ).toEqual([]);
      expect(
        lines.filter((l) => l.includes(wrapped)).length,
        `${file}: nothing renders ${expr} any more — prune this entry`
      ).toBeGreaterThan(0);
    }
  });

  describe('the scanner discriminates', () => {
    const scan = (src: string): CellSite[] => scanFreeTextCells(src, 'x.ts');

    it('flags an unescaped free-text cell', () => {
      const found = scan('lines.push(`| ${e.type} | ${e.rationale} |`);');
      expect(found.map((s) => s.escaped)).toEqual([false]);
    });

    it('accepts the escaped form', () => {
      expect(scan('lines.push(`| ${e.type} | ${escapeCell(e.rationale)} |`);')).toEqual([
        expect.objectContaining({ escaped: true }),
      ]);
    });

    it('accepts a nullish default INSIDE the call and refuses it outside', () => {
      expect(scan("lines.push(`| ${escapeCell(e.detail ?? '—')} |`);")[0]!.escaped).toBe(true);
      expect(scan("lines.push(`| ${escapeCell(e.detail) ?? '—'} |`);")[0]!.escaped).toBe(true);
      expect(scan("lines.push(`| ${e.detail ?? '—'} |`);")[0]!.escaped).toBe(false);
    });

    it('refuses a cell that escapes only ONE of two prose values', () => {
      // The whole-cell "is anything wrapped?" test passes this; the per-name
      // test is what makes it a violation.
      const found = scan('lines.push(`| ${escapeCell(a.rationale) + b.detail} |`);');
      expect(found[0]!.escaped).toBe(false);
    });

    it('sees a cell in a `+`-built row, not only the first fragment', () => {
      const found = scan(
        'lines.push(`| ${t.type} | ` + `${t.rationale} | ` + `${t.count} |`);'
      );
      expect(found.map((s) => [s.expression, s.escaped])).toEqual([['t.rationale', false]]);
    });

    it('sees a non-literal leaf of a `+`-built row', () => {
      expect(scan("lines.push('| a | ' + e.rationale + ' |');")[0]).toMatchObject({
        expression: 'e.rationale',
        escaped: false,
      });
    });

    it('ignores a template that is not a table row', () => {
      // Prose paragraphs in these generators mention pipes and rationales
      // freely; only a row starts with `|` AND carries a second delimiter.
      expect(scan('lines.push(`add an entry with a ${e.rationale} |`);')).toEqual([]);
      expect(scan('lines.push(`| ${e.rationale}`);')).toEqual([]);
    });

    it('ignores a structural cell', () => {
      expect(scan('lines.push(`| ${e.resourceType} | ${e.count} |`);')).toEqual([]);
    });

    it('never reports a correctly-escaped cell, nor a count, as a violation', () => {
      // The two shapes that killed the method-call arm, kept as cases so the
      // arm cannot come back by accident. Both are FALSE POSITIVES, which is the
      // expensive direction: a violation an author cannot satisfy honestly.
      //
      // Per-element escaping is already correct — the only way to satisfy a
      // violation here is a second whole-cell wrap, which double-escapes:
      // `a|b` becomes `a\|b` and then `a\\\|b`, rendering literal backslashes
      // in the published page. A fence prescribing that is worse than no fence.
      expect(
        scan("lines.push(`| ${e.type} | ${e.notes.map((n) => escapeCell(n)).join('<br>')} |`);")
      ).toEqual([]);
      expect(scan("lines.push(`| ${e.type} | ${e.notes.map(escapeCell).join('<br>')} |`);")).toEqual(
        []
      );
      // ...and a COUNT over a prose collection is not prose. `isIntermediateRead`'s
      // own docstring says a fence that fires on a count teaches the next author
      // to widen the exemption rather than to escape a rationale.
      expect(scan('lines.push(`| ${e.type} | ${e.notes.filter(Boolean).length} |`);')).toEqual([]);
      expect(scan('lines.push(`| ${e.type} | ${report.summary.toFixed(0)} |`);')).toEqual([]);
      expect(
        scan("lines.push(`| ${e.type} | ${e.notes.some(Boolean) ? 'yes' : 'no'} |`);")
      ).toEqual([]);
    });

    it('has known blind spots, and they are pinned rather than described', () => {
      // Asserting a NEGATIVE on purpose. These three shapes were detected by
      // code this PR removed; without a case, a future author re-adding one has
      // no signal that the removal was a decision, and a future author relying
      // on the fence has no signal that these are uncovered. If one of these
      // starts returning a site, that is either a deliberate widening — update
      // this case and the header together — or an accident worth catching.
      //
      // The control below is what stops this from being satisfied by a scanner
      // that returns nothing at all.
      expect(scan("lines.push(`| ${e.type} | ${e.rationales.map((r) => r).join(', ')} |`);")).toEqual(
        []
      );
      expect(scan('const r = e.rationale;\nlines.push(`| ${e.type} | ${r} |`);')).toEqual([]);
      expect(scan("lines.push(['', r.type, r.rationale, ''].join(' | '));")).toEqual([]);
      // ...and the same shapes' DIRECT spelling still scores, so the emptiness
      // above is about these shapes and not about a dead scanner.
      expect(scan('lines.push(`| ${e.type} | ${e.rationale} |`);')).toHaveLength(1);
    });

    it('matches a free-text word inside a camelCase name', () => {
      expect(scan('lines.push(`| ${e.type} | ${e.sdkDetail} |`)')[0]!.freeTextNames).toEqual([
        'sdkDetail',
      ]);
    });
  });
});
