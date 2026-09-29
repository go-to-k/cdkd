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
 * removal must reach AWS as the `{ SchemaRegistryConfig: {} }` reset.
 */
export class LambdaEsmSelfManagedKafkaStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const isUpdate = process.env.CDKD_TEST_UPDATE === 'true';
    const isRemoval = isUpdate && process.env.CDKD_TEST_REMOVAL === 'true';

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
        ...(isUpdate && { provisionedPollerConfig: { minimumPollers: 1, maximumPollers: 2 } }),
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
  }
}
