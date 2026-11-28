import { noEchoLeavesFor, noEchoPositionSources } from './noecho.js';
import { isSingleDynamicReferenceToken, valueAtCoordinate } from '../secret-redaction.js';
import { holdsMaskLeaf } from '../secret-redaction/recorded-secrecy.js';
import type { DeployEngine } from '../deploy-engine.js';
import type { StackState, SupersededResourceRecord } from '../../types/state.js';

/**
 * Whether a carried rollback-orphan or superseded record still holds a value
 * at a position its save masks as `NoEcho` (go-to-k/cdkd#7191): a pre-v11
 * record of a logical id today's template declares as its type, or one whose
 * own `noEchoLeaves` name the position. The no-change save is gated on a
 * fixed list of triggers, and nothing else in it moves for such a record, so
 * without this the plaintext rides every unchanged deploy.
 *
 * It asks `noEchoLeavesFor` with no resolved bag, exactly as the save's
 * `scrubDroppedRecord` does on this path (the no-change diff resolves no
 * record), so a record it flags is one the save masks: the next unchanged
 * deploy finds the mask there and saves nothing more. The caller hands the
 * containers in, read below its own guards.
 */
export function carriedRecordsHoldNoEchoPlaintext(
  engine: Pick<DeployEngine, 'noEchoRun' | 'noEchoDeps'>,
  resources: StackState['resources'],
  orphans: StackState['orphans'] | undefined,
  superseded: readonly SupersededResourceRecord[]
): boolean {
  const rows = [...(Array.isArray(orphans) ? orphans : []), ...superseded];
  if (rows.length === 0) return false;
  const sources = noEchoPositionSources(engine.noEchoRun, resources);
  if (sources === undefined) return false;
  const deps = engine.noEchoDeps();
  return rows.some((row) => {
    const record = row?.state;
    if (record === null || typeof record !== 'object') return false;
    const leaves = noEchoLeavesFor(
      engine.noEchoRun,
      deps,
      row.logicalId,
      record,
      undefined,
      sources
    );
    return (leaves ?? []).some((coordinate) => {
      const value = valueAtCoordinate(record.properties, coordinate);
      return (
        value !== undefined &&
        value !== null &&
        !holdsMaskLeaf(value) &&
        !(typeof value === 'string' && isSingleDynamicReferenceToken(value))
      );
    });
  });
}
