/**
 * `ec2-provider.ts` keeps only a few methods in its class body; the rest live
 * in `providers/ec2/*.ts` as `this: EC2Provider` functions, collected into
 * one `<module>Methods` object per module and installed on the prototype by
 * the loop at the bottom of `ec2-provider.ts`. Nothing type-checks that
 * hand-off: the interface merge declares every member whether or not it is
 * installed. A module left out of the loop, a function left out of its
 * module's object, or an object member bound to the wrong function would
 * surface only on the code path that calls it. This pins all three for the
 * whole family, read recursively from the companion directory.
 */
import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vite-plus/test';
import { EC2Provider } from '../../../src/provisioning/providers/ec2-provider.js';
import { companionFiles } from '../../../scripts/provider-companion-files.js';

const HOST = fileURLToPath(
  new URL('../../../src/provisioning/providers/ec2-provider.ts', import.meta.url)
);
const FILES = companionFiles(HOST);

/** Source with comments removed, so a commented-out declaration does not count. */
const code = (path: string): string =>
  readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

/** Every `export [async] function name(this: EC2Provider` a module declares. */
const declaredThisFunctions = (path: string): string[] =>
  [...code(path).matchAll(/export\s+(?:async\s+)?function\s+(\w+)\s*(?:<[^(]*>)?\(\s*this:\s*EC2Provider\b/g)].map(
    (m) => m[1]!
  );

const CLASS_BODY_METHODS = [
  'create',
  'update',
  'delete',
  'getAttribute',
  'isSameResource',
  'import',
] as const;

describe('EC2Provider prototype install of its companion-module methods', () => {
  it('reads the companion directory (floors)', () => {
    expect(FILES.length).toBeGreaterThanOrEqual(29);
    const total = FILES.reduce((n, f) => n + declaredThisFunctions(f).length, 0);
    expect(total).toBeGreaterThanOrEqual(170);
  });

  it.each(FILES.map((f) => [relative(HOST, f), f] as const))(
    '%s: every this:EC2Provider function is in its Methods object and installed as a class method',
    async (_rel, file) => {
      const declared = declaredThisFunctions(file);
      const mod = (await import(file)) as Record<string, unknown>;
      const objects = Object.entries(mod).filter(([name]) => /^[a-z]\w*Methods$/.test(name));
      if (declared.length === 0) {
        // A support module: holds no methods, so exports no Methods object.
        expect(objects).toEqual([]);
        return;
      }
      // Per-file floor: a method module exports exactly one Methods object.
      expect(objects).toHaveLength(1);
      const members = objects[0]![1] as Record<string, unknown>;
      expect(Object.keys(members).sort()).toEqual([...declared].sort());
      for (const name of declared) {
        // Bound to the module's own function of the same name, not a sibling.
        expect(members[name], name).toBe(mod[name]);
        const descriptor = Object.getOwnPropertyDescriptor(EC2Provider.prototype, name);
        expect(descriptor?.value, name).toBe(mod[name]);
        expect(descriptor, name).toMatchObject({
          writable: true,
          configurable: true,
          enumerable: false,
        });
      }
    }
  );

  it('the prototype holds exactly the class-body methods plus the installed ones', async () => {
    const installed = new Set<string>();
    for (const file of FILES) for (const name of declaredThisFunctions(file)) installed.add(name);
    const own = Object.getOwnPropertyNames(EC2Provider.prototype).filter((n) => n !== 'constructor');
    expect(own.sort()).toEqual([...CLASS_BODY_METHODS, ...installed].sort());
    // No name is both a class-body method and an installed one (the install would overwrite it).
    for (const name of CLASS_BODY_METHODS) expect(installed.has(name), name).toBe(false);
    // An instance resolves every installed method through the prototype.
    const provider = Object.create(EC2Provider.prototype) as Record<string, unknown>;
    for (const name of installed) expect(typeof provider[name], name).toBe('function');
  });
});
