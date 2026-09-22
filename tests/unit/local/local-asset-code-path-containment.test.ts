/**
 * `Metadata['aws:asset:path']` becomes a read-only BIND MOUNT at `/var/task`
 * (or `/opt` for a layer) in a container running handler code the same
 * assembly supplied (issue
 * [#3494](https://github.com/go-to-k/cdkd/issues/3494)).
 *
 * Both resolvers — `cdkd local invoke`'s in `src/local/lambda-resolver.ts` and
 * `cdkd local start-api`'s in `src/cli/commands/local-start-api.ts` — spelled
 * the resolution as `isAbsolute(p) ? p : resolve(cdkOutDir, p)`, so an
 * absolute value was honoured ON PURPOSE and `..` folded exactly as `join`
 * does. Measured before the fix against a throwaway directory beside the
 * assembly: both shapes, at both sites, returned the outside directory
 * verbatim as the path to mount.
 *
 * TWO REFUSALS, and both polarities of each, per site. They are asserted apart
 * because they answer different questions: refusing `..` while honouring an
 * absolute path would close almost nothing and look closed.
 *
 * THE WIRING PAIR is the part a guard-only suite misses. On
 * go-to-k/cdkd#3493 the whole suite stayed green with the bound argument
 * deleted at a call site, because every case was a TOP-LEVEL shape where the
 * manifest directory and the app outdir coincide. So each site gets a Stage
 * manifest, where they do not:
 *
 * - `../asset.<hash>` ACCEPTED — reds if the bound is dropped (fails closed,
 *   refusing every legitimate Stage asset: go-to-k/cdkd#3493's B1);
 * - `../../victim` REFUSED from that same manifest — reds if the bound is
 *   widened past the app outdir (fails open).
 */
import { describe, expect, it } from 'vite-plus/test';
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveLambdaTarget } from '../../../src/local/lambda-resolver.js';
import { resolveLambdaByLogicalId } from '../../../src/cli/commands/local-start-api.js';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';

function tmp(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'cdkd-local-asset-')));
}

interface Assembly {
  /** The app's outdir — the containment bound. */
  outdir: string;
  /** The directory the manifest lives in; differs from `outdir` for a Stage. */
  manifestDir: string;
  /** A throwaway directory OUTSIDE the outdir. Never a real sensitive path. */
  outer: string;
  stack: StackInfo;
}

/**
 * An assembly whose one Lambda carries `assetPath`. `stagePrefix` puts the
 * manifest in `cdk.out/assembly-<Stage>/` while its asset stays staged in
 * `cdk.out`, which is what `cdk synth` does for a `cdk.Stage`.
 */
function assembly(
  assetPath: string,
  opts: { stage?: boolean; omitBound?: boolean; layer?: boolean } = {}
): Assembly {
  const outer = tmp();
  const outdir = join(outer, 'cdk.out');
  const manifestDir = opts.stage ? join(outdir, 'assembly-MyStage') : outdir;
  mkdirSync(manifestDir, { recursive: true });
  // A THROWAWAY victim, created so the `existsSync` check in the invoke
  // resolver cannot mask the containment verdict with a "does not exist".
  mkdirSync(join(outer, 'throwaway-victim'));
  mkdirSync(join(outdir, 'asset.abc123'));
  mkdirSync(join(outdir, 'nested'), { recursive: true });
  writeFileSync(join(manifestDir, 'Stk.assets.json'), JSON.stringify({ version: '54.0.0' }));

  const fn = {
    Type: 'AWS::Lambda::Function',
    Properties: {
      Runtime: 'nodejs20.x',
      Handler: 'index.handler',
      Code: {},
      ...(opts.layer ? { Layers: [{ Ref: 'Lyr' }] } : {}),
    },
    // In the LAYER cases the subject under test is the layer's own metadata,
    // so the function's must be a benign path that still resolves from
    // wherever this assembly's manifest sits.
    Metadata: {
      'aws:asset:path': opts.layer
        ? opts.stage
          ? '../asset.abc123'
          : 'asset.abc123'
        : assetPath,
    },
  };
  const resources: Record<string, unknown> = { Fn: fn };
  if (opts.layer) {
    resources['Lyr'] = {
      Type: 'AWS::Lambda::LayerVersion',
      Properties: {},
      Metadata: { 'aws:asset:path': assetPath },
    };
  }

  const stack = {
    stackName: 'Stk',
    displayName: 'Stk',
    artifactId: 'Stk',
    assetManifestPath: join(manifestDir, 'Stk.assets.json'),
    // `omitBound` reproduces a hand-built StackInfo carrying no `assetOutdir`,
    // which must fall back to the manifest directory — never wider.
    ...(opts.omitBound ? {} : { assetOutdir: outdir }),
    dependencyNames: [],
    template: { Resources: resources },
  } as unknown as StackInfo;

  return { outdir, manifestDir, outer, stack };
}

/** The two sites, called through each one's own public entry point. */
const SITES = [
  {
    name: 'cdkd local invoke (lambda-resolver)',
    call: (a: Assembly): string =>
      (resolveLambdaTarget('Stk:Fn', [a.stack]) as { codePath: string }).codePath,
  },
  {
    name: 'cdkd local start-api',
    call: (a: Assembly): string =>
      (resolveLambdaByLogicalId('Fn', [a.stack]) as { codePath: string }).codePath,
  },
] as const;

for (const site of SITES) {
  describe(`aws:asset:path containment — ${site.name}`, () => {
    it('REFUSES an absolute value, with the absolute-path wording', () => {
      const a = assembly('/placeholder');
      (
        (a.stack.template.Resources!['Fn']!.Metadata as Record<string, string>)
      )['aws:asset:path'] = join(a.outer, 'throwaway-victim');

      expect(() => site.call(a)).toThrow(/an absolute path/);
      expect(() => site.call(a)).toThrow(/Refusing to mount it/);
      // The two refusals must stay tellable apart: the absolute one must NOT
      // borrow the containment sentence.
      expect(() => site.call(a)).not.toThrow(/outside '/);
    });

    it('REFUSES an escaping relative value, with the containment wording', () => {
      const a = assembly('../throwaway-victim');

      expect(() => site.call(a)).toThrow(/outside '/);
      expect(() => site.call(a)).toThrow(/hand-modified or generated by a non-CDK toolchain/);
      // ...and must NOT claim the value was absolute.
      expect(() => site.call(a)).not.toThrow(/an absolute path/);
    });

    it('REFUSES one that stays inside lexically but leads out through a symlink', () => {
      const a = assembly('link/throwaway-victim');
      symlinkSync(a.outer, join(a.manifestDir, 'link'), 'dir');

      expect(() => site.call(a)).toThrow(/leads through a symbolic link to/);
    });

    it('still ACCEPTS an ordinary sibling asset directory', () => {
      const a = assembly('asset.abc123');

      expect(site.call(a)).toBe(join(a.outdir, 'asset.abc123'));
    });

    it('still ACCEPTS one that normalises back inside', () => {
      const a = assembly('nested/../asset.abc123');

      expect(site.call(a)).toBe(join(a.outdir, 'asset.abc123'));
    });

    // ---- the WIRING pair -------------------------------------------------
    // Both cases live BELOW a Stage manifest, the only shape in which the
    // bound and the resolution base differ. A top-level case cannot see the
    // bound at all.

    it("WIRING: ACCEPTS a Stage's `../asset.<hash>`, bounded by the app outdir", () => {
      const a = assembly('../asset.abc123', { stage: true });

      // Reds if the call site stops passing `stack.assetOutdir`: the bound
      // collapses to `cdk.out/assembly-MyStage/` and every Stage asset is
      // refused as hand-modified (go-to-k/cdkd#3493's B1).
      expect(site.call(a)).toBe(join(a.outdir, 'asset.abc123'));
    });

    it('WIRING: REFUSES `../../throwaway-victim` from that same Stage manifest', () => {
      const a = assembly('../../throwaway-victim', { stage: true });

      // Reds if the bound is widened past the app outdir — the failure mode a
      // refusal-only suite reads as success.
      expect(() => site.call(a)).toThrow(/outside '/);
    });

    it('WIRING: a StackInfo with no assetOutdir falls back to the manifest directory', () => {
      // Never WIDER than the base. Under a Stage manifest that costs the
      // legitimate `../asset.<hash>`, which is the documented fail-OPEN-free
      // trade: a missing bound narrows, it does not open.
      const a = assembly('../asset.abc123', { stage: true, omitBound: true });

      expect(() => site.call(a)).toThrow(/outside '/);
    });
  });
}

describe('aws:asset:path containment — cdkd local invoke layer assets', () => {
  // `resolveLambdaLayers` resolves a same-stack `AWS::Lambda::LayerVersion`
  // through the SAME helper, and its result bind-mounts at `/opt`.
  const layerPath = (a: Assembly): string =>
    (resolveLambdaTarget('Stk:Fn', [a.stack]) as { layers: { assetPath: string }[] })
      .layers[0]!.assetPath;

  it('REFUSES an absolute layer asset path', () => {
    const a = assembly('/placeholder', { layer: true });
    (
      (a.stack.template.Resources!['Lyr']!.Metadata as Record<string, string>)
    )['aws:asset:path'] = join(a.outer, 'throwaway-victim');

    expect(() => layerPath(a)).toThrow(/an absolute path/);
  });

  it('REFUSES an escaping layer asset path', () => {
    const a = assembly('../throwaway-victim', { layer: true });

    expect(() => layerPath(a)).toThrow(/outside '/);
  });

  it("ACCEPTS a Stage's `../asset.<hash>` layer, bounded by the app outdir", () => {
    const a = assembly('../asset.abc123', { layer: true, stage: true });

    expect(layerPath(a)).toBe(join(a.outdir, 'asset.abc123'));
  });
});
