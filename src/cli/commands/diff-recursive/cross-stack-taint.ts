import type { CrossStackPreview } from '../../../analyzer/cross-stack-preview.js';
import type { CloudFormationTemplate } from '../../../types/resource.js';
import { NESTED_STACK_RESOURCE_TYPE } from '../retire-cfn-stack.js';
import { indexNestedChildTemplates, readNestedTemplate } from './nested-template.js';
import {
  crossStackTaintSeeds,
  readsTainted,
  taintedNamesOf,
  templateMixesDynamicReference,
} from './passed-secret-display.js';

/**
 * go-to-k/cdkd#7090: the passed-secret PROVENANCE of go-to-k/cdkd#7068 carried
 * across stacks. The outputs deriving from a secret-fed name are marked in
 * the run's {@link CrossStackPreview}: from the app's templates before any
 * diff (`markAppProducerTaint`), so a consumer whose producer is not diffed
 * here (not selected, failed, ordered after it) is covered, and again by each
 * producer's diff, which adds the values as print needles. A consumer seeds
 * its own tainted names from its reads of those outputs
 * (`crossStackTaintSeedsOf`), so every display mask of
 * `passed-secret-display.ts` applies to an imported value on every surface.
 * The previewed value itself is untouched: the comparison runs on it, and a
 * masked comparison value plans phantom changes (go-to-k/cdkd#7060).
 *
 * The preview is the one place a producer's provenance crosses into a
 * consumer's diff, and its writers are only these and `recordProducerPreview`.
 */

/**
 * The tainted names `template` seeds from its cross-stack reads of outputs
 * `preview` marks secret-fed. A read whose target is not a literal is tainted
 * whenever ANY output of the run is (fail closed).
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

/** As the recursive walk's own depth guard: past it, a subtree is not read. */
const MAX_NESTED_DEPTH = 32;

type Output = { Value?: unknown; Export?: { Name?: unknown } } | undefined;

/** The outputs of `template` whose `Value` or `Export` reads one of `tainted`. */
function taintedOutputsOf(
  template: CloudFormationTemplate,
  tainted: ReadonlySet<string>
): Array<[string, Output]> {
  if (tainted.size === 0) return [];
  return Object.entries(template.Outputs ?? {}).filter(([, raw]) => {
    const output = raw as Output;
    return readsTainted(output?.Value, tainted) || readsTainted(output?.Export, tainted);
  }) as Array<[string, Output]>;
}

/**
 * The secret-fed names of one node, with its nested subtree read from disk:
 * {@link taintedNamesOf} over `passed` and the node's tainted cross-stack
 * reads, plus each nested row whose child (at any depth) has a secret-fed
 * output, since `Fn::GetAtt Row.Outputs.*` reads it. `onChildOutput` sees
 * each such child output, for its export. A child template that cannot be
 * read adds nothing here: the walk that diffs it refuses it.
 */
export function subtreeTaintedNames(
  template: CloudFormationTemplate,
  nestedTemplates: Readonly<Record<string, string>> | undefined,
  passed: Iterable<string>,
  preview: CrossStackPreview | undefined,
  onChildOutput?: (childPath: string, outputName: string, output: Output) => void,
  depth = 0
): Set<string> {
  const seeds = [...passed, ...crossStackTaintSeedsOf(template, '', preview)];
  let tainted = taintedNamesOf(template, seeds);
  if (nestedTemplates === undefined || depth >= MAX_NESTED_DEPTH) return tainted;
  const rows = new Set<string>();
  for (const [logicalId, raw] of Object.entries(template.Resources ?? {})) {
    if (raw?.Type !== NESTED_STACK_RESOURCE_TYPE || !Object.hasOwn(nestedTemplates, logicalId)) {
      continue;
    }
    const childPath = nestedTemplates[logicalId]!;
    let child: CloudFormationTemplate;
    let grandchildren: Record<string, string>;
    try {
      child = readNestedTemplate(childPath);
      grandchildren = indexNestedChildTemplates(child, childPath);
    } catch {
      continue;
    }
    const parameters = (raw.Properties as { Parameters?: unknown } | undefined)?.Parameters;
    const childPassed: string[] = [];
    if (parameters !== null && typeof parameters === 'object' && !Array.isArray(parameters)) {
      for (const [key, value] of Object.entries(parameters as Record<string, unknown>)) {
        if (readsTainted(value, tainted) || templateMixesDynamicReference(value)) {
          childPassed.push(key);
        }
      }
    }
    const childTainted = subtreeTaintedNames(
      child,
      grandchildren,
      childPassed,
      preview,
      onChildOutput,
      depth + 1
    );
    const outputs = taintedOutputsOf(child, childTainted);
    for (const [name, output] of outputs) onChildOutput?.(childPath, name, output);
    if (outputs.length > 0) rows.add(logicalId);
  }
  if (rows.size > 0) tainted = taintedNamesOf(template, [...seeds, ...rows]);
  return tainted;
}

/** `null` for an export whose name is not a literal string (fail closed). */
function literalExportName(output: Output): string | null | undefined {
  if (output?.Export === undefined) return undefined;
  return typeof output.Export.Name === 'string' ? output.Export.Name : null;
}

/**
 * Mark, before any diff, every output of `stacks` (the app's synthesized
 * stacks, selected or not) and of their nested children whose template reads
 * a secret-fed name, to a fixed point across stacks (a re-export of a tainted
 * import). Provenance only: the values are the diffs' to add.
 */
export function markAppProducerTaint(
  preview: CrossStackPreview,
  stacks: ReadonlyArray<{
    stackName: string;
    template: CloudFormationTemplate;
    nestedTemplates?: Readonly<Record<string, string>> | undefined;
  }>
): void {
  let grew = true;
  while (grew) {
    grew = false;
    for (const { stackName, template, nestedTemplates } of stacks) {
      const mark = (owner: string, outputName: string, output: Output): void => {
        if (preview.markTainted(owner, outputName, literalExportName(output))) grew = true;
      };
      const tainted = subtreeTaintedNames(
        template,
        nestedTemplates,
        [],
        preview,
        // A child's outputs are read by its export name; its stack name is
        // the deploy's, so the template path stands for it.
        (childPath, outputName, output) => mark(childPath, outputName, output)
      );
      for (const [outputName, output] of taintedOutputsOf(template, tainted)) {
        mark(stackName, outputName, output);
      }
    }
  }
}
