/**
 * `indexNestedChildTemplates` — the `cdkd diff --recursive` twin of the
 * nested-template walk — must refuse a `Metadata['aws:asset:path']` that
 * resolves outside the directory it is joined onto (issue go-to-k/cdkd#3489).
 *
 * Its ABSOLUTE tripwire cannot see that shape, and `path.join` never lets an
 * absolute value leave the directory in the first place, so the two refusals
 * answer different questions and both are pinned here — including that their
 * messages stay distinguishable.
 */
import { describe, it, expect } from 'vite-plus/test';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { indexNestedChildTemplates } from '../../../src/cli/commands/diff-recursive.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';

function tmp(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'cdkd-diff-containment-')));
}

/** An assembly directory holding the parent template, plus a file OUTSIDE it. */
function assembly(): { parent: string; dir: string } {
  const root = tmp();
  const dir = join(root, 'cdk.out');
  mkdirSync(dir);
  writeFileSync(join(root, 'outside.json'), JSON.stringify({ Resources: {} }));
  return { parent: join(dir, 'Parent.template.json'), dir };
}

function template(assetPath: string): CloudFormationTemplate {
  return {
    Resources: {
      Child: {
        Type: 'AWS::CloudFormation::Stack',
        Metadata: { 'aws:asset:path': assetPath },
      },
    },
  } as unknown as CloudFormationTemplate;
}

const CONTAINMENT = /resolves to '.*', outside '.*'\./;

describe('indexNestedChildTemplates containment', () => {
  it('refuses an asset path that leaves the parent template directory', () => {
    const { parent } = assembly();

    expect(() => indexNestedChildTemplates(template('../outside.json'), parent)).toThrow(
      /Nested stack 'Child' has Metadata\['aws:asset:path'\]='\.\.\/outside\.json' which resolves to '.*outside\.json', outside/
    );
  });

  it('refuses one that stays inside lexically but leads out through a symlink', () => {
    const { parent, dir } = assembly();
    symlinkSync(dirname(dir), join(dir, 'link'), 'dir');

    expect(() => indexNestedChildTemplates(template('link/outside.json'), parent)).toThrow(
      /leads through a symbolic link to '.*outside\.json', outside/
    );
  });

  it('keeps the ABSOLUTE tripwire, with its own distinguishable message', () => {
    const { parent } = assembly();

    expect(() => indexNestedChildTemplates(template('/etc/hosts'), parent)).toThrow(
      /which is absolute/
    );
    expect(() => indexNestedChildTemplates(template('/etc/hosts'), parent)).not.toThrow(
      CONTAINMENT
    );
  });

  it('still indexes an ordinary sibling', () => {
    const { parent, dir } = assembly();

    expect(indexNestedChildTemplates(template('Child.nested.template.json'), parent)).toEqual({
      Child: join(dir, 'Child.nested.template.json'),
    });
  });

  it('still indexes a value that normalises back inside', () => {
    const { parent, dir } = assembly();

    expect(
      indexNestedChildTemplates(template('sub/../Child.nested.template.json'), parent)
    ).toEqual({ Child: join(dir, 'Child.nested.template.json') });
  });
});
