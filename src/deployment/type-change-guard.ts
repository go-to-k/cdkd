/**
 * Plan-time refusal for a resource `Type` change that involves a NESTED STACK
 * row (issue [#2668](https://github.com/go-to-k/cdkd/issues/2668)).
 *
 * ## The defect this guards
 *
 * A replacement runs BOTH halves — the delete of the existing resource and the
 * create of the new one — on a single `resourceType`, and that one type comes
 * from the TEMPLATE:
 *
 *   - `src/analyzer/diff-calculator.ts` emits a Type change as
 *     `changeType: 'UPDATE'` carrying `resourceType: desiredResource.Type` (the
 *     NEW type) plus a synthetic `{ path: 'Type', requiresReplacement: true }`
 *     property change, so a plain `cdkd deploy` takes the replacement path with
 *     no `--recreate-via-*` flag involved;
 *   - `deploy-engine.ts`'s `provisionResource` binds `const resourceType =
 *     change.resourceType`, and its `oldDeleteProvider` resolves from THAT
 *     while taking `provisionedBy` from the state record.
 *
 * So the OLD resource's delete is dispatched at the NEW type's provider. That
 * has three outcomes, all of them wrong and all of them the subject of #2668's
 * full routing fix: usually a loud API error, or a silent leak of the old
 * resource; and where the two types' physical-id namespaces OVERLAP (a log
 * group and a Lambda function can both be addressed by the bare name `myapp`),
 * the deletion of an unrelated LIVE resource of the new type. For
 * `AWS::CloudFormation::Stack` it is a fourth and worse one, because
 * `NestedStackProvider.delete` IGNORES the physical id it is handed and derives
 * its own target, `<parent>~<logicalId>`, then destroys that child stack and
 * every resource it owns. Nothing else stops it: the type is not in
 * `STATEFUL_TYPES`, so the property-driven stateful guard does not fire, and
 * `deleteProtection`-style consent screens are per-resource on a stack the user
 * never named.
 *
 * ## Why the guard is scoped to this one type pair
 *
 * The catastrophic property is not "the types differ" but "the delete provider
 * ignores the physical id it is handed and derives its own target". Every
 * provider `delete` in `src/provisioning/providers/**` that ignores its
 * `physicalId` parameter was enumerated when this guard was written: four
 * sites, of which three (`wait-condition-handle-provider.ts`,
 * `agentcore-code-interpreter-provider.ts`, `agentcore-browser-provider.ts`)
 * are pure no-ops that emit a debug line and touch no AWS resource. Only
 * `nested-stack-provider.ts` turns the mis-route into the destruction of
 * resources the deploy never named.
 *
 * Widening the refusal to EVERY Type change was rejected because it would
 * refuse a deploy that is correct today: under `UpdateReplacePolicy: Retain`
 * the property-driven replacement SKIPS the old resource's delete entirely, so
 * the mis-routed provider is never called and the outcome (old resource
 * retained, new one created) is exactly CloudFormation's. Blocking that is a
 * false refusal of a working deploy.
 *
 * The nested-stack pair is refused ANYWAY under `Retain`, deliberately: the
 * create half still runs, and in the into-nested direction that means
 * `NestedStackProvider.create` deploying a child stack at
 * `<parent>~<logicalId>` and writing a child state record at that key. Reading
 * the effective policy here would also duplicate the engine's own
 * template-vs-state policy resolution inside a stopgap whose failure mode is
 * fail-OPEN. The remedy below costs the user a rename either way.
 *
 * ## No escape hatch
 *
 * Deliberately absolute, matching the sibling refusal issue #2567 shipped for
 * the FLAGGED half of the same hazard (`recreate-targets.ts`'s
 * `blockedNestedStackTargets`, refused in both directions with no
 * `--force-stateful-recreation` bypass). A consent flag only makes sense when
 * the destructive call is correctly TARGETED and the user is accepting its
 * consequences; here the target itself is wrong, so there is no outcome to opt
 * into.
 */

import type { ResourceChange, ResourceState } from '../types/state.js';

/**
 * The CFn type of a nested stack's row in its PARENT's template.
 *
 * Spelled locally rather than imported, matching
 * `src/deployment/recreate-targets.ts`: the only exported copy lives in
 * `src/cli/commands/retire-cfn-stack.ts`, and importing a CLI command module
 * from the deployment layer would invert the dependency direction.
 */
const NESTED_STACK_RESOURCE_TYPE = 'AWS::CloudFormation::Stack';

/** One refused row: a Type change with a nested-stack row on one side. */
export interface NestedStackTypeChange {
  logicalId: string;
  /** The type cdkd has RECORDED for this row — the resource that exists. */
  currentType: string;
  /** The type the TEMPLATE now declares — the one both halves would route on. */
  desiredType: string;
  /** The recorded physical id of the resource the delete would be aimed at. */
  physicalId: string;
  /**
   * Which side carries the nested-stack type. The two produce different
   * damage, so the message renders them separately.
   */
  direction: 'into-nested-stack' | 'out-of-nested-stack';
}

/**
 * Find every planned change whose recorded type and template type differ with
 * `AWS::CloudFormation::Stack` on one side.
 *
 * Reads exactly the two values the defect is made of: `change.resourceType`
 * (what `provisionResource` binds and routes BOTH replacement halves on) and
 * the state record's `resourceType` (the resource that actually exists). That
 * is deliberate — deriving the "desired" type from the template again would be
 * a second implementation of the diff's own Type-change rule (metadata skip,
 * condition pruning) which could drift away from the routing decision this
 * guards.
 *
 * `changeType` is not filtered on. A Type change surfaces as an `UPDATE`, but a
 * DELETE / NO_CHANGE row cannot diverge in the first place (the diff builds
 * both from the state record's own type), so filtering would only add a way for
 * a future change-shape to slip past.
 */
export function findNestedStackTypeChanges(input: {
  changes: ReadonlyMap<string, ResourceChange>;
  stateResources: Record<string, ResourceState>;
}): NestedStackTypeChange[] {
  const found: NestedStackTypeChange[] = [];
  for (const [logicalId, change] of input.changes) {
    // `Object.hasOwn`, not a bare index: `resources` is a JSON-parsed plain
    // object, so a logical id spelling an `Object.prototype` member —
    // `constructor`, `toString`, `valueOf`, `hasOwnProperty`, all valid CFn
    // logical ids — resolves down the prototype chain to a truthy value with
    // no `resourceType`. A CREATE at such an id would then be reported as a
    // Type change "from undefined", refusing a deploy that has nothing to
    // refuse.
    //
    // This makes the guard STRICTER than two call sites that index the same map
    // raw (`analyzer/diff-calculator.ts`'s CREATE-vs-UPDATE decision and
    // `deploy-engine.ts`'s per-resource previous-state read), so for such an id
    // with no own record the diff can manufacture a Type change this guard
    // skips. Deliberately left asymmetric rather than "fixed" here, because the
    // asymmetry is safe in the direction that matters and the other two sites
    // are outside this stopgap: the delete that would follow derives
    // `<parent>~constructor`, finds no child state and returns idempotently,
    // and a LIVE child at that key implies an OWN record in the parent's state
    // — which is exactly the case this guard does see.
    if (!Object.hasOwn(input.stateResources, logicalId)) continue;
    const currentResource = input.stateResources[logicalId];
    if (!currentResource) continue;
    const currentType = currentResource.resourceType;
    const desiredType = change.resourceType;
    if (currentType === desiredType) continue;
    const intoNested = desiredType === NESTED_STACK_RESOURCE_TYPE;
    const outOfNested = currentType === NESTED_STACK_RESOURCE_TYPE;
    if (!intoNested && !outOfNested) continue;
    found.push({
      logicalId,
      currentType,
      desiredType,
      physicalId: currentResource.physicalId,
      direction: intoNested ? 'into-nested-stack' : 'out-of-nested-stack',
    });
  }
  return found;
}

/**
 * Render the refusal. Names the logical id, BOTH types, the resource the
 * mis-routed delete would be aimed at, and what to do instead.
 *
 * `stackName` is the stack being deployed, so the into-nested arm can print the
 * child stack name `NestedStackProvider.delete` would derive and destroy — the
 * one piece of the damage the user cannot read off their own template.
 */
export function renderNestedStackTypeChangeRefusal(
  typeChanges: readonly NestedStackTypeChange[],
  stackName: string
): string {
  const rows = typeChanges.map((tc) => {
    const head =
      `  - ${tc.logicalId}: Type changes from ${tc.currentType} to ${tc.desiredType} ` +
      `(the existing ${tc.currentType} is ${tc.physicalId}).`;
    const damage =
      tc.direction === 'into-nested-stack'
        ? `    Both halves of the replacement would route on the TEMPLATE's type, so the ` +
          `existing resource's delete would be dispatched at the ${NESTED_STACK_RESOURCE_TYPE} ` +
          `provider — which ignores the physical id it is handed and instead destroys the ` +
          `nested child stack "${stackName}~${tc.logicalId}" and every resource that child ` +
          `owns. Where no such child exists the delete is a no-op and ${tc.physicalId} is ` +
          `silently leaked instead.`
        : `    Both halves of the replacement would route on the TEMPLATE's type, so the ` +
          `existing nested stack's delete would be dispatched at the ${tc.desiredType} ` +
          `provider, which cannot delete a nested stack — the child stack ` +
          `"${stackName}~${tc.logicalId}" and every resource it owns would be left behind, ` +
          `untracked.`;
    return `${head}\n${damage}`;
  });

  return (
    `Refusing to deploy ${stackName}: ` +
    (typeChanges.length === 1
      ? `a resource changes its Type `
      : `${typeChanges.length} resources change their Type `) +
    `into or out of ${NESTED_STACK_RESOURCE_TYPE}, which cdkd cannot replace safely ` +
    `(issue #2668).\n` +
    `${rows.join('\n')}\n` +
    `  Deploy this as two changes instead: give the new resource a DIFFERENT logical id ` +
    `(in CDK, rename the construct) so the existing row is deleted through its own type's ` +
    `provider and the new one is created under its own — or remove the resource in one deploy ` +
    `and add its replacement in the next. There is no flag that overrides this refusal: the ` +
    `delete's TARGET would be wrong, not merely its consequences.`
  );
}
