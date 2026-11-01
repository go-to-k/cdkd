import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import {
  AuthenticationMethod,
  ConfluentSchemaRegistry,
  SelfManagedKafkaEventSource,
} from 'aws-cdk-lib/aws-lambda-event-sources';

/**
 * Lambda event source mapping for a SELF-MANAGED Apache Kafka cluster
 * (issue #1384).
 *
 * CFn spells the bootstrap-server map key
 * `SelfManagedEventSource.Endpoints.KafkaBootstrapServers`, while the SDK
 * models `Endpoints` as `Partial<Record<EndPointType, string[]>>` keyed by the
 * enum VALUE `KAFKA_BOOTSTRAP_SERVERS`. Because `Endpoints` is a MAP rather
 * than a modeled structure, the AWS SDK v3 serializer forwards the unknown CFn
 * key verbatim and the service REJECTS the request — so before the fix
 * `CreateEventSourceMapping` failed outright for every CDK
 * `SelfManagedKafkaEventSource` user. A successful deploy of this fixture IS
 * the proof; verify.sh additionally reads the key back from AWS.
 *
 * covers: AWS::Lambda::EventSourceMapping
 * covers: AWS::Lambda::Function
 * covers: AWS::SecretsManager::Secret
 * covers: AWS::IAM::Role
 *
 * The broker endpoint is deliberately a NON-EXISTENT host: the
 * CreateEventSourceMapping API validates the request SHAPE, not connectivity,
 * and the mapping is created `enabled: false` so Lambda never attempts to poll
 * it. That keeps the fixture free of an actual Kafka cluster (and its cost)
 * while still exercising the exact wire path the bug broke.
 *
 * Self-managed Kafka requires a `SourceAccessConfigurations` auth entry, hence
 * the SASL/SCRAM secret. It holds placeholder credentials — nothing ever
 * authenticates with them.
 *
 * UPDATE phase (CDKD_TEST_UPDATE=true) bumps `batchSize`, which routes through
 * `UpdateEventSourceMapping` against the SAME mapping (`SelfManagedEventSource`
 * is create-only and is deliberately held constant, so the UUID must not
 * change). It also ADDS a schema registry to
 * `SelfManagedKafkaEventSourceConfig`, which update() never sent before issue
 * #3851; AWS accepts one only in provisioned mode, hence the poller config.
 *
 * REMOVAL phase (CDKD_TEST_UPDATE=true CDKD_TEST_REMOVAL=true) drops the schema
 * registry again while keeping provisioned mode and batchSize 20, so the
 * removal must reach AWS as the `{ SchemaRegistryConfig: {} }` reset. It also
 * drops the `MaximumRetryAttempts` / `MaximumRecordAgeInSeconds` the UPDATE
 * phase added, which CloudFormation keeps (issue #1160).
 *
 * DEFAULTS phase (the above plus CDKD_TEST_ESM_DEFAULTS=true, issue #1160)
 * drops `batchSize`, the poller config and the `LoggingConfig` the UPDATE phase
 * added. CloudFormation resets them (BatchSize 100, `LoggingConfig: {}`,
 * `ProvisionedPollerConfig: {}`); cdkd used to leave all three live.
 *
 * Issue #5356, in every phase: a declared `MaximumBatchingWindowInSeconds: 0`
 * (cdkd dropped it on create, leaving AWS's 500 ms default, which reads back
 * as no value) and a tag with a Key but no Value (CFn accepts it; cdkd refused
 * it). TOPIC phase (the DEFAULTS env plus CDKD_TEST_ESM_TOPIC=true) changes the
 * topic, which UpdateEventSourceMapping cannot carry and CloudFormation
 * refuses: the deploy must fail and leave the mapping's topic as it was.
 *
 * Issue #3850, in every phase: a second mapping on its own topic declares
 * `ConsumptionMode: Queue`. Lambda refuses `Queue` beside `StartingPosition` or
 * `MaximumBatchingWindowInSeconds`, so it omits both, on an L1 because the L2
 * requires a starting position. Its `BatchSize` follows the UPDATE phase, which
 * proves an in-place update of a Queue mapping. CDKD_TEST_ESM_MODE (on the
 * DEFAULTS env): `stream` changes only the mode, which Lambda refuses on update,
 * so the deploy must fail, and with --replace must recreate the mapping.
 * `stream-sp` also adds a StartingPosition, the create-only change a real move
 * off Queue makes: the create-first replacement must collide and delete nothing.
 */
export class LambdaEsmSelfManagedKafkaStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const isUpdate = process.env.CDKD_TEST_UPDATE === 'true';
    const isRemoval = isUpdate && process.env.CDKD_TEST_REMOVAL === 'true';
    const isDefaults = isRemoval && process.env.CDKD_TEST_ESM_DEFAULTS === 'true';
    const isTopicChange = isDefaults && process.env.CDKD_TEST_ESM_TOPIC === 'true';
    const modeChange = isDefaults ? process.env.CDKD_TEST_ESM_MODE : undefined;

    const secret = new secretsmanager.Secret(this, 'KafkaAuth', {
      secretName: `${this.stackName}-kafka-auth`,
      description: 'cdkd integ placeholder SASL/SCRAM credentials (never used)',
      secretObjectValue: {
        username: cdk.SecretValue.unsafePlainText('cdkd-integ'),
        password: cdk.SecretValue.unsafePlainText('cdkd-integ-placeholder'),
      },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const fn = new lambda.Function(this, 'Fn', {
      functionName: `${this.stackName}-fn`,
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline('exports.handler=async()=>({});'),
    });

    fn.addEventSource(
      new SelfManagedKafkaEventSource({
        bootstrapServers: ['b-1.cdkd-integ.example.com:9092', 'b-2.cdkd-integ.example.com:9092'],
        topic: 'cdkd-integ-topic',
        secret,
        authenticationMethod: AuthenticationMethod.SASL_SCRAM_512_AUTH,
        startingPosition: lambda.StartingPosition.TRIM_HORIZON,
        batchSize: isUpdate ? 20 : 10,
        ...(isUpdate &&
          !isDefaults && { provisionedPollerConfig: { minimumPollers: 1, maximumPollers: 2 } }),
        ...(isUpdate &&
          !isRemoval && {
            schemaRegistryConfig: new ConfluentSchemaRegistry({
              schemaRegistryUri: 'https://schema-registry.cdkd-integ.example.com',
              eventRecordFormat: lambda.EventRecordFormat.JSON,
              authenticationType: lambda.KafkaSchemaRegistryAccessConfigType.BASIC_AUTH,
              secret,
              schemaValidationConfigs: [
                { attribute: lambda.KafkaSchemaValidationAttribute.VALUE },
              ],
            }),
          }),
        // Never poll the (non-existent) brokers.
        enabled: false,
      })
    );

    // Issue #1160, on the L1: the L2 source has no logging prop, and it fills
    // an omitted batchSize with 100, so only a deletion override drops it.
    const cfnEsm = fn.node
      .findAll()
      .find((c): c is lambda.CfnEventSourceMapping => c instanceof lambda.CfnEventSourceMapping);
    if (cfnEsm === undefined) throw new Error('no CfnEventSourceMapping under the function');
    // Issue #5356 (every phase): a zero batching window and a Value-less tag.
    cfnEsm.addPropertyOverride('MaximumBatchingWindowInSeconds', 0);
    cfnEsm.addPropertyOverride('Tags', [{ Key: 'cdkd-5356-novalue' }]);
    // On the L1: the L2 puts the topic in the mapping's construct id, so a
    // changed L2 `topic` is a new logical ID (a create + delete), never an
    // update.
    if (isTopicChange) cfnEsm.addPropertyOverride('Topics', ['cdkd-integ-topic-5356']);
    if (isDefaults) cfnEsm.addPropertyDeletionOverride('BatchSize');
    else if (isUpdate) cfnEsm.addPropertyOverride('LoggingConfig', { SystemLogLevel: 'WARN' });
    // Issue #1160 (third CFn A/B): the Kafka error-handling numerics, which AWS
    // takes in provisioned mode only. The REMOVAL phase drops them while the
    // poller config stays; CloudFormation keeps both values, and so must cdkd.
    if (isUpdate && !isRemoval) {
      cfnEsm.addPropertyOverride('MaximumRetryAttempts', 3);
      cfnEsm.addPropertyOverride('MaximumRecordAgeInSeconds', 3600);
    }

    // Issue #3850: the L1 interface may not know the member, so an override.
    const queueEsm = new lambda.CfnEventSourceMapping(this, 'QueueEsm', {
      functionName: fn.functionName,
      topics: ['cdkd-integ-queue-topic'],
      enabled: false,
      batchSize: isUpdate ? 20 : 10,
      selfManagedEventSource: {
        endpoints: { kafkaBootstrapServers: ['b-1.cdkd-integ.example.com:9092'] },
      },
      sourceAccessConfigurations: [{ type: 'SASL_SCRAM_512_AUTH', uri: secret.secretArn }],
    });
    queueEsm.addPropertyOverride(
      'SelfManagedKafkaEventSourceConfig.ConsumptionMode',
      modeChange === undefined ? 'Queue' : 'Stream'
    );
    if (modeChange === 'stream-sp') queueEsm.addPropertyOverride('StartingPosition', 'TRIM_HORIZON');
    if (fn.role !== undefined) queueEsm.node.addDependency(fn.role);
  }
}
