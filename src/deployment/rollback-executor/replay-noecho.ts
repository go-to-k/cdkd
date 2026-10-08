import type { ResourceState } from '../../types/state.js';
import { CdkdError } from '../../utils/error-handler.js';
import { plainOrDescribed } from '../../utils/pasteable-command.js';
import {
  carriesSecretMask,
  isMarkedCoordinate,
  maskAtCoordinates,
  maskReadbackAtCoordinates,
  maskedLeafCoordinatesOf,
  maskWholeValue,
  noEchoLeavesOf,
  readbackPathFor,
  recordLogOnlyParameterValue,
  recordMaskOnlyValue,
  valueAtCoordinate,
  wholeStringLeavesOf,
  SECRET_MASK,
  type NoEchoCoordinate,
  type RecordedSecretValues,
} from '../secret-redaction.js';
import { canonicalJson } from '../secret-redaction/noecho-leaves.js';
import { markNonRetryable } from '../retryable-errors.js';
import { shownLogicalId } from './messages.js';
import type { RollbackExecutorContext } from './types.js';

/**
 * The rollback replay of a `NoEcho` leaf (go-to-k/cdkd#4043, Phase C, design
 * section 4.4).
 *
 * Since schema v11 a record holds a `NoEcho` parameter's value (or a declared
 * `NoEcho` attribute's, read through `Fn::GetAtt`) only as `***`, at the
 * coordinates its `noEchoLeaves` names. A revert replays that record to
 * `provider.update()`, and neither the journal nor an out-of-process `cdkd
 * rollback` holds the value. So the replay asks AWS: the leaf is left exactly
 * as AWS holds it, which is the one value the replay can send without guessing.
 *
 * - The resource is read ONCE, routed by the LIVE record (type and
 *   `provisionedBy`), and handed that record with every marked coordinate
 *   masked, so a provider echoing the bag it was handed for a field AWS does
 *   not return reports `***`, which is never substituted.
 * - A value that is absent, itself carries the mask, or sits under a list the
 *   readback reordered with no identity field to pair it, is NOT READABLE: the
 *   op refuses with `ROLLBACK_REDACTED_BASELINE` and sends nothing. So does a
 *   resource with no readback, and a read that fails or outlives its cap.
 * - Each substituted value becomes a mask-only needle of the op's bag (the
 *   persisted record and every printed line) AND a log-only one (no length
 *   floor, every printed spelling, a number included), so the record and the
 *   op's lines and events mask it.
 *
 * A consequence the design accepts: a `NoEcho` parameter change the reverted
 * op made is NOT reverted. The next deploy with the old value restores it.
 */

/** How long one readback may take before the op refuses as `read-failed`. */
export const NOECHO_REPLAY_READBACK_TIMEOUT_MS = 30_000;

/** What {@link substituteMarkedNoEchoLeaves} returns. */
export interface NoEchoReplaySubstitution {
  /** The desired bag with AWS's value at every marked coordinate it masked. */
  readonly desired: Record<string, unknown> | undefined;
  /**
   * Put the same value at the same coordinates of the OTHER side of the diff
   * (`previousProperties`), where that side holds the mask, so a patch
   * provider sees no change there and writes nothing to the leaf.
   */
  readonly onPreviousSide: (
    bag: Record<string, unknown> | undefined
  ) => Record<string, unknown> | undefined;
  /**
   * Marked coordinates left holding the mask because nothing sends them: a
   * nested stack row's revert replays the child's journal and reads none of
   * the row's `properties` (`NestedStackProvider`'s `replayingState` arm), so
   * its `Parameters.<P>` mask is inert and not refused.
   */
  readonly inert: readonly NoEchoCoordinate[];
  /** What was substituted where, for {@link maskRestoredNoEchoRecord}'s attribute arm. */
  readonly substituted: readonly SubstitutedLeaf[];
}

const NESTED_STACK_TYPE = 'AWS::CloudFormation::Stack';

type ReadFailure = 'not-readable' | 'read-failed';

/** One value the revert put at a marked coordinate. */
export interface SubstitutedLeaf {
  readonly coordinate: NoEchoCoordinate;
  readonly value: unknown;
}

function coordinatePath(coordinate: NoEchoCoordinate): string {
  let path = '';
  for (const segment of coordinate) {
    path += typeof segment === 'number' ? `[${segment}]` : path === '' ? segment : `.${segment}`;
  }
  return path;
}

function shownPaths(coordinates: readonly NoEchoCoordinate[]): string {
  return coordinates
    .map((coordinate) => plainOrDescribed(coordinatePath(coordinate), 'property path'))
    .join(', ');
}

/**
 * The refusal for a marked leaf the replay could not read back. The message
 * names `cdkd` commands, so each path is shown only when plain
 * (go-to-k/cdkd#4214). No value is ever in it: the path is a template
 * property name.
 */
function unreadableNoEchoLeafRefusal(
  logicalId: string,
  coordinates: readonly NoEchoCoordinate[],
  failure: ReadFailure
): CdkdError {
  const why =
    failure === 'read-failed'
      ? 'reading the resource back from AWS failed, so cdkd could not learn the value AWS holds ' +
        'there (re-running the rollback retries the read)'
      : 'cdkd cannot read the value AWS holds there (the property is write-only, AWS does not ' +
        'return it, or cdkd has no readback for this resource type)';
  return markNonRetryable(
    new CdkdError(
      `Cannot roll ${shownLogicalId(logicalId)} back: its recorded baseline holds a NoEcho value ` +
        `only as the redaction mask ('${SECRET_MASK}') at ${shownPaths(coordinates)}, and ${why}. ` +
        `cdkd sent nothing rather than write the mask to the live resource. Restore the property ` +
        `with 'cdkd deploy', which sends the NoEcho parameter's value again (a NoEcho attribute ` +
        `of a custom resource is sent again only when that custom resource updates in the same ` +
        `deploy).`,
      'ROLLBACK_REDACTED_BASELINE'
    )
  );
}

/**
 * The refusal for a marked leaf of a resource the replay must re-CREATE
 * (reverse-replacement): there is no live resource to read the value from,
 * and the replay holds no parameters. Thrown only when EVERY mask of `props`
 * sits at a marked coordinate; any other mask keeps the general refusal.
 */
export function refuseMarkedNoEchoRecreate(
  props: Record<string, unknown> | undefined,
  marked: readonly NoEchoCoordinate[] | undefined,
  logicalId: string
): void {
  if (props === undefined || marked === undefined || marked.length === 0) return;
  const masked = maskedLeafCoordinatesOf(props);
  if (masked.length === 0 || !masksOnlyAt(props, marked)) return;
  const shown = marked.filter((outer) =>
    masked.some((inner) => isMarkedCoordinate(inner, [outer]))
  );
  throw new CdkdError(
    `Cannot re-create ${shownLogicalId(logicalId)} while reversing its replacement: its recorded ` +
      `baseline holds a NoEcho value only as the redaction mask ('${SECRET_MASK}') at ` +
      `${shownPaths(shown)}, and there is no live resource to read that value back from, so cdkd ` +
      `sent nothing rather than create the resource with the mask. Restore the stack with ` +
      `'cdkd deploy', which sends the NoEcho parameter's value again.`,
    'ROLLBACK_REDACTED_BASELINE'
  );
}

/**
 * Does every mask `props` carries sit at (or inside) one of `marked`? A mask
 * is a whole `***` leaf, as {@link carriesSecretMask} reads it; one elsewhere
 * is another population's, which keeps its own refusal.
 */
export function masksOnlyAt(
  props: Record<string, unknown>,
  marked: readonly NoEchoCoordinate[]
): boolean {
  return maskedLeafCoordinatesOf(props).every((c) => isMarkedCoordinate(c, marked));
}

/**
 * A readback leaf that is no value: cdkd's mask, or a service's own
 * all-asterisk placeholder (`****`), anywhere inside it.
 */
function holdsPlaceholder(value: unknown): boolean {
  if (typeof value === 'string') return /^\*{3,}$/.test(value);
  if (Array.isArray(value)) return value.some(holdsPlaceholder);
  if (value !== null && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some(holdsPlaceholder);
  }
  return false;
}

function replaceAtCoordinate<T>(bag: T, coordinate: NoEchoCoordinate, value: unknown): T {
  if (coordinate.length === 0) return value as T;
  const clone = (node: unknown): unknown =>
    Array.isArray(node)
      ? [...(node as unknown[])]
      : node !== null && typeof node === 'object'
        ? { ...(node as Record<string, unknown>) }
        : node;
  const root = clone(bag) as Record<string | number, unknown>;
  let node = root;
  for (let i = 0; i < coordinate.length - 1; i++) {
    const segment = coordinate[i]!;
    const next = clone(node[segment]) as Record<string | number, unknown>;
    node[segment] = next;
    node = next;
  }
  const last = coordinate[coordinate.length - 1]!;
  // `defineProperty`, never `node[last] = ...`: a property literally named
  // `__proto__` is an own key of a parsed bag (go-to-k/cdkd#2776).
  Object.defineProperty(node, last, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
  return root as T;
}

async function readLive(
  live: ResourceState,
  baseline: ResourceState,
  marked: readonly NoEchoCoordinate[],
  logicalId: string,
  ctx: RollbackExecutorContext
): Promise<{ live: Record<string, unknown> } | { failure: ReadFailure }> {
  let readCurrentState;
  try {
    const { provider } = ctx.providerRegistry.getProviderFor({
      resourceType: live.resourceType,
      provisionedBy: live.provisionedBy,
    });
    readCurrentState = provider.readCurrentState?.bind(provider);
  } catch {
    return { failure: 'not-readable' };
  }
  if (readCurrentState === undefined) return { failure: 'not-readable' };
  // The live record masked at every marked coordinate: in process it may
  // still hold the failed deploy's resolved value, and an echoing provider
  // must not hand that back as what AWS holds.
  // Masked by index AND through the identity pairing the substitution reads
  // by, so a list the failed deploy reordered cannot hand back an unmasked
  // element (the whole list is masked where nothing pairs).
  const handed = maskReadbackAtCoordinates(
    maskAtCoordinates(live.properties ?? {}, [...marked, ...(noEchoLeavesOf(live) ?? [])]),
    baseline.properties,
    marked
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      Promise.resolve().then(() =>
        readCurrentState(live.physicalId, logicalId, live.resourceType, handed)
      ),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('readback timed out')),
          NOECHO_REPLAY_READBACK_TIMEOUT_MS
        );
      }),
    ]);
    if (result === undefined || result === null || typeof result !== 'object') {
      return { failure: 'not-readable' };
    }
    return { live: result };
  } catch {
    // The error is dropped, never printed: its message could echo the value.
    return { failure: 'read-failed' };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Substitute AWS's value at every coordinate of `desired` that `baseline`
 * marks and that holds the mask. See the module doc. Throws
 * `ROLLBACK_REDACTED_BASELINE` for a leaf it cannot read; returns `desired`
 * unchanged when no marked coordinate holds the mask.
 */
export async function substituteMarkedNoEchoLeaves(input: {
  desired: Record<string, unknown> | undefined;
  /** The record the replay restores TO: its `noEchoLeaves` and list pairing. */
  baseline: ResourceState;
  /** The record of the resource as it is now: routing, and the bag handed. */
  live: ResourceState;
  logicalId: string;
  ctx: RollbackExecutorContext;
  secrets: RecordedSecretValues;
  /** The `provisionedBy` the arm's `update()` routes on (the op's, as a rule). */
  routedVia: string | undefined;
}): Promise<NoEchoReplaySubstitution> {
  const { desired, baseline, live, logicalId, ctx, secrets, routedVia } = input;
  const identity: NoEchoReplaySubstitution = {
    desired,
    onPreviousSide: (bag) => bag,
    inert: [],
    substituted: [],
  };
  if (desired === undefined) return identity;
  const pending = (noEchoLeavesOf(baseline) ?? []).filter((coordinate) =>
    carriesSecretMask(valueAtCoordinate(desired, coordinate))
  );
  if (pending.length === 0) return identity;
  // Not on a Cloud Control route, which WOULD send the row's properties:
  // neither the record's nor the one the update is routed on.
  if (
    live.resourceType === NESTED_STACK_TYPE &&
    baseline.resourceType === NESTED_STACK_TYPE &&
    live.provisionedBy !== 'cc-api' &&
    routedVia !== 'cc-api'
  ) {
    return { ...identity, inert: pending };
  }
  const read = await readLive(live, baseline, pending, logicalId, ctx);
  if ('failure' in read) throw unreadableNoEchoLeafRefusal(logicalId, pending, read.failure);
  const values: Array<{ coordinate: NoEchoCoordinate; value: unknown }> = [];
  const unreadable: NoEchoCoordinate[] = [];
  for (const coordinate of pending) {
    const path = readbackPathFor(read.live, baseline.properties, coordinate);
    const value =
      path !== undefined && path.length === coordinate.length
        ? valueAtCoordinate(read.live, path)
        : undefined;
    // `null` is no value either: AWS returning nothing there.
    if (value === undefined || value === null || holdsPlaceholder(value)) {
      unreadable.push(coordinate);
      continue;
    }
    values.push({ coordinate, value });
  }
  if (unreadable.length > 0)
    throw unreadableNoEchoLeafRefusal(logicalId, unreadable, 'not-readable');
  let substituted: Record<string, unknown> = desired;
  for (const { coordinate, value } of values) {
    recordLogOnlyParameterValue(secrets, value);
    for (const leaf of wholeStringLeavesOf(value)) recordMaskOnlyValue(secrets, leaf);
    substituted = replaceAtCoordinate(substituted, coordinate, value);
  }
  return {
    inert: [],
    substituted: values,
    desired: substituted,
    onPreviousSide: (bag) => {
      if (bag === undefined) return bag;
      let out = bag;
      for (const { coordinate, value } of values) {
        if (carriesSecretMask(valueAtCoordinate(out, coordinate))) {
          out = replaceAtCoordinate(out, coordinate, value);
        }
      }
      return out;
    },
  };
}

function declaredNoEchoAttributeNames(record: ResourceState): string[] {
  const field = (record as { noEchoAttributeNames?: unknown }).noEchoAttributeNames;
  return Array.isArray(field)
    ? field.filter((name): name is string => typeof name === 'string')
    : [];
}

/**
 * The POSITIONAL arm over a record the replay restores (go-to-k/cdkd#4043,
 * Phase C): every coordinate `baseline` marks is `***` in `properties`, and
 * every attribute it declares `NoEcho` is `***` in `attributes`, whatever the
 * value's type or length. The value arm (`redactRollbackRecord`) cannot mask a
 * number or a value under `MIN_NEEDLE_LENGTH`, and a provider's
 * `effectiveProperties` / returned attributes can carry what AWS holds. The
 * record keeps `baseline`'s `noEchoLeaves`.
 */
export function maskRestoredNoEchoRecord(
  record: ResourceState,
  baseline: ResourceState,
  /**
   * What the revert substituted. An attribute of the SAME NAME as a
   * substituted coordinate's property that equals its value is masked too,
   * whatever its type or length (the deploy's echo rule); one equal to the
   * physical id stays, since that only names the resource. A string of needle
   * length under another name is the value arm's.
   */
  substituted: readonly SubstitutedLeaf[] = []
): ResourceState {
  const marked = noEchoLeavesOf(baseline) ?? [];
  const names = declaredNoEchoAttributeNames(baseline);
  if (marked.length === 0 && names.length === 0 && substituted.length === 0) return record;
  const echoes = (name: string, value: unknown): boolean =>
    value !== record.physicalId &&
    substituted.some(
      (leaf) => leaf.coordinate[0] === name && canonicalJson(leaf.value) === canonicalJson(value)
    );
  let attributes = record.attributes;
  if (attributes !== undefined && attributes !== null && typeof attributes === 'object') {
    for (const [name, value] of Object.entries(attributes)) {
      if (!names.includes(name) && !echoes(name, value)) continue;
      attributes = replaceAtCoordinate(attributes, [name], maskWholeValue(value));
    }
  }
  // By index; and, for a coordinate whose LIST differs from the baseline's
  // after that (a provider's `effectiveProperties` returned it in another
  // order or shape), through the identity pairing too, which masks that whole
  // list where nothing pairs. Decided per coordinate, so a difference
  // elsewhere in the bag never masks a list that kept its order.
  const byIndex = maskAtCoordinates(record.properties, marked);
  const reshaped = marked.filter((coordinate) => {
    const list = coordinate.findIndex((segment) => typeof segment === 'number');
    if (list < 0) return false;
    const path = coordinate.slice(0, list);
    return (
      canonicalJson(valueAtCoordinate(byIndex, path)) !==
      canonicalJson(valueAtCoordinate(baseline.properties, path))
    );
  });
  const properties =
    reshaped.length === 0
      ? byIndex
      : maskReadbackAtCoordinates(byIndex, baseline.properties, reshaped);
  return {
    ...record,
    properties,
    ...(attributes !== record.attributes && { attributes }),
    ...(baseline.noEchoLeaves !== undefined && { noEchoLeaves: baseline.noEchoLeaves }),
  };
}
