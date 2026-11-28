import { getLogger } from '../../../utils/logger.js';
import {
  noEchoAttributeNamesOf,
  noEchoParameterNamesOf,
} from '../../../deployment/deploy-engine/noecho.js';
import {
  canonicalCoordinates,
  maskAtCoordinates,
  maskWholeValue,
  noEchoCoordinatesOf,
  readsNoEchoSource,
  type NoEchoPositionSources,
  valueAtCoordinate,
  type NoEchoCoordinate,
} from '../../../deployment/secret-redaction.js';
import { safeMsg } from '../../../utils/display-safe.js';
import type { CloudFormationTemplate } from '../../../types/resource.js';
import type { StackState } from '../../../types/state.js';
import type { ObservedBaselineRefusals } from './types.js';

/** One resolved record's input to {@link positionImportedNoEcho}. */
export interface NoEchoImportInput {
  readonly template: Record<string, unknown>;
  readonly resolved: Record<string, unknown>;
  /** The attributes as imported, before the value arm redacted them. */
  readonly attributes: Record<string, unknown> | undefined;
}

/**
 * The deploy's POSITIONAL arm over every resolved imported record
 * (go-to-k/cdkd#4043 Phase C, design section 4.5), so the record is
 * v11-correct from creation:
 *
 * - a leaf the template serves from a `NoEcho` parameter, or from a
 *   `Fn::GetAtt` of an attribute declared `NoEcho`, persists `***` whatever
 *   its type or length, named in `noEchoLeaves`;
 * - an attribute of the SAME NAME as a coordinate's property that equals the
 *   resolved value (an SSM parameter's `Value`) is masked and declared in
 *   `noEchoAttributeNames`; one equal to the physical id only names the
 *   resource and stays.
 *
 * Iterated to a fixed point: a declaration found on a producer positions its
 * consumers, whatever order the records were resolved in. A record whose bag
 * cannot be walked (too deep for the stack) takes no baseline, fail-closed.
 */
export function positionImportedNoEcho(
  stackState: StackState,
  inputs: ReadonlyMap<string, NoEchoImportInput>,
  template: CloudFormationTemplate,
  conditions: Record<string, boolean>,
  refusals: ObservedBaselineRefusals,
  logger: ReturnType<typeof getLogger>
): void {
  if (inputs.size === 0) return;
  const resources = stackState.resources ?? {};
  const declared = new Map<string, Set<string>>();
  for (const [id, record] of Object.entries(resources)) {
    const names = noEchoAttributeNamesOf(record);
    if (names !== undefined) declared.set(id, new Set(names));
  }
  const sources = {
    parameters: noEchoParametersOrAll(template),
    attributeIsNoEcho: (id: string, attribute: string): boolean =>
      declared.get(id)?.has(attribute) === true,
    ...(Object.keys(conditions).length > 0 && { conditions }),
  };
  const leavesOf = new Map<string, NoEchoCoordinate[]>();
  const failed = new Map<string, NoEchoCoordinate[]>();
  for (let round = 0; round <= inputs.size; round++) {
    let grew = false;
    for (const [id, input] of inputs) {
      let leaves = failed.get(id);
      if (leaves === undefined) {
        try {
          leaves = canonicalCoordinates(
            noEchoCoordinatesOf(input.template, input.resolved, sources)
          );
        } catch (err) {
          logger.debug(
            safeMsg`NoEcho position walk failed for imported ${id}: ${err instanceof Error ? err.name : typeof err} — masking each property that reads a NoEcho source whole and refusing its baseline, fail-closed.`
          );
          leaves = topLevelNoEchoProperties(input.template, sources);
          failed.set(id, leaves);
          refusals.add(id);
        }
      }
      leavesOf.set(id, leaves);
      const physicalId = Object.hasOwn(resources, id) ? resources[id]!.physicalId : undefined;
      for (const [name, attribute] of Object.entries(input.attributes ?? {})) {
        if (attribute === physicalId) continue;
        const echoes = leaves.some(
          (coordinate) =>
            coordinate[0] === name &&
            JSON.stringify(valueAtCoordinate(input.resolved, coordinate)) ===
              JSON.stringify(attribute)
        );
        if (!echoes) continue;
        let names = declared.get(id);
        if (names === undefined) {
          names = new Set();
          declared.set(id, names);
        }
        if (!names.has(name)) {
          names.add(name);
          grew = true;
        }
      }
    }
    if (!grew) break;
  }
  for (const [id, leaves] of leavesOf) {
    if (!Object.hasOwn(resources, id)) continue;
    const resource = resources[id]!;
    if (leaves.length > 0) {
      resource.properties = maskAtCoordinates(resource.properties, leaves);
      resource.noEchoLeaves = leaves.map((coordinate) => [...coordinate]);
    }
    const names = declared.get(id);
    const echoed = [...(names ?? [])].filter(
      (name) => resource.attributes !== undefined && Object.hasOwn(resource.attributes, name)
    );
    if (echoed.length > 0 && resource.attributes !== undefined) {
      const attributes = { ...resource.attributes };
      for (const name of echoed) attributes[name] = maskWholeValue(attributes[name]);
      resource.attributes = attributes;
      resource.noEchoAttributeNames = [
        ...new Set([...(noEchoAttributeNamesOf(resource) ?? []), ...echoed]),
      ].sort();
    }
  }
}

/**
 * The fail-closed positions of a record whose position walk threw: every
 * top-level property whose template value reads a `NoEcho` source, as a
 * whole. A property too deep to read is taken as reading one.
 */
function topLevelNoEchoProperties(
  template: Record<string, unknown>,
  sources: NoEchoPositionSources
): NoEchoCoordinate[] {
  const leaves: NoEchoCoordinate[] = [];
  for (const [key, value] of Object.entries(template)) {
    let reads: boolean;
    try {
      reads = readsNoEchoSource(value, sources);
    } catch {
      reads = true;
    }
    if (reads) leaves.push([key]);
  }
  return canonicalCoordinates(leaves);
}

/**
 * The template's `NoEcho` parameter names, or EVERY parameter when they
 * cannot be read: fail-closed, a parameter that might be `NoEcho` is
 * positioned as one. Defensive: no parsed template throws today; the guard
 * and its test keep the fallback fail-closed if that changes.
 */
function noEchoParametersOrAll(template: CloudFormationTemplate): Set<string> {
  try {
    return noEchoParameterNamesOf(template);
  } catch {
    try {
      return new Set(Object.keys((template.Parameters ?? {}) as object));
    } catch {
      return new Set();
    }
  }
}
