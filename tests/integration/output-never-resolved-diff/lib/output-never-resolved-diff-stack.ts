import * as cdk from 'aws-cdk-lib';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

/**
 * Fixture for issue #2740: an Output that NEVER resolves at deploy, because
 * its failure happens INSIDE a secret lookup — a JSON key the secret does not
 * hold — under the default (non-`--strict-getatt`) arm. The deploy warns,
 * skips the output and never writes the key to `state.outputs`; `cdkd diff`
 * resolves outputs with `skipDynamicReferences`, so the reference ASSEMBLES
 * there instead of failing, and pre-fix the diff reported an `ADD` the deploy
 * would never perform, on every run of the unchanged stack.
 *
 * covers: AWS::SecretsManager::Secret
 * covers: AWS::SSM::Parameter
 *
 * Resources (cheap, no VPC):
 *   - ONE SecretsManager secret with a KNOWN JSON value that holds `username`
 *     and NOTHING ELSE. Every reference below names this secret by its
 *     literal name (see the last paragraph for the two shapes that
 *     synthesizes to), so it is exactly the dynamic reference cdkd resolves.
 *
 * Outputs:
 *   - `NeverResolves` — `{{resolve:secretsmanager:<name>:SecretString:password}}`.
 *     The `password` key does not exist, so the resolver throws
 *     `Dynamic reference: key 'password' not found in secret` on every deploy.
 *     THE SUBJECT. Under `CDKD_TEST_UPDATE=true` (the repair phase) its Value
 *     switches to the `username` key, which exists — the digest the deploy
 *     recorded no longer matches, so the diff must show the ADD again, and
 *     the next deploy publishes it. `NeverResolvesViaRef` repairs on the same
 *     toggle, so the record is emptied — see its note for why a PARTIAL
 *     repair is not what this fixture asserts.
 *   - `Resolves` — the same secret's `username` key: a SIBLING that resolves
 *     fine, so the record's scope (only the skipped key) is observable.
 *   - `NeverResolvesViaRef` — the same missing key, reached through an
 *     `Fn::Sub` that also names the `RefMarker` SSM parameter. Under
 *     `CDKD_TEST_RESOURCE_EDIT=true` only that parameter's value changes, so
 *     the digest is unmoved while the resource diff reports it — the one
 *     shape that exercises the change-map un-bind (review round 2). Without
 *     it the fixture passes even if `referencedLogicalIds` returns nothing.
 *   - `Plain` — a literal, so the bag is never empty. Under
 *     `CDKD_TEST_SIBLING=true` its value changes, so `verify.sh` can assert
 *     that a genuine sibling change still renders beside the suppressed key.
 *
 * The secret name carries the account: with `CDK_DEFAULT_ACCOUNT` reaching
 * the app (cdkd's synth exports it, see `src/synthesis/app-executor.ts`) the
 * references synthesize as plain strings, otherwise as an `Fn::Join` over
 * `AWS::AccountId`. `verify.sh` RENDERS either shape and fails closed on any
 * other, so both environments assert the same spellings.
 */
export class OutputNeverResolvedDiffStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const account = process.env['CDK_DEFAULT_ACCOUNT'] ?? cdk.Stack.of(this).account;
    const secretName = `cdkd-test-neverres-secret-${account}`;
    const repaired = process.env['CDKD_TEST_UPDATE'] === 'true';

    // A KNOWN value with exactly one key. `generateSecretString` is NOT used:
    // the whole fixture rests on `password` being absent.
    const secret = new secretsmanager.Secret(this, 'NeverResSecret', {
      secretName,
      secretStringValue: cdk.SecretValue.unsafePlainText(
        JSON.stringify({ username: 'cdkd-neverres-user' })
      ),
    });
    secret.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    new cdk.CfnOutput(this, 'NeverResolves', {
      // Repaired under CDKD_TEST_UPDATE: `username` exists, `password` does not.
      value: `{{resolve:secretsmanager:${secretName}:SecretString:${repaired ? 'username' : 'password'}}}`,
      description: 'Fails inside the secret lookup on every deploy until repaired',
    });
    new cdk.CfnOutput(this, 'Resolves', {
      value: `{{resolve:secretsmanager:${secretName}:SecretString:username}}`,
      description: 'Sibling that resolves, so the record scope is observable',
    });
    // --- The un-bind arm (review round 2) -----------------------------
    // An SSM parameter the skipped output REFERENCES. The record itself stores
    // only the output key and a digest — no logical id — so the diff derives
    // the references by walking TODAY's template entry for that key, and this
    // parameter is what that walk has to find. `CDKD_TEST_RESOURCE_EDIT=true`
    // changes ONLY this parameter's value: the digest cannot see it
    // (`Resources` is not digested), so the record still matches — and the
    // diff must decline it anyway, because the deploy that follows re-resolves
    // every output. Without a resource in the picture the fixture is green
    // even if `referencedLogicalIds` returns nothing at all.
    const marker = new ssm.StringParameter(this, 'RefMarker', {
      stringValue:
        process.env['CDKD_TEST_RESOURCE_EDIT'] === 'true'
          ? 'cdkd-neverres-marker-changed'
          : 'cdkd-neverres-marker',
    });
    new cdk.CfnOutput(this, 'NeverResolvesViaRef', {
      // The SAME missing JSON key as `NeverResolves`, so this output is
      // skipped on every deploy too — and its `Fn::Sub` names `RefMarker`,
      // which is what the change map intersects with.
      //
      // It repairs on the SAME toggle, and that is not cosmetic: deploy's
      // no-resource-change path keeps the PREVIOUS outputs bag whenever any
      // output is still unresolved (`resolutionFailed`, go-to-k/cdkd#2771), so
      // leaving this one broken would make the repair phase unable to publish
      // `NeverResolves` at all and the fixture would be asserting that bug
      // instead of this fix.
      value: cdk.Fn.sub(
        '${Marker}-{{resolve:secretsmanager:' +
          secretName +
          `:SecretString:${repaired ? 'username' : 'password'}}}`,
        { Marker: marker.parameterName }
      ),
      description: 'Skipped like NeverResolves, but REFERENCES a resource',
    });

    new cdk.CfnOutput(this, 'Plain', {
      value:
        process.env['CDKD_TEST_SIBLING'] === 'true'
          ? 'cdkd-neverres-plain-value-changed'
          : 'cdkd-neverres-plain-value',
      description: 'A literal, so the outputs bag is never empty',
    });
  }
}
