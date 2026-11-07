/**
 * The moved `S3StateBackend` method bodies live in `src/state/s3-state-backend/*.ts`
 * (go-to-k/cdkd#5835); the class keeps one `return f.call(this, ...)` delegator
 * per moved method, and each argument a delegator hands on is a hand-off the
 * split introduced.
 *
 * Every companion function is a pass-through spy on the real one. Each case
 * stubs its spy once and pins that the delegator calls its own function with
 * the backend as `this`, every argument in declared order, and returns that
 * function's result. The real bodies run end to end in the rest of
 * `tests/unit/state/s3-state-backend*.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { S3Client } from '@aws-sdk/client-s3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// The compiler API lives under `typescript-v6`, as in the other source-reading fences.
import ts from 'typescript-v6';

/** Replace every function a module exports with a pass-through spy. */
async function spied(path: string): Promise<Record<string, unknown>> {
  const actual = await vi.importActual<Record<string, unknown>>(path);
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [
      k,
      typeof v === 'function' ? vi.fn(v as (...a: unknown[]) => unknown) : v,
    ])
  );
}

vi.mock('../../../src/state/s3-state-backend/client.js', () =>
  spied('../../../src/state/s3-state-backend/client.js')
);
vi.mock('../../../src/state/s3-state-backend/state-record.js', () =>
  spied('../../../src/state/s3-state-backend/state-record.js')
);
vi.mock('../../../src/state/s3-state-backend/listing.js', () =>
  spied('../../../src/state/s3-state-backend/listing.js')
);
vi.mock('../../../src/state/s3-state-backend/markers.js', () =>
  spied('../../../src/state/s3-state-backend/markers.js')
);
vi.mock('../../../src/state/s3-state-backend/sidecars.js', () =>
  spied('../../../src/state/s3-state-backend/sidecars.js')
);
vi.mock('../../../src/state/s3-state-backend/rollback-journal.js', () =>
  spied('../../../src/state/s3-state-backend/rollback-journal.js')
);
vi.mock('../../../src/state/s3-state-backend/legacy.js', () =>
  spied('../../../src/state/s3-state-backend/legacy.js')
);

import * as entry from '../../../src/state/s3-state-backend.js';
import { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import * as shared from '../../../src/state/s3-state-backend/shared.js';
import * as client from '../../../src/state/s3-state-backend/client.js';
import * as stateRecord from '../../../src/state/s3-state-backend/state-record.js';
import * as listing from '../../../src/state/s3-state-backend/listing.js';
import * as markers from '../../../src/state/s3-state-backend/markers.js';
import * as sidecars from '../../../src/state/s3-state-backend/sidecars.js';
import * as rollbackJournal from '../../../src/state/s3-state-backend/rollback-journal.js';
import * as legacy from '../../../src/state/s3-state-backend/legacy.js';

const MODULES: Record<string, Record<string, unknown>> = {
  client,
  'state-record': stateRecord,
  listing,
  markers,
  sidecars,
  'rollback-journal': rollbackJournal,
  legacy,
};

/** [class method, companion module, declared parameter count]; the function shares the method's name. */
const DELEGATORS: ReadonlyArray<readonly [string, string, number]> = [
  ['clientForScan', 'client', 0],
  ['warmConnections', 'client', 3],
  ['ensureClientForBucket', 'client', 0],
  ['headObject', 'client', 1],
  ['verifyBucketExists', 'state-record', 1],
  ['stateExists', 'state-record', 2],
  ['stateExistsOwnedBy', 'state-record', 3],
  ['rawObjectExists', 'state-record', 1],
  ['getState', 'state-record', 2],
  ['saveState', 'state-record', 4],
  ['deleteState', 'state-record', 2],
  ['purgeDeletedStateHistory', 'state-record', 2],
  ['otherRegionHistoryState', 'state-record', 3],
  ['deleteLegacyState', 'state-record', 1],
  ['listStacks', 'listing', 0],
  ['listTopLevelPrefixes', 'listing', 0],
  ['putRawObject', 'listing', 3],
  ['earlierStateResources', 'listing', 3],
  ['lockUnderPrefix', 'listing', 3],
  ['getRawObject', 'listing', 1],
  ['listRawKeys', 'listing', 1],
  ['listRawObjects', 'listing', 1],
  ['deleteRawObjects', 'listing', 1],
  ['purgeNoncurrentVersions', 'listing', 2],
  ['loadRetainedResources', 'markers', 2],
  ['loadRetainedRecord', 'markers', 2],
  ['ensureRetainedTombstone', 'markers', 2],
  ['saveRetainedResources', 'markers', 3],
  ['getRefactorMarker', 'markers', 0],
  ['saveRefactorMarker', 'markers', 2],
  ['getRegistryMarker', 'markers', 2],
  ['claimRegistryMarker', 'markers', 3],
  ['releaseRegistryMarker', 'markers', 3],
  ['loadCreateTokenLedger', 'sidecars', 2],
  ['saveCreateTokenLedger', 'sidecars', 3],
  ['rotateCreateTokenNonce', 'sidecars', 3],
  ['deleteCreateTokenLedger', 'sidecars', 2],
  ['stackInstanceIdForFirstWrite', 'sidecars', 3],
  ['stackInstanceSiblingError', 'sidecars', 4],
  ['prefetchStackInstanceSibling', 'sidecars', 2],
  ['readSiblingId', 'sidecars', 3],
  ['readStackInstanceSibling', 'sidecars', 2],
  ['deleteStackInstanceSibling', 'sidecars', 2],
  ['dropStackInstanceSiblingAfterSave', 'sidecars', 2],
  ['loadRollbackJournal', 'rollback-journal', 2],
  ['appendRollbackJournalSegment', 'rollback-journal', 3],
  ['setRollbackJournalFailedOperations', 'rollback-journal', 3],
  ['dropRollbackJournalFailedOperations', 'rollback-journal', 3],
  ['rewriteRollbackJournalFailedOperations', 'rollback-journal', 3],
  ['reduceRollbackJournalToFailedOperations', 'rollback-journal', 5],
  ['popRollbackJournalSegment', 'rollback-journal', 2],
  ['markRollbackJournalSuperseded', 'rollback-journal', 3],
  ['markRollbackJournalImported', 'rollback-journal', 3],
  ['dropRollbackJournalSegments', 'rollback-journal', 3],
  ['deleteRollbackJournal', 'rollback-journal', 2],
  ['adoptKeyRegion', 'legacy', 4],
  ['probeLegacyState', 'legacy', 1],
  ['readLegacyRegion', 'legacy', 1],
  ['legacyBelongsToRegion', 'legacy', 2],
  ['tryGetLegacy', 'legacy', 2],
  ['parseStateBody', 'legacy', 2],
];

/** Methods whose bodies stay on the class. */
const KEPT_ON_CLASS = new Set([
  'constructor',
  'destroyClient',
  'prefix',
  'getStateKey',
  'getLegacyStateKey',
  'getRollbackJournalKey',
  'rollbackJournalKey',
  'rollbackJournalReadAbsent',
  'purgeRollbackJournalVersions',
  'getStackInstanceKey',
  'getCreateTokenLedgerKey',
  'ownerParam',
  'recordUnderPrefix',
  'getRetainedKey',
  'refactorMarkerKey',
  'registryMarkerKey',
  'purgeNoncurrentVersionsUnderPrefix',
  'wrapS3Failure',
  'displayName',
  'stackRef',
]);

type Callable = (...args: unknown[]) => unknown;
type Spy = ReturnType<typeof vi.fn>;

const backend = (): S3StateBackend =>
  new S3StateBackend({} as S3Client, { bucket: 'b', prefix: 'cdkd' });

describe('S3StateBackend delegators hand every argument and the result on', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('the table names every method the class delegates', () => {
    const methods = Object.getOwnPropertyNames(S3StateBackend.prototype).filter(
      (m) => !KEPT_ON_CLASS.has(m)
    );
    expect(methods.sort()).toEqual(DELEGATORS.map(([m]) => m).sort());
  });

  it('each arity in the table is the delegator signature parameter count', () => {
    // Read off the class source, so a parameter added to a delegator without
    // a table update reddens here instead of leaving its hand-off unchecked.
    const file = join(process.cwd(), 'src/state/s3-state-backend.ts');
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const declared = new Map<string, number>();
    source.forEachChild(function visit(node: ts.Node): void {
      if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) {
        declared.set(node.name.text, node.parameters.length);
      }
      node.forEachChild(visit);
    });
    for (const [method, , arity] of DELEGATORS) expect(declared.get(method), method).toBe(arity);
  });

  for (const [method, mod, arity] of DELEGATORS) {
    it(`${method} calls ${mod}.${method} with this, ${arity} argument(s) in order, and returns its result`, () => {
      const spy = MODULES[mod]![method] as Spy;
      expect(vi.isMockFunction(spy), `${mod}.${method} is not spied`).toBe(true);
      const result = { result: method };
      spy.mockImplementationOnce(() => result);
      const b = backend();
      const args = Array.from({ length: arity }, (_, i) => ({ arg: i }));
      const returned = (b as unknown as Record<string, Callable>)[method]!(...args);
      expect(returned).toBe(result);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]).toEqual(args);
      spy.mock.calls[0]!.forEach((a, i) => expect(a).toBe(args[i]));
      expect(spy.mock.contexts[0]).toBe(b);
    });
  }

  it('the delegators with a default hand on that default', () => {
    const cases: ReadonlyArray<readonly [Spy, () => unknown, unknown[]]> = [
      [
        stateRecord.verifyBucketExists as unknown as Spy,
        () => backend().verifyBucketExists(),
        [{}],
      ],
      [
        stateRecord.saveState as unknown as Spy,
        () => backend().saveState('S', 'us-east-1', {} as never),
        ['S', 'us-east-1', {}, {}],
      ],
      [
        listing.putRawObject as unknown as Spy,
        () => backend().putRawObject('k', 'body'),
        ['k', 'body', 'application/json'],
      ],
      [
        listing.earlierStateResources as unknown as Spy,
        () => backend().earlierStateResources('S', 'us-east-1'),
        ['S', 'us-east-1', 10],
      ],
      [
        listing.purgeNoncurrentVersions as unknown as Spy,
        () => backend().purgeNoncurrentVersions(['k']),
        [['k'], {}],
      ],
    ];
    for (const [spy, call, expected] of cases) {
      spy.mockImplementationOnce(() => undefined);
      void call();
      expect(spy.mock.calls.at(-1)).toEqual(expected);
    }
  });
});

describe('s3-state-backend.ts re-exports what it always exported', () => {
  it('LEGACY_KEY_DEPTH, REGISTRY_ROOT, parseRetainedResources and registryMarkerPrefix are the companion values', () => {
    expect(entry.LEGACY_KEY_DEPTH).toBe(shared.LEGACY_KEY_DEPTH);
    expect(entry.LEGACY_KEY_DEPTH).toBe(2);
    expect(entry.REGISTRY_ROOT).toBe(shared.REGISTRY_ROOT);
    expect(entry.REGISTRY_ROOT).toBe('_cdkd-registry');
    expect(entry.parseRetainedResources).toBe(shared.parseRetainedResources);
    expect(entry.registryMarkerPrefix).toBe(shared.registryMarkerPrefix);
  });

  it('exports exactly the runtime names it did before the split', () => {
    expect(Object.keys(entry).sort()).toEqual(
      [
        'LEGACY_KEY_DEPTH',
        'REGISTRY_ROOT',
        'S3StateBackend',
        'parseRetainedResources',
        'registryMarkerPrefix',
      ].sort()
    );
  });
});
