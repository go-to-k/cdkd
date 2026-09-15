import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vite-plus/test';
import {
  defineOwnKey,
  hasOwnKey,
  hasPlainPrototype,
  nullPrototypeRecord,
  ownValue,
} from '../../../src/utils/own-keys.js';

/**
 * `src/utils/own-keys.ts` (issue #3121): the ONE spelling of the own-key /
 * plain-prototype rule `drift.ts` and the analyzer canonicalizers rebuild by.
 * The behaviour is pinned through its consumers (`drift-normalize.test.ts`,
 * `drift-masked-leaf-preserve.test.ts`, ...); this file pins the two things a
 * consumer suite cannot: the helpers' own contract on the exotic inputs, and
 * the module's LEAF-ness -- its header and `.claude/rules/own-keys.md` say it
 * must import nothing, because a value import from a module other suites
 * `vi.mock` reds those suites with a missing-export failure.
 */
describe('own-keys', () => {
  it('is a LEAF module: the source carries no import statement (source-shape fence)', () => {
    const source = readFileSync(new URL('../../../src/utils/own-keys.ts', import.meta.url), 'utf8');
    // Any `import` at column 0 -- a value import, a type import, a side-effect
    // import -- breaks the leaf property the rule file promises.
    expect(source.split('\n').filter((line) => /^\s*import\b/.test(line))).toEqual([]);
    expect(source).toMatch(/export function hasPlainPrototype/);
  });

  it('hasOwnKey / ownValue answer the bag alone, never the prototype chain', () => {
    const bag = JSON.parse('{"A":"a","__proto__":{"polluted":"base"}}') as Record<string, unknown>;
    expect(hasOwnKey(bag, 'A')).toBe(true);
    expect(hasOwnKey(bag, '__proto__')).toBe(true);
    expect(hasOwnKey(bag, 'constructor')).toBe(false);
    expect(hasOwnKey(bag, 'toString')).toBe(false);
    expect(ownValue(bag, 'constructor')).toBeUndefined();
    expect(ownValue({}, '__proto__')).toBeUndefined();
    expect(JSON.stringify(ownValue(bag, '__proto__'))).toBe('{"polluted":"base"}');
  });

  it('defineOwnKey defines __proto__ as an own data key on a plain object, never as its prototype', () => {
    const target: Record<string, unknown> = {};
    defineOwnKey(target, '__proto__', { polluted: 'x' });
    expect(Object.getOwnPropertyNames(target)).toEqual(['__proto__']);
    expect(Object.getPrototypeOf(target)).toBe(Object.prototype);
    expect((target as { polluted?: unknown }).polluted).toBeUndefined();
    expect(JSON.stringify(target)).toBe('{"__proto__":{"polluted":"x"}}');
  });

  it('nullPrototypeRecord takes __proto__ by plain assignment as an own key', () => {
    const out = nullPrototypeRecord();
    out['__proto__'] = { polluted: 'y' };
    expect(Object.getOwnPropertyNames(out)).toEqual(['__proto__']);
    expect(Object.getPrototypeOf(out)).toBeNull();
    expect(JSON.stringify(out)).toBe('{"__proto__":{"polluted":"y"}}');
  });

  it('hasPlainPrototype admits a plain and a null-prototype object and refuses a Date / Map / class instance / typed array', () => {
    expect(hasPlainPrototype({})).toBe(true);
    expect(hasPlainPrototype(nullPrototypeRecord())).toBe(true);
    expect(hasPlainPrototype([])).toBe(false);
    expect(hasPlainPrototype(new Date(0))).toBe(false);
    expect(hasPlainPrototype(new Map())).toBe(false);
    expect(hasPlainPrototype(new Uint8Array(1))).toBe(false);
    class Thing {}
    expect(hasPlainPrototype(new Thing())).toBe(false);
  });
});
