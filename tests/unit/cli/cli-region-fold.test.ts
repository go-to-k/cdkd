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
 * The defect was not one site — it was ONE SHAPE repeated across the CLI:
 * a region resolved as `options.region || process.env['AWS_REGION']` and handed
 * to an SDK client, an ARN segment or a state key without folding. 23
 * occurrences existed on `main` when this was written, 19 of them unfolded.
 * A sentence asking the next author to remember is what let issue
 * [#1795](https://github.com/go-to-k/cdkd/issues/1795) fix four `cdkd local *`
 * commands and leave eighteen others carrying the same bug for months, so the
 * rule is a test instead.
 *
 * Two spellings are legitimate and are exempted BY SHAPE rather than by a path
 * allow-list (an allow-list goes inert as files are renamed):
 *
 * - the expression WRAPPED in `canonicalizeRegion(...)` — folded at the read;
 * - a binding named `raw*` — the deliberate raw capture the bootstrap marker's
 *   second probe consumes (`gc.ts`, `bootstrap-destroy.ts`, `deploy.ts`).
 */
describe('no CLI command resolves a region without folding it', () => {
  const SHAPE = /options\.region \|\| process\.env\['AWS_REGION'\]/g;

  /** Violations in one file's source, as `line: text` rows. */
  const violations = (source: string): string[] => {
    const found: string[] = [];
    for (const match of source.matchAll(SHAPE)) {
      const at = match.index;
      // Walk back to the start of the enclosing statement. `;`, `{` and `}`
      // are the only statement boundaries these resolutions ever sit behind,
      // and scanning the STATEMENT rather than the LINE is what sees a fold
      // that wraps across a line break (`local-run-task.ts` has one).
      const start = Math.max(
        source.lastIndexOf(';', at),
        source.lastIndexOf('{', at),
        source.lastIndexOf('}', at)
      );
      const statement = source.slice(start + 1, at);
      if (statement.includes('canonicalizeRegion(')) continue;
      if (/\braw[A-Za-z]*\s*(?::[^=]*)?=/.test(statement)) continue;
      const line = source.slice(0, at).split('\n').length;
      found.push(`${line}: ${source.slice(at, at + 60).split('\n')[0]!.trim()}`);
    }
    return found;
  };

  const files = readdirSync(COMMANDS_DIR).filter((f) => f.endsWith('.ts'));

  it('reads a real command tree — floor, so "found nothing" cannot pass as "all clean"', () => {
    expect(files.length).toBeGreaterThan(20);
    const withRegion = files.filter((f) =>
      readFileSync(join(COMMANDS_DIR, f), 'utf8').includes('options.region')
    );
    expect(withRegion.length).toBeGreaterThan(15);
  });

  it('flags the pre-fix shape — proving the scanner discriminates', () => {
    // The literal line `deploy.ts` carried on `main` before this change.
    expect(
      violations("  const region = options.region || process.env['AWS_REGION'] || 'us-east-1';")
    ).toHaveLength(1);
    // ...and the two shapes that are legitimately exempt.
    expect(
      violations(
        "  const clientRegion = canonicalizeRegion(options.region || process.env['AWS_REGION']) || undefined;"
      )
    ).toEqual([]);
    expect(
      violations("  const rawRegion = options.region || process.env['AWS_REGION'] || 'us-east-1';")
    ).toEqual([]);
  });

  it.each(files)('%s folds every region it resolves', (file) => {
    expect(violations(readFileSync(join(COMMANDS_DIR, file), 'utf8'))).toEqual([]);
  });
});

/**
 * The ORDER fence. `deploy.ts` and `publish-assets.ts` each keep a raw capture
 * beside the fold, and the capture is only correct ABOVE it — `rawCliRegion`
 * reads `process.env.AWS_REGION`, which `foldRegionOption` overwrites. Swap the
 * two lines and nothing fails: the marker's second probe silently collapses
 * onto its first, and the failure surfaces only against a real bootstrap marker
 * written under a raw key.
 *
 * The fold in turn must precede `applyRoleArnIfSet`, which issues a real
 * `sts:AssumeRole` — STS rejects a non-canonical region with
 * `SignatureDoesNotMatch: Credential should be scoped to a valid region`.
 */
describe('the raw capture, the fold and the first AWS call stay in order', () => {
  it.each(['deploy.ts', 'publish-assets.ts'])('%s captures raw, then folds, then calls AWS', (file) => {
    const source = readFileSync(join(COMMANDS_DIR, file), 'utf8');
    const rawAt = source.indexOf('rawCliRegion(options.region)');
    const foldAt = source.indexOf('foldRegionOption(options)');
    const stsAt = source.indexOf('await applyRoleArnIfSet(');
    expect(rawAt, 'no raw capture found - anchor drifted?').toBeGreaterThan(-1);
    expect(foldAt, 'no fold found - anchor drifted?').toBeGreaterThan(-1);
    expect(stsAt, 'no applyRoleArnIfSet found - anchor drifted?').toBeGreaterThan(-1);
    expect(rawAt).toBeLessThan(foldAt);
    expect(foldAt).toBeLessThan(stsAt);
  });

  it.each(['destroy.ts', 'diff.ts', 'drift.ts', 'export.ts', 'import.ts', 'state.ts'])(
    '%s folds before its first AWS call',
    (file) => {
      const source = readFileSync(join(COMMANDS_DIR, file), 'utf8');
      expect(source.indexOf('foldRegionOption(options)')).toBeGreaterThan(-1);
      expect(source.indexOf('foldRegionOption(options)')).toBeLessThan(
        source.indexOf('await applyRoleArnIfSet(')
      );
    }
  );
});
