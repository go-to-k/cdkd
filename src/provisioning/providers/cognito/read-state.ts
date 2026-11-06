import { narrowMfaConfiguration } from './mfa-preflight.js';
import {
  type ResourceNotFound,
  RESOURCE_NOT_FOUND,
  type ResourceImportInput,
  type ResourceImportResult,
} from '../../../types/resource.js';
import {
  DescribeUserPoolCommand,
  ResourceNotFoundException,
  GetUserPoolMfaConfigCommand,
  ListUserPoolsCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { MFA_FACTOR_SMS, MFA_FACTOR_SOFTWARE_TOKEN, MFA_FACTOR_EMAIL_OTP } from './mfa-request.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { derivePartitionAndUrlSuffix } from '../../../utils/aws-partition.js';
import { definedAttributes } from '../../attribute-map.js';
import type { CognitoUserPoolProvider } from '../cognito-provider.js';

/**
 * The DIFF-side half of the `MfaConfiguration` substitution record.
 *
 * Applied by `DiffCalculator` to BOTH comparison sides, so a template that
 * declares a malformed / blank `MfaConfiguration` compares equal to the state
 * record holding the value cdkd actually sent for it. Without this half, the
 * `effectiveProperties` above would make every later deploy read the
 * substitution back as a user-made change and re-run the update forever.
 *
 * Shares ONE helper with the provisioning path rather than re-deriving the
 * rule, per `.claude/rules/providers.md` -- state and template narrowed by
 * different code is how this fix would become the bug.
 */
export function canonicalizeDesiredProperties(
  this: CognitoUserPoolProvider,
  resourceType: string,
  properties: Record<string, unknown>
): Record<string, unknown> {
  if (resourceType !== 'AWS::Cognito::UserPool') return properties;
  return narrowMfaConfiguration(properties);
}

/**
 * Read the AWS-current Cognito User Pool configuration in CFn-property shape.
 *
 * Issues `DescribeUserPool` and surfaces the keys cdkd's `create()` accepts.
 * AWS-managed fields (Arn, Id, CreationDate, LastModifiedDate, EstimatedNumberOfUsers,
 * etc.) are filtered at the wire layer.
 *
 * **Note**: Cognito only supports `AWS::Cognito::UserPool` in this provider;
 * `UserPoolClient`, `UserPoolGroup`, and other Cognito sub-resources go
 * through the CC API fallback (which has its own `readCurrentState`).
 *
 * `UserPoolTags` is surfaced from the same `DescribeUserPool` response —
 * Cognito's CFn property is a tag-name → value map (NOT an array of
 * `{Key, Value}`), so we keep the map shape and just filter out CDK's
 * `aws:*` auto-tags. The result key is omitted when no user tags remain.
 *
 * Returns `RESOURCE_NOT_FOUND` when the pool is gone (`ResourceNotFoundException`).
 */
export async function readCurrentState(
  this: CognitoUserPoolProvider,
  physicalId: string,
  _logicalId: string,
  resourceType: string
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  if (resourceType !== 'AWS::Cognito::UserPool') return undefined;

  let resp;
  try {
    resp = await this.getClient().send(new DescribeUserPoolCommand({ UserPoolId: physicalId }));
  } catch (err) {
    if (err instanceof ResourceNotFoundException) return RESOURCE_NOT_FOUND;
    throw err;
  }
  const pool = resp.UserPool;
  if (!pool) return undefined;

  // Cognito UserPool is mutated via UpdateUserPool, which accepts most
  // fields below; Schema only grows (AddCustomAttributes), and
  // UsernameAttributes / AliasAttributes / UsernameConfiguration have no
  // UpdateUserPool member (see `createTimeOnlyChanges`). Always emit user-controllable top-level keys with
  // placeholders so a console-side ADD on a property the pool wasn't
  // templated with at deploy time surfaces as drift.
  const result: Record<string, unknown> = {};
  if (pool.Name !== undefined) result['UserPoolName'] = pool.Name;
  result['AutoVerifiedAttributes'] = pool.AutoVerifiedAttributes
    ? [...pool.AutoVerifiedAttributes]
    : [];
  result['UsernameAttributes'] = pool.UsernameAttributes ? [...pool.UsernameAttributes] : [];
  result['AliasAttributes'] = pool.AliasAttributes ? [...pool.AliasAttributes] : [];
  result['Policies'] = pool.Policies ?? {};
  if (pool.SchemaAttributes && pool.SchemaAttributes.length > 0) {
    // Schema is immutable on create — only emit when present so a pool
    // without a custom schema doesn't surface an empty Schema array as
    // a phantom diff.
    result['Schema'] = pool.SchemaAttributes;
  }
  result['LambdaConfig'] = pool.LambdaConfig ?? {};
  result['MfaConfiguration'] = pool.MfaConfiguration ?? 'OFF';
  result['AdminCreateUserConfig'] = pool.AdminCreateUserConfig ?? {};
  result['AccountRecoverySetting'] = pool.AccountRecoverySetting ?? {};
  result['UserAttributeUpdateSettings'] = pool.UserAttributeUpdateSettings ?? {};
  result['DeletionProtection'] = pool.DeletionProtection ?? 'INACTIVE';
  result['EmailConfiguration'] = pool.EmailConfiguration ?? {};
  result['SmsConfiguration'] = pool.SmsConfiguration ?? {};
  result['VerificationMessageTemplate'] = pool.VerificationMessageTemplate ?? {};
  result['UsernameConfiguration'] = pool.UsernameConfiguration ?? {};
  result['DeviceConfiguration'] = pool.DeviceConfiguration ?? {};
  result['UserPoolAddOns'] = pool.UserPoolAddOns ?? {};
  result['EmailVerificationMessage'] = pool.EmailVerificationMessage ?? '';
  result['EmailVerificationSubject'] = pool.EmailVerificationSubject ?? '';
  result['SmsAuthenticationMessage'] = pool.SmsAuthenticationMessage ?? '';
  result['SmsVerificationMessage'] = pool.SmsVerificationMessage ?? '';
  // UserPoolTags is a map in CFn (NOT an array of {Key, Value}). Filter
  // aws:* auto-tags but keep the map shape to match what cdkd state holds.
  // Always emit (even when empty) so a console-side tag ADD on an
  // initially-untagged pool surfaces as drift.
  const userTags: Record<string, string> = {};
  if (pool.UserPoolTags) {
    for (const [k, v] of Object.entries(pool.UserPoolTags)) {
      if (!k.startsWith('aws:')) userTags[k] = v;
    }
  }
  result['UserPoolTags'] = userTags;
  // UserPoolTier rides on DescribeUserPool; defaults to ESSENTIALS per AWS.
  result['UserPoolTier'] = pool.UserPoolTier ?? 'ESSENTIALS';
  // Reported on every pool (measured 2026-11-01, issue #2762: `AWS_OWNED_KEY`
  // and `ORIGINAL` when nothing was declared). Unlike its siblings no `{}`
  // placeholder: `UpdateUserPool` refuses an empty block of either, so
  // `drift --revert` could not send one back.
  if (pool.KeyConfiguration) result['KeyConfiguration'] = pool.KeyConfiguration;
  if (pool.IssuerConfiguration) result['IssuerConfiguration'] = pool.IssuerConfiguration;

  // EnabledMfas / email-OTP message+subject / WebAuthn config live on the
  // separate GetUserPoolMfaConfig API, not DescribeUserPool. Fetch them and
  // reconstruct the CFn-shape properties. A pool with no MFA factors and no
  // WebAuthn config returns empty/absent sub-blocks; emit the keys so a
  // console-side ADD surfaces as drift, mirroring the always-emit policy
  // above. Tolerate a failure on this secondary call (e.g. a permission gap
  // on the MFA API) by skipping the MFA-derived keys rather than failing the
  // whole drift read.
  try {
    const mfa = await this.getClient().send(
      new GetUserPoolMfaConfigCommand({ UserPoolId: physicalId })
    );
    // Reconstructed in a fixed canonical order (SMS -> SOFTWARE_TOKEN ->
    // EMAIL_OTP). A template that lists EnabledMfas in a different order can
    // surface a spurious array-order drift; the canonical order is documented
    // so authors can match it. (A future order-insensitive array compare in
    // drift-calculator would remove the caveat entirely.)
    const enabledMfas: string[] = [];
    if (mfa.SmsMfaConfiguration) enabledMfas.push(MFA_FACTOR_SMS);
    if (mfa.SoftwareTokenMfaConfiguration?.Enabled) enabledMfas.push(MFA_FACTOR_SOFTWARE_TOKEN);
    // The block IS the factor -- the model at `MFA_FACTOR_EMAIL_OTP` (issue
    // #1924): there is no enable flag to consult, so a block carrying only a
    // message still reports EMAIL_OTP, which is what AWS enabled.
    if (mfa.EmailMfaConfiguration) enabledMfas.push(MFA_FACTOR_EMAIL_OTP);
    result['EnabledMfas'] = enabledMfas;
    result['EmailAuthenticationMessage'] = mfa.EmailMfaConfiguration?.Message ?? '';
    result['EmailAuthenticationSubject'] = mfa.EmailMfaConfiguration?.Subject ?? '';
    result['WebAuthnRelyingPartyID'] = mfa.WebAuthnConfiguration?.RelyingPartyId ?? '';
    result['WebAuthnUserVerification'] = mfa.WebAuthnConfiguration?.UserVerification ?? '';
    // Issue #2064. MEASURED 2026-09-23: absent on a fresh pool (no
    // WebAuthnConfiguration at all), hence the same '' placeholder as its
    // two siblings -- but a pool with ANY WebAuthn block reads back an
    // explicit value, `SINGLE_FACTOR` when only a relying party was set.
    // Drift compares against the observed read-back, so that explicit
    // default is on both sides of the comparison.
    result['WebAuthnFactorConfiguration'] = mfa.WebAuthnConfiguration?.FactorConfiguration ?? '';
  } catch (mfaErr) {
    this.logger.debug(
      `GetUserPoolMfaConfig failed for ${physicalId}, skipping MFA-derived drift keys: ${describeAwsFailure(mfaErr).detail}`
    );
  }
  return result;
}

/**
 * The attribute map a user pool records, derived as `create()` / `update()`
 * derive it (issue #3627): the resolver served the pool id for
 * `ProviderName` / `ProviderURL` after an import.
 */
export async function userPoolAttributes(
  this: CognitoUserPoolProvider,
  userPoolId: string,
  arn: string | undefined
): Promise<Record<string, unknown>> {
  const region = await this.getClient().config.region();
  const { urlSuffix } = derivePartitionAndUrlSuffix(region);
  return definedAttributes({
    Arn: arn,
    ProviderName: `cognito-idp.${region}.${urlSuffix}/${userPoolId}`,
    ProviderURL: `https://cognito-idp.${region}.${urlSuffix}/${userPoolId}`,
    UserPoolId: userPoolId,
  });
}

/**
 * Adopt an existing Cognito User Pool into cdkd state.
 *
 * User Pool physical id is the AWS-generated `<region>_<random>` id.
 * Lookup chain:
 *  1. `--resource` override → `DescribeUserPool` to verify.
 *  2. `Properties.UserPoolName` (when CDK template carries it) →
 *     `ListUserPools` walk + name match.
 *
 * The `aws:cdk:path` tag match that used to ride the same `ListUserPools`
 * walk is gone (issue #1134): AWS rejects `aws:`-prefixed tag writes, so
 * that tag never exists on a real resource and the walk could not match.
 * Auto-mode import resolves ids from CloudFormation's
 * `DescribeStackResources` or the template's physical name; without a
 * `UserPoolName` there is nothing to match.
 */
export async function importImpl(
  this: CognitoUserPoolProvider,
  input: ResourceImportInput
): Promise<ResourceImportResult | null> {
  if (input.knownPhysicalId) {
    try {
      const resp = await this.getClient().send(
        new DescribeUserPoolCommand({ UserPoolId: input.knownPhysicalId })
      );
      return {
        physicalId: input.knownPhysicalId,
        attributes: await this.userPoolAttributes(input.knownPhysicalId, resp.UserPool?.Arn),
      };
    } catch (err) {
      if (err instanceof ResourceNotFoundException) return null;
      throw err;
    }
  }

  const desiredName =
    typeof input.properties?.['UserPoolName'] === 'string'
      ? input.properties['UserPoolName']
      : undefined;
  if (!desiredName) return null;

  // Match the template's UserPoolName against each pool's Name.
  let marker: string | undefined;
  do {
    const list = await this.getClient().send(
      new ListUserPoolsCommand({ MaxResults: 60, ...(marker && { NextToken: marker }) })
    );
    for (const pool of list.UserPools ?? []) {
      if (pool.Id && pool.Name === desiredName) {
        let resp;
        try {
          resp = await this.getClient().send(new DescribeUserPoolCommand({ UserPoolId: pool.Id }));
        } catch (err) {
          // Deleted between the list and the describe: not found, like the
          // override branch above.
          if (err instanceof ResourceNotFoundException) return null;
          throw err;
        }
        return {
          physicalId: pool.Id,
          attributes: await this.userPoolAttributes(pool.Id, resp.UserPool?.Arn),
        };
      }
    }
    marker = list.NextToken;
  } while (marker);
  return null;
}
