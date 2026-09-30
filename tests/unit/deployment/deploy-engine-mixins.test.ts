import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';

/**
 * `DeployEngine` method groups live in mixin modules (issue #4200): each is an
 * `export function name(this: DeployEngine, ...)` that `deploy-engine.ts`
 * assigns onto `DeployEngine.prototype`, while a `declare module` augmentation
 * tells the type checker the method exists. A MISSING assignment therefore
 * typechecks clean and fails only when the method is first called at runtime,
 * which for a rare refusal path may be never in the unit suite.
 *
 * The population is DERIVED from the directory, so a module added by a later
 * phase is checked without editing this file.
 */
const DEPLOYMENT_DIR = fileURLToPath(new URL('../../../src/deployment/', import.meta.url));

const MIXIN_FN = /^export (?:async )?function (\w+)(?:<[^(]*>)?\(\s*this: DeployEngine\b/gm;

function mixinModules(): Array<{ file: string; names: string[] }> {
  return readdirSync(DEPLOYMENT_DIR)
    .filter((f) => /^deploy-engine-.+\.ts$/.test(f))
    .map((file) => ({
      file,
      names: [...readFileSync(`${DEPLOYMENT_DIR}${file}`, 'utf8').matchAll(MIXIN_FN)].map(
        (m) => m[1]!
      ),
    }))
    .filter((m) => m.names.length > 0);
}

describe('DeployEngine mixin modules are wired onto the prototype (#4200)', () => {
  it('finds the mixin modules — the anti-vacuity floor', () => {
    const modules = mixinModules();
    expect(modules.map((m) => m.file)).toContain('deploy-engine-name-collision.ts');
    expect(modules.flatMap((m) => m.names)).toContain('replacementNameOrigin');
  });

  it('assigns every exported `this: DeployEngine` function as the SAME prototype method', async () => {
    for (const { file, names } of mixinModules()) {
      const mod = (await import(`${DEPLOYMENT_DIR}${file}`)) as Record<string, unknown>;
      for (const name of names) {
        expect(
          (DeployEngine.prototype as unknown as Record<string, unknown>)[name],
          `${file}: DeployEngine.prototype.${name} is not wired — add it to the assignments after the class in deploy-engine.ts`
        ).toBe(mod[name]);
      }
    }
  });
});
