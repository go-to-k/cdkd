import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript-v6';
import { describe, expect, it } from 'vite-plus/test';
import { CONTENDED_CASE_TIMEOUT_MS } from '../../contended-case-timeout.js';

/**
 * `DeployEngine` (#4200) and `IntrinsicFunctionResolver` (#4337) split their
 * methods into mixin modules, and a member a mixin reads went from `private` to
 * `@internal`. `@internal` only keeps the member out of the published `.d.ts`;
 * inside `src/` it is plain public, so the compiler no longer stops another
 * module from calling it. Fences that reason about who can reach a member (the
 * resolver's drain-budget graph is one) assume only the host and its own split
 * modules do.
 *
 * So: no file outside a host's family may reach an `@internal` member of that
 * family through any receiver. Resolved by the type checker, not by name, since
 * `logger` and `strictGetAtt` are also fields of unrelated objects.
 */
const REPO_ROOT = join(import.meta.dirname, '../../..');

const FAMILIES = [
  { host: 'src/deployment/deploy-engine.ts', dir: 'src/deployment/deploy-engine' },
  { host: 'src/deployment/intrinsic-function-resolver.ts', dir: 'src/deployment/intrinsic-resolver' },
] as const;

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : [];
  });

/** Repo-relative file -> the index of the family it belongs to. */
const familyOf = new Map<string, number>(
  FAMILIES.flatMap(({ host, dir }, i) =>
    [host, ...readdirSync(join(REPO_ROOT, dir)).map((f) => `${dir}/${f}`)].map(
      (file) => [file, i] as const
    )
  )
);

const isInternal = (decl: ts.Declaration): boolean =>
  ts.getJSDocTags(decl).some((tag) => tag.tagName.text === 'internal');

/** `file:line expr` for every reach of a family's `@internal` member from outside it. */
function outsideReaches(): { reaches: string[]; scanned: number } {
  // Every non-family file, not only the ones that NAME a host: a re-export
  // (`src/index.ts`) or an inferred type reaches a host with no path in sight.
  // Every src file: a member of one family reaching another family's
  // `@internal` member is as much an outside caller as any other module.
  const roots = walk(join(REPO_ROOT, 'src'));
  const config = ts.parseJsonConfigFileContent(
    ts.readConfigFile(join(REPO_ROOT, 'tsconfig.json'), (p) => ts.sys.readFile(p)).config,
    ts.sys,
    REPO_ROOT
  );
  const program = ts.createProgram(roots, { ...config.options, noEmit: true });
  const checker = program.getTypeChecker();
  const reaches: string[] = [];
  for (const abs of roots) {
    const sf = program.getSourceFile(abs)!;
    const visit = (node: ts.Node): void => {
      let decl: ts.Declaration | undefined;
      if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
        const nameNode = ts.isPropertyAccessExpression(node) ? node.name : node.argumentExpression;
        decl = checker.getSymbolAtLocation(nameNode)?.declarations?.[0];
      } else if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
        // `const { member } = host` reaches the member without a dot.
        const key = node.propertyName ?? node.name;
        if (ts.isIdentifier(key)) {
          decl = checker.getTypeAtLocation(node.parent).getProperty(key.text)?.declarations?.[0];
        }
      }
      if (decl !== undefined) {
        const declFamily = familyOf.get(decl.getSourceFile().fileName.slice(REPO_ROOT.length + 1));
        const callerFamily = familyOf.get(abs.slice(REPO_ROOT.length + 1));
        if (declFamily !== undefined && declFamily !== callerFamily && isInternal(decl)) {
          const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
          reaches.push(`${abs.slice(REPO_ROOT.length + 1)}:${line} ${node.getText(sf).slice(0, 80)}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return { reaches, scanned: roots.length };
}

describe('split hosts keep their @internal members inside the family (#4200, #4337)', () => {
  it(
    'no src file outside a family reaches an @internal member of it',
    () => {
      const { reaches, scanned } = outsideReaches();
      // A floor: the scan must have found the engine's and the resolver's callers.
      expect(scanned).toBeGreaterThan(20);
      expect(
        reaches,
        'an @internal member is reached from outside its split host: route the call through a ' +
          'public member of the host, or move the caller into the family'
      ).toEqual([]);
    },
    CONTENDED_CASE_TIMEOUT_MS
  );
});
