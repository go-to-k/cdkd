/**
 * Stateful-resource guard list (issue [#615]).
 *
 * `--recreate-via-cc-api <LogicalId>` destroys + recreates the named
 * resource in one deploy so a previously-silent-dropped top-level CFn
 * property reaches AWS via Cloud Control API. For most types this is
 * safe — destroying + recreating an IAM Role or a Lambda Function
 * loses no user data — but for **data-bearing** types the destroy
 * cycle loses everything in the resource: rows in a DynamoDB table,
 * objects in an S3 bucket, log lines in a LogGroup, images in an ECR
 * repository, etc.
 *
 * To avoid an accidental data-loss footgun, cdkd refuses to recreate
 * any resource whose type is in {@link STATEFUL_TYPES} unless the user
 * ALSO passes `--force-stateful-recreation`. On the `--recreate-via-*`
 * and `--replace` opt-ins that is a two-flag protection, mirroring
 * `--remove-protection`'s pattern (see
 * `src/cli/commands/destroy-runner.ts`). It is NOT only that shape any
 * more: the guard also runs on replacement paths a plain `cdkd deploy`
 * reaches with no flag at all (a property-driven replacement, and the
 * update-failure fallback's Cloud Control trigger — issue [#2514]),
 * where `--force-stateful-recreation` is the ONLY flag involved. See
 * {@link isStatefulRecreateTargetForReplace} for the mid-deploy variant
 * those paths use.
 *
 * The list is hand-curated and intentionally **conservative**: every
 * type here carries user data that the AWS service does NOT
 * automatically migrate to the replacement resource. Types that the
 * AWS service treats as ephemeral (e.g. Lambda Function, IAM Role)
 * are NOT in this list — recreate is cheap.
 *
 * Two entries carry a CONDITION instead of counting unconditionally.
 * The condition is what the guard evaluates; failing it is not a
 * finding that the resource holds no data (see the LogGroup note):
 *
 *   - `AWS::S3::Bucket`: empty buckets are safe to recreate. The
 *     deploy engine probes `s3:ListObjectVersions` at plan time and only
 *     refuses when the bucket has at least one object.
 *   - `AWS::Logs::LogGroup`: a log group holding no log events is safe
 *     to recreate, and RETENTION IS NOT THE SIGNAL FOR THAT (issue
 *     [#2558]). An unset or zero `RetentionInDays` is CloudWatch Logs'
 *     "never expire" — the most data-bearing configuration the type
 *     has, and what `LogsLogGroupProvider` records `0` for — so reading
 *     it as "holds nothing" destroyed years of events on a plain
 *     `cdkd deploy`. A `RetentionInDays > 0` recorded in EITHER of the
 *     state record's property bags still answers `has-retention` from
 *     the bags alone (a cheap positive, never probed away); every other
 *     bag DEFERS, exactly as the bucket does. Which bags, and why the
 *     value is coerced rather than type-tested, is issue [#2521] —
 *     see {@link logGroupHasPositiveRetention}.
 *     The pre-flight resolves the deferral with a live
 *     `logs:DescribeLogStreams` probe (a log group with no stream can
 *     hold no event, since every event belongs to a stream); mid-deploy,
 *     where no probe can run, it resolves to `has-log-events`.
 *
 * Both conditional checks live in {@link isStatefulRecreateTargetSync};
 * the bare {@link STATEFUL_TYPES} set is the type-only first-cut.
 *
 * **Lower bound, enforced by a test** (issue [#2514]'s review round):
 * every type in `final-snapshot.ts`'s `ATOMIC_FINAL_SNAPSHOT_TYPES` ∪
 * `PRE_DELETE_SNAPSHOT_TYPES` must appear here. That union is the
 * CloudFormation-documented `DeletionPolicy: Snapshot`-capable list, and
 * CloudFormation permits the attribute exactly where deleting the resource
 * destroys data worth capturing first — so membership there is an
 * AWS-authored statement that the type is data-bearing. The types that were
 * in that union and NOT here (`AWS::Redshift::Cluster`,
 * `AWS::ElastiCache::ReplicationGroup`, `AWS::ElastiCache::CacheCluster`)
 * meant cdkd took a final snapshot before a `cdkd destroy` of them
 * while replacing them mid-deploy with no consent flag at all.
 * `tests/unit/provisioning/stateful-types.test.ts` pins the subset
 * relation so a future addition to either snapshot set cannot land without
 * the guard entry.
 *
 * The relation is deliberately ONE-directional: most data-bearing types
 * (S3, DynamoDB, LogGroup, ECR, …) have no snapshot API at all and
 * CloudFormation rejects `DeletionPolicy: Snapshot` on them, so this set is
 * a strict superset and the reverse containment would be wrong.
 *
 * **Second lower bound, also enforced by a test**: every resource type
 * registered to a provider whose `delete()` consults
 * `DeleteContext.forceDataDelete` must appear here. That field is set ONLY
 * by the replacement / recreate delete sites under
 * `--force-stateful-recreation`, so a provider reading it has already
 * declared its delete destroys user data — which makes the guard list's
 * agreement checkable rather than hand-curated.
 * `AWS::S3Express::DirectoryBucket` was the one type on the wrong side.
 *
 * **Third bound, and the first that reads the population the other two are
 * blind to** (issue [#2553]): both bounds above are derived from
 * `src/provisioning/providers/**` and `register-providers.ts`, so both can
 * only see types cdkd has an SDK PROVIDER for — 134 of them, against the
 * 1371 tier-2 types that have none and whose replacement routes through
 * Cloud Control's DELETE. That is the population issue [#2514] was filed
 * about, and until now it had never been swept.
 * `scripts/audit-stateful-candidates.ts` reads every tier-2 type's
 * CloudFormation registry schema and PROPOSES the ones that declare a
 * createOnly property (so a rename is a replacement a plain `cdkd deploy`
 * reaches with no flag) AND fire a data-bearing signal. Each proposal must
 * end up either on this list or in that script's `NOT_GUARDED` map with a
 * reason; `tests/unit/scripts/stateful-candidates.test.ts` fails on any that
 * is in neither, and on a `NOT_GUARDED` entry the derivation has stopped
 * proposing. Unlike the two bounds above the signals are HEURISTIC — no AWS
 * artifact states "deleting this destroys user data" — so this bound makes
 * the widening CHECKABLE rather than proven, which is the property a hand
 * pass over 1371 types could not have.
 *
 * Neither fence can see a provider whose delete destroys data with NO opt-in
 * at all — an unconditional empty (`S3TablesProvider.deleteTableBucket`,
 * `S3VectorsProvider.deleteVectorBucket`) or a plainly destructive API call
 * (`KMSProvider`'s `ScheduleKeyDeletion`,
 * `CodeCommitRepositoryProvider`'s `DeleteRepository`). Those types are
 * hand-added with the reason at the entry, and a provider added that way
 * should be reviewed for whether it wants a `forceDataDelete` gate too.
 */

// A `.ts` extension, deliberately, against this repo's ordinary `.js` rule.
// `scripts/audit-stateful-candidates.ts` imports `STATEFUL_TYPES` and runs
// under BARE `node` (Node 24 strips the types), where module resolution is
// literal: a `./dynamodb-warm-throughput.js` specifier resolves to a file that
// does not exist and the whole audit dies with `ERR_MODULE_NOT_FOUND` — which
// is how this landed, as three red cases in
// `tests/unit/scripts/stateful-candidates.test.ts` rather than as a type
// error. `src/utils/aws-clients.ts` and `src/utils/aws-client-defaults.ts`
// carry the same spelling for the same reason: they are the other two src
// modules on a `scripts/` entrypoint's import closure. The target is a LEAF
// (no imports of its own), so this closure ends here.
import { toFiniteNumber } from './dynamodb-warm-throughput.ts';

export const STATEFUL_TYPES: ReadonlySet<string> = new Set([
  // Database / storage primaries (data-bearing core).
  'AWS::RDS::DBInstance',
  'AWS::RDS::DBCluster',
  'AWS::DocDB::DBInstance',
  'AWS::DocDB::DBCluster',
  'AWS::Neptune::DBInstance',
  'AWS::Neptune::DBCluster',
  'AWS::DynamoDB::Table',
  'AWS::DynamoDB::GlobalTable',
  // Data warehouse. A Redshift cluster's tables live on the cluster's own
  // nodes; DELETE + CREATE starts an empty warehouse and AWS migrates
  // nothing. CloudFormation supports `DeletionPolicy: Snapshot` on it and
  // cdkd implements that snapshot (`PRE_DELETE_SNAPSHOT_TYPES`), which is
  // the same statement about the data made from the destroy side.
  'AWS::Redshift::Cluster',
  // In-memory data stores. Both are `always`, not conditional: Redis /
  // Valkey persist their dataset (RDB / AOF, and the automatic-backup
  // window CFn's Snapshot policy captures), so a recreate loses real data,
  // and even a pure Memcached cache comes back cold — the replacement
  // starts empty and AWS migrates nothing. Both carry a CFn-documented
  // `DeletionPolicy: Snapshot` (CacheCluster atomically at delete,
  // ReplicationGroup via cdkd's pre-delete snapshot), so the destroy path
  // already treats them as data-bearing.
  'AWS::ElastiCache::CacheCluster',
  'AWS::ElastiCache::ReplicationGroup',
  // Filesystem / blob.
  'AWS::EFS::FileSystem',
  'AWS::FSx::FileSystem',
  'AWS::S3::Bucket', // conditional — see isStatefulRecreateTargetSync
  // S3 Express directory bucket. `S3DirectoryBucketProvider.delete` consumes
  // `DeleteContext.forceDataDelete` and the CDK `autoDeleteObjects` tag
  // (issue [#1344], the sibling of the general-purpose bucket's [#1340]
  // guard), so the repo already classifies this type as data-bearing on the
  // DESTROY side — it was the only such type absent from this list. `always`,
  // not conditional like `AWS::S3::Bucket`, because of the probe cdkd HAS:
  // `recreate-targets.ts` issues `ListObjectVersions`, a general-purpose-bucket
  // API, so no CURRENT probe can report a directory bucket empty. Note the
  // narrow claim — a probe is not impossible in principle, since
  // `S3DirectoryBucketProvider.emptyBucket` enumerates these same buckets with
  // `ListObjectsV2`. Until one is wired into the pre-flight, an unprovable
  // emptiness must not read as empty, which is stricter than its
  // general-purpose sibling gets there and deliberately so.
  'AWS::S3Express::DirectoryBucket',
  // S3 Tables. `S3TablesProvider.deleteTableBucket` calls `emptyTableBucket`
  // UNCONDITIONALLY — no `forceDataDelete`, no tag opt-in — which walks every
  // namespace and `DeleteTable`s every table in it. So a replacement of the
  // BUCKET destroys every Iceberg table it holds with no flag at all, and a
  // replacement of a TABLE starts an empty one (an S3 Tables table holds the
  // rows themselves, unlike the `AWS::Glue::Table` catalog entry already on
  // this list).
  'AWS::S3Tables::TableBucket',
  'AWS::S3Tables::Table',
  // `AWS::S3Tables::Namespace` is here on the FAIL-SAFE side of an OPEN
  // question rather than on a proof, and the distinction matters because an
  // earlier revision excluded it. What the repo can state is only about cdkd's
  // own delete: `S3TablesProvider.deleteNamespace` enumerates no tables and
  // issues a bare `DeleteNamespace`. Whether AWS's `DeleteNamespace` cascades
  // server-side is UNMEASURED — an earlier draft inferred "it does not" from
  // `emptyTableBucket` deleting each table explicitly first, and that inference
  // is withdrawn: it is equally consistent with merely defensive ordering.
  // The question is load-bearing, which is why the unproven answer does not get
  // to decide it: the type's createOnly properties make a RENAME a
  // property-driven replacement that fires on a plain `cdkd deploy` with no
  // flag, so a cascade would take out-of-band tables silently. Those properties
  // are `Namespace` and `TableBucketARN` — read from the registry schema at
  // diff time by `create-only-properties.ts`, and checked into this repo as
  // `tests/fixtures/cfn-schemas/AWS-S3Tables-Namespace.json`, which is where
  // that claim is verifiable rather than assumed. Issue [#2539] holds the live probe that settles it (delete
  // a namespace holding a table, record what AWS answers); AWS refusing there
  // is the only thing that is grounds to revisit this entry.
  'AWS::S3Tables::Namespace',
  // S3 Vectors. Same shape as the table bucket: `deleteVectorBucket` calls
  // `emptyVectorBucket` unconditionally, deleting every vector index in it.
  'AWS::S3Vectors::VectorBucket',
  'AWS::ECR::Repository',
  // An EBS volume carries a filesystem; DELETE+CREATE loses every byte and
  // AWS offers no migration. Added with the immutable-property
  // classification in issue #1356 — before that, an AZ / Encrypted /
  // SnapshotId change could not reach the replacement path at all, so the
  // guard had nothing to protect. `UpdateReplacePolicy: Snapshot` still does
  // not exempt it: a snapshot is a point-in-time copy, not a surviving
  // resource (see the deploy engine's property-driven replacement guard).
  'AWS::EC2::Volume',
  // Managed compute clusters with LOCAL storage. `EMRClusterProvider.delete`
  // issues `TerminateJobFlows`, which destroys the HDFS volumes on the core
  // nodes; AWS migrates none of it to the replacement. Same argument the
  // ElastiCache entries above are on — an EMR cluster is often treated as
  // ephemeral compute over S3, but the local filesystem is real storage and
  // the replacement comes back empty either way. It is reachable on a PLAIN
  // deploy with no flag: the type has no `ReplacementRulesRegistry` entry, so
  // `create-only-properties.ts` resolves the registry schema at diff time and
  // its createOnly set (`Name`, `ReleaseLabel`, `Applications`,
  // `Configurations`, ... — checked in at
  // `tests/fixtures/cfn-schemas/AWS-EMR-Cluster.json`) classifies a change to
  // any of them as a replacement.
  'AWS::EMR::Cluster',
  // Streaming.
  'AWS::Kinesis::Stream',
  // Search.
  'AWS::Elasticsearch::Domain',
  'AWS::OpenSearchService::Domain',
  // Identity / config (user-managed values).
  'AWS::Cognito::UserPool',
  'AWS::SecretsManager::Secret',
  'AWS::SSM::Parameter',
  // Hardware security module. Deleting a CloudHSM cluster destroys the key
  // material inside it, and — as with `AWS::KMS::Key` below — the loss is not
  // confined to the resource cdkd deleted: every ciphertext produced under
  // those keys becomes undecryptable, including data in other stacks. AWS
  // gives the type a backup retention policy, which is the same statement
  // about the contents made from the other side.
  'AWS::CloudHSM::Cluster',
  // Encryption keys. `KMSProvider.delete` issues `ScheduleKeyDeletion`; once
  // the window elapses the key material is gone and every ciphertext under it
  // is undecryptable. Like the table and vector buckets above, the loss is not
  // confined to the resource cdkd deleted — it lands on other resources, in
  // other stacks, that merely reference the key. `always` rather than a
  // conditional, and deliberately NOT conditional on the deletion window: the
  // recorded bag CAN see one (`KMSProvider.delete` reads `PendingWindowInDays`
  // from the properties, defaulting to 7), so the ground for `always` is not
  // that the bag is blind to it. It is that a window only DELAYS the loss —
  // cdkd never calls `CancelKeyDeletion` (grep says so; the string appears
  // nowhere else in this repo), so nothing here will stop the schedule, and the
  // blast radius reaches ciphertext in other stacks this deploy never looked
  // at. A long window is not consent.
  'AWS::KMS::Key',
  // Guarded on the same UNMEASURED footing as `AWS::S3Tables::Namespace` above,
  // and flagged as such rather than argued: whether a destroyed replica's
  // ciphertexts stay decryptable through another key in the same multi-region
  // set is a statement about AWS and about the user's topology, and this repo
  // has measured neither. What IS repo-derivable: cdkd registers no SDK
  // provider for the type (`register-providers.ts` has `AWS::KMS::Key` and
  // `AWS::KMS::Alias` only), so a replacement routes through Cloud Control's
  // DELETE — the population this guard hoist exists for. Fail-safe by the same
  // rule as the directory bucket above: an unprovable recoverability must not
  // read as recoverable. `AWS::KMS::Alias` is deliberately NOT here —
  // `KMSProvider.delete` removes it with `DeleteAlias`, which drops a pointer
  // and no key material, which IS repo-derivable.
  'AWS::KMS::ReplicaKey',
  // Source control. `CodeCommitRepositoryProvider.delete` issues
  // `DeleteRepository`, which destroys the repository's entire git history.
  'AWS::CodeCommit::Repository',
  // Metadata catalog.
  'AWS::Glue::Database',
  'AWS::Glue::Table',
  // Logs (retained data).
  'AWS::Logs::LogGroup', // conditional — see isStatefulRecreateTargetSync
  // Edge / URL-immutability — CloudFront URL change breaks downstream
  // consumers and the change has a ~20-minute propagation window.
  'AWS::CloudFront::Distribution',

  // ---------------------------------------------------------------------
  // Tier-2 (Cloud-Control-routed) additions — issue [#2553].
  //
  // Everything above this line was reached by walking
  // `src/provisioning/providers/**`, which is why the entries above are
  // almost all types cdkd has an SDK provider for. The types below have NO
  // SDK provider: a replacement routes through Cloud Control's DELETE, the
  // path PR [#2519] hoisted this guard onto. They were proposed by
  // `scripts/audit-stateful-candidates.ts`, which reads every tier-2 type's
  // registry schema, and each one is reachable by a rename on a plain
  // `cdkd deploy` — none has a `ReplacementRulesRegistry` entry, so
  // `create-only-properties.ts` resolves the schema at diff time and its
  // createOnly set classifies the change as a replacement. The per-type
  // createOnly properties are recorded in
  // `docs/_generated/stateful-candidates.json`, which is where that claim is
  // checkable rather than assumed.
  //
  // The 27 candidates deliberately left OFF carry their reason in that
  // script's `NOT_GUARDED` map, and
  // `tests/unit/scripts/stateful-candidates.test.ts` fails on any candidate
  // in neither place — so this block cannot silently stop keeping up with
  // the derivation.
  // ---------------------------------------------------------------------

  // Databases and warehouses with no SDK provider. Each holds the rows
  // themselves; a DELETE + CREATE hands back an empty one and AWS migrates
  // nothing.
  'AWS::Cassandra::Table',
  'AWS::DocDBElastic::Cluster',
  'AWS::Lightsail::Database',
  'AWS::Timestream::Database',
  'AWS::Timestream::Table',
  // InfluxDB is a managed time-series server with provisioned storage
  // (`AllocatedStorage`, `DbStorageType`); the cluster/instance IS the store.
  'AWS::Timestream::InfluxDBCluster',
  'AWS::Timestream::InfluxDBInstance',
  // Oracle Database@AWS. A VM cluster runs the customer's Oracle databases on
  // its own storage; terminating it destroys them.
  'AWS::ODB::CloudAutonomousVmCluster',
  'AWS::ODB::CloudVmCluster',
  // Redshift Serverless splits storage from compute: the NAMESPACE owns the
  // databases (and a snapshot IS a copy of them), while the workgroup is
  // compute and is deliberately NOT guarded — see the script's NOT_GUARDED.
  'AWS::RedshiftServerless::Namespace',
  'AWS::RedshiftServerless::Snapshot',
  // Graph stores. A snapshot is the data itself, not a pointer to it.
  'AWS::NeptuneGraph::Graph',
  'AWS::NeptuneGraph::GraphSnapshot',
  // The rest of that family, on the identical argument: a snapshot or backup
  // resource IS a copy of the data, so replacing one destroys the copy the
  // user was keeping. They are guarded for the same reason
  // `AWS::RedshiftServerless::Snapshot` above is, and they arrived by the
  // derivation rather than by hand — the 2026-09-04 coverage refresh added
  // them to tier 2 and the disposition fence refused to pass with them
  // undispositioned.
  'AWS::RDS::DBSnapshot',
  'AWS::RDS::ClusterSnapshot',
  'AWS::DynamoDB::Backup',

  // In-memory / streaming stores that persist their dataset.
  'AWS::MemoryDB::Cluster',
  // Guarded while `AWS::RDS::GlobalCluster` and its Neptune / DocDB siblings
  // are written off, and the discriminator is in the schemas rather than in
  // the naming: this type declares `NodeType` and `NumShards` — it SIZES the
  // storage the regional clusters serve — while `AWS::RDS::GlobalCluster`
  // declares NO sizing property at all. Its nearest equivalents are
  // `SourceDBClusterIdentifier` and `GlobalClusterIdentifier`, which point at
  // member clusters that outlive it.
  'AWS::MemoryDB::MultiRegionCluster',
  'AWS::ElastiCache::ServerlessCache',
  // Kafka. Topic data lives on the brokers' own storage; there is no
  // migration to a replacement cluster.
  'AWS::MSK::Cluster',
  'AWS::MSK::ServerlessCluster',
  // An MSK channel carries encryption AT REST over the change stream it
  // buffers before delivery. Whether a delete drops undelivered records is
  // UNMEASURED, and the fail-safe rule applies.
  'AWS::MSK::Channel',
  // A managed message broker persists its queues (ActiveMQ KahaDB, RabbitMQ
  // mnesia) on the broker's own storage.
  'AWS::AmazonMQ::Broker',
  // OpenSearch Ingestion buffers to persistent storage (`BufferOptions`,
  // `EncryptionAtRestOptions`); a delete drops whatever has not drained.
  'AWS::OSIS::Pipeline',
  // Retained media, not a pipe: `DataRetentionInHours` is what makes a Kinesis
  // Video stream data-bearing where a plain transport would not be.
  'AWS::KinesisVideo::Stream',
  // EventBridge archives retain the events themselves for `RetentionDays`.
  'AWS::Events::Archive',

  // Search / vector / analytics indexes. The indexed documents are the user's
  // and are not re-derivable from the template.
  'AWS::OpenSearchServerless::Collection',
  'AWS::OpenSearchServerless::Index',
  'AWS::OpenSearchServerless::CollectionIndex',
  'AWS::Kendra::Index',
  'AWS::QBusiness::Index',
  // A Q Business application owns its indices, data-source sync state and
  // conversation history.
  'AWS::QBusiness::Application',
  // Face and geofence collections are written through the service API, never
  // from the template, so a recreate cannot restore them.
  'AWS::Rekognition::Collection',
  'AWS::Location::GeofenceCollection',
  // An S3 Vectors index holds the vectors, exactly as the already-guarded
  // `AWS::S3Vectors::VectorBucket` holds the indexes.
  'AWS::S3Vectors::Index',
  // Bedrock knowledge bases can hold Bedrock-MANAGED vector storage
  // (`StorageConfiguration`); whether a given one does is a template-time
  // choice this guard cannot see, so it takes the fail-safe side.
  'AWS::Bedrock::KnowledgeBase',
  // A data-automation library carries encryption at rest over the entity
  // definitions and extractions it accumulates.
  'AWS::Bedrock::DataAutomationLibrary',

  // Object / file / image stores with no SDK provider.
  'AWS::Lightsail::Bucket',
  'AWS::S3Outposts::Bucket',
  'AWS::HealthImaging::Datastore',
  'AWS::HealthLake::FHIRDatastore',
  // A volume inside an FSx file system holds the files themselves, so the
  // argument is the already-guarded `AWS::FSx::FileSystem`'s one level down.
  // Its createOnly set includes `BackupId` and the ONTAP aggregate
  // configuration, so a restore-source or layout change replaces it.
  'AWS::FSx::Volume',
  // An email archive retains the messages themselves.
  'AWS::SES::MailManagerArchive',
  // A WorkSpaces instance volume is an EBS volume with a filesystem on it —
  // the same argument as the already-guarded `AWS::EC2::Volume`.
  'AWS::WorkspacesInstances::Volume',

  // IoT Analytics stores raw and processed messages on all three of its
  // resources; none of it is re-derivable.
  'AWS::IoTAnalytics::Channel',
  'AWS::IoTAnalytics::Datastore',
  'AWS::IoTAnalytics::Dataset',

  // Artifact / image / source stores.
  //
  // A CodeArtifact DOMAIN is not a grouping: it owns the deduplicated asset
  // storage every repository in it references, so deleting the domain
  // destroys package content the repositories alone do not hold.
  'AWS::CodeArtifact::Domain',
  'AWS::CodeArtifact::Repository',
  // Public ECR repositories hold images exactly as the already-guarded
  // private `AWS::ECR::Repository` does.
  'AWS::ECR::PublicRepository',

  // Backup vaults hold the recovery points — the data whose whole purpose is
  // to survive the loss of the resource it was taken from. Note that NO
  // property-shaped signal can see this: every property on the type is a
  // pointer or a setting, and the recovery points appear nowhere in the
  // schema. That blind spot is why the derivation also has a name-scoped
  // signal.
  'AWS::Backup::BackupVault',
  'AWS::Backup::LogicallyAirGappedBackupVault',

  // Kubernetes control plane. The etcd store behind an EKS cluster holds
  // every Kubernetes object the user created; nothing in the CloudFormation
  // template describes it, and a replacement comes back empty.
  'AWS::EKS::Cluster',
  // SageMaker HyperPod cluster nodes carry local and tiered storage
  // (`TieredStorageConfig`) holding training checkpoints.
  'AWS::SageMaker::Cluster',
  // A SageMaker Studio domain OWNS the EFS file system holding every user
  // profile's home directory (`HomeEfsFileSystemId`).
  'AWS::SageMaker::Domain',

  // Service-owned "domains" that hold the records themselves rather than DNS
  // names. Contrast `AWS::Amplify::Domain`, `AWS::Cognito::UserPoolDomain`
  // and `AWS::Lightsail::Domain`, which are DNS and are NOT guarded.
  'AWS::Cases::Domain',
  'AWS::CustomerProfiles::Domain',
  'AWS::DataZone::Domain',

  // Clean Rooms tables hold populated mapping and intermediate-result data,
  // not just a reference to a configured table.
  'AWS::CleanRooms::IdMappingTable',
  'AWS::CleanRooms::IntermediateTable',

  // Runtime-written key/value and tabular stores. Both are seeded from the
  // template at most once (`ImportSource`) and then written through the
  // service API, so a recreate loses every write since.
  'AWS::CloudFront::KeyValueStore',
  'AWS::Connect::DataTable',

  // An AppConfig configuration profile whose `LocationUri` is `hosted` owns
  // its configuration versions; deleting the profile deletes them. Whether a
  // given profile is hosted is a template-time value, so the type is guarded
  // unconditionally rather than probed.
  'AWS::AppConfig::ConfigurationProfile',

  // Investigation groups retain investigations for `RetentionInDays` — the
  // same argument the LogGroup entry rests on.
  'AWS::AIOps::InvestigationGroup',
  // Guarded on the FAIL-SAFE side of an open question, like
  // `AWS::S3Tables::Namespace` and `AWS::Rbin::Rule` above, and the entry says
  // so rather than arguing it. The registry schema describes the type as
  // providing "logical isolation for tasks and pipelines", which are their own
  // template resources — that reads like the write-off rule's DECLARED CONTENT
  // arm. Against it: AWS makes `EncryptionConfiguration` REQUIRED and
  // `KmsKeyId` createOnly, which is a statement that the workspace itself
  // holds something at rest, and whether deleting one cascades to the sibling
  // `AWS::IoTSiteWise::Dataset` resources inside it is UNMEASURED. An
  // unprovable emptiness must not read as empty.
  'AWS::IoTSiteWise::Workspace',
  // A Recycle Bin retention rule is guarded on the FAIL-SAFE side of an open
  // question rather than on a proof, and the distinction is the whole reason
  // it is here: the rule's own content (`ResourceTags`, `RetentionPeriod`,
  // `LockConfiguration`) is entirely template-declared, so a recreate restores
  // the RULE exactly. What is NOT derivable from this repo or the type's
  // schema is what happens to the resources already sitting in the bin UNDER
  // that rule when it is deleted — and those are snapshots and AMIs the user
  // deleted expecting to be able to get them back. An earlier revision wrote
  // the type off on the assumption that they survive; that assumption is
  // withdrawn, because the derivation's own rule says a candidate whose answer
  // is not knowable from the outside is guarded (see `NOT_GUARDED`'s header in
  // `scripts/audit-stateful-candidates.ts`).
  'AWS::Rbin::Rule',

  // Identifier-immutability, the class `AWS::CloudFront::Distribution` is
  // already on this list for. Releasing a phone number or a sender ID returns
  // it to the pool: the replacement gets a DIFFERENT one, every downstream
  // consumer of the old one breaks, and the original may be unobtainable. AWS
  // ships `DeletionProtectionEnabled` on both, which is the same judgement.
  'AWS::SMSVOICE::PhoneNumber',
  'AWS::SMSVOICE::SenderId',
]);

/**
 * Multi-region resource types — `--recreate-via-cc-api` refuses these
 * outright in v1 regardless of `--force-stateful-recreation`. Design
 * doc §8 calls these "out of scope": the destroy + recreate cycle
 * across replica regions is more involved than a single-region
 * destroy-and-create (replica regions, automated backups, eventual
 * consistency across the replication mesh, etc.).
 *
 * Distinct from {@link STATEFUL_TYPES} — STATEFUL_TYPES gates on data
 * loss (bypassable with `--force-stateful-recreation`); this set is
 * an out-of-scope refusal (no bypass).
 */
export const MULTI_REGION_RECREATE_BLOCKED_TYPES: ReadonlySet<string> = new Set([
  'AWS::DynamoDB::GlobalTable',
]);

/**
 * Reason an existing resource is treated as stateful for the
 * recreate-via-cc-api guard.
 *
 *  - `'always'` — destroy + recreate always loses user data for this
 *    type, regardless of the resource's current properties (RDS,
 *    DynamoDB, EFS, etc.).
 *  - `'has-objects'` — S3 bucket whose emptiness is not established.
 *    THREE cases, not one: the plan-time probe found a version or a
 *    delete-marker; the probe answered with a page carrying a
 *    continuation marker and no entries, which does not settle the
 *    question (issue [#2578]); or nothing was probed at all.
 *  - `'has-retention'` — Logs::LogGroup with `RetentionInDays > 0` in EITHER
 *    of the state record's two property bags, `observedProperties` or
 *    `properties`, and read through {@link toFiniteNumber} so a
 *    CloudFormation-legal `'30'` counts (issue [#2521]). See
 *    {@link logGroupHasPositiveRetention} for why a zero observed retention
 *    may not veto a positive recorded one.
 *  - `'has-log-events'` — Logs::LogGroup whose emptiness is not
 *    established, on FIVE producers: the plan-time probe found a log
 *    stream; it answered without settling the question; it hit a
 *    not-found in a region it could not verify; it THREW; or the
 *    caller is a mid-deploy site with no probe opportunity at all. The
 *    two probe-failure arms are where this reason fails CLOSED while
 *    the bucket fails OPEN, so its case list is a SUPERSET of
 *    `'has-objects'`'s three rather than a mirror of them. Its
 *    rendered text is HEDGED ("log group is not provably empty") for
 *    exactly that reason — only the hedge is true across all five.
 *    `'has-objects'` carries the same duty across its own three cases
 *    and is hedged the same way ("S3 bucket is not provably empty",
 *    issue [#2615]). It was assertive until then, and the argument for
 *    keeping it — that hedging weakens the case that IS proved — lost
 *    to the one that broke it: of the two unproved paths, only the
 *    continuation-marker case corrected the claim on screen (it warns
 *    "without settling it" immediately before the refusal). The other,
 *    this module's {@link isStatefulRecreateTargetForReplace}
 *    `AWS::S3::Bucket` arm reached from `deploy-engine.ts`'s two
 *    replacement guards, throws with no warning at all — so the
 *    assertive sentence was the only thing that user saw, and it named
 *    a measurement cdkd never took. The one site that re-derives a
 *    reason (`recreate-confirm-prompt.ts`) still uses its own wording:
 *    it knows something narrower, that the force flag SKIPPED the
 *    probe.
 *  - `null` — not stateful for the purposes of this guard.
 */
export type StatefulReason = 'always' | 'has-objects' | 'has-retention' | 'has-log-events' | null;

/**
 * Does either recorded bag prove this log group carries a POSITIVE
 * `RetentionInDays`? (issue [#2521])
 *
 * Two decisions, and both were defects before this function existed.
 *
 * **The value is COERCED, not type-tested.** The predicate used to gate on
 * `typeof retention === 'number' && retention > 0`, and CloudFormation is
 * stringly typed: a hand-written L1, an `Fn::Sub`-produced value, a
 * `Type: String` parameter's default, or a record imported by
 * `cdkd import --migrate-from-cloudformation` all put `'30'` into the bag,
 * where the type test answers "not a number". {@link toFiniteNumber} is the
 * repo's single answer to "is this stringly-typed CFn value a number?" —
 * imported rather than re-spelled here for the reason its own doc gives, that
 * the same rule hand-written twice diverges on the next fix to one copy. It
 * rejects `''`, `'   '`, `null`, `[]` and `false`, each of which a bare
 * `Number()` turns into a `0` that would read as never-expire.
 *
 * **BOTH bags are consulted, and a positive in EITHER wins.** The old read
 * saw `properties` alone, so a retention set OUT OF BAND (the console,
 * `aws logs put-retention-policy`, another tool) or one recorded only in
 * `observedProperties` — an imported record whose template never declared
 * the property — never produced `has-retention`.
 *
 * The rule is a plain OR, and the loop order below is INERT — a review round
 * caught an earlier version of this paragraph claiming `observedProperties`
 * is "read FIRST", a precedence the code does not implement and must not.
 * A strict "observed when present, else properties" rule — which is what
 * issue [#2521] literally prescribed — was tried and REJECTED:
 * `LogsLogGroupProvider.readCurrentState` writes `RetentionInDays: 0` for a
 * group with no retention policy, so the observed bag almost always CARRIES
 * the key, and precedence would make the recorded bag dead for every record
 * that has ever been captured and would DROP the `has-retention` verdict this
 * guard already produced. A test pins that rejection
 * (`tests/unit/provisioning/stateful-types.test.ts`, "reads a retention that
 * lives ONLY in properties, even against a ZERO observed one"). The OR is
 * also the strictly safer direction: it can only ADD refusals, never remove
 * one.
 *
 * What a `false` here means is DEFER, not "holds nothing" — see the callers.
 */
function logGroupHasPositiveRetention(
  recordedProperties: Record<string, unknown> | undefined,
  observedProperties: Record<string, unknown> | undefined
): boolean {
  for (const bag of [observedProperties, recordedProperties]) {
    const retention = toFiniteNumber(bag?.['RetentionInDays']);
    if (retention !== undefined && retention > 0) return true;
  }
  return false;
}

/**
 * Cheap, synchronous read of the state record's own property bags only —
 * no AWS call. Both bags are parameters rather than one: `properties` is
 * what the last deploy applied, `observedProperties` what it read back,
 * and the log group's arm consults BOTH (issue [#2521]). Passing the
 * observed bag is REQUIRED, not optional, so a new call site has to
 * decide what it holds instead of silently repeating the omission that
 * issue records; `undefined` is the right answer where no record is in
 * hand (`recreate-confirm-prompt.ts`).
 *
 * TWO types return `null` meaning DEFER rather than "not stateful":
 * `AWS::S3::Bucket` always, and `AWS::Logs::LogGroup` whenever neither
 * bag already proves `has-retention`. The live probes
 * that resolve both deferrals (`ListObjectVersions` for the bucket,
 * `DescribeLogStreams` for the log group) live in
 * `src/deployment/recreate-targets.ts#probeStatefulRecreateTargetsAsync`
 * (issues [#648] / [#2558]) and run after this sync first-cut. Sync callers can
 * still treat `null` as "not stateful" — the deploy command does both
 * passes back-to-back; only callers that explicitly opt out of the
 * async probe need to assume conservative "stateful" semantics, which
 * is what {@link isStatefulRecreateTargetForReplace} exists to do.
 *
 * Returns the {@link StatefulReason} when the type is stateful (or
 * `null` for non-stateful types).
 */
export function isStatefulRecreateTargetSync(
  resourceType: string,
  recordedProperties: Record<string, unknown> | undefined,
  observedProperties: Record<string, unknown> | undefined
): StatefulReason {
  if (!STATEFUL_TYPES.has(resourceType)) return null;
  if (resourceType === 'AWS::Logs::LogGroup') {
    if (logGroupHasPositiveRetention(recordedProperties, observedProperties)) {
      return 'has-retention';
    }
    // NOT "no retention, therefore nothing to lose" — an unset or zero
    // retention is CloudWatch Logs' never-expire (issue [#2558]). The bag
    // cannot answer whether the group holds events, so defer to the live
    // `DescribeLogStreams` probe exactly as the bucket defers to its own.
    return null;
  }
  if (resourceType === 'AWS::S3::Bucket') {
    // The live object-count probe runs in the deploy engine. The bare
    // sync map cannot judge — defer.
    return null;
  }
  return 'always';
}

/**
 * Conservative variant for the deploy engine's mid-deploy guard sites, which
 * between them serve the paths below — only one of which is reached by a flag:
 *
 *   - property-driven replacement (an immutable / createOnly property changed
 *     in the template) — fires on a plain `cdkd deploy`, no flag;
 *   - the update-failure fallback's Cloud Control trigger (an
 *     `UnsupportedActionException` / "does not support UPDATE" rejection) —
 *     also no flag (issue [#2514]);
 *   - the same fallback's `--replace` trigger (an SDK provider's typed
 *     `ResourceUpdateNotSupportedError`).
 *
 * All of them catch the rejection or classify the diff while the deploy is
 * already in flight, so — unlike the `--recreate-via-*` pre-flight, which
 * runs {@link probeStatefulRecreateTargetsAsync} (`s3:ListObjectVersions`) —
 * there is no opportunity to probe an `AWS::S3::Bucket`'s object count, nor an
 * `AWS::Logs::LogGroup`'s log streams. The sync check returns `null` for both
 * deferrals, which would let a NON-EMPTY bucket — or a never-expiring log group
 * — be DELETE + CREATEd (data loss) without `--force-stateful-recreation`. To
 * stay fail-safe, both deferrals resolve to stateful here: the user must pass
 * `--force-stateful-recreation` to replace ANY S3 bucket, and any log group
 * neither of whose recorded property bags already proves `has-retention`, on
 * any of those paths — empty or not.
 *
 * `UpdateReplacePolicy: Retain` is the standing EXEMPTION, and it covers all
 * three (issue [#2604]): the engine never consults this predicate under it —
 * the property-driven guard tests `updateReplacePolicy !== 'Retain'`
 * directly, and the fallback's two triggers short-circuit through
 * `retainOldOnReplace`, which issue [#2518] added. The old resource survives
 * the replacement, so there is no data loss to confirm, and the refusal's own
 * remedy would have destroyed exactly what the user asked to keep.
 * `Snapshot` is NOT exempt on any of them — a snapshot is a copy, not a
 * surviving resource. So read the paragraph above as scoped to a template
 * that is not retaining.
 *
 * The two engine sites are not the only callers: a THIRD sits outside those
 * paths and outside that exemption — `recreate-confirm-prompt.ts` re-derives
 * a `null` verdict for the `--recreate-via-*` pre-flight, where
 * `--force-stateful-recreation` is what skipped the probe.
 * `stateful-replace-message-doc-sync` pins the whole guard's reader list by
 * file, but the residuals comment above its own walk enumerates what that
 * cannot see — among them an ALIASED import, a `.mts` / `.cts` reader, and,
 * the one that bit, a NEW PATH routed through an existing call site, which
 * adds no file and reds nothing (issue [#2514]'s shape). So this enumeration
 * is maintained by hand.
 *
 * The log group's arm is the one issue [#2558] added, and the reason it is
 * needed is that the old predicate treated "no retention recorded" as "holds
 * nothing" when it is CloudWatch Logs' never-expire. Every other type matches
 * {@link isStatefulRecreateTargetSync} exactly.
 */
export function isStatefulRecreateTargetForReplace(
  resourceType: string,
  recordedProperties: Record<string, unknown> | undefined,
  observedProperties: Record<string, unknown> | undefined
): StatefulReason {
  const sync = isStatefulRecreateTargetSync(resourceType, recordedProperties, observedProperties);
  if (sync) return sync;
  if (resourceType === 'AWS::S3::Bucket') {
    // Cannot prove the bucket is empty mid-deploy — assume it has data.
    return 'has-objects';
  }
  if (resourceType === 'AWS::Logs::LogGroup') {
    // Same shape, one type down: neither bag proved a positive retention
    // (unset or zero, i.e. never-expire) and no probe can run here, so assume
    // the group holds events.
    return 'has-log-events';
  }
  return null;
}

/**
 * Human-readable rendering of {@link StatefulReason} for error
 * messages. Used by the pre-flight guard's "X resources require
 * --force-stateful-recreation" listing.
 */
export function renderStatefulReason(reason: StatefulReason): string {
  switch (reason) {
    case 'always':
      return 'destroy loses all data in the resource';
    case 'has-objects':
      // Hedged for the same reason `has-log-events` is (issue [#2615]): this
      // reason covers a probe that FOUND a version or delete-marker, a probe
      // whose page carried a continuation marker and no entries, and a
      // mid-deploy site with no probe at all. The old assertive "S3 bucket is
      // non-empty" was true only of the first, and on the third — the
      // `isStatefulRecreateTargetForReplace` arm reached from the deploy
      // engine's two replacement guards — it was the ONLY thing the user saw,
      // with no warning beside it to correct the claim.
      return 'S3 bucket is not provably empty';
    case 'has-retention':
      return 'log group retains data (RetentionInDays > 0)';
    case 'has-log-events':
      // Deliberately NOT "log group is non-empty": this reason renders on
      // FIVE producers, and only the hedged wording is true of all of them —
      // the probe found a stream, it answered without settling the question,
      // it hit a not-found in an unverified region, it THREW, and the
      // mid-deploy arm ABOVE where no probe runs at all. The NOT-FOUND-IN-AN-
      // UNVERIFIED-REGION and THREW arms are
      // the divergence `recreate-targets.ts` documents: a probe failure fails
      // CLOSED here and OPEN for the bucket. The mid-deploy arm is NOT part of
      // it — the bucket's arm beside it answers `'has-objects'` on the same
      // no-probe path, so that one is parity and must not be "simplified"
      // toward the bucket. It was also the FIRST of the two to hedge; the
      // bucket followed in issue [#2615], so the two are now the same shape
      // rather than a contrast.
      return 'log group is not provably empty';
    case null:
      return '(not stateful)';
  }
}
