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
  /**
   * go-to-k/cdkd#7090: PROVENANCE, beside the values and never in them. The
   * exports and outputs whose template reads a secret-fed name
   * (`passed-secret-display.ts`), changed or not, so a consumer diffed later
   * MASKS what it prints from them while comparing on the real value (a
   * masked comparison value plans phantom changes, go-to-k/cdkd#7060).
   */
  private readonly taintedExports = new Set<string>();
  private readonly taintedOutputs = new Set<string>();
  private readonly taintedTexts = new Set<string>();
  /** A tainted output exports under a name this diff could not resolve: every export is. */
  private everyExportTainted = false;

  /** Is export `name` in `region` derived from a secret, by provenance? */
  exportTainted(region: string, name: string): boolean {
    return this.everyExportTainted || this.taintedExports.has(key(region, name));
  }

  /** Is `stackName`'s output `outputName` in `region` derived from a secret? */
  stackOutputTainted(region: string, stackName: string, outputName: string): boolean {
    return this.taintedOutputs.has(key(region, stackName, outputName));
  }

  /** Does this run hold any tainted export or output? */
  anyTainted(): boolean {
    return this.taintedExports.size > 0 || this.taintedOutputs.size > 0;
  }

  /**
   * The string values (desired and stored) of every tainted export and
   * output: mask-only print needles for a consumer's diff, whose lines can
   * embed an imported value outside any template leaf.
   */
  taintedValues(): ReadonlySet<string> {
    return this.taintedTexts;
  }

  /**
   * Mark `stackName`'s output `outputName` (and its export) tainted; `values`
   * become needles. `exportName` is `null` for an export whose name did not
   * resolve, which taints every export (fail closed).
   */
  markTainted(
    region: string,
    stackName: string,
    outputName: string,
    exportName: string | null | undefined,
    values: readonly unknown[]
  ): void {
    this.taintedOutputs.add(key(region, stackName, outputName));
    if (exportName === null) this.everyExportTainted = true;
    else if (exportName !== undefined) this.taintedExports.add(key(region, exportName));
    for (const value of values) {
      if (isScalar(value) && value !== '' && value !== SECRET_MASK) {
        this.taintedTexts.add(String(value));
      }
    }
  }

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
  /**
   * True when `value` reads an export or output this run's preview answers
   * unknown. An output that failed to resolve is unknown only then; any other
   * failure leaves it out, as before.
   */
  readsUnknownPreview?: (value: unknown) => boolean;
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
    } else if (input.readsUnknownPreview?.(value) === true) {
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

/** What {@link markProducerTaint} reads from one stack's diff. */
export interface ProducerTaintInput {
  stackName: string;
  template: CloudFormationTemplate;
  desiredOutputs: Readonly<Record<string, unknown>>;
  storedOutputs: Readonly<Record<string, unknown>> | undefined;
  /**
   * go-to-k/cdkd#7090: does this template value read a secret-fed name of the
   * stack (by provenance)? Each output whose `Value` or `Export` does, and its
   * export, is marked tainted whether or not the deploy changes it: a
   * consumer reads an unchanged one from state, holding the same value.
   */
  readsSecretFedName?: (value: unknown) => boolean;
}

/**
 * Mark the outputs and exports of one stack that derive from a secret, by
 * provenance, with their desired and stored values as needles. Any stack of
 * the run, a nested child included: provenance changes no previewed value.
 */
export async function markProducerTaint(
  preview: CrossStackPreview,
  region: string,
  resolve: (value: unknown) => Promise<unknown>,
  input: ProducerTaintInput,
  exportNames?: ReadonlyMap<string, string>
): Promise<void> {
  const reads = input.readsSecretFedName;
  if (reads === undefined) return;
  const exportNameOf = exportNames ?? (await resolvedExportNames(input.template, resolve));
  const stored = input.storedOutputs ?? {};
  for (const [outputName, definition] of Object.entries(input.template.Outputs ?? {})) {
    const output = definition as { Value?: unknown; Export?: unknown } | undefined;
    const secretName = reads(output?.Export);
    if (!reads(output?.Value) && !secretName) continue;
    // An export whose name did not resolve taints every export (fail closed).
    const exportName =
      exportNameOf.get(outputName) ?? (output?.Export === undefined ? undefined : null);
    preview.markTainted(region, input.stackName, outputName, exportName, [
      Object.hasOwn(input.desiredOutputs, outputName)
        ? input.desiredOutputs[outputName]
        : undefined,
      Object.hasOwn(stored, outputName) ? stored[outputName] : undefined,
      ...(typeof exportName === 'string'
        ? [Object.hasOwn(stored, exportName) ? stored[exportName] : undefined]
        : []),
      // An export name built from the secret is itself one.
      ...(secretName && typeof exportName === 'string' ? [exportName] : []),
    ]);
  }
}

/** Record a producer's {@link previewProducerValues} into `preview`, resolving its export names. */
export async function recordProducerPreview(
  preview: CrossStackPreview,
  region: string,
  resolve: (value: unknown) => Promise<unknown>,
  input: Omit<ProducerPreviewInput, 'exportNameOf'> & Pick<ProducerTaintInput, 'readsSecretFedName'>
): Promise<void> {
  const exportNameOf = await resolvedExportNames(input.template, resolve);
  await markProducerTaint(preview, region, resolve, input, exportNameOf);
  const readsUnknownPreview = (value: unknown): boolean =>
    crossStackReads(value).some((read) => {
      const found =
        read.kind === 'export'
          ? preview.exportValue(region, read.name)
          : preview.stackOutput(read.region ?? region, read.stackName, read.outputName);
      return found?.kind === 'unknown';
    });
  preview.record(
    region,
    input.stackName,
    previewProducerValues({ ...input, exportNameOf, readsUnknownPreview })
  );
}

type CrossStackRead =
  | { kind: 'export'; name: string }
  | { kind: 'output'; stackName: string; outputName: string; region?: string };

/** The literal `Fn::ImportValue` / same-account `Fn::GetStackOutput` reads inside `value`. */
export function crossStackReads(value: unknown): CrossStackRead[] {
  const reads: CrossStackRead[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node === null || typeof node !== 'object') return;
    for (const [key, arg] of Object.entries(node as Record<string, unknown>)) {
      if (key === 'Fn::ImportValue' && typeof arg === 'string') {
        reads.push({ kind: 'export', name: arg });
      } else if (key === 'Fn::GetStackOutput' && arg !== null && typeof arg === 'object') {
        const { StackName, OutputName, Region, RoleArn } = arg as Record<string, unknown>;
        if (
          typeof StackName === 'string' &&
          typeof OutputName === 'string' &&
          RoleArn === undefined
        ) {
          reads.push({
            kind: 'output',
            stackName: StackName,
            outputName: OutputName,
            ...(typeof Region === 'string' && { region: Region }),
          });
        }
      }
      walk(arg);
    }
  };
  walk(value);
  return reads;
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
