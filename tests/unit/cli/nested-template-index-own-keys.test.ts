/**
 * Every nested-template index in cdkd maps a template logical id to the child
 * template's path, and each of the four builders below is a deliberate
 * duplicate of the others (see each function's doc comment). A logical id is a
 * template key, so `JSON.parse` hands these walks `__proto__` as an ordinary
 * own data property — and on a `{}` literal the assignment runs
 * `Object.prototype`'s setter instead, dropping the row (issue
 * go-to-k/cdkd#3480).
 *
 * Both polarities are pinned per builder, because the two halves fail
 * differently and only one of them is fixed by defining the key:
 *
 * - **The DROP.** `idx['__proto__'] = path` on a `{}` literal never creates the
 *   key, so the row vanishes from `Object.keys` and the lookup answers
 *   `Object.prototype`, which reaches `readFileSync` as `[object Object]`.
 * - **The INHERITED ANSWER.** A `{}` literal also answers a lookup for a key
 *   that was NEVER indexed when the name collides with `Object.prototype`
 *   (`toString`, `valueOf`, `constructor`, `toLocaleString`). SIX readers test
 *   exactly that with `if (!idx[id])` — `NestedStackProvider.create` /
 *   `update`, `buildDiffTree` (`diff-recursive.ts`),
 *   `validateNestedStackShape` and `importNestedStackChildrenRecursive`
 *   (`import.ts`), and `buildPerStackImportNodes` (`export.ts`) — so an
 *   inherited member is TRUTHY there and skips a refusal that exists to fire.
 *
 * Which assertions below actually DISCRIMINATE, so nobody trims the wrong one:
 * `__proto__` appearing in `Object.keys`, and `index[NEVER_INDEXED]` being
 * `undefined`. `constructor` / `toString` as INDEXED rows pass pre-fix too —
 * only `__proto__` reaches the inherited setter, the other two just shadow —
 * and they are kept as documentation that ordinary shadowing is unaffected.
 *
 * `defineOwnKey` would close the first and leave the second, which is why all
 * four builders take `nullPrototypeRecord()`: with no prototype there is
 * nothing to inherit. `NestedStackProvider.indexGrandchildTemplates` is the
 * fifth site and was already converted by go-to-k/cdkd#3448.
 */
import { describe, it, expect } from 'vite-plus/test';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { indexGrandchildTemplatePaths } from '../../../src/cli/commands/import.js';
import {
  buildPerStackImportNodes,
  indexNestedTemplatePaths,
  type CdkdStateStackTree,
} from '../../../src/cli/commands/export.js';
import { indexNestedChildTemplates } from '../../../src/cli/commands/diff-recursive.js';
import { AssemblyReader } from '../../../src/synthesis/assembly-reader.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';

/** Names that resolve through `Object.prototype` on a plain object. */
const INHERITED_NAMES = ['__proto__', 'constructor', 'toString'] as const;
/** Indexed by no test below — the inherited-answer probe. */
const NEVER_INDEXED = 'toLocaleString';

function tmp(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'cdkd-3480-')));
}

/**
 * A `cdk.out` whose parent template carries one nested-stack row per name in
 * `rows`, plus an ordinary row, all pointing at one real child template.
 *
 * Written as JSON TEXT on purpose: a JS object literal spelled
 * `{ __proto__: ... }` sets the prototype rather than creating the key, so
 * building the fixture in JS would not reproduce what `JSON.parse` produces.
 */
function assembly(rows: readonly string[]): { dir: string; parentPath: string } {
  const dir = join(tmp(), 'cdk.out');
  mkdirSync(dir);
  writeFileSync(join(dir, 'child.nested.template.json'), '{"Resources":{}}');
  const row = '{"Type":"AWS::CloudFormation::Stack","Metadata":{"aws:asset:path":"child.nested.template.json"}}';
  const resources = [...rows, 'Ordinary'].map((k) => `${JSON.stringify(k)}:${row}`).join(',');
  const parentPath = join(dir, 'Parent.template.json');
  writeFileSync(parentPath, `{"Resources":{${resources}}}`);
  return { dir, parentPath };
}

function parse(parentPath: string): CloudFormationTemplate {
  // Round-tripping through the file is the point: these builders are fed by
  // `JSON.parse`, which is what makes `__proto__` an own key.
  return JSON.parse(readFileSync(parentPath, 'utf-8')) as CloudFormationTemplate;
}

/** The shared contract, asserted against whatever built the index. */
function assertOwnKeyIndex(index: Record<string, string>, childPath: string): void {
  // POLARITY 1: every inherited-collision row is a real, enumerable own key.
  for (const name of INHERITED_NAMES) {
    expect(Object.keys(index)).toContain(name);
    expect(Object.hasOwn(index, name)).toBe(true);
    expect(index[name]).toBe(childPath);
  }
  // POLARITY 2: an ordinary row is untouched by the change.
  expect(index['Ordinary']).toBe(childPath);
  // POLARITY 3: a key that was never indexed MISSES, even though its name
  // collides with `Object.prototype`. This is the half `defineOwnKey` on a
  // `{}` literal would have left answering a function.
  expect(index[NEVER_INDEXED]).toBeUndefined();
  expect(Object.hasOwn(index, NEVER_INDEXED)).toBe(false);
  // ...which is what makes the readers' `if (!idx[id])` guard fire.
  expect(!index[NEVER_INDEXED]).toBe(true);
}

describe('nested-template indexes keep a template-derived key as an own key (#3480)', () => {
  it('AssemblyReader.extractStackInfo — the ROOT index deploy / diff / import / export consume', () => {
    const { dir } = assembly(INHERITED_NAMES);
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify({
        version: '36.0.0',
        artifacts: {
          Parent: {
            type: 'aws:cloudformation:stack',
            environment: 'aws://123456789012/us-east-1',
            properties: { templateFile: 'Parent.template.json', stackName: 'Parent' },
          },
        },
      })
    );

    const reader = new AssemblyReader();
    const stacks = reader.readAssembly(dir, reader.readManifest(dir)).stacks;
    const index = stacks.find((s) => s.stackName === 'Parent')?.nestedTemplates;

    expect(index).toBeDefined();
    assertOwnKeyIndex(index!, join(dir, 'child.nested.template.json'));
  });

  it('diff-recursive.indexNestedChildTemplates — the recursive diff walk', () => {
    const { dir, parentPath } = assembly(INHERITED_NAMES);

    const index = indexNestedChildTemplates(parse(parentPath), parentPath);

    assertOwnKeyIndex(index, join(dir, 'child.nested.template.json'));
  });

  it('export.indexNestedTemplatePaths — the cdkd export walk', () => {
    const { dir, parentPath } = assembly(INHERITED_NAMES);

    const index = indexNestedTemplatePaths(
      parse(parentPath) as unknown as Record<string, unknown>,
      dir
    );

    assertOwnKeyIndex(index, join(dir, 'child.nested.template.json'));
  });

  it('import.indexGrandchildTemplatePaths — the CFn-migration walk', () => {
    const { dir, parentPath } = assembly(INHERITED_NAMES);

    const index = indexGrandchildTemplatePaths(parse(parentPath), parentPath);

    assertOwnKeyIndex(index, join(dir, 'child.nested.template.json'));
  });

  it('a template with no indexable nested row still yields no index at all, not a populated one', () => {
    // The ABSENT arm: `extractStackInfo` omits `nestedTemplates` when no row
    // carried a usable asset path, which is why every consumer's `??` fallback
    // has to build a null-prototype record rather than a `{}` literal.
    const dir = join(tmp(), 'cdk.out');
    mkdirSync(dir);
    writeFileSync(
      join(dir, 'Parent.template.json'),
      // A nested row named `toString` carrying NO `aws:asset:path` -- the exact
      // shape `validateNestedStackShape` exists to report.
      '{"Resources":{"toString":{"Type":"AWS::CloudFormation::Stack"}}}'
    );
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify({
        version: '36.0.0',
        artifacts: {
          Parent: {
            type: 'aws:cloudformation:stack',
            environment: 'aws://123456789012/us-east-1',
            properties: { templateFile: 'Parent.template.json', stackName: 'Parent' },
          },
        },
      })
    );

    const reader = new AssemblyReader();
    const stacks = reader.readAssembly(dir, reader.readManifest(dir)).stacks;

    expect(stacks.find((s) => s.stackName === 'Parent')?.nestedTemplates).toBeUndefined();
  });

  it('export.buildPerStackImportNodes refuses a child row named toString instead of reading a prototype member', () => {
    // WHY the `??` fallbacks have to build a null-prototype record rather than a
    // `{}` literal: this is the fourth `if (!childTemplatePath)` reader, and it
    // is reached with the fallback bag whenever the stack carried no indexable
    // row. Handed a PLAIN empty object it would read
    // `Object.prototype.toString` -- truthy -- skip the out-of-sync refusal and
    // hand a function to `readNestedChildTemplateFile`.
    const state = {
      version: 10 as const,
      stackName: 'Root',
      region: 'us-east-1',
      resources: {},
      outputs: {},
      lastModified: 0,
    };
    const child: CdkdStateStackTree = {
      stackName: 'Root~toString',
      region: 'us-east-1',
      state,
      nestedChildren: new Map(),
    };
    const tree: CdkdStateStackTree = {
      stackName: 'Root',
      region: 'us-east-1',
      state,
      nestedChildren: new Map([['toString', child]]),
    };

    // The bag comes from the PRODUCTION builder rather than a hand-rolled
    // `Object.create(null)`, so this case goes red if
    // `indexNestedTemplatePaths` regresses to a `{}` literal — a hand-rolled
    // bag would keep passing and assert nothing about src. `Resources: {}` is
    // TRUTHY, so this reaches the builder's own container line and loops zero
    // times; it does not take the early `return result` guard above it.
    const emptyIndex = indexNestedTemplatePaths({ Resources: {} }, tmp());

    expect(() =>
      buildPerStackImportNodes('Root', { Resources: {} }, emptyIndex, 'json', tree)
    ).toThrow(/no Metadata\['aws:asset:path'\]/);
  });
});
