import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vite-plus/test';
import { IntrinsicFunctionResolver } from '../../../src/deployment/intrinsic-function-resolver.js';

/**
 * `IntrinsicFunctionResolver` (issue #4337) method groups live in mixin
 * modules: a `declare module '../<host>.js'`
 * augmentation tells the type checker the method exists, and the host module
 * assigns the mixin's function onto the class prototype. A MISSING assignment therefore typechecks clean and
 * fails only when the method is first called at runtime, which for a rare
 * refusal path may be never in the unit suite.
 *
 * The names come from the AUGMENTATION, the thing that hides the gap, not from
 * the implementations' signatures: a member declared there is exactly what the
 * checker will accept a call to. The modules are found by that header anywhere
 * under `src/deployment/`, so a later phase is checked without editing this file.
 *
 * `DeployEngine` (issue #4200) no longer has mixins: its split-out groups are
 * plain functions taking `engine` (or their deps) explicitly, so a missing
 * wiring is a type error and needs no row here.
 */
const DEPLOYMENT_DIR = fileURLToPath(new URL('../../../src/deployment/', import.meta.url));

/**
 * One row per class split this way: the module the augmentation names, the
 * class whose prototype receives the methods, and a floor of known files and
 * members so a parser that silently matches nothing cannot pass.
 */
const HOSTS = [
  {
    module: 'intrinsic-function-resolver',
    cls: IntrinsicFunctionResolver,
    // `clients.ts` / `cfn-fallback.ts` (collaborator classes) and
    // `stack-state.ts` / `masking-display.ts` / `parameter-secrets.ts` (plain
    // functions) no longer augment the class, so they are not listed.
    files: [
      'intrinsic-resolver/cross-stack.ts',
      'intrinsic-resolver/dynamic-refs.ts',
      'intrinsic-resolver/dynamic-ref-lookups.ts',
      'intrinsic-resolver/functions.ts',
      'intrinsic-resolver/getatt.ts',
      'intrinsic-resolver/getatt-heal.ts',
      'intrinsic-resolver/getatt-refusals.ts',
      'intrinsic-resolver/masking.ts',
      'intrinsic-resolver/params-conditions.ts',
      'intrinsic-resolver/refs.ts',
      'intrinsic-resolver/stack-output.ts',
      'intrinsic-resolver/string-functions.ts',
      'intrinsic-resolver/sub.ts',
    ],
    members: [
      'resolveGetAtt',
      'constructAttribute',
      'refuseUnconstructibleAttribute',
      'healBeforeConstructing',
      'resolveSecretsManagerReference',
      'resolveImportValue',
      'resolveGetStackOutput',
      'positionalNameMask',
      'evaluateConditions',
      'resolveKeyUnit',
      'resolveRef',
      'resolveDynamicReferencesWithLogTwin',
      'sendWithThrottleRetry',
      'resolveSub',
      'resolveIf',
      'maskSecretsRaw',
    ],
  },
] as const;

/** A member line: `name:`, `name?:`, `readonly name:`, or a method `name(` / `name<`. */
const MEMBER = /^\s+(?:readonly\s+)?(\w+)\??\s*[:(<]/gm;

function mixinModules(host: (typeof HOSTS)[number]): Array<{ file: string; names: string[] }> {
  const augmentation = new RegExp(
    `declare module '(?:\\.\\.?/)+${host.module.replace(/-/g, '\\-')}\\.js' \\{\\s*interface ${host.cls.name} \\{([\\s\\S]*?)\\n {2}\\}`,
    'g'
  );
  return readdirSync(DEPLOYMENT_DIR, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.ts'))
    .flatMap((file) => {
      const blocks = [...readFileSync(`${DEPLOYMENT_DIR}${file}`, 'utf8').matchAll(augmentation)];
      if (blocks.length === 0) return [];
      const names = blocks.flatMap((b) => [...b[1]!.matchAll(MEMBER)].map((m) => m[1]!));
      return [{ file, names }];
    });
}

describe.each(HOSTS)('$module mixin modules are wired onto the prototype (#4337)', (host) => {
  it('finds the mixin modules, and every augmentation declares at least one member', () => {
    const modules = mixinModules(host);
    expect(modules.map((m) => m.file)).toEqual(expect.arrayContaining([...host.files]));
    for (const { file, names } of modules) {
      expect(names.length, `${file}: augmentation parsed to no members`).toBeGreaterThan(0);
    }
    expect(modules.flatMap((m) => m.names)).toEqual(expect.arrayContaining([...host.members]));
  });

  it('exports every augmented member and assigns it as the SAME prototype method', async () => {
    for (const { file, names } of mixinModules(host)) {
      const mod = (await import(pathToFileURL(`${DEPLOYMENT_DIR}${file}`).href)) as Record<
        string,
        unknown
      >;
      for (const name of names) {
        expect(typeof mod[name], `${file}: augments \`${name}\` but does not export it`).toBe(
          'function'
        );
        expect(
          (host.cls.prototype as unknown as Record<string, unknown>)[name],
          `${file}: ${host.cls.name}.prototype.${name} is not wired — add it to the assignments after the class in ${host.module}.ts`
        ).toBe(mod[name]);
      }
    }
  });
});
