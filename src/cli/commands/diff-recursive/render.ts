import { movedToHint, type MovedTo } from '../../../analyzer/refactor-hints.js';
import { stripForDisplay } from '../../../utils/regexp.js';
import { cdkdRemedy } from '../../../utils/pasteable-command.js';
import type { ResourceChange } from '../../../types/state.js';
import { INTRINSIC_KEYS } from '../../../analyzer/diff-calculator.js';
import type { OutputChange } from '../../../analyzer/outputs-diff.js';
import {
  displayLogicalId,
  UNREADABLE_ORPHANS_CONTAINER_ROW,
  UNREADABLE_RESOURCES_MAP_ROW,
} from '../../../state/malformed-resources-bag.js';
import type { DiffTreeNode, UnreadableContainer } from './types.js';
import { SDK_MIGRATION_TOKEN } from './routes.js';
import { nodeHasChanges, unreadableCount } from './tree.js';
import { outputNameRow } from './json.js';

/** The name the human preview prints for each {@link UnreadableContainer}. */
const UNREADABLE_CONTAINER_NAMES: Record<UnreadableContainer, string> = {
  resources: UNREADABLE_RESOURCES_MAP_ROW,
  orphans: UNREADABLE_ORPHANS_CONTAINER_ROW,
};

/** How many unreadable row names the human preview lists before summarizing. */
const UNREADABLE_PREVIEW_NAMES = 10;

function isIntrinsic(value: unknown): boolean {
  if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const keys = Object.keys(value as Record<string, unknown>);
  return keys.length === 1 && INTRINSIC_KEYS.has(keys[0]!);
}

/**
 * Per-side rendering rule for a diff side that is NOT a plain object pair
 * (primitives, arrays, intrinsics). The both-plain-objects case is handled
 * jointly by {@link stripUnchangedValuePair}, which never delegates it here.
 */
function stripUnchangedValues(value: unknown, other: unknown): unknown {
  // Primitives or nulls: return as-is (the caller already determined these differ)
  if (value === null || value === undefined || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value;

  // If value itself is an intrinsic, omit it (it's not a real change)
  if (isIntrinsic(value)) return undefined;
  // If the other side is an intrinsic, the resolved value on this side is not a real change
  if (isIntrinsic(other)) return undefined;

  // The other side is a primitive / array / null here (object-vs-object goes
  // through stripUnchangedValuePair), so this side renders in full.
  return value;
}

function isPlainNonIntrinsicObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' && value !== null && !Array.isArray(value) && !isIntrinsic(value)
  );
}

/**
 * Strip unchanged and intrinsic-only keys from BOTH sides of a property
 * change in ONE walk, so the two rendered sides stay symmetric (issue #1608).
 *
 * {@link stripUnchangedValues} runs per side, so a PURE KEY ADDITION pruned
 * the new side down to the added key while the old side — whose own keys are
 * all unchanged — hit the empty-result fallback and printed the FULL object.
 * That asymmetry reads as "the whole object is replaced by just the added
 * key" (i.e. everything else removed), the opposite of what deploy does.
 * Walking the UNION of keys once yields `old: {}` / `new: {AddedKey: ...}`
 * for an addition (and the mirror for a removal); the full-value fallback —
 * kept for sides differing only in key order or intrinsic-valued keys — now
 * fires only when BOTH sides pruned to nothing, so it can never be one-sided.
 * Non-object sides (primitives, arrays, intrinsics) keep the existing
 * per-side semantics via {@link stripUnchangedValues}.
 */
function stripUnchangedValuePair(oldValue: unknown, newValue: unknown): [unknown, unknown] {
  if (!isPlainNonIntrinsicObject(oldValue) || !isPlainNonIntrinsicObject(newValue)) {
    return [stripUnchangedValues(oldValue, newValue), stripUnchangedValues(newValue, oldValue)];
  }

  const oldResult: Record<string, unknown> = {};
  const newResult: Record<string, unknown> = {};
  // Object.hasOwn, not `in`: a user-controlled map key named after an
  // Object.prototype member (`toString`, `constructor`, ...) is `in` every
  // object via the prototype chain, so `in` would silently drop its
  // addition/removal from the union and copy inherited members into a side.
  const keys = [
    ...Object.keys(oldValue),
    ...Object.keys(newValue).filter((k) => !Object.hasOwn(oldValue, k)),
  ];

  for (const key of keys) {
    const o = oldValue[key];
    const n = newValue[key];

    // If either side is intrinsic for this key, skip (not a real change)
    if (isIntrinsic(o) || isIntrinsic(n)) continue;

    // If values are deeply equal, skip
    if (JSON.stringify(o) === JSON.stringify(n)) continue;

    // Recurse for nested objects
    if (isPlainNonIntrinsicObject(o) && isPlainNonIntrinsicObject(n)) {
      const [fo, fn] = stripUnchangedValuePair(o, n);
      if (fo !== undefined && JSON.stringify(fo) !== '{}') oldResult[key] = fo;
      if (fn !== undefined && JSON.stringify(fn) !== '{}') newResult[key] = fn;
    } else {
      if (Object.hasOwn(oldValue, key)) oldResult[key] = o;
      if (Object.hasOwn(newValue, key)) newResult[key] = n;
    }
  }

  if (Object.keys(oldResult).length === 0 && Object.keys(newResult).length === 0) {
    return [oldValue, newValue];
  }
  return [oldResult, newResult];
}

/**
 * Render one side of a property change for the diff output.
 *
 * A side whose WHOLE value is still a raw intrinsic could not be resolved
 * against current state — most commonly a `Ref` / `Fn::GetAtt` to a resource
 * this same deploy will CREATE (the CDK logical-id-churn dance: an
 * `AWS::ApiGateway::Deployment` hash rotation, a `fn.currentVersion` Lambda
 * Version). Rendering that via the strip-unchanged pass collapsed it to
 * the literal string `undefined`, which reads as "this property is being
 * removed" (issue #1017). Instead, render the raw intrinsic compactly and —
 * on the NEW side — annotate that the value only exists after the deploy.
 * Everything else renders the pre-filtered value computed jointly for both
 * sides by {@link stripUnchangedValuePair}.
 */
function renderDiffValue(
  own: unknown,
  filtered: unknown,
  indent: string,
  isNewSide: boolean
): string {
  if (isIntrinsic(own)) {
    const suffix = isNewSide ? ' (known after deploy)' : '';
    return `${JSON.stringify(own)}${suffix}`;
  }
  return (JSON.stringify(filtered, null, 2) ?? 'undefined').replace(/\n/g, `\n${indent}`);
}

/**
 * Render one resource-change map into human-readable diff lines via `logFn`,
 * returning the per-type counts. Shared by the root stack block and every
 * nested-stack block.
 *
 * When `ccApiRoutes` is supplied, every CREATE / UPDATE line whose logical ID
 * appears in the map gets a `[via CC API: <props>]` suffix so the user sees
 * #614's auto-fallback decision at plan time. DELETE lines are not annotated
 * — the delete routing is recorded on each resource's `provisionedBy` state
 * field rather than re-derived from the template.
 *
 * `adoptedOrphans` annotates the rows whose resource is in this diff only
 * because a rollback-orphan record was verified and spliced in (issue
 * go-to-k/cdkd#2943). Without it the row is indistinguishable from an ordinary
 * update, and the user last saw that resource FAIL and leave state — so an
 * unannotated `[~]` reads as cdkd having quietly kept managing it. Both
 * annotations can apply to one row; adoption is printed first because it is
 * why the row exists at all, where the routing describes how it will be
 * carried out.
 */
export function renderChangeLines(
  changes: Map<string, ResourceChange>,
  logFn: (msg: string) => void,
  ccApiRoutes?: Map<string, string[]>,
  adoptedOrphans?: readonly string[],
  refactorHints?: ReadonlyMap<string, MovedTo>
): { create: number; update: number; delete: number } {
  let createCount = 0;
  let updateCount = 0;
  let deleteCount = 0;

  const adopted = new Set(adoptedOrphans ?? []);
  const annotateAdoption = (logicalId: string): string =>
    adopted.has(logicalId) ? ' [adopted from a rollback orphan]' : '';

  const annotateRouting = (logicalId: string): string => {
    const props = ccApiRoutes?.get(logicalId);
    if (!props || props.length === 0) return '';
    // The migration token describes a resource LEAVING Cloud Control, so it
    // cannot wear the `via CC API:` prefix the other tokens share -- that
    // read `[via CC API: returning to SDK provider]`, which says both things
    // at once. It is the only token that is a whole phrase rather than a
    // property name, hence the special case rather than a prefix variable.
    if (props.length === 1 && props[0] === SDK_MIGRATION_TOKEN) {
      return ` [${SDK_MIGRATION_TOKEN}]`;
    }
    return ` [via CC API: ${props.join(', ')}]`;
  };

  for (const [logicalId, change] of changes.entries()) {
    switch (change.changeType) {
      case 'CREATE':
        createCount++;
        logFn(
          `  [+] ${logicalId} (${change.resourceType})` +
            `${annotateAdoption(logicalId)}${annotateRouting(logicalId)}`
        );
        break;
      case 'UPDATE': {
        updateCount++;
        logFn(
          `  [~] ${logicalId} (${change.resourceType})` +
            `${annotateAdoption(logicalId)}${annotateRouting(logicalId)}`
        );
        if (change.propertyChanges && change.propertyChanges.length > 0) {
          for (const propChange of change.propertyChanges) {
            // A synthetic change's `requiresReplacement` is a CEILING the deploy
            // lowers when the resolved value did not move (go-to-k/cdkd#3662,
            // #3803), so the preview must not state it as a verdict.
            const isCeiling =
              propChange.requiresReplacement &&
              (propChange.inPlacePropagated === true || propChange.replacementPropagated === true);
            const requiresReplace = isCeiling
              ? ' [may require replacement]'
              : propChange.requiresReplacement
                ? ' [requires replacement]'
                : '';
            // Issue #807: a propagated change shows old=<resolved value> /
            // new=<unresolved intrinsic> because the property's template
            // value did not change — only the physical ID / ARN it
            // references will change after the upstream replacement. Label
            // it so the apparent string -> {Ref} delta is not misread as a
            // literal value edit.
            // go-to-k/cdkd#3662: the in-place twin — the reader was promoted
            // because a value it reads MAY move in this deploy, which only the
            // deploy learns: an attribute of an updated resource (a nested
            // stack output, a custom resource's `Data`), a custom resource's
            // physical id through `Ref` (#3722), or a nested child's parameter
            // carrying a fresh `NoEcho` value (#3717, a deploy-only arm that
            // `cdkd diff` never reaches). ONE label for all of them, the name
            // of the first: the display's job is to say the delta is not a
            // literal edit, and the JSON field (`inPlacePropagated`) is one
            // flag. The old side is the resolved value, the new side the
            // reading intrinsic.
            // go-to-k/cdkd#4451: both sides are the mask, so the label is
            // what says this is a change at all.
            // go-to-k/cdkd#4852: a reader promoted by its recorded secret
            // versions (`readProvenancePromoted`) names that cause.
            const propagated = propChange.replacementPropagated
              ? ' [replacement propagated]'
              : propChange.readProvenancePromoted === true
                ? ' [read value moved upstream]'
                : propChange.inPlacePropagated
                  ? ' [attribute propagated]'
                  : propChange.maskedExpressionChanged === true
                    ? ' [masked input or expression changed]'
                    : propChange.unsettled === true
                      ? ' [unsettled after a failed update; sent again]'
                      : propChange.newValueKnownAfterDeploy === true
                        ? ' [reads a resource this deploy changes]'
                        : '';
            const indent = '              ';
            const [oldFiltered, newFiltered] = stripUnchangedValuePair(
              propChange.oldValue,
              propChange.newValue
            );
            const oldStr = renderDiffValue(propChange.oldValue, oldFiltered, indent, false);
            // go-to-k/cdkd#6078: `newValue` was resolved against the resource
            // this deploy replaces or updates, so print the template value.
            const newStr =
              propChange.newValueKnownAfterDeploy === true
                ? `${JSON.stringify(propChange.newValueTemplate)} (known after deploy)`
                : renderDiffValue(propChange.newValue, newFiltered, indent, true);
            logFn(`      - ${propChange.path}:${requiresReplace}${propagated}`);
            logFn(`          old: ${oldStr}`);
            logFn(`          new: ${newStr}`);
          }
        }
        if (change.attributeChanges && change.attributeChanges.length > 0) {
          for (const attrChange of change.attributeChanges) {
            logFn(`      - ${attrChange.attribute}: [metadata only, no AWS API call]`);
            logFn(`          old: ${attrChange.oldValue ?? '(unset)'}`);
            logFn(`          new: ${attrChange.newValue ?? '(unset)'}`);
          }
        }
        break;
      }
      case 'DELETE':
        deleteCount++;
        {
          const movedTo = refactorHints?.get(logicalId);
          logFn(
            `  [-] ${logicalId} (${change.resourceType})` +
              (movedTo !== undefined ? movedToHint(movedTo) : '')
          );
        }
        break;
    }
  }

  return { create: createCount, update: updateCount, delete: deleteCount };
}

/**
 * Stand-in printed instead of a withheld stored output value.
 *
 * Worded as a POSSIBILITY because both reasons the value is withheld are
 * suspicions rather than detections — a record that LOOKS pre-GHSA, and a
 * stored key today's template cannot account for (issue #1948), which is
 * undecidable by construction. Stating it as a fact would be wrong on the
 * benign half of each, and `cdkd scrub` finding nothing is the expected
 * outcome there.
 */
const redactedLegacyPlaintext = (): string =>
  `<redacted: may be legacy plaintext in state — run \`${cdkdRemedy('cdkd scrub')}\`>`;

/**
 * The guard for an already-JSON-SERIALIZED value: C1 and the bidi marks
 * only, deliberately NOT C0.
 *
 * `JSON.stringify` escapes every character below 0x20 that occurs INSIDE a
 * string, so the only C0 left on this path is the pretty-printer's own
 * structural newlines — stripping those collapses a multi-line value onto a
 * single line. What `JSON.stringify` passes through unchanged is the C1 range
 * and the bidi overrides, and those are what this removes. It passes `U+2028` /
 * `U+2029` through too, which a JSON or web log viewer breaks a line on: those
 * become a space, as `stripForDisplay` makes them (go-to-k/cdkd#2888). Inside
 * this payload either can only sit in a string literal, never in its layout.
 */
function stripDisplayOnlyChars(value: string): string {
  return (
    value
      // eslint-disable-next-line no-control-regex
      .replace(/[\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
      .replace(/[\u2028\u2029]/g, ' ')
  );
}

/**
 * Render one node's Outputs delta (issue #1921) via `logFn`, returning the
 * per-kind counts. Emits nothing when there is no delta, so an unchanged
 * Outputs section adds no noise to a resource-only diff.
 *
 * Rows are keyed by the PERSISTED bag key, which is what `StackState.outputs`
 * holds and what the exports index publishes. An output carrying an
 * `Export.Name` therefore shows TWO rows — its logical name and its export
 * name — because the deploy writes both keys. That is the useful half for the
 * motivating case: the `[export]`-tagged row IS the string a downstream
 * `Fn::ImportValue` resolves, so the user can match it against the consumer
 * that was failing with "export not found".
 */
export function renderOutputChangeLines(
  outputChanges: readonly OutputChange[],
  logFn: (msg: string) => void
): { add: number; change: number; remove: number } {
  const counts = { add: 0, change: 0, remove: 0 };
  if (outputChanges.length === 0) return counts;

  logFn('\n  Outputs:');
  const indent = '            ';
  // Values are guarded too, but with the C0 range EXCLUDED — see
  // `stripDisplayOnlyChars`. Using the full class here deleted the
  // pretty-printer's newlines and collapsed every multi-line value onto one line.
  const render = (value: unknown): string =>
    stripDisplayOnlyChars(
      (JSON.stringify(value, null, 2) ?? 'undefined').replace(/\n/g, `\n${indent}`)
    );
  const renderOld = (change: OutputChange): string =>
    change.oldValueRedacted ? redactedLegacyPlaintext() : render(change.oldValue);

  for (const change of outputChanges) {
    const exported = change.isExport ? ' [export]' : '';
    // Unlike a resource line's logical id — which CloudFormation constrains to
    // [A-Za-z0-9] — an Outputs bag key can be an `Export.Name` that cdkd
    // RESOLVED from an `Fn::Sub` / parameter / SSM value, so it never passed a
    // CFn validator and may carry control characters or ANSI escapes that would
    // rewrite the surrounding terminal output — or, written by an older binary,
    // a resolved secret. `secretSafeKeyDisplay` answers both in ONE string
    // space: its text deletes a superset of what the logger's sink blanks, so
    // `correct` + U+2028 + `horse` cannot reach the terminal as `correct horse`
    // beside a verdict taken on the unsplit key (issue #4015).
    const name = outputNameRow(change);
    switch (change.changeType) {
      case 'ADD':
        counts.add++;
        logFn(`    [+] ${name}${exported}`);
        logFn(`          new: ${render(change.newValue)}`);
        break;
      case 'MODIFY':
        counts.change++;
        logFn(`    [~] ${name}${exported}`);
        logFn(`          old: ${renderOld(change)}`);
        logFn(`          new: ${render(change.newValue)}`);
        break;
      case 'REMOVE':
        counts.remove++;
        logFn(`    [-] ${name}${exported}`);
        logFn(`          old: ${renderOld(change)}`);
        break;
    }
  }
  return counts;
}

/**
 * The first `limit` names the preview's unreadable-row line prints, in the
 * order the record is read: the `resources` container, the dropped entries,
 * the `orphans` container, the dropped orphan records. (A container and its
 * own rows never occur together: an unreadable container has none.)
 *
 * A container prints its fixed name BARE, from the node's
 * {@link DiffTreeNode.unreadableContainers} field. Everything else is a name the
 * record holds and takes `displayLogicalId`, whose quoting keeps an id padded
 * to look like a healthy sibling — or spelled like a container's name
 * (go-to-k/cdkd#3339) — visibly distinct. An orphan record with no id renders
 * as its `<unrenderable>` stand-in, as the warning beside this names it.
 *
 * Stops at `limit` rather than rendering every row and slicing: a record can
 * hold thousands of dropped rows. The `resources` container needs no check: it
 * can only come first, and `limit` is the preview's fixed cap of ten.
 */
function unreadableRowNames(node: DiffTreeNode, limit: number): string[] {
  const names: string[] = [];
  if (node.unreadableContainers.includes('resources')) {
    names.push(UNREADABLE_CONTAINER_NAMES.resources);
  }
  for (const id of node.unreadable) {
    if (names.length >= limit) break;
    names.push(displayLogicalId(id));
  }
  if (node.unreadableContainers.includes('orphans') && names.length < limit) {
    names.push(UNREADABLE_CONTAINER_NAMES.orphans);
  }
  for (const id of node.unreadableOrphans) {
    if (names.length >= limit) break;
    names.push(displayLogicalId(id ?? ''));
  }
  return names;
}

/**
 * Render a diff tree (root + nested children, DFS) via `logFn`. Only nodes
 * that actually have changes get a block — unchanged nested children are
 * walked silently so the output shows only what the next deploy would do
 * (mirrors `cdk diff`, which lists only changed stacks). The root uses a
 * `Stack <name>:` header; every nested child uses `Nested stack: <name>`
 * (the A4 `state show --show-nested` convention, full `~`-joined name).
 */
export function renderDiffTree(
  node: DiffTreeNode,
  isRoot: boolean,
  logFn: (msg: string) => void
): void {
  // Either condition prints the block. A refusal today always arrives BESIDE a
  // change — (d) fires only for a record the template still declares, which
  // the diff reports as a create — but gating the header on `nodeHasChanges`
  // alone would make that coincidence load-bearing, and a refusal nobody
  // prints is the one outcome this section exists to prevent.
  const hasChanges = nodeHasChanges(node);
  if (hasChanges || node.blocking.length > 0) {
    logFn(
      isRoot
        ? `\nStack ${stripForDisplay(node.stackName)}:`
        : `\nNested stack: ${stripForDisplay(node.displayName)}`
    );
  }
  if (hasChanges) {
    const {
      create,
      update,
      delete: del,
    } = renderChangeLines(
      node.changes,
      logFn,
      node.ccApiRoutes,
      node.adoptedOrphans,
      node.refactorHints
    );
    const outputs = renderOutputChangeLines(node.outputChanges, logFn);
    logFn(`\n${create} to create, ${update} to update, ${del} to delete`);
    // A SECOND summary line rather than extra terms on the first: the resource
    // counts drive what the deploy does to AWS, while an Outputs change is a
    // state / exports-index write with no resource operation behind it. Folding
    // them together would read as "1 to update" for a stack whose resources are
    // untouched. Printed only when there is something to say.
    if (outputs.add + outputs.change + outputs.remove > 0) {
      logFn(
        `${outputs.add} output(s) to add, ${outputs.change} to change, ${outputs.remove} to remove`
      );
    }
    // A THIRD summary line, and the only place an adoption is guaranteed to
    // appear. The per-row annotation rides a CREATE or UPDATE row, and an
    // adopted record that already matches the template produces neither — it
    // is NO_CHANGE, which renders nothing. Measured against real AWS: the
    // fixture's adopted role matched, so the preview named it nowhere.
    //
    // The ids are STATE-CHOSEN (an orphan record's `logicalId`), so they take
    // `displayLogicalId`, as the unreadable-row line below does — not
    // `stripControlChars`, which keeps U+2028 / U+2029 and draws no boundary,
    // so an id spelled `A (AWS::IAM::Role), B` read as two adoptions on the
    // `', '`-joined line (go-to-k/cdkd#3642 review). `--json`'s
    // `adoptedOrphans` keeps the raw keys: a machine payload needs the id
    // itself, and a many-to-one rendering there would be a collision.
    if (node.adoptedOrphans.length > 0) {
      logFn(
        `${node.adoptedOrphans.length} resource(s) to adopt from a previous rollback: ` +
          `${node.adoptedOrphans.map((id) => displayLogicalId(id)).join(', ')}`
      );
    }
    // A FOURTH line, for the rows the diff could not read (go-to-k/cdkd#3018).
    // A dropped row the template still declares IS above, as a create — the
    // diff has no record of it — but one the template no longer declares has
    // no row at all, not even a delete, so this line is the only place the
    // preview names it. Worded for both, since the node cannot tell a reader
    // which dropped id is which without re-reading the template.
    //
    // CAPPED at ten names, like the other lists of this kind (`cdkd export`'s
    // baseline report, the drift warnings): the count leads the line and
    // `--json` keeps every id, so a record with thousands of broken rows cannot
    // print one megabyte-long line. The create clause is for logical ids only:
    // a container is not one, so a node whose only rows are containers gets no
    // such sentence.
    const unreadableTotal = unreadableCount(node);
    if (unreadableTotal > 0) {
      const named = unreadableRowNames(node, UNREADABLE_PREVIEW_NAMES);
      const rest = unreadableTotal - named.length;
      // Decided from the node's FIELDS, not from how a row is spelled
      // (go-to-k/cdkd#3339): an entry keyed `(resources map)` is a logical id,
      // keeps this sentence, and renders quoted above.
      const onlyContainerRows = node.unreadable.length === 0 && node.unreadableOrphans.length === 0;
      logFn(
        `${unreadableTotal} state record row(s) could not be read: ` +
          `${named.join(', ')}${rest > 0 ? ` and ${rest} more` : ''}.` +
          (onlyContainerRows
            ? ''
            : ` One the template still declares is shown above as a create; one it no ` +
              `longer declares is not shown above.`)
      );
    }
  }
  // AFTER the rows and the summaries, for the same reason `cdkd diff` renders
  // at all when a deploy would refuse: the user came here to see what the
  // deploy would do, and the refusal is one more thing it would do rather than
  // a reason to withhold the rest.
  if (node.blocking.length > 0) {
    logFn('\n  Blocking (cdkd deploy will refuse):');
    for (const reason of node.blocking) {
      logFn(`    ! ${stripForDisplay(reason)}`);
    }
  }
  for (const child of node.children) {
    renderDiffTree(child, false, logFn);
  }
}
