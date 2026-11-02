import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as elasticache from 'aws-cdk-lib/aws-elasticache';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

/**
 * Issue #5635: `AWS::ElastiCache::CacheCluster` `SnapshotArns` on the SDK route.
 *
 * covers: AWS::ElastiCache::CacheCluster
 *
 * A single-node redis cluster seeded from an RDB file in S3. verify.sh writes
 * the file (one string key) to a bucket it owns and passes the object ARN in
 * `CDKD_TEST_SEED_RDB_ARN`; the placeholder default only lets the app synth
 * without verify.sh, and a deploy of it fails at CreateCacheCluster.
 *
 * DescribeCacheClusters has no SnapshotArns member, so verify.sh reads the
 * value back through the DATA it seeds: the `SeedReader` function, in the
 * cluster's VPC, GETs the seeded key over RESP and returns it.
 *
 * Cheap: one cache.t4g.micro node and a VPC with no NAT gateway.
 */
export class ElastiCacheSnapshotArnsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const seedArn =
      process.env.CDKD_TEST_SEED_RDB_ARN ??
      'arn:aws:s3:::cdkd-integ-5635-seed-placeholder/seed/dump.rdb';

    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        { name: 'isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });

    const readerSg = new ec2.SecurityGroup(this, 'ReaderSg', {
      vpc,
      description: 'cdkd elasticache-snapshot-arns seed reader',
      allowAllOutbound: true,
    });
    const redisSg = new ec2.SecurityGroup(this, 'RedisSg', {
      vpc,
      description: 'cdkd elasticache-snapshot-arns redis',
      allowAllOutbound: true,
    });
    redisSg.addIngressRule(readerSg, ec2.Port.tcp(6379), 'seed reader to redis');

    const subnetGroup = new elasticache.CfnSubnetGroup(this, 'SubnetGroup', {
      description: 'cdkd elasticache-snapshot-arns subnet group',
      subnetIds: vpc.isolatedSubnets.map((s) => s.subnetId),
    });

    const redis = new elasticache.CfnCacheCluster(this, 'Redis', {
      engine: 'redis',
      cacheNodeType: 'cache.t4g.micro',
      numCacheNodes: 1,
      cacheSubnetGroupName: subnetGroup.ref,
      vpcSecurityGroupIds: [redisSg.securityGroupId],
      // The property under test (create-only).
      snapshotArns: [seedArn],
    });
    redis.addDependency(subnetGroup);

    const readerLogs = new logs.LogGroup(this, 'SeedReaderLogs', {
      logGroupName: `/aws/lambda/${this.stackName}-seed-reader`,
      retention: logs.RetentionDays.ONE_DAY,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // GET <event.key> from <event.host>:<event.port> over RESP with nothing
    // but `net`: no bundled client. Returns { found: false } for a nil reply,
    // { found: true, value } else.
    //
    // The endpoint arrives in the PAYLOAD, not as an environment variable
    // naming the cluster's attributes: that made the function wait for the
    // cluster, so it was created last and invoked while still `Pending` (a
    // VPC function takes minutes to go Active, and cdkd, by design, does not
    // wait for it). Independent of the cluster, it is created at the start of
    // the deploy and goes Active while the cluster is being created.
    new lambda.Function(this, 'SeedReader', {
      functionName: `${this.stackName}-seed-reader`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      timeout: cdk.Duration.seconds(30),
      memorySize: 128,
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [readerSg],
      logGroup: readerLogs,
      code: lambda.Code.fromInline(`
const net = require('net');
exports.handler = (event) => new Promise((resolve, reject) => {
  const key = String(event.key);
  const sock = net.createConnection({ host: String(event.host), port: Number(event.port) });
  let buf = Buffer.alloc(0);
  const timer = setTimeout(() => { sock.destroy(); reject(new Error('timed out reading redis')); }, 15000);
  const finish = (err, result) => { clearTimeout(timer); sock.destroy(); if (err) reject(err); else resolve(result); };
  sock.on('connect', () => sock.write('*2\\r\\n$3\\r\\nGET\\r\\n$' + Buffer.byteLength(key) + '\\r\\n' + key + '\\r\\n'));
  sock.on('error', (err) => finish(err));
  sock.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    const nl = buf.indexOf('\\r\\n');
    if (nl < 0) return;
    const head = buf.subarray(0, nl).toString();
    if (head === '$-1') return finish(null, { found: false });
    if (head[0] !== '$') return finish(new Error('unexpected redis reply: ' + head));
    const n = Number(head.slice(1));
    if (buf.length < nl + 2 + n + 2) return;
    finish(null, { found: true, value: buf.subarray(nl + 2, nl + 2 + n).toString() });
  });
});
`),
    });

    new cdk.CfnOutput(this, 'CacheClusterId', { value: redis.ref });
  }
}
