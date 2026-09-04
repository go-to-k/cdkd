import { describe, it, expect } from 'vite-plus/test';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Fences for the lists on public docs pages that are DERIVED from source.
 *
 * A hand-written page carrying a list the code owns goes stale silently, and
 * every gate stays green while it does. Measured when these pages were
 * rewritten: `cli-drift.md` listed about 55 types with a drift read-back where
 * 129 have one, and named three types as "deferred" that had shipped a
 * read-back long before; `cli-export.md` listed twelve composite-id splitters
 * where sixteen are registered, so a reader would have concluded four
 * exportable types were not.
 *
 * Both lists are set-equal to the source today. These tests are what keeps
 * them that way — the alternative is a generator owning the whole page, which
 * these pages cannot be, since they are prose with the list embedded in it.
 */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const providersDir = join(repoRoot, 'src', 'provisioning', 'providers');
const docs = (name: string): string => readFileSync(join(repoRoot, 'docs', name), 'utf8');

/** Resource types named in a markdown page's `AWS::X::Y` occurrences. */
const typesIn = (markdown: string): Set<string> =>
  new Set(markdown.match(/AWS::[A-Za-z0-9]+::[A-Za-z0-9]+/g) ?? []);

/**
 * Every type `register-providers.ts` registers, mapped to its provider class.
 *
 * `registry.register('T', x)` binds a shared INSTANCE for the multi-type
 * providers (`ec2Provider`, `apigwProvider`, ...), so a naive
 * `register('T', new X)` match sees roughly half the tree. Resolve the
 * `const x = new X(...)` bindings first.
 */
function registeredTypes(): Map<string, string> {
  const source = readFileSync(
    join(repoRoot, 'src', 'provisioning', 'register-providers.ts'),
    'utf8'
  );
  const bindings = new Map<string, string>();
  for (const m of source.matchAll(/const\s+(\w+)\s*=\s*new\s+(\w+)\s*\(/g)) {
    bindings.set(m[1]!, m[2]!);
  }
  const out = new Map<string, string>();
  for (const m of source.matchAll(
    /registry\.register\(\s*'(AWS::[A-Za-z0-9]+::[A-Za-z0-9]+)'\s*,\s*(?:new\s+(\w+)|(\w+))/g
  )) {
    const cls = m[2] ?? bindings.get(m[3]!);
    if (cls) out.set(m[1]!, cls);
  }
  return out;
}

/**
 * The types `cli-drift.md`'s coverage table names.
 *
 * The table groups by service to stay readable —
 * `` | `AWS::ApiGateway` | `Account`, `Authorizer`, ... | `` — so a plain
 * `AWS::X::Y` scan of the page finds none of them. Reconstruct the full type
 * from the two columns.
 */
function driftTableTypes(): Set<string> {
  const out = new Set<string>();
  for (const line of docs('cli-drift.md').split('\n')) {
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').slice(1, -1);
    if (cells.length < 2) continue;
    const service = cells[0]!.trim().match(/^`(AWS::[A-Za-z0-9]+)`$/);
    if (!service) continue;
    for (const m of cells[1]!.matchAll(/`([A-Za-z0-9]+)`/g)) {
      out.add(`${service[1]!}::${m[1]!}`);
    }
  }
  return out;
}

/** Provider class names that define `readCurrentState`. */
function classesWithReadCurrentState(): Set<string> {
  const out = new Set<string>();
  for (const file of readdirSync(providersDir)) {
    if (!file.endsWith('.ts')) continue;
    const source = readFileSync(join(providersDir, file), 'utf8');
    for (const m of source.matchAll(/export\s+class\s+(\w+)/g)) {
      // A class's body runs to the next top-level `export class`, so slice
      // between declarations rather than scanning the whole file — otherwise
      // one implementing class vouches for every sibling in the same file.
      const start = m.index!;
      const nextMatch = source.slice(start + 1).match(/\nexport\s+class\s+\w+/);
      const end = nextMatch ? start + 1 + nextMatch.index! : source.length;
      if (/\breadCurrentState\s*\(/.test(source.slice(start, end))) out.add(m[1]!);
    }
  }
  return out;
}

describe('docs lists derived from source', () => {
  it('cli-drift.md names exactly the types whose provider reads current state', () => {
    const registered = registeredTypes();
    // Anti-vacuity: a parse regression that stops resolving the shared-instance
    // registrations halves this, and a set-equality check would then pass only
    // if the page halved too. Fail loudly instead.
    expect(registered.size).toBeGreaterThanOrEqual(120);

    const implementing = classesWithReadCurrentState();
    expect(implementing.size).toBeGreaterThanOrEqual(60);

    const expected = new Set(
      [...registered].filter(([, cls]) => implementing.has(cls)).map(([type]) => type)
    );
    expect(expected.size).toBeGreaterThanOrEqual(120);

    const page = driftTableTypes();
    const missing = [...expected].filter((t) => !page.has(t)).sort();
    expect(
      missing,
      'these types have a readCurrentState but are absent from cli-drift.md — the coverage table went stale'
    ).toEqual([]);
  });

  it('cli-export.md names every registered composite-id splitter', () => {
    const source = readFileSync(join(repoRoot, 'src', 'cli', 'commands', 'export.ts'), 'utf8');
    const start = source.indexOf('const COMPOSITE_ID_SPLITTERS');
    expect(start, 'COMPOSITE_ID_SPLITTERS moved or was renamed').toBeGreaterThanOrEqual(0);
    const table = source.slice(start, source.indexOf('\n};', start));
    const splitters = typesIn(table);
    expect(
      splitters.size,
      'parsed no splitter types — the constant changed shape and this fence measures nothing'
    ).toBeGreaterThanOrEqual(12);

    const page = typesIn(docs('cli-export.md'));
    const missing = [...splitters].filter((t) => !page.has(t)).sort();
    expect(
      missing,
      'these composite-id splitters are registered but absent from cli-export.md — a reader would conclude they cannot be exported'
    ).toEqual([]);
  });

  it('the --no-recreate-import-unsupported help names every type it applies to', () => {
    const source = readFileSync(join(repoRoot, 'src', 'cli', 'commands', 'export.ts'), 'utf8');
    const start = source.indexOf('const IMPORT_UNSUPPORTED_RECREATABLE_TYPES');
    expect(start).toBeGreaterThanOrEqual(0);
    const types = typesIn(source.slice(start, source.indexOf('\n]);', start)));
    expect(
      types.size,
      'parsed no types out of IMPORT_UNSUPPORTED_RECREATABLE_TYPES'
    ).toBeGreaterThanOrEqual(2);

    const optionStart = source.indexOf("'--no-recreate-import-unsupported'");
    expect(optionStart).toBeGreaterThanOrEqual(0);
    const help = source.slice(optionStart, optionStart + 1200);
    const missing = [...types].filter((t) => !help.includes(t)).sort();
    expect(
      missing,
      "these types are in IMPORT_UNSUPPORTED_RECREATABLE_TYPES but the flag's help text does not name them; the string said \"currently only AWS::ApiGatewayV2::Stage\" for the two releases after AWS::IAM::Policy joined"
    ).toEqual([]);
  });
});
