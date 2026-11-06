import { nullPrototypeRecord } from '../../../utils/own-keys.js';
import {
  canonicalCoordinates,
  carriesSecretMask,
  maskAtCoordinates,
  maskReadbackAtCoordinates,
  maskWholeValue,
  noEchoCoordinatesOf,
  noEchoLeavesOf,
  readsNoEchoSource,
  type NoEchoPositionSources,
  isSingleDynamicReferenceToken,
  recordNoEchoParameterFreshValue,
  valueAtCoordinate,
  type NoEchoCoordinate,
  physicalNameCopiesOf,
  type RecordedSecretValues,
} from '../../../deployment/secret-redaction.js';
import {
  noEchoAttributeNamesOf,
  noEchoExactEchoLeavesOf,
  noEchoParameterNamesOf,
  withAttemptedItemsMasked,
} from '../../../deployment/deploy-engine/noecho.js';
import type { StackState } from '../../../types/state.js';
import type { CloudFormationTemplate } from '../../../types/resource.js';

/** One record's `NoEcho` positions in scrub (go-to-k/cdkd#4043 Phase C). */
export interface ScrubNoEchoPlan {
  /** The coordinates the record is written with. */
  readonly leaves: NoEchoCoordinate[];
  /**
   * The plaintext the record still held at a coordinate (the migration
   * witness). `needle` is false where only a conditional row parameter
   * positions it: masked there, but no needle for the rest of the record.
   */
  readonly stored: ReadonlyArray<{ coordinate: NoEchoCoordinate; value: unknown; needle: boolean }>;
  /** Attribute names declared `NoEcho`: the record's own, plus echoes found now. */
  readonly attributeNames: readonly string[];
}

/**
 * Plan the `NoEcho` arms over every record today's template still declares
 * under the same type (go-to-k/cdkd#4043 Phase C, design section 4.6).
 *
 * - The coordinates are the record's own `noEchoLeaves` when it has the field
 *   (as a deploy keeps it for a record it does not write), else today's
 *   template positions that read a `NoEcho` parameter, over the STORED record.
 * - A plaintext the record still holds there is kept as the record's
 *   migration witness: {@link scrubMigrationNeedles} makes it a FRESH mask-only
 *   and containment needle of a second scrub of THAT record alone, never the
 *   stack-wide union: one record's value must not rewrite another's literal.
 * - An attribute of the same name as a coordinate's property that equals the
 *   stored value (an SSM parameter's `Value`) is declared `NoEcho`, and the
 *   positions are recomputed until no declaration is added, so a
 *   `Fn::GetAtt` consumer is positioned whatever the record order.
 *
 * `changesAny` lets a stack with no other recorded secret still be scrubbed.
 * `passedParameters` are the child parameters a parent's row fills from a
 * `NoEcho` source, for a nested child (the deploy's decision 8). Those in
 * `conditionalParameters` (filled through an `Fn::If`) are positioned, but a
 * stored plaintext only they position is no migration needle.
 */
export function planScrubNoEcho(
  state: StackState,
  template: CloudFormationTemplate,
  templateProps: ReadonlyMap<string, Record<string, unknown>>,
  conditions: Record<string, boolean>,
  passedParameters: readonly string[] = [],
  conditionalParameters: readonly string[] = []
): {
  byLogicalId: Map<string, ScrubNoEchoPlan>;
  outputKeys: string[];
  changesAny: boolean;
  parameters: ReadonlySet<string>;
  /** The positioning sources over the FINAL declared attribute names. */
  sources: NoEchoPositionSources;
  /**
   * The sources a NEEDLE comes from: no conditional parameter, and only the
   * attributes declared without one. A nested row reading none of them
   * outside an `Fn::If` is conditional for its child too.
   */
  needleSources: NoEchoPositionSources;
} {
  const byLogicalId = new Map<string, ScrubNoEchoPlan>();
  const parameters = new Set([...noEchoParameterNamesOf(template), ...passedParameters]);
  const resources = state.resources ?? {};
  const declared = new Map<string, Set<string>>();
  for (const [id, record] of Object.entries(resources)) {
    declared.set(id, new Set(noEchoAttributeNamesOf(record) ?? []));
  }
  const sources = {
    parameters,
    attributeIsNoEcho: (id: string, attribute: string): boolean =>
      declared.get(id)?.has(attribute) === true,
    ...(Object.keys(conditions).length > 0 && { conditions }),
  };
  const persisted = (value: unknown): boolean =>
    carriesSecretMask(value) || (typeof value === 'string' && isSingleDynamicReferenceToken(value));
  const templateResources = template.Resources ?? {};
  const eligible = Object.entries(resources).filter(
    ([logicalId, record]) =>
      templateProps.has(logicalId) &&
      Object.hasOwn(templateResources, logicalId) &&
      templateResources[logicalId]?.Type === record.resourceType
  );
  // The positions and declarations reached from `params`, to a fixed point.
  const positionFrom = (
    params: ReadonlySet<string>,
    names: Map<string, Set<string>>
  ): Map<string, NoEchoCoordinate[]> => {
    const from = {
      ...sources,
      parameters: params,
      attributeIsNoEcho: (id: string, attribute: string): boolean =>
        names.get(id)?.has(attribute) === true,
    };
    const leavesOf = new Map<string, NoEchoCoordinate[]>();
    for (let round = 0; round <= eligible.length; round++) {
      let grew = false;
      for (const [logicalId, record] of eligible) {
        const own = noEchoLeavesOf(record);
        const leaves = canonicalCoordinates(
          own ?? noEchoCoordinatesOf(templateProps.get(logicalId), record.properties, from)
        );
        leavesOf.set(logicalId, leaves);
        for (const [name, attribute] of Object.entries(record.attributes ?? {})) {
          if (attribute === record.physicalId || persisted(attribute)) continue;
          const echoes = leaves.some(
            (coordinate) =>
              coordinate[0] === name &&
              JSON.stringify(valueAtCoordinate(record.properties, coordinate)) ===
                JSON.stringify(attribute)
          );
          const recordNames = names.get(logicalId)!;
          if (echoes && !recordNames.has(name)) {
            recordNames.add(name);
            grew = true;
          }
        }
      }
      if (!grew) break;
    }
    return leavesOf;
  };
  const leavesOf = positionFrom(parameters, declared);
  // The coordinates whose stored plaintext is a migration NEEDLE: those a
  // source other than a conditional row parameter positions.
  const conditional = new Set(conditionalParameters);
  const needleParameters = new Set([...parameters].filter((name) => !conditional.has(name)));
  const needleDeclared =
    conditional.size === 0
      ? declared
      : new Map(
          Object.entries(resources).map(([id, record]) => [
            id,
            new Set(noEchoAttributeNamesOf(record) ?? []),
          ])
        );
  const needleLeavesOf =
    conditional.size === 0 ? leavesOf : positionFrom(needleParameters, needleDeclared);
  let changesAny = false;
  for (const [logicalId, record] of eligible) {
    const leaves = leavesOf.get(logicalId) ?? [];
    const attributeNames = [...(declared.get(logicalId) ?? [])].sort();
    if (leaves.length === 0 && attributeNames.length === 0) continue;
    const stored: Array<{ coordinate: NoEchoCoordinate; value: unknown; needle: boolean }> = [];
    const needleCoordinates = new Set(
      (needleLeavesOf.get(logicalId) ?? []).map((coordinate) => JSON.stringify(coordinate))
    );
    for (const coordinate of leaves) {
      const value = valueAtCoordinate(record.properties, coordinate);
      if (value === undefined || value === null || persisted(value)) continue;
      stored.push({ coordinate, value, needle: needleCoordinates.has(JSON.stringify(coordinate)) });
    }
    byLogicalId.set(logicalId, { leaves, stored, attributeNames });
    const unmaskedAttribute = attributeNames.some(
      (name) => Object.hasOwn(record.attributes ?? {}, name) && !persisted(record.attributes![name])
    );
    if (
      stored.length > 0 ||
      unmaskedAttribute ||
      (leaves.length > 0 && JSON.stringify(record.noEchoLeaves) !== JSON.stringify(leaves))
    ) {
      changesAny = true;
    }
  }
  // Declared outputs whose value reads a `NoEcho` parameter on EVERY branch
  // (no conditions: scrub cannot know the deploy's verdicts, so a value is
  // masked if any branch could read one), not yet persisted as the mask.
  const outputSources = { parameters, attributeIsNoEcho: sources.attributeIsNoEcho };
  const outputKeys: string[] = [];
  const stored = state.outputs as unknown;
  if (stored !== null && typeof stored === 'object' && !Array.isArray(stored)) {
    for (const [key, output] of Object.entries(template.Outputs ?? {})) {
      if (!Object.hasOwn(stored, key)) continue;
      const value = (stored as Record<string, unknown>)[key];
      if (value === undefined || value === null || persisted(value)) continue;
      if (!readsNoEchoSource((output as { Value?: unknown } | undefined)?.Value, outputSources)) {
        continue;
      }
      outputKeys.push(key);
    }
  }
  if (outputKeys.length > 0) changesAny = true;
  return {
    byLogicalId,
    outputKeys,
    changesAny,
    parameters,
    sources: outputSources,
    needleSources: {
      parameters: needleParameters,
      attributeIsNoEcho: (id: string, attribute: string): boolean =>
        needleDeclared.get(id)?.has(attribute) === true,
    },
  };
}

/**
 * The migration needles of one record's plan (go-to-k/cdkd#4043 Phase C): a
 * map of its own, each stored plaintext a FRESH mask-only and containment
 * needle as the deploy records a `NoEcho` value. `undefined` when the record
 * holds none.
 */
export function scrubMigrationNeedles(
  plan: ScrubNoEchoPlan | undefined,
  publicTokens: ReadonlySet<string>
): RecordedSecretValues | undefined {
  if (plan === undefined || plan.stored.length === 0) return undefined;
  const needles: RecordedSecretValues = new Map();
  for (const { value, needle } of plan.stored) {
    if (needle) recordNoEchoParameterFreshValue(value, needles, publicTokens);
  }
  return needles.size > 0 ? needles : undefined;
}

/**
 * Mask every declared output a `NoEcho` parameter serves (go-to-k/cdkd#4043
 * Phase C), as the deploy's `maskOutputsByPosition` does, and its OWN export
 * alias key (`aliasOf`, resolved by this run). A key that is neither a declared
 * output nor ANOTHER output's alias, holding the same stored value, is an alias
 * this run cannot name (an older binary's), and is masked by value. Another
 * declared output, or another output's alias, is never matched by value.
 */
export function maskScrubNoEchoOutputs(
  outputs: Record<string, unknown> | undefined,
  keys: readonly string[],
  declared: ReadonlySet<string>,
  aliasOf: ReadonlyMap<string, string>
): Record<string, unknown> | undefined {
  if (outputs === undefined || keys.length === 0) return outputs;
  const ownAliases = new Set(keys.flatMap((key) => (aliasOf.has(key) ? [aliasOf.get(key)!] : [])));
  const otherAliases = new Set(
    [...aliasOf].filter(([key]) => !keys.includes(key)).map(([, alias]) => alias)
  );
  const spelled = new Set(
    keys.filter((key) => Object.hasOwn(outputs, key)).map((key) => JSON.stringify(outputs[key]))
  );
  const masked: Record<string, unknown> = nullPrototypeRecord();
  for (const [key, value] of Object.entries(outputs)) {
    const byValue =
      !declared.has(key) && !otherAliases.has(key) && spelled.has(JSON.stringify(value));
    masked[key] =
      keys.includes(key) || ownAliases.has(key) || byValue ? maskWholeValue(value) : value;
  }
  return masked;
}

/**
 * Apply a record's {@link ScrubNoEchoPlan} to what the dynamic-reference
 * scrub produced: `properties` by index, `observedProperties` through each
 * list's identity field (the whole list where nothing pairs), and an
 * attribute of the SAME NAME as a coordinate's property that equals the
 * stored value (an SSM parameter's `Value`) masked and declared, whatever
 * its type or length; one equal to the physical id stays.
 */
export function applyScrubNoEcho(
  scrubbed: StackState['resources'][string],
  record: StackState['resources'][string],
  plan: ScrubNoEchoPlan | undefined
): StackState['resources'][string] {
  if (plan === undefined) return scrubbed;
  const { leaves, attributeNames } = plan;
  // `observedProperties` was redacted by `scrubResourceRecord` already; this
  // only adds the `NoEcho` positions on top.
  const next: StackState['resources'][string] = {
    ...scrubbed,
    properties: maskAtCoordinates(scrubbed.properties, leaves),
    ...(leaves.length > 0 && { noEchoLeaves: leaves.map((coordinate) => [...coordinate]) }),
    ...(scrubbed.observedProperties !== undefined && {
      observedProperties: maskReadbackAtCoordinates(
        scrubbed.observedProperties,
        record.properties,
        leaves
      ),
    }),
  };
  // An echo-fidelity entry describes a coordinate the record still marks,
  // or nothing (as the deploy's `applyNoEchoPersist` prunes it).
  const marked = new Set(leaves.map((coordinate) => JSON.stringify(coordinate)));
  const exact = noEchoExactEchoLeavesOf(scrubbed);
  if (exact !== undefined) {
    const kept = exact.filter((coordinate) => marked.has(JSON.stringify(coordinate)));
    if (kept.length > 0) next.noEchoExactEchoLeaves = kept;
    else delete next.noEchoExactEchoLeaves;
  }
  // Every attribute declared `NoEcho` (the record's own names, and an echo
  // the plan found) is masked whole, whatever its type or length.
  const attributes = next.attributes;
  if (attributes !== undefined && attributes !== null && attributeNames.length > 0) {
    const masked = { ...attributes };
    for (const name of attributeNames) {
      if (Object.hasOwn(masked, name)) masked[name] = maskWholeValue(masked[name]);
    }
    next.attributes = masked;
    next.noEchoAttributeNames = [...attributeNames];
  }
  // go-to-k/cdkd#5498: an attempted item name built from a value at a `NoEcho`
  // position (read off the record before this pass masked it) is masked too,
  // by value: the names sit at no template position.
  const needles = leaves.flatMap((coordinate) => {
    const value = valueAtCoordinate(record.properties, coordinate);
    return typeof value === 'string' && value !== '' ? [value] : [];
  });
  return withAttemptedItemsMasked(next, needles);
}

/** `value` with every `Fn::If` node replaced by `null`. */
function withoutFnIf(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutFnIf);
  if (value === null || typeof value !== 'object') return value;
  if (Object.hasOwn(value, 'Fn::If')) return null;
  const out: Record<string, unknown> = nullPrototypeRecord();
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    out[key] = withoutFnIf(inner);
  }
  return out;
}

/**
 * The child parameters a nested-stack row fills from a `NoEcho` source
 * (go-to-k/cdkd#4043 Phase C, the deploy's decision 8: `recordPassedNoEchoParameters`):
 * each `Parameters` entry whose template value reads a `NoEcho` parameter or a
 * declared `NoEcho` attribute, on either branch of an `Fn::If`. One is also
 * listed in `conditional` when no needle source (`needleSources`: no
 * conditional parameter, only attributes declared without one) is read
 * outside every `Fn::If`: scrub's default-bound verdicts may not reproduce the
 * deploy's branch, so the child positions it but takes no needle from it.
 */
export function noEchoFilledRowParameters(
  rowProperties: unknown,
  sources: NoEchoPositionSources,
  needleSources: NoEchoPositionSources
): { names: string[]; conditional: string[] } {
  const names: string[] = [];
  const conditional: string[] = [];
  if (rowProperties === null || typeof rowProperties !== 'object') return { names, conditional };
  const passed = (rowProperties as Record<string, unknown>)['Parameters'];
  if (passed === null || typeof passed !== 'object' || Array.isArray(passed)) {
    return { names, conditional };
  }
  // No condition verdicts: an `Fn::If` is read on both branches.
  const unconditioned: NoEchoPositionSources = {
    parameters: sources.parameters,
    ...(sources.attributeIsNoEcho !== undefined && {
      attributeIsNoEcho: sources.attributeIsNoEcho,
    }),
  };
  for (const [name, value] of Object.entries(passed as Record<string, unknown>)) {
    if (!readsNoEchoSource(value, unconditioned)) continue;
    names.push(name);
    // Conditional unless a needle source is read OUTSIDE every `Fn::If`.
    if (!readsNoEchoSource(withoutFnIf(value), needleSources)) conditional.push(name);
  }
  return { names, conditional };
}

/** The parent row's physical-id copies as a resolver context field (go-to-k/cdkd#4819). */
export function copiesOfParentRow(bag: RecordedSecretValues): {
  inheritedPhysicalNameCopies?: ReadonlySet<string>;
} {
  const copies = physicalNameCopiesOf.get(bag);
  return copies === undefined || copies.size === 0 ? {} : { inheritedPhysicalNameCopies: copies };
}
