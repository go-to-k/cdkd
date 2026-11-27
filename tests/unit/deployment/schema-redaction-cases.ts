/**
 * The generated case population the schema redaction invariants share
 * (go-to-k/cdkd#7061 slice (c), go-to-k/cdkd#7151): every path of
 * `tests/fixtures/cfn-registry-secret-paths.json`, deduplicated per type.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MAP_KEY } from '../../../scripts/refresh-registry-secret-paths.ts';

const FIXTURES = join(import.meta.dirname, '..', '..', 'fixtures');
export type Kind = 'writeOnly' | 'secretNamed' | 'mapValue';
const KINDS: readonly Kind[] = ['writeOnly', 'secretNamed', 'mapValue'];
type SecretPaths = Record<Kind, string[][]>;
const SNAPSHOT = JSON.parse(readFileSync(join(FIXTURES, 'cfn-registry-secret-paths.json'), 'utf8')) as {
  types: Record<string, SecretPaths>;
};
const CREATE_ONLY = JSON.parse(readFileSync(join(FIXTURES, 'cfn-registry-create-only-paths.json'), 'utf8')) as {
  types: Record<string, string[][]>;
};

/** The snapshot's segment for a map's value at an arbitrary key. */
export { MAP_KEY };
/** The key a map-value case places its value under, after a plain entry. */
export const PLACED_MAP_KEY = 'CaseKey7151';

export type Shape = 'top-level' | 'nested' | 'array-item' | 'map-value' | 'create-only';
export interface Case {
  readonly type: string;
  readonly path: readonly string[];
  readonly kinds: readonly Kind[];
  readonly shapes: readonly Shape[];
}

export function casesOf(): Case[] {
  const out: Case[] = [];
  for (const [type, paths] of Object.entries(SNAPSHOT.types).sort(([a], [b]) => a.localeCompare(b))) {
    const createOnly = new Set((CREATE_ONLY.types[type] ?? []).map((p) => p.join('/')));
    const byPath = new Map<string, Set<Kind>>();
    for (const kind of KINDS) {
      for (const path of paths[kind] ?? []) {
        const key = path.join('/');
        byPath.set(key, (byPath.get(key) ?? new Set()).add(kind));
      }
    }
    for (const [key, kinds] of [...byPath].sort(([a], [b]) => a.localeCompare(b))) {
      const path = key.split('/');
      const shapes: Shape[] = [
        path.includes(MAP_KEY) ? 'map-value' : path.includes('*') ? 'array-item' : path.length === 1 ? 'top-level' : 'nested',
      ];
      if (createOnly.has(key) || createOnly.has(path[0]!)) shapes.push('create-only');
      out.push({ type, path, kinds: [...kinds], shapes });
    }
  }
  return out;
}

/**
 * `value` placed at `path`: `*` is the SECOND item of a list, after a plain
 * one, and {@link MAP_KEY} the second entry of a map, under
 * {@link PLACED_MAP_KEY}, after a plain one.
 */
export function placed(path: readonly string[], value: unknown): Record<string, unknown> {
  const build = (i: number): unknown => {
    if (i === path.length) return value;
    if (path[i] === '*') return ['plain-item-7061', build(i + 1)];
    if (path[i] === MAP_KEY) return { PlainKey7151: 'plain-value-7151', [PLACED_MAP_KEY]: build(i + 1) };
    return { [path[i]!]: build(i + 1) };
  };
  return build(0) as Record<string, unknown>;
}

/** The value at `path` of a bag {@link placed} built, or `undefined`. */
export function at(bag: unknown, path: readonly string[]): unknown {
  let cursor = bag;
  for (const segment of path) {
    if (segment === '*') cursor = Array.isArray(cursor) ? cursor[1] : undefined;
    else if (cursor === null || typeof cursor !== 'object') return undefined;
    else cursor = (cursor as Record<string, unknown>)[segment === MAP_KEY ? PLACED_MAP_KEY : segment];
  }
  return cursor;
}
