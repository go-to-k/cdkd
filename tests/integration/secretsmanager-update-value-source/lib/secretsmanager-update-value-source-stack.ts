import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';

/**
 * Integ probe for issue #2472: an in-place UPDATE of an
 * AWS::SecretsManager::Secret must NOT touch the secret value unless the
 * value's SOURCE changed.
 *
 * covers: AWS::SecretsManager::Secret
 *
 * Two secrets, one per value source:
 *   - `Generated`: `GenerateSecretString` (the CDK default shape). Pre-fix,
 *     every `update()` re-ran the local generator and staged a fresh password
 *     as AWSCURRENT — a Tags-only deploy silently replaced a live credential.
 *   - `Literal`: a fixed `SecretString`. Pre-fix, the unchanged literal was
 *     re-sent on every update, stacking a redundant version per deploy.
 *
 * Phases (verify.sh sets the env PER PHASE):
 *   - no env:                    baseline deploy.
 *   - CDKD_TEST_UPDATE=true:     a tag is added to BOTH secrets and nothing
 *                                else changes — the value must stay put
 *                                (AWSCURRENT VersionId unchanged, still one
 *                                version).
 *   - CDKD_TEST_UPDATE=regen:    the positive control — the
 *                                `GenerateSecretString` block changes
 *                                (PasswordLength 32 -> 40) and the literal
 *                                changes, so BOTH values must move (new
 *                                AWSCURRENT, the old one now AWSPREVIOUS).
 *                                Without this arm the `true` assertion could
 *                                pass on a provider that never sends a value.
 *
 * The literal is a fixed, non-secret marker string; it exists to exercise the
 * literal branch, and verify.sh sweeps the state bucket's object versions on
 * teardown because it lands in state.json verbatim.
 */
export class SecretsmanagerUpdateValueSourceStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const mode = process.env.CDKD_TEST_UPDATE;
    const isUpdate = mode === 'true' || mode === 'regen';
    const isRegen = mode === 'regen';

    const generated = new secretsmanager.Secret(this, 'Generated', {
      secretName: `${id}-generated`,
      description: 'cdkd issue #2472 probe: GenerateSecretString source',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: 'admin' }),
        generateStringKey: 'password',
        excludePunctuation: true,
        passwordLength: isRegen ? 40 : 32,
      },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const literal = new secretsmanager.Secret(this, 'Literal', {
      secretName: `${id}-literal`,
      description: 'cdkd issue #2472 probe: literal SecretString source',
      secretStringValue: cdk.SecretValue.unsafePlainText(
        isRegen ? 'cdkd-2472-literal-marker-v2' : 'cdkd-2472-literal-marker-v1'
      ),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    if (isUpdate) {
      // The ONLY change in the `true` phase: a tag on each secret. Tags ride
      // TagResource, a separate API call from UpdateSecret, so a value sent
      // alongside them is provably unrelated to what the template changed.
      cdk.Tags.of(generated).add('cdkd-update-probe', 'true');
      cdk.Tags.of(literal).add('cdkd-update-probe', 'true');
    }
  }
}
