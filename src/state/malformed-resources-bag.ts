/**
 * Every guard over a state container a hand edit or a truncation can leave
 * unreadable. The implementation lives in `./malformed-resources-bag/*.ts`;
 * this module re-exports every name it exported before the split, so no
 * importer changes.
 */
import { isReadableBag } from '../types/state.js';

/**
 * The plain-object test itself, without the `resources` field bound to it.
 *
 * RE-EXPORTED, not defined here any more: it MOVED to `src/types/state.ts` with
 * go-to-k/cdkd#3192, whose own doc carries the full rationale and the reason for
 * the move (`importableOutputKeys` needs the predicate, and it sits in the layer
 * this module imports FROM). Every importer of this module is unchanged — the
 * same shape, and the same reason, as `DEFAULT_STATE_PREFIX` moving into
 * `src/state/state-prefix.ts`.
 *
 * Enumerate the consumers with `grep -rn "isReadableBag" src/` rather than from
 * a list here; four successive enumerations of them, written by reasoning, came
 * out incomplete.
 */
export { isReadableBag };

// The record / coordinate key helpers moved to the import-free leaf
// `src/state/record-keys.ts` (go-to-k/cdkd#3323): their consumers span the
// cli, state and deployment layers, and `state-list-tree.ts` is deliberately
// kept with no imports at all. RE-EXPORTED here so no existing importer moved.
export { producerRecordKey, producerCoordinateKey } from './record-keys.js';
export {
  UNREADABLE_RESOURCES_MAP_ROW,
  STATE_RESOURCES_MALFORMED,
  hasReadableResources,
  hasReadableOutputs,
  SHORT_NAME_MAX_CODE_POINTS,
  safeStackName,
  safeRegion,
  displayLogicalId,
} from './malformed-resources-bag/core.js';
export {
  JSON_LISTING_HOLE_VALUE,
  accountArgs,
  withheldAccountClause,
} from './malformed-resources-bag/account-args.js';
export {
  repairMalformedResourcesForReadOnly,
  malformedStateRefusalMessage,
  malformedDestroyResourcesRefusalMessage,
  refuseMalformedResourcesForDestroy,
  malformedDeployResourcesRefusalMessage,
  refuseMalformedResourcesForDeploy,
  malformedExportResourcesRefusalMessage,
  refuseMalformedResourcesForExport,
  malformedRenderedContainersWarning,
  malformedResourcesWarning,
  refuseMalformedState,
} from './malformed-resources-bag/resources.js';
export type { RenderedStateContainer } from './malformed-resources-bag/resources.js';
export {
  STATE_REGION_DIVERGED,
  divergentRecordRegionRefusalMessage,
  refuseDivergentRecordRegionForDestroy,
} from './malformed-resources-bag/divergent-region.js';
export {
  repairMalformedOutputsForReadOnly,
  malformedOutputsWarning,
  malformedOutputsRefusalMessage,
  malformedExportSourceWarning,
  malformedExportNamesWarning,
  refuseMalformedOutputs,
  malformedDestroyOutputsRefusalMessage,
  refuseMalformedOutputsForDestroy,
  malformedNestedChildOutputsRefusalMessage,
  refuseMalformedNestedChildOutputs,
  malformedLocalOutputsWarning,
} from './malformed-resources-bag/outputs.js';
export {
  UNREADABLE_ORPHANS_CONTAINER_ROW,
  hasReadableOrphans,
  repairMalformedOrphansForReadOnly,
  malformedOrphansWarning,
  malformedOrphansRefusalMessage,
  malformedDestroyOrphansRefusalMessage,
  refuseMalformedOrphansForDestroy,
  refuseMalformedOrphans,
} from './malformed-resources-bag/orphans-container.js';
export {
  unreadableResourcePropertyBags,
  refuseMalformedResourceProperties,
  repairMalformedResourcePropertiesForReadOnly,
  malformedResourcePropertiesRefusalMessage,
  malformedOrphanResourcePropertiesRefusalMessage,
  refuseMalformedResourcePropertiesForOrphan,
  malformedResourcePropertiesWarning,
  malformedDriftResourcePropertiesRefusalMessage,
  refuseMalformedResourcePropertiesForDrift,
  malformedDriftResourcePropertiesWarning,
  malformedExportResourcePropertiesRefusalMessage,
  refuseMalformedResourcePropertiesForExport,
  refuseMalformedResourcePropertiesForDestroy,
  malformedDestroyResourcePropertiesRefusalMessage,
} from './malformed-resources-bag/properties.js';
export {
  unreadableResourceEntries,
  isReadableResourceEntry,
  refuseMalformedResourceEntries,
  repairMalformedResourceEntriesForReadOnly,
  malformedResourceEntriesWarning,
  malformedResourceEntriesRefusalMessage,
  refuseMalformedResourceEntriesForDeploy,
  malformedDeployResourceEntriesRefusalMessage,
  refuseMalformedResourceEntriesForDestroy,
  malformedDestroyResourceEntriesRefusalMessage,
  refuseMalformedResourceEntriesForImport,
  refuseMalformedResourceEntriesForImportSave,
  malformedImportUnrepairedEntriesRefusalMessage,
  malformedScrubResourceEntriesRefusalMessage,
  malformedLocalResourcesWarning,
  malformedLocalResourceEntriesWarning,
  refuseMalformedResourceEntriesForOrphan,
  malformedOrphanResourceEntriesRefusalMessage,
  unreadableResourceAttributeBags,
  refuseMalformedResourceAttributesForOrphan,
  malformedOrphanResourceAttributesRefusalMessage,
} from './malformed-resources-bag/entries.js';
export {
  malformedOrphanRecordsWarning,
  isPreviewableOrphanRecord,
  hasAddressablePhysicalId,
  unaddressableUpdateRefusalMessage,
  unpreviewableOrphanRecords,
  previewableOrphanRecords,
  isReadableOrphanRecord,
  unreadableOrphanRecords,
  refuseMalformedOrphanRecords,
  refuseMalformedOrphanRecordsForDestroy,
  malformedOrphanRecordsRefusalMessage,
  malformedOrphanRecordsForDestroyRefusalMessage,
  repairMalformedOrphanRecordsForReadOnly,
  refuseMalformedOrphansForOrphan,
  deployRefusesOrphanRowsReason,
  malformedOrphanRowsKeptWarning,
  malformedOrphansForOrphanRefusalMessage,
} from './malformed-resources-bag/orphan-records.js';
