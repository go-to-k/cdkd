/**
 * Plan-time refusal for a resource `Type` change that involves a NESTED STACK
 * row (issue [#2668](https://github.com/go-to-k/cdkd/issues/2668)).
 *
 * ## History, and what is still true
 *
 * This guard shipped as a stopgap while a replacement ran BOTH halves on the
 * TEMPLATE's type, which dispatched the old resource's delete at the new type's
 * provider. For `AWS::CloudFormation::Stack` that was catastrophic:
 * `NestedStackProvider.delete` IGNORES the physical id it is handed and derives
 * `<parent>~<logicalId>`, so the mis-route destroyed a whole child stack.
 *
 * The routing is fixed: the old half of a replacement routes on the STATE
 * record's type and the create on the template's
 * (docs/design/2668-type-change-routing.md). Every other type pair is now
 * replaced normally. This pair is STILL refused, deliberately, because correct
 * routing is necessary here and not sufficient:
 *
 *   - the replacement path deletes the old half as a best-effort CLEANUP step
 *     whose failure is a warning. For a single resource that strands one
 *     resource; for a nested stack it strands a child stack, its state record
 *     at `<parent>~<logicalId>` and every resource it owns, under a green
 *     deploy;
 *   - in the other direction the create half is a whole child-stack deploy run
 *     as one row of a replacement, a path no test or fixture has entered;
 *   - neither direction has been exercised against real AWS.
 *
 * Lifting the refusal is a separate decision with its own fixture, not a side
 * effect of the routing fix.
 *
 * ## No escape hatch
 *
 * Deliberately absolute, matching the sibling refusal issue #2567 shipped for
 * the FLAGGED half (`recreate-targets.ts`'s `blockedNestedStackTargets`,
 * refused in both directions with no `--force-stateful-recreation` bypass). The
 * remedy costs the user a rename.
 */

import type { ResourceChange, ResourceState } from '../types/state.js';
import { isCustomResource } from '../provisioning/provider-registry.js';

/**
 * Does an EQUAL physical id on the two halves of a replacement name the SAME
 * resource? (issue [#2668](https://github.com/go-to-k/cdkd/issues/2668))
 *
 * Within one type, always — which is what the engine's name-idempotent-create
 * guards and the rollback's "adopted the live new resource" shortcut assume.
 * Across a `Type` change an equal id is a coincidence of two namespaces (an SSM
 * parameter and a log group, an IAM user and an IAM group, can share a bare
 * name): the create was genuine, and the other half still has to be deleted
 * through its own type's provider.
 *
 * The ONE exception is the custom-resource family. Every `Custom::*` type and
 * `AWS::CloudFormation::CustomResource` are served by the user's handler, which
 * picks the id, so `Custom::Foo` -> `Custom::Bar` returning the same
 * `PhysicalResourceId` names the SAME resource — and "deleting the other half"
 * would send `Delete` for what the create just built. That holds only on the
 * SDK layer: Cloud Control addresses a resource by type AND identifier.
 *
 * Keyed on the TYPES, deliberately not on "both halves resolved to one provider
 * instance": `register-providers.ts` shares one instance across many types
 * whose namespaces are disjoint (`AWS::IAM::User` / `AWS::IAM::Group`, the EC2,
 * RDS, Glue, ECS families ...), and reading those as one namespace refuses a
 * genuine create on the deploy side and strands the new resource on the
 * rollback side.
 */
export function equalIdNamesSameResource(input: {
  oldType: string;
  newType: string;
  /** The layer the CREATE half of this operation routes through. */
  createLayer: 'sdk' | 'cc-api' | undefined;
}): boolean {
  if (input.oldType === input.newType) return true;
  return (
    isCustomResource(input.oldType) &&
    isCustomResource(input.newType) &&
    input.createLayer !== 'cc-api'
  );
}

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
  /** The type the TEMPLATE now declares. */
  desiredType: string;
  /** The recorded physical id of the resource that would be replaced. */
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
 * Reads exactly the two values a replacement's halves route on:
 * `change.resourceType` (the create) and the state record's `resourceType`
 * (the resource that actually exists, and the delete). That
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
 * Render the refusal. Names the logical id, BOTH types, the existing resource,
 * the child stack involved, and what to do instead.
 *
 * `stackName` is the stack being deployed, so each arm can print the child
 * stack name `<stackName>~<logicalId>` — the one piece the user cannot read off
 * their own template.
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
        ? `    Replacing a single resource BY a nested stack is not supported: the create half ` +
          `of the replacement would deploy a whole child stack "${stackName}~${tc.logicalId}" ` +
          `as one row, while ${tc.physicalId} is still recorded under this logical id.`
        : `    Replacing a nested stack BY a single resource is not supported: a replacement ` +
          `deletes its old half as a best-effort cleanup step whose failure is only a warning, ` +
          `so the child stack "${stackName}~${tc.logicalId}" and every resource it owns could ` +
          `be left behind, untracked, under a deploy that reports success.`;
    return `${head}\n${damage}`;
  });

  return (
    `Refusing to deploy ${stackName}: ` +
    (typeChanges.length === 1
      ? `a resource changes its Type `
      : `${typeChanges.length} resources change their Type `) +
    `into or out of ${NESTED_STACK_RESOURCE_TYPE}, which cdkd does not replace in place ` +
    `(issue #2668).\n` +
    `${rows.join('\n')}\n` +
    `  Deploy this as two changes instead: give the new resource a DIFFERENT logical id ` +
    `(in CDK, rename the construct) so the existing row is deleted through its own type's ` +
    `provider and the new one is created under its own — or remove the resource in one deploy ` +
    `and add its replacement in the next. There is no flag that overrides this refusal.`
  );
}
