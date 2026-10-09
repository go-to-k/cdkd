import * as cdk from 'aws-cdk-lib';
import * as elasticache from 'aws-cdk-lib/aws-elasticache';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

/**
 * A `NoEcho: true` template PARAMETER consumed by resources (issue #1998).
 *
 * cdkd records such a value as a LOG-ONLY needle when a `Ref` or `Fn::Sub`
 * variable serves it: the provider's masker, the engine's error text and the
 * `deployments/*.jsonl` event mask it. Since state schema v11 (issue #4043)
 * what cdkd PERSISTS holds `***` where the value served a leaf, and an export
 * alias holding it is refused.
 * `verify.sh` generates the value per run and passes it in through
 * `CDKD_TEST_NOECHO_TOKEN`, which becomes the parameter's `Default` (cdkd
 * deploy takes no `--parameters`).
 *
 * - `NoEchoConsumer`: an SSM String parameter whose value embeds the token
 *   through `Fn::Sub`, so the resolver's `--verbose` `Resolved Fn::Sub:` line
 *   carries it; AWS holds it, and state.json holds `***` there (v11).
 * - `NoEchoReject` (only under `CDKD_TEST_NOECHO_REJECT=true`): an SSM
 *   parameter whose `Tier` IS the token. `PutParameter` rejects it with a
 *   service-side `ValidationException` that quotes the value back
 *   (`Value '<token>' at 'tier' failed to satisfy constraint`, measured), so
 *   the deploy fails through the provider's own error masking, the engine's
 *   error masking and the recorded event, the three surfaces the fix covers.
 *   An `AllowedPattern` rejection was the first vehicle and does NOT quote the
 *   value (`Parameter value, cannot be validated against allowedPattern`).
 * - `NoEchoRenamed` (go-to-k/cdkd#4049): an SNS topic whose create-only
 *   `TopicName` is a literal, and under `CDKD_TEST_NOECHO_RENAME=true` embeds
 *   the token, so that redeploy prints the diff's `--verbose`
 *   `requires replacement (from <old> to <new>)` line over it.
 * - `NoEchoAliasProbe` (go-to-k/cdkd#4043): the output's `Export.Name` IS a
 *   second `NoEcho` parameter (`CDKD_TEST_NOECHO_ALIAS_TOKEN`), so every
 *   deploy refuses the alias: it reaches neither state nor the exports index,
 *   and the warning names it masked.
 * - `NoEchoLiteralAliasProbe`, `NoEchoEarlyAliasProbe` and
 *   `NoEchoLateEncodedProbe` (go-to-k/cdkd#4043, Phase B): a literal name
 *   spelling the value only a resource reads, and an earlier literal name
 *   spelling the `Fn::Base64` encoding a LATER name records. Every deploy
 *   refuses all three aliases.
 * - `NoEchoShortAliasProbe` (go-to-k/cdkd#4657): an `Fn::Join` name embedding
 *   a fourth `NoEcho` parameter whose value is 3 characters
 *   (`CDKD_TEST_NOECHO_SHORT_TOKEN`), under the containment floor: only the
 *   positional refusal (the name READS the parameter) refuses it.
 * - `NoEchoSplitConsumer` (go-to-k/cdkd#4049): an SSM String parameter whose
 *   value is the SECOND piece of an `Fn::Split` over a third `NoEcho`
 *   parameter holding two comma-separated pieces
 *   (`CDKD_TEST_NOECHO_SPLIT_TOKEN`), so the resolver's `Resolved Fn::Split`
 *   line carries both pieces. `NoEchoSplitAliasProbe` exports under the FIRST
 *   piece, so every deploy refuses that alias too.
 * - `SplitChild` (go-to-k/cdkd#4049): a nested stack whose
 *   `CommaDelimitedList` parameter `ListIn` is fed that same `NoEcho` STRING,
 *   so the child engine receives it split and trimmed, and prints both
 *   elements on its `Resolved Ref to parameter: ListIn` line unless the
 *   inherited needle is carried element by element. Its SSM parameter holds
 *   the first element.
 * - `NoEchoFailingQueue` (only under `CDKD_TEST_NOECHO_FAIL=true`,
 *   go-to-k/cdkd#4043 Phase C): an SQS queue SQS rejects, created after
 *   `NoEchoConsumer`, so a `--no-rollback` deploy that changes the value
 *   fails with the SSM update journaled for `cdkd rollback`.
 * - `NoEchoSnapshotGroup` (only under `CDKD_TEST_NOECHO_SNAPSHOT=true`,
 *   go-to-k/cdkd#3869): a one-node Redis replication group whose id is
 *   `rg-<token>` and whose `DeletionPolicy` is `Snapshot`. The redeploy that
 *   removes it takes a final snapshot named after the id's first 28
 *   characters, which end inside the token, so no literal needle matches the
 *   snapshot name: only the derived-name judge's snapshot-prefix arm masks it.
 *
 * covers: AWS::SSM::Parameter, AWS::SNS::Topic, AWS::CloudFormation::Stack,
 * AWS::ElastiCache::ReplicationGroup
 */
/**
 * `SplitChild`: reads its list parameter's first element. A CDK-synthesized
 * nested parameter never says `NoEcho`, so only the parent's value knows it.
 */
class SplitChild extends cdk.NestedStack {
  constructor(scope: Construct, id: string, props: cdk.NestedStackProps) {
    super(scope, id, props);
    // Pinned so the child's cdkd state key is `<parent>~SplitChild`.
    (this.nestedStackResource as cdk.CfnResource).overrideLogicalId('SplitChild');
    const listIn = new cdk.CfnParameter(this, 'ListIn', { type: 'CommaDelimitedList' });
    listIn.overrideLogicalId('ListIn');
    new ssm.CfnParameter(this, 'SplitChildConsumer', {
      name: `cdkd-test-noecho-splitchild-${cdk.Stack.of(this).account}`,
      type: 'String',
      value: cdk.Fn.select(0, listIn.valueAsList),
    });
  }
}

export class NoechoParameterMaskingStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const account = cdk.Stack.of(this).account;

    const token = new cdk.CfnParameter(this, 'NoEchoToken', {
      type: 'String',
      noEcho: true,
      default: process.env['CDKD_TEST_NOECHO_TOKEN'] ?? 'cdkd-noecho-unset-token',
    });

    const consumer = new ssm.CfnParameter(this, 'NoEchoConsumer', {
      name: `cdkd-test-noecho-consumer-${account}`,
      type: 'String',
      // `token-`, not `token=`: the resolver's `--verbose` line prints a value
      // only when it is shell-inert and not an assignment word, so a `token=`
      // frame would be DESCRIBED there and the arm could no longer see the
      // mask (go-to-k/cdkd#4161).
      value: cdk.Fn.sub('token-${NoEchoToken}'),
      // go-to-k/cdkd#4043 Phase C: a non-NoEcho sibling the failing mode also
      // changes, so a rollback that restores it proves the revert's update ran.
      description:
        process.env['CDKD_TEST_NOECHO_FAIL'] === 'true'
          ? 'noecho-consumer-failing'
          : 'noecho-consumer',
    });

    new sns.CfnTopic(this, 'NoEchoRenamed', {
      topicName:
        process.env['CDKD_TEST_NOECHO_RENAME'] === 'true'
          ? cdk.Fn.sub('cdkd-test-noecho-rename-${AWS::AccountId}-${NoEchoToken}')
          : `cdkd-test-noecho-rename-${account}-a`,
    });

    const aliasToken = new cdk.CfnParameter(this, 'NoEchoAliasToken', {
      type: 'String',
      noEcho: true,
      default: process.env['CDKD_TEST_NOECHO_ALIAS_TOKEN'] ?? 'CdkdNoEchoAliasUnset',
    });
    new cdk.CfnOutput(this, 'NoEchoAliasProbe', {
      value: 'alias-probe-value',
      exportName: aliasToken.valueAsString,
    });
    // go-to-k/cdkd#4043 Phase B, the seed: a LITERAL name spelling the value
    // only `NoEchoConsumer` (a resource) reads. No output reads `NoEchoToken`.
    new cdk.CfnOutput(this, 'NoEchoLiteralAliasProbe', {
      value: 'literal-alias-probe-value',
      exportName: `literal-${process.env['CDKD_TEST_NOECHO_TOKEN'] ?? 'cdkd-noecho-unset-token'}`,
    });
    // go-to-k/cdkd#4043 Phase B, declaration order: an EARLIER literal name
    // spelling the Fn::Base64 encoding that only the LATER name's resolution
    // records. The seed holds the value, never its encoding.
    const aliasEncoding = Buffer.from(
      process.env['CDKD_TEST_NOECHO_ALIAS_TOKEN'] ?? 'CdkdNoEchoAliasUnset'
    ).toString('base64');
    new cdk.CfnOutput(this, 'NoEchoEarlyAliasProbe', {
      value: 'early-alias-probe-value',
      // A `Lazy` so CDK's export-name charset check (it reads only a literal)
      // lets the encoding's `=` / `+` / `/` through; it synthesizes as a literal.
      exportName: cdk.Lazy.string({ produce: () => `early-${aliasEncoding}` }),
    });
    new cdk.CfnOutput(this, 'NoEchoLateEncodedProbe', {
      value: 'late-encoded-probe-value',
      exportName: cdk.Fn.base64(aliasToken.valueAsString),
    });

    // go-to-k/cdkd#4657: a 3-character value embedded through an intrinsic.
    const shortToken = new cdk.CfnParameter(this, 'NoEchoShortToken', {
      type: 'String',
      noEcho: true,
      default: process.env['CDKD_TEST_NOECHO_SHORT_TOKEN'] ?? 'qzz',
    });
    new cdk.CfnOutput(this, 'NoEchoShortAliasProbe', {
      value: 'short-alias-probe-value',
      exportName: cdk.Fn.join('-', ['short', shortToken.valueAsString, 'probe']),
    });

    const splitToken = new cdk.CfnParameter(this, 'NoEchoSplitToken', {
      type: 'String',
      noEcho: true,
      default: process.env['CDKD_TEST_NOECHO_SPLIT_TOKEN'] ?? 'CdkdSplitUnsetA,CdkdSplitUnsetB',
    });
    const pieces = cdk.Fn.split(',', splitToken.valueAsString);
    new ssm.CfnParameter(this, 'NoEchoSplitConsumer', {
      name: `cdkd-test-noecho-split-${account}`,
      type: 'String',
      value: cdk.Fn.select(1, pieces),
    });
    new cdk.CfnOutput(this, 'NoEchoSplitAliasProbe', {
      value: 'split-alias-probe-value',
      exportName: cdk.Fn.select(0, pieces),
    });
    new SplitChild(this, 'SplitChild', {
      parameters: { ListIn: splitToken.valueAsString },
    });

    if (process.env['CDKD_TEST_NOECHO_SNAPSHOT'] === 'true') {
      const group = new elasticache.CfnReplicationGroup(this, 'NoEchoSnapshotGroup', {
        replicationGroupId: cdk.Fn.sub('rg-${NoEchoToken}'),
        replicationGroupDescription: 'cdkd noecho-parameter-masking integ (go-to-k/cdkd#3869)',
        engine: 'redis',
        cacheNodeType: 'cache.t3.micro',
        numCacheClusters: 1,
        automaticFailoverEnabled: false,
        tags: [{ key: 'cdkd-integ', value: 'noecho-parameter-masking-snapshot' }],
      });
      group.cfnOptions.deletionPolicy = cdk.CfnDeletionPolicy.SNAPSHOT;
    }

    if (process.env['CDKD_TEST_NOECHO_FAIL'] === 'true') {
      // go-to-k/cdkd#4043 Phase C: fails AFTER NoEchoConsumer's update (it
      // depends on it), so a `--no-rollback` deploy leaves that update in the
      // journal for `cdkd rollback` to revert. SQS rejects the retention.
      const failing = new sqs.CfnQueue(this, 'NoEchoFailingQueue', {
        queueName: `cdkd-test-noecho-failing-${account}`,
        messageRetentionPeriod: 9999999,
      });
      failing.addDependency(consumer);
    }

    if (process.env['CDKD_TEST_NOECHO_REJECT'] === 'true') {
      new ssm.CfnParameter(this, 'NoEchoReject', {
        name: `cdkd-test-noecho-reject-${account}`,
        type: 'String',
        value: 'noecho-reject-probe',
        tier: token.valueAsString,
      });
    }
  }
}
