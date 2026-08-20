import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';
import {
  foldRegionOption,
  namedCliRegion,
  rawCliRegion,
} from '../../../src/cli/region-options.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const COMMANDS_DIR = join(REPO_ROOT, 'src', 'cli', 'commands');

describe('foldRegionOption', () => {
  const saved = { region: process.env['AWS_REGION'], def: process.env['AWS_DEFAULT_REGION'] };
  beforeEach(() => {
    delete process.env['AWS_REGION'];
    delete process.env['AWS_DEFAULT_REGION'];
  });
  afterEach(() => {
    if (saved.region === undefined) delete process.env['AWS_REGION'];
    else process.env['AWS_REGION'] = saved.region;
    if (saved.def === undefined) delete process.env['AWS_DEFAULT_REGION'];
    else process.env['AWS_DEFAULT_REGION'] = saved.def;
  });

  it('folds the --region flag in place', () => {
    const options = { region: 'US-EAST-1' };
    foldRegionOption(options);
    expect(options.region).toBe('us-east-1');
  });

  it('folds BOTH env vars — the half the SDK reads directly', () => {
    // `new AwsClients({})` with no region hands resolution to the SDK's own
    // chain, which reads these two. Folding only the flag left
    // `AWS_REGION=US-EAST-1 cdkd deploy` broken (issue #2065).
    process.env['AWS_REGION'] = 'US-EAST-1';
    process.env['AWS_DEFAULT_REGION'] = 'US-EAST-1';
    foldRegionOption({});
    expect(process.env['AWS_REGION']).toBe('us-east-1');
    expect(process.env['AWS_DEFAULT_REGION']).toBe('us-east-1');
  });

  it('leaves canonical input byte-identical, and an absent flag absent', () => {
    process.env['AWS_REGION'] = 'ap-northeast-1';
    const options: { region?: string } = {};
    foldRegionOption(options);
    expect(options.region).toBeUndefined();
    expect(process.env['AWS_REGION']).toBe('ap-northeast-1');
  });

  it('does not invent an env var that was never set', () => {
    foldRegionOption({ region: 'US-WEST-2' });
    expect('AWS_REGION' in process.env).toBe(false);
    expect('AWS_DEFAULT_REGION' in process.env).toBe(false);
  });
});

describe('namedCliRegion', () => {
  const saved = process.env['AWS_REGION'];
  beforeEach(() => delete process.env['AWS_REGION']);
  afterEach(() => {
    if (saved === undefined) delete process.env['AWS_REGION'];
    else process.env['AWS_REGION'] = saved;
  });

  it('returns undefined when the user named NO region — distinct from any region', () => {
    // The whole point of issue #2029: collapsing this into `'us-east-1'` is
    // what let a literal win over the profile region the SDK would resolve.
    expect(namedCliRegion(undefined)).toBeUndefined();
  });

  it('prefers the flag over the env var, and folds it', () => {
    process.env['AWS_REGION'] = 'eu-west-1';
    expect(namedCliRegion('US-EAST-1')).toBe('us-east-1');
  });

  it('folds the env var when no flag was given', () => {
    process.env['AWS_REGION'] = 'US-EAST-1';
    expect(namedCliRegion(undefined)).toBe('us-east-1');
  });

  it('treats an empty flag as unnamed rather than as a region', () => {
    expect(namedCliRegion('')).toBeUndefined();
  });
});

describe('rawCliRegion', () => {
  const saved = process.env['AWS_REGION'];
  beforeEach(() => delete process.env['AWS_REGION']);
  afterEach(() => {
    if (saved === undefined) delete process.env['AWS_REGION'];
    else process.env['AWS_REGION'] = saved;
  });

  it('preserves the exact spelling — the bootstrap marker probe needs it', () => {
    expect(rawCliRegion('US-EAST-1')).toBe('US-EAST-1');
    process.env['AWS_REGION'] = 'US-EAST-1';
    expect(rawCliRegion(undefined)).toBe('US-EAST-1');
  });

  it('must be read BEFORE foldRegionOption, which is why the order is fenced here', () => {
    // Reading it after the fold returns the folded value, silently collapsing
    // the marker's second probe onto its first. `deploy.ts` / `publish-assets.ts`
    // therefore capture it on the line above the fold.
    process.env['AWS_REGION'] = 'US-EAST-1';
    const before = rawCliRegion(undefined);
    foldRegionOption({});
    const after = rawCliRegion(undefined);
    expect(before).toBe('US-EAST-1');
    expect(after).toBe('us-east-1');
  });
});

/**
 * The mechanical fence for issue [#2065](https://github.com/go-to-k/cdkd/issues/2065).
 *
 * The defect was not one site - it was ONE SHAPE repeated across the CLI: a
 * region resolved from `options.region` and the `AWS_REGION` env var and handed
 * to an SDK client, an ARN segment or a state key without folding. 23
 * occurrences existed on `main` when this was written, 19 of them unfolded. A
 * sentence asking the next author to remember is what let issue
 * [#1795](https://github.com/go-to-k/cdkd/issues/1795) fix four `cdkd local *`
 * commands and leave eighteen others carrying the same bug for months, so the
 * rule is a test instead.
 *
 * Three things the first cut of this scanner got wrong, each found by review
 * and each fixed here, because they are the ways a lint quietly goes inert:
 *
 * 1. It matched `||` only. The tree already uses `??` for the same resolution
 *    (`local-invoke.ts`, `local-invoke-agentcore.ts`), so the obvious way to
 *    reintroduce the bug passed clean.
 * 2. Its exemption walk sliced from the last `;`/`{`/`}` and so INCLUDED the
 *    preceding comment. This repo puts ten-line comments directly above these
 *    lines, several of which say `canonicalizeRegion(` or `rawRegion =` - so a
 *    genuinely unfolded resolution under such a comment was exempted. Comments
 *    and string literals are stripped before the walk now.
 * 3. Its floor counted `options.region` occurrences rather than SHAPE matches,
 *    so rewriting the three surviving matches to `??` would have left the
 *    scanner fully inert while green. The floors below count what the scanner
 *    actually consumes, per exemption class.
 *
 * Two spellings are legitimate and are exempted BY SHAPE rather than by a path
 * allow-list (an allow-list goes inert as files are renamed):
 *
 * - the expression WRAPPED in `canonicalizeRegion(...)` - folded at the read;
 * - a binding named `raw*` - the deliberate raw capture the bootstrap marker's
 *   second probe consumes (`gc.ts`, `bootstrap-destroy.ts`, `deploy.ts`,
 *   `publish-assets.ts`, `bootstrap.ts`).
 */
describe('no CLI command resolves a region without folding it', () => {
  const SHAPE = /options\.region\s*(?:\|\||\?\?)\s*process\.env(?:\['AWS_REGION'\]|\.AWS_REGION)/g;

  /**
   * Blank out comments and string literals, PRESERVING length and newlines so
   * every offset below still points at the real source position. Doing it on
   * the whole text rather than per line matters: a block comment spans lines,
   * and a per-line pass would pair one construct's terminator with the next
   * one's opener.
   */
  const stripNonCode = (source: string, alsoStringContents: boolean): string => {
    const out = source.split('');
    let i = 0;
    const blank = (from: number, to: number): void => {
      for (let k = from; k < to && k < out.length; k++) if (out[k] !== '\n') out[k] = ' ';
    };
    while (i < source.length) {
      const two = source.slice(i, i + 2);
      if (two === '//') {
        const end = source.indexOf('\n', i);
        const stop = end === -1 ? source.length : end;
        blank(i, stop);
        i = stop;
      } else if (two === '/*') {
        const end = source.indexOf('*/', i + 2);
        const stop = end === -1 ? source.length : end + 2;
        blank(i, stop);
        i = stop;
      } else if (source[i] === "'" || source[i] === '"' || source[i] === '`') {
        const quote = source[i]!;
        let k = i + 1;
        while (k < source.length && source[k] !== quote) k += source[k] === '\\' ? 2 : 1;
        // The quote characters themselves always stay, so `'...'` remains a
        // recognisable literal; only the CONTENTS are optionally blanked.
        if (alsoStringContents) blank(i + 1, k);
        i = k + 1;
      } else {
        i++;
      }
    }
    return out.join('');
  };

  interface Scan {
    violations: string[];
    matches: number;
    exemptByCanonicalize: number;
    exemptByRaw: number;
  }

  const scan = (source: string): Scan => {
    // TWO length-preserving passes, because the two questions want different
    // text and one pass cannot serve both. MATCHING needs string literals
    // intact - the shape itself contains one (`process.env['AWS_REGION']`), and
    // blanking its contents makes the pattern stop matching, which is how the
    // second cut of this scanner silently reported zero violations. The
    // statement WALK-BACK needs them blanked, so a `';'` inside a string is not
    // read as a statement boundary. Offsets are interchangeable because both
    // passes preserve length.
    const forMatching = stripNonCode(source, false);
    const forWalkBack = stripNonCode(source, true);
    const result: Scan = { violations: [], matches: 0, exemptByCanonicalize: 0, exemptByRaw: 0 };
    for (const match of forMatching.matchAll(SHAPE)) {
      const at = match.index;
      result.matches++;
      const start = Math.max(
        forWalkBack.lastIndexOf(';', at),
        forWalkBack.lastIndexOf('{', at),
        forWalkBack.lastIndexOf('}', at)
      );
      const statement = forWalkBack.slice(start + 1, at);
      if (statement.includes('canonicalizeRegion(')) {
        result.exemptByCanonicalize++;
        continue;
      }
      if (/\braw[A-Za-z]*\s*(?::[^=]*)?=/.test(statement)) {
        result.exemptByRaw++;
        continue;
      }
      const line = forMatching.slice(0, at).split('\n').length;
      result.violations.push(`${line}: ${source.split('\n')[line - 1]!.trim()}`);
    }
    return result;
  };

  const files = readdirSync(COMMANDS_DIR).filter((f) => f.endsWith('.ts'));
  const sources = new Map(files.map((f) => [f, readFileSync(join(COMMANDS_DIR, f), 'utf8')]));
  const totals = [...sources.values()].reduce(
    (acc, src) => {
      const r = scan(src);
      return {
        matches: acc.matches + r.matches,
        canon: acc.canon + r.exemptByCanonicalize,
        raw: acc.raw + r.exemptByRaw,
      };
    },
    { matches: 0, canon: 0, raw: 0 }
  );

  it('still SEES its input - floors on what the scanner consumes', () => {
    // Counting SHAPE matches, not `options.region` mentions. The first cut
    // floored on the latter, which would have stayed satisfied while every
    // remaining match was rewritten out of the scanner's reach.
    //
    // No floor on the `raw*` exemption class: after this lane, ZERO real
    // matches take it (every raw capture now goes through `rawCliRegion`), so a
    // floor there would assert a shape the tree no longer has. That arm is
    // covered by the synthetic cases below instead - which is the right split,
    // since a floor's job is to prove the scanner is reading real input and a
    // synthetic case's job is to prove its logic discriminates.
    expect(files.length).toBeGreaterThan(20);
    expect(totals.matches).toBeGreaterThanOrEqual(3);
    expect(totals.canon).toBeGreaterThanOrEqual(1);
  });

  it.each([
    ["  const region = options.region || process.env['AWS_REGION'] || 'us-east-1';", 1],
    ["  const region = options.region ?? process.env['AWS_REGION'] ?? 'us-east-1';", 1],
    ['  const region = options.region ?? process.env.AWS_REGION ?? undefined;', 1],
    [
      "  const clientRegion = canonicalizeRegion(options.region || process.env['AWS_REGION']);",
      0,
    ],
    ["  const rawRegion = options.region || process.env['AWS_REGION'] || 'us-east-1';", 0],
    // The live trap: an UNFOLDED resolution under a comment that merely
    // mentions the exempting tokens. The first cut exempted this.
    [
      "  // canonicalizeRegion( is named here, and so is rawRegion =\n  const region = options.region || process.env['AWS_REGION'] || 'us-east-1';",
      1,
    ],
    // ...and the mirror: a genuinely folded statement whose STRING contains a
    // `;`, which must not be read as a statement boundary.
    [
      "  const r = canonicalizeRegion(options.region || process.env['AWS_REGION']) ?? sep(';');",
      0,
    ],
  ])('discriminates the pre-fix shape from its exempt look-alikes (%#)', (source, expected) => {
    expect(scan(source as string).violations).toHaveLength(expected as number);
  });

  /**
   * The one file that still carries the shape, PINNED rather than exempted.
   *
   * `local-start-api.ts` folds `--region` at its entry but not the ENV half, so
   * three chains fall through to a raw `AWS_REGION` and ship it into every
   * Lambda container it starts (issue
   * [#2103](https://github.com/go-to-k/cdkd/issues/2103)). It is a real
   * instance of exactly this defect class, found by this scanner. It is not
   * fixed here because `src/cli/commands/local-*.ts` sits behind the
   * `integ-local` merge gate, so folding it would pull a real-Docker
   * `local-start-api` run onto a PR in a different command family.
   *
   * A path allow-list would go inert the moment the file is renamed or the
   * count changes, so this pins the COUNT and asserts it can only SHRINK. A new
   * violation in this file fails; a violation in any other file fails; fixing
   * #2103 fails this test until the entry is deleted, which is the reminder.
   */
  const KNOWN_VIOLATIONS: Record<string, number> = { 'local-start-api.ts': 3 };

  it.each(files)('%s folds every region it resolves', (file) => {
    const found = scan(sources.get(file)!).violations;
    const allowed = KNOWN_VIOLATIONS[file] ?? 0;
    expect(
      found.length,
      allowed === 0
        ? `${file} has unfolded region resolutions:\n${found.join('\n')}`
        : `${file} is pinned at ${allowed} known violation(s) (issue #2103). ` +
            `Found ${found.length}. If you FIXED them, delete the entry; if this GREW, ` +
            `the new one is a regression:\n${found.join('\n')}`
    ).toBe(allowed);
  });

  it('the known-violations pin names only files that really still violate', () => {
    // Guard-the-guard: an entry left behind after its file was fixed would
    // silently re-permit the shape there. Every pinned file must still have at
    // least one violation, and every pinned count must be exact (asserted
    // above), so the list cannot outlive what it describes.
    for (const [file, count] of Object.entries(KNOWN_VIOLATIONS)) {
      expect(sources.has(file), `${file} is pinned but no longer exists`).toBe(true);
      expect(count).toBeGreaterThan(0);
    }
  });
});

/**
 * The COVERAGE fence: every handler that takes a region must fold it.
 *
 * The scanner above only rejects one WRITTEN shape, which leaves the other half
 * of the bug open - a handler that simply never folds, and reads
 * `options.region` straight into `applyRoleArnIfSet` or a client spread. A
 * review probe deleting the `foldRegionOption` line from ten of the eighteen
 * handlers produced ZERO scanner violations, which is exactly the regression
 * this file exists to prevent: `cdkd orphan --region US-EAST-1` would again
 * hand a raw spelling to `applyRoleArnIfSet`, whose `new STSClient({ region })`
 * fails `SignatureDoesNotMatch`.
 *
 * The exemptions are BY SHAPE: a file may fold via `foldRegionOption(options)`
 * or by assigning `options.region = canonicalizeRegion(...)` itself (what the
 * four `cdkd local *` commands do), or - for the two DESTRUCTIVE commands - by
 * routing every read through `namedCliRegion` / `rawCliRegion`, which fold on
 * the way out.
 */
const stripComments = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, ''))
    .join('\n');

describe('every region-taking handler folds', () => {
  const files = readdirSync(COMMANDS_DIR).filter((f) => f.endsWith('.ts'));
  const regionTaking = files.filter((f) =>
    // Comment-stripped: `local-state-loader.ts` names `options.region` only in
    // a prose comment about another command, and it reads `opts.region` (which
    // it folds at every site). Matching raw text listed it as an unfolded
    // handler - a false positive that would have been "fixed" by adding a fold
    // call to a file that has no `options` object at all.
    /\boptions\.region\b/.test(stripComments(readFileSync(join(COMMANDS_DIR, f), 'utf8')))
  );

  it('finds the handlers - floor, so an empty list cannot pass as full coverage', () => {
    expect(regionTaking.length).toBeGreaterThanOrEqual(18);
  });

  it.each(regionTaking)('%s folds its region by one of the accepted shapes', (file) => {
    const source = readFileSync(join(COMMANDS_DIR, file), 'utf8');
    const folds =
      source.includes('foldRegionOption(options)') ||
      /options\.region\s*=\s*canonicalizeRegion\(/.test(source) ||
      source.includes('namedCliRegion(options.region)');
    expect(folds, `${file} reads options.region but never folds it`).toBe(true);
  });
});

/**
 * The ORDER fence. `deploy.ts`, `publish-assets.ts` and `bootstrap.ts` each
 * keep a raw capture beside the fold, and the capture is only correct ABOVE it
 * - `rawCliRegion` reads `process.env.AWS_REGION`, which `foldRegionOption`
 * overwrites. Swap the two lines and nothing else fails: the marker's second
 * probe silently collapses onto its first, and the failure surfaces only
 * against a real bootstrap marker written under a raw key.
 *
 * The fold in turn must precede `applyRoleArnIfSet`, which issues a real
 * `sts:AssumeRole` - STS rejects a non-canonical region with
 * `SignatureDoesNotMatch: Credential should be scoped to a valid region`.
 *
 * Both checks below use ALL occurrences rather than `indexOf`. The first cut
 * used `indexOf` and so saw only the first pair, which let a review probe
 * delete the SECOND `foldRegionOption` from `state.ts` (the `stateInfoCommand`
 * handler) with every test still green.
 */
describe('the raw capture, the fold and the first AWS call stay in order', () => {
  const offsets = (source: string, needle: string): number[] => {
    const out: number[] = [];
    for (let i = source.indexOf(needle); i !== -1; i = source.indexOf(needle, i + 1)) out.push(i);
    return out;
  };

  it.each(['deploy.ts', 'publish-assets.ts', 'bootstrap.ts'])(
    '%s captures the raw spelling before folding',
    (file) => {
      const source = readFileSync(join(COMMANDS_DIR, file), 'utf8');
      const raws = offsets(source, 'rawCliRegion(options.region)');
      const folds = offsets(source, 'foldRegionOption(options)');
      expect(raws.length, 'no raw capture found - anchor drifted?').toBeGreaterThan(0);
      expect(folds).toHaveLength(1);
      // EVERY raw capture must precede the fold, not just the first.
      for (const at of raws) expect(at).toBeLessThan(folds[0]!);
    }
  );

  it.each(readdirSync(COMMANDS_DIR).filter((f) => f.endsWith('.ts')))(
    '%s folds before every AWS call it makes',
    (file) => {
      const source = readFileSync(join(COMMANDS_DIR, file), 'utf8');
      const folds = offsets(source, 'foldRegionOption(options)');
      if (folds.length === 0) return; // covered by the coverage fence above
      const roleArns = offsets(source, 'await applyRoleArnIfSet(');
      // Each `applyRoleArnIfSet` must have a fold before it. Handlers with two
      // of each (`state.ts`, `events.ts`) are the reason this pairs them off
      // rather than comparing first-to-first.
      for (const [i, at] of roleArns.entries()) {
        expect(
          folds.filter((f) => f < at).length,
          `${file}: applyRoleArnIfSet #${i + 1} has no fold above it`
        ).toBeGreaterThanOrEqual(i + 1);
      }
    }
  );
});
