import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';

/**
 * Integ probe for issues #5302 and #5323: a Secrets Manager secret that
 * replicates to a second region.
 *
 * covers: AWS::SecretsManager::Secret
 *
 * - #5302: changing `ReplicaRegions[].KmsKeyId` for a region the secret
 *   already replicates to must re-key that replica IN PLACE, as CloudFormation
 *   does (a real A/B: CloudFormation calls ReplicateSecretToRegions for the
 *   kept region with the new key, or with no key when it is removed).
 * - #5323: destroying the secret must remove its replica region first —
 *   Secrets Manager refuses DeleteSecret on a primary that still has replicas.
 *
 * The replica region and its customer managed key come from verify.sh: a
 * stack cannot create a KMS key in another region, so verify.sh creates the
 * key by direct call and schedules it for deletion on teardown.
 *
 * Env (verify.sh sets it PER PHASE):
 *   - CDKD_REPLICA_REGION: the replica region (always set).
 *   - CDKD_TEST_REPLICA_KEY: when set, the replica's `KmsKeyId`; unset, the
 *     replica uses the AWS managed key (`KmsKeyId` absent).
 */
export class SecretsmanagerReplicaRekeyStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const replicaRegion = process.env.CDKD_REPLICA_REGION ?? 'us-west-2';
    const replicaKey = process.env.CDKD_TEST_REPLICA_KEY;

    // The L1, so `ReplicaRegions[].KmsKeyId` is exactly what the template
    // declares. The value is generated, so no literal lands in the template.
    // Without a removalPolicy the L1 deletes on destroy.
    new secretsmanager.CfnSecret(this, 'Replicated', {
      name: `${id}-replicated`,
      description: 'cdkd issues #5302 / #5323 probe: replicated secret',
      generateSecretString: { passwordLength: 32, excludePunctuation: true },
      replicaRegions: [
        {
          region: replicaRegion,
          ...(replicaKey ? { kmsKeyId: replicaKey } : {}),
        },
      ],
    });
  }
}
