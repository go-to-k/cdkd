import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as appsync from 'aws-cdk-lib/aws-appsync';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as ssm from 'aws-cdk-lib/aws-ssm';

/**
 * `QueueReaderChild`: stores the parent-passed queue ARN. Its description
 * changes on UPDATE, so the parent's row is updated too.
 */
class QueueReaderChild extends cdk.NestedStack {
  constructor(scope: Construct, id: string, props: cdk.NestedStackProps & { update: boolean }) {
    super(scope, id, props);
    // Pinned so the child's cdkd state key is `<parent>~QueueReaderChild`.
    (this.nestedStackResource as cdk.CfnResource).overrideLogicalId('QueueReaderChild');
    const queueArn = new cdk.CfnParameter(this, 'QueueArn', { type: 'String' });
    queueArn.overrideLogicalId('QueueArn');
    // Bound and never read: its value is SecretQueue's URL, the queue's
    // PHYSICAL id, which state records in plaintext (the recorded ARN
    // attribute is redacted to its `{{resolve:` spelling). `cdkd diff
    // --recursive` binds it, and its `Parameter QueueUrl:` line is the one
    // that names the queue unless masked (go-to-k/cdkd#3869).
    const queueUrl = new cdk.CfnParameter(this, 'QueueUrl', { type: 'String' });
    queueUrl.overrideLogicalId('QueueUrl');
    new ssm.CfnParameter(this, 'ChildQueueArn', {
      // Named per run by `verify.sh`, so its cleanup can delete it by name.
      name: process.env.SDIN_CHILD_PARAM_NAME ?? '/cdkd-integ/sdin-unset/child-queue-arn',
      type: 'String',
      value: queueArn.valueAsString,
      description: props.update ? 'cdkd integ: updated' : 'cdkd integ: initial',
    });
  }
}

/**
 * Immutable NAMES taken from a Secrets Manager secret, updated in place
 * (go-to-k/cdkd#4264, go-to-k/cdkd#4275).
 *
 * cdkd records a secret-derived value as its `{{resolve:secretsmanager:...}}`
 * expression, while a provider's `update()` receives the resolved value. Each
 * provider's immutable-name guard compared the two, saw a rename that never
 * happened, and refused every in-place update of the resource.
 *
 * `verify.sh` seeds the secret `SDIN_SECRET_NAME` with `{"stage": ...,
 * "service": ...}`, so both names reach cdkd only through the secret.
 *
 * Deploys:
 *   - `SecretStage` (AWS::ApiGatewayV2::Stage), `StageName` from the secret.
 *     The physical id IS the stage name, so the provider compares the
 *     resolved name with it.
 *   - `PlainStage`, a literal `StageName`: the positive control, updated the
 *     same way; it passes with or without the fix.
 *   - `SecretService` (AWS::ECS::Service), `ServiceName` from the secret
 *     (go-to-k/cdkd#4263): EC2 launch type with `DesiredCount: 0`, so it needs
 *     no VPC, no capacity and runs nothing. The physical id is the service
 *     ARN, which ends with the name.
 *
 *   - `SecretPolicy` (AWS::IAM::ManagedPolicy), `Path` and `Description`
 *     from the secret. Both are create-only, and the provider REPLACED the
 *     policy on every update (a create under the same name and path, which
 *     IAM refuses). The policy ARN carries the path; the description takes
 *     the masker arm.
 *   - `SecretApi` (AWS::AppSync::GraphQLApi), `Name` from the secret: the
 *     physical id is the API id, so the provider asks AppSync for the live
 *     name. `SecretDataSource` (AWS::AppSync::DataSource, type NONE), `Name`
 *     from the secret: the `<apiId>|<name>` physical id carries it.
 *   - `SecretQueue` (AWS::SQS::Queue), `QueueName` from the secret
 *     (go-to-k/cdkd#2177): the provider's own update debug lines print the
 *     queue URL, which carries the name, with no per-site masker. Only the
 *     logger's sink mask keeps the name out of the `--verbose` log.
 *   - `SecretFilter` (AWS::Logs::MetricFilter, no SDK provider, so it routes
 *     to Cloud Control), `FilterName` from the secret. `FilterName` is
 *     create-only, and Cloud Control's `update()` built its JSON Patch from
 *     the recorded bag: the recorded reference against the resolved name put
 *     an op on that create-only path in every update's patch. `verify.sh`
 *     rotates the secret's `filter` field before the update, so that op
 *     would carry a name the filter does not have.
 *
 *   - `SecretSchedule` (AWS::Scheduler::Schedule, DISABLED), `GroupName`
 *     from the secret, in `SecretScheduleGroup` (Cloud Control), whose `Name`
 *     comes from the same field (go-to-k/cdkd#4275). The schedule's ARN embeds
 *     the group, so nothing in the record named it: the update was refused,
 *     and the destroy skipped it. cdkd now records the schedule's creation
 *     date and confirms the group the secret resolves to holds that schedule
 *     before the update, and finds it by that date to delete it.
 *   - `SecretQueueReaderPolicy` (AWS::SQS::QueuePolicy) reads SecretQueue by
 *     `Ref` and `Fn::GetAtt`, and `PlainScheduleRole` attaches SecretPolicy by
 *     `Ref` (go-to-k/cdkd#3869): each read resolves to a value embedding a
 *     secret-derived name (the queue name, the policy path), which no log line
 *     may print.
 *   - `PlainTargetSchedule`, in the same group with its own role. Both
 *     schedules target `PlainTargetQueue`, whose name is NOT secret-derived,
 *     so each one's recorded target ARN and role are compared with the live
 *     ones too. A redacted recorded target or role (the date then decides) is
 *     covered by unit tests only.
 *
 *   - `QueueReaderChild` (a nested stack, go-to-k/cdkd#3869) receives
 *     SecretQueue's ARN as its `QueueArn` parameter and stores it in an SSM
 *     String parameter, and its URL as `QueueUrl`, which it only binds. The parent's read is no recorded secret of the row, and
 *     never may be (it would seed the child's export-name verdict), so the
 *     child's `Resolved Ref to parameter: QueueArn` and provider lines printed
 *     the queue name until the row's reads joined the printing bag bound around
 *     its body.
 *
 * UPDATE (CDKD_TEST_UPDATE=true) changes only the Stages' `Description`, the
 * Service's `EnableECSManagedTags` (it has no description), the Policy's
 * `PolicyDocument`, the API's `XrayEnabled`, the DataSource's `Description`
 * the Queue's `VisibilityTimeout`, the Filter's `FilterPattern` and the Schedule's
 * `Description`: ordinary in-place changes, so the update is not a no-op.
 *
 * covers: AWS::ApiGatewayV2::Api
 * covers: AWS::ApiGatewayV2::Stage
 * covers: AWS::ECS::Cluster
 * covers: AWS::ECS::TaskDefinition
 * covers: AWS::ECS::Service
 * covers: AWS::IAM::ManagedPolicy
 * covers: AWS::AppSync::GraphQLApi
 * covers: AWS::AppSync::DataSource
 * covers: AWS::SQS::Queue
 * covers: AWS::SQS::QueuePolicy
 * covers: AWS::Logs::LogGroup
 * covers: AWS::Logs::MetricFilter
 * covers: AWS::Scheduler::ScheduleGroup
 * covers: AWS::Scheduler::Schedule
 * covers: AWS::IAM::Role
 * covers: AWS::CloudFormation::Stack
 * covers: AWS::SSM::Parameter
 */
export class SecretDerivedImmutableNamesStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    const update = process.env.CDKD_TEST_UPDATE === 'true';
    const description = update ? 'cdkd integ: updated' : 'cdkd integ: initial';
    // A placeholder keeps `cdk synth` working without the script; a deploy
    // against it fails at resolve time, which is the loud outcome.
    const secretName = process.env.SDIN_SECRET_NAME ?? 'cdkd-integ-sdin-unset';
    const fromSecret = (jsonField: string): string =>
      cdk.SecretValue.secretsManager(secretName, { jsonField }).unsafeUnwrap();

    const api = new apigwv2.CfnApi(this, 'Api', {
      name: 'CdkdSecretDerivedImmutableNamesApi',
      protocolType: 'HTTP',
    });
    new apigwv2.CfnStage(this, 'SecretStage', {
      apiId: api.ref,
      stageName: fromSecret('stage'),
      description,
    });
    new apigwv2.CfnStage(this, 'PlainStage', {
      apiId: api.ref,
      stageName: 'plain',
      description,
    });

    const cluster = new ecs.CfnCluster(this, 'Cluster');
    const taskDefinition = new ecs.CfnTaskDefinition(this, 'TaskDef', {
      requiresCompatibilities: ['EC2'],
      networkMode: 'bridge',
      containerDefinitions: [
        { name: 'app', image: 'public.ecr.aws/docker/library/busybox:latest', memory: 32 },
      ],
    });
    new ecs.CfnService(this, 'SecretService', {
      cluster: cluster.ref,
      serviceName: fromSecret('service'),
      taskDefinition: taskDefinition.ref,
      launchType: 'EC2',
      desiredCount: 0,
      enableEcsManagedTags: update,
    });

    const secretPolicy = new iam.CfnManagedPolicy(this, 'SecretPolicy', {
      path: fromSecret('path'),
      description: fromSecret('policydesc'),
      policyDocument: {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Action: update ? ['sts:GetCallerIdentity', 'sts:GetSessionToken'] : 'sts:GetCallerIdentity',
            Resource: '*',
          },
        ],
      },
    });

    const graphqlApi = new appsync.CfnGraphQLApi(this, 'SecretApi', {
      name: fromSecret('api'),
      authenticationType: 'API_KEY',
      xrayEnabled: update,
    });
    new appsync.CfnDataSource(this, 'SecretDataSource', {
      apiId: graphqlApi.attrApiId,
      name: fromSecret('datasource'),
      type: 'NONE',
      description,
    });

    const secretQueue = new sqs.CfnQueue(this, 'SecretQueue', {
      queueName: fromSecret('queue'),
      visibilityTimeout: update ? 60 : 30,
    });
    // READERS of the secret-named queue (go-to-k/cdkd#3869): a `Ref` (its URL)
    // and a `Fn::GetAtt` (its ARN) each resolve to a value embedding the name
    // and are no recorded secret, so before the fix the resolver's `resolved
    // to` lines printed the name. The Sid changes on update, so the policy is
    // written on both deploys.
    new sqs.CfnQueuePolicy(this, 'SecretQueueReaderPolicy', {
      queues: [secretQueue.ref],
      policyDocument: {
        Version: '2012-10-17',
        Statement: [
          {
            Sid: update ? 'SdinReaderUpdated' : 'SdinReaderInitial',
            Effect: 'Allow',
            Principal: { AWS: cdk.Stack.of(this).account },
            Action: 'sqs:SendMessage',
            Resource: secretQueue.attrArn,
          },
        ],
      },
    });

    // Both schedules target this queue, whose name is NOT secret-derived, so
    // each schedule's recorded target is a readable ARN the identity match
    // compares; a `Fn::GetAtt` of the secret-named SecretQueue is exercised by
    // SecretQueueReaderPolicy instead (go-to-k/cdkd#3869). The shared target
    // also leaves only the ROLE to tell the two schedules apart.
    const plainTargetQueue = new sqs.CfnQueue(this, 'PlainTargetQueue', {});
    const scheduleRole = new iam.CfnRole(this, 'ScheduleRole', {
      assumeRolePolicyDocument: {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: { Service: 'scheduler.amazonaws.com' },
            Action: 'sts:AssumeRole',
          },
        ],
      },
      policies: [
        {
          policyName: 'send',
          policyDocument: {
            Version: '2012-10-17',
            Statement: [
              { Effect: 'Allow', Action: 'sqs:SendMessage', Resource: plainTargetQueue.attrArn },
            ],
          },
        },
      ],
    });
    const scheduleGroup = new scheduler.CfnScheduleGroup(this, 'SecretScheduleGroup', {
      name: fromSecret('group'),
    });
    const schedule = new scheduler.CfnSchedule(this, 'SecretSchedule', {
      name: 'CdkdSdinSchedule',
      // The secret reference itself, not `scheduleGroup.ref`, so the recorded
      // GroupName is the reference.
      groupName: fromSecret('group'),
      description,
      state: 'DISABLED',
      flexibleTimeWindow: { mode: 'OFF' },
      scheduleExpression: 'rate(1 day)',
      target: { arn: plainTargetQueue.attrArn, roleArn: scheduleRole.attrArn },
    });
    schedule.addDependency(scheduleGroup);

    // A second schedule in the same secret-derived group, with its own role:
    // the two share a name prefix, a group and a target.
    const plainScheduleRole = new iam.CfnRole(this, 'PlainScheduleRole', {
      // A `Ref` to SecretPolicy, whose ARN carries the secret's path
      // (go-to-k/cdkd#3869): the role provider's attach line and the
      // resolver's `resolved to` line print it.
      managedPolicyArns: [secretPolicy.ref],
      assumeRolePolicyDocument: {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: { Service: 'scheduler.amazonaws.com' },
            Action: 'sts:AssumeRole',
          },
        ],
      },
      policies: [
        {
          policyName: 'send',
          policyDocument: {
            Version: '2012-10-17',
            Statement: [
              { Effect: 'Allow', Action: 'sqs:SendMessage', Resource: plainTargetQueue.attrArn },
            ],
          },
        },
      ],
    });
    const plainTargetSchedule = new scheduler.CfnSchedule(this, 'PlainTargetSchedule', {
      name: 'CdkdSdinSchedulePlainTarget',
      groupName: fromSecret('group'),
      description,
      state: 'DISABLED',
      flexibleTimeWindow: { mode: 'OFF' },
      scheduleExpression: 'rate(1 day)',
      target: { arn: plainTargetQueue.attrArn, roleArn: plainScheduleRole.attrArn },
    });
    plainTargetSchedule.addDependency(scheduleGroup);

    new QueueReaderChild(this, 'QueueReaderChild', {
      parameters: { QueueArn: secretQueue.attrArn, QueueUrl: secretQueue.ref },
      update,
    });

    const logGroup = new logs.CfnLogGroup(this, 'FilterLogGroup', { retentionInDays: 1 });
    new logs.CfnMetricFilter(this, 'SecretFilter', {
      filterName: fromSecret('filter'),
      logGroupName: logGroup.ref,
      filterPattern: update ? 'ERROR' : 'WARN',
      metricTransformations: [
        { metricName: 'SdinFilterHits', metricNamespace: 'CdkdIntegSdin', metricValue: '1' },
      ],
    });
  }
}
