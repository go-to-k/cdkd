/**
 * Fence for go-to-k/cdkd#3950: no `src/**` message may wrap a sanitized value
 * in a hand-written `'...'` or `"..."`.
 *
 * The sanitizers keep `'`, `$`, `(`, `;` and a space, and `displayIdent`'s
 * JSON boundary does not survive a quote around it either, so a value carrying
 * `'` closes cdkd's own quote and the rest of a pasted sentence runs as bare
 * shell. The value goes through its own boundary instead (`displayIdent` /
 * `displayStackName`, with no quotes around the call).
 *
 * BOUND: the pattern sees a sanitizer CALLED inside the quote, or a hoisted
 * sanitized value whose variable is named `safe*` (`'${safeId}'`,
 * `'${safeId || UNRENDERABLE}'`). A hoisted value under any other name is
 * invisible to it, and so is a site split across a continuation line. Those
 * are covered per site by paste cases, not here.
 *
 * The allow-list is per FILE, so a new site in a listed file is invisible
 * while the file sits on it. It has no stale check on purpose: its rows are
 * being fixed by parallel lanes of the same issue, and a stale check would
 * turn `main` red at whichever of them merged second. The lane that fixes the
 * last row deletes the list.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vite-plus/test';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * A sanitizer call, or a hoisted `safe*` value, opened straight after a
 * hand-written `'` or `"`. A `"` fails the same way: a `"` in the value closes
 * it, and `$( )` runs inside it regardless.
 */
const HAND_QUOTED =
  /['"]\$\{(?:(?:safeSegment|displaySafe|safe|safeId|safeStack|displayIdent|displayStackName|showId|(?:this\.)?displayMasked|(?:this\.)?displayLeaf)\(|safe[A-Za-z]*\s*(?:\}|\|\|))/;

/** Files whose sites go-to-k/cdkd#3950 still lists as open, each with its reason. */
const ALLOWED: Readonly<Record<string, string>> = {
  'src/deployment/intrinsic-function-resolver.ts':
    "open row of go-to-k/cdkd#3950 (the resolver's displayMasked / displayLeaf renders inside single quotes; they keep `'`). While listed, the two sites #4052 fixed here rely on their paste cases, not this fence",
};

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (entry.name.endsWith('.ts')) out.push(path);
  }
  return out;
}

/** `file:line` of every hand-quoted sanitizer call in `text`. */
function hits(file: string, text: string): string[] {
  return text
    .split('\n')
    .flatMap((line, i) => (HAND_QUOTED.test(line) ? [`${file}:${i + 1}`] : []));
}

describe('no sanitized value inside a hand-written quote (go-to-k/cdkd#3950)', () => {
  it('finds none outside the files still listed as open', () => {
    const files = sourceFiles(join(repoRoot, 'src'));
    // The walk saw the tree, including a file this fence was written against.
    expect(files.length).toBeGreaterThan(200);
    expect(files.map((f) => relative(repoRoot, f))).toContain('src/cli/commands/rollback.ts');
    const found = files.flatMap((f) => {
      const rel = relative(repoRoot, f).split('\\').join('/');
      return rel in ALLOWED ? [] : hits(rel, readFileSync(f, 'utf8'));
    });
    expect(found).toEqual([]);
  });

  it('the pattern fires on the shape it fences, and not on the fixed one', () => {
    expect(hits('x.ts', "`Roll back '${safeStack(stackName)}' (${safe(region)})?`")).toEqual([
      'x.ts:1',
    ]);
    expect(hits('x.ts', "`for run '${displayIdent(run)}'`")).toEqual(['x.ts:1']);
    expect(hits('x.ts', '`value "${displayIdent(v)}": expected`')).toEqual(['x.ts:1']);
    expect(hits('x.ts', "`so '${showId(identifier)}' is looked up`")).toEqual(['x.ts:1']);
    expect(hits('x.ts', "`deleting '${safeId || UNRENDERABLE}' from`")).toEqual(['x.ts:1']);
    expect(hits('x.ts', "`deleting '${safeName}' from`")).toEqual(['x.ts:1']);
    expect(hits('x.ts', "`mapping '${this.displayMasked(mapName, context)}' not found`")).toEqual([
      'x.ts:1',
    ]);
    expect(hits('x.ts', "`deleting ${quotedOrDescribed(id, 'name')} from`")).toEqual([]);
    expect(hits('x.ts', '`Roll back ${safeStack(stackName)} (${safe(region)})?`')).toEqual([]);
  });
});
