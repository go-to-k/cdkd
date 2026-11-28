import {
  PREVIOUS_NOECHO_VALUE,
  canonicalJson,
  containsMask,
  maskWholeValue,
  noEchoCoordinatesOf,
  type NoEchoPositionSources,
} from './noecho-leaves.js';

/**
 * The OUTPUTS twin of {@link noEchoComparison} (go-to-k/cdkd#4043): `cdkd diff`
 * compares an output a `NoEcho` source serves as the persisted `***` on both
 * sides. `templateValues` maps each output name to its template `Value`; an
 * export alias key (not in `templateValues`) is masked when its value is the
 * value of an output masked here. A stored pre-v11 plaintext is the migration
 * witness: equal reads as unchanged, different shows
 * {@link PREVIOUS_NOECHO_VALUE}, never the old value.
 */
export function noEchoOutputsComparison(
  templateValues: Readonly<Record<string, unknown>>,
  sources: NoEchoPositionSources
): (
  current: Record<string, unknown> | undefined,
  desired: Record<string, unknown>
) => {
  current: Record<string, unknown> | undefined;
  desired: Record<string, unknown>;
  masked: string[];
} {
  return (current, desired) => {
    const coordinates = noEchoCoordinatesOf(templateValues, desired, sources);
    const maskedKeys = new Set(
      coordinates
        .map((coordinate) => coordinate[0])
        .filter((key): key is string => typeof key === 'string')
    );
    const maskedValues = new Set([...maskedKeys].map((key) => canonicalJson(desired[key])));
    for (const key of Object.keys(desired)) {
      if (!Object.hasOwn(templateValues, key) && maskedValues.has(canonicalJson(desired[key]))) {
        maskedKeys.add(key);
      }
    }
    if (maskedKeys.size === 0) return { current, desired, masked: [] };
    const maskedDesired: Record<string, unknown> = { ...desired };
    for (const key of maskedKeys) maskedDesired[key] = maskWholeValue(desired[key]);
    let normalized = current;
    if (current !== undefined && current !== null && typeof current === 'object') {
      for (const key of maskedKeys) {
        if (!Object.hasOwn(current, key)) continue;
        const stored = current[key];
        if (containsMask(stored)) continue;
        normalized = { ...(normalized ?? {}) };
        normalized[key] =
          canonicalJson(stored) === canonicalJson(desired[key])
            ? maskedDesired[key]
            : PREVIOUS_NOECHO_VALUE;
      }
    }
    return { current: normalized, desired: maskedDesired, masked: [...maskedKeys] };
  };
}
