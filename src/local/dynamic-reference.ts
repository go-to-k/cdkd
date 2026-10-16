import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { SSMClient } from '@aws-sdk/client-ssm';
import { DynamicReferenceResolver } from 'cdk-local/internal';
import { awsClientDefaults } from '../utils/aws-client-defaults.js';
import { canonicalizeRegion } from '../utils/aws-partition.js';

/**
 * The `{{resolve:...}}` resolver the four cdkd-owned `local` commands build
 * (issue #2056): cdk-local's `DynamicReferenceResolver`, with its Secrets
 * Manager and SSM clients built by cdkd so they resolve the CALLER's identity.
 *
 * cdk-local's own clients take `profile` alone, so under `--role-arn` with no
 * profile they read the role triple `applyRoleArnIfSet` published. The value a
 * lookup returns lands in the container, so the clients pass `ignoreAssumedRole`
 * (`.claude/rules/local-caller-identity.md`). `awsClientDefaults` also carries
 * cdkd's proxy and retry configuration. The region is folded: a state record
 * can spell it upper-cased (#1836), and the SDK endpoint is case-sensitive.
 * The engine `start-*` commands get cdk-local's resolver instead, which
 * resolves as the caller under `workloadIdentity: 'caller'`
 * (`.claude/rules/local-engine-role-leak.md`).
 */
export function createCallerDynamicReferenceResolver(
  profile: string | undefined
): DynamicReferenceResolver {
  // No `profile` for the resolver itself: it reads one only to build its own
  // default clients, which both factories below replace.
  return new DynamicReferenceResolver({
    secretsManagerClientFactory: (region) =>
      new SecretsManagerClient({
        ...awsClientDefaults({ profile, ignoreAssumedRole: true }),
        ...(region && { region: canonicalizeRegion(region) }),
        ...(profile && { profile }),
      }),
    ssmClientFactory: (region) =>
      new SSMClient({
        ...awsClientDefaults({ profile, ignoreAssumedRole: true }),
        ...(region && { region: canonicalizeRegion(region) }),
        ...(profile && { profile }),
      }),
  });
}
