import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { IntrinsicFunctionResolver } from '../../../src/deployment/intrinsic-function-resolver.js';

/**
 * `DeployEngine` (issue #4200) and `IntrinsicFunctionResolver` (issue #4337)
 * method groups live in mixin modules: a `declare module '../<host>.js'`
 * augmentation tells the type checker the method exists, and the host module
 * assigns the mixin's function onto the class prototype. A MISSING assignment therefore typechecks clean and
 * fails only when the method is first called at runtime, which for a rare
 * refusal path may be never in the unit suite.
 *
 * The names come from the AUGMENTATION, the thing that hides the gap, not from
 * the implementations' signatures: a member declared there is exactly what the
 * checker will accept a call to. The modules are found by that header anywhere
 * under `src/deployment/`, so a later phase is checked without editing this file.
 */
const DEPLOYMENT_DIR = fileURLToPath(new URL('../../../src/deployment/', import.meta.url));

/**
 * One row per class split this way: the module the augmentation names, the
 * class whose prototype receives the methods, and a floor of known files and
 * members so a parser that silently matches nothing cannot pass.
 */
const HOSTS = [
  {
    module: 'deploy-engine',
    cls: DeployEngine,
    files: [
      'deploy-engine/create.ts',
      'deploy-engine/delete.ts',
      'deploy-engine/dependencies.ts',
      'deploy-engine/deploy-flow.ts',
      'deploy-engine/execute.ts',
      'deploy-engine/heal.ts',
      'deploy-engine/masking.ts',
      'deploy-engine/name-collision.ts',
      'deploy-engine/observed-capture.ts',
      'deploy-engine/outputs.ts',
      'deploy-engine/provision.ts',
      'deploy-engine/record-shape.ts',
      'deploy-engine/replacement.ts',
      'deploy-engine/resolver-context.ts',
      'deploy-engine/rollback.ts',
      'deploy-engine/routing.ts',
      'deploy-engine/update-in-place.ts',
      'deploy-engine/update-replace.ts',
      'deploy-engine/update.ts',
    ],
    members: [
      'replacementNameOrigin',
      'orphanedNameCollisionAdvice',
      'resolveOutputs',
      'performRollback',
      'drainObservedCaptures',
      'redactOutputs',
      'replaceDeleteFirstAndRecreate',
      'healStaleAttributes',
      'provisionCreate',
      'provisionUpdate',
      'updateByReplacement',
      'updateInPlace',
      'provisionDelete',
      'provisionResource',
      'executeDeployment',
      'doDeployWithPrefetch',
      'buildResolverContext',
      'peekRoutingForLabel',
      'propertiesToRecord',
      'addImplicitDeleteDependencies',
    ],
  },
  {
    module: 'intrinsic-function-resolver',
    cls: IntrinsicFunctionResolver,
    files: [
      'intrinsic-resolver/cfn-fallback.ts',
      'intrinsic-resolver/cross-stack.ts',
      'intrinsic-resolver/dynamic-refs.ts',
      'intrinsic-resolver/functions.ts',
      'intrinsic-resolver/getatt.ts',
      'intrinsic-resolver/masking.ts',
      'intrinsic-resolver/params-conditions.ts',
      'intrinsic-resolver/parameter-secrets.ts',
      'intrinsic-resolver/refs.ts',
      'intrinsic-resolver/clients.ts',
      'intrinsic-resolver/stack-output.ts',
      'intrinsic-resolver/stack-state.ts',
      'intrinsic-resolver/string-functions.ts',
    ],
    members: [
      'resolveGetAtt',
      'constructAttribute',
      'refuseUnconstructibleAttribute',
      'resolveImportValue',
      'resolveGetStackOutput',
      'lookupCfnExport',
      'getCrossAccountStackState',
      'evaluateConditions',
      'refuseCoercedInheritedSecret',
      'resolveRef',
      'clientsForRegion',
      'resolveDynamicReferencesWithLogTwin',
      'sendWithThrottleRetry',
      'resolveSub',
      'resolveIf',
      'displayMasked',
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

describe.each(HOSTS)('$module mixin modules are wired onto the prototype (#4200, #4337)', (host) => {
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
