import { describe, it, expect } from 'vite-plus/test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// `typescript-v6` is an npm alias of typescript@6 — TS7 ships the stable
// compiler API only under `typescript/unstable/*`. Same import every other
// AST-based critic in this repo uses (`scripts/check-provider-error-cause.ts`,
// `scripts/check-withretry-interrupt.ts`, ...).
import ts from 'typescript-v6';

/**
 * Issue [#2340](https://github.com/go-to-k/cdkd/issues/2340) — the paths that
 * delete custom-resource response objects must run the SAME purge.
 *
 * ## Why this fence PARSES instead of scanning text
 *
 * The question "is this token in code or in a comment?" is a CLASSIFIER, and
 * two hand-written revisions of it were broken by review on inputs nobody had
 * thought of. The first was a plain substring scan: a file entered the
 * population because a COMMENT named the constant, and "calls the purge" was
 * satisfiable by a comment — deleting one word from a comment flipped the
 * fence green. The second added a hand-rolled comment stripper, and it fell to
 * two more shapes, both live in this tree:
 *
 *   - a REGEX LITERAL whose closing delimiter follows an escaped slash.
 *     `!/^https?:\/\//` ends in `//`, which the stripper read as a line
 *     comment, dropping the rest of the LINE. Measured on this tree: the
 *     `intrinsic-function-resolver.ts:4115` shape DOES break it; the
 *     `types/assembly.ts:165` and `appsync-provider.ts:1867` regexes do not,
 *     because theirs do not end that way — so two of the three "carriers"
 *     carry the shape without the failure. A char class `/[/*]/` also breaks
 *     it, opening a block-comment skip that runs to the next `*​/`.
 *   - a BACKTICK INSIDE A STRING INSIDE A TEMPLATE, `\`${\"\`\"}\``. With no
 *     `${}` depth tracking the inner backtick closes the template and the
 *     following quote opens a string that never closes, after which NOTHING is
 *     stripped — which hands back the very first defeat.
 *
 * Patching a classifier a third time is the move this repo's own guidance
 * forbids. Comments are TRIVIA in a real parse: they are not in the AST at
 * all, so the question stops needing an answer. Every predicate below is an
 * AST query, and a file that fails to parse throws rather than contributing
 * zero matches — a silent zero reads exactly like a clean file.
 *
 * ## WHAT THIS FENCE HOLDS, AND THE SPELLINGS IT CANNOT SEE
 *
 * This list is the artifact. Three consecutive review rounds each found a
 * spelling the previous round's query missed, so the useful thing is not a
 * wider query — it is an accurate account of the edges. **If a further
 * spelling turns up, the correct response is one more line in this list, not
 * another layer of query.** Each entry below is pinned by an executable case
 * in the guard-the-guard, so widening the query later flips a test and forces
 * this list to be updated in the same edit.
 *
 * HELD. A file that (a) names `CUSTOM_RESOURCE_RESPONSE_PREFIX` in code, or
 * constructs a PREFIX-SCOPED version listing — directly, through a named-import
 * `as` alias, through a namespace import, with the key quoted, or with the
 * `Prefix` buried in this repo's `...(cond && { ... })` spread idiom — AND
 * (b) constructs `DeleteObject(s)Command` or calls `deleteRawObjects`, must
 * call the shared purge and must not name the listing command at all.
 *
 * NOT HELD, measured on this tree:
 *
 *   - a GENERIC deleter: `keys: string[]` in, no prefix named, no version
 *     listing open-coded. Indistinguishable by static analysis from any other
 *     object deleter; that population is the umbrella issue's, not a fence's.
 *   - a RE-EXPORTED binding (`import { LOV } from './reexport.js'`).
 *   - a DYNAMIC import destructure (`const { X: LOV } = await import(...)`).
 *   - a LOCAL REBINDING (`const LOV = X;`) — the scoped-listing arm cannot
 *     resolve it, so such a file enters only if it also names the prefix.
 *   - an ALIASED DELETE COMMAND (`import { DeleteObjectsCommand as DOC }`).
 *     This is the consequential one: the file is not a "deleter", so NEITHER
 *     assertion runs against it even when it names the prefix. The substring
 *     scan this replaced was equally blind, so it is not a regression — but
 *     the earlier doc did not admit it.
 *
 * Bounding the risk, measured: `src/` today contains ZERO
 * `import * as X from '@aws-sdk/...'` and ZERO `export { ... } from
 * '@aws-sdk/...'`, so the re-export and namespace routes are hypothetical
 * here rather than idiomatic. The spread form is the opposite — it is the
 * house idiom, which is why it was worth widening the query for once.
 */

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');

const PREFIX_SYMBOL = 'CUSTOM_RESOURCE_RESPONSE_PREFIX';
const LISTING_COMMAND = 'ListObjectVersionsCommand';
const IMPLEMENTATION_SITE = 'src/state/s3-noncurrent-version-purge.ts';
const DEFINITION_SITE = 'src/state/state-prefix.ts';
const REEXPORT_SITE = 'src/cli/commands/state-file-keys.ts';
const DELETE_COMMANDS = new Set(['DeleteObjectCommand', 'DeleteObjectsCommand']);
const PURGE_CALL = /^purgeNoncurrent[A-Za-z]*$/;

class ParseFailure extends Error {}

/** Same parse + diagnostics discipline as `scripts/check-provider-error-cause.ts`. */
export function parseSource(fileName: string, text: string): ts.SourceFile {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const diagnostics =
    (source as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
  if (diagnostics.length > 0) {
    const first = diagnostics[0];
    const detail = first ? ts.flattenDiagnosticMessageText(first.messageText, ' ') : 'unknown';
    throw new ParseFailure(`${fileName} failed to parse (${diagnostics.length} errors): ${detail}`);
  }
  return source;
}

function walk(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
}

/** Any IDENTIFIER with this name, anywhere in the AST. Comments cannot match. */
export function namesIdentifier(source: ts.SourceFile, name: string): boolean {
  let found = false;
  walk(source, (n) => {
    if (!found && ts.isIdentifier(n) && n.text === name) found = true;
  });
  return found;
}

/** Local names bound to `ListObjectVersionsCommand`, including `as` aliases. */
function listingAliases(source: ts.SourceFile): Set<string> {
  const names = new Set<string>([LISTING_COMMAND]);
  walk(source, (n) => {
    if (ts.isImportSpecifier(n) && (n.propertyName?.text ?? n.name.text) === LISTING_COMMAND) {
      names.add(n.name.text);
    }
  });
  return names;
}

/** `new <listing>({ ... Prefix: ... })` — the shape a copy of THIS purge has. */
export function hasScopedVersionListing(source: ts.SourceFile): boolean {
  const aliases = listingAliases(source);
  let found = false;
  walk(source, (n) => {
    if (found || !ts.isNewExpression(n)) return;
    const callee = n.expression;
    const named =
      (ts.isIdentifier(callee) && aliases.has(callee.text)) ||
      // `new S3.ListObjectVersionsCommand({...})` — a namespace import.
      (ts.isPropertyAccessExpression(callee) && aliases.has(callee.name.text));
    if (!named) return;
    const arg = n.arguments?.[0];
    if (!arg) return;
    // WALK the argument rather than reading its direct properties. This
    // repo's house idiom for an optional request field is
    // `...(cond && { Prefix: p })`, a SpreadAssignment, which has no `.name`
    // and was therefore invisible to a direct-property scan — while the
    // balanced-paren SUBSTRING scan this AST rewrite replaced did see it.
    // It is the DOMINANT spelling of an optional request field here: 960
    // sites across 119 files, TWO of them in `s3-noncurrent-version-purge.ts`
    // itself — so it is the likeliest spelling of the next copy, and the
    // rewrite was strictly weaker exactly there.
    //
    // The count is an AST measurement, and the rule is stated so it can be
    // reproduced rather than taken on trust: over
    // `git ls-files 'src/*.ts' 'src/**/*.ts'` (331 files), a `SpreadAssignment`
    // whose expression (parentheses unwrapped) is a `BinaryExpression` with
    // `AmpersandAmpersandToken` whose right operand is an
    // `ObjectLiteralExpression`. Three TEXT rules bracket it at 925 / 936 /
    // 967 by miscounting multi-line and nested forms; the idiom is an AST
    // shape, so a text rule is the wrong instrument for it.
    walk(arg, (m) => {
      if (!ts.isPropertyAssignment(m) && !ts.isShorthandPropertyAssignment(m)) return;
      const key = m.name;
      if (ts.isIdentifier(key) && key.text === 'Prefix') found = true;
      if (ts.isStringLiteral(key) && key.text === 'Prefix') found = true;
    });
  });
  return found;
}

/** `new DeleteObject(s)Command(...)` or `<x>.deleteRawObjects(...)`. */
export function deletesObjects(source: ts.SourceFile): boolean {
  let found = false;
  walk(source, (n) => {
    if (found) return;
    if (ts.isNewExpression(n) && ts.isIdentifier(n.expression) && DELETE_COMMANDS.has(n.expression.text)) {
      found = true;
    }
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === 'deleteRawObjects'
    ) {
      found = true;
    }
  });
  return found;
}

/** A CALL to `purgeNoncurrent*`, by bare identifier or as a method. */
export function callsPurge(source: ts.SourceFile): boolean {
  let found = false;
  walk(source, (n) => {
    if (found || !ts.isCallExpression(n)) return;
    const callee = n.expression;
    if (ts.isIdentifier(callee) && PURGE_CALL.test(callee.text)) found = true;
    if (ts.isPropertyAccessExpression(callee) && PURGE_CALL.test(callee.name.text)) found = true;
  });
  return found;
}

function sourceFiles(): string[] {
  return execFileSync('git', ['ls-files', 'src/*.ts', 'src/**/*.ts'], {
    cwd: REPO_ROOT,
    encoding: 'utf-8',
  })
    .split('\n')
    .filter(Boolean);
}

const ast = (rel: string): ts.SourceFile =>
  parseSource(rel, readFileSync(join(REPO_ROOT, rel), 'utf-8'));

describe('custom-resource response purge is SHARED, not copied (issue #2340)', () => {
  const files = sourceFiles();
  const parsed = new Map(files.map((rel) => [rel, ast(rel)]));
  const EXCLUDED = new Set([DEFINITION_SITE, REEXPORT_SITE, IMPLEMENTATION_SITE]);
  const candidates = files.filter((rel) => {
    const src = parsed.get(rel)!;
    return namesIdentifier(src, PREFIX_SYMBOL) || hasScopedVersionListing(src);
  });
  const deleters = candidates.filter(
    (rel) => !EXCLUDED.has(rel) && deletesObjects(parsed.get(rel)!)
  );

  describe('guard-the-guard: the classifier sees CODE and not comments', () => {
    const src = (text: string): ts.SourceFile => parseSource('probe.ts', text);

    it('does not match a symbol that appears only in a comment', () => {
      expect(namesIdentifier(src(`// ${PREFIX_SYMBOL}\nconst a = 1;`), PREFIX_SYMBOL)).toBe(false);
      expect(namesIdentifier(src(`/* ${PREFIX_SYMBOL} */ const a = 1;`), PREFIX_SYMBOL)).toBe(false);
      expect(callsPurge(src('// purgeNoncurrentKeyVersions(x)\nconst a = 1;'))).toBe(false);
    });

    it('still sees the symbol when it IS code', () => {
      expect(namesIdentifier(src(`const a = ${PREFIX_SYMBOL};`), PREFIX_SYMBOL)).toBe(true);
      expect(callsPurge(src('await purgeNoncurrentKeyVersions(a, b, c);'))).toBe(true);
      expect(callsPurge(src('await backend.purgeNoncurrentVersions(k);'))).toBe(true);
    });

    it('REGEX LITERALS containing slashes do not blind it (both fail the old stripper)', () => {
      // `/^https?:\/\//` — the hand-rolled stripper read the `//` inside the
      // regex as a line comment and dropped the rest of the line. Three files
      // in this tree carry this exact shape.
      expect(
        namesIdentifier(src(`const ok = !/^https?:\\/\\//.test(u); const a = ${PREFIX_SYMBOL};`), PREFIX_SYMBOL)
      ).toBe(true);
      // `/[/*]/` — opened a block-comment skip that ran to the next `*/`,
      // swallowing everything between.
      expect(
        namesIdentifier(src(`const re = /[/*]/; const a = ${PREFIX_SYMBOL};`), PREFIX_SYMBOL)
      ).toBe(true);
    });

    it('a BACKTICK inside a string inside a template does not blind it', () => {
      // Measured against the old stripper: it tracked no `${}` depth, so the
      // backtick inside the nested string closed the template, the following
      // quote opened a string that never closed, and from there NOTHING was
      // stripped — which hands back the very first defeat, a comment
      // satisfying `callsPurge`. Verified: with this input the old stripper
      // leaves the comment intact.
      const text = 'const t = `${"`"}`;\n// purgeNoncurrentKeyVersions(x)\nconst z = 1;';
      expect(callsPurge(src(text))).toBe(false);
    });

    it('an ALIASED import still counts as naming the command', () => {
      const text = `import { ${LISTING_COMMAND} as LOV } from '@aws-sdk/client-s3';\nnew LOV({ Bucket: b, Prefix: p });`;
      expect(namesIdentifier(src(text), LISTING_COMMAND)).toBe(true);
      expect(hasScopedVersionListing(src(text))).toBe(true);
    });

    it('sees Prefix inside the house SPREAD idiom', () => {
      // `...(cond && { Prefix: p })` is a SpreadAssignment with no `.name`, so
      // a direct-property scan missed it while the SUBSTRING scan it replaced
      // did not — the AST rewrite was strictly WEAKER here until the walk.
      const text = `new ${LISTING_COMMAND}({ Bucket: b, ...(s !== undefined && { Prefix: s }) });`;
      expect(hasScopedVersionListing(src(text))).toBe(true);
    });

    it('sees a NAMESPACE-imported constructor', () => {
      const text = `import * as S3 from '@aws-sdk/client-s3';\nnew S3.${LISTING_COMMAND}({ Bucket: b, Prefix: p });`;
      expect(hasScopedVersionListing(src(text))).toBe(true);
    });

    it('sees a quoted Prefix key', () => {
      expect(
        hasScopedVersionListing(src(`new ${LISTING_COMMAND}({ 'Prefix': p });`))
      ).toBe(true);
    });

    // ---------------------------------------------------------------
    // BLIND SPOTS, pinned as EXECUTABLE expectations rather than prose.
    // These assert what the fence CANNOT see. A future round that widens
    // the query will flip one of these to `true` and must update the
    // header's list in the same edit — which is the point: the list is
    // the artifact, not the query.
    // ---------------------------------------------------------------
    it('BLIND: a re-exported binding is invisible', () => {
      const text = `import { LOV } from './reexport.js';\nnew LOV({ Bucket: b, Prefix: p });`;
      expect(namesIdentifier(src(text), LISTING_COMMAND)).toBe(false);
      expect(hasScopedVersionListing(src(text))).toBe(false);
    });

    it('BLIND: a dynamic import destructure is invisible', () => {
      const text = `const { ${LISTING_COMMAND}: LOV } = await import('@aws-sdk/client-s3');\nnew LOV({ Prefix: p });`;
      // The identifier IS named here (in the destructure), but the
      // CONSTRUCTION is not resolvable, so a copy escapes the scoped-listing
      // arm and enters the population only if it also names the prefix.
      expect(hasScopedVersionListing(src(text))).toBe(false);
    });

    it('BLIND: a local rebinding is invisible to the scoped-listing arm', () => {
      const text = `const LOV = ${LISTING_COMMAND};\nnew LOV({ Bucket: b, Prefix: p });`;
      expect(hasScopedVersionListing(src(text))).toBe(false);
    });

    it('BLIND: an ALIASED DELETE command escapes the deleter set entirely', () => {
      // The most consequential one: such a file is not a "deleter", so
      // NEITHER assertion runs against it, even if it names the prefix.
      const text = `import { DeleteObjectsCommand as DOC } from '@aws-sdk/client-s3';\nawait c.send(new DOC({ Bucket: b }));`;
      expect(deletesObjects(src(text))).toBe(false);
    });

    it('an UNSCOPED listing is not a scoped one', () => {
      expect(
        hasScopedVersionListing(src(`new ${LISTING_COMMAND}({ Bucket: b, KeyMarker: k });`))
      ).toBe(false);
    });

    it('FAILS loudly when a scanned file no longer parses', () => {
      expect(() => parseSource('broken.ts', 'const a = (;')).toThrow(/failed to parse/);
    });
  });

  it('derives a population the fence can actually see', () => {
    expect(files.length).toBeGreaterThan(200);
    expect(files).toContain(IMPLEMENTATION_SITE);
    expect(namesIdentifier(parsed.get(DEFINITION_SITE)!, PREFIX_SYMBOL)).toBe(true);
    expect(namesIdentifier(parsed.get(REEXPORT_SITE)!, PREFIX_SYMBOL)).toBe(true);
    expect(hasScopedVersionListing(parsed.get(IMPLEMENTATION_SITE)!)).toBe(true);
    expect(deleters).toContain('src/provisioning/providers/custom-resource-provider.ts');
    expect(deleters).toContain('src/cli/commands/gc.ts');
    expect(deleters.length).toBeGreaterThanOrEqual(2);
  });

  it('every in-population deleter CALLS the shared purge', () => {
    const missing = deleters.filter((rel) => !callsPurge(parsed.get(rel)!));
    expect(missing).toEqual([]);
  });

  it('no in-population deleter so much as NAMES the version-listing command', () => {
    const copies = deleters.filter((rel) => namesIdentifier(parsed.get(rel)!, LISTING_COMMAND));
    expect(copies).toEqual([]);
  });

  it('the purge is implemented exactly once in src', () => {
    const implementers = files.filter((rel) => {
      let found = false;
      walk(parsed.get(rel)!, (n) => {
        if (
          ts.isFunctionDeclaration(n) &&
          n.name?.text === 'purgeNoncurrentKeyVersions' &&
          n.body !== undefined
        ) {
          found = true;
        }
      });
      return found;
    });
    expect(implementers).toEqual([IMPLEMENTATION_SITE]);
  });

  it('the state backend method delegates rather than reimplementing', () => {
    const backend = parsed.get('src/state/s3-state-backend.ts')!;
    expect(callsPurge(backend)).toBe(true);
    expect(namesIdentifier(backend, LISTING_COMMAND)).toBe(false);
  });

  it('the three whole-bucket emptiers are excluded by PROPERTY, not by name', () => {
    for (const rel of [
      'src/cli/commands/bootstrap-destroy.ts',
      'src/cli/commands/state-migrate.ts',
      'src/provisioning/providers/s3-bucket-provider.ts',
    ]) {
      const src = parsed.get(rel)!;
      expect(namesIdentifier(src, LISTING_COMMAND)).toBe(true);
      expect(hasScopedVersionListing(src)).toBe(false);
      expect(deleters).not.toContain(rel);
    }
  });
});
