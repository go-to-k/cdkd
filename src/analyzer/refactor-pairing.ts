/**
 * `cdkd refactor` pairing (go-to-k/cdkd#5201): which DELETE row of a stack's
 * diff (a record the template no longer declares) is the same resource as
 * which CREATE row (a template resource state does not hold yet).
 *
 * This module only PROPOSES pairs. The command confirms every proposal by
 * diffing the stack with the pairs applied, and keeps a pair only when the new
 * logical id then shows no change -- the same comparator `cdkd deploy` uses,
 * so a refactor never keeps a pair the next deploy would update. The
 * proposal is therefore allowed to be loose, never to guess: two candidates
 * that look the same are reported AMBIGUOUS and left to the user.
 */

/** Types `cdkd refactor` never pairs. */
const UNPAIRABLE_TYPES: ReadonlySet<string> = new Set([
  // Not a resource cdkd provisions.
  'AWS::CDK::Metadata',
  // A nested-stack child's state key embeds its parent row's logical id
  // (`{parent}~{logicalId}`), so renaming the row would orphan the child.
  'AWS::CloudFormation::Stack',
]);

/** Whether `cdkd refactor` can pair a resource of this type. */
export function isPairableType(resourceType: string): boolean {
  return !UNPAIRABLE_TYPES.has(resourceType);
}

/** A template resource state does not hold (a CREATE row). */
export interface RefactorCreateSide {
  logicalId: string;
  resourceType: string;
  /** The row's desired properties, resolved as far as the diff could. */
  properties: Record<string, unknown>;
}

/** A state record the template no longer declares (a DELETE row). */
export interface RefactorDeleteSide {
  logicalId: string;
  resourceType: string;
  /** The record's `properties`: the resolved template values cdkd sent. */
  properties: Record<string, unknown>;
}

/** A proposed rename of one record. */
export interface ProposedRename {
  from: string;
  to: string;
  resourceType: string;
  /** `override`: named by the user's mapping file; `detected`: found here. */
  source: 'detected' | 'override';
}

/** A group of look-alike records and template resources no rule can split. */
export interface AmbiguousGroup {
  resourceType: string;
  from: string[];
  to: string[];
}

/** A user-named pair this module refuses, with the reason. */
export interface RefusedOverride {
  from: string;
  to: string;
  reason: string;
}

export interface PairingProposal {
  renames: ProposedRename[];
  ambiguous: AmbiguousGroup[];
  refusedOverrides: RefusedOverride[];
}

/**
 * Propose renames for one stack.
 *
 * 1. Each user-named pair (`overrides`) is taken as named once it is shown to
 *    be a DELETE row and a CREATE row of one pairable type; otherwise it is
 *    refused with the reason.
 * 2. Of the rest, a type with exactly one DELETE row and one CREATE row pairs
 *    them.
 * 3. Otherwise a CREATE row pairs with a DELETE row of its type whose
 *    properties are {@link looselyEqual} when each is the other's ONLY such
 *    candidate. Rows with more than one candidate form an ambiguous group.
 */
export function proposeRenames(
  creates: readonly RefactorCreateSide[],
  deletes: readonly RefactorDeleteSide[],
  overrides: ReadonlyArray<{ from: string; to: string }> = []
): PairingProposal {
  const createById = new Map(creates.map((c) => [c.logicalId, c]));
  const deleteById = new Map(deletes.map((d) => [d.logicalId, d]));
  const renames: ProposedRename[] = [];
  const refusedOverrides: RefusedOverride[] = [];
  const takenFrom = new Set<string>();
  const takenTo = new Set<string>();

  for (const { from, to } of overrides) {
    const d = deleteById.get(from);
    const c = createById.get(to);
    let reason: string | undefined;
    if (d === undefined) {
      reason = `${from} is not a resource this stack's state holds and its template no longer declares`;
    } else if (c === undefined) {
      reason = `${to} is not a resource this stack's template declares and its state does not hold`;
    } else if (d.resourceType !== c.resourceType) {
      reason = `the types differ (${d.resourceType} and ${c.resourceType})`;
    } else if (!isPairableType(d.resourceType)) {
      reason = `cdkd refactor cannot rename a ${d.resourceType} resource`;
    } else if (takenFrom.has(from) || takenTo.has(to)) {
      reason = 'the mapping names one of these logical IDs more than once';
    }
    if (reason !== undefined) {
      refusedOverrides.push({ from, to, reason });
      continue;
    }
    takenFrom.add(from);
    takenTo.add(to);
    renames.push({ from, to, resourceType: d!.resourceType, source: 'override' });
  }

  const ambiguous: AmbiguousGroup[] = [];
  const types = new Set(creates.map((c) => c.resourceType));
  for (const resourceType of [...types].sort()) {
    if (!isPairableType(resourceType)) continue;
    const typeCreates = creates.filter(
      (c) => c.resourceType === resourceType && !takenTo.has(c.logicalId)
    );
    const typeDeletes = deletes.filter(
      (d) => d.resourceType === resourceType && !takenFrom.has(d.logicalId)
    );
    if (typeCreates.length === 0 || typeDeletes.length === 0) continue;
    if (typeCreates.length === 1 && typeDeletes.length === 1) {
      renames.push({
        from: typeDeletes[0]!.logicalId,
        to: typeCreates[0]!.logicalId,
        resourceType,
        source: 'detected',
      });
      continue;
    }
    const candidatesOf = new Map<string, string[]>();
    const reverse = new Map<string, string[]>();
    for (const c of typeCreates) {
      const matches = typeDeletes
        .filter((d) => looselyEqual(c.properties, d.properties))
        .map((d) => d.logicalId);
      candidatesOf.set(c.logicalId, matches);
      for (const from of matches) reverse.set(from, [...(reverse.get(from) ?? []), c.logicalId]);
    }
    const groupFrom = new Set<string>();
    const groupTo = new Set<string>();
    for (const c of typeCreates) {
      const matches = candidatesOf.get(c.logicalId) ?? [];
      if (matches.length === 0) continue;
      if (matches.length === 1 && (reverse.get(matches[0]!) ?? []).length === 1) {
        renames.push({ from: matches[0]!, to: c.logicalId, resourceType, source: 'detected' });
        continue;
      }
      groupTo.add(c.logicalId);
      for (const from of matches) groupFrom.add(from);
    }
    if (groupTo.size > 0) {
      ambiguous.push({ resourceType, from: [...groupFrom].sort(), to: [...groupTo].sort() });
    }
  }

  return { renames, ambiguous, refusedOverrides };
}

/** An object with exactly one key naming an intrinsic function. */
function isIntrinsic(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 1 && (keys[0] === 'Ref' || keys[0]!.startsWith('Fn::'));
}

/**
 * Do a CREATE row's desired properties and a record's properties agree,
 * treating every intrinsic the diff left unresolved on the template side as
 * matching anything? Loose by design -- an unresolved `Ref` to a renamed
 * resource cannot be compared before the rename -- because the command's
 * confirming diff is the authority. Exported for its unit tests.
 */
export function looselyEqual(desired: unknown, recorded: unknown): boolean {
  if (isIntrinsic(desired)) return true;
  if (Array.isArray(desired)) {
    return (
      Array.isArray(recorded) &&
      desired.length === recorded.length &&
      desired.every((item, i) => looselyEqual(item, recorded[i]))
    );
  }
  if (desired !== null && typeof desired === 'object') {
    if (recorded === null || typeof recorded !== 'object' || Array.isArray(recorded)) return false;
    const want = Object.entries(desired).filter(([, v]) => v !== undefined);
    const have = Object.entries(recorded).filter(([, v]) => v !== undefined);
    if (want.length !== have.length) return false;
    const recordedMap = new Map(have);
    return want.every(
      ([key, value]) => recordedMap.has(key) && looselyEqual(value, recordedMap.get(key))
    );
  }
  if (desired === recorded) return true;
  // A scalar the template spells as a string and the record as a number (or
  // the reverse) -- CloudFormation coerces them alike.
  const scalar = (v: unknown): boolean =>
    typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
  return scalar(desired) && scalar(recorded) && String(desired) === String(recorded);
}

/** One entry of the AWS CDK CLI's refactor mapping file. */
export interface MappingEnvironment {
  account: string;
  region: string;
  resources: Record<string, string>;
}

/**
 * Parse `cdk refactor --override-file`'s shape:
 * `{"environments":[{"account","region","resources":{"Stack.OldId":"Stack.NewId"}}]}`.
 * Throws naming the first defect; never echoes a value it could not read.
 */
export function parseMappingFile(text: string): MappingEnvironment[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('The mapping file is not valid JSON');
  }
  const environments = (parsed as { environments?: unknown } | null)?.environments;
  if (parsed === null || typeof parsed !== 'object' || !Array.isArray(environments)) {
    throw new Error('The mapping file must be an object with an "environments" array');
  }
  return environments.map((env, i) => {
    if (env === null || typeof env !== 'object' || Array.isArray(env)) {
      throw new Error(`environments[${i}] must be an object`);
    }
    const { account, region, resources } = env as Record<string, unknown>;
    if (typeof account !== 'string' || typeof region !== 'string') {
      throw new Error(`environments[${i}] must have string "account" and "region" fields`);
    }
    if (resources === null || typeof resources !== 'object' || Array.isArray(resources)) {
      throw new Error(`environments[${i}].resources must be an object`);
    }
    const out: Record<string, string> = {};
    const destinations = new Set<string>();
    for (const [from, to] of Object.entries(resources)) {
      if (typeof to !== 'string') {
        throw new Error(`environments[${i}].resources values must be strings`);
      }
      splitLocation(from);
      splitLocation(to);
      if (destinations.has(to)) {
        throw new Error(`environments[${i}].resources names one destination more than once`);
      }
      destinations.add(to);
      Object.defineProperty(out, from, {
        value: to,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return { account, region, resources: out };
  });
}

/** A mapping entry split into its stack and logical-id halves. */
export interface MappingPair {
  fromStack: string;
  from: string;
  toStack: string;
  to: string;
}

/**
 * The pairs of one environment's mapping, `--revert` swapping each side.
 * A location is `Stack.LogicalId`; a logical id never contains a dot, so the
 * LAST dot splits it (a stack name may not contain one either, but splitting
 * at the last keeps a malformed one visible as a stack that matches nothing).
 */
export function mappingPairs(resources: Record<string, string>, revert: boolean): MappingPair[] {
  const pairs: MappingPair[] = [];
  for (const [rawFrom, rawTo] of Object.entries(resources)) {
    const [fromLoc, toLoc] = revert ? [rawTo, rawFrom] : [rawFrom, rawTo];
    const from = splitLocation(fromLoc);
    const to = splitLocation(toLoc);
    pairs.push({
      fromStack: from.stack,
      from: from.logicalId,
      toStack: to.stack,
      to: to.logicalId,
    });
  }
  return pairs;
}

function splitLocation(location: string): { stack: string; logicalId: string } {
  const dot = location.lastIndexOf('.');
  if (dot <= 0 || dot === location.length - 1) {
    throw new Error(
      'A mapping location must be "<StackName>.<LogicalId>"; one entry is not in that form'
    );
  }
  return { stack: location.slice(0, dot), logicalId: location.slice(dot + 1) };
}
