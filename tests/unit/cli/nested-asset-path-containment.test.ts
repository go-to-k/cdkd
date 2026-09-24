/**
 * `cdkd import --migrate-from-cloudformation` and `cdkd export` each carry
 * their own copy of the nested-template index (kept separate on purpose — see
 * each function's doc comment), and each must refuse a
 * `Metadata['aws:asset:path']` that resolves outside the directory it is
 * joined onto (issue go-to-k/cdkd#3489).
 *
 * They are the two sites beyond the synth / diff / deploy walks: import READS
 * the escaping file and writes what it finds into cdkd state, export reads it
 * and writes it into the CloudFormation template it hands back to the user.
 * Their ABSOLUTE tripwire cannot see the shape, and `path.join` never lets an
 * absolute value leave the directory, so both refusals exist and both are
 * pinned here — including that their messages stay apart.
 */
import { describe, it, expect } from 'vite-plus/test';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { indexGrandchildTemplatePaths } from '../../../src/cli/commands/import.js';
import { indexNestedTemplatePaths } from '../../../src/cli/commands/export.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';

function tmp(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'cdkd-nested-asset-containment-')));
}

/** A cdk.out holding the child template, plus a file OUTSIDE it. */
function assembly(): { child: string; dir: string } {
  const root = tmp();
  const dir = join(root, 'cdk.out');
  mkdirSync(dir);
  writeFileSync(join(root, 'outside.json'), JSON.stringify({ Resources: {} }));
  return { child: join(dir, 'Child.nested.template.json'), dir };
}

function template(assetPath: string): CloudFormationTemplate {
  return {
    Resources: {
      Grandchild: {
        Type: 'AWS::CloudFormation::Stack',
        Properties: { TemplateURL: 'x' },
        Metadata: { 'aws:asset:path': assetPath },
      },
    },
  } as unknown as CloudFormationTemplate;
}

const CONTAINMENT = /resolves to .*, outside .*\./;

/**
 * The two indexers take their base differently — import derives it from the
 * child template PATH, export is handed the directory — so each is driven
 * through its own adapter rather than by pretending they share a signature.
 */
const SITES: ReadonlyArray<{
  name: string;
  index: (assetPath: string, child: string, dir: string) => Record<string, string>;
  subject: RegExp;
}> = [
  {
    name: 'cdkd import --migrate-from-cloudformation',
    index: (assetPath, child) => indexGrandchildTemplatePaths(template(assetPath), child),
    subject: /grandchild nested-stack 'Grandchild'/,
  },
  {
    name: 'cdkd export',
    index: (assetPath, _child, dir) =>
      indexNestedTemplatePaths(
        template(assetPath) as unknown as Record<string, unknown>,
        dir
      ),
    subject: /nested-stack 'Grandchild'/,
  },
];

for (const site of SITES) {
  describe(`${site.name}: nested asset-path containment`, () => {
    it('refuses one that leaves the directory, naming the value and the resolved path', () => {
      const { child, dir } = assembly();

      expect(() => site.index('../outside.json', child, dir)).toThrow(site.subject);
      expect(() => site.index('../outside.json', child, dir)).toThrow(
        /Metadata\['aws:asset:path'\]='\.\.\/outside\.json' which resolves to .*outside\.json, outside/
      );
    });

    it('refuses one that stays inside lexically but leads out through a symlink', () => {
      const { child, dir } = assembly();
      symlinkSync(dirname(dir), join(dir, 'link'), 'dir');

      expect(() => site.index('link/outside.json', child, dir)).toThrow(
        /leads through a symbolic link to .*outside\.json, outside/
      );
    });

    it('keeps the ABSOLUTE tripwire, with its own distinguishable message', () => {
      const { child, dir } = assembly();

      expect(() => site.index('/abs/foo.json', child, dir)).toThrow(/which is absolute/);
      expect(() => site.index('/abs/foo.json', child, dir)).not.toThrow(CONTAINMENT);
    });

    it('still indexes an ordinary sibling', () => {
      const { child, dir } = assembly();

      expect(site.index('Grandchild.nested.template.json', child, dir)).toEqual({
        Grandchild: join(dir, 'Grandchild.nested.template.json'),
      });
    });

    it('still indexes a value that normalises back inside', () => {
      const { child, dir } = assembly();

      expect(site.index('sub/../Grandchild.nested.template.json', child, dir)).toEqual({
        Grandchild: join(dir, 'Grandchild.nested.template.json'),
      });
    });
  });
}
