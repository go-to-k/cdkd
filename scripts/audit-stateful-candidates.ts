/**
 * Tier-2 stateful-candidate derivation (issue [#2553]).
 *
 * `STATEFUL_TYPES` (`src/provisioning/stateful-types.ts`) has two mechanical
 * lower bounds — the `DeletionPolicy: Snapshot`-capable union in
 * `src/provisioning/final-snapshot.ts`, and the providers whose `delete()`
 * consumes `DeleteContext.forceDataDelete`. BOTH can only see types cdkd has
 * an SDK provider for, because both are derived from
 * `src/provisioning/providers/**` and `register-providers.ts`. The larger
 * population by two orders of magnitude — tier 2, the types with no SDK
 * provider that route through Cloud Control API — had no derivation at all,
 * and the hand passes that widened the guard list (PR #2519, issue #2548)
 * were both walks of the provider directory, so they could not have seen it.
 *
 * This script is the third bound, and the first one that reads tier 2. It
 * proposes CANDIDATES; it does not decide. For every tier-2 type it reads the
 * CloudFormation registry schema — the same artifact
 * `src/provisioning/create-only-properties.ts` resolves at diff time, via the
 * same `cloudformation:DescribeType` call — and keeps a type when BOTH hold:
 *
 *   1. The schema declares at least one `createOnlyProperties` entry. Without
 *      one, no property change can drive a replacement, so the guard has
 *      nothing to protect on a plain `cdkd deploy`: the type is unreachable by
 *      the paths issue #2514 is about. WITH one, a rename lands as a
 *      property-driven replacement that a plain deploy reaches with no flag —
 *      `src/analyzer/diff-calculator.ts` consults the hand-authored
 *      `ReplacementRulesRegistry` first and falls back to
 *      `create-only-properties.ts`'s schema resolution for every type the
 *      registry does not cover, which is all but three of tier 2
 *      (`AWS::ApiGateway::RestApi`, `AWS::EC2::Volume`, `AWS::Lambda::Version`
 *      have rules; the other 1369 take the schema fallback). A registry rule is
 *      deliberately NOT an exemption here: it makes the replacement
 *      classification more certain, not less.
 *   2. At least one DATA-BEARING SIGNAL fires on the schema's own property
 *      names — see {@link STATEFUL_SIGNALS}. This is the "its delete is not
 *      obviously a pointer-drop" half of the issue's criterion, and it is a
 *      heuristic by construction: no AWS-published artifact states "deleting
 *      this destroys user data" for a CFn type. What makes it checkable rather
 *      than a hunch is that each signal is a property AWS only puts on a type
 *      that stores something (you do not give a pointer a backup retention
 *      period), the signals are calibrated against the real tier-2 corpus, and
 *      `tests/unit/scripts/stateful-candidates.test.ts` holds a floor AND a
 *      ceiling per signal so neither an inert signal nor one that fires on
 *      everything can pass as a derivation.
 *
 * The output is therefore a REVIEW QUEUE, and the fence is a disposition
 * requirement rather than a containment: every candidate must be either in
 * `STATEFUL_TYPES` or in {@link NOT_GUARDED} with a reason. A tier-2 type that
 * gains a createOnly property or a storage-shaped property in a future AWS
 * schema revision becomes a candidate, is dispositioned by neither, and reds
 * the fence — which is the property the issue asked for and the reason a hand
 * pass over 1371 types was the wrong deliverable.
 *
 * Outputs (atomic write via `.tmp` + rename, mirroring
 * `scripts/audit-provider-coverage.ts`):
 *   docs/_generated/stateful-candidates.json — machine-readable cache.
 *   docs/_generated/stateful-candidates.md   — human-readable review queue.
 *
 * Usage:
 *   node scripts/audit-stateful-candidates.ts              # offline: summary from cache
 *   node scripts/audit-stateful-candidates.ts --regenerate # call AWS; rewrite cache
 *   node scripts/audit-stateful-candidates.ts --check      # offline: cache vs guard list
 *
 * Regeneration issues a `cloudformation:DescribeType` per tier-2 type (1371 at
 * the time of writing), so budget the same 10-30 minutes as
 * `vp run audit:coverage:regenerate` and expect the same throttling. Raw
 * schemas are cached under the gitignored `.cache/cfn-tier2-schemas/` so a
 * re-derivation after a signal change costs no AWS calls (`--regenerate`
 * reuses a cached schema unless `--refetch` is passed).
 *
 * Deliberately NOT in `vp run gen:all-matrices` and NOT a CI staleness guard,
 * for the same reason `audit:coverage:regenerate` is excluded: it needs AWS
 * credentials and tens of minutes. `--check` is the offline half CI and
 * `/verify-pr` can afford, and it is what the unit fence duplicates.
 */

import { mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DescribeTypeCommand } from '@aws-sdk/client-cloudformation';
import pLimit from 'p-limit';
// NOTE: Node 24 native TS strip resolves imports literally — it does NOT
// rewrite `.js` to `.ts`. See the same note in
// `scripts/audit-provider-coverage.ts`.
import { getAwsClients } from '../src/utils/aws-clients.ts';
import { STATEFUL_TYPES } from '../src/provisioning/stateful-types.ts';
import { escapeCell } from './markdown-table.ts';

const SCHEMA_VERSION = 1;

const DEFAULT_CONCURRENCY = 3;
const DEFAULT_RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 16000, 16000, 16000] as const;

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), '..');
const COVERAGE_JSON = resolve(REPO_ROOT, 'docs/_generated/provider-coverage.json');
const SCHEMA_CACHE_DIR = resolve(REPO_ROOT, '.cache/cfn-tier2-schemas');
const OUTPUT_JSON = resolve(REPO_ROOT, 'docs/_generated/stateful-candidates.json');
const OUTPUT_MARKDOWN = resolve(REPO_ROOT, 'docs/_generated/stateful-candidates.md');

/**
 * A data-bearing signal: a rule over either the resource type's TOP-LEVEL
 * registry schema property names, or the type name's own last segment.
 *
 * Property-name signals are top-level only, and that is a deliberate
 * under-approximation. Nested definitions carry the same words for unrelated
 * reasons — an `AWS::Something::Config` with a nested
 * `LogConfiguration.RetentionInDays` describes the LOGS it configures, not
 * itself — so matching them would fire on configuration types by the hundred
 * and the ceiling in the fence would go red. A type that stores something
 * declares the storage knob at the top level, where CloudFormation users set
 * it.
 *
 * The `type-name` scope exists because the property-name family has a MEASURED
 * blind spot, not as a shortcut: a type whose contents are entirely
 * out-of-band declares nothing about them. `AWS::Backup::BackupVault` — one of
 * the types issue #2553 names — has properties `AccessPolicy`,
 * `BackupVaultArn`, `BackupVaultName`, `BackupVaultTags`, `EncryptionKeyArn`,
 * `LockConfiguration` and `Notifications`, every one a pointer or a setting,
 * while the recovery points the vault holds appear nowhere in the schema. No
 * property-shaped rule can see that vault, and the same is true of a
 * repository, a collection and a bucket. The last name segment is the only
 * mechanical thing left that distinguishes them, so it is used with a tight
 * noun list and its false positives are dispositioned in {@link NOT_GUARDED}
 * rather than pattern-tuned away — a disposition is visible in the generated
 * review queue, a narrowed regex is not.
 */
export interface StatefulSignal {
  /** Stable key recorded per candidate in the JSON output. */
  readonly key: string;
  /** What the signal claims about a type it fires on. Rendered in the .md. */
  readonly rationale: string;
  /**
   * What {@link pattern} is tested against: every top-level property name, or
   * the LAST `::`-separated segment of the type name.
   */
  readonly scope: 'property-name' | 'type-name';
  readonly pattern: RegExp;
}

/**
 * The signal set, calibrated against the real tier-2 corpus (see the
 * per-signal counts in `docs/_generated/stateful-candidates.md`).
 *
 * Every pattern is anchored on a WHOLE property name rather than a substring,
 * because the substring spellings all over-fire: an unanchored `/Backup/`
 * matches `BackupPlanId` on `AWS::Backup::BackupSelection` (a pointer to a
 * plan, storing nothing), and an unanchored `/Retention/` matches every
 * type that configures retention SOMEWHERE ELSE.
 */
export const STATEFUL_SIGNALS: readonly StatefulSignal[] = [
  {
    key: 'snapshot-or-backup',
    scope: 'property-name',
    rationale:
      'The type declares a snapshot / backup / restore-from property. AWS adds ' +
      'those to a type whose contents survive independently of the resource, ' +
      'which is a statement that the resource has contents.',
    pattern:
      /^(SnapshotArns?|SnapshotName|SnapshotIdentifier|SnapshotWindow|SnapshotRetentionLimit|SourceSnapshotName|FinalSnapshotName|BackupRetentionPeriod|BackupWindow|BackupPolicy|BackupId|AutomaticBackupRetentionDays|DailyAutomaticBackupStartTime|PointInTimeRecoverySpecification|RestoreFrom|RestoreToTime|SourceBackupId)$/,
  },
  {
    key: 'retention-window',
    scope: 'property-name',
    rationale:
      'The type declares its own retention period. A retention window is a ' +
      'promise about how long WRITTEN DATA is kept, so the resource holds ' +
      'writes rather than pointing at them.',
    pattern:
      /^(RetentionPeriod|RetentionInDays|RetentionDays|RetentionProperties|MagneticStoreRetentionPeriodInDays|MemoryStoreRetentionPeriodInHours|DataRetentionInHours|MessageRetentionPeriod)$/,
  },
  {
    key: 'storage-capacity',
    scope: 'property-name',
    rationale:
      'The type declares provisioned storage. A resource you size in gibibytes ' +
      'or provisioned IOPS has a disk, and DELETE + CREATE hands back an empty one.',
    pattern:
      /^(AllocatedStorage|StorageCapacity|StorageType|StorageEncrypted|StorageConfiguration|VolumeSize|DataStorageSizeLimitGB|NumberOfNodes|NodeType|ShardConfiguration|NumShards)$/,
  },
  {
    key: 'deletion-protection',
    scope: 'property-name',
    rationale:
      'The type has a deletion-protection switch. AWS ships one where an ' +
      'accidental delete is expensive to undo, which is the same judgement ' +
      'this guard makes.',
    pattern:
      /^(DeletionProtection|DeletionProtectionEnabled|EnableDeletionProtection|DeletionPolicy|DeletionProtectionCheck)$/,
  },
  {
    key: 'encryption-at-rest',
    scope: 'property-name',
    rationale:
      'The type declares encryption AT REST specifically (not a generic ' +
      '`KmsKeyId`, which every type that encrypts anything in transit or in a ' +
      'log also carries). Data at rest is data the resource stores.',
    pattern:
      /^(EncryptionAtRest|EncryptionAtRestOptions|AtRestEncryptionEnabled|DataEncryption|EncryptionInfo|EncryptionConfiguration)$/,
  },
  {
    key: 'data-store-noun',
    scope: 'type-name',
    rationale:
      'The type name ends in a noun AWS uses for a thing that HOLDS things — ' +
      'the only mechanical signal left for a type whose contents are entirely ' +
      'out-of-band and therefore absent from its schema (a vault, a repository, ' +
      'a collection). Deliberately the noisiest signal: its false positives are ' +
      'dispositioned in `NOT_GUARDED`, not tuned out of the pattern.',
    // Anchored on the LAST segment, so `AWS::EC2::LocalGatewayRouteTable`
    // matches on `Table` and gets a disposition, while a type merely mentioning
    // a store in the middle of its name does not. Nouns AWS also uses for pure
    // configuration containers — `Group`, `Environment`, `Pool`, `Queue`,
    // `Namespace`, `Registry`, `Fleet`, `Instance` — are deliberately OUT: on
    // the corpus they contributed dozens of types with nothing to lose
    // (`AWS::CodeDeploy::DeploymentGroup`, `AWS::Batch::JobQueue`,
    // `AWS::AutoScaling::WarmPool`), and a signal whose hits are almost all
    // dispositions stops being read.
    pattern:
      /(Cluster|Database|Table|Vault|Bucket|FileSystem|Volume|Warehouse|Collection|Repository|DataStore|Datastore|Lake|Ledger|Journal|Archive|Index|KeyValueStore|Domain)$/,
  },
];

/** One tier-2 type the derivation proposes for review. */
export interface StatefulCandidate {
  readonly typeName: string;
  /** Raw `createOnlyProperties` paths from the registry schema, sorted. */
  readonly createOnlyProperties: readonly string[];
  /** Keys of the signals that fired, sorted. */
  readonly signals: readonly string[];
  /** Whether the type is currently in `STATEFUL_TYPES`. */
  readonly guarded: boolean;
}

/** Machine-readable output shape. */
export interface StatefulCandidateReport {
  readonly schemaVersion: number;
  readonly generatedAt: string;
  readonly summary: {
    readonly tier2Count: number;
    readonly schemasRead: number;
    readonly withCreateOnly: number;
    /**
     * Schemas that parsed but declare NO top-level properties.
     *
     * Measured 0 over the real corpus, and that is what makes the field
     * useful: a truncated or half-written cache file parses as `{}`, counts as
     * READ, contributes no createOnly and no signal, and is therefore
     * indistinguishable from a type honestly cleared. `unreadable` cannot see
     * it — the file exists and parses. This count can, and its ceiling is 0.
     */
    readonly schemasWithNoProperties: number;
    readonly candidateCount: number;
    readonly guardedCount: number;
    readonly unguardedCount: number;
    /** How many candidates each signal contributed to, by signal key. */
    readonly signalCounts: Readonly<Record<string, number>>;
  };
  readonly candidates: readonly StatefulCandidate[];
  /** Tier-2 types whose schema could not be read; excluded from the derivation. */
  readonly unreadable: readonly string[];
}

/**
 * The subset of a CloudFormation registry schema this derivation reads.
 * Everything else in the document is ignored.
 */
export interface RegistrySchema {
  readonly typeName?: string;
  readonly createOnlyProperties?: readonly string[];
  readonly properties?: Readonly<Record<string, unknown>>;
}

/**
 * Top-level property names, in schema order.
 *
 * `properties` is the object CloudFormation template authors write into, so
 * its KEYS are exactly the top-level property names. Every tier-2 schema
 * measured has one — `FLOORS.maxSchemasWithNoProperties` is 0 for that reason —
 * so a schema without one is not a quiet "contributes no signal" case: it is
 * either a truncated cache file or a genuinely new registry shape, and both
 * want a human. `deriveReport` COUNTS them rather than throwing — the count is
 * what `FLOORS.maxSchemasWithNoProperties` reads; the types themselves are not
 * recorded, so the remedy is to re-run with `--regenerate --refetch` rather
 * than to look one up in the report.
 */
export function topLevelPropertyNames(schema: RegistrySchema): string[] {
  return Object.keys(schema.properties ?? {});
}

/** The last `::`-separated segment of a CloudFormation type name. */
export function lastTypeSegment(typeName: string): string {
  const parts = typeName.split('::');
  return parts[parts.length - 1] ?? typeName;
}

/**
 * Signal keys that fire, sorted for diff-stable output.
 *
 * `typeName` is taken as an ARGUMENT rather than read off `schema.typeName`:
 * the derivation walks the tier-2 list from `provider-coverage.json`, and the
 * name it looked the type up BY is the one the guard list would have to
 * contain. A schema whose own `typeName` disagrees (a stale cache entry, a
 * hand-edited fixture) must not be able to move a signal onto a different type.
 */
export function signalsFor(typeName: string, schema: RegistrySchema): string[] {
  const names = topLevelPropertyNames(schema);
  const segment = lastTypeSegment(typeName);
  return STATEFUL_SIGNALS.filter((signal) =>
    signal.scope === 'type-name'
      ? signal.pattern.test(segment)
      : names.some((name) => signal.pattern.test(name))
  )
    .map((signal) => signal.key)
    .sort();
}

/**
 * Decide whether a tier-2 type is a candidate, and why.
 *
 * Returns `undefined` for a non-candidate so callers can distinguish "read the
 * schema, not a candidate" from "could not read the schema" (the latter lands
 * in `unreadable`, because a type whose schema never arrived has NOT been
 * cleared — treating an unread schema as a clean result is the failed-clean
 * shape this repo has been bitten by).
 */
export function classifyCandidate(
  typeName: string,
  schema: RegistrySchema,
  guardList: ReadonlySet<string> = STATEFUL_TYPES
): StatefulCandidate | undefined {
  const createOnlyProperties = [...(schema.createOnlyProperties ?? [])].sort();
  if (createOnlyProperties.length === 0) {
    return undefined;
  }
  const signals = signalsFor(typeName, schema);
  if (signals.length === 0) {
    return undefined;
  }
  return {
    typeName,
    createOnlyProperties,
    signals,
    guarded: guardList.has(typeName),
  };
}

/**
 * Tier-2 candidates this repo has REVIEWED and deliberately left unguarded,
 * each with the reason.
 *
 * This is the escape hatch that keeps the fence usable: the derivation is a
 * heuristic and will propose types whose delete really is a pointer-drop. An
 * entry here is a decision, not a suppression, so it carries the argument the
 * same way an entry in `STATEFUL_TYPES` does.
 *
 * `tests/unit/scripts/stateful-candidates.test.ts` fences BOTH directions:
 * every candidate must be guarded or listed here, AND every entry here must
 * still BE a candidate — an entry whose type stopped being proposed (renamed,
 * schema changed, promoted to an SDK provider) is dead weight that would
 * silently absorb a future type of the same name.
 */
export const NOT_GUARDED: ReadonlyMap<string, string> = new Map([
  // The rule every entry below is decided by, stated once so a future entry
  // has something to be measured against. A candidate is left UNGUARDED only
  // when one of these holds, each checked against the type's own registry
  // schema rather than recalled:
  //
  //   (a) DECLARED CONTENT — everything the resource holds is written in the
  //       CloudFormation template, or in a sibling template resource, so
  //       DELETE + CREATE restores it. A route table whose routes are separate
  //       resources is the shape.
  //   (b) POINTER OR GROUPING — the resource references storage that OUTLIVES
  //       it. A global cluster over regional clusters, a storage config naming
  //       an S3 bucket.
  //   (c) NO CONTENT — the resource stores nothing at all; what it loses on a
  //       delete is in-flight or derived.
  //
  // Anything else is guarded, INCLUDING the cases where the answer is not
  // repo-derivable. That is the same fail-safe the `AWS::S3Tables::Namespace`
  // and `AWS::KMS::ReplicaKey` entries in `stateful-types.ts` are on: an
  // unprovable emptiness must not read as empty. The cost of being wrong in
  // that direction is one `--force-stateful-recreation` flag; the cost of
  // being wrong in the other is the user's data.
  [
    'AWS::Amplify::Domain',
    '(a) A domain ASSOCIATION, not a zone: the resource is a domain name plus the ' +
      '`SubDomainSettings` map, both written in the template. The DNS records live in ' +
      'whatever hosted zone the user points at, which the delete does not touch.',
  ],
  [
    'AWS::AppConfig::Environment',
    '(c) An environment holds deployment HISTORY and the `Monitors` list; the ' +
      'configuration content lives under a ConfigurationProfile (guarded) and its ' +
      'hosted versions. Nothing the environment itself stores survives a redeploy ' +
      'anyway.',
  ],
  [
    'AWS::AppRunner::Service',
    '(c) A stateless container service. Its `SourceConfiguration` points at an image ' +
      'repository or a code repository that outlives the service, and the running ' +
      'instances hold nothing a recreate would not rebuild.',
  ],
  [
    'AWS::Cognito::UserPoolDomain',
    '(a) A domain NAME for the pool\'s hosted UI — `Domain` plus an optional ' +
      '`CustomDomainConfig` certificate ARN, both in the template. The users are in ' +
      '`AWS::Cognito::UserPool`, which is already on the guard list.',
  ],
  [
    'AWS::Connect::InstanceStorageConfig',
    '(b) A POINTER: it associates a Connect instance with an S3 bucket, a Kinesis ' +
      'stream, a Firehose or a Kinesis Video stream, every one of which is its own ' +
      'resource and outlives this association. Deleting the config stops the delivery; ' +
      'it deletes nothing already delivered.',
  ],
  [
    'AWS::DocDB::GlobalCluster',
    '(b) A GROUPING over regional `AWS::DocDB::DBCluster` resources, which hold the ' +
      'data and are themselves guarded. Deleting the global cluster detaches the ' +
      'members; it does not delete them.',
  ],
  [
    'AWS::EC2::LocalGatewayRouteTable',
    '(a) The table itself carries only `Mode` and tags — its routes and VIF-group / ' +
      'VPC associations are separate template resources, so a recreate restores them.',
  ],
  [
    'AWS::EC2::TransitGatewayMulticastDomain',
    '(a) The domain carries only `Options` and tags; its group members, sources and ' +
      'subnet associations are separate template resources.',
  ],
  [
    'AWS::EC2::TransitGatewayPolicyTable',
    '(a) The table carries only tags — the policy entries are ' +
      '`AWS::EC2::TransitGatewayPolicyTableEntry` resources in the template.',
  ],
  [
    'AWS::EC2::TransitGatewayRouteTable',
    '(a) The table carries only tags — the routes, associations and propagations are ' +
      'each their own template resource, so a recreate restores every one of them.',
  ],
  [
    'AWS::ECR::RepositoryCreationTemplate',
    '(c) A TEMPLATE applied to repositories created later under a `Prefix`. It stores ' +
      'no images; the repositories it templated keep existing after it is deleted, ' +
      'unchanged.',
  ],
  [
    'AWS::EMRContainers::VirtualCluster',
    '(b) A REGISTRATION of an existing EKS namespace with EMR: `ContainerProvider` ' +
      'names the EKS cluster, which outlives it. Deleting the virtual cluster ' +
      'deregisters; the namespace and everything in it stay.',
  ],
  [
    'AWS::Lightsail::Domain',
    '(a) A DNS zone whose records are the template\'s own `DomainEntries` list, so a ' +
      'recreate restores every record. (Contrast `AWS::Lightsail::Bucket` and ' +
      '`AWS::Lightsail::Database`, both guarded.)',
  ],
  [
    'AWS::Location::PlaceIndex',
    '(c) A configured POINTER at a geocoding data provider (`DataSource`); the place ' +
      'data belongs to the provider, not to this resource. Nothing the user wrote is ' +
      'stored in it. (Contrast `AWS::Location::GeofenceCollection`, whose geofences ' +
      'are written through the API and ARE guarded.)',
  ],
  [
    'AWS::MediaLive::Cluster',
    '(c) A POOL of on-premises nodes: `NetworkSettings`, an instance role and a ' +
      'read-only `ChannelIds` list. It has no storage, and the channels it lists are ' +
      'separate resources.',
  ],
  [
    'AWS::MWAAServerless::Workflow',
    '(a) The workflow IS its definition — `Code` inline or `DefinitionS3Location` — ' +
      'both written in the template, so a recreate restores it. Run history is ' +
      'operational output, not user-supplied content.',
  ],
  [
    'AWS::Neptune::GlobalCluster',
    '(b) A GROUPING over regional `AWS::Neptune::DBCluster` resources, which hold the ' +
      'graph and are themselves guarded.',
  ],
  [
    'AWS::Omics::Workflow',
    '(a) The workflow IS its definition, supplied by `DefinitionUri` / ' +
      '`DefinitionRepository` / `Main` — all in the template. Its `StorageCapacity` is ' +
      'the RUN-time scratch size, not a store that survives a run.',
  ],
  [
    'AWS::Omics::WorkflowVersion',
    '(a) Same as `AWS::Omics::Workflow`: a version is a definition supplied from the ' +
      'template or an S3 URI, and the run scratch space it sizes does not outlive a run.',
  ],
  [
    'AWS::PCS::Cluster',
    '(c) A Slurm scheduler plus networking. Job data lives on the file systems the ' +
      'compute node groups mount (FSx, EFS — their own resources); what a delete loses ' +
      'is queued job state, which is in-flight rather than stored.',
  ],
  [
    'AWS::RDS::GlobalCluster',
    '(b) A GROUPING over regional `AWS::RDS::DBCluster` resources, which hold the data ' +
      'and are themselves guarded. `SourceDBClusterIdentifier` names an existing ' +
      'cluster that outlives this resource.',
  ],
  [
    'AWS::RedshiftServerless::Workgroup',
    '(b) COMPUTE: base / max capacity, networking and config parameters. The databases ' +
      'live in `AWS::RedshiftServerless::Namespace`, which is guarded — a workgroup can ' +
      'be dropped and recreated against the same namespace with no data loss.',
  ],
  [
    'AWS::Route53::CidrCollection',
    '(a) The collection\'s `Locations` — every CIDR block in it — are written in the ' +
      'template, so a recreate restores the collection exactly.',
  ],
  [
    'AWS::Route53RecoveryControl::Cluster',
    '(c) A set of control-plane endpoints. The routing controls, control panels and ' +
      'safety rules that carry the actual state are separate template resources.',
  ],
  [
    'AWS::S3Files::FileSystem',
    '(b) A VIEW over an existing S3 bucket: `Bucket` plus `Prefix`. The files are ' +
      "objects in that bucket, which is its own resource and outlives the file system. " +
      'Deleting the file system removes the view, not the objects.',
  ],
  [
    'AWS::SecurityAgent::TargetDomain',
    '(c) A domain-ownership VERIFICATION record — the domain name plus its verification ' +
      'method and status. It stores nothing of the user\'s beyond what the template ' +
      'already declares.',
  ],
  [
    'AWS::StepFunctions::Activity',
    '(c) A poll endpoint: a name and an encryption configuration. Task tokens held ' +
      'against it are in-flight work, not stored content, and the state machines that ' +
      'schedule them are separate resources.',
  ],
]);

/**
 * Floors the derivation must clear, as literals.
 *
 * Two different collapses, and neither is detectable by the other. A derivation
 * that reads nothing (a moved cache directory, a `provider-coverage.json`
 * without a `tier2` key) reports zero candidates, zero undispositioned, and
 * exits 0 — a green that means "nothing was examined". A derivation whose
 * signals stopped matching does the same. The magnitudes below are measured
 * against the real corpus and pinned by
 * `tests/unit/scripts/stateful-candidates.test.ts`; they are deliberately well
 * under the measured values, since their job is total collapse, not drift.
 */
export const FLOORS = {
  /** Tier-2 types the coverage cache must list. Measured: 1371 (deduped). */
  tier2: 1000,
  /** Registry schemas the run must have read. Measured: see the report. */
  schemasRead: 1000,
  /** Types declaring at least one createOnly property. Measured: see the report. */
  withCreateOnly: 700,
  /** Candidates proposed. Measured: see the report. */
  candidates: 30,
  /**
   * A CEILING, not a floor, and the only one in this object. Measured 0 over
   * the real corpus; see `schemasWithNoProperties`' own note for why 0 is the
   * right value rather than a slack bound.
   */
  maxSchemasWithNoProperties: 0,
} as const;

/**
 * A signal that fires on NOTHING disposes of nothing; a signal that fires on
 * EVERYTHING makes the review queue unreadable and the fence unusable. Both
 * are silent failures of a derivation, so both are bounded.
 *
 * The ceiling is a FRACTION of the types with a createOnly property — the
 * population a signal is choosing within — rather than of tier 2, so a future
 * AWS release that adds hundreds of pointer-only types cannot loosen it.
 */
export const SIGNAL_BOUNDS = {
  minCandidatesPerSignal: 1,
  /**
   * Measured worst case at introduction: `data-store-noun` fires on 63 of the
   * 1185 types with a createOnly property, 5.3%. At the first cut this was
   * 0.25, which review measured as fencing nothing — that signal could grow
   * 4.7x before tripping. 0.15 leaves roughly a 3x margin over the widest
   * signal while still refusing one that fires on a sixth of the population.
   */
  maxShareOfCreateOnlyTypes: 0.15,
} as const;

/**
 * A fixed corpus with known verdicts, analysed BEFORE the real tree is read.
 *
 * The floors above catch a derivation that collapses toward ZERO. They cannot
 * catch one that collapses toward GREEN: a `classifyCandidate` that returned a
 * candidate for everything, or a `signalsFor` that returned every key, would
 * leave the floors satisfied and the counts larger, not smaller. This is the
 * defence against that direction, and it is why several cases expect
 * `undefined`.
 *
 * Each case is a shape the real corpus either contains or was measured NOT to
 * contain; the negatives are the load-bearing half.
 */
export const SELF_PROBE_CASES: ReadonlyArray<{
  readonly label: string;
  readonly typeName: string;
  readonly schema: RegistrySchema;
  /** Expected signal keys, or `null` when the type must not be a candidate. */
  readonly expected: readonly string[] | null;
}> = [
  {
    label: 'createOnly + a snapshot property is a candidate',
    typeName: 'AWS::Probe::Widget',
    schema: {
      createOnlyProperties: ['/properties/Name'],
      properties: { Name: {}, SnapshotRetentionLimit: {} },
    },
    expected: ['snapshot-or-backup'],
  },
  {
    label: 'createOnly + a retention property is a candidate',
    typeName: 'AWS::Probe::Widget',
    schema: {
      createOnlyProperties: ['/properties/Name'],
      properties: { Name: {}, RetentionProperties: {} },
    },
    expected: ['retention-window'],
  },
  {
    label: 'createOnly + provisioned storage is a candidate',
    typeName: 'AWS::Probe::Widget',
    schema: {
      createOnlyProperties: ['/properties/Name'],
      properties: { Name: {}, AllocatedStorage: {} },
    },
    expected: ['storage-capacity'],
  },
  {
    label: 'createOnly + a deletion-protection switch is a candidate',
    typeName: 'AWS::Probe::Widget',
    schema: {
      createOnlyProperties: ['/properties/Name'],
      properties: { Name: {}, DeletionProtection: {} },
    },
    expected: ['deletion-protection'],
  },
  {
    label: 'createOnly + encryption AT REST is a candidate',
    typeName: 'AWS::Probe::Widget',
    schema: {
      createOnlyProperties: ['/properties/Name'],
      properties: { Name: {}, EncryptionAtRestOptions: {} },
    },
    expected: ['encryption-at-rest'],
  },
  {
    label:
      'a data-store noun is a candidate on the NAME alone — the AWS::Backup::BackupVault shape, ' +
      'whose every property is a pointer or a setting',
    typeName: 'AWS::Probe::ThingVault',
    schema: {
      createOnlyProperties: ['/properties/ThingVaultName'],
      properties: { ThingVaultName: {}, AccessPolicy: {}, Notifications: {} },
    },
    expected: ['data-store-noun'],
  },
  {
    label: 'no createOnly property means no replacement can be driven — not a candidate',
    typeName: 'AWS::Probe::ThingVault',
    schema: { properties: { SnapshotRetentionLimit: {}, RetentionPeriod: {} } },
    expected: null,
  },
  {
    label: 'createOnly with no signal at all is not a candidate',
    typeName: 'AWS::Probe::Widget',
    schema: {
      createOnlyProperties: ['/properties/Name'],
      properties: { Name: {}, Description: {}, RoleArn: {} },
    },
    expected: null,
  },
  {
    label:
      'a NESTED retention property does not fire — it describes what the type configures, ' +
      'not what the type holds',
    typeName: 'AWS::Probe::Widget',
    schema: {
      createOnlyProperties: ['/properties/Name'],
      properties: { Name: {}, LogConfiguration: {} },
    },
    expected: null,
  },
  {
    label:
      'an unanchored `Backup` substring does not fire — `BackupPlanId` is a pointer to a plan ' +
      '(the AWS::Backup::BackupSelection shape)',
    typeName: 'AWS::Probe::Widget',
    schema: {
      createOnlyProperties: ['/properties/Name'],
      properties: { Name: {}, BackupPlanId: {}, SourceBackupWindow: {} },
    },
    expected: null,
  },
  {
    label:
      'a generic `KmsKeyId` does not fire — every type that encrypts anything carries one, ' +
      'including types that store nothing',
    typeName: 'AWS::Probe::Widget',
    schema: {
      createOnlyProperties: ['/properties/Name'],
      properties: { Name: {}, KmsKeyId: {} },
    },
    expected: null,
  },
  {
    label:
      'a property name CONTAINING a signal word does not fire — the patterns are anchored on ' +
      'whole names, and without the anchors `MySnapshotWindowOverride` matches `SnapshotWindow`',
    typeName: 'AWS::Probe::Widget',
    schema: {
      createOnlyProperties: ['/properties/Name'],
      properties: {
        Name: {},
        MySnapshotWindowOverride: {},
        RetentionPeriodPolicyArn: {},
        // SUFFIX shape as well as prefix: a prefix-extended name only fences the
        // TRAILING anchor. Dropping the LEADING `^` needs a name the pattern
        // matches at its end.
        SourceSnapshotWindow: {},
        SnapshotWindowOverride: {},
        DefaultRetentionPeriod: {},
      },
    },
    expected: null,
  },
  {
    label:
      'a property name merely CONTAINING `AllocatedStorage` does not fire — anchoring is per ' +
      'signal, and three of the six patterns were still unfenced after the first anchor pass',
    typeName: 'AWS::Probe::Widget',
    schema: {
      createOnlyProperties: ['/properties/Name'],
      properties: {
        Name: {},
        PreAllocatedStorageHint: {},
        StorageTypeOverride: {},
        PreAllocatedStorage: {},
      },
    },
    expected: null,
  },
  {
    label: 'a property name merely CONTAINING `DeletionProtection` does not fire',
    typeName: 'AWS::Probe::Widget',
    schema: {
      createOnlyProperties: ['/properties/Name'],
      properties: { Name: {}, DeletionProtectionPolicyArn: {}, HasDeletionProtection: {} },
    },
    expected: null,
  },
  {
    label: 'a property name merely CONTAINING `EncryptionAtRest` does not fire',
    typeName: 'AWS::Probe::Widget',
    schema: {
      createOnlyProperties: ['/properties/Name'],
      properties: { Name: {}, EncryptionAtRestOptionsArn: {}, RequireEncryptionAtRest: {} },
    },
    expected: null,
  },
  {
    label:
      'a type name CONTAINING a data-store noun before its last segment does not fire — the ' +
      'noun pattern is anchored on the END, and without the `$` `TableViewer` matches `Table`',
    typeName: 'AWS::Probe::TableViewer',
    schema: { createOnlyProperties: ['/properties/Name'], properties: { Name: {} } },
    expected: null,
  },
  {
    label:
      'the noun signal reads the LAST segment, not the whole type name — a SERVICE called ' +
      '`Table` must not make every one of its types a candidate',
    typeName: 'AWS::Table::Widget',
    schema: { createOnlyProperties: ['/properties/Name'], properties: { Name: {} } },
    expected: null,
  },
  {
    label:
      'a schema firing several signals reports ALL of them, sorted — a classifier that kept ' +
      'only the first would pass every single-signal case here',
    typeName: 'AWS::Probe::ThingCluster',
    schema: {
      createOnlyProperties: ['/properties/Name'],
      properties: { Name: {}, SnapshotWindow: {}, AllocatedStorage: {}, RetentionPeriod: {} },
    },
    expected: ['data-store-noun', 'retention-window', 'snapshot-or-backup', 'storage-capacity'],
  },
  {
    label:
      'a configuration-container noun does not fire — `Group` / `Environment` / `Pool` / ' +
      '`Queue` are deliberately outside the noun list',
    typeName: 'AWS::Probe::DeploymentGroup',
    schema: {
      createOnlyProperties: ['/properties/Name'],
      properties: { Name: {}, ServiceRoleArn: {} },
    },
    expected: null,
  },
  {
    label:
      "the LOOKUP name decides the noun signal, not the schema's own `typeName` — a stale or " +
      'hand-edited cache entry must not move a signal onto a different type',
    typeName: 'AWS::Probe::DeploymentGroup',
    schema: {
      typeName: 'AWS::Probe::ThingVault',
      createOnlyProperties: ['/properties/Name'],
      properties: { Name: {} },
    },
    expected: null,
  },
];

/**
 * Run {@link SELF_PROBE_CASES}, returning the labels that disagreed with their
 * expected verdict. An empty array is the only acceptable result.
 *
 * Exported so the unit test can call it directly; `CDKD_SELF_PROBE_FORCE_FAIL=1`
 * is the seam proving the BINARY still consults it (a `main()` that dropped the
 * call would otherwise be unobservable from the unit test).
 */
export function runSelfProbe(): string[] {
  const failures: string[] = [];
  if (process.env.CDKD_SELF_PROBE_FORCE_FAIL === '1') {
    failures.push('forced failure via CDKD_SELF_PROBE_FORCE_FAIL');
  }
  // An EMPTY guard list, so a probe's verdict never depends on what
  // STATEFUL_TYPES happens to contain today.
  const empty = new Set<string>();
  for (const probe of SELF_PROBE_CASES) {
    const got = classifyCandidate(probe.typeName, probe.schema, empty);
    if (probe.expected === null) {
      if (got !== undefined) {
        failures.push(`${probe.label} — expected NOT a candidate, got [${got.signals.join(', ')}]`);
      }
      continue;
    }
    if (got === undefined) {
      failures.push(`${probe.label} — expected [${probe.expected.join(', ')}], got NOT a candidate`);
      continue;
    }
    if (got.signals.join(',') !== [...probe.expected].sort().join(',')) {
      failures.push(
        `${probe.label} — expected [${probe.expected.join(', ')}], got [${got.signals.join(', ')}]`
      );
    }
  }
  return failures;
}

/** Read the tier-2 list from the provider-coverage cache. */
export function loadTier2(path: string = COVERAGE_JSON): string[] {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as { tier2?: readonly string[] };
  // DEDUPED as defence in depth. `provider-coverage.json`'s `tier2` array used
  // to carry `AWS::Logs::LogStream` TWICE (1372 entries, 1371 distinct, with
  // its own `summary.tier2Count` reporting the inflated figure) because
  // `partitionCoverage` walked `ListTypes` output straight into the tier
  // arrays. Left as-is, the duplicate is described twice, counted twice in
  // `withCreateOnly`, and — if it were ever a candidate — proposed twice,
  // asking the disposition fence for the same decision twice. Issue [#2571]
  // fixed it at the producer, so this guard is now redundant rather than
  // load-bearing; it stays because a consumer that assumes its input is a set
  // should say so, and it costs one `Set` construction.
  const tier2 = [...new Set(parsed.tier2 ?? [])];
  if (tier2.length === 0) {
    throw new Error(
      `No tier2 entries found in ${path}. ` +
        `Regenerate the audit with \`vp run audit:coverage:regenerate\` first.`
    );
  }
  return [...tier2].sort();
}

/** Cache path for one type's raw registry schema. */
export function schemaCachePath(typeName: string, dir: string = SCHEMA_CACHE_DIR): string {
  return resolve(dir, `${typeName.replace(/::/g, '-')}.json`);
}

function isThrottlingError(err: unknown): boolean {
  if (err instanceof Error) {
    const name = err.name;
    return name === 'Throttling' || name === 'ThrottlingException';
  }
  return false;
}

export type Sleep = (ms: number) => Promise<void>;
const defaultSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Minimal CloudFormation client surface this script needs. */
export interface CfnClientLike {
  send(command: DescribeTypeCommand): Promise<{ Schema?: string }>;
}

/**
 * `DescribeType` for one type, returning the raw `Schema` document string,
 * retrying throttle-shaped failures with exponential backoff. Mirrors
 * `describeTypeWithRetry` in `scripts/audit-provider-coverage.ts`; kept
 * separate because that one returns `ProvisioningType` and discards the schema
 * this derivation exists to read.
 */
export async function describeSchemaWithRetry(
  client: CfnClientLike,
  typeName: string,
  options: { retryDelaysMs?: readonly number[]; sleep?: Sleep } = {}
): Promise<string | undefined> {
  const delays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const sleep = options.sleep ?? defaultSleep;
  let attempt = 0;
  while (true) {
    try {
      const resp = await client.send(
        new DescribeTypeCommand({ Type: 'RESOURCE', TypeName: typeName })
      );
      return resp.Schema;
    } catch (err) {
      if (isThrottlingError(err) && attempt < delays.length) {
        const delayMs = delays[attempt] ?? 1000;
        await sleep(delayMs);
        attempt++;
        continue;
      }
      throw err;
    }
  }
}

/**
 * Build the report from schemas already on disk. Pure apart from the reads, so
 * a signal change is re-derivable offline in seconds against the cache.
 */
export function deriveReport(
  tier2: readonly string[],
  readSchema: (typeName: string) => RegistrySchema | undefined,
  guardList: ReadonlySet<string> = STATEFUL_TYPES
): StatefulCandidateReport {
  const candidates: StatefulCandidate[] = [];
  const unreadable: string[] = [];
  let schemasRead = 0;
  let withCreateOnly = 0;
  let schemasWithNoProperties = 0;
  for (const typeName of tier2) {
    const schema = readSchema(typeName);
    if (schema === undefined) {
      unreadable.push(typeName);
      continue;
    }
    schemasRead++;
    if (topLevelPropertyNames(schema).length === 0) {
      schemasWithNoProperties++;
    }
    if ((schema.createOnlyProperties ?? []).length > 0) {
      withCreateOnly++;
    }
    const candidate = classifyCandidate(typeName, schema, guardList);
    if (candidate !== undefined) {
      candidates.push(candidate);
    }
  }
  candidates.sort((a, b) => a.typeName.localeCompare(b.typeName));
  unreadable.sort();

  const signalCounts: Record<string, number> = {};
  for (const signal of STATEFUL_SIGNALS) {
    signalCounts[signal.key] = candidates.filter((c) => c.signals.includes(signal.key)).length;
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    summary: {
      tier2Count: tier2.length,
      schemasRead,
      withCreateOnly,
      schemasWithNoProperties,
      candidateCount: candidates.length,
      guardedCount: candidates.filter((c) => c.guarded).length,
      unguardedCount: candidates.filter((c) => !c.guarded).length,
      signalCounts,
    },
    candidates,
    unreadable,
  };
}

/**
 * Undispositioned candidates: proposed by the derivation, absent from the
 * guard list, and absent from {@link NOT_GUARDED}. This is what `--check` and
 * the unit fence both fail on.
 */
export function undispositioned(
  report: StatefulCandidateReport,
  guardList: ReadonlySet<string> = STATEFUL_TYPES,
  notGuarded: ReadonlyMap<string, string> = NOT_GUARDED
): string[] {
  return report.candidates
    .filter((c) => !guardList.has(c.typeName) && !notGuarded.has(c.typeName))
    .map((c) => c.typeName)
    .sort();
}

/**
 * {@link NOT_GUARDED} entries the current derivation no longer proposes. An
 * entry that stopped being a candidate is inert: it disposes of nothing, and
 * it would silently absorb a future type of the same name.
 */
export function staleNotGuardedEntries(
  report: StatefulCandidateReport,
  notGuarded: ReadonlyMap<string, string> = NOT_GUARDED
): string[] {
  const proposed = new Set(report.candidates.map((c) => c.typeName));
  return [...notGuarded.keys()].filter((t) => !proposed.has(t)).sort();
}

/**
 * Floor and signal-bound violations in a report, as human-readable lines.
 *
 * Checked on the REPORT rather than inside the derivation so `--check` applies
 * the same bounds to the committed artifact that `--regenerate` applied when it
 * was written: a hand-edited or truncated JSON is exactly the input a fence
 * reading only its `candidates` array would accept.
 */
export function floorViolations(report: StatefulCandidateReport): string[] {
  const out: string[] = [];
  const s = report.summary;
  // INTERNAL CONSISTENCY FIRST. Every floor below reads `summary`, so a report
  // whose `candidates` array was truncated while the summary was left alone
  // clears all of them — and `--check`'s disposition sweep walks the truncated
  // array, so it passes too. That is the exact hand-edit the floors claim to
  // defend against, and it was green until review measured it.
  if (report.candidates.length !== s.candidateCount) {
    out.push(
      `summary.candidateCount ${s.candidateCount} disagrees with the ${report.candidates.length} ` +
        `candidate(s) actually in the report`
    );
  }
  const guarded = report.candidates.filter((c) => c.guarded).length;
  if (guarded !== s.guardedCount || report.candidates.length - guarded !== s.unguardedCount) {
    out.push(
      `summary guarded/unguarded ${s.guardedCount}/${s.unguardedCount} disagrees with the ` +
        `candidates' own flags ${guarded}/${report.candidates.length - guarded}`
    );
  }
  if (s.tier2Count - s.schemasRead !== report.unreadable.length) {
    out.push(
      `tier2Count ${s.tier2Count} minus schemasRead ${s.schemasRead} is ` +
        `${s.tier2Count - s.schemasRead}, but ${report.unreadable.length} type(s) are listed ` +
        `unreadable — a type that is neither read nor listed has been dropped silently`
    );
  }
  if (s.schemasWithNoProperties > FLOORS.maxSchemasWithNoProperties) {
    out.push(
      `${s.schemasWithNoProperties} schema(s) parsed but declare no top-level properties, over ` +
        `the ceiling ${FLOORS.maxSchemasWithNoProperties} — a truncated cache file reads as a ` +
        `cleared type, so re-run with --regenerate --refetch`
    );
  }
  if (s.withCreateOnly > s.schemasRead) {
    out.push(`withCreateOnly ${s.withCreateOnly} exceeds schemasRead ${s.schemasRead}`);
  }
  if (s.candidateCount > s.withCreateOnly) {
    out.push(`candidateCount ${s.candidateCount} exceeds withCreateOnly ${s.withCreateOnly}`);
  }
  if (s.tier2Count < FLOORS.tier2) {
    out.push(`tier2Count ${s.tier2Count} is below the floor ${FLOORS.tier2}`);
  }
  if (s.schemasRead < FLOORS.schemasRead) {
    out.push(`schemasRead ${s.schemasRead} is below the floor ${FLOORS.schemasRead}`);
  }
  if (s.withCreateOnly < FLOORS.withCreateOnly) {
    out.push(`withCreateOnly ${s.withCreateOnly} is below the floor ${FLOORS.withCreateOnly}`);
  }
  if (s.candidateCount < FLOORS.candidates) {
    out.push(`candidateCount ${s.candidateCount} is below the floor ${FLOORS.candidates}`);
  }
  const ceiling = Math.floor(s.withCreateOnly * SIGNAL_BOUNDS.maxShareOfCreateOnlyTypes);
  for (const signal of STATEFUL_SIGNALS) {
    const count = s.signalCounts[signal.key] ?? 0;
    if (count < SIGNAL_BOUNDS.minCandidatesPerSignal) {
      out.push(
        `signal \`${signal.key}\` fired on ${count} types — it disposes of nothing and is inert`
      );
    }
    if (count > ceiling) {
      out.push(
        `signal \`${signal.key}\` fired on ${count} of ${s.withCreateOnly} types with a ` +
          `createOnly property, over the ceiling ${ceiling} — a signal that fires on ` +
          `everything makes the review queue unreadable`
      );
    }
  }
  return out;
}

export function renderMarkdown(report: StatefulCandidateReport): string {
  const lines: string[] = [];
  lines.push('---');
  lines.push('title: "Tier-2 stateful candidates"');
  lines.push('unlisted: true');
  lines.push('---');
  lines.push('');
  lines.push('# Tier-2 Stateful Candidates');
  lines.push('');
  lines.push(
    'Auto-generated by `scripts/audit-stateful-candidates.ts` (issue #2553). Do not ' +
      'edit by hand; re-run the script to regenerate.'
  );
  lines.push('');
  lines.push(
    'A **candidate** is a tier-2 CloudFormation resource type — no cdkd SDK provider, ' +
      'so a replacement routes through Cloud Control API — whose registry schema ' +
      'declares at least one `createOnlyProperties` entry (so a rename is a ' +
      'property-driven replacement a plain `cdkd deploy` reaches with no flag) AND on ' +
      'which at least one data-bearing signal fires. Candidacy is a proposal for ' +
      'review, not a verdict: each one must end up either in `STATEFUL_TYPES` or in ' +
      "the script's `NOT_GUARDED` map with a reason, and " +
      '`tests/unit/scripts/stateful-candidates.test.ts` fails on any that is in neither.'
  );
  lines.push('');
  lines.push(`- Generated: \`${report.generatedAt}\``);
  lines.push(`- Schema version: ${report.schemaVersion}`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push('| Measure | Count |');
  lines.push('|---------|-------|');
  lines.push(`| Tier-2 types considered | ${report.summary.tier2Count} |`);
  lines.push(`| Registry schemas read | ${report.summary.schemasRead} |`);
  lines.push(`| ...of which declare a createOnly property | ${report.summary.withCreateOnly} |`);
  lines.push(
    `| Schemas declaring no top-level properties | ${report.summary.schemasWithNoProperties} |`
  );
  lines.push(`| ...and fire a data-bearing signal (**candidates**) | ${report.summary.candidateCount} |`);
  lines.push(`| Candidates already guarded | ${report.summary.guardedCount} |`);
  lines.push(`| Candidates not guarded | ${report.summary.unguardedCount} |`);
  lines.push(`| Schemas unreadable (excluded, NOT cleared) | ${report.unreadable.length} |`);
  lines.push('');
  lines.push('## Signals');
  lines.push('');
  lines.push('| Signal | Candidates | What firing claims |');
  lines.push('|--------|-----------:|--------------------|');
  for (const signal of STATEFUL_SIGNALS) {
    lines.push(
      `| \`${signal.key}\` | ${report.summary.signalCounts[signal.key] ?? 0} | ${escapeCell(signal.rationale)} |`
    );
  }
  lines.push('');
  lines.push('## Candidates');
  lines.push('');
  lines.push('| Type | Guarded | Signals | createOnly properties |');
  lines.push('|------|---------|---------|-----------------------|');
  for (const c of report.candidates) {
    const createOnly = c.createOnlyProperties
      .map((p) => `\`${p.replace(/^\/properties\//, '')}\``)
      .join(', ');
    // Escaped even though a type name and a JSON-pointer property name are
    // STRUCTURAL, not prose. The split that decides escaping is PROVENANCE, and
    // these two are the only cells in any generator whose value arrives from an
    // AWS API rather than from this repository: both are read off a
    // `cloudformation:DescribeType` response, which for a tier-2 type includes
    // THIRD-PARTY public-registry schemas. The only thing keeping a `|` out of
    // them is the provider meta-schema's `^[A-Za-z0-9]{1,64}$` on property
    // names — a constraint enforced remotely, by a service this repo does not
    // control and cannot re-check. `tests/unit/scripts/table-cell-escape.test.ts`
    // pins both sites by name for that reason.
    lines.push(
      `| \`${escapeCell(c.typeName)}\` | ${c.guarded ? 'yes' : '**no**'} | ${c.signals.join(', ')} | ${escapeCell(createOnly)} |`
    );
  }
  lines.push('');
  if (report.unreadable.length > 0) {
    lines.push('## Unreadable schemas');
    lines.push('');
    lines.push(
      '`DescribeType` did not return a schema for these. They are excluded from the ' +
        'derivation and are NOT a clean result — re-run the regeneration to settle them.'
    );
    lines.push('');
    for (const t of report.unreadable) {
      lines.push(`- \`${t}\``);
    }
    lines.push('');
  }
  return lines.join('\n');
}

export function atomicWriteFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  try {
    writeFileSync(tmp, content);
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // ignore — the original error is what the caller needs
    }
    throw err;
  }
}

export function loadCachedReport(path: string = OUTPUT_JSON): StatefulCandidateReport {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as StatefulCandidateReport;
  if (parsed.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(
      `cached report schema version ${parsed.schemaVersion} does not match ` +
        `expected ${SCHEMA_VERSION}; re-run with --regenerate`
    );
  }
  return parsed;
}

export function renderSummaryToStdout(report: StatefulCandidateReport): string {
  const lines: string[] = [];
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Tier-2 types considered:      ${report.summary.tier2Count}`);
  lines.push(`Registry schemas read:        ${report.summary.schemasRead}`);
  lines.push(`With a createOnly property:   ${report.summary.withCreateOnly}`);
  lines.push(`Schemas with no properties:   ${report.summary.schemasWithNoProperties}`);
  lines.push(`Candidates:                   ${report.summary.candidateCount}`);
  lines.push(`  guarded:                    ${report.summary.guardedCount}`);
  lines.push(`  not guarded:                ${report.summary.unguardedCount}`);
  lines.push(`Unreadable schemas:           ${report.unreadable.length}`);
  return lines.join('\n');
}

/** Read a cached raw schema, or `undefined` if it is absent or unparseable. */
export function readCachedSchema(
  typeName: string,
  dir: string = SCHEMA_CACHE_DIR
): RegistrySchema | undefined {
  try {
    return coerceRegistrySchema(JSON.parse(readFileSync(schemaCachePath(typeName, dir), 'utf8')));
  } catch {
    return undefined;
  }
}

/**
 * Accept only the shapes this derivation can read, and return `undefined` for
 * anything else so the type lands in `unreadable` rather than in a verdict.
 *
 * The cast this replaces was load-bearing in the wrong direction: a cached
 * schema whose `createOnlyProperties` is a STRING spreads character by
 * character in {@link classifyCandidate}, manufacturing a non-empty createOnly
 * list out of a malformed document — a candidate proposed on nothing. A
 * truncated or half-written cache file is the realistic source, and it is
 * exactly what an interrupted `--regenerate` leaves behind.
 */
export function coerceRegistrySchema(value: unknown): RegistrySchema | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  const createOnly = raw['createOnlyProperties'];
  if (createOnly !== undefined) {
    if (!Array.isArray(createOnly) || createOnly.some((e) => typeof e !== 'string')) {
      return undefined;
    }
  }
  const properties = raw['properties'];
  if (properties !== undefined) {
    if (typeof properties !== 'object' || properties === null || Array.isArray(properties)) {
      return undefined;
    }
  }
  const typeName = raw['typeName'];
  if (typeName !== undefined && typeof typeName !== 'string') {
    return undefined;
  }
  return raw as RegistrySchema;
}

async function fetchSchemas(tier2: readonly string[], refetch: boolean): Promise<void> {
  mkdirSync(SCHEMA_CACHE_DIR, { recursive: true });
  const cached = new Set(readdirSync(SCHEMA_CACHE_DIR));
  const pending = refetch
    ? [...tier2]
    : tier2.filter((t) => !cached.has(`${t.replace(/::/g, '-')}.json`));
  if (pending.length === 0) {
    console.error(`[stateful-candidates] all ${tier2.length} schemas already cached`);
    return;
  }
  console.error(
    `[stateful-candidates] fetching ${pending.length} registry schemas ` +
      `(${tier2.length - pending.length} already cached)...`
  );
  const client = getAwsClients().cloudFormation;
  const limit = pLimit(DEFAULT_CONCURRENCY);
  let done = 0;
  try {
    await Promise.all(
      pending.map((typeName) =>
        limit(async () => {
          try {
            const schema = await describeSchemaWithRetry(client, typeName);
            if (schema !== undefined) {
              // Write the raw document; the derivation parses it separately so
              // a signal change never needs another AWS call.
              atomicWriteFile(schemaCachePath(typeName), schema);
            } else {
              console.error(`[stateful-candidates] no Schema returned for ${typeName}`);
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`[stateful-candidates] DescribeType failed for ${typeName}: ${msg}`);
          }
          done++;
          if (done % 25 === 0 || done === pending.length) {
            console.error(`[stateful-candidates] DescribeType: ${done}/${pending.length}`);
          }
        })
      )
    );
  } finally {
    client.destroy();
  }
}

function writeReport(report: StatefulCandidateReport): void {
  atomicWriteFile(OUTPUT_JSON, JSON.stringify(report, null, 2) + '\n');
  atomicWriteFile(OUTPUT_MARKDOWN, renderMarkdown(report));
  console.error('[stateful-candidates] wrote:');
  console.error(`  ${OUTPUT_JSON}`);
  console.error(`  ${OUTPUT_MARKDOWN}`);
  console.error(renderSummaryToStdout(report));
}

async function regenerate(refetch: boolean): Promise<void> {
  const tier2 = loadTier2();
  await fetchSchemas(tier2, refetch);
  writeReport(deriveReport(tier2, readCachedSchema));
}

/** Offline re-derivation from the schema cache — no AWS calls. */
function rederive(): void {
  writeReport(deriveReport(loadTier2(), readCachedSchema));
}

export function check(jsonPath: string = OUTPUT_JSON): void {
  let report: StatefulCandidateReport;
  try {
    report = loadCachedReport(jsonPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[stateful-candidates] cannot read cached report: ${msg}`);
    console.error(
      '[stateful-candidates] run `node scripts/audit-stateful-candidates.ts --regenerate` first'
    );
    process.exitCode = 1;
    return;
  }
  // `loadCachedReport` only validates `schemaVersion`, so a report missing
  // `summary` or `candidates` entirely reaches here and would crash out of
  // `floorViolations` with a raw TypeError — non-zero, but naming neither the
  // problem nor the remedy.
  if (
    typeof report.summary !== 'object' ||
    report.summary === null ||
    // `signalCounts` specifically: `floorViolations` indexes it per signal, so
    // a summary missing THAT field throws the exact raw TypeError this guard
    // exists to replace — measured, with the object check alone in place.
    typeof report.summary.signalCounts !== 'object' ||
    report.summary.signalCounts === null ||
    !Array.isArray(report.candidates) ||
    !Array.isArray(report.unreadable)
  ) {
    console.error(
      '[stateful-candidates] the cached report is missing `summary`, `candidates` or ' +
        '`unreadable`; re-run with --regenerate'
    );
    process.exitCode = 1;
    return;
  }
  const floors = floorViolations(report);
  for (const line of floors) {
    console.error(`[stateful-candidates] ${line}`);
  }
  const missing = undispositioned(report);
  const stale = staleNotGuardedEntries(report);
  if (missing.length > 0) {
    console.error(
      `[stateful-candidates] ${missing.length} candidate(s) are neither in STATEFUL_TYPES ` +
        `nor in NOT_GUARDED:`
    );
    for (const t of missing) {
      console.error(`  ${t}`);
    }
  }
  if (stale.length > 0) {
    console.error(
      `[stateful-candidates] ${stale.length} NOT_GUARDED entr(y|ies) are no longer proposed ` +
        `by the derivation and dispose of nothing:`
    );
    for (const t of stale) {
      console.error(`  ${t}`);
    }
  }
  if (missing.length > 0 || stale.length > 0 || floors.length > 0) {
    process.exitCode = 1;
    return;
  }
  console.log(
    `[stateful-candidates] OK — all ${report.summary.candidateCount} candidates dispositioned`
  );
}

const USAGE = `Usage: node scripts/audit-stateful-candidates.ts [MODE] [--refetch]

Modes (at most one):
  (none)        print the summary of the committed report
  --regenerate  fetch missing tier-2 registry schemas from AWS, then derive
  --rederive    re-derive offline from the cached schemas (no AWS calls)
  --check       fail if a candidate is undispositioned or an entry went stale
  --help        print this and exit 0

  --refetch     with --regenerate only: re-fetch every schema, ignoring the cache`;

/**
 * Reject anything outside the known argument set, and reject two modes at once.
 *
 * Not defensive tidiness: the sibling critics `refresh-cfn-schemas.mjs` and
 * `gen-nested-key-coverage.ts` both carry this guard because a `--chekc` typo
 * fell through to a NON-checking path and exited 0 — in one case rewriting the
 * committed matrix it was meant to validate. This script's `--check` is a CI
 * step, so the same typo in `vite.config.ts` or `ci.yml` would make the critic
 * a no-op that reports success. `--refetch` is rejected without `--regenerate`
 * for the same reason: alone it is a silent no-op that reads as a re-fetch.
 *
 * Returns the error text, or `undefined` when the arguments are usable.
 */
export function validateArgs(args: readonly string[]): string | undefined {
  const known = new Set(['--regenerate', '--rederive', '--check', '--refetch', '--help']);
  const unknown = args.filter((a) => !known.has(a));
  if (unknown.length > 0) {
    return `unknown argument(s): ${unknown.join(', ')}`;
  }
  // `--help` counts as a mode: `--check --help` printed usage and exited 0
  // WITHOUT checking anything, which is the guard's own failure class one
  // spelling over.
  const modes = args.filter((a) => a !== '--refetch');
  if (modes.length > 1) {
    return `at most one mode may be given, got: ${modes.join(', ')}`;
  }
  if (args.includes('--refetch') && !args.includes('--regenerate')) {
    return '--refetch is only meaningful with --regenerate';
  }
  return undefined;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const argError = validateArgs(args);
  if (argError !== undefined) {
    console.error(`[stateful-candidates] ${argError}`);
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  if (args.includes('--help')) {
    console.log(USAGE);
    return;
  }
  // Before anything reads the tree or the network: a classifier that has
  // collapsed toward "everything is a candidate" produces LARGER numbers, so no
  // floor can see it.
  const probeFailures = runSelfProbe();
  if (probeFailures.length > 0) {
    console.error('[stateful-candidates] self-probe FAILED — the classifier is not trustworthy:');
    for (const line of probeFailures) {
      console.error(`  ${line}`);
    }
    process.exitCode = 1;
    return;
  }
  if (args.includes('--regenerate')) {
    await regenerate(args.includes('--refetch'));
    return;
  }
  if (args.includes('--rederive')) {
    rederive();
    return;
  }
  if (args.includes('--check')) {
    check();
    return;
  }
  try {
    console.log(renderSummaryToStdout(loadCachedReport()));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[stateful-candidates] cannot read cached report: ${msg}`);
    console.error(
      '[stateful-candidates] run `node scripts/audit-stateful-candidates.ts --regenerate` first'
    );
    process.exitCode = 1;
  }
}

// Only run the CLI when invoked directly, so the unit test can import the
// pure functions above without triggering AWS calls or file writes.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(__filename)) {
  await main();
}
