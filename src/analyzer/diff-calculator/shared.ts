import type { ResourceChange } from '../../types/state.js';
import type { ReplacementSiblings } from '../replacement-rules.js';
import { isIntrinsicShaped } from '../../provisioning/create-only-properties.js';
import { SECRET_MASK } from '../../deployment/secret-redaction.js';
import { maskDeep, type MaskerFn } from '../../provisioning/masked-retry-logger.js';
import { CC_IN_PLACE_UPDATE_DERIVED_ATTRS } from './in-place-cc-derived-attrs.generated.js';

/**
 * A type's CFn-schema create-only keys as the promotion passes read them
 * (go-to-k/cdkd#3803): every WHOLE-property key, and those that raise no
 * ceiling from a value that may be a fresh `NoEcho` one — the write-only keys,
 * or `'all'` when the write-only list is unknown.
 */
export interface SyntheticCreateOnly {
  readonly whole: ReadonlySet<string>;
  readonly unconfirmable: ReadonlySet<string> | 'all';
}

/**
 * Best-effort resolver for intrinsic functions during diff calculation.
 * Should return the resolved value on success, or the original value if resolution fails.
 * Kept as a callback to avoid circular dependency between analyzer and deployment layers.
 */
export type IntrinsicResolveFn = (value: unknown) => Promise<unknown>;

/**
 * The CloudFormation intrinsic function keys, as a single shared set.
 *
 * Exported so `outputs-diff.ts` detects a surviving intrinsic with exactly the
 * same key list this calculator uses — a second hand-maintained copy is how the
 * two drift into disagreeing about what "unresolved" means.
 */
export const INTRINSIC_KEYS: ReadonlySet<string> = new Set([
  'Ref',
  'Fn::Sub',
  'Fn::GetAtt',
  'Fn::Join',
  'Fn::Select',
  'Fn::Split',
  'Fn::If',
  'Fn::ImportValue',
  'Fn::FindInMap',
  'Fn::Base64',
  'Fn::GetAZs',
  'Fn::Equals',
  'Fn::And',
  'Fn::Or',
  'Fn::Not',
]);

/**
 * Per-type normalization applied to BOTH comparison sides (issue #1591).
 *
 * A provider that deliberately sends LESS than the template declares records
 * the narrowed bag in state (`effectiveProperties`). Without the identical
 * narrowing here the template's extra keys read as a user-made change on every
 * later deploy — and for a create-only property that is a REPLACEMENT, so a
 * previously-green no-op deploy starts destroying and re-creating the resource,
 * or failing outright where the provider refuses the shape on the create path.
 *
 * BOTH sides, not just the desired one: a record written BEFORE the provider
 * started narrowing still carries every key, so a desired-only normalization
 * flips the same difference to a REMOVAL and breaks exactly the population the
 * narrowing exists for. State can only carry the wider bag when it is junk, so
 * normalizing it is safe and the next write self-heals the record.
 * `drift-normalize.ts` records the same both-sides rule for ordering.
 *
 * MUST be pure and synchronous — it runs inside the diff, before any AWS call.
 */
export type CanonicalizePropertiesFn = (
  resourceType: string,
  properties: Record<string, unknown>
) => Record<string, unknown>;

/**
 * Per-type set of computed/derived read-only attributes whose value can change
 * as a side effect of an IN-PLACE update, even though the attribute NAME never
 * appears among the type's template properties (issue #985).
 *
 * The default in-place propagation arm matches a dependent only when the GetAtt
 * attribute NAME equals a template property that CHANGED on the upstream (e.g.
 * an SSM Parameter `Value`). That arm cannot see version-style attributes: an
 * `AWS::EC2::LaunchTemplate` edit changes `LaunchTemplateData`, which bumps the
 * read-only `LatestVersionNumber` from N to N+1 — but `LatestVersionNumber` is
 * NOT a template property, so a dependent reading `Fn::GetAtt[Lt,
 * LatestVersionNumber]` (the canonical `autoscaling.AutoScalingGroup`
 * `LaunchTemplate.Version` shape) is left NO_CHANGE and stays pinned one deploy
 * behind. These attributes resolve LIVE from AWS at deploy time (see the
 * `DescribeLaunchTemplates` special case in intrinsic-resolver/getatt.ts), so
 * a speculative promotion is safe: the deploy engine re-resolves the dependent
 * against the fresh live value and skips the provider call if it did not move.
 *
 * Keyed by upstream resource type -> the derived attribute names that any
 * in-place UPDATE of that type may move. Kept intentionally narrow (an allow
 * list, not "every read-only attr") so unrelated computed attributes that do
 * NOT track in-place edits (e.g. a Lambda `Arn`) never trigger spurious
 * dependent promotion.
 *
 * go-to-k/cdkd#7007: the Cloud Control rows a moving rule of the in-place
 * attribute audit settles (an update timestamp) are generated and merged in.
 */
export const HAND_IN_PLACE_UPDATE_DERIVED_ATTRS: Readonly<Record<string, ReadonlySet<string>>> =
  Object.freeze({
    'AWS::EC2::LaunchTemplate': new Set(['LatestVersionNumber', 'DefaultVersionNumber']),
    // Issue #5446: an InstanceType / UserData update stops and starts the
    // instance, which gives an instance without an Elastic IP a new public
    // address and DNS name (its private address and DNS name stay). The update
    // records the new pair, so a reader re-resolves against it.
    // go-to-k/cdkd#5630: a PrivateDnsNameOptions.HostnameType change moves the
    // private DNS name in place (`ip-10-0-0-1...` <-> `i-0123...`, measured).
    'AWS::EC2::Instance': new Set(['PublicIp', 'PublicDnsName', 'PrivateDnsName']),
    // go-to-k/cdkd#6962: every UpdateAgentRuntime mints a new runtime version,
    // and cdkd's update sends it for every change, a tag-only one included (a
    // full replace, Tags synced after it). A reader of `AgentRuntimeVersion`
    // (CDK `addEndpoint()`) moves to it, as CloudFormation moves the endpoint;
    // if a tag-only update minted none, the re-resolve-and-skip drops the
    // promotion. The update records the version UpdateAgentRuntime answers.
    'AWS::BedrockAgentCore::Runtime': new Set(['AgentRuntimeVersion', 'LastUpdatedAt']),
  });

/**
 * go-to-k/cdkd#7007: operational statuses of SDK-provider types. An update
 * returns once the resource is stable, but the stable value can differ from
 * the recorded one (an IPAM pool's `State` goes `create-complete` ->
 * `modify-complete` on a Description-only update, measured), so a reader is
 * re-resolved after any in-place update. Like a generated Cloud Control row,
 * an export of one is judged against the value the update recorded
 * (`export-change-guard.ts`), not refused before it.
 */
export const HAND_IN_PLACE_UPDATE_STATUS_ATTRS: Readonly<Record<string, ReadonlySet<string>>> =
  Object.freeze({
    'AWS::BedrockAgentCore::Browser': new Set(['Status']),
    'AWS::BedrockAgentCore::CodeInterpreter': new Set(['Status']),
    'AWS::BedrockAgentCore::Evaluator': new Set(['Status']),
    'AWS::BedrockAgentCore::Runtime': new Set(['Status', 'FailureReason']),
    'AWS::Connect::Instance': new Set(['InstanceStatus']),
    'AWS::EC2::Instance': new Set(['State']),
    'AWS::Kinesis::StreamConsumer': new Set(['ConsumerStatus']),
    'AWS::Lambda::MicrovmImage': new Set(['State']),
    'AWS::Lambda::NetworkConnector': new Set(['State']),
    'AWS::Lambda::WebFunctionEndpoint': new Set([
      'State',
      'StateReason',
      'UpdateStatus',
      'UpdateStatusReason',
    ]),
    'AWS::Lambda::WebFunctionRevision': new Set(['State', 'StateReason']),
    'AWS::Logs::DeliverySource': new Set(['Status', 'StatusReason']),
    'AWS::Pipes::Pipe': new Set(['StateReason']),
    // DBInstanceStatus / PercentProgress / StorageOperation* stay out: the
    // record holds them only from a settled `available` read, so a reader
    // re-resolved after an update read mid-modification would be refused.
    'AWS::RDS::DBInstance': new Set(['StatusInfos']),
  });

export const IN_PLACE_UPDATE_DERIVED_ATTRS: Readonly<Record<string, ReadonlySet<string>>> =
  Object.freeze(
    Object.fromEntries(
      [
        ...new Set([
          ...Object.keys(HAND_IN_PLACE_UPDATE_DERIVED_ATTRS),
          ...Object.keys(HAND_IN_PLACE_UPDATE_STATUS_ATTRS),
          ...Object.keys(CC_IN_PLACE_UPDATE_DERIVED_ATTRS),
        ]),
      ].map((type) => [
        type,
        new Set([
          ...(HAND_IN_PLACE_UPDATE_DERIVED_ATTRS[type] ?? []),
          ...(HAND_IN_PLACE_UPDATE_STATUS_ATTRS[type] ?? []),
          ...(CC_IN_PLACE_UPDATE_DERIVED_ATTRS[type] ?? []),
        ]),
      ])
    )
  );

/** What rebuilds a MicroVM image: the provider's `BUILD_AFFECTING_CFN_KEYS`. */
const MICROVM_IMAGE_BUILD_KEYS = new Set([
  'BaseImageArn',
  'BaseImageVersion',
  'BuildRoleArn',
  'Description',
  'CodeArtifact',
  'Logging',
  'EgressNetworkConnectors',
  'CpuConfigurations',
  'Resources',
  'AdditionalOsCapabilities',
  'Hooks',
  'EnvironmentVariables',
  'KmsKeyIdentifier',
]);

/**
 * What mints a new Step Functions revision. Measured: a definition, role,
 * tracing, logging or encryption change does; a tag edit or an identical
 * update does not. `DefinitionSubstitutions` and `DefinitionS3Location` are
 * kept: cdkd renders them into the definition it sends, so a change of a key
 * the definition uses mints one, and a move test sees only the one property.
 */
const STATE_MACHINE_REVISION_KEYS = new Set([
  'Definition',
  'DefinitionString',
  'DefinitionS3Location',
  'DefinitionSubstitutions',
  'RoleArn',
  'LoggingConfiguration',
  'TracingConfiguration',
  'EncryptionConfiguration',
]);

/**
 * go-to-k/cdkd#6913: derived attributes an in-place UPDATE moves only when one
 * of the NAMED properties changes. Kept out of
 * {@link IN_PLACE_UPDATE_DERIVED_ATTRS}, which promotes on ANY in-place edit:
 * `export-change-guard.ts` reads both, so a CDK cross-stack `db.secret` export
 * would be refused on every unrelated cluster update while a consumer imports
 * it. Keyed by upstream type -> attribute -> the top-level property names.
 */
export const IN_PLACE_UPDATE_ATTRS_MOVED_BY: Readonly<
  Record<string, Readonly<Record<string, ReadonlySet<string>>>>
> = Object.freeze({
  // Turning the managed password off and on again mints a new master secret;
  // a storage change moves a Multi-AZ cluster's throughput. The update
  // records the described values.
  'AWS::RDS::DBCluster': Object.freeze({
    'MasterUserSecret.SecretArn': new Set(['ManageMasterUserPassword']),
    StorageThroughput: new Set(['StorageType', 'Iops', 'AllocatedStorage']),
    // go-to-k/cdkd#7001: a Port change is modified in place.
    Endpoint: new Set(['Port']),
    'Endpoint.Port': new Set(['Port']),
  }),
  'AWS::RDS::DBInstance': Object.freeze({
    'MasterUserSecret.SecretArn': new Set(['ManageMasterUserPassword']),
    // go-to-k/cdkd#7001: the port, CA and Multi-AZ standby are modified in place.
    Endpoint: new Set(['Port']),
    'Endpoint.Port': new Set(['Port']),
    ListenerEndpoint: new Set(['Port']),
    'ListenerEndpoint.Port': new Set(['Port']),
    CertificateDetails: new Set(['CACertificateIdentifier']),
    'CertificateDetails.CAIdentifier': new Set(['CACertificateIdentifier']),
    'CertificateDetails.ValidTill': new Set(['CACertificateIdentifier']),
    SecondaryAvailabilityZone: new Set(['MultiAZ']),
  }),
  // go-to-k/cdkd#6939: a subnet added or removed gains or loses an interface
  // and its zonal DNS name; private DNS, DNS options and the IP address type
  // add or drop DNS names. The update records the described values, or, after
  // a --no-wait modify, none, so a reader reads the endpoint live.
  // go-to-k/cdkd#7007 (Cloud Control): the linked repository's owner; a
  // RepositoryLinkId change re-points the sync configuration.
  'AWS::CodeStarConnections::SyncConfiguration': Object.freeze({
    OwnerId: new Set(['RepositoryLinkId']),
    RepositoryName: new Set(['RepositoryLinkId']),
    ProviderType: new Set(['RepositoryLinkId']),
  }),
  // go-to-k/cdkd#7007 (Cloud Control): a DataSync location URI carries its
  // host and subdirectory (an HDFS name node), which UpdateLocation*
  // rewrites; a Deadline monitor URL carries the subdomain UpdateMonitor takes.
  'AWS::DataSync::LocationFSxWindows': Object.freeze({ LocationUri: new Set(['Subdirectory']) }),
  'AWS::DataSync::LocationS3': Object.freeze({ LocationUri: new Set(['Subdirectory']) }),
  'AWS::DataSync::LocationEFS': Object.freeze({ LocationUri: new Set(['Subdirectory']) }),
  'AWS::DataSync::LocationFSxLustre': Object.freeze({ LocationUri: new Set(['Subdirectory']) }),
  'AWS::DataSync::LocationFSxOpenZFS': Object.freeze({ LocationUri: new Set(['Subdirectory']) }),
  'AWS::DataSync::LocationFSxONTAP': Object.freeze({
    LocationUri: new Set(['Subdirectory', 'Protocol']),
  }),
  'AWS::DataSync::LocationNFS': Object.freeze({
    LocationUri: new Set(['Subdirectory', 'ServerHostname']),
  }),
  'AWS::DataSync::LocationSMB': Object.freeze({
    LocationUri: new Set(['Subdirectory', 'ServerHostname']),
  }),
  'AWS::DataSync::LocationHDFS': Object.freeze({
    LocationUri: new Set(['Subdirectory', 'NameNodes']),
  }),
  'AWS::DataSync::LocationObjectStorage': Object.freeze({
    LocationUri: new Set(['Subdirectory', 'ServerHostname']),
  }),
  'AWS::DataSync::LocationAzureBlob': Object.freeze({ LocationUri: new Set(['Subdirectory']) }),
  'AWS::Deadline::Monitor': Object.freeze({ Url: new Set(['Subdomain']) }),
  // go-to-k/cdkd#7007 (Cloud Control): an in-place RouteTableId change calls
  // ReplaceRouteTableAssociation, which answers a new association id.
  'AWS::EC2::GatewayRouteTableAssociation': Object.freeze({
    AssociationId: new Set(['RouteTableId']),
  }),
  'AWS::EC2::VPCEndpoint': Object.freeze({
    NetworkInterfaceIds: new Set(['SubnetIds']),
    DnsEntries: new Set(['SubnetIds', 'PrivateDnsEnabled', 'DnsOptions', 'IpAddressType']),
  }),
  // go-to-k/cdkd#6999: turning the stream on, or changing its view type,
  // disables the old stream and mints a new ARN, so an event source mapping
  // reading `StreamArn` must follow it; its `EventSourceArn` is create-only, so
  // the mapping is replaced, as CloudFormation does. A `ResourcePolicy` /
  // `Tags`-only edit keeps the ARN: `IN_PLACE_UPDATE_ATTR_MOVE_TESTS`.
  'AWS::DynamoDB::Table': Object.freeze({
    StreamArn: new Set(['StreamSpecification']),
  }),
  'AWS::DynamoDB::GlobalTable': Object.freeze({
    StreamArn: new Set(['StreamSpecification']),
  }),
  // go-to-k/cdkd#7001: the rest of the audit (`scripts/in-place-attr-classification.ts`
  // carries each row's reason; `vp run audit:in-place-attr-coverage:check`).
  // An update timestamp is moved by the properties its update call sends, so
  // a Tags-only edit moves none of them.
  'AWS::BedrockAgentCore::Evaluator': Object.freeze({
    EvaluatorType: new Set(['EvaluatorConfig']),
    Provider: new Set(['EvaluatorConfig']),
    UpdatedAt: new Set(['Description', 'EvaluatorConfig', 'Level', 'KmsKeyArn']),
  }),
  'AWS::CloudFormation::WaitCondition': Object.freeze({
    Data: new Set(['Handle', 'Count', 'Timeout']),
  }),
  'AWS::CloudTrail::Trail': Object.freeze({
    SnsTopicArn: new Set(['SnsTopicName']),
  }),
  // UpdateRepositoryName renames in place; the ARN and clone URLs end in it.
  'AWS::CodeCommit::Repository': Object.freeze({
    Arn: new Set(['RepositoryName']),
    Name: new Set(['RepositoryName']),
    CloneUrlHttp: new Set(['RepositoryName']),
    CloneUrlSsh: new Set(['RepositoryName']),
  }),
  'AWS::DocDB::DBCluster': Object.freeze({
    ServerlessV2PlatformVersion: new Set(['EngineVersion']),
  }),
  'AWS::EC2::Subnet': Object.freeze({
    Ipv6CidrBlocks: new Set(['Ipv6CidrBlock']),
  }),
  'AWS::EC2::VPCGatewayAttachment': Object.freeze({
    AttachmentType: new Set(['InternetGatewayId', 'VpnGatewayId']),
  }),
  // UpdateUser / UpdateGroup move the principal to the new path, and the ARN
  // carries it: a policy granting the old ARN would keep naming nothing.
  'AWS::IAM::Group': Object.freeze({ Arn: new Set(['Path']) }),
  'AWS::IAM::User': Object.freeze({ Arn: new Set(['Path']) }),
  'AWS::IAM::ManagedPolicy': Object.freeze({
    DefaultVersionId: new Set(['PolicyDocument']),
    UpdateDate: new Set(['PolicyDocument']),
    AttachmentCount: new Set(['Roles', 'Users', 'Groups']),
  }),
  'AWS::Kinesis::Stream': Object.freeze({
    WarmThroughputObject: new Set(['WarmThroughputMiBps', 'StreamModeDetails']),
  }),
  'AWS::Lambda::Function': Object.freeze({
    SnapStartResponse: new Set(['SnapStart']),
    'SnapStartResponse.ApplyOn': new Set(['SnapStart']),
    'SnapStartResponse.OptimizationStatus': new Set(['SnapStart']),
  }),
  'AWS::Lambda::MicrovmImage': Object.freeze({
    LatestActiveImageVersion: MICROVM_IMAGE_BUILD_KEYS,
    LatestFailedImageVersion: MICROVM_IMAGE_BUILD_KEYS,
    UpdatedAt: MICROVM_IMAGE_BUILD_KEYS,
  }),
  'AWS::Lambda::WebFunctionEndpoint': Object.freeze({
    UpdatedAt: new Set([
      'Description',
      'AuthType',
      'RevisionWeights',
      'ScalingConfig',
      'ThrottleConfig',
    ]),
  }),
  'AWS::Lambda::NetworkConnector': Object.freeze({
    LatestVersion: new Set(['Configuration', 'OperatorRole']),
    LatestVersionArn: new Set(['Configuration', 'OperatorRole']),
  }),
  'AWS::Logs::DeliverySource': Object.freeze({
    ResourceArns: new Set(['ResourceArn']),
    Service: new Set(['ResourceArn']),
  }),
  'AWS::Neptune::DBCluster': Object.freeze({
    Port: new Set(['DBPort']),
  }),
  'AWS::Pipes::Pipe': Object.freeze({
    CurrentState: new Set(['DesiredState']),
    LastModifiedTime: new Set([
      'Description',
      'DesiredState',
      'Enrichment',
      'EnrichmentParameters',
      'KmsKeyIdentifier',
      'LogConfiguration',
      'RoleArn',
      'SourceParameters',
      'Target',
      'TargetParameters',
    ]),
  }),
  'AWS::S3::Bucket': Object.freeze({
    'MetadataTableConfiguration.S3TablesDestination.TableArn': new Set([
      'MetadataTableConfiguration',
    ]),
    'MetadataTableConfiguration.S3TablesDestination.TableNamespace': new Set([
      'MetadataTableConfiguration',
    ]),
    'MetadataConfiguration.Destination': new Set(['MetadataConfiguration']),
    'MetadataConfiguration.JournalTableConfiguration.TableName': new Set(['MetadataConfiguration']),
    'MetadataConfiguration.JournalTableConfiguration.TableArn': new Set(['MetadataConfiguration']),
    'MetadataConfiguration.InventoryTableConfiguration.TableName': new Set([
      'MetadataConfiguration',
    ]),
    'MetadataConfiguration.InventoryTableConfiguration.TableArn': new Set([
      'MetadataConfiguration',
    ]),
    'MetadataConfiguration.AnnotationTableConfiguration.TableName': new Set([
      'MetadataConfiguration',
    ]),
    'MetadataConfiguration.AnnotationTableConfiguration.TableArn': new Set([
      'MetadataConfiguration',
    ]),
  }),
  'AWS::StepFunctions::StateMachine': Object.freeze({
    StateMachineRevisionId: STATE_MACHINE_REVISION_KEYS,
  }),
  'AWS::WAFv2::WebACL': Object.freeze({
    Capacity: new Set(['Rules']),
  }),
});

/**
 * A DynamoDB `StreamSpecification`'s view type, `null` for no stream, or
 * `undefined` when the block cannot be read (an intrinsic, a malformed value).
 */
function streamViewTypeOf(spec: unknown): string | null | undefined {
  if (spec === undefined || spec === null) return null;
  if (typeof spec !== 'object' || Array.isArray(spec)) return undefined;
  const viewType = (spec as Record<string, unknown>)['StreamViewType'];
  return typeof viewType === 'string' ? viewType : undefined;
}

/**
 * Whether a change of `StreamSpecification` from `oldValue` to `newValue`
 * mints a new stream ARN: the view type moved, or the stream was turned on or
 * off. An unreadable side answers `true` (the reader is promoted, and the
 * engine skips it if the value did not move).
 */
function streamSpecificationMovesStreamArn(oldValue: unknown, newValue: unknown): boolean {
  const before = streamViewTypeOf(oldValue);
  const after = streamViewTypeOf(newValue);
  if (before === undefined || after === undefined) return true;
  return before !== after;
}

/**
 * go-to-k/cdkd#7001: a managed policy's `AttachmentCount` moves only when a
 * principal list changes LENGTH; a same-length swap keeps the count. A side
 * that is not a list (an intrinsic) answers `true`. Bound: a swapped-in
 * principal already holding the policy another way (a role's
 * `ManagedPolicyArns`) lowers the count without promoting the reader.
 */
function principalListLengthMoves(oldValue: unknown, newValue: unknown): boolean {
  const length = (v: unknown): number | undefined =>
    v === undefined || v === null ? 0 : Array.isArray(v) ? v.length : undefined;
  const before = length(oldValue);
  const after = length(newValue);
  return before === undefined || after === undefined || before !== after;
}

/**
 * A bag (object) side, `null` for absent, `undefined` when unreadable (a
 * scalar, a list, or an intrinsic the resolver left unresolved).
 */
function bagOf(value: unknown): Record<string, unknown> | null | undefined {
  if (value === undefined || value === null) return null;
  return typeof value === 'object' && !Array.isArray(value) && !isIntrinsicShaped(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * go-to-k/cdkd#7001: an S3 `MetadataConfiguration` edit re-creates its
 * destination and journal table only when the whole configuration is added
 * or removed; while one exists on both sides the provider updates the journal
 * expiration in place and refuses an encryption change
 * (`applyMetadataConfigurationDiff`). An unreadable side answers `true`.
 */
function metadataConfigurationAddedOrRemoved(oldValue: unknown, newValue: unknown): boolean {
  const before = bagOf(oldValue);
  const after = bagOf(newValue);
  if (before === undefined || after === undefined) return true;
  return (before === null) !== (after === null);
}

/**
 * The inventory / annotation table of an S3 `MetadataConfiguration` is
 * created or deleted when the configuration is added or removed, or when that
 * table's `ConfigurationState` flips (absent reads `DISABLED`).
 */
function metadataTableStateFlips(
  member: string
): (oldValue: unknown, newValue: unknown) => boolean {
  const stateOf = (bag: Record<string, unknown>): unknown => {
    const table = bagOf(bag[member]);
    if (table === undefined) return undefined;
    return table === null ? 'DISABLED' : (table['ConfigurationState'] ?? 'DISABLED');
  };
  return (oldValue, newValue) => {
    if (metadataConfigurationAddedOrRemoved(oldValue, newValue)) return true;
    const before = stateOf(bagOf(oldValue)!);
    const after = stateOf(bagOf(newValue)!);
    if (typeof before !== 'string' || typeof after !== 'string') return true;
    return before !== after;
  };
}

const INVENTORY_TABLE_STATE_FLIPS = metadataTableStateFlips('InventoryTableConfiguration');
const ANNOTATION_TABLE_STATE_FLIPS = metadataTableStateFlips('AnnotationTableConfiguration');

/**
 * Narrower tests for rows of {@link IN_PLACE_UPDATE_ATTRS_MOVED_BY}: per type
 * -> attribute -> property, whether that property's change from the recorded
 * to the desired value moves the attribute. A row with no test moves on any
 * change of the property. `export-change-guard.ts` reads the answer too, so a
 * test keeps an export from being refused over an edit that leaves it alone.
 */
export const IN_PLACE_UPDATE_ATTR_MOVE_TESTS: Readonly<
  Record<
    string,
    Readonly<
      Record<string, Readonly<Record<string, (oldValue: unknown, newValue: unknown) => boolean>>>
    >
  >
> = Object.freeze({
  'AWS::DynamoDB::Table': Object.freeze({
    StreamArn: Object.freeze({ StreamSpecification: streamSpecificationMovesStreamArn }),
  }),
  'AWS::DynamoDB::GlobalTable': Object.freeze({
    StreamArn: Object.freeze({ StreamSpecification: streamSpecificationMovesStreamArn }),
  }),
  'AWS::IAM::ManagedPolicy': Object.freeze({
    AttachmentCount: Object.freeze({
      Roles: principalListLengthMoves,
      Users: principalListLengthMoves,
      Groups: principalListLengthMoves,
    }),
  }),
  'AWS::S3::Bucket': Object.freeze({
    'MetadataConfiguration.Destination': Object.freeze({
      MetadataConfiguration: metadataConfigurationAddedOrRemoved,
    }),
    'MetadataConfiguration.JournalTableConfiguration.TableName': Object.freeze({
      MetadataConfiguration: metadataConfigurationAddedOrRemoved,
    }),
    'MetadataConfiguration.JournalTableConfiguration.TableArn': Object.freeze({
      MetadataConfiguration: metadataConfigurationAddedOrRemoved,
    }),
    'MetadataConfiguration.InventoryTableConfiguration.TableName': Object.freeze({
      MetadataConfiguration: INVENTORY_TABLE_STATE_FLIPS,
    }),
    'MetadataConfiguration.InventoryTableConfiguration.TableArn': Object.freeze({
      MetadataConfiguration: INVENTORY_TABLE_STATE_FLIPS,
    }),
    'MetadataConfiguration.AnnotationTableConfiguration.TableName': Object.freeze({
      MetadataConfiguration: ANNOTATION_TABLE_STATE_FLIPS,
    }),
    'MetadataConfiguration.AnnotationTableConfiguration.TableArn': Object.freeze({
      MetadataConfiguration: ANNOTATION_TABLE_STATE_FLIPS,
    }),
  }),
});

/**
 * Whether `attr` of an in-place-updated `type` moves with one of `changed`
 * (top-level property names), per {@link IN_PLACE_UPDATE_ATTRS_MOVED_BY},
 * narrowed by {@link IN_PLACE_UPDATE_ATTR_MOVE_TESTS} when `valuesOf` hands
 * over a changed property's recorded and desired values.
 * `Object.hasOwn` on every level: type, attribute and property are template text.
 */
export function attributeMovedByChangedProperty(
  type: string,
  attr: string,
  changed: ReadonlySet<string>,
  valuesOf?: (prop: string) => { oldValue: unknown; newValue: unknown } | undefined
): boolean {
  if (!Object.hasOwn(IN_PLACE_UPDATE_ATTRS_MOVED_BY, type)) return false;
  const byAttr = IN_PLACE_UPDATE_ATTRS_MOVED_BY[type]!;
  if (!Object.hasOwn(byAttr, attr)) return false;
  const tests =
    Object.hasOwn(IN_PLACE_UPDATE_ATTR_MOVE_TESTS, type) &&
    Object.hasOwn(IN_PLACE_UPDATE_ATTR_MOVE_TESTS[type]!, attr)
      ? IN_PLACE_UPDATE_ATTR_MOVE_TESTS[type]![attr]!
      : undefined;
  return [...byAttr[attr]!].some((prop) => {
    if (!changed.has(prop)) return false;
    const test = tests !== undefined && Object.hasOwn(tests, prop) ? tests[prop] : undefined;
    const values = test !== undefined ? valuesOf?.(prop) : undefined;
    return test === undefined || values === undefined || test(values.oldValue, values.newValue);
  });
}

/**
 * The PREFIX twin of {@link IN_PLACE_UPDATE_DERIVED_ATTRS}, for a type whose
 * derived attributes are an open family rather than a fixed list (issue
 * [#3631](https://github.com/go-to-k/cdkd/issues/3631)).
 *
 * A nested stack's `Outputs.<Key>` attributes are the child's outputs, and a
 * child-only change moves them while the parent's `AWS::CloudFormation::Stack`
 * row changes only `TemplateURL` / `Parameters`. The parent's diff runs BEFORE
 * the child deploys, so a reader of `Fn::GetAtt [Child, 'Outputs.<Key>']`
 * resolves against the PREVIOUS value and diffs NO_CHANGE. Which outputs move
 * is decided by the child's own deploy, so it is not knowable here: every
 * reader is promoted, and the deploy engine's re-resolve-and-skip drops the
 * ones whose output did not move.
 */
export const IN_PLACE_UPDATE_DERIVED_ATTR_PREFIXES: Readonly<Record<string, readonly string[]>> =
  Object.freeze({
    'AWS::CloudFormation::Stack': Object.freeze(['Outputs.']),
  });

/**
 * The attribute name `DiffCalculator.extractGetAttRefs` records for a
 * `Ref` read (go-to-k/cdkd#3717 / #3722). Not a name any attribute can have, so
 * the property-name, derived-attribute and prefix arms of the in-place pass
 * never match it; only the custom-resource arm (whose physical id the handler
 * may change) and the fresh-parameter arm (a parameter carrying a `NoEcho`
 * value supplied in this deploy) read it.
 */
export const REF_READ = '<Ref>';

/**
 * Does `value` hold an intrinsic (`Ref` / `Fn::*`, a single-key object) at any
 * depth? The shape `create-only-properties.ts` treats as unresolved.
 */
export function containsIntrinsic(value: unknown, seen: Set<object> = new Set()): boolean {
  if (value === null || typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (!Array.isArray(value) && isIntrinsicShaped(value)) return true;
  return Object.values(value).some((child) => containsIntrinsic(child, seen));
}

/**
 * One side of the replacement debug line, masked BEFORE it is stringified
 * (go-to-k/cdkd#4049): `JSON.stringify` escapes `"`, `\` and newlines, so a
 * needle carrying one no longer occurs in the finished line. `maskDeep` masks
 * every string leaf and key; the replacer masks a number or boolean leaf
 * whose printed form is a needle, the spelling `recordNoEchoParameterValue`
 * records for a `Number` parameter.
 */
function maskedJsonForLog(value: unknown, mask: MaskerFn): string {
  // `?? 'undefined'`: `JSON.stringify(undefined)` is `undefined`, which
  // `safeMsg` renders as nothing, so an added or removed property would print
  // an empty side.
  return (
    JSON.stringify(maskDeep(value, mask), (_key, leaf: unknown) =>
      (typeof leaf === 'number' || typeof leaf === 'boolean') && mask(String(leaf)) !== String(leaf)
        ? SECRET_MASK
        : leaf
    ) ?? 'undefined'
  );
}

/**
 * Both sides of the replacement debug line (go-to-k/cdkd#4049).
 *
 * The OLD side is read from state, which persists a `NoEcho` value in the
 * clear, and only the CURRENT value is a needle (the deploy's masker holds
 * every `NoEcho` parameter's current value from the start, so this does not
 * depend on which resource the diff reaches first): a rotated value's
 * previous plaintext masks nothing. So when the new side carries a needle, the old side
 * is withheld whole — the old value of the property now served by a secret is
 * taken to have been served by it too. Over-masking a debug line is the safe
 * direction; a property that stops being served by one still prints its old
 * value.
 */
export function replacementSidesForLog(
  oldValue: unknown,
  newValue: unknown,
  mask: MaskerFn
): [string, string] {
  const newText = maskedJsonForLog(newValue, mask);
  // Against the SAME walk unmasked, so a shape the walk itself reshapes is
  // never read as a needle.
  if (newText !== maskedJsonForLog(newValue, (text) => text)) return [SECRET_MASK, newText];
  return [maskedJsonForLog(oldValue, mask), newText];
}

/**
 * The `NoEcho` half of the comparison (go-to-k/cdkd#4043), injected so the
 * analyzer layer holds no redaction rule of its own: given a resource's
 * template bag, its resolved desired bag and its recorded bag (both after the
 * calculator's own narrowing), return the two bags the property comparison
 * reads. The deploy and `cdkd diff` mask the desired side where a `NoEcho`
 * source served a leaf, exactly as the persist side writes it, and read a
 * pre-v11 record's plaintext there as the migration witness.
 */
export type NoEchoCompareFn = (input: {
  logicalId: string;
  resourceType: string;
  templateProperties: Record<string, unknown>;
  desired: Record<string, unknown>;
  current: Record<string, unknown>;
}) => { desired: Record<string, unknown>; current: Record<string, unknown> } | undefined;

/**
 * The sibling bags a synthetic (propagated) change hands a conditional
 * replacement predicate (issue #5446: an instance's `SecurityGroupIds`
 * replaces only without a `SubnetId`).
 */
export function siblingsOf(change: {
  currentProperties?: Record<string, unknown> | undefined;
  desiredProperties?: Record<string, unknown> | undefined;
}): ReplacementSiblings | undefined {
  // Without the bags a predicate answers its non-destructive default.
  if (change.currentProperties === undefined || change.desiredProperties === undefined) {
    return undefined;
  }
  return { oldProperties: change.currentProperties, newProperties: change.desiredProperties };
}

/**
 * Marks the row the diff computed ON ITS OWN for `path` as resolved against a
 * resource this deploy replaces or updates (go-to-k/cdkd#6078), and records
 * the template value the renderers print instead of its stale `newValue`.
 * Display-only: nothing on the deploy path reads either field. A row a
 * promotion pass created (propagated, `NoEcho`-promoted, read-provenance) or
 * one shown as `***` on both sides already says the value is not final, so
 * it is left as it is.
 */
export function markNewValueKnownAfterDeploy(change: ResourceChange, path: string): void {
  for (const pc of change.propertyChanges ?? []) {
    if (
      pc.path !== path ||
      pc.replacementPropagated === true ||
      pc.inPlacePropagated === true ||
      pc.noEchoPromoted === true ||
      pc.readProvenancePromoted === true ||
      pc.maskedExpressionChanged === true
    ) {
      continue;
    }
    pc.newValueKnownAfterDeploy = true;
    pc.newValueTemplate = change.desiredProperties?.[path];
  }
}
