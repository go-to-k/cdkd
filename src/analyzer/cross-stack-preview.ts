/**
 * What a `cdkd diff` run previews for a producer stack's exports and outputs,
 * so a consumer diffed later in the SAME run resolves its `Fn::ImportValue` /
 * same-account `Fn::GetStackOutput` against the value the producer's deploy
 * will publish rather than the one in state (go-to-k/cdkd#6796).
 *
 * `cdkd deploy` reaches the consumer only after its producer saved its new
 * outputs, so the consumer's diff there sees them; CloudFormation never does
 * (it refuses to change an export another stack imports), which is why this
 * has no AWS CDK CLI counterpart. Display only: nothing here is persisted or
 * sent, and a diff that does not select the producer records nothing.
 */
import type { CloudFormationTemplate } from '../types/resource.js';
import type { ResourceChange } from '../types/state.js';
import { canonicalizeRegion } from '../utils/aws-partition.js';
import { SECRET_MASK } from '../deployment/secret-redaction/pairs.js';
import { referencedLogicalIds } from './refactor-pairing.js';

/** A previewed value: known, or decided only by the producer's deploy. */
export type PreviewedValue =
  | { kind: 'known'; value: string | number | boolean; producerStack: string }
  | { kind: 'unknown'; producerStack: string };

/** One run's previewed producer values, filled stack by stack in dependency order. */
export class CrossStackPreview {
  private readonly exports = new Map<string, PreviewedValue>();
  private readonly outputs = new Map<string, PreviewedValue>();

  /** The previewed value of export `name` in `region`, if a producer in this run changes it. */
  exportValue(region: string, name: string): PreviewedValue | undefined {
    return this.exports.get(key(region, name));
  }

  /** The previewed value of `stackName`'s output `outputName` in `region`. */
  stackOutput(region: string, stackName: string, outputName: string): PreviewedValue | undefined {
    return this.outputs.get(key(region, stackName, outputName));
  }

  /** Record one producer's {@link previewProducerValues} result. */
  record(region: string, stackName: string, values: ProducerPreview): void {
    for (const [name, value] of values.exports) this.exports.set(key(region, name), value);
    for (const [name, value] of values.outputs) {
      this.outputs.set(key(region, stackName, name), value);
    }
  }
}

function key(region: string, ...parts: string[]): string {
  return JSON.stringify([canonicalizeRegion(region), ...parts]);
}

/** A producer's changed exports (by `Export.Name`) and outputs (by output name). */
export interface ProducerPreview {
  exports: Map<string, PreviewedValue>;
  outputs: Map<string, PreviewedValue>;
}

/** What {@link previewProducerValues} reads from one stack's diff. */
export interface ProducerPreviewInput {
  stackName: string;
  /** The condition-pruned template the diff ran on. */
  template: CloudFormationTemplate;
  /** The resource diff. */
  changes: ReadonlyMap<string, ResourceChange>;
  /** The desired outputs bag (`resolveTemplateOutputs`), output names and export aliases. */
  desiredOutputs: Readonly<Record<string, unknown>>;
  /** The stored outputs bag. */
  storedOutputs: Readonly<Record<string, unknown>> | undefined;
  /** Each output's resolved `Export.Name`, by output name. */
  exportNameOf: ReadonlyMap<string, string>;
  /** Evaluated conditions; an output whose condition is false is skipped. */
  conditions?: Readonly<Record<string, boolean>>;
  /**
   * True when `text` holds a value this diff must not print (a `NoEcho`
   * value, a resolved secret). Such a value is previewed as unknown, never
   * handed to another stack's diff, whose masking does not know it.
   */
  holdsSecret: (text: string) => boolean;
}

type Scalar = string | number | boolean;

function isScalar(value: unknown): value is Scalar {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

/**
 * The exports and outputs of one producer whose value the deploy changes.
 *
 * - An output referencing a resource the deploy creates or replaces, or a
 *   nested stack it updates (`Outputs.*`), is UNKNOWN: its `Ref` /
 *   `Fn::GetAtt` resolved here against the old record.
 * - So is one that failed to resolve because it reads another stack's output:
 *   that stack, diffed earlier in this run, previews it as unknown.
 * - Otherwise an output whose desired value differs from the stored one is
 *   KNOWN when it is a plain scalar holding no secret, mask or dynamic
 *   reference, and UNKNOWN when it is not. An `Export.Name` the stored bag
 *   lacks (a renamed export) is previewed the same way, as an export only.
 * - An unchanged output, or one that did not resolve for another reason, is
 *   left out, so its consumers read state as before.
 */
export function previewProducerValues(input: ProducerPreviewInput): ProducerPreview {
  const exports = new Map<string, PreviewedValue>();
  const outputs = new Map<string, PreviewedValue>();
  const renewed = new Set<string>();
  for (const change of input.changes.values()) {
    if (
      change.changeType === 'CREATE' ||
      (change.changeType === 'UPDATE' &&
        (change.resourceType === 'AWS::CloudFormation::Stack' ||
          (change.propertyChanges ?? []).some((p) => p.requiresReplacement)))
    ) {
      renewed.add(change.logicalId);
    }
  }
  const producerStack = input.stackName;
  const stored = input.storedOutputs ?? {};
  const verdict = (desired: unknown): PreviewedValue =>
    isScalar(desired) &&
    desired !== SECRET_MASK &&
    !String(desired).includes('{{resolve:') &&
    !input.holdsSecret(String(desired))
      ? { kind: 'known', value: desired, producerStack }
      : { kind: 'unknown', producerStack };
  for (const [outputName, definition] of Object.entries(input.template.Outputs ?? {})) {
    const condition = (definition as { Condition?: unknown } | undefined)?.Condition;
    if (typeof condition === 'string' && input.conditions?.[condition] === false) continue;
    const value = (definition as { Value?: unknown } | undefined)?.Value;
    const exportName = input.exportNameOf.get(outputName);
    const refs = referencedLogicalIds(
      { Resources: { output: { Type: 'Output', Properties: { value } } } },
      'output'
    );
    let previewed: PreviewedValue | undefined;
    if ([...refs].some((id) => renewed.has(id))) {
      previewed = { kind: 'unknown', producerStack };
    } else if (Object.hasOwn(input.desiredOutputs, outputName)) {
      const desired = input.desiredOutputs[outputName];
      // A `NoEcho`-served output is stored as the mask, so the producer's own
      // diff cannot tell it changed either (go-to-k/cdkd#4043); neither can this.
      if (stored[outputName] === SECRET_MASK || desired === undefined) continue;
      if (JSON.stringify(desired) !== JSON.stringify(stored[outputName])) {
        previewed = verdict(desired);
      } else if (exportName !== undefined && !Object.hasOwn(stored, exportName)) {
        exports.set(exportName, verdict(desired));
        continue;
      }
    } else if (/"Fn::(ImportValue|GetStackOutput)"/.test(JSON.stringify(value) ?? '')) {
      previewed = { kind: 'unknown', producerStack };
    }
    if (previewed === undefined) continue;
    outputs.set(outputName, previewed);
    if (exportName !== undefined) exports.set(exportName, previewed);
  }
  return { exports, outputs };
}

/**
 * Each output's resolved `Export.Name`, by output name. A name that does not
 * resolve to a string is left out: its consumers read state.
 */
export async function resolvedExportNames(
  template: CloudFormationTemplate,
  resolve: (value: unknown) => Promise<unknown>
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  for (const [outputName, definition] of Object.entries(template.Outputs ?? {})) {
    const exportName = (definition as { Export?: { Name?: unknown } } | undefined)?.Export?.Name;
    if (exportName === undefined) continue;
    try {
      const resolved = typeof exportName === 'string' ? exportName : await resolve(exportName);
      if (typeof resolved === 'string') names.set(outputName, resolved);
    } catch {
      // Unresolvable: previews nothing for this output's export.
    }
  }
  return names;
}

/** Record a producer's {@link previewProducerValues} into `preview`, resolving its export names. */
export async function recordProducerPreview(
  preview: CrossStackPreview,
  region: string,
  resolve: (value: unknown) => Promise<unknown>,
  input: Omit<ProducerPreviewInput, 'exportNameOf'>
): Promise<void> {
  const exportNameOf = await resolvedExportNames(input.template, resolve);
  preview.record(region, input.stackName, previewProducerValues({ ...input, exportNameOf }));
}

/**
 * `stacks` reordered so each comes after the stacks it depends on, otherwise
 * keeping their order (a dependency cycle keeps the rest as given).
 */
export function orderProducersFirst<T>(
  stacks: readonly T[],
  dependenciesOf: (stack: T) => Iterable<T>
): T[] {
  const inSet = new Set(stacks);
  const placed = new Set<T>();
  const ordered: T[] = [];
  let progressed = true;
  while (ordered.length < stacks.length && progressed) {
    progressed = false;
    for (const stack of stacks) {
      if (placed.has(stack)) continue;
      const ready = [...dependenciesOf(stack)].every(
        (dep) => dep === stack || !inSet.has(dep) || placed.has(dep)
      );
      if (!ready) continue;
      placed.add(stack);
      ordered.push(stack);
      progressed = true;
      break;
    }
  }
  for (const stack of stacks) if (!placed.has(stack)) ordered.push(stack);
  return ordered;
}
