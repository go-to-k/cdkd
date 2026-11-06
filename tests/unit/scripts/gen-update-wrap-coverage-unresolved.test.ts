import { describe, it, expect } from 'vite-plus/test';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  buildReport,
  classifySource,
  findGaps,
  UPDATE_WRAP_ALLOW_LIST,
} from '../../../scripts/gen-update-wrap-coverage.ts';
import { companionFiles } from '../../../scripts/provider-companion-files.ts';

// #5882: a split provider's `fn.call(this, ...)` delegate that the critic
// cannot resolve must fail CLOSED (`unresolved-callee`, blocking `--check`),
// never fall through to a confident `no-aws`.

const PROVIDERS_DIR = resolve(process.cwd(), 'src/provisioning/providers');

const delegatingClass = `class SplitProvider {
  async update(logicalId, physicalId, resourceType, props) {
    return update.call(this, logicalId, physicalId, resourceType, props);
  }
}`;

const wrappingCompanion = `export async function update(this: SplitProvider, logicalId, physicalId, resourceType, props) {
  try {
    await this.client.send(new UpdateThingCommand({}));
    return { physicalId, wasReplaced: false };
  } catch (error) {
    if (error instanceof ProvisioningError) throw error;
    throw new ProvisioningError('Failed to update', resourceType, logicalId, physicalId, error);
  }
}`;

const blocking = (src: string, companions: readonly string[]): string[] =>
  findGaps(buildReport(classifySource(src, 'split-provider.ts', new Map(), companions))).map(
    (c) => c.className
  );

describe('gen-update-wrap-coverage: unresolved delegates fail closed (#5882)', () => {
  it('resolves the delegate when its companion is read (negative control)', () => {
    const [c] = classifySource(delegatingClass, 'split-provider.ts', new Map(), [wrappingCompanion]);
    expect(c?.bucket).toBe('wrapped');
    expect(c?.unresolvedCallees).toEqual([]);
    expect(blocking(delegatingClass, [wrappingCompanion])).toEqual([]);
  });

  it('blocks when the companion file holding the delegate was not read', () => {
    const [c] = classifySource(delegatingClass, 'split-provider.ts', new Map(), []);
    expect(c?.bucket).toBe('unresolved-callee');
    expect(c?.unresolvedCallees).toEqual(['update']);
    expect(blocking(delegatingClass, [])).toEqual(['SplitProvider']);
  });

  it('blocks when the delegate signature is not a recognised this: function', () => {
    const noThisParam = wrappingCompanion.replace('this: SplitProvider, ', '');
    const [c] = classifySource(delegatingClass, 'split-provider.ts', new Map(), [noThisParam]);
    expect(c?.bucket).toBe('unresolved-callee');
    expect(c?.unresolvedCallees).toEqual(['update']);
  });

  it('blocks on an unresolved fn.call(this, ...) reached inside a companion body', () => {
    const companion = `export async function update(this: SplitProvider, logicalId, physicalId) {
      await applyTags.call(this, physicalId);
      return { physicalId, wasReplaced: false };
    }`;
    const [c] = classifySource(delegatingClass, 'split-provider.ts', new Map(), [companion]);
    expect(c?.bucket).toBe('unresolved-callee');
    expect(c?.unresolvedCallees).toEqual(['applyTags']);
  });

  it('outranks an allow-list entry, so a lost edge still blocks', () => {
    const gapClass = `class SplitProvider {
      async update(logicalId, physicalId) {
        await this.client.send(new UpdateThingCommand({}));
        await applyTags.call(this, physicalId);
        return { physicalId, wasReplaced: false };
      }
    }`;
    const allow = new Map([['SplitProvider#update', { rationale: 'test entry' }]]);
    const classes = classifySource(gapClass, 'split-provider.ts', allow, []);
    expect(classes[0]?.bucket).toBe('unresolved-callee');
    expect(findGaps(buildReport(classes))).toHaveLength(1);
  });

  // The real split providers: drop each companion FILE in turn (and then the
  // whole directory) and require that every class either keeps its verdict or
  // lands in the CI-blocking set. Before #5882 the drop silently turned
  // `wrapped` providers into non-blocking `no-aws`.
  describe('real split providers, a companion file hidden', () => {
    const split = readdirSync(PROVIDERS_DIR)
      .filter((f) => f.endsWith('-provider.ts'))
      .map((f) => ({ file: f, path: resolve(PROVIDERS_DIR, f) }))
      .map((p) => ({ ...p, companions: companionFiles(p.path) }))
      .filter((p) => p.companions.length > 0);

    const classify = (p: (typeof split)[number], keep: readonly string[]) =>
      classifySource(
        readFileSync(p.path, 'utf8'),
        p.file,
        UPDATE_WRAP_ALLOW_LIST,
        keep.map((c) => readFileSync(c, 'utf8'))
      );

    it('reads a realistic number of split providers', () => {
      // A literal floor, not derived from the tree: 8 when written.
      expect(split.length).toBeGreaterThanOrEqual(8);
    });

    it('never turns a hidden companion into a non-blocking verdict change', () => {
      const silentFlips: string[] = [];
      let blockedDrops = 0;
      for (const p of split) {
        const full = new Map(classify(p, p.companions).map((c) => [c.className, c.bucket]));
        const drops = [...p.companions.map((c) => [c]), p.companions];
        for (const dropped of drops) {
          const keep = p.companions.filter((c) => !dropped.includes(c));
          const report = buildReport(classify(p, keep));
          const gaps = new Set(findGaps(report).map((c) => c.className));
          for (const c of report.classes) {
            if (gaps.has(c.className)) {
              if (full.get(c.className) !== c.bucket) blockedDrops++;
            } else if (full.get(c.className) !== c.bucket) {
              silentFlips.push(`${c.className}: ${full.get(c.className)} -> ${c.bucket}`);
            }
          }
        }
      }
      expect(silentFlips).toEqual([]);
      // Discrimination floor: hiding companions must actually reach the guard
      // (a literal, so a walk that stopped following delegates cannot pass by
      // never resolving anything in the first place).
      expect(blockedDrops).toBeGreaterThanOrEqual(8);
    });
  });
});
