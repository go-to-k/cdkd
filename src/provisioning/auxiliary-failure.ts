/**
 * Declare a failure an AUXILIARY call raised inside a provider's `create()`
 * (issue [#3826](https://github.com/go-to-k/cdkd/issues/3826)).
 *
 * An auxiliary call acts on an object other than the resource's own name: a
 * rule of a security group, a tag, an attribute, an alias, a subscription,
 * a policy, a lifecycle configuration. When one of them fails with AWS's
 * "already exists", the provider's wrapper relays AWS's text and threads the
 * SDK error as `cause`, and `isNameCollisionErrorFrom` then credits it to the
 * resource: the top-level message relays the phrase, and an AWS-authored link
 * says it. That verdict is DESTRUCTIVE. `--replace` deletes the live old
 * resource first, and the rollback's reverse-replacement arm deletes the live
 * new one; the re-create then fails again on the same auxiliary object.
 *
 * The mark reuses the classifier's own ANCHOR rather than a second signal:
 * `isNameCollisionErrorFrom` returns `false` at the first link whose own
 * `logicalId` names another resource, before it reads anything else on that
 * link. An auxiliary object IS another resource, so the link carries a
 * logical id no template can spell (a CloudFormation logical id is
 * alphanumeric, and this one carries a `/`). The AWS error is not replaced or
 * reworded, so the message the user reads is unchanged, and the provider keeps
 * threading the caught value as `cause` (`scripts/check-provider-error-cause.ts`).
 *
 * WHICH link is marked: the first one, walking down from `error`, that has no
 * own string `logicalId`. A provider helper can wrap the SDK error in its own
 * `ProvisioningError` before the create's `catch` sees it; that wrapper carries
 * the OWNER's id and is left alone, and the SDK error beneath it is marked.
 * Marking stops there, so everything below the mark is unreachable to the
 * classifier.
 *
 * The property is non-enumerable, like `markNameCollision`'s symbol: it never
 * serializes, and `maskSecretsInError`'s clone copies own descriptors, so it
 * survives masking. A primitive throw, or a link that cannot take the property,
 * is left alone.
 *
 * A LEAF: no imports, so any provider can use it without an edge into
 * `src/deployment/**`.
 */

const AUXILIARY_LOGICAL_ID_SUFFIX = '/auxiliary';

/** Bounded like every other cause-chain walk in cdkd. */
const MAX_DEPTH = 5;

/**
 * The logical id an auxiliary failure is anchored to. Never equal to a
 * template logical id. A provider's mark names the owner's template logical
 * id, so a debugger reading the chain sees whose create raised it; a mark
 * `withRetry` adds carries the fixed owner `withRetry` instead, since its
 * label can hold a physical name (go-to-k/cdkd#4222).
 */
export function auxiliaryLogicalId(ownerLogicalId: string): string {
  return `${ownerLogicalId}${AUXILIARY_LOGICAL_ID_SUFFIX}`;
}

/**
 * The owner `withRetry` marks with (go-to-k/cdkd#4222): a fixed word, never the
 * label. A label can carry a physical name — `<table name> (<dimension>)`, a
 * policy name, and an all-alphanumeric physical name reads no differently from
 * a logical id — and the mark is the one `logicalId` `maskSecretsInError`
 * copies verbatim. Exported so a reader can tell that mark from a provider's
 * ({@link isAuxiliaryMarkOf}).
 */
export const RETRY_AUXILIARY_OWNER = 'withRetry';

/**
 * Whether `link`'s OWN `logicalId` is the mark `markAuxiliaryFailure(_, owner)`
 * defines — that link alone, no walk. Never throws: an unreadable link is not
 * the mark.
 */
export function isAuxiliaryMarkOf(link: unknown, ownerLogicalId: string): boolean {
  try {
    if ((typeof link !== 'object' && typeof link !== 'function') || link === null) return false;
    const own = Object.getOwnPropertyDescriptor(link, 'logicalId');
    return isAuxiliaryMark(own) && own?.value === auxiliaryLogicalId(ownerLogicalId);
  } catch {
    return false;
  }
}

/**
 * Whether an own `logicalId` descriptor is the mark {@link markAuxiliaryFailure}
 * defines. The suffix alone does not identify it: a physical id can end in a
 * `/auxiliary` path segment (an SSM parameter name, a log group, an IAM path),
 * and a `ProvisioningError` built with one in its logical-id slot would read as
 * marked (go-to-k/cdkd#4222). So the mark's descriptor shape is required too —
 * non-enumerable and read-only, where a `ProvisioningError`'s field is an
 * ordinary assignment. `maskSecretsInError`'s `isAuxiliaryAnchor` keys its
 * verbatim copy on the same shape.
 */
function isAuxiliaryMark(descriptor: PropertyDescriptor | undefined): boolean {
  return (
    descriptor !== undefined &&
    descriptor.enumerable === false &&
    descriptor.writable === false &&
    typeof descriptor.value === 'string' &&
    descriptor.value.endsWith(AUXILIARY_LOGICAL_ID_SUFFIX)
  );
}

/**
 * True when `error`'s chain carries an auxiliary mark: a link, within the
 * bounded walk {@link markAuxiliaryFailure} makes, whose own `logicalId` is an
 * {@link auxiliaryLogicalId} in the mark's descriptor shape
 * ({@link isAuxiliaryMark}). Reads own properties only, as the marker writes
 * them. A chain whose walk throws (a `cause` getter, a Proxy trap) reads as
 * unmarked: the caller is a retry loop's `catch`, where an out-throw would
 * replace the error it is handling.
 *
 * The retry wrapper's reader (issue
 * [#3972](https://github.com/go-to-k/cdkd/issues/3972)): an attempt that failed
 * auxiliary may have left the resource behind, so a REPLAYED create can
 * collide with it before the replay's own flag is set.
 */
export function isAuxiliaryFailure(error: unknown): boolean {
  try {
    let current: unknown = error;
    for (
      let depth = 0;
      depth < MAX_DEPTH && typeof current === 'object' && current !== null;
      depth++
    ) {
      if (isAuxiliaryMark(Object.getOwnPropertyDescriptor(current, 'logicalId'))) {
        return true;
      }
      current = (current as { cause?: unknown }).cause;
    }
  } catch {
    // Unreadable chain: unmarked, per the doc above.
  }
  return false;
}

const CREATED_BEFORE_FAILURE = Symbol.for('cdkd.createdBeforeFailure');

/**
 * Declare that `ownerLogicalId`'s create call had RETURNED — the resource
 * `physicalId` exists in AWS because THIS attempt made it — before `error`
 * was thrown (go-to-k/cdkd#1710). The deploy engine journals that id on the
 * failed CREATE so `cdkd rollback --revert-failed` can delete a resource no
 * state record holds.
 *
 * A POSITIVE proof, deliberately not inferred from
 * `ProvisioningError.physicalId`: providers attach the NAME they were going to
 * use to refusals and to their create call's own failure (an "already exists"
 * on another owner's resource), and deleting that would destroy a resource
 * this deploy never made. Mark only where the create call is known to have
 * returned. Stamped on `error` itself, non-enumerable and read-only like the
 * auxiliary mark; returns `error`. A primitive or non-extensible throw is left
 * unmarked, which loses only the recovery.
 */
export function markCreatedBeforeFailure<E>(
  error: E,
  ownerLogicalId: string,
  resourceType: string,
  physicalId: string
): E {
  try {
    if (typeof error !== 'object' || error === null || !Object.isExtensible(error)) return error;
    if (physicalId === '') return error;
    Object.defineProperty(error, CREATED_BEFORE_FAILURE, {
      value: Object.freeze({ logicalId: ownerLogicalId, resourceType, physicalId }),
      enumerable: false,
      writable: false,
      configurable: true,
    });
  } catch {
    // Unmarkable: left as it is.
  }
  return error;
}

/** The mark {@link markCreatedBeforeFailure} put on `link` itself, if any. */
type CreatedMark = { logicalId: string; resourceType: string; physicalId: string };

function createdMarkOn(link: object): CreatedMark | undefined {
  const value = (link as Record<symbol, unknown>)[CREATED_BEFORE_FAILURE];
  if (typeof value !== 'object' || value === null) return undefined;
  const { logicalId, resourceType, physicalId } = value as Record<string, unknown>;
  if (
    typeof logicalId !== 'string' ||
    typeof resourceType !== 'string' ||
    typeof physicalId !== 'string' ||
    physicalId === ''
  ) {
    return undefined;
  }
  return { logicalId, resourceType, physicalId };
}

/**
 * The physical id a {@link markCreatedBeforeFailure} mark for `logicalId` and
 * `resourceType` carries on `error`'s bounded cause chain, or `undefined`.
 *
 * Anchored on both sides: the mark must name `logicalId` AND `resourceType`
 * (a nested child may share its parent row's logical id), and the walk stops
 * at the first link naming ANOTHER logical id (a nested stack's child error
 * wrapped under its parent row) — an auxiliary mark of `logicalId` excepted,
 * since it marks the same create's own SDK error. A GRANDCHILD nested stack
 * can share both the logical id and the `AWS::CloudFormation::Stack` type with
 * the row above it, so a nested-stack create clears the marks its child
 * deploy's failure carries ({@link clearCreatedBeforeFailure}) before the
 * error reaches the parent row's reader. Never throws.
 */
export function createdBeforeFailure(
  error: unknown,
  logicalId: string,
  resourceType: string
): string | undefined {
  try {
    let current: unknown = error;
    for (
      let depth = 0;
      depth < MAX_DEPTH * 2 && typeof current === 'object' && current !== null;
      depth++
    ) {
      const mark = createdMarkOn(current);
      if (mark) {
        return mark.logicalId === logicalId && mark.resourceType === resourceType
          ? mark.physicalId
          : undefined;
      }
      const own = Object.getOwnPropertyDescriptor(current, 'logicalId');
      if (
        typeof own?.value === 'string' &&
        own.value !== logicalId &&
        !isAuxiliaryMarkOf(current, logicalId)
      ) {
        return undefined;
      }
      current = (current as { cause?: unknown }).cause;
    }
  } catch {
    // Unreadable chain: no proof.
  }
  return undefined;
}

/**
 * Remove every {@link markCreatedBeforeFailure} mark from `error`'s bounded
 * cause chain; returns `error`. For an error that crosses a nesting boundary:
 * a nested child deploy journals its own rows' marks in the CHILD's journal
 * before it rejects, and the same marks read again at the parent row could
 * name a grandchild's resource under the parent's logical id. Never throws.
 */
export function clearCreatedBeforeFailure<E>(error: E): E {
  try {
    let current: unknown = error;
    for (
      let depth = 0;
      depth < MAX_DEPTH * 2 && typeof current === 'object' && current !== null;
      depth++
    ) {
      if (Object.getOwnPropertyDescriptor(current, CREATED_BEFORE_FAILURE)?.configurable) {
        delete (current as Record<symbol, unknown>)[CREATED_BEFORE_FAILURE];
      }
      current = (current as { cause?: unknown }).cause;
    }
  } catch {
    // Unreadable chain: left as it is.
  }
  return error;
}

/** Whether `error`'s bounded cause chain carries any created-before-failure mark. */
export function hasCreatedBeforeFailure(error: unknown): boolean {
  try {
    let current: unknown = error;
    for (
      let depth = 0;
      depth < MAX_DEPTH * 2 && typeof current === 'object' && current !== null;
      depth++
    ) {
      if (createdMarkOn(current)) return true;
      current = (current as { cause?: unknown }).cause;
    }
  } catch {
    // Unreadable chain: no mark.
  }
  return false;
}

/**
 * Carry a {@link markCreatedBeforeFailure} mark from an EARLIER attempt's
 * error onto the error a retry loop finally throws, unless that one carries a
 * mark of its own. A replayed create collides with the resource the earlier
 * attempt made, and its own error proves nothing — without the carry the one
 * record of that resource is dropped with the earlier error. The mark is
 * copied as is, so the reader's logical-id anchor still applies. Never throws.
 */
export function carryCreatedBeforeFailure<E>(from: unknown, to: E): E {
  try {
    if (typeof to !== 'object' || to === null) return to;
    let current: unknown = from;
    let mark: CreatedMark | undefined;
    for (
      let depth = 0;
      depth < MAX_DEPTH * 2 && typeof current === 'object' && current !== null && !mark;
      depth++
    ) {
      mark = createdMarkOn(current);
      current = (current as { cause?: unknown }).cause;
    }
    if (!mark) return to;
    let probe: unknown = to;
    for (
      let depth = 0;
      depth < MAX_DEPTH * 2 && typeof probe === 'object' && probe !== null;
      depth++
    ) {
      if (createdMarkOn(probe)) return to;
      probe = (probe as { cause?: unknown }).cause;
    }
    return markCreatedBeforeFailure(to, mark.logicalId, mark.resourceType, mark.physicalId);
  } catch {
    return to;
  }
}

/**
 * Mark `error` (or the first link under it that carries no logical id of its
 * own) as the failure of an auxiliary call made while creating
 * `ownerLogicalId`. Returns `error` so a `catch` can write
 * `throw markAuxiliaryFailure(error, logicalId)`. Idempotent: a chain that
 * already carries an auxiliary mark is left as it is.
 *
 * The walk visits every OBJECT link, as the classifier does (its name and
 * Cloud Control code arms read a non-`Error` link too), and never throws: a
 * link whose own `logicalId` cannot be redefined is left alone rather than
 * trading the provider's error for a `TypeError`, and a walk that throws (a
 * `cause` getter, a Proxy trap) stops where it is, since the retry loop's
 * `catch` calls this too (#3972).
 */
export function markAuxiliaryFailure<E>(error: E, ownerLogicalId: string): E {
  try {
    let current: unknown = error;
    for (
      let depth = 0;
      depth < MAX_DEPTH && typeof current === 'object' && current !== null;
      depth++
    ) {
      const own = Object.getOwnPropertyDescriptor(current, 'logicalId');
      if (typeof own?.value === 'string') {
        if (isAuxiliaryMark(own)) return error;
      } else {
        if (Object.isExtensible(current) && own?.configurable !== false) {
          Object.defineProperty(current, 'logicalId', {
            value: auxiliaryLogicalId(ownerLogicalId),
            enumerable: false,
            writable: false,
            configurable: true,
          });
        }
        return error;
      }
      current = (current as { cause?: unknown }).cause;
    }
  } catch {
    // Unreadable chain: left as it is, per the doc above.
  }
  return error;
}
