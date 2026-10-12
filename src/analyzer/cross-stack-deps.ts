import type { CloudFormationTemplate } from '../types/resource.js';

/**
 * Minimal shape this helper needs from a synthesized stack: its physical
 * CloudFormation stack name plus its synthesized template. `StackInfo`
 * (from `src/synthesis/assembly-reader.ts`) satisfies this structurally, so
 * deploy.ts / destroy.ts can pass their `StackInfo[]` directly.
 */
export interface CrossStackScanStack {
  stackName: string;
  template: CloudFormationTemplate;
}

/**
 * The two raw cross-stack reference kinds this helper recognizes. They have
 * DIFFERENT strengths and callers care about the distinction:
 * - `ImportValue` is a STRONG reference — the producer's `Export.Name` must
 *   exist at deploy time, so the producer is a genuine deploy dependency.
 * - `GetStackOutput` is a WEAK reference (cdkd-specific) — it reads the
 *   producer's output opportunistically from cdkd state. It does NOT make the
 *   producer a deploy dependency; deploying a consumer must not drag an
 *   unselected producer into the deploy.
 *
 * See `docs/cross-stack-references.md` (strong) and
 * `src/types/state.ts` `outputReads` (weak) for the full semantics.
 */
export type CrossStackRefKind = 'ImportValue' | 'GetStackOutput';

/**
 * Options for {@link inferCrossStackStackDeps}.
 */
export interface InferCrossStackStackDepsOptions {
  /**
   * Which reference kinds to treat as edges. Defaults to BOTH kinds (used for
   * ordering, where deploying producer-before-consumer is always beneficial
   * when both are already in the set). Pass `['ImportValue']` to get
   * STRONG-only edges — the right set for deploy-closure expansion, which must
   * not pull a weakly-referenced (`Fn::GetStackOutput`) producer into the
   * deploy.
   */
  kinds?: readonly CrossStackRefKind[];
  /**
   * Called with every `Fn::GetStackOutput` argument that carries a `RoleArn`
   * and that a deploy ALWAYS resolves, as the walk meets it (whatever `kinds`
   * says), so `deploy` can check the cross-account references before anything
   * is provisioned without a second walk of every template. Always resolved
   * means inside a resource's `Properties`, the resource has no `Condition`,
   * and no `Fn::If` encloses it: a reference elsewhere (an output, `Conditions`,
   * a conditional branch) may never be resolved, so it is left to the
   * resolver. A reference without a `RoleArn` never calls it.
   */
  onRoleArnReference?: (consumerStackName: string, args: Record<string, unknown>) => void;
}

/**
 * Infer cross-stack ordering edges that CDK's manifest dependency graph
 * (`stack.dependencyNames`, surfaced from `addDependency`) does NOT capture.
 *
 * Two stacks can be linked by a RAW cross-stack reference —
 * `cdk.Fn.importValue('<exportName>')` (→ `Fn::ImportValue`) or
 * `Fn::GetStackOutput` — WITHOUT an explicit `addDependency`. CDK only emits a
 * manifest dependency when the reference goes through its own
 * `exportValue` / strong-reference machinery; a hand-written
 * `Fn.importValue` of a literal export name produces no manifest edge. Under
 * concurrent `--all` deploys that lets the consumer race ahead of the
 * producer and fail (`export not found` / `stack not found`); on `--all`
 * destroy it lets the producer be deleted while a consumer still imports it.
 *
 * This helper closes that gap by scanning the synthesized templates directly
 * (NOT the runtime S3 export index, which is empty on a fresh multi-stack
 * deploy). It returns, per consumer stackName, the set of OTHER stackNames in
 * the SAME input set that it depends on (consumer → producer edges).
 *
 * Rules (mirroring deploy.ts's existing `if (stackMap.has(depName))` guard):
 * - Edges are only added between stacks BOTH present in the input set. A
 *   producer outside the set = no edge — its export resolves at runtime from
 *   already-deployed state, which is correct.
 * - `Fn::ImportValue` with a literal-string export name matches against the
 *   `Export.Name` of every OTHER stack's outputs. An import whose export name
 *   no stack in the set produces (external / pre-existing export) is ignored.
 * - `Fn::GetStackOutput`'s `StackName` argument names the producer stack
 *   DIRECTLY (the intrinsic arg is an object `{ StackName, OutputName,
 *   Region?, RoleArn? }` — see
 *   `src/deployment/intrinsic-resolver/stack-output.ts`). If that stack is in the
 *   set, add the edge.
 * - Non-literal `Fn::ImportValue` / `Fn::GetStackOutput` args (intrinsic
 *   nesting, etc.) are skipped without crashing — they cannot be statically
 *   resolved to a producer stack name here.
 *
 * @param stacks the stacks being deployed / destroyed together (the `--all`
 *   set, or the auto-include-dependency-expanded target set).
 * @param opts see {@link InferCrossStackStackDepsOptions}. `opts.kinds`
 *   restricts which reference kinds count as edges (defaults to both). Pass
 *   `['ImportValue']` for STRONG-only edges (deploy-closure expansion).
 * @returns Map<consumerStackName, Set<producerStackName>>. Consumers with no
 *   inferred cross-stack producer get an empty set entry.
 */
export function inferCrossStackStackDeps(
  stacks: readonly CrossStackScanStack[],
  opts?: InferCrossStackStackDepsOptions
): Map<string, Set<string>> {
  const kinds = opts?.kinds ?? (['ImportValue', 'GetStackOutput'] as const);
  const wantImportValue = kinds.includes('ImportValue');
  const wantGetStackOutput = kinds.includes('GetStackOutput');
  // exportName -> producer stackName. Built from every stack's
  // `Outputs[*].Export.Name` literal string.
  const exportOwner = new Map<string, string>();
  for (const stack of stacks) {
    const outputs = stack.template.Outputs;
    if (!outputs) continue;
    for (const output of Object.values(outputs)) {
      const name = output?.Export?.Name;
      if (typeof name === 'string' && name !== '') {
        // First writer wins; a duplicate export name across stacks is an
        // AWS-side error anyway, so we don't try to be clever here.
        if (!exportOwner.has(name)) {
          exportOwner.set(name, stack.stackName);
        }
      }
    }
  }

  const stackNames = new Set(stacks.map((s) => s.stackName));
  const result = new Map<string, Set<string>>();

  for (const stack of stacks) {
    const producers = new Set<string>();

    // Collect raw cross-stack references by walking the whole template.
    collectTemplateCrossStackRefs(stack.template, (kind, value, unconditional) => {
      let producer: string | undefined;
      if (kind === 'ImportValue') {
        if (!wantImportValue) return;
        // Fn::ImportValue arg must be a literal export name to be statically
        // resolvable; nested intrinsics are skipped.
        if (typeof value === 'string') {
          producer = exportOwner.get(value);
        }
      } else {
        if (
          opts?.onRoleArnReference &&
          unconditional &&
          value &&
          typeof value === 'object' &&
          !Array.isArray(value) &&
          Object.hasOwn(value, 'RoleArn')
        ) {
          opts.onRoleArnReference(stack.stackName, value as Record<string, unknown>);
        }
        if (!wantGetStackOutput) return;
        // Fn::GetStackOutput arg is an object whose StackName names the
        // producer stack directly.
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          const sn = (value as Record<string, unknown>)['StackName'];
          if (typeof sn === 'string') {
            producer = sn;
          }
        }
      }
      // Only add edges between two distinct stacks BOTH in the input set.
      if (producer && producer !== stack.stackName && stackNames.has(producer)) {
        producers.add(producer);
      }
    });

    result.set(stack.stackName, producers);
  }

  return result;
}

type OnCrossStackRef = (
  kind: 'ImportValue' | 'GetStackOutput',
  value: unknown,
  unconditional: boolean
) => void;

/**
 * Walk a whole template, marking a reference `unconditional` when a deploy
 * always resolves it: in a `Condition`-free resource's `Properties`, outside
 * any `Fn::If`. Every node is still visited exactly once.
 */
function collectTemplateCrossStackRefs(template: unknown, onRef: OnCrossStackRef): void {
  if (!template || typeof template !== 'object' || Array.isArray(template)) {
    collectCrossStackRefs(template, onRef, false);
    return;
  }
  for (const [section, body] of Object.entries(template as Record<string, unknown>)) {
    if (section !== 'Resources' || !body || typeof body !== 'object' || Array.isArray(body)) {
      collectCrossStackRefs(body, onRef, false);
      continue;
    }
    for (const resource of Object.values(body as Record<string, unknown>)) {
      if (!resource || typeof resource !== 'object' || Array.isArray(resource)) {
        collectCrossStackRefs(resource, onRef, false);
        continue;
      }
      const record = resource as Record<string, unknown>;
      const always = !Object.hasOwn(record, 'Condition');
      for (const [key, value] of Object.entries(record)) {
        collectCrossStackRefs(value, onRef, always && key === 'Properties');
      }
    }
  }
}

/**
 * Recursively walk a template node, invoking `onRef` for every
 * `Fn::ImportValue` / `Fn::GetStackOutput` intrinsic encountered. The
 * callback receives the discriminator and the raw (unresolved) argument.
 */
function collectCrossStackRefs(
  node: unknown,
  onRef: OnCrossStackRef,
  unconditional: boolean
): void {
  if (!node || typeof node !== 'object') return;

  if (Array.isArray(node)) {
    for (const item of node) {
      collectCrossStackRefs(item, onRef, unconditional);
    }
    return;
  }

  const obj = node as Record<string, unknown>;

  if ('Fn::ImportValue' in obj) {
    onRef('ImportValue', obj['Fn::ImportValue'], unconditional);
    // The arg itself may be a nested intrinsic; keep walking it too.
  }
  if ('Fn::GetStackOutput' in obj) {
    onRef('GetStackOutput', obj['Fn::GetStackOutput'], unconditional);
  }

  // Everything under an `Fn::If` is a branch a deploy may never resolve.
  const below = unconditional && !('Fn::If' in obj);
  for (const value of Object.values(obj)) {
    collectCrossStackRefs(value, onRef, below);
  }
}
