import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';

/**
 * `DeployEngine` method groups live in mixin modules (issue #4200): a
 * `declare module './deploy-engine.js'` augmentation tells the type checker the
 * method exists, and `deploy-engine.ts` assigns the module's function onto
 * `DeployEngine.prototype`. A MISSING assignment therefore typechecks clean and
 * fails only when the method is first called at runtime, which for a rare
 * refusal path may be never in the unit suite.
 *
 * The names come from the AUGMENTATION, the thing that hides the gap, not from
 * the implementations' signatures: a member declared there is exactly what the
 * checker will accept a call to. The modules are found by that header anywhere
 * under `src/deployment/`, so a later phase is checked without editing this file.
 */
const DEPLOYMENT_DIR = fileURLToPath(new URL('../../../src/deployment/', import.meta.url));

const AUGMENTATION =
  /declare module '(?:\.\.?\/)+deploy-engine\.js' \{\s*interface DeployEngine \{([\s\S]*?)\n {2}\}/g;

/** A member line: `name:`, `name?:`, `readonly name:`, or a method `name(` / `name<`. */
const MEMBER = /^\s+(?:readonly\s+)?(\w+)\??\s*[:(<]/gm;

function mixinModules(): Array<{ file: string; names: string[] }> {
  return readdirSync(DEPLOYMENT_DIR, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.ts'))
    .flatMap((file) => {
      const blocks = [...readFileSync(`${DEPLOYMENT_DIR}${file}`, 'utf8').matchAll(AUGMENTATION)];
      if (blocks.length === 0) return [];
      const names = blocks.flatMap((b) => [...b[1]!.matchAll(MEMBER)].map((m) => m[1]!));
      return [{ file, names }];
    });
}

describe('DeployEngine mixin modules are wired onto the prototype (#4200)', () => {
  it('finds the mixin modules, and every augmentation declares at least one member', () => {
    const modules = mixinModules();
    expect(modules.map((m) => m.file)).toEqual(
      expect.arrayContaining(['deploy-engine-name-collision.ts', 'deploy-engine-outputs.ts'])
    );
    for (const { file, names } of modules) {
      expect(names.length, `${file}: augmentation parsed to no members`).toBeGreaterThan(0);
    }
    expect(modules.flatMap((m) => m.names)).toEqual(
      expect.arrayContaining(['replacementNameOrigin', 'orphanedNameCollisionAdvice', 'resolveOutputs'])
    );
  });

  it('exports every augmented member and assigns it as the SAME prototype method', async () => {
    for (const { file, names } of mixinModules()) {
      const mod = (await import(pathToFileURL(`${DEPLOYMENT_DIR}${file}`).href)) as Record<
        string,
        unknown
      >;
      for (const name of names) {
        expect(typeof mod[name], `${file}: augments \`${name}\` but does not export it`).toBe(
          'function'
        );
        expect(
          (DeployEngine.prototype as unknown as Record<string, unknown>)[name],
          `${file}: DeployEngine.prototype.${name} is not wired — add it to the assignments after the class in deploy-engine.ts`
        ).toBe(mod[name]);
      }
    }
  });
});
