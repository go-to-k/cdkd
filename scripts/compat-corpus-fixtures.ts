/**
 * scripts/compat-corpus-fixtures.ts
 *
 * Optional corpus generator for `scripts/compat-corpus.ts`. Synthesizes a
 * diverse set of typical CDK stacks (env-agnostic, so pseudo-params /
 * `Fn::GetAZs` / `Fn::Select` appear realistically) into a temp dir, then
 * point `compat-corpus` at it for ad-hoc compatibility measurement:
 *
 *   node scripts/compat-corpus-fixtures.ts            # synth to default out dir
 *   node scripts/compat-corpus-fixtures.ts <out-dir>  # synth to a chosen dir
 *   vp run compat-corpus <out-dir>                    # then measure
 *
 * Each stack synths in its OWN `App` so one construct failure (e.g. a CDK
 * version that renamed a construct) does not abort the rest. Uses the
 * repo's own `aws-cdk-lib` via a `createRequire` rooted at the repo's
 * `package.json` — no hardcoded user paths.
 *
 * This is a dev convenience only. It is NOT a CI gate and writes nothing
 * into the repo tree (output defaults to the OS temp dir).
 */

import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), '..');

// Resolve aws-cdk-lib from the repo's own node_modules.
const require = createRequire(join(REPO_ROOT, 'package.json'));
/* eslint-disable @typescript-eslint/no-explicit-any */
const cdk: any = require('aws-cdk-lib');
const {
  App,
  Stack,
  Duration,
  aws_s3: s3,
  aws_lambda: lambda,
  aws_dynamodb: dynamodb,
  aws_iam: iam,
  aws_sns: sns,
  aws_sqs: sqs,
  aws_kms: kms,
  aws_ec2: ec2,
  aws_ecs: ecs,
  aws_ecs_patterns: ecsp,
  aws_rds: rds,
  aws_apigateway: apigw,
  aws_cloudfront: cloudfront,
  aws_cloudfront_origins: origins,
  aws_cognito: cognito,
  aws_stepfunctions: sfn,
  aws_events: events,
  aws_events_targets: targets,
  aws_logs: logs,
  aws_secretsmanager: secrets,
  aws_ssm: ssm,
  aws_certificatemanager: acm,
  aws_elasticache: elasticache,
  aws_wafv2: wafv2,
  aws_route53: route53,
  aws_sns_subscriptions: subs,
  custom_resources: cr,
} = cdk;

const fn = (s: any): any =>
  new lambda.Function(s, 'Fn', {
    runtime: lambda.Runtime.NODEJS_20_X,
    handler: 'index.handler',
    code: lambda.Code.fromInline('exports.handler=async()=>({statusCode:200});'),
  });

type StackBuilder = [name: string, build: (s: any) => void];

const stacks: StackBuilder[] = [
  [
    'lambda-dynamodb',
    (s) => {
      const t = new dynamodb.Table(s, 'T', {
        partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
      });
      t.grantReadWriteData(fn(s));
    },
  ],
  [
    's3-kms',
    (s) => {
      const k = new kms.Key(s, 'K');
      new s3.Bucket(s, 'B', {
        encryption: s3.BucketEncryption.KMS,
        encryptionKey: k,
        enforceSSL: true,
      });
    },
  ],
  [
    'sns-sqs',
    (s) => {
      const q = new sqs.Queue(s, 'Q');
      const tp = new sns.Topic(s, 'Tp');
      tp.addSubscription(new subs.SqsSubscription(q));
    },
  ],
  [
    'apigw-lambda',
    (s) => {
      const api = new apigw.RestApi(s, 'Api');
      api.root.addMethod('GET', new apigw.LambdaIntegration(fn(s)));
    },
  ],
  [
    'cognito',
    (s) => {
      const up = new cognito.UserPool(s, 'UP');
      up.addClient('Client');
      up.addDomain('D', { cognitoDomain: { domainPrefix: 'compat-corpus-pool-xyz' } });
    },
  ],
  [
    'stepfunctions',
    (s) => {
      const wait = new sfn.Wait(s, 'W', { time: sfn.WaitTime.duration(Duration.seconds(1)) });
      new sfn.StateMachine(s, 'SM', { definitionBody: sfn.DefinitionBody.fromChainable(wait) });
    },
  ],
  [
    'events-lambda',
    (s) => {
      const r = new events.Rule(s, 'R', { schedule: events.Schedule.rate(Duration.minutes(5)) });
      r.addTarget(new targets.LambdaFunction(fn(s)));
    },
  ],
  ['vpc-only', (s) => { new ec2.Vpc(s, 'Vpc', { maxAzs: 2, natGateways: 1 }); }],
  [
    'rds',
    (s) => {
      const vpc = new ec2.Vpc(s, 'Vpc', { maxAzs: 2, natGateways: 1 });
      new rds.DatabaseInstance(s, 'Db', {
        engine: rds.DatabaseInstanceEngine.postgres({
          version: rds.PostgresEngineVersion.VER_16,
        }),
        vpc,
        instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
      });
    },
  ],
  [
    'ecs-fargate-alb',
    (s) => {
      const vpc = new ec2.Vpc(s, 'Vpc', { maxAzs: 2, natGateways: 1 });
      const cluster = new ecs.Cluster(s, 'C', { vpc });
      new ecsp.ApplicationLoadBalancedFargateService(s, 'Svc', {
        cluster,
        memoryLimitMiB: 512,
        cpu: 256,
        taskImageOptions: {
          image: ecs.ContainerImage.fromRegistry('amazon/amazon-ecs-sample'),
        },
      });
    },
  ],
  [
    'cloudfront-oac',
    (s) => {
      const b = new s3.Bucket(s, 'B');
      new cloudfront.Distribution(s, 'D', {
        defaultBehavior: { origin: origins.S3BucketOrigin.withOriginAccessControl(b) },
      });
    },
  ],
  [
    'iam-managed-policy',
    (s) => {
      const mp = new iam.ManagedPolicy(s, 'MP', {
        statements: [new iam.PolicyStatement({ actions: ['s3:GetObject'], resources: ['*'] })],
      });
      const role = new iam.Role(s, 'Role', {
        assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      });
      role.addManagedPolicy(mp);
    },
  ],
  [
    'acm-cert',
    (s) => {
      new acm.Certificate(s, 'Cert', {
        domainName: 'compat.example.com',
        validation: acm.CertificateValidation.fromDns(),
      });
    },
  ],
  [
    'secrets-ssm',
    (s) => {
      new secrets.Secret(s, 'Sec');
      new ssm.StringParameter(s, 'P', { stringValue: 'hello' });
    },
  ],
  ['logs', (s) => { new logs.LogGroup(s, 'LG', { retention: logs.RetentionDays.ONE_WEEK }); }],
  [
    'elasticache',
    (s) => {
      const vpc = new ec2.Vpc(s, 'Vpc', { maxAzs: 2, natGateways: 0 });
      const sg = new elasticache.CfnSubnetGroup(s, 'SG', {
        description: 'compat-corpus',
        subnetIds: vpc.privateSubnets.map((x: any) => x.subnetId),
      });
      const cc = new elasticache.CfnCacheCluster(s, 'CC', {
        cacheNodeType: 'cache.t3.micro',
        engine: 'redis',
        numCacheNodes: 1,
        cacheSubnetGroupName: sg.ref,
      });
      cc.addDependency(sg);
    },
  ],
  [
    'wafv2',
    (s) => {
      new wafv2.CfnWebACL(s, 'ACL', {
        defaultAction: { allow: {} },
        scope: 'REGIONAL',
        visibilityConfig: {
          cloudWatchMetricsEnabled: true,
          metricName: 'm',
          sampledRequestsEnabled: true,
        },
        rules: [],
      });
    },
  ],
  [
    'route53',
    (s) => {
      const z = new route53.HostedZone(s, 'Z', { zoneName: 'compat.example.com' });
      new route53.ARecord(s, 'A', { zone: z, target: route53.RecordTarget.fromIpAddresses('1.2.3.4') });
    },
  ],
  [
    'dynamodb-autoscaling',
    (s) => {
      const t = new dynamodb.Table(s, 'T', {
        partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
        billingMode: dynamodb.BillingMode.PROVISIONED,
      });
      t.autoScaleReadCapacity({ minCapacity: 1, maxCapacity: 10 }).scaleOnUtilization({
        targetUtilizationPercent: 70,
      });
    },
  ],
  [
    'lambda-custom-resource',
    (s) => {
      new cr.AwsCustomResource(s, 'CR', {
        onCreate: {
          service: 'SSM',
          action: 'getParameter',
          parameters: { Name: 'x' },
          physicalResourceId: cr.PhysicalResourceId.of('x'),
        },
        policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
          resources: cr.AwsCustomResourcePolicy.ANY_RESOURCE,
        }),
      });
    },
  ],
];

function main(): void {
  const argDir = process.argv[2];
  const out = argDir ? resolve(argDir) : mkdtempSync(join(tmpdir(), 'cdkd-compat-corpus-'));
  if (argDir) {
    // Caller-chosen dir: start clean so stale templates don't pollute.
    rmSync(out, { recursive: true, force: true });
  }

  let ok = 0;
  let fail = 0;
  for (const [name, build] of stacks) {
    try {
      const app = new App({ outdir: join(out, name) });
      const stack = new Stack(app, name);
      build(stack);
      app.synth();
      ok++;
    } catch (e) {
      fail++;
      const msg = String((e as Error)?.message ?? e).split('\n')[0];
      process.stderr.write(`SYNTH FAIL ${name}: ${msg}\n`);
    }
  }
  process.stderr.write(`\nsynthed ok=${ok} fail=${fail} into ${out}\n`);
  // Print the dir to stdout so it can be captured:
  //   DIR=$(node scripts/compat-corpus-fixtures.ts); vp run compat-corpus "$DIR"
  process.stdout.write(`${out}\n`);
}

main();
