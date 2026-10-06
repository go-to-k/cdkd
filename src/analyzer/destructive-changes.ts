import type { CloudFormationTemplate } from '../types/resource.js';
import { shouldRetainResource, type ResourceChange, type ResourceState } from '../types/state.js';
import { displayIdent, displaySafe } from '../utils/display-safe.js';

/**
 * What a destructive change does to the existing physical resource. The same
 * four impacts the AWS CDK CLI treats as destructive for
 * `cdk diff --fail-on=destructive` and `cdk deploy --require-approval=destructive`
 * (aws/aws-cdk-cli#2011, #2021).
 */
export type DestructiveImpact = 'WILL_REPLACE' | 'MAY_REPLACE' | 'WILL_DESTROY' | 'WILL_ORPHAN';

/** A resource change that replaces, deletes or orphans an existing physical resource. */
export interface DestructiveChange {
  /** The stack the resource belongs to (a nested child's `<parent>~<logicalId>` state name). */
  stackName: string;
  logicalId: string;
  /** The recorded type for a removal or a replacement, so a `Type` change names the resource being replaced. */
  resourceType: string;
  /** The template's `aws:cdk:path` metadata, when the template still declares the resource. */
  constructPath?: string;
  impact: DestructiveImpact;
}

/** Not a physical resource, so removing or replacing it destroys nothing. */
const IGNORED_RESOURCE_TYPES: ReadonlySet<string> = new Set(['AWS::CDK::Metadata']);

const PATH_METADATA_KEY = 'aws:cdk:path';

/**
 * Collect the changes of one stack that replace, delete or orphan an existing
 * resource.
 *
 * - A `DELETE` destroys the resource, or orphans it when its recorded
 *   `DeletionPolicy` keeps it (`Retain` / `RetainExceptOnCreate`, which a
 *   deploy and a destroy both keep — {@link shouldRetainResource}).
 * - An `UPDATE` whose recorded type differs from the template's, or that
 *   changes a create-only property, replaces it. That is the same test the
 *   deploy engine's replacement decision applies.
 * - A replacement CEILING (a `requiresReplacement` the diff set on a value it
 *   could not resolve yet, marked `inPlacePropagated` / `replacementPropagated`)
 *   is "may be replaced": only the deploy learns whether the value moves. It
 *   counts as destructive, as upstream counts `MAY_REPLACE`, since a false
 *   positive is the safe side for a gate.
 *
 * `records` is the state the diff was computed against, adopted rollback-orphan
 * records included, so a removal reads the `DeletionPolicy` the deploy will.
 */
export function findDestructiveChanges(
  stackName: string,
  changes: Iterable<ResourceChange>,
  records: Readonly<Record<string, ResourceState>>,
  template?: CloudFormationTemplate,
  /** `--recreate-via-*` targets: replaced by the deploy whatever their properties say. */
  recreateTargets: ReadonlySet<string> = new Set()
): DestructiveChange[] {
  const found: DestructiveChange[] = [];
  for (const change of changes) {
    const record = Object.hasOwn(records, change.logicalId) ? records[change.logicalId] : undefined;
    const resourceType = record?.resourceType ?? change.resourceType;
    if (
      IGNORED_RESOURCE_TYPES.has(resourceType) ||
      IGNORED_RESOURCE_TYPES.has(change.resourceType)
    ) {
      continue;
    }
    const impact =
      change.changeType === 'UPDATE' && recreateTargets.has(change.logicalId)
        ? 'WILL_REPLACE'
        : destructiveImpactOf(change, record);
    if (impact === undefined) continue;
    // A removed resource is no longer in the template: the path the deploy
    // that created it recorded is the one to show.
    const constructPath = constructPathOf(template, change.logicalId) ?? record?.constructPath;
    found.push({
      stackName,
      logicalId: change.logicalId,
      resourceType,
      ...(constructPath !== undefined && { constructPath }),
      impact,
    });
  }
  return found;
}

function destructiveImpactOf(
  change: ResourceChange,
  record: ResourceState | undefined
): DestructiveImpact | undefined {
  switch (change.changeType) {
    case 'DELETE':
      return shouldRetainResource(record?.deletionPolicy) ? 'WILL_ORPHAN' : 'WILL_DESTROY';
    case 'UPDATE': {
      if (record !== undefined && record.resourceType !== change.resourceType)
        return 'WILL_REPLACE';
      let mayReplace = false;
      for (const pc of change.propertyChanges ?? []) {
        if (!pc.requiresReplacement) continue;
        if (pc.inPlacePropagated === true || pc.replacementPropagated === true) {
          mayReplace = true;
        } else {
          return 'WILL_REPLACE';
        }
      }
      return mayReplace ? 'MAY_REPLACE' : undefined;
    }
    default:
      return undefined;
  }
}

/** The template resource's `aws:cdk:path` metadata, if it declares one. */
export function constructPathOf(
  template: CloudFormationTemplate | undefined,
  logicalId: string
): string | undefined {
  const resources = template?.Resources;
  if (resources === undefined || !Object.hasOwn(resources, logicalId)) return undefined;
  const path = resources[logicalId]?.Metadata?.[PATH_METADATA_KEY];
  return typeof path === 'string' && path !== '' ? path : undefined;
}

/** The impact in a few words, as the AWS CDK CLI words it. */
export function describeDestructiveImpact(impact: DestructiveImpact): string {
  switch (impact) {
    case 'WILL_REPLACE':
      return 'will be replaced';
    case 'MAY_REPLACE':
      return 'may be replaced';
    case 'WILL_DESTROY':
      return 'will be destroyed';
    case 'WILL_ORPHAN':
      return 'will be orphaned';
  }
}

/**
 * One line per change: stack, resource type, construct path and logical id, as
 * the AWS CDK CLI lists them. Every value is template- or state-chosen, so each
 * is rendered through the display helpers.
 */
export function formatDestructiveChange(change: DestructiveChange): string {
  const path =
    change.constructPath !== undefined ? `${displaySafe(displayPath(change.constructPath))} ` : '';
  return (
    `${displayIdent(change.stackName)}: ${displaySafe(change.resourceType)} ${path}` +
    `${displayIdent(change.logicalId)} ${describeDestructiveImpact(change.impact)}`
  );
}

/**
 * Shorten a construct path the way the AWS CDK CLI's diff does: the stack is
 * left out (it is shown separately), as is a trailing `Resource` / `Default`.
 */
function displayPath(constructPath: string): string {
  let parts = constructPath.replace(/^\//, '').split('/');
  if (parts.length > 1) {
    parts = parts.slice(1);
    const last = parts[parts.length - 1];
    if (parts.length > 1 && (last === 'Resource' || last === 'Default')) {
      parts = parts.slice(0, -1);
    }
  }
  return parts.join('/');
}

/**
 * `record` with `constructPath` set to `path`. Returned BY IDENTITY when it
 * already matches, or when the template declares none (a removed resource
 * keeps the path its last deploy recorded), so a save allocates nothing for an
 * unchanged record.
 */
export function withConstructPath<R extends ResourceState>(record: R, path: string | undefined): R {
  if (path === undefined || record.constructPath === path) return record;
  return { ...record, constructPath: path };
}
