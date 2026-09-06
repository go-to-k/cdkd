/**
 * Unit tests for the #615 stateful-resource guard list + the
 * conditional-stateful predicate that distinguishes empty / no-retention
 * resources from data-bearing ones.
 */

import { describe, it, expect } from 'vite-plus/test';
import {
  STATEFUL_TYPES,
  isStatefulRecreateTargetSync,
  isStatefulRecreateTargetForReplace,
  renderStatefulReason,
} from '../../../src/provisioning/stateful-types.js';
import * as finalSnapshot from '../../../src/provisioning/final-snapshot.js';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * The PUBLISHED type tables in `docs/cli-deploy-safety.md`, parsed once and
 * shared by the two fences that anchor on them. Hoisted deliberately: the
 * reason-kind fence below must be anchored on something OTHER than the
 * predicate it is checking, or it is vacuous — deriving the expected set from
 * `isStatefulRecreateTargetSync` and then asserting it with the same function
 * proves nothing. The doc is the independent anchor, and the doc/code equality
 * fence is what keeps the anchor honest.
 */
const doc = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'docs', 'cli-deploy-safety.md'),
  'utf8'
);

/**
 * TABLE ROWS between two headings, not the whole section. Scanning a section's
 * prose too made an earlier version of this fence one-directional by accident:
 * the paragraphs around the tables also name several of the types, so DELETING
 * one from a table row still found it in the prose and the equality held.
 * Measured — a probe removing `AWS::S3Vectors::VectorBucket` from its row
 * passed.
 *
 * Deliberately NO assertion in here: this runs at COLLECTION time, where a
 * failure aborts the file instead of naming a test. The indices are returned
 * and asserted in the floors case.
 */
function tableRowsBetween(
  startHeading: string,
  endHeading: string
): { start: number; end: number; rows: string[] } {
  const start = doc.indexOf(startHeading);
  const end = doc.indexOf(endHeading);
  const rows =
    start >= 0 && end > start
      ? doc
          .slice(start, end)
          .split('\n')
          .filter((line) => line.startsWith('| ') && !line.startsWith('| ---'))
      : [];
  return { start, end, rows };
}

function typesIn(rows: string[]): string[] {
  return [
    ...new Set(
      [...rows.join('\n').matchAll(/`(AWS::[A-Za-z0-9]+::[A-Za-z0-9]+)`/g)].map((m) => m[1])
    ),
  ].sort();
}

const alwaysTable = tableRowsBetween(
  '### Always-stateful types',
  '### Conditionally stateful types'
);
const conditionalTable = tableRowsBetween(
  '### Conditionally stateful types',
  '### How the conditional types are judged'
);

describe('STATEFUL_TYPES (#615)', () => {
  it('includes the data-bearing primary types from the design doc', () => {
    // Spot-check the categories — full list is hand-curated in the
    // source. We just confirm a representative from each category
    // (DB / filesystem / streaming / search / identity / metadata /
    // logs / edge) is present so a future PR that accidentally drops
    // one will fail this test.
    expect(STATEFUL_TYPES.has('AWS::RDS::DBInstance')).toBe(true);
    expect(STATEFUL_TYPES.has('AWS::DynamoDB::Table')).toBe(true);
    expect(STATEFUL_TYPES.has('AWS::EFS::FileSystem')).toBe(true);
    expect(STATEFUL_TYPES.has('AWS::S3::Bucket')).toBe(true);
    expect(STATEFUL_TYPES.has('AWS::ECR::Repository')).toBe(true);
    expect(STATEFUL_TYPES.has('AWS::Kinesis::Stream')).toBe(true);
    // Note canonical CFn casing: 'Elasticsearch' (lowercase 's') —
    // matches `cloudformation:DescribeType AWS::Elasticsearch::Domain`.
    // A camelcased typo `AWS::ElasticSearch::Domain` would silently
    // bypass the guard, so this assertion is load-bearing.
    expect(STATEFUL_TYPES.has('AWS::Elasticsearch::Domain')).toBe(true);
    expect(STATEFUL_TYPES.has('AWS::ElasticSearch::Domain')).toBe(false);
    expect(STATEFUL_TYPES.has('AWS::OpenSearchService::Domain')).toBe(true);
    expect(STATEFUL_TYPES.has('AWS::Cognito::UserPool')).toBe(true);
    expect(STATEFUL_TYPES.has('AWS::SecretsManager::Secret')).toBe(true);
    expect(STATEFUL_TYPES.has('AWS::SSM::Parameter')).toBe(true);
    expect(STATEFUL_TYPES.has('AWS::Glue::Database')).toBe(true);
    expect(STATEFUL_TYPES.has('AWS::Logs::LogGroup')).toBe(true);
    expect(STATEFUL_TYPES.has('AWS::CloudFront::Distribution')).toBe(true);
  });

  it('excludes ephemeral types where destroy+recreate loses no user data', () => {
    expect(STATEFUL_TYPES.has('AWS::Lambda::Function')).toBe(false);
    expect(STATEFUL_TYPES.has('AWS::IAM::Role')).toBe(false);
    expect(STATEFUL_TYPES.has('AWS::IAM::Policy')).toBe(false);
    expect(STATEFUL_TYPES.has('AWS::SQS::Queue')).toBe(false);
    expect(STATEFUL_TYPES.has('AWS::SNS::Topic')).toBe(false);
    // EC2::Instance not on the list — boot disk is ephemeral by default and
    // the user is responsible for EBS / snapshot lifecycle if they want
    // persistence. Could be argued either way; current design says "no."
    expect(STATEFUL_TYPES.has('AWS::EC2::Instance')).toBe(false);
  });

  describe('every final-snapshot-capable type is on the guard list (issue #2514 review)', () => {
    // The two lists in `final-snapshot.ts` are the CloudFormation-documented
    // `DeletionPolicy: Snapshot`-capable set, split by mechanism. CFn permits
    // that attribute exactly where deleting the resource destroys data worth
    // capturing first, so membership there is an AWS-authored statement that
    // the type is data-bearing — which makes it a LOWER BOUND on the guard
    // list, not a coincidence.
    //
    // The types this fence first found unguarded — `AWS::Redshift::Cluster`,
    // `AWS::ElastiCache::ReplicationGroup`, `AWS::ElastiCache::CacheCluster` —
    // were being snapshotted before a `cdkd destroy` while being replaced
    // mid-deploy with no consent flag at all.
    //
    // Derived from `final-snapshot.ts`'s EXPORTS rather than from two named
    // imports. Naming the two sets meant a THIRD snapshot mechanism — a new
    // `*_SNAPSHOT_TYPES` set beside them — would be invisible here, and its
    // types would sit outside the lower bound while the fence went on passing.
    // Scope of the fix, stated so the next reader does not over-trust it: this
    // sees a new set IN THIS MODULE, under this naming convention. A mechanism
    // list that moves to a different module is still invisible, and no fence
    // over one module's exports can be otherwise.
    const mechanismSetNames = Object.keys(finalSnapshot)
      .filter((name) => name.endsWith('_SNAPSHOT_TYPES'))
      .sort();
    // NOT filtered by `instanceof Set`. Filtering would make a mechanism list
    // declared as an ARRAY (or a Map) vanish from the lower bound silently —
    // the same fail-open as naming the two sets, wearing a derivation's
    // clothes. Non-Set exports are collected and asserted EMPTY below, so the
    // shape change reds instead of shrinking the bound.
    const nonSetMechanisms = mechanismSetNames.filter(
      (name) => !((finalSnapshot as Record<string, unknown>)[name] instanceof Set)
    );
    const snapshotCapable = [
      ...new Set(
        mechanismSetNames
          .filter((name) => (finalSnapshot as Record<string, unknown>)[name] instanceof Set)
          .flatMap((name) => [
            ...(finalSnapshot as unknown as Record<string, ReadonlySet<string>>)[name]!,
          ])
      ),
    ].sort();

    it('has a non-empty set to check (floor — an emptied snapshot list must not pass vacuously)', () => {
      // A FLOOR, not a cap: a genuinely new snapshot-capable type should red in
      // the per-type loop below (with a message naming it), not here with a
      // count mismatch that says nothing about which type is unguarded.
      expect(snapshotCapable.length).toBeGreaterThanOrEqual(8);
      // Guard-the-guard for the export-derived discovery: the two mechanisms
      // that exist today must still be FOUND by it, so a rename that slips out
      // of the `*_SNAPSHOT_TYPES` convention reds here instead of quietly
      // shrinking the lower bound to whatever is left.
      expect(mechanismSetNames).toContain('ATOMIC_FINAL_SNAPSHOT_TYPES');
      expect(mechanismSetNames).toContain('PRE_DELETE_SNAPSHOT_TYPES');
      // And every one of them must actually be a Set — see `nonSetMechanisms`.
      expect(nonSetMechanisms).toEqual([]);
    });

    for (const resourceType of snapshotCapable) {
      it(`${resourceType} is in STATEFUL_TYPES`, () => {
        expect(STATEFUL_TYPES.has(resourceType)).toBe(true);
      });
    }

    it('the types this fence added are `always`, not conditional', () => {
      // Their verdict must not depend on the recorded bag — no probe runs on
      // any mid-deploy path, and none of them has a cheap emptiness signal the
      // way S3 and LogGroup do.
      for (const resourceType of [
        'AWS::Redshift::Cluster',
        'AWS::ElastiCache::CacheCluster',
        'AWS::ElastiCache::ReplicationGroup',
      ]) {
        expect(isStatefulRecreateTargetSync(resourceType, {}, undefined)).toBe('always');
        expect(isStatefulRecreateTargetSync(resourceType, undefined, undefined)).toBe('always');
        expect(isStatefulRecreateTargetForReplace(resourceType, {}, undefined)).toBe('always');
      }
    });

    it('does NOT hold in reverse — the guard list is a strict superset', () => {
      // Stating the direction, so nobody "fixes" the asymmetry by pruning the
      // guard. Most data-bearing types have no snapshot API at all and CFn
      // rejects `DeletionPolicy: Snapshot` on them.
      const snapshotSet = new Set(snapshotCapable);
      const guardOnly = [...STATEFUL_TYPES].filter((t) => !snapshotSet.has(t));
      expect(guardOnly).toContain('AWS::S3::Bucket');
      expect(guardOnly).toContain('AWS::DynamoDB::Table');
    });
  });

  describe('the published type tables in docs/cli-deploy-safety.md', () => {
    // The guard list is a USER-FACING contract: the doc enumerates every type
    // by name, and a reader plans around it. Nothing connected the two, so an
    // addition here could ship with the doc still promising the old list — the
    // same drift class the message doc-sync fence closes for the refusal text.
    //
    // Asserted PER TABLE, not over both at once. A single set-equality spanning
    // the always-stateful and conditionally-stateful tables watches MEMBERSHIP
    // only: moving `AWS::Redshift::Cluster` from one table to the other keeps
    // the union identical and the fence green, while the doc now tells a reader
    // the guard fires only when the cluster holds data. The split each table
    // must match is derived from the PREDICATE rather than hand-listed, so a
    // type whose conditionality changes in code has to move rows.
    //
    // Both directions red in each table: a type added to the code and not the
    // doc, and a type the doc claims that the guard does not actually cover —
    // the second being the one that misleads a user into thinking they are
    // protected.
    //
    // Known residual: a row's explanatory CELL is scanned too, so a type named
    // in prose inside a row satisfies the fence without being listed as one of
    // that row's types. Consequence for doc authors: a type mentioned in a cell
    // must be one this file actually guards, and any other type belongs in the
    // prose ABOVE the tables (which is where `AWS::KMS::Alias`, deliberately
    // NOT guarded, is discussed).
    //
    // The code-side split, read from the predicate the deploy engine calls.
    // An empty recorded bag is the discriminator: an unconditional type answers
    // `always` from it, a conditional one defers (S3) or reads a property that
    // is absent (LogGroup).
    const codeAlways = [...STATEFUL_TYPES]
      .filter((t) => isStatefulRecreateTargetSync(t, {}, undefined) === 'always')
      .sort();
    const codeConditional = [...STATEFUL_TYPES]
      .filter((t) => isStatefulRecreateTargetSync(t, {}, undefined) !== 'always')
      .sort();
    const alwaysRows = alwaysTable.rows;
    const conditionalRows = conditionalTable.rows;

    it('both tables were actually parsed (floors — a heading rename must not pass vacuously)', () => {
      // A heading rename would silently shrink a slice to nothing, and a table
      // reformat away from pipes would empty the rows — either way an equality
      // would hold between two empty-ish sets. One floor PER TABLE, because an
      // aggregate floor is satisfied by the larger table alone.
      for (const { start, end } of [alwaysTable, conditionalTable]) {
        expect(start).toBeGreaterThan(0);
        expect(end).toBeGreaterThan(start);
      }
      expect(alwaysRows.length).toBeGreaterThanOrEqual(10);
      expect(conditionalRows.length).toBeGreaterThanOrEqual(2);
      expect(typesIn(alwaysRows).length).toBeGreaterThanOrEqual(20);
      expect(typesIn(conditionalRows).length).toBeGreaterThanOrEqual(2);
      // And the code-side split must be non-degenerate, or the two equalities
      // below could both hold against an empty side.
      expect(codeAlways.length).toBeGreaterThanOrEqual(20);
      expect(codeConditional.length).toBeGreaterThanOrEqual(2);
    });

    it('the always-stateful table lists exactly the unconditional types', () => {
      expect(typesIn(alwaysRows)).toEqual(codeAlways);
    });

    it('the conditionally stateful table lists exactly the conditional types', () => {
      expect(typesIn(conditionalRows)).toEqual(codeConditional);
    });

    it('the two tables partition the guard list — no type in both, none missing', () => {
      // Belt to the two equalities' braces: it states the property a reader of
      // the page relies on directly, so a future split into a THIRD table reds
      // here rather than quietly dropping a type out of both.
      expect([...typesIn(alwaysRows), ...typesIn(conditionalRows)].sort()).toEqual(
        [...STATEFUL_TYPES].sort()
      );
      const both = typesIn(alwaysRows).filter((t) => typesIn(conditionalRows).includes(t));
      expect(both).toEqual([]);
    });
  });

  describe('every forceDataDelete-consuming provider type is on the guard list', () => {
    // The SECOND lower bound, and the one that found
    // `AWS::S3Express::DirectoryBucket` missing.
    //
    // `DeleteContext.forceDataDelete` is set ONLY by the deploy engine's
    // replacement / recreate delete sites, and only under
    // `--force-stateful-recreation`. A provider whose `delete()` reads it has
    // therefore already declared that its delete destroys user data and needs
    // that exact consent — so the guard list must agree, or the consent flag
    // gates a delete the guard never asked for.
    //
    // Derived from the SOURCE rather than hand-listed: the provider files are
    // found by grepping `src/provisioning/providers/**` for the field, and the
    // resource types by reading `register-providers.ts`'s registrations for
    // each provider CLASS. Hand-listing either half is what this fence exists
    // to replace.
    const providersDir = join(repoRoot, 'src', 'provisioning', 'providers');
    const registerSource = readFileSync(
      join(repoRoot, 'src', 'provisioning', 'register-providers.ts'),
      'utf8'
    );

    /**
     * Every module in the providers directory that mentions `forceDataDelete`.
     *
     * NOT scoped to `*-provider.ts`, and RECURSIVE. A consuming module named
     * anything else was invisible to that filter, and an invisible consumer is
     * precisely the fail-open this fence exists to remove; the directory holds
     * a handful of non-`-provider.ts` helpers and no subdirectories today, so
     * both widenings are cheap now and correct later.
     *
     * Two residuals this cannot close, stated rather than implied:
     *
     *  - The match is TEXTUAL, so a file that only MENTIONS the field in a
     *    comment qualifies. Over-strict — a false RED demanding a guard entry
     *    for a type that may not need one, which a human resolves in seconds.
     *  - A provider that reads the consent through a HELPER, without the
     *    literal `forceDataDelete` anywhere in its own module, is invisible.
     *    `src/provisioning/data-delete-intent.ts` is the existing shape of such
     *    a helper (it does not expose the field today). No fence over file text
     *    can see that; it needs the lower bound to be re-derived from the
     *    `DeleteContext` type's readers, which is a bigger change than this
     *    fence.
     */
    function tsFilesUnder(dir: string, prefix = ''): string[] {
      return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) return tsFilesUnder(join(dir, entry.name), rel);
        return entry.name.endsWith('.ts') ? [rel] : [];
      });
    }
    const consumingFiles = tsFilesUnder(providersDir).filter((f) =>
      readFileSync(join(providersDir, f), 'utf8').includes('forceDataDelete')
    );

    /**
     * Exported class names declared in one module. `export default class` and
     * `export abstract class` are matched as well as the plain form: a file
     * yielding ZERO classes contributes zero types, which clears every floor
     * below while covering nothing for that file — the files-to-classes twin of
     * the classes-to-types hole, asserted separately.
     */
    function classesIn(file: string): string[] {
      return [
        ...readFileSync(join(providersDir, file), 'utf8').matchAll(
          /^export\s+(?:default\s+|abstract\s+|declare\s+)*class\s+(\w+)/gm
        ),
      ].map((m) => m[1]);
    }

    /** Provider class names whose module mentions `forceDataDelete`. */
    const consumingClasses = consumingFiles.flatMap(classesIn);

    /** Every `registry.register('<Type>', ...<Class>...)` pairing. */
    function typesRegisteredTo(className: string): string[] {
      const direct = [
        ...registerSource.matchAll(
          new RegExp(`registry\\.register\\(\\s*'(AWS::[^']+)',\\s*new ${className}\\(`, 'g')
        ),
      ].map((m) => m[1]);
      // Some providers are constructed once into a local and registered for
      // several types (`const s3TablesProvider = new S3TablesProvider();`).
      //
      // `const` OR `let`, and an optional type annotation, and matchAll rather
      // than match — each of those three is a measured FAIL-OPEN, not defensive
      // breadth. A reviewer probed the narrow form: rewriting one registration
      // as `let ecr = new ECRProvider()` or
      // `const b: ResourceProvider = new S3BucketProvider()` made the fence
      // silently stop covering that type, and a class bound to two locals lost
      // the second binding. A fence that stops covering a type is worse than no
      // fence, because the list still looks checked.
      const locals = [
        ...registerSource.matchAll(
          new RegExp(`(?:const|let)\\s+(\\w+)(?:\\s*:[^=]+)?\\s*= new ${className}\\(`, 'g')
        ),
      ].map((m) => m[1]);
      const viaLocal = locals.flatMap((local) =>
        [
          ...registerSource.matchAll(
            new RegExp(`registry\\.register\\(\\s*'(AWS::[^']+)',\\s*${local}\\s*\\)`, 'g')
          ),
        ].map((m) => m[1])
      );
      return [...new Set([...direct, ...viaLocal])];
    }

    const guardedTypes = consumingClasses.flatMap(typesRegisteredTo).sort();

    it('found the providers and their registrations (floor — a broken grep must not pass vacuously)', () => {
      // Guard-the-guard, and it is load-bearing twice over: the class names
      // come from a regex over provider sources and the types from a regex
      // over `register-providers.ts`. Either regex silently returning nothing
      // makes every assertion below vacuous, which is exactly the shape that
      // let this list drift in the first place.
      expect(consumingFiles.length).toBeGreaterThanOrEqual(3);
      expect(consumingClasses.length).toBeGreaterThanOrEqual(3);
      expect(guardedTypes.length).toBeGreaterThanOrEqual(3);
      // EVERY consuming FILE must yield at least one class, for the same reason
      // every class must yield a type: a file the class regex cannot read
      // contributes nothing while the totals above stay over the bar, so the
      // list still looks checked.
      expect(consumingFiles.filter((f) => classesIn(f).length === 0)).toEqual([]);
      // EVERY consuming class must yield at least one type. Without this, a
      // class whose registration spelling the regexes cannot see contributes
      // ZERO types and the fence passes while covering nothing for it — the
      // fail-open the floors above cannot detect, because the other classes
      // keep the totals over the bar.
      const unresolved = consumingClasses.filter((c) => typesRegisteredTo(c).length === 0);
      expect(unresolved).toEqual([]);
      // Both registration spellings must be exercised, or the `viaLocal` half
      // could rot unnoticed: ECR / S3 register directly, and the local-variable
      // form is what `S3TablesProvider` uses.
      expect(guardedTypes).toContain('AWS::ECR::Repository');
      expect(guardedTypes).toContain('AWS::S3::Bucket');
      expect(typesRegisteredTo('S3TablesProvider')).toContain('AWS::S3Tables::Table');
    });

    it('every one of them is in STATEFUL_TYPES', () => {
      const missing = guardedTypes.filter((t) => !STATEFUL_TYPES.has(t));
      expect(missing).toEqual([]);
    });
  });

  describe('every published always-stateful type is `always` for every bag', () => {
    // The reason KIND, not just membership. Membership was all that pinned it,
    // and membership is the weaker half: adding a `return null` special case to
    // `isStatefulRecreateTargetSync` for one type lets the replacement through
    // whenever the recorded bag looks a certain way, with the type still on the
    // list.
    //
    // ANCHORED ON THE DOC TABLE, not on a hand list and not on the predicate.
    // A hand list goes stale the moment someone adds a guard entry and forgets
    // this file; deriving the expected set from the predicate and then
    // asserting it with the same predicate is vacuous — a `return null` case
    // simply removes the type from both sides. The doc table is independent of
    // both, and the per-table equality above is what keeps IT honest, so the
    // two fences hold each other up rather than either standing alone.
    for (const resourceType of typesIn(alwaysTable.rows)) {
      it(`${resourceType} answers 'always' whatever the recorded bag says`, () => {
        expect(STATEFUL_TYPES.has(resourceType)).toBe(true);
        // Every bag shape, because the whole point of `always` is that the
        // recorded properties cannot change the verdict.
        expect(isStatefulRecreateTargetSync(resourceType, {}, undefined)).toBe('always');
        expect(isStatefulRecreateTargetSync(resourceType, undefined, undefined)).toBe('always');
        expect(isStatefulRecreateTargetSync(resourceType, { RetentionInDays: 0 }, undefined)).toBe('always');
        expect(isStatefulRecreateTargetForReplace(resourceType, {}, undefined)).toBe('always');
        expect(isStatefulRecreateTargetForReplace(resourceType, undefined, undefined)).toBe('always');
      });
    }

    it('the anchor is non-empty (floor — an unparsed doc table must not pass vacuously)', () => {
      // Without this the loop above generates ZERO cases and the describe
      // passes while pinning nothing.
      expect(typesIn(alwaysTable.rows).length).toBeGreaterThanOrEqual(20);
    });

    it('every guard type answers a KNOWN reason kind, so a new kind cannot land unpinned', () => {
      // The two fences above split on `=== 'always'`, which silently puts any
      // future third reason kind on the conditional side. Enumerating the kinds
      // makes the addition of one red here, where the message names it.
      // Several bag shapes, or the retention kind never appears and the
      // enumeration silently covers a subset of the documented values.
      const bags = [{}, { RetentionInDays: 30 }, undefined];
      const kinds = new Set(
        [...STATEFUL_TYPES].flatMap((t) =>
          bags.flatMap((bag) => [
            isStatefulRecreateTargetSync(t, bag, undefined),
            isStatefulRecreateTargetForReplace(t, bag, undefined),
          ])
        )
      );
      expect([...kinds].map(String).sort()).toEqual([
        'always',
        'has-log-events',
        'has-objects',
        'has-retention',
        'null',
      ]);
    });

    it('AWS::KMS::Alias is deliberately NOT guarded — deleting it drops a pointer, not key material', () => {
      // The sibling decision made alongside `AWS::KMS::Key` and
      // `AWS::KMS::ReplicaKey`. Pinned so "add the KMS types" never becomes
      // "add all of them" by momentum.
      expect(STATEFUL_TYPES.has('AWS::KMS::Alias')).toBe(false);
      expect(isStatefulRecreateTargetForReplace('AWS::KMS::Alias', {}, undefined)).toBe(null);
    });
  });
});

describe('isStatefulRecreateTargetSync (#615)', () => {
  it('returns "always" for unconditional stateful types regardless of properties', () => {
    expect(isStatefulRecreateTargetSync('AWS::DynamoDB::Table', {}, undefined)).toBe('always');
    expect(isStatefulRecreateTargetSync('AWS::RDS::DBInstance', undefined, undefined)).toBe('always');
    expect(isStatefulRecreateTargetSync('AWS::Cognito::UserPool', { UserPoolName: 'x' }, undefined)).toBe(
      'always'
    );
  });

  it('returns null for ephemeral types', () => {
    expect(isStatefulRecreateTargetSync('AWS::Lambda::Function', {}, undefined)).toBe(null);
    expect(isStatefulRecreateTargetSync('AWS::IAM::Role', { RoleName: 'foo' }, undefined)).toBe(null);
    expect(isStatefulRecreateTargetSync('AWS::Unknown::Thing', {}, undefined)).toBe(null);
  });

  describe('AWS::Logs::LogGroup conditional', () => {
    it('returns "has-retention" when RetentionInDays > 0', () => {
      expect(
        isStatefulRecreateTargetSync('AWS::Logs::LogGroup', { RetentionInDays: 7 }, undefined)
      ).toBe('has-retention');
      expect(
        isStatefulRecreateTargetSync('AWS::Logs::LogGroup', { RetentionInDays: 365 }, undefined)
      ).toBe('has-retention');
    });

    it('DEFERS (null) when RetentionInDays is 0 or absent — issue #2558', () => {
      // `null` here is the S3 bucket's meaning of `null`: the bag cannot
      // answer, so the live `DescribeLogStreams` probe decides. It is NOT
      // "the log group holds nothing" — an unset or zero `RetentionInDays`
      // is CloudWatch Logs' never-expire, and `LogsLogGroupProvider` records
      // `0` for exactly that. Reading it as "not stateful" is what destroyed
      // a never-expiring log group on a plain `cdkd deploy`.
      //
      // The polarity that PROVES this is a deferral rather than a pass is in
      // `isStatefulRecreateTargetForReplace` below (mid-deploy, no probe
      // opportunity -> `'has-log-events'`) and in the probe's own suite in
      // `tests/unit/deployment/recreate-targets.test.ts`.
      expect(isStatefulRecreateTargetSync('AWS::Logs::LogGroup', {}, undefined)).toBe(null);
      expect(
        isStatefulRecreateTargetSync('AWS::Logs::LogGroup', { LogGroupName: 'x' }, undefined)
      ).toBe(null);
      expect(
        isStatefulRecreateTargetSync('AWS::Logs::LogGroup', { RetentionInDays: 0 }, undefined)
      ).toBe(null);
    });

    it('defers when properties is undefined', () => {
      expect(isStatefulRecreateTargetSync('AWS::Logs::LogGroup', undefined, undefined)).toBe(null);
    });

    // Issue #2521. The cases below pin WHICH VALUE the cheap positive reads.
    // Each is a bag pairing the two arguments differ in, so a call site that
    // drops the observed argument, or a predicate that goes back to
    // `typeof retention === 'number'`, reds one of them -- the reason they are
    // written as a table of PAIRS rather than as independent assertions on one
    // bag. Deliberately UNCOUNTED: an earlier revision said "the four cases
    // below", a fifth was added, and the number went stale with nothing to
    // catch it. A count here buys a reader nothing the `describe` does not
    // already show.
    describe('which bag, and which value, the has-retention positive reads (#2521)', () => {
      it('coerces a CloudFormation-legal STRING retention', () => {
        // CloudFormation is stringly typed: a hand-written L1, an `Fn::Sub`
        // result, a `Type: String` parameter default, or a record imported by
        // `cdkd import --migrate-from-cloudformation` all put `'30'` in the
        // bag. The old `typeof retention === 'number'` test answered `null`
        // for it, so an EMPTY log group with a string retention was ALLOWED
        // through where an identical group with a numeric one was refused.
        expect(
          isStatefulRecreateTargetSync('AWS::Logs::LogGroup', { RetentionInDays: '30' }, undefined)
        ).toBe('has-retention');
        expect(
          isStatefulRecreateTargetSync('AWS::Logs::LogGroup', undefined, { RetentionInDays: '30' })
        ).toBe('has-retention');
      });

      it('reads a retention that lives ONLY in observedProperties', () => {
        // The out-of-band case: `aws logs put-retention-policy` or the console
        // set the retention, so it is in what AWS REPORTS and in no template.
        // An imported record whose template never declared the property lands
        // in the same shape. Every caller used to pass `properties` alone, so
        // neither produced `has-retention`.
        expect(
          isStatefulRecreateTargetSync(
            'AWS::Logs::LogGroup',
            { LogGroupName: 'x' },
            { LogGroupName: 'x', RetentionInDays: 90 }
          )
        ).toBe('has-retention');
      });

      it('reads a retention that lives ONLY in properties, even against a ZERO observed one', () => {
        // The case that REJECTS the precedence issue #2521 literally
        // prescribed ("observed when present, falling back to properties").
        // `readCurrentState` writes `RetentionInDays: 0` for a group with no
        // retention policy, so the observed bag almost always CARRIES the key
        // -- precedence would make the recorded bag dead for every captured
        // record and DROP a positive verdict the guard already produced. The
        // shipped rule is a plain OR, and this case is what goes red if
        // anyone reinstates the precedence.
        expect(
          isStatefulRecreateTargetSync(
            'AWS::Logs::LogGroup',
            { RetentionInDays: 30 },
            { RetentionInDays: 0 }
          )
        ).toBe('has-retention');
        // ...and the same pairing one level out, where the deferral resolves.
        expect(
          isStatefulRecreateTargetForReplace(
            'AWS::Logs::LogGroup',
            { RetentionInDays: 30 },
            { RetentionInDays: 0 }
          )
        ).toBe('has-retention');
      });

      it('DEFERS when NEITHER bag proves a positive retention', () => {
        // The negative control the three positives need: without it a
        // predicate that answered `has-retention` unconditionally would
        // satisfy all of them. Both never-expire spellings on both sides.
        expect(
          isStatefulRecreateTargetSync(
            'AWS::Logs::LogGroup',
            { LogGroupName: 'x' },
            { LogGroupName: 'x', RetentionInDays: 0 }
          )
        ).toBe(null);
        expect(
          isStatefulRecreateTargetForReplace(
            'AWS::Logs::LogGroup',
            { LogGroupName: 'x' },
            { LogGroupName: 'x', RetentionInDays: 0 }
          )
        ).toBe('has-log-events');
      });

      it('does NOT read an unusable value as a retention', () => {
        // `toFiniteNumber`, not a bare `Number()`. The DISCRIMINATING members
        // of the list below are `true` and `[30]`, and only those two:
        // measured under a bare `Number()`, `true` -> 1 and `[30]` -> 30, so
        // both would PROVE a retention and this case would go red. Every
        // other member (`''`, `'   '`, `[]`, `null` -> 0; `'abc'`, `{}` ->
        // NaN) fails the `> 0` test under either implementation and pins
        // nothing about the choice of coercion -- they are here as the
        // never-expire family, not as evidence. An earlier version of this
        // comment named exactly those inert members as the reason, which is
        // the shape a probe result gets when it is written from memory
        // instead of run.
        //
        // All of them must DEFER because nothing proved a retention, not
        // because they coerced to zero.
        for (const value of ['', '   ', 'abc', true, [], {}, null, [30]]) {
          expect(
            isStatefulRecreateTargetSync(
              'AWS::Logs::LogGroup',
              { RetentionInDays: value },
              { RetentionInDays: value }
            ),
            `RetentionInDays: ${JSON.stringify(value)} must not prove a retention`
          ).toBe(null);
        }
      });
    });
  });

  describe('AWS::S3::Bucket conditional', () => {
    it('returns null at sync time — the live ListObjectsV2 probe runs in the deploy engine', () => {
      // The sync map intentionally defers S3. A caller that only has the
      // map gets `null` and is expected to call the async probe before
      // deciding to block the recreate.
      expect(isStatefulRecreateTargetSync('AWS::S3::Bucket', { BucketName: 'foo' }, undefined)).toBe(null);
      expect(isStatefulRecreateTargetSync('AWS::S3::Bucket', undefined, undefined)).toBe(null);
    });
  });
});

describe('renderStatefulReason', () => {
  it('produces user-readable strings for each reason', () => {
    expect(renderStatefulReason('always')).toMatch(/destroy loses all data/);
    expect(renderStatefulReason('has-objects')).toMatch(/not provably empty/);
    expect(renderStatefulReason('has-retention')).toMatch(/retains data/);
    expect(renderStatefulReason('has-log-events')).toMatch(/not provably empty/);
    expect(renderStatefulReason(null)).toBe('(not stateful)');
    // BOTH conditional reasons render on paths where nothing was measured — a
    // pre-flight probe that answered, one that did not settle, and a
    // mid-deploy site with no probe at all — so neither may assert contents.
    // `has-objects` was assertive until issue #2615; pinned here because
    // "is non-empty" is the wording a future reword reaches for, and on the
    // mid-deploy arm it is the ONLY line the user sees.
    expect(renderStatefulReason('has-log-events')).not.toMatch(/is non-empty/);
    expect(renderStatefulReason('has-objects')).not.toMatch(/is non-empty/);
  });
});

describe('isStatefulRecreateTargetForReplace (--replace mid-deploy, no async probe)', () => {
  it('treats a deferred S3 bucket as stateful (cannot probe emptiness mid-deploy)', () => {
    // Unlike the sync variant (which returns null and relies on the async
    // ListObjectVersions probe), the --replace path has no probe opportunity,
    // so an S3 bucket must require --force-stateful-recreation regardless.
    expect(isStatefulRecreateTargetForReplace('AWS::S3::Bucket', { BucketName: 'foo' }, undefined)).toBe(
      'has-objects'
    );
    expect(isStatefulRecreateTargetForReplace('AWS::S3::Bucket', undefined, undefined)).toBe('has-objects');
  });

  it('matches the sync variant for always-stateful types', () => {
    expect(isStatefulRecreateTargetForReplace('AWS::DynamoDB::Table', {}, undefined)).toBe('always');
    expect(isStatefulRecreateTargetForReplace('AWS::RDS::DBInstance', {}, undefined)).toBe('always');
  });

  it('a type\'s STATEFULNESS never depends on the bags — the invariant recreate-confirm-prompt.ts rests on', () => {
    // `recreate-confirm-prompt.ts` calls this predicate with `undefined` for
    // BOTH bags and consumes only whether the answer is null: a non-null
    // verdict renders **DATA LOSS** plus a FIXED sentence naming the force
    // flag, never `renderStatefulReason`, so WHICH non-null reason comes back
    // is invisible there. That makes its two `undefined` arguments inert —
    // measured, not assumed: swapping one for `{ RetentionInDays: 30 }` leaves
    // the whole suite green, because the swap moves `has-log-events` to
    // `has-retention` and both are non-null.
    //
    // So the thing worth fencing is not that call's arguments but the
    // invariant it rests on. If a future edit made any arm return `null` for
    // some bag, that prompt would silently drop the **DATA LOSS** line from
    // the one screen a user reads before consenting to a destroy — and
    // nothing at the call site could catch it, since it has no bag to vary.
    //
    // The bag list carries both LogGroup polarities and both S3 shapes on
    // purpose: those are the only two types whose REASON is bag-computed, so a
    // list without them would hold vacuously for every `'always'` type.
    const bags: ReadonlyArray<Record<string, unknown> | undefined> = [
      undefined,
      {},
      { RetentionInDays: 30 },
      { RetentionInDays: 0 },
      { RetentionInDays: '30' },
      { RetentionInDays: 'abc' },
      { BucketName: 'b' },
    ];
    const varying: string[] = [];
    let pairs = 0;
    for (const resourceType of [
      ...STATEFUL_TYPES,
      'AWS::Lambda::Function',
      'AWS::IAM::Role',
      'AWS::Glue::SecurityConfiguration',
    ]) {
      const nullness = new Set<boolean>();
      for (const recorded of bags) {
        for (const observed of bags) {
          pairs++;
          nullness.add(isStatefulRecreateTargetForReplace(resourceType, recorded, observed) === null);
        }
      }
      if (nullness.size > 1) varying.push(resourceType);
    }
    // Floor: an empty type list or an empty bag list would make the assertion
    // below hold at zero. The bag count is a LITERAL read off the array.
    expect(bags).toHaveLength(7);
    expect(pairs).toBeGreaterThanOrEqual(7 * 7 * 100);
    expect(
      varying,
      'these types answer null for some bags and non-null for others, so ' +
        "recreate-confirm-prompt.ts's bag-free call can no longer be trusted to " +
        'produce the same **DATA LOSS** verdict the guard would'
    ).toEqual([]);
  });

  it('keeps the sync verdict for a LogGroup the recorded retention already settles', () => {
    expect(
      isStatefulRecreateTargetForReplace('AWS::Logs::LogGroup', { RetentionInDays: 30 }, undefined)
    ).toBe('has-retention');
  });

  it('treats a deferred LogGroup as stateful (cannot probe log streams mid-deploy) — issue #2558', () => {
    // The fix's core polarity, and the one the old predicate got backwards: an
    // unset or zero `RetentionInDays` is CloudWatch Logs' never-expire, so the
    // mid-deploy sites — which include a PLAIN `cdkd deploy`'s property-driven
    // replacement, reached with no flag at all — must refuse rather than
    // DELETE + CREATE.
    for (const bag of [
      {},
      { LogGroupName: 'x' },
      { RetentionInDays: 0 },
      // The provider's own never-expire placeholder, read back from the
      // observed bag: `LogsLogGroupProvider` writes `0` for a log group with
      // no retention policy.
      { LogGroupName: 'x', RetentionInDays: 0 },
      undefined,
    ]) {
      expect(isStatefulRecreateTargetForReplace('AWS::Logs::LogGroup', bag, undefined)).toBe(
        'has-log-events'
      );
    }
  });

  it('returns null for non-stateful types (replace freely)', () => {
    expect(isStatefulRecreateTargetForReplace('AWS::Glue::SecurityConfiguration', {}, undefined)).toBe(null);
    expect(isStatefulRecreateTargetForReplace('AWS::ECS::TaskDefinition', {}, undefined)).toBe(null);
  });
});
