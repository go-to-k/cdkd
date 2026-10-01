import {
  IAMClient,
  CreateInstanceProfileCommand,
  DeleteInstanceProfileCommand,
  GetInstanceProfileCommand,
  AddRoleToInstanceProfileCommand,
  RemoveRoleFromInstanceProfileCommand,
  NoSuchEntityException,
} from '@aws-sdk/client-iam';
import { getLogger } from '../../utils/logger.js';
import { definedAttributes } from '../attribute-map.js';
import { describeAwsFailure } from '../../utils/aws-failure-text.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { wrapMaskedAwsError } from '../../deployment/retryable-errors.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import { generateResourceNameWithFallback } from '../resource-name.js';
import { resolveExplicitPhysicalId } from '../import-helpers.js';
import {
  createMaskedLogSinks,
  withDerivedNameMasks,
  type MaskerFn,
} from '../masked-retry-logger.js';
import { pasteableAwsCommand } from '../replacement-protection-advice.js';
import { markAuxiliaryFailure } from '../auxiliary-failure.js';
import {
  onlySecretDerived,
  readPrincipalLists,
  recordedPrincipalsRepair,
  SECRET_DERIVED_READ_LIVE,
} from '../iam-policy-targets.js';
import type {
  CreateContext,
  UpdateContext,
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
} from '../../types/resource.js';

/**
 * AWS IAM InstanceProfile Provider
 *
 * Implements resource provisioning for AWS::IAM::InstanceProfile using the IAM SDK.
 * This is required because IAM InstanceProfile is not supported by Cloud Control API.
 */
export class IAMInstanceProfileProvider implements ResourceProvider {
  private iamClient: IAMClient;
  private logger = getLogger().child('IAMInstanceProfileProvider');

  /**
   * A failure wrap quoting the caught error's text through the operation's
   * masker (issue #2177), stamped when the mask changed it so the retry
   * classifiers read the unmasked `cause` chain (`wrapMaskedAwsError`, issue
   * #4244). A method, so `gen-update-wrap-coverage` sees the catch that throws
   * it as a wrap.
   */
  private wrapMaskedError(
    mask: MaskerFn,
    error: unknown,
    build: (maskedText: string) => ProvisioningError
  ): ProvisioningError {
    return wrapMaskedAwsError(mask, error, build);
  }

  handledProperties = new Map<string, ReadonlySet<string>>([
    ['AWS::IAM::InstanceProfile', new Set(['InstanceProfileName', 'Path', 'Roles'])],
  ]);

  constructor() {
    const awsClients = getAwsClients();
    this.iamClient = awsClients.iam;
  }

  /**
   * Create an IAM instance profile
   */
  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    // Issue #2177: ONE masked sink per operation (the `ssm-parameter-provider.ts`
    // shape), and every bag-derived value masked RAW as well. Absent context
    // means identity.
    const instanceProfileName = generateResourceNameWithFallback(
      properties['InstanceProfileName'] as string | undefined,
      logicalId,
      { maxLength: 128 }
    );
    // The physical name is REWRITTEN from the template value (stack prefix,
    // charset folding, truncation), so the masker cannot recognise it by
    // itself: add it as a needle when the value it came from is a secret.
    const log = withDerivedNameMasks(
      this.logger,
      createMaskedLogSinks(this.logger, context?.maskSecrets),
      [[properties['InstanceProfileName'], instanceProfileName]]
    );
    const { value: v } = log;
    log.debug(`Creating IAM instance profile ${logicalId}`);
    const path = (properties['Path'] as string | undefined) || '/';
    // Read before any call (go-to-k/cdkd#3906): a string `Roles` was skipped
    // here but walked by character in `update()`, and a rollback's
    // reverse-replacement create passes a recorded bag.
    const principals = readPrincipalLists({ Roles: properties['Roles'] });
    if ('malformed' in principals) {
      throw new ProvisioningError(
        `Roles of IAM instance profile ${logicalId} is not a list of IAM role names — no ` +
          `instance profile was created`,
        resourceType,
        logicalId
      );
    }
    const roles = principals.lists.Roles;

    try {
      // Create instance profile
      const response = await this.iamClient.send(
        new CreateInstanceProfileCommand({
          InstanceProfileName: instanceProfileName,
          Path: path,
        })
      );

      log.debug(`Created IAM instance profile: ${v(instanceProfileName)}`);

      // CreateInstanceProfileCommand has succeeded — AWS has now
      // committed the InstanceProfile. The subsequent
      // `AddRoleToInstanceProfileCommand` loop wires role attachments
      // onto it; if any fail, the instance profile exists on AWS but
      // cdkd state will NOT (the throw aborts before the success-return).
      // The next redeploy would then re-try CREATE and AWS would reject
      // with `EntityAlreadyExists: Instance Profile <X> already exists`.
      // Wrap the role-attach loop in an inner try/catch that issues
      // `RemoveRoleFromInstanceProfile` per attached role + then
      // `DeleteInstanceProfileCommand` before re-throwing the original
      // error.
      const attachedRoles: string[] = [];
      try {
        // Add roles to instance profile
        if (roles && Array.isArray(roles)) {
          for (const roleName of roles) {
            await this.iamClient.send(
              new AddRoleToInstanceProfileCommand({
                InstanceProfileName: instanceProfileName,
                RoleName: roleName,
              })
            );
            attachedRoles.push(roleName);
            log.debug(`Added role ${v(roleName)} to instance profile ${v(instanceProfileName)}`);
          }
        }
      } catch (innerError) {
        try {
          for (const roleName of attachedRoles) {
            try {
              await this.iamClient.send(
                new RemoveRoleFromInstanceProfileCommand({
                  InstanceProfileName: instanceProfileName,
                  RoleName: roleName,
                })
              );
            } catch (err) {
              if (!(err instanceof NoSuchEntityException)) throw err;
            }
          }
          await this.iamClient.send(
            new DeleteInstanceProfileCommand({ InstanceProfileName: instanceProfileName })
          );
          log.debug(
            `Cleaned up partially-created IAM instance profile ${logicalId} (${v(instanceProfileName)}) after wiring failure`
          );
        } catch (cleanupError) {
          // The name is `generateResourceNameWithFallback`'s output, whose
          // default `allowedPattern` rewrites everything outside `[A-Za-z0-9-]`
          // (issue #3136), so it renders BARE -- but it can still BE a resolved
          // secret, so every command goes through `pasteableAwsCommand` with the
          // masker (issue #2177): a masked name is WITHHELD rather than printed
          // as `***`, which would act on a different profile. Pinned by this
          // type's partial-create cleanup test.
          // The `<name>` hole is QUOTED: bare, it is two shell redirections.
          const aws = pasteableAwsCommand(log.mask);
          log.warn(
            `Failed to clean up partially-created IAM instance profile ${logicalId} (${v(instanceProfileName)}): ${v(describeAwsFailure(cleanupError).detail)}. Manual deletion may be required before the next deploy: remove every role (${aws`aws iam remove-role-from-instance-profile --instance-profile-name ${instanceProfileName} --role-name '<name>'`.render()}) then ${aws`aws iam delete-instance-profile --instance-profile-name ${instanceProfileName}`.render()}`
          );
        }
        // The resource itself was created: an "already exists" from its wiring
        // is an auxiliary object's, not this resource's name collision (#3826).
        throw markAuxiliaryFailure(innerError, logicalId);
      }

      log.debug(
        `Successfully created IAM instance profile ${logicalId}: ${v(instanceProfileName)}`
      );

      return {
        physicalId: instanceProfileName,
        attributes: {
          Arn: response.InstanceProfile?.Arn,
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw this.wrapMaskedError(
        log.mask,
        error,
        (text) =>
          new ProvisioningError(
            `Failed to create IAM instance profile ${logicalId}: ${text}`,
            resourceType,
            logicalId,
            instanceProfileName,
            cause
          )
      );
    }
  }

  /**
   * Update an IAM instance profile
   *
   * Instance profile name and path are immutable. Only role membership can be updated.
   */
  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    context?: UpdateContext
  ): Promise<ResourceUpdateResult> {
    // Issue #2177 -- see `create()`, including the derived-name needle: the
    // recorded name is paired with the value it was derived from. The name is
    // immutable, so the desired value derives the same name.
    const log = withDerivedNameMasks(
      this.logger,
      createMaskedLogSinks(this.logger, context?.maskSecrets),
      [
        [properties['InstanceProfileName'], physicalId],
        [previousProperties['InstanceProfileName'], physicalId],
      ]
    );
    const { value: v } = log;
    log.debug(`Updating IAM instance profile ${logicalId}: ${v(physicalId)}`);

    // BOTH sides before any call (go-to-k/cdkd#3906). A recorded string was
    // walked by character: the real role was removed (`.includes` on a string
    // is a substring test) and a one-letter role ADDED, swapping the
    // credentials every instance using the profile receives. A rollback revert
    // or `drift --revert` replays this with a recorded bag as the desired side.
    const newPrincipals = readPrincipalLists({ Roles: properties['Roles'] });
    let oldPrincipals = readPrincipalLists({ Roles: previousProperties['Roles'] });
    // A recorded list cdkd redacted (a dynamic reference or its mask) cannot be
    // repaired in state, so with a well-formed desired side the old side is
    // read from IAM, where `delete()` reads it too (go-to-k/cdkd#3906).
    if (!('malformed' in newPrincipals) && onlySecretDerived(oldPrincipals)) {
      try {
        const response = await this.iamClient.send(
          new GetInstanceProfileCommand({ InstanceProfileName: physicalId })
        );
        const live = (response.InstanceProfile?.Roles ?? [])
          .map((r) => r.RoleName)
          .filter((n): n is string => !!n);
        oldPrincipals = { lists: { Roles: live } };
      } catch (error) {
        throw new ProvisioningError(
          `the recorded Roles of IAM instance profile ${logicalId} is secret-derived and the ` +
            `profile's roles could not be read from IAM — no role was added or removed`,
          resourceType,
          logicalId,
          physicalId,
          error instanceof Error ? error : undefined
        );
      }
    }
    if ('malformed' in newPrincipals || 'malformed' in oldPrincipals) {
      const which = [
        ...('malformed' in newPrincipals ? ['desired Roles'] : []),
        ...('malformed' in oldPrincipals ? ['recorded Roles'] : []),
      ];
      throw new ProvisioningError(
        `${which.join(' / ')} of IAM instance profile ${logicalId} is not a list of IAM role ` +
          `names — no role was added or removed` +
          ('malformed' in oldPrincipals
            ? `: ${recordedPrincipalsRepair(
                oldPrincipals.malformed,
                oldPrincipals.secretDerived,
                'role names',
                SECRET_DERIVED_READ_LIVE
              )}`
            : ''),
        resourceType,
        logicalId,
        physicalId
      );
    }
    const newRoles = newPrincipals.lists.Roles ?? [];
    const oldRoles = oldPrincipals.lists.Roles ?? [];

    try {
      // Remove old roles that are no longer in the list
      for (const roleName of oldRoles) {
        if (!newRoles.includes(roleName)) {
          try {
            await this.iamClient.send(
              new RemoveRoleFromInstanceProfileCommand({
                InstanceProfileName: physicalId,
                RoleName: roleName,
              })
            );
            log.debug(`Removed role ${v(roleName)} from instance profile ${v(physicalId)}`);
          } catch (error) {
            if (!(error instanceof NoSuchEntityException)) {
              throw error;
            }
            log.debug(`Role ${v(roleName)} already removed from instance profile ${v(physicalId)}`);
          }
        }
      }

      // Add new roles that were not previously attached
      for (const roleName of newRoles) {
        if (!oldRoles.includes(roleName)) {
          await this.iamClient.send(
            new AddRoleToInstanceProfileCommand({
              InstanceProfileName: physicalId,
              RoleName: roleName,
            })
          );
          log.debug(`Added role ${v(roleName)} to instance profile ${v(physicalId)}`);
        }
      }

      log.debug(`Successfully updated IAM instance profile ${logicalId}`);

      // Get updated instance profile info for attributes
      const getResponse = await this.iamClient.send(
        new GetInstanceProfileCommand({ InstanceProfileName: physicalId })
      );

      return {
        physicalId,
        wasReplaced: false,
        attributes: {
          Arn: getResponse.InstanceProfile?.Arn,
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw this.wrapMaskedError(
        log.mask,
        error,
        (text) =>
          new ProvisioningError(
            `Failed to update IAM instance profile ${logicalId}: ${text}`,
            resourceType,
            logicalId,
            physicalId,
            cause
          )
      );
    }
  }

  /**
   * Delete an IAM instance profile
   *
   * Before deleting, removes all roles from the instance profile.
   */
  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting IAM instance profile ${logicalId}: ${physicalId}`);

    try {
      // Get current instance profile to find attached roles
      let roles: string[] = [];
      try {
        const response = await this.iamClient.send(
          new GetInstanceProfileCommand({ InstanceProfileName: physicalId })
        );
        roles =
          response.InstanceProfile?.Roles?.map((r) => r.RoleName).filter(
            (name): name is string => !!name
          ) || [];
      } catch (error) {
        if (error instanceof NoSuchEntityException) {
          const clientRegion = await this.iamClient.config.region();
          assertRegionMatch(
            clientRegion,
            context?.expectedRegion,
            resourceType,
            logicalId,
            physicalId
          );
          this.logger.debug(`Instance profile ${physicalId} does not exist, skipping deletion`);
          return;
        }
        throw error;
      }

      // Remove all roles from instance profile
      for (const roleName of roles) {
        try {
          await this.iamClient.send(
            new RemoveRoleFromInstanceProfileCommand({
              InstanceProfileName: physicalId,
              RoleName: roleName,
            })
          );
          this.logger.debug(`Removed role ${roleName} from instance profile ${physicalId}`);
        } catch (error) {
          if (!(error instanceof NoSuchEntityException)) {
            throw error;
          }
        }
      }

      // Delete instance profile
      await this.iamClient.send(
        new DeleteInstanceProfileCommand({ InstanceProfileName: physicalId })
      );

      this.logger.debug(`Successfully deleted IAM instance profile ${logicalId}`);
    } catch (error) {
      if (error instanceof NoSuchEntityException) {
        const clientRegion = await this.iamClient.config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`Instance profile ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete IAM instance profile ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Read the AWS-current IAM instance profile configuration in CFn-property
   * shape.
   *
   * Issues a single `GetInstanceProfile` and surfaces the keys `create()`
   * accepts (`InstanceProfileName`, `Path`, `Roles`). The Roles list maps
   * the inline `Role[]` (each carrying `{RoleName, Arn, ...}`) back to the
   * `string[]` of role names that CFn / cdkd state holds.
   *
   * Returns `undefined` when the profile is gone (`NoSuchEntityException`).
   */
  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    _resourceType: string
  ): Promise<Record<string, unknown> | undefined> {
    let profile;
    try {
      const resp = await this.iamClient.send(
        new GetInstanceProfileCommand({ InstanceProfileName: physicalId })
      );
      profile = resp.InstanceProfile;
    } catch (err) {
      if (err instanceof NoSuchEntityException) return undefined;
      throw err;
    }
    if (!profile) return undefined;

    const result: Record<string, unknown> = {};
    if (profile.InstanceProfileName !== undefined) {
      result['InstanceProfileName'] = profile.InstanceProfileName;
    }
    if (profile.Path !== undefined) result['Path'] = profile.Path;

    const roleNames = (profile.Roles ?? []).map((r) => r.RoleName).filter((n): n is string => !!n);
    result['Roles'] = roleNames;

    return result;
  }

  /**
   * Adopt an existing IAM instance profile into cdkd state.
   *
   * Lookup order:
   *  1. `--resource` override or `Properties.InstanceProfileName` → verify
   *     via `GetInstanceProfile`.
   */
  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    const explicit = resolveExplicitPhysicalId(input, 'InstanceProfileName');
    if (explicit) {
      try {
        const resp = await this.iamClient.send(
          new GetInstanceProfileCommand({ InstanceProfileName: explicit })
        );
        // Issue #3627: the `Arn` `create()` records. The resolver's arm builds
        // `instance-profile/<name>` and drops a non-`/` `Path`, silently.
        return {
          physicalId: explicit,
          attributes: definedAttributes({ Arn: resp.InstanceProfile?.Arn }),
        };
      } catch (err) {
        if (err instanceof NoSuchEntityException) return null;
        throw err;
      }
    }

    // No `aws:cdk:path` tag walk: AWS rejects `aws:`-prefixed tag writes, so that
    // tag never exists on a real resource and the walk could not match (issue
    // #1134). Auto-mode import resolves ids from CloudFormation's
    // DescribeStackResources or the template's physical-name property; an
    // instance profile reaching here needs an explicit `--resource` override.
    return null;
  }
}
