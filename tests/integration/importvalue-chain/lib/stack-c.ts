import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ssm from 'aws-cdk-lib/aws-ssm';

/**
 * Stack C — the tail of the chain (pure consumer).
 *
 * Imports `ChainDerivedValue` from Stack B via Fn::ImportValue and stores
 * it in an SSM Parameter so the resolved value can be asserted on AWS. The
 * value C ends up with was derived by B from a value B imported from A, so
 * a correct resolve here proves the full A -> B -> C transitive chain.
 *
 * C's import records state.imports[] (sourceStack = Stack B), so attempting
 * to destroy B while C is deployed is refused by the strong-ref check — the
 * second link in the chained protection (A protected by B, B protected by C).
 */
export class StackC extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const importedDerived = cdk.Fn.importValue('ChainDerivedValue');

    new ssm.StringParameter(this, 'ImportedDerivedParam', {
      parameterName: '/cdkd-integ/importvalue-chain/c-imported-derived',
      stringValue: importedDerived,
      description:
        'Stores the derived value Stack C imported from Stack B via ' +
        'Fn::ImportValue. The resolved value proves the transitive ' +
        'A -> B -> C chain (B derived it from A; C imported it from B).',
    });
  }
}
