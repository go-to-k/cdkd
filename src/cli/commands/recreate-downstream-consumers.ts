/**
 * Downstream-consumer enumeration for the `--recreate-via-cc-api` warn
 * block (issue [#650]).
 *
 * A recreated resource gets a fresh physical id (most types — Lambda
 * Functions with a user-supplied `functionName` reuse the name, but
 * the AWS-side resource is new). Any **downstream cdkd stack** that
 * imports the producer's outputs via `Fn::ImportValue` (or reads via
 * `Fn::GetStackOutput`) will see a STALE value until that downstream
 * stack is re-deployed.
 *
 * The cdkd state bucket already has the data needed to enumerate
 * `Fn::ImportValue` consumers — every stack's `state.json` carries an
 * `imports[]` list of `(sourceStack, sourceRegion, exportName)`
 * triples written at deploy time by the intrinsic resolver (see
 * `src/deployment/intrinsic-function-resolver.ts` and the schema v4
 * note in `.claude/rules/state-schema.md`).
 *
 * **v1 scope (#650)**: `Fn::ImportValue` consumers ONLY. cdkd's
 * `Fn::GetStackOutput` is intentionally NOT tracked in `imports[]`
 * (the design treats it as a weak reference — see
 * `src/types/state.ts` `StateImportEntry`'s JSDoc). Detecting
 * `Fn::GetStackOutput` consumers would require a separate
 * `outputReads[]` field on `StackState` — a schema bump out of scope
 * for this PR. The warn block continues to surface the generic
 * "downstream consumers will need a re-deploy" caveat so users with
 * `Fn::GetStackOutput`-only consumers see the warning even though we
 * cannot name them.
 *
 * The walk is per-stack: `ListStacks` returns a flat list of
 * (stackName, region) refs and we read each state's `imports[]`. The
 * cost is O(M) S3 reads where M = total stacks in the bucket. The
 * existing `scanActiveConsumers` in `destroy-runner.ts` uses the same
 * shape for the destroy-time strong-reference refusal — this helper
 * exists as its read-only sibling for the recreate-warn use case.
 */

import type { S3StateBackend } from '../../state/s3-state-backend.js';

/**
 * One downstream consumer of a recreate target's outputs.
 */
export interface DownstreamConsumer {
  /** The consumer stack name. */
  consumerStack: string;
  /** The consumer stack's region. */
  consumerRegion: string;
  /** The export the consumer reads from the producer. */
  exportName: string;
  /**
   * Which intrinsic surfaced the cross-stack reference. v1 only
   * detects `'ImportValue'`; `'GetStackOutput'` is reserved for a
   * future schema bump that adds `outputReads[]` tracking.
   */
  intrinsic: 'ImportValue';
}

/**
 * Walk every stack in the cdkd state bucket and find consumers whose
 * `imports[]` reference the producer `(producerStack, producerRegion)`.
 *
 * Skips the producer itself (self-imports are invalid in CFn / cdkd).
 *
 * Soft-fails per consumer: an unreadable state file is logged at debug
 * and skipped — the warn block falls back to "we couldn't enumerate
 * downstream consumers" rather than blocking the deploy. The caller
 * always proceeds; this is informational only.
 */
export async function findDownstreamConsumers(input: {
  producerStack: string;
  producerRegion: string;
  stateBackend: S3StateBackend;
  /** Default-region fallback for legacy v1 state records that lack `region`. */
  baseRegion: string;
}): Promise<DownstreamConsumer[]> {
  const refs = await input.stateBackend.listStacks();
  const results = await Promise.all(
    refs.map(async (ref) => {
      const region = ref.region ?? input.baseRegion;
      // Skip self (a stack importing its own output is invalid).
      if (ref.stackName === input.producerStack && region === input.producerRegion) {
        return null;
      }
      try {
        const got = await input.stateBackend.getState(ref.stackName, region);
        const imports = got?.state.imports;
        if (!imports || imports.length === 0) return null;
        const matches = imports.filter(
          (entry) =>
            entry.sourceStack === input.producerStack && entry.sourceRegion === input.producerRegion
        );
        if (matches.length === 0) return null;
        return matches.map<DownstreamConsumer>((entry) => ({
          consumerStack: ref.stackName,
          consumerRegion: region,
          exportName: entry.exportName,
          intrinsic: 'ImportValue',
        }));
      } catch {
        // An unreadable single state file shouldn't tank the entire
        // enumeration — return null and let the caller render
        // whatever consumers were found in other stacks.
        return null;
      }
    })
  );
  return results.filter((r): r is DownstreamConsumer[] => r !== null).flat();
}

/**
 * Render the per-consumer subset of the warn block as a multi-line
 * string suitable for piping into the logger. Returns `null` when the
 * enumeration is empty (caller skips the subsection in that case).
 *
 * Shape:
 * ```
 *   Downstream consumers of <ProducerStack>'s outputs (will need re-deploy):
 *     - StackB (region) reads ExportName via Fn::ImportValue
 *     - StackC (region) reads OtherExport via Fn::ImportValue
 * ```
 */
export function renderDownstreamConsumers(
  producerStack: string,
  consumers: ReadonlyArray<DownstreamConsumer>
): string | null {
  if (consumers.length === 0) return null;
  const lines: string[] = [
    `  Downstream consumers of ${producerStack}'s outputs (will need re-deploy after this run):`,
  ];
  for (const c of consumers) {
    lines.push(
      `    - ${c.consumerStack} (${c.consumerRegion}) reads ${c.exportName} via Fn::${c.intrinsic}`
    );
  }
  return lines.join('\n');
}
