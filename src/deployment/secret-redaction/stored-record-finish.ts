import type { RecordedSecretValues } from './pairs.js';
import { withOffTemplateEchoesMasked, type OffTemplateEchoRecord } from './off-template-echo.js';
import { templateGetAttNamesOf, withSecretAttributeKeysDropped } from './secret-attribute-keys.js';

/** A record read from `state.json`, as the scrub rewrite holds it. */
type StoredRecord = OffTemplateEchoRecord & Parameters<typeof withSecretAttributeKeysDropped>[0];

/**
 * The last two passes `cdkd scrub` runs over a record read from `state.json`
 * (the live record, an orphan's, a superseded one's), from `stored`, the record
 * as it was read:
 *
 * - a secret its readback echoed under a key the template lacks is masked and
 *   named (go-to-k/cdkd#7158 / #7152 / #7160);
 * - a custom resource attribute whose KEY holds one of `needles` is dropped
 *   (go-to-k/cdkd#7161), unless a template `Fn::GetAtt` spells it. An orphan
 *   or superseded record takes the needles its value scrub takes (this run's
 *   union): a key holding any secret this run knows is plaintext in state,
 *   and such a record is kept only to be deleted, so dropping an attribute
 *   whose key merely contains another resource's secret is the safe side. The record
 *   is its own `raw`: its `NoEcho` attribute values are the mask, so the
 *   needles alone teach. A deploy that leaves a custom resource UNCHANGED
 *   resolves nothing for it, so a key an older binary persisted holding a
 *   value this scrub resolved is repaired here. A key holding a value the
 *   secret no longer has (a rotated one) is not: nothing resolves it.
 */
export function storedRecordFinisher(
  template: object,
  publicTokens: ReadonlySet<string>
): <R extends StoredRecord>(
  record: R,
  needles: RecordedSecretValues | undefined,
  stored: { readonly logicalId: string; readonly state: StoredRecord }
) => R {
  return (record, needles, { logicalId, state }) => {
    const masked = withOffTemplateEchoesMasked(
      record,
      {
        ...(state.properties !== undefined && { properties: state.properties }),
        ...(state.observedProperties !== undefined && { readback: state.observedProperties }),
      },
      publicTokens
    );
    return withSecretAttributeKeysDropped(
      masked,
      masked,
      needles,
      templateGetAttNamesOf(template, logicalId),
      publicTokens
    );
  };
}
