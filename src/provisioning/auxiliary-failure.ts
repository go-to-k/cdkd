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
 * template logical id, and it names the owner so a debugger reading the chain
 * sees whose create raised it.
 */
export function auxiliaryLogicalId(ownerLogicalId: string): string {
  return `${ownerLogicalId}${AUXILIARY_LOGICAL_ID_SUFFIX}`;
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
 * trading the provider's error for a `TypeError`.
 */
export function markAuxiliaryFailure<E>(error: E, ownerLogicalId: string): E {
  let current: unknown = error;
  for (
    let depth = 0;
    depth < MAX_DEPTH && typeof current === 'object' && current !== null;
    depth++
  ) {
    const own = Object.getOwnPropertyDescriptor(current, 'logicalId');
    if (typeof own?.value === 'string') {
      if (own.value.endsWith(AUXILIARY_LOGICAL_ID_SUFFIX)) return error;
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
  return error;
}
