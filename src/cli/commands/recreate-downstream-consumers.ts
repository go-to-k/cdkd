/**
 * Downstream-consumer enumeration for the `--recreate-via-cc-api` /
 * `--recreate-via-sdk-provider` warn block.
 *
 * A recreated resource gets a fresh physical id (most types — Lambda
 * Functions with a user-supplied `functionName` reuse the name, but
 * the AWS-side resource is new). Any **downstream cdkd stack** that
 * imports the producer's outputs via `Fn::ImportValue` (or reads via
 * `Fn::GetStackOutput`) will see a STALE value until that downstream
 * stack is re-deployed.
 *
 * The cdkd state bucket has the data needed to enumerate both kinds
 * of cross-stack consumers:
 *
 *   - `state.imports[]` — `(sourceStack, sourceRegion, exportName)`
 *     triples recorded by the resolver on every `Fn::ImportValue`
 *     resolution (schema v4, issue #650).
 *   - `state.outputReads[]` — `(sourceStack, sourceRegion, outputName)`
 *     triples recorded by the resolver on every same-account
 *     `Fn::GetStackOutput` resolution (schema v8, issue #668).
 *
 * The walk is per-stack: `ListStacks` returns a flat list of
 * `(stackName, region)` refs and we read each state's `imports[]` AND
 * `outputReads[]`. The cost is O(M) S3 reads where M = total stacks
 * in the bucket. The existing `scanActiveConsumers` in
 * `destroy-runner.ts` uses the same shape for the destroy-time
 * strong-reference refusal — this helper exists as its read-only
 * sibling for the recreate-warn use case.
 *
 * **Schema-degrade**: pre-v8 state has `outputReads` undefined and
 * the `GetStackOutput` walk reports no consumers (matches the v4
 * shipped behavior). The `Fn::ImportValue` walk still works against
 * pre-v8 state since `imports[]` predates v8.
 *
 * **Cross-account scope**: same-account reads only. Cross-account
 * (`RoleArn`-based) `Fn::GetStackOutput` reads do NOT push entries
 * into the producer's `outputReads` (the resolver intentionally
 * skips recording in that branch) — a future schema bump alongside
 * a `sourceAccountId` field would extend the enumeration there.
 */

import type { S3StateBackend } from '../../state/s3-state-backend.js';
import { getLogger } from '../../utils/logger.js';

/**
 * One downstream consumer of a recreate target's outputs.
 */
export interface DownstreamConsumer {
  /** The consumer stack name. */
  consumerStack: string;
  /** The consumer stack's region. */
  consumerRegion: string;
  /**
   * The producer-side reference name. `'ImportValue'` rows carry the
   * `Export.Name`; `'GetStackOutput'` rows carry the template
   * `Outputs.<Name>` (the two are usually but not always the same).
   */
  exportName: string;
  /**
   * Which intrinsic surfaced the cross-stack reference. Both are
   * detected today: `'ImportValue'` via `state.imports[]` (schema v4,
   * issue #650), `'GetStackOutput'` via `state.outputReads[]`
   * (schema v8, issue #668).
   */
  intrinsic: 'ImportValue' | 'GetStackOutput';
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
  const logger = getLogger().child('recreate-downstream');
  // Outer soft-fail: a transient `ListObjectsV2` IAM denial / 5xx on
  // the state bucket must NOT abort the deploy. The warn block is
  // informational; the generic caveat that follows already covers the
  // "we couldn't enumerate" case.
  let refs: Awaited<ReturnType<S3StateBackend['listStacks']>>;
  try {
    refs = await input.stateBackend.listStacks();
  } catch (err) {
    logger.debug(
      `findDownstreamConsumers: listStacks failed; ` +
        `falling back to empty enumeration. ${err instanceof Error ? err.message : String(err)}`
    );
    return [];
  }
  const results = await Promise.all(
    refs.map(async (ref) => {
      const region = ref.region ?? input.baseRegion;
      // Skip self (a stack importing its own output is invalid).
      if (ref.stackName === input.producerStack && region === input.producerRegion) {
        return null;
      }
      try {
        const got = await input.stateBackend.getState(ref.stackName, region);
        if (!got) return null;
        const out: DownstreamConsumer[] = [];
        const imports = got.state.imports;
        if (imports && imports.length > 0) {
          for (const entry of imports) {
            if (
              entry.sourceStack === input.producerStack &&
              entry.sourceRegion === input.producerRegion
            ) {
              out.push({
                consumerStack: ref.stackName,
                consumerRegion: region,
                exportName: entry.exportName,
                intrinsic: 'ImportValue',
              });
            }
          }
        }
        // Schema v8 (#668): walk `outputReads[]` alongside `imports[]`.
        // Pre-v8 state has the field undefined and degrades to
        // imports-only — matches the v4-shipped behavior.
        const outputReads = got.state.outputReads;
        if (outputReads && outputReads.length > 0) {
          for (const entry of outputReads) {
            if (
              entry.sourceStack === input.producerStack &&
              entry.sourceRegion === input.producerRegion
            ) {
              out.push({
                consumerStack: ref.stackName,
                consumerRegion: region,
                exportName: entry.outputName,
                intrinsic: 'GetStackOutput',
              });
            }
          }
        }
        return out.length > 0 ? out : null;
      } catch (err) {
        // An unreadable single state file shouldn't tank the entire
        // enumeration — log at debug and return null; the caller still
        // renders whatever consumers were found in other stacks.
        logger.debug(
          `findDownstreamConsumers: skip ${ref.stackName} (${region}); ` +
            `${err instanceof Error ? err.message : String(err)}`
        );
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
