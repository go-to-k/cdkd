/**
 * `NestedStackProvider.indexGrandchildTemplates` — the layer-7 twin of the
 * nested-template walk, and the one site that runs DURING a deploy — must
 * refuse a `Metadata['aws:asset:path']` that resolves outside the directory it
 * is joined onto (issue go-to-k/cdkd#3489). Without it the child engine
 * deployed whatever the escaping file parsed to.
 *
 * Normally unreachable, for the same reason the absolute arm beside it is:
 * `refuseMalformedNestedTemplateTree` reports the whole subtree before any
 * level deploys. It stays as the per-level backstop and is driven directly
 * here, like that arm. Both refusals are pinned, including that their messages
 * stay apart — `path.join` never lets an absolute value escape, so "absolute"
 * and "escapes" are different questions.
 */
import { describe, it, expect } from 'vite-plus/test';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { NestedStackProvider } from '../../../src/provisioning/providers/nested-stack-provider.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';

type IndexFn = (template: unknown, childTemplatePath: string) => Record<string, string>;

function indexer(): IndexFn {
  const provider = new NestedStackProvider();
  return (
    provider as unknown as { indexGrandchildTemplates: IndexFn }
  ).indexGrandchildTemplates.bind(provider) as IndexFn;
}

function tmp(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'cdkd-nested-containment-')));
}

/** A cdk.out holding the child template, plus a file OUTSIDE it. */
function assembly(): { child: string; dir: string } {
  const root = tmp();
  const dir = join(root, 'cdk.out');
  mkdirSync(dir);
  writeFileSync(join(root, 'outside.json'), JSON.stringify({ Resources: {} }));
  return { child: join(dir, 'Child.nested.template.json'), dir };
}

function template(assetPath: string): unknown {
  return {
    Resources: {
      Grand: {
        Type: 'AWS::CloudFormation::Stack',
        Metadata: { 'aws:asset:path': assetPath },
      },
    },
  };
}

const CONTAINMENT = /resolves to .*, outside .*\./;

describe('NestedStackProvider.indexGrandchildTemplates containment', () => {
  it('refuses an asset path that leaves the child template directory', () => {
    const { child } = assembly();

    expect(() => indexer()(template('../outside.json'), child)).toThrow(
      /NestedStackProvider: nested-stack Grand has Metadata\['aws:asset:path'\]=\.\.\/outside\.json which resolves to .*outside\.json, outside/
    );
  });

  it('marks the containment refusal non-retryable, as the absolute arm is', () => {
    // A bare Error here is retried by the deploy engine's backoff, which can
    // only fail again — and on a hostile assembly it re-reads the outside file
    // once per attempt.
    const { child } = assembly();

    let err: unknown;
    try {
      indexer()(template('../outside.json'), child);
    } catch (e) {
      err = e;
    }

    expect(err).toBeInstanceOf(Error);
    expect(isMarkedNonRetryable(err as Error)).toBe(true);
  });

  it('renders the refusal display-safe: a forged logical id cannot write terminal bytes', () => {
    const { child } = assembly();
    const forged = `G${String.fromCharCode(0x1b)}[2KFORGED`;

    let message = '';
    try {
      indexer()(
        {
          Resources: {
            [forged]: {
              Type: 'AWS::CloudFormation::Stack',
              Metadata: { 'aws:asset:path': `../${forged}.json` },
            },
          },
        },
        child
      );
    } catch (e) {
      message = (e as Error).message;
    }

    // eslint-disable-next-line no-control-regex
    const FORGING = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
    expect(message).not.toMatch(FORGING);
    expect(message).toMatch(CONTAINMENT);
  });

  it('refuses one that stays inside lexically but leads out through a symlink', () => {
    const { child, dir } = assembly();
    symlinkSync(dirname(dir), join(dir, 'link'), 'dir');

    expect(() => indexer()(template('link/outside.json'), child)).toThrow(
      /leads through a symbolic link to .*outside\.json, outside/
    );
  });

  it('keeps the ABSOLUTE tripwire, with its own distinguishable message', () => {
    const { child } = assembly();

    expect(() => indexer()(template('/abs/g.json'), child)).toThrow(/which is absolute/);
    expect(() => indexer()(template('/abs/g.json'), child)).not.toThrow(CONTAINMENT);
  });

  it('still indexes an ordinary sibling', () => {
    const { child, dir } = assembly();

    expect(indexer()(template('Grand.nested.template.json'), child)).toEqual({
      Grand: join(dir, 'Grand.nested.template.json'),
    });
  });

  it('still indexes a value that normalises back inside', () => {
    const { child, dir } = assembly();

    expect(indexer()(template('sub/../Grand.nested.template.json'), child)).toEqual({
      Grand: join(dir, 'Grand.nested.template.json'),
    });
  });
});
