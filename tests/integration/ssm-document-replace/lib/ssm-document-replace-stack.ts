import * as cdk from 'aws-cdk-lib';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';

/**
 * Two SSM Command documents whose `content` changes (issue #6568).
 *
 * `AWS::SSM::Document` has no SDK provider, so both go through Cloud Control.
 * Under the default `UpdateMethod: Replace` a `Content` change replaces the
 * document in CloudFormation; with `NewVersion` it adds a document version in
 * place. cdkd called every such change an in-place update, and the Cloud
 * Control handler refused the default one ("Create-Only Property cannot be
 * updated").
 *
 *  - `DocUnnamed`: no `name` and no `updateMethod` (the usual shape). The
 *    change must replace it create-first under a new generated name.
 *  - `DocNamed`: a fixed name and `updateMethod: 'NewVersion'`. The change
 *    must stay an in-place update that adds a version.
 *
 * `CDKD_TEST_UPDATE=true` changes the command each document runs (v1 -> v2).
 * Both carry a stack tag, so the teardown finds a document a failed deploy
 * created before state recorded it.
 *
 * covers: AWS::SSM::Document
 */
export class SsmDocumentReplaceStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    const marker = process.env.CDKD_TEST_UPDATE === 'true' ? 'v2' : 'v1';
    const content = (label: string) => ({
      schemaVersion: '2.2',
      description: `cdkd integ ${label} document`,
      mainSteps: [
        {
          action: 'aws:runShellScript',
          name: 'run',
          inputs: { runCommand: [`echo cdkd-${label}-${marker}`] },
        },
      ],
    });
    const tags = [{ key: 'cdkd-integ', value: this.stackName }];

    // Deliberately no `name` and no `updateMethod`: the default Replace.
    const unnamed = new ssm.CfnDocument(this, 'DocUnnamed', {
      documentType: 'Command',
      content: content('unnamed'),
      tags,
    });

    const named = new ssm.CfnDocument(this, 'DocNamed', {
      documentType: 'Command',
      name: `${this.stackName}-named`,
      updateMethod: 'NewVersion',
      content: content('named'),
      tags,
    });

    new cdk.CfnOutput(this, 'UnnamedDocumentName', { value: unnamed.ref });
    new cdk.CfnOutput(this, 'NamedDocumentName', { value: named.ref });
  }
}
