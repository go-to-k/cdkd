import type { RecordedSecretValues } from './pairs.js';
import { isPlainObject } from './rules.js';
import { mentionsMask } from './recorded-secrecy.js';
import { maskAtCoordinates, noEchoLeavesOf, valueAtCoordinate } from './noecho-leaves.js';
import { withOffTemplateEchoesMasked, type OffTemplateEchoRecord } from './off-template-echo.js';
import { templateGetAttNamesOf, withSecretAttributeKeysDropped } from './secret-attribute-keys.js';
import { withWholeNoEchoEchoesDeclared } from './whole-noecho-echo.js';

/** A record read from `state.json`, as the scrub rewrite holds it. */
type StoredRecord = OffTemplateEchoRecord & Parameters<typeof withSecretAttributeKeysDropped>[0];

/**
 * What {@link storedRecordFinisher} is handed beside the record: the record as
 * it was read, and the properties this scrub resolved for its logical id from
 * today's template (`undefined` when none).
 */
export interface StoredRecordInput {
  readonly logicalId: string;
  readonly state: StoredRecord;
  readonly resolved?: unknown;
  /** Today's template properties of the logical id, unresolved. */
  readonly templateProps?: unknown;
}

/**
 * `stored.resolved` reduced to what it teaches beyond the record as read: the
 * resolved bag with every `noEchoLeaves` position masked except those holding
 * a value the stored bag lacks there (the stored mask) and today's template
 * does not spell as a literal (a public value at a position the record still
 * marks). `undefined` when no position teaches, so a record the resolution
 * adds nothing to takes no extra pass.
 */
export function resolvedNoEchoTeacher(
  record: { noEchoLeaves?: unknown },
  stored: StoredRecordInput
): Record<string, unknown> | undefined {
  const resolved = stored.resolved;
  if (!isPlainObject(resolved)) return undefined;
  const coordinates = noEchoLeavesOf(record) ?? [];
  const silent = coordinates.filter((coordinate) => {
    const value = valueAtCoordinate(resolved, coordinate);
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      return true;
    }
    if (value === '' || (typeof value === 'string' && mentionsMask(value))) return true;
    return (
      valueAtCoordinate(stored.state.properties, coordinate) === value ||
      valueAtCoordinate(stored.templateProps, coordinate) === value
    );
  });
  if (silent.length === coordinates.length) return undefined;
  return maskAtCoordinates(resolved, silent);
}

/**
 * The last passes `cdkd scrub` runs over a record read from `state.json`
 * (the live record, an orphan's, a superseded one's), from `stored`, the record
 * as it was read:
 *
 * - a secret its readback echoed under a key the template lacks is masked and
 *   named (go-to-k/cdkd#7158 / #7152 / #7160);
 * - a custom resource attribute EQUAL to one of its `NoEcho` inputs, under a
 *   key no template `Fn::GetAtt` reads, is masked and named in
 *   `noEchoAttributeNames` (go-to-k/cdkd#7188, the deploy's #7183 rule);
 * - a custom resource attribute whose KEY holds one of `needles` is dropped
 *   (go-to-k/cdkd#7161), unless a template `Fn::GetAtt` spells it. An orphan
 *   or superseded record takes the needles its value scrub takes (this run's
 *   union): a key holding any secret this run knows is plaintext in state,
 *   and such a record is kept only to be deleted, so dropping an attribute
 *   whose key merely contains another resource's secret is the safe side.
 *
 * The values at the record's `noEchoLeaves` are read from the record as read
 * (plaintext only in a record older than v11) and from `stored.resolved`, what
 * this scrub resolved for the logical id: the persisted bag holds the mask
 * there, so a value too short for a needle (go-to-k/cdkd#7181) is known only
 * from the resolution. A deploy that leaves a resource UNCHANGED resolves
 * nothing for it, so an echo an older binary persisted holding a value this
 * scrub resolved is repaired here. One holding a value the input no longer
 * has (a rotated one) is not: nothing resolves it. Only the positions
 * {@link resolvedNoEchoTeacher} keeps are read from the resolution.
 */
export function storedRecordFinisher(
  template: object,
  publicTokens: ReadonlySet<string>,
  stackName: string
): <R extends StoredRecord>(
  record: R,
  needles: RecordedSecretValues | undefined,
  stored: StoredRecordInput
) => R {
  return (record, needles, stored) => {
    const { logicalId, state } = stored;
    const readback = state.observedProperties;
    let masked = withOffTemplateEchoesMasked(
      record,
      {
        ...(state.properties !== undefined && { properties: state.properties }),
        ...(readback !== undefined && { readback }),
      },
      publicTokens
    );
    const resolvedBag = resolvedNoEchoTeacher(masked, stored);
    if (resolvedBag !== undefined) {
      masked = withOffTemplateEchoesMasked(
        masked,
        { properties: resolvedBag, ...(readback !== undefined && { readback }) },
        publicTokens
      );
    }
    masked = withWholeNoEchoEchoesDeclared(
      masked,
      [state.properties, resolvedBag],
      template,
      logicalId,
      stackName,
      isPlainObject(state.attributes) ? state.attributes : undefined
    );
    return withSecretAttributeKeysDropped(
      masked,
      resolvedBag === undefined ? masked : { ...masked, properties: resolvedBag },
      needles,
      templateGetAttNamesOf(template, logicalId),
      publicTokens
    );
  };
}
