import { MAX_CAUSE_CHAIN_DEPTH } from './marks.js';

/**
 * The Cloud Control exception NAME for "this resource type ships no handler
 * for the action you asked for" (issue
 * [#2520](https://github.com/go-to-k/cdkd/issues/2520)).
 *
 * A NAME, not a message fragment: AWS SDK v3 sets `error.name` to the service
 * exception's own identifier, which is a wire-level contract, while the prose
 * beside it is text AWS is free to reword. The sibling READ classifier in
 * `src/cli/commands/drift.ts` (`NO_READ_HANDLER_NAMES`) already keys on this
 * same name for the GET direction.
 */
export const CC_UNSUPPORTED_ACTION_ERROR_NAME = 'UnsupportedActionException';

/**
 * True when a failed `provider.update()` for `logicalId` was rejected because
 * the resource type has no UPDATE handler at all — the signal the deploy
 * engine's update-failure fallback fires on, turning the update into a
 * replacement.
 *
 * ## Why the chain is walked
 *
 * `CloudControlProvider.handleError` WRAPS the raw AWS rejection in a
 * `ProvisioningError` and interpolates `err.message` only; the exception name
 * is never copied into the wrapper's text. Measured 2026-09-04: `aws
 * cloudcontrol update-resource --type-name AWS::DocDB::DBCluster` answers
 * `UnsupportedActionException` with the message `Resource type
 * AWS::DocDB::DBCluster does not support UPDATE action`, which does not repeat
 * the name. That is why the predicate's pre-#2520
 * `message.includes('UnsupportedActionException')` half matched nothing cdkd
 * produces, and why the structured read has to look one link down.
 *
 * Two structured signals, both read off a link rather than out of prose:
 *
 *  - `name` — the synchronous `UpdateResource` rejection, one cause link below
 *    the provider's wrapper.
 *  - `ccErrorCode` PLUS `ccOperation === 'UPDATE'` — the two fields
 *    `CloudControlOperationFailedError` carries for an asynchronous
 *    progress-event failure, read structurally exactly as
 *    `cloud-control-provider.ts` reads the code for `AlreadyExists` /
 *    `NotFound`. No async occurrence has been MEASURED
 *    (`UnsupportedActionException` is raised synchronously by `UpdateResource`
 *    today); the arm exists so the async shape is classified at all, and it is
 *    pinned by unit cases built from the real error class.
 *    `ccOperation` is required rather than decorative precisely BECAUSE the
 *    arm is unmeasured: a CREATE or DELETE sub-operation reporting the same
 *    code says nothing about whether the type has an UPDATE handler, and
 *    reading the code alone would let it trigger a DELETE + CREATE.
 *
 * ## Why the walk stops at another resource's error
 *
 * `logicalId` is not decoration — it is the fence that keeps a chain walk from
 * being WIDER than the message read it replaces. `NestedStackProvider.update`
 * runs a whole child deploy inside the PARENT's `provider.update()` call, so a
 * child resource's Cloud Control rejection propagates into the parent's update
 * catch, several cause links down. An unanchored walk would classify that as
 * "the nested stack cannot be updated in place" and DELETE + CREATE the entire
 * child stack. The pre-#2520 message read was immune by accident — the child
 * engine's wrapper is `Failed to update resource <child>`, which quotes no AWS
 * text — and this anchor makes the immunity deliberate: `ProvisioningError`
 * and `ResourceUpdateNotSupportedError` both carry `logicalId`, so the walk
 * stops dead at the first link that names a resource other than the one being
 * updated.
 *
 * ## Why no message is read
 *
 * AWS's prose (`does not support UPDATE`) is NOT a signal (issue #3810). A
 * top-level message can quote template-chosen text — a cdkd refusal
 * interpolating a property value, or an AWS rejection echoing its input — so a
 * substring match replaced resources without `--replace`. Both real shapes
 * carry a structured field: `handleError` threads the SDK exception as `cause`,
 * and the async failure carries `ccErrorCode`. Missing the signal fails the
 * deploy (safe); matching too broadly deletes a resource nobody asked to
 * replace (unsafe).
 *
 * ## Codes deliberately NOT matched
 *
 * The Cloud Control handler error code `NotUpdatable` reports "this particular
 * patch is not applicable" (a create-only property, an invalid document)
 * rather than "the type has no UPDATE handler", and cdkd already routes the
 * create-only case through its own property-driven replacement — accepting it
 * here would convert ordinary update rejections into replacements.
 * `TypeNotFoundException`, which `handleError` wraps into the SAME sentence as
 * the unsupported-action case, is not matched either: an unregistered type has
 * no replacement story, so it must keep failing the deploy rather than
 * deleting the resource.
 */
export function isUpdateUnsupportedError(error: unknown, logicalId: string): boolean {
  // A typed `ResourceUpdateNotSupportedError` is the `--replace` OPT-IN
  // trigger, never the auto-fallback (issue #3757). Still a live fence: its
  // constructor accepts a `cause`, so a typed refusal wrapping a named
  // `UnsupportedActionException` would otherwise match at depth 1. Matched by
  // NAME: this module does not import `error-handler.ts`, which imports it, to
  // avoid a cycle.
  if (
    (error as { name?: unknown } | null | undefined)?.name === 'ResourceUpdateNotSupportedError'
  ) {
    return false;
  }
  let current: unknown = error;
  for (
    let depth = 0;
    current !== null && current !== undefined && depth < MAX_CAUSE_CHAIN_DEPTH;
    depth++
  ) {
    const link = current as {
      name?: unknown;
      ccErrorCode?: unknown;
      ccOperation?: unknown;
      logicalId?: unknown;
      cause?: unknown;
    };
    // The anchor runs FIRST at every depth, ahead of both structured reads, so
    // a rejection that names another resource cannot classify this one by ANY
    // route — a nested stack's child rejection included.
    //
    // RESIDUAL, stated rather than left to be rediscovered: the anchor
    // compares logical IDS, so a CHILD resource whose logical id EQUALS the
    // parent `AWS::CloudFormation::Stack`'s passes it at every link, and that
    // child's Cloud Control rejection classifies the PARENT — replacing the
    // whole child stack. Reachable, via CDK's `overrideLogicalId`, but not a
    // trust boundary: the same operator authors both templates, so it is a
    // self-inflicted collision rather than an attack, and the ordinary case
    // (child ids differing from the nested stack's) is correctly fenced.
    // Closing it would need an identity the ids alone do not carry — the stack
    // name, or the resource ARN — which is a wider change than the classifier.
    if (typeof link.logicalId === 'string' && link.logicalId !== logicalId) return false;
    // NO operation anchor on this arm, unlike the `ccErrorCode` one below, and
    // that asymmetry is deliberate rather than an oversight. AUDITED
    // 2026-09-05 for what a non-UPDATE Cloud Control call could put here.
    // THREE Cloud Control calls are reachable from
    // `CloudControlProvider.update()`, derived by grepping every
    // `new *ResourceCommand(` in that file and resolving each to its enclosing
    // method rather than from memory (an earlier revision of this comment
    // listed two, omitted `GetResource`, and then contradicted itself by
    // naming `readCcResourceModel` — the caller that issues it — one clause
    // later):
    //
    //   - `UpdateResource` — the update itself.
    //   - `GetResourceRequestStatus` — `waitForOperation`'s polling. It
    //     invokes no resource handler; its documented failure is
    //     `RequestTokenNotFoundException`.
    //   - `GetResource` — via `readCcResourceModel`, reached from
    //     `mergeSparseModelReadback` and from six sites inside
    //     `enrichResourceAttributes`. It NEVER throws: its own body is one
    //     try/catch that logs at debug and returns `undefined`.
    //
    // The remaining `GetResource` sites in that file (`getResourceState`,
    // `readCurrentState`, `import`) are entry points for drift / import and
    // are not called from `update()` — grep for `this.getResourceState(` /
    // `this.readCurrentState(` returns nothing.
    //
    // Everything else awaited inside `update()`'s try is non-Cloud-Control and
    // cannot raise this exception at all: `getTopLevelWriteOnlyProperties` is
    // a CloudFormation `DescribeType` that swallows its own failures, and
    // `enrichResourceAttributes` has 21 awaits under 15 try/catch pairs — 15
    // of them RDS x2 / DynamoDB / API Gateway / CloudFront / Lambda /
    // EventBridge x2 / ElastiCache / Redshift / OpenSearch and four
    // account-info lookups, the other six the `readCcResourceModel` calls
    // above. No SDK provider makes a Cloud Control call either (the one
    // `GetResourceCommand` in `apigateway-provider.ts` is API Gateway's, not
    // Cloud Control's). So a non-UPDATE `UnsupportedActionException` cannot
    // reach this walk today.
    //
    // Anchoring it anyway would be the WRONG trade: `handleError` does not
    // record which operation it wrapped, so the only available anchor is a
    // field the sync path never sets — the arm would stop firing on the shape
    // it exists for. The async arm can be anchored precisely because
    // `CloudControlOperationFailedError` carries `ccOperation`.
    if (link.name === CC_UNSUPPORTED_ACTION_ERROR_NAME) return true;
    // `ccOperation` too, even though no async occurrence has been measured: the
    // field distinguishes which Cloud Control operation failed, and a CREATE or
    // DELETE sub-operation reporting the same code says nothing about whether
    // the type has an UPDATE handler. Reading the code alone would let such a
    // failure trigger a DELETE + CREATE.
    if (link.ccErrorCode === CC_UNSUPPORTED_ACTION_ERROR_NAME && link.ccOperation === 'UPDATE') {
      return true;
    }
    current = link.cause;
  }
  return false;
}
