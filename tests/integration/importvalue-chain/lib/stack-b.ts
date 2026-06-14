import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ssm from 'aws-cdk-lib/aws-ssm';

/**
 * Stack B — the middle of the chain (consumer AND re-producer).
 *
 * This is the piece neither `cross-stack-references` nor
 * `import-value-strong-ref` exercises: a stack that BOTH imports an
 * upstream export AND re-exports a *derived* value built from it.
 *
 *   1. Imports `ChainTopicArn` from Stack A via Fn::ImportValue and stores
 *      it in an SSM Parameter (so the resolved value can be asserted on AWS
 *      and so cdkd records the import into state.imports[]).
 *   2. Derives a new value from the imported ARN (`Fn::Sub` wrapping the
 *      imported token) and re-exports it as `ChainDerivedValue`. Stack C
 *      imports THIS export.
 *
 * The derived re-export is the crux of the test: the value flowing into
 * C's import depends on a value B imported from A. If cdkd's exports index
 * or resolver mishandles the transitive case (e.g. resolves B's export
 * before B's own import resolved, or leaves a dangling token in the index),
 * C's deploy surfaces the bug.
 */
export class StackB extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const importedTopicArn = cdk.Fn.importValue('ChainTopicArn');

    // (1) Store the imported value so it can be asserted end-to-end and so
    //     cdkd records state.imports[] (sourceStack = Stack A).
    new ssm.StringParameter(this, 'ImportedTopicArnParam', {
      parameterName: '/cdkd-integ/importvalue-chain/b-imported-topic-arn',
      stringValue: importedTopicArn,
      description:
        'Stores the topic ARN Stack B imported from Stack A via ' +
        'Fn::ImportValue. Its state.imports[] entry makes A undeletable ' +
        'while B is deployed (chained strong reference).',
    });

    // (2) Derive a new value from the imported ARN and re-export it. The
    //     Fn::Sub forces the derived value to depend on the imported token,
    //     so `ChainDerivedValue` cannot resolve correctly unless A's export
    //     resolved first.
    const derived = cdk.Fn.sub('derived::${TopicArn}::from-b', {
      TopicArn: importedTopicArn,
    });

    new cdk.CfnOutput(this, 'ChainDerivedValueOutput', {
      value: derived,
      exportName: 'ChainDerivedValue',
      description:
        'Re-exported by Stack B; derived from the value B imported from ' +
        'Stack A. Imported by Stack C via Fn::ImportValue. This is the ' +
        'transitive link in the A -> B -> C chain.',
    });
  }
}
