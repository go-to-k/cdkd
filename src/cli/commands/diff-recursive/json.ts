import type { MovedTo } from '../../../analyzer/refactor-hints.js';
import type { ResourceChange } from '../../../types/state.js';
import type { OutputChange } from '../../../analyzer/outputs-diff.js';
import {
  WITHHELD_NAME_DISPLAY,
  displayTextOrWithheld,
  secretSafeKeyDisplay,
  type SecretSafeKeyDisplay,
} from '../../../deployment/outputs-export-alias.js';
import type { DestructiveImpact } from '../../../analyzer/destructive-changes.js';
import type { DiffTreeNode, UnreadableContainer } from './types.js';

/** Serializable per-resource change record for `--json`. */
export interface DiffChangeJson {
  logicalId: string;
  changeType: ResourceChange['changeType'];
  resourceType: string;
  propertyChanges?: ResourceChange['propertyChanges'];
  attributeChanges?: ResourceChange['attributeChanges'];
  /** go-to-k/cdkd#6282: a nested stack updated so its child re-spells an SSM parameter name. */
  nestedChildHeal?: true;
  /**
   * SDK-unwired property names that #614's auto-fallback would route via
   * Cloud Control API for this resource. Present only when the resource is
   * a CC-routed auto-route hit (matches the human renderer's
   * `[via CC API: <prop list>]` annotation), so never on a type with no Cloud
   * Control route (issue #5600).
   */
  ccApi?: string[];
  /** A DELETE a `cdkd refactor` would keep: where the resource reappears (go-to-k/cdkd#5203). */
  movedTo?: MovedTo;
}

/** Serializable Outputs change record for `--json` (issue #1921). */
export interface DiffOutputChangeJson {
  name: string;
  changeType: OutputChange['changeType'];
  oldValue?: unknown;
  newValue?: unknown;
  /**
   * Present and true when `oldValue` was WITHHELD because state holds legacy
   * secret plaintext for this key (run `cdkd scrub`). The change is still
   * reported; only the value is omitted.
   */
  oldValueRedacted?: boolean;
  /** True for an `Export.Name` key — the ones a consumer's `Fn::ImportValue` reads. */
  export: boolean;
  /**
   * Present and true when `name` is NOT the stored key but its masked form or
   * a placeholder, because the key holds a secret (issue #4015). The change is
   * still reported.
   */
  nameRedacted?: boolean;
}

/** How a stored Outputs key is shown: {@link OutputChange.nameDisplay}, or a no-corpus verdict. */
function outputNameDisplay(change: OutputChange): SecretSafeKeyDisplay {
  return change.nameDisplay ?? secretSafeKeyDisplay(change.name, new Map());
}

/** The `--json` `name` / `nameRedacted` pair for one Outputs change (issue #4015). */
function outputNameJson(change: OutputChange): { name: string; nameRedacted?: true } {
  const display = outputNameDisplay(change);
  if (display.kind === 'safe') return { name: change.name };
  return { name: displayTextOrWithheld(display), nameRedacted: true };
}

/**
 * The row name for one Outputs change on the HUMAN path (issue #4015): the
 * verdict's own text, never a separately sanitised copy of the key.
 *
 * A MASKED name carrying anything outside printable ASCII is withheld rather
 * than printed, the rule `outputs-export-alias/warnings.ts`'s `maskedLabel` applies. No
 * sink on this path reshapes such a character today (`terminalSafe` does not);
 * it is the defensive fallback issue #4015 asked for beside the corpus, so a
 * future sink that blanks one cannot make the printed text differ from the
 * tested one.
 */
export function outputNameRow(change: OutputChange): string {
  const display = outputNameDisplay(change);
  switch (display.kind) {
    case 'safe':
      return display.text;
    case 'masked':
      return /[^ -~]/.test(display.text)
        ? WITHHELD_NAME_DISPLAY
        : `${display.text} (name masked: it contains a secret)`;
    case 'withheld':
      return WITHHELD_NAME_DISPLAY;
  }
}

/** Serializable diff-tree node for `--json` (nested when `--recursive`). */
export interface DiffNodeJson {
  stack: string;
  region: string;
  changes: DiffChangeJson[];
  /**
   * Outputs delta (issue #1921). Always present — empty array when unchanged —
   * for the same key-set stability reason as `children`.
   */
  outputChanges: DiffOutputChangeJson[];
  /**
   * Logical ids adopted from a rollback-orphan record (issue
   * go-to-k/cdkd#2943). Always present — empty array when none — for the same
   * key-set stability reason as `children`.
   */
  adoptedOrphans: string[];
  /**
   * Reasons `cdkd deploy` would refuse. Always present; non-empty means the
   * run this payload describes would not start. Consumers gating on the diff
   * must read this, not just `changes`.
   */
  blocking: string[];
  /**
   * Logical ids of the `resources` entries the diff could not read
   * (go-to-k/cdkd#3018). Always present, like the two fields below; any of the
   * three non-empty means `changes` is NOT the whole picture — a record the
   * template no longer declares has no DELETE row here.
   */
  unreadable: string[];
  /**
   * The containers the diff could not read at all and read as empty
   * (go-to-k/cdkd#3339): `'resources'` (the whole resource inventory is
   * missing from what was diffed) and `'orphans'`. A field of its own, so no
   * key an entry can hold reads as one.
   */
  unreadableContainers: UnreadableContainer[];
  /**
   * The rollback-orphan records the adoption preview could not read, by
   * `logicalId` — `null` for one with no string `logicalId`, which no key can
   * spell (go-to-k/cdkd#3339).
   */
  unreadableOrphans: Array<string | null>;
  /**
   * The resources this node's changes replace, delete or orphan — what
   * `--fail-on=destructive` fails on. Always present, empty when none.
   */
  destructiveChanges: DestructiveChangeJson[];
  children: DiffNodeJson[];
}

/** Serializable destructive change for `--json`; the node's `stack` names its stack. */
export interface DestructiveChangeJson {
  logicalId: string;
  resourceType: string;
  constructPath?: string;
  impact: DestructiveImpact;
  movedTo?: MovedTo;
}

/**
 * Project a {@link DiffTreeNode} into the `--json` shape. `NO_CHANGE`
 * entries are dropped so machine consumers see only actionable changes;
 * `children` is always present (empty array on leaves / non-recursive) so
 * the key set is stable.
 */
export function diffTreeToJson(node: DiffTreeNode): DiffNodeJson {
  const changes: DiffChangeJson[] = [];
  for (const change of node.changes.values()) {
    if (change.changeType === 'NO_CHANGE') continue;
    const ccApi = node.ccApiRoutes.get(change.logicalId);
    const movedTo =
      change.changeType === 'DELETE' ? node.refactorHints?.get(change.logicalId) : undefined;
    changes.push({
      logicalId: change.logicalId,
      changeType: change.changeType,
      resourceType: change.resourceType,
      ...(change.propertyChanges && change.propertyChanges.length > 0
        ? { propertyChanges: change.propertyChanges }
        : {}),
      ...(change.attributeChanges && change.attributeChanges.length > 0
        ? { attributeChanges: change.attributeChanges }
        : {}),
      ...(change.nestedChildHeal === true && { nestedChildHeal: true as const }),
      ...(ccApi && ccApi.length > 0 ? { ccApi } : {}),
      ...(movedTo !== undefined && { movedTo }),
    });
  }
  return {
    stack: node.stackName,
    region: node.region,
    changes,
    outputChanges: node.outputChanges.map((change) => ({
      // The RAW key when its verdict is safe -- this payload is a machine
      // interface and a consumer matches on the exact key -- and the verdict's
      // own text otherwise, flagged, for the reason `oldValue` is withheld
      // below: this is the payload CI tooling captures (issue #4015).
      ...outputNameJson(change),
      changeType: change.changeType,
      // `oldValue` / `newValue` are omitted rather than set to `undefined` so
      // `JSON.stringify` does not have to drop them: an ADD has no old side and
      // a REMOVE has no new side, and a key present-but-null would read as a
      // real null value.
      // A withheld legacy-plaintext value is withheld from `--json` too — that
      // payload is the one most likely to be captured by CI tooling.
      ...(change.changeType !== 'ADD' && !change.oldValueRedacted
        ? { oldValue: change.oldValue }
        : {}),
      ...(change.oldValueRedacted ? { oldValueRedacted: true } : {}),
      ...(change.changeType !== 'REMOVE' ? { newValue: change.newValue } : {}),
      export: change.isExport,
    })),
    adoptedOrphans: node.adoptedOrphans,
    blocking: node.blocking,
    unreadable: node.unreadable,
    unreadableContainers: node.unreadableContainers,
    unreadableOrphans: node.unreadableOrphans,
    destructiveChanges: node.destructiveChanges.map(
      ({ logicalId, resourceType, constructPath, impact, movedTo }) => ({
        logicalId,
        resourceType,
        ...(constructPath !== undefined && { constructPath }),
        impact,
        ...(movedTo !== undefined && { movedTo }),
      })
    ),
    children: node.children.map(diffTreeToJson),
  };
}
