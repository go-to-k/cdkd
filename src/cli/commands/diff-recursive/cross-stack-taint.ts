import type { CrossStackPreview } from '../../../analyzer/cross-stack-preview.js';
import type { CloudFormationTemplate } from '../../../types/resource.js';
import { crossStackTaintSeeds, readsTainted } from './passed-secret-display.js';

/**
 * go-to-k/cdkd#7090: the passed-secret PROVENANCE of go-to-k/cdkd#7068 carried
 * across stacks. A producer's output reading a secret-fed name is marked in
 * the run's {@link CrossStackPreview} (`producerReadsSecretFedName`), and a
 * consumer diffed later seeds its own tainted names from the reads of those
 * outputs (`crossStackTaintSeedsOf`), so every display mask of
 * `passed-secret-display.ts` applies to an imported value on every surface.
 * The previewed value itself is untouched: the comparison runs on it, and a
 * masked comparison value plans phantom changes (go-to-k/cdkd#7060).
 *
 * The preview is the one place a producer's value crosses into a consumer's
 * diff (`import-value.ts` / `stack-output.ts` read it, else state), and
 * `recordProducerPreview` is its one writer, so this is the choke point.
 */

/**
 * The tainted names `template` (a node in region `region`) seeds from its
 * cross-stack reads of outputs `preview` marks secret-fed. A read whose target
 * is not a literal is tainted whenever ANY output of the run is (fail closed).
 */
export function crossStackTaintSeedsOf(
  template: CloudFormationTemplate,
  region: string,
  preview: CrossStackPreview | undefined
): Set<string> {
  if (preview === undefined || !preview.anyTainted()) return new Set();
  return crossStackTaintSeeds(template, (source) => {
    if (source === undefined) return true;
    return source.kind === 'export'
      ? preview.exportTainted(region, source.name)
      : preview.stackOutputTainted(source.region ?? region, source.stackName, source.outputName);
  });
}

/**
 * The producer's predicate for `recordProducerPreview`: does an output's
 * template value read one of `tainted` (this node's secret-fed names)?
 * `undefined` when nothing is tainted, so nothing is marked.
 */
export function producerReadsSecretFedName(
  tainted: ReadonlySet<string> | undefined
): ((value: unknown) => boolean) | undefined {
  if (tainted === undefined || tainted.size === 0) return undefined;
  return (value) => readsTainted(value, tainted);
}
