import type { CompletedOperation, FailedOperation } from '../types.js';

/**
 * go-to-k/cdkd#4690: the delete-first reversal deletes the NEW resource before
 * re-creating the old one from `previousState.properties`. When those
 * properties name a resource that another op of the SAME segment took away
 * (a replacement that did not keep its old copy, or a DELETE), the rollback
 * may not be able to bring that resource back under the id they name: the
 * re-create then fails after the new resource is gone, and the resource is
 * lost (a target group replaced create-first while its listener was recreated
 * delete-first). Such an op keeps the create-first order, and its collision
 * route refuses to delete the new resource too, so a failed re-create keeps
 * it. Keyed by the op object, like {@link markProvenDistinctFromRecord}:
 * computed per replay, never journaled.
 */
const deleteFirstBlockedBy = new WeakMap<
  CompletedOperation,
  { logicalId: string; physicalId: string }
>();

/**
 * Mark each delete-first op of one segment whose old properties reference a
 * resource {@link deleteFirstBlockedBy} describes. Only the PROPERTIES are
 * scanned: the re-create sends `previousState.properties`, and its attributes
 * never reach `create()`.
 *
 * A gone resource is named by its old physical id AND by the attributes of its
 * old record that IDENTIFY it ({@link identityAttributeValues}): a dependent
 * names an SQS queue by its ARN, never by its URL id. Never by an attribute it
 * merely shares with other resources (a subnet's `VpcId` or
 * `AvailabilityZone`, a `CidrBlock`, a hosted-zone id, an account or region).
 * A leaf matches a needle
 * exactly, as any whole `:`/`/`-separated segment (an ARN or path boundary)
 * whatever its length, so a short
 * user-chosen name inside an ARN counts, or, for a needle of 16+ characters,
 * anywhere inside it (an ARN embedded in a document).
 *
 * Both errors cost something, so the needles are identities only: a missed
 * match can lose a resource, and a false block keeps the create-first order
 * AND refuses that op's collision route, where the create-first order alone
 * deletes the new resource on a proven name holder and completes the
 * reversal.
 *
 * The segment's FAILED ops count too (`failedOperations`): a replacement that
 * deleted its old resource before a create that failed.
 *
 * KNOWN BOUND: the scan reads this segment's ops only. A parent op whose old
 * properties name a nested child stack's output is not checked against the
 * CHILD's journal.
 */
export function markDeleteFirstBlocked(
  operations: readonly CompletedOperation[],
  failedOperations: readonly FailedOperation[] = []
): void {
  const gone: Array<{ logicalId: string; physicalId: string; needles: string[] }> = [];
  const add = (
    logicalId: string,
    physicalId: unknown,
    attributes: Record<string, unknown> | undefined
  ): void => {
    if (typeof physicalId !== 'string' || physicalId === '') return;
    gone.push({
      logicalId,
      physicalId,
      needles: [physicalId, ...identityAttributeValues(physicalId, attributes)],
    });
  };
  // A FAILED replacement that deleted its old resource first took it away
  // too, whether or not its create made anything.
  for (const f of failedOperations) {
    if (seedsDeleteFirstGuard(f)) {
      add(f.logicalId, f.previousState?.physicalId, f.previousState?.attributes);
    } else if (f.changeType === 'CREATE' && f.replacedResourceDeleted === true) {
      add(f.logicalId, f.replacedPhysicalId, undefined);
    }
  }
  for (const op of operations) {
    const prev = op.previousState?.physicalId;
    if (typeof prev !== 'string' || prev === '') continue;
    // An old resource that may survive (`oldResourceMaySurvive`, #2631) counts
    // as taken away too: that only keeps another op's reversal create-first.
    const replacedAway =
      op.changeType === 'DELETE' ||
      (op.changeType === 'UPDATE' &&
        op.physicalId !== prev &&
        op.wasReplaced !== false &&
        op.oldResourceRetained !== true);
    if (replacedAway) add(op.logicalId, prev, op.previousState?.attributes);
  }
  if (gone.length === 0) return;
  for (const op of operations) {
    if (op.oldDeletedBeforeCreate !== true) continue;
    const props = op.previousState?.properties;
    if (props === undefined) continue;
    const hit = gone.find(
      (g) =>
        g.logicalId !== op.logicalId &&
        someStringLeaf(props, (leaf) => g.needles.some((n) => namesResource(leaf, n)))
    );
    if (hit) deleteFirstBlockedBy.set(op, { logicalId: hit.logicalId, physicalId: hit.physicalId });
  }
}

/**
 * The attribute values of a gone record that name THAT record, not something
 * it shares with others:
 * - a value containing a physical id of 8+ characters (an ARN or URL built on
 *   it; a shorter id is too likely to occur inside an unrelated value);
 * - an `arn:` value whose last `:`/`/` segment is a segment of the physical id
 *   (an SQS queue's `Arn` against its URL id; an EKS cluster's KMS key ARN is
 *   another resource's, and its key id is no segment of the cluster name);
 * - `DNSName`: a load balancer's own name, which a Route 53 alias names.
 */
function identityAttributeValues(
  physicalId: string,
  attributes: Record<string, unknown> | undefined
): string[] {
  if (attributes === null || typeof attributes !== 'object') return [];
  const idSegments = new Set(physicalId.split(/[:/|]/).filter((t) => t !== ''));
  const out: string[] = [];
  for (const [key, value] of Object.entries(attributes)) {
    if (typeof value !== 'string' || value === '' || value === physicalId) continue;
    const arnTail = value.startsWith('arn:') ? value.split(/[:/]/).at(-1) : undefined;
    if (
      (physicalId.length >= 8 && value.includes(physicalId)) ||
      (arnTail !== undefined && arnTail !== '' && idSegments.has(arnTail)) ||
      key === 'DNSName'
    ) {
      out.push(value);
    }
  }
  return out;
}

/** Whether `leaf` names `needle` (see {@link markDeleteFirstBlocked}). */
function namesResource(leaf: string, needle: string): boolean {
  return (
    leaf === needle ||
    // Any ARN or path boundary: `...:name`, `.../name`, `.../name/...`, `...:name:...`.
    leaf.split(/[:/]/).includes(needle) ||
    // A needle that itself holds a `/` (a log group `/a/b`) is no single
    // segment: match it between ARN colons (`...:log-group:/a/b:*`).
    (needle.includes('/') && (leaf.includes(`:${needle}:`) || leaf.endsWith(`:${needle}`))) ||
    (needle.length >= 16 && leaf.includes(needle))
  );
}

/**
 * A FAILED op that deleted its old resource before a create that failed: the
 * delete-first guard counts that resource as gone, and `cdkd rollback` keeps
 * such an op in the journal after handling it while the segment's completed
 * ops remain (see its keep rule), so a re-run's guard still sees it.
 */
export function seedsDeleteFirstGuard(op: FailedOperation): boolean {
  return (
    op.changeType === 'UPDATE' &&
    (op.oldDeletedBeforeCreate === true || op.replacementOrphaned === 'delete-first')
  );
}

/** The op and id that keep `op` off the delete-first reversal, if any. */
export function deleteFirstBlocker(
  op: CompletedOperation
): { logicalId: string; physicalId: string } | undefined {
  return deleteFirstBlockedBy.get(op);
}

function someStringLeaf(value: unknown, test: (leaf: string) => boolean, depth = 0): boolean {
  if (typeof value === 'string') return test(value);
  if (depth > 64 || value === null || typeof value !== 'object') return false;
  const children = Array.isArray(value) ? value : Object.values(value);
  return children.some((child) => someStringLeaf(child, test, depth + 1));
}
