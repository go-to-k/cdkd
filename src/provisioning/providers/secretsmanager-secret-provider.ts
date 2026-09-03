import { isDeepStrictEqual } from 'node:util';
import { getCurrentResourceSecrets } from '../../deployment/resource-secrets-scope.js';
import { redactSecretsForState } from '../../deployment/secret-redaction.js';
import {
  SecretsManagerClient,
  CreateSecretCommand,
  DeleteSecretCommand,
  DescribeSecretCommand,
  UpdateSecretCommand,
  TagResourceCommand,
  UntagResourceCommand,
  ReplicateSecretToRegionsCommand,
  RemoveRegionsFromReplicationCommand,
  ResourceNotFoundException,
  type Tag,
} from '@aws-sdk/client-secrets-manager';
import { getLogger } from '../../utils/logger.js';
import { readConfigString } from '../config-shape.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import { generateResourceName } from '../resource-name.js';
import { normalizeAwsTagsToCfn } from '../import-helpers.js';
import { clearOnUpdateRemoval } from '../update-removal.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
} from '../../types/resource.js';

/**
 * `value` after a JSON round-trip: `undefined` members dropped, exactly the
 * shape state.json can hold. Used so the two sides of the issue-#2472
 * comparison in {@link SecretsManagerSecretProvider.changedSecretValue} are
 * spelled the same way, and so a null-prototype object (what
 * `redactSecretsForState` builds) compares equal to a plain one —
 * `isDeepStrictEqual` checks prototypes. `undefined` round-trips to `undefined`.
 */
function asJson(value: unknown): unknown {
  return value === undefined ? undefined : (JSON.parse(JSON.stringify(value)) as unknown);
}

/**
 * AWS Secrets Manager Secret Provider
 *
 * Implements resource provisioning for AWS::SecretsManager::Secret using the Secrets Manager SDK.
 * WHY: CreateSecret is synchronous - the CC API adds unnecessary polling overhead
 * (1s->2s->4s->8s) for an operation that completes immediately.
 */
export class SecretsManagerSecretProvider implements ResourceProvider {
  private smClient: SecretsManagerClient;
  private logger = getLogger().child('SecretsManagerSecretProvider');

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::SecretsManager::Secret',
      new Set([
        'Name',
        'GenerateSecretString',
        'SecretString',
        'Description',
        'KmsKeyId',
        'Tags',
        'ReplicaRegions',
        'Type',
      ]),
    ],
  ]);

  constructor() {
    const awsClients = getAwsClients();
    this.smClient = awsClients.secretsManager;
  }

  /**
   * Create a Secrets Manager secret
   */
  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating secret ${logicalId}`);

    const name =
      (properties['Name'] as string | undefined) ||
      generateResourceName(logicalId, { maxLength: 512, allowedPattern: /[^a-zA-Z0-9-/_]/g });

    try {
      // Build the secret value from GenerateSecretString or SecretString
      let secretString: string | undefined;
      const generateConfig = properties['GenerateSecretString'] as
        | Record<string, unknown>
        | undefined;

      if (generateConfig) {
        secretString = this.generateSecretString(generateConfig);
      } else if (properties['SecretString']) {
        // Truthy gate: a `SecretString: ''` creates a secret with NO version.
        // `update()` deliberately treats `''` as a value (issue #2472, see
        // `changedSecretValue`); the two gates differ on purpose, so a later
        // change TO `''` on a secret created empty is a no-op there.
        secretString = properties['SecretString'] as string;
      }

      const createParams: import('@aws-sdk/client-secrets-manager').CreateSecretCommandInput = {
        Name: name,
      };
      if (secretString) createParams.SecretString = secretString;
      if (properties['Description']) createParams.Description = properties['Description'] as string;
      if (properties['KmsKeyId']) createParams.KmsKeyId = properties['KmsKeyId'] as string;
      if (properties['Tags']) {
        createParams.Tags = properties['Tags'] as Tag[];
      }
      if (properties['ReplicaRegions']) {
        const replicaRegions = properties['ReplicaRegions'] as Array<Record<string, unknown>>;
        createParams.AddReplicaRegions = replicaRegions.map((r) => ({
          Region: r['Region'] as string,
          KmsKeyId: r['KmsKeyId'] as string | undefined,
        }));
      }
      if (properties['Type']) createParams.Type = properties['Type'] as string;

      const response = await this.smClient.send(new CreateSecretCommand(createParams));

      const secretArn = response.ARN;
      if (!secretArn) {
        throw new Error('CreateSecret did not return ARN');
      }

      this.logger.debug(`Successfully created secret ${logicalId}: ${secretArn}`);

      return {
        physicalId: secretArn,
        attributes: {
          Id: secretArn,
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create secret ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        name,
        cause
      );
    }
  }

  /**
   * Update a Secrets Manager secret
   */
  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating secret ${logicalId}: ${physicalId}`);

    try {
      // The secret VALUE is sent only when its SOURCE changed (issue #2472).
      // `UpdateSecret` with a `SecretString` creates a new version and moves
      // `AWSCURRENT` to it, so re-sending the value on every in-place update
      // — a Tags-only or Description-only deploy, or a rollback replay — used
      // to mint a fresh random password for a `GenerateSecretString` secret
      // (a database seeded from the old value then rejects every consumer
      // that reads the new one), and to stack a redundant version for an
      // unchanged literal (advancing `AWSPREVIOUS` off the real previous
      // value). CloudFormation regenerates only when the `GenerateSecretString`
      // block itself changes and re-sends a literal only when it changes; the
      // comparison against `previousProperties` below is that semantics.
      // `UpdateSecret` has merge semantics, so omitting `SecretString` leaves
      // the current version untouched.
      const secretString = this.changedSecretValue(properties, previousProperties);

      const updateParams: import('@aws-sdk/client-secrets-manager').UpdateSecretCommandInput = {
        SecretId: physicalId,
      };
      if (secretString !== undefined) updateParams.SecretString = secretString;
      // `Description`: pass-through is `!== undefined` (not truthy) —
      // readCurrentState emits `Description: ''` as a placeholder for "no
      // description set" so the drift comparator can detect a console-side
      // description add. A truthy gate here would silently drop a
      // user-intended `Description: ''` (clear-the-description) on
      // `cdkd drift --revert`. AWS UpdateSecret accepts empty string for
      // Description (treated as "no description").
      // #1160 reset-on-removal — UpdateSecret has merge semantics (an absent
      // input field means "no change"), so a Description REMOVED from the
      // template must be sent as the explicit clear sentinel `''` via
      // `clearOnUpdateRemoval` (CFn resets a removed Description to "no
      // description"; live-verified 2026-07-27: after `Description: ''`
      // DescribeSecret omits Description again, so the reset is drift-clean).
      const description = clearOnUpdateRemoval(
        properties['Description'] as string | undefined,
        previousProperties['Description'] as string | undefined,
        ''
      );
      if (description !== undefined) updateParams.Description = description;
      // `KmsKeyId`: readCurrentState emits `KmsKeyId: ''` as a placeholder
      // when the secret uses the AWS-managed key (no customer KMS key set), so
      // `''` on EITHER side is normalized to "absent" before the #1160
      // removal-reset resolution — a placeholder must never pass through as a
      // customer-key value, and a placeholder-only previous side must not fire
      // a pointless reset (keeps `cdkd drift --revert` round-trips a wire
      // no-op, symmetric with the serializeRedrivePolicy pattern in
      // sqs-queue-provider.ts).
      // The reset sentinel for a REAL removal (previous had a customer key,
      // template no longer does) IS the empty string: the UpdateSecret API
      // documents `KmsKeyId: ''` as "use the Amazon Web Services managed key
      // aws/secretsmanager", exactly CloudFormation's behavior when KmsKeyId
      // is removed from the template. Live-probed 2026-07-27 (us-east-1):
      // UpdateSecret with `KmsKeyId: ''` is accepted (an earlier comment here
      // claimed AWS rejects it as an invalid ARN — no longer true), and a
      // subsequent DescribeSecret OMITS KmsKeyId again, which readCurrentState
      // maps back to the `''` placeholder — so the reset is drift-clean.
      // (`alias/aws/secretsmanager` is also accepted but leaves an EXPLICIT
      // KmsKeyId in DescribeSecret, which would diverge from the
      // never-had-a-key shape; `''` is the strictly better sentinel.)
      const newKmsKeyId = properties['KmsKeyId'] as string | undefined;
      const prevKmsKeyId = previousProperties['KmsKeyId'] as string | undefined;
      const kmsKeyId = clearOnUpdateRemoval(
        newKmsKeyId === '' ? undefined : newKmsKeyId,
        prevKmsKeyId === '' ? undefined : prevKmsKeyId,
        ''
      );
      if (kmsKeyId !== undefined) updateParams.KmsKeyId = kmsKeyId;
      // `Type`: emit-when-present (no placeholder in readCurrentState).
      // Truthy gate matches create() — Type is the partner identifier for
      // Secrets Manager managed external secrets and is rarely user-set;
      // passing an empty string would be a no-op on AWS side.
      // DELIBERATELY NOT routed through clearOnUpdateRemoval (issue #1160
      // secretsmanager batch): a template-removed Type still keeps its live
      // value — the umbrella's UNCERTAIN bucket tracks it (partner-managed
      // secrets; no documented clear sentinel, and probing one requires a
      // partner-linked secret we cannot fabricate).
      if (properties['Type']) updateParams.Type = properties['Type'] as string;

      await this.smClient.send(new UpdateSecretCommand(updateParams));

      // Update Tags if changed
      const newTags = properties['Tags'] as Tag[] | undefined;
      const oldTags = previousProperties['Tags'] as Tag[] | undefined;
      if (JSON.stringify(newTags) !== JSON.stringify(oldTags)) {
        // Remove old tags
        if (oldTags && oldTags.length > 0) {
          const oldTagKeys = oldTags.map((t) => t.Key).filter((k): k is string => !!k);
          if (oldTagKeys.length > 0) {
            await this.smClient.send(
              new UntagResourceCommand({
                SecretId: physicalId,
                TagKeys: oldTagKeys,
              })
            );
          }
        }
        // Apply new tags
        if (newTags && newTags.length > 0) {
          await this.smClient.send(
            new TagResourceCommand({
              SecretId: physicalId,
              Tags: newTags,
            })
          );
        }
        this.logger.debug(`Updated tags for secret ${physicalId}`);
      }

      // Update ReplicaRegions if changed
      const newReplicas = properties['ReplicaRegions'] as
        | Array<Record<string, unknown>>
        | undefined;
      const oldReplicas = previousProperties['ReplicaRegions'] as
        | Array<Record<string, unknown>>
        | undefined;
      if (JSON.stringify(newReplicas) !== JSON.stringify(oldReplicas)) {
        // Remove old replica regions that are no longer present
        if (oldReplicas && oldReplicas.length > 0) {
          const newRegionSet = new Set((newReplicas || []).map((r) => r['Region'] as string));
          const regionsToRemove = oldReplicas
            .map((r) => r['Region'] as string)
            .filter((region) => !newRegionSet.has(region));
          if (regionsToRemove.length > 0) {
            await this.smClient.send(
              new RemoveRegionsFromReplicationCommand({
                SecretId: physicalId,
                RemoveReplicaRegions: regionsToRemove,
              })
            );
          }
        }
        // Add new replica regions
        if (newReplicas && newReplicas.length > 0) {
          const oldRegionSet = new Set((oldReplicas || []).map((r) => r['Region'] as string));
          const regionsToAdd = newReplicas.filter((r) => !oldRegionSet.has(r['Region'] as string));
          if (regionsToAdd.length > 0) {
            await this.smClient.send(
              new ReplicateSecretToRegionsCommand({
                SecretId: physicalId,
                AddReplicaRegions: regionsToAdd.map((r) => ({
                  Region: r['Region'] as string,
                  KmsKeyId: r['KmsKeyId'] as string | undefined,
                })),
              })
            );
          }
        }
        this.logger.debug(`Updated replica regions for secret ${physicalId}`);
      }

      this.logger.debug(`Successfully updated secret ${logicalId}`);

      return {
        physicalId,
        wasReplaced: false,
        attributes: {
          Id: physicalId,
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update secret ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Delete a Secrets Manager secret
   */
  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting secret ${logicalId}: ${physicalId}`);

    try {
      await this.smClient.send(
        new DeleteSecretCommand({
          SecretId: physicalId,
          ForceDeleteWithoutRecovery: true,
        })
      );
      this.logger.debug(`Successfully deleted secret ${logicalId}`);
    } catch (error) {
      if (error instanceof ResourceNotFoundException) {
        const clientRegion = await this.smClient.config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`Secret ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete secret ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * The `SecretString` an in-place update must send, or `undefined` when the
   * value's SOURCE is unchanged (issue #2472).
   *
   * The source is `GenerateSecretString` when present (CloudFormation gives it
   * precedence over a literal) and `SecretString` otherwise. A generated value
   * is minted only when the `GenerateSecretString` block differs from the
   * previous one — every in-place update re-runs this method, so comparing
   * the block rather than the (never persisted, never read back) value is
   * the only way to keep an unrelated update from re-rolling the password. A
   * literal is sent only when it differs from the previous literal. Switching
   * source in either direction counts as a change (the previous side of the
   * new source is `undefined`), and a bag that carries NEITHER source keeps
   * the live value untouched, as CloudFormation does.
   *
   * THE PREVIOUS BAG IS WHAT STATE PERSISTED, so the block is compared in
   * that spelling. On the deploy path a `{{resolve:...}}` inside
   * `SecretStringTemplate` reaches this method as plaintext while state holds
   * the redacted expression (GHSA-p5qg-v9gv-hc7w); compared raw, such a block
   * ALWAYS differs and every Tags-only update re-rolls the password — the
   * defect this method exists to close, for exactly the shape that embeds a
   * secret. {@link asPersisted} rewrites the desired block through the same
   * redaction the state writer uses, so the two sides meet. A pre-GHSA record
   * still holding plaintext matches the raw comparison instead; either match
   * means "unchanged".
   *
   * The same rewrite means an upstream ROTATION behind an unchanged reference
   * in `SecretStringTemplate` does NOT regenerate (the expression is the same
   * on both sides), where CloudFormation, which re-resolves at update time,
   * would. That is the intended trade for the generated source: the harmful
   * direction is the unrequested re-roll. (Two references collapsing onto one
   * plaintext persist the LAST expression recorded, so that rarer shape can
   * still read as changed once.)
   *
   * A LITERAL IS DELIBERATELY NOT REDACTED BEFORE COMPARING. A
   * `SecretString: '{{resolve:...}}'` (a secret mirroring another one) is
   * re-sent on every in-place update: cdkd cannot tell whether the REFERENCED
   * value changed since the last deploy — state holds only the expression —
   * and CloudFormation re-applies it when the resolved value changed. A
   * redundant version is the milder failure; a stale copy is a wrong value.
   *
   * `isDeepStrictEqual` over a JSON round-trip rather than `JSON.stringify`
   * equality: the previous bag comes back from state.json while the new one
   * comes from the resolver, so a key-order difference is not a change, and
   * an explicit `undefined` member (which state.json cannot hold) must not
   * read as one either — that failure direction is a silent re-roll.
   *
   * KNOWN EDGE, accepted: the redaction is a VALUE scan, so a literal in the
   * block that happens to EQUAL a plaintext this resource resolved from a
   * reference elsewhere in its bag is rewritten to that reference's
   * expression too. Replacing a `{{resolve:...}}` in the template with the
   * literal it currently resolves to therefore compares equal and does NOT
   * regenerate, where CloudFormation would. This is the same rewrite the
   * state writer applies to that literal when it persists the record, so the
   * two sides stay consistent, and the miss is in the safe direction (no
   * unrequested re-roll) for an edit that puts a secret's plaintext into a
   * template.
   */
  private changedSecretValue(
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): string | undefined {
    const generateConfig = properties['GenerateSecretString'] as
      | Record<string, unknown>
      | undefined;
    if (generateConfig) {
      const previous = previousProperties['GenerateSecretString'];
      const unchanged =
        isDeepStrictEqual(asJson(generateConfig), asJson(previous)) ||
        isDeepStrictEqual(asJson(this.asPersisted(generateConfig)), asJson(previous));
      return unchanged ? undefined : this.generateSecretString(generateConfig);
    }
    const literal = properties['SecretString'];
    if (literal === undefined) return undefined;
    if (typeof literal !== 'string') {
      // Pre-#2472 this was forwarded and left to AWS; a silent drop is the
      // worse failure for a value the user wrote, so name the shape (never
      // the value) instead.
      const shape = literal === null ? 'null' : Array.isArray(literal) ? 'array' : typeof literal;
      throw new Error(`SecretString must be a string, got ${shape}`);
    }
    // An empty string is a VALUE here, not "absent": a literal changed to
    // `''` (or a switch from `GenerateSecretString` to `SecretString: ''`)
    // is a change the user wrote, so it goes on the wire and AWS accepts
    // or rejects it, rather than silently keeping the old value. (`create()`
    // still skips `''` with its truthy gate, so a secret created empty has no
    // version at all; a later change TO `''` then reads as a no-op here.)
    return literal === previousProperties['SecretString'] ? undefined : literal;
  }

  /**
   * `bag` as the state writer would persist it: every plaintext this
   * provider call resolved from a `{{resolve:...}}` reference is rewritten
   * back to its expression. The pairs come from the per-resource scope the
   * deploy engine / rollback executor bind around the provider call
   * (`resource-secrets-scope.ts`); absent (drift `--revert`, import, tests)
   * the bag is returned as-is. The map is handed to the redaction helper
   * only — never enumerated, never logged.
   */
  private asPersisted<T>(bag: T): T {
    const secrets = getCurrentResourceSecrets();
    return secrets !== undefined && secrets.size > 0 ? redactSecretsForState(bag, secrets) : bag;
  }

  /**
   * Generate a secret string from GenerateSecretString configuration
   *
   * Simple implementation that generates a random string based on the config.
   */
  private generateSecretString(config: Record<string, unknown>): string {
    const length = (config['PasswordLength'] as number) || 32;
    const excludeUppercase = config['ExcludeUppercase'] as boolean;
    const excludeLowercase = config['ExcludeLowercase'] as boolean;
    const excludeNumbers = config['ExcludeNumbers'] as boolean;
    const excludePunctuation = config['ExcludePunctuation'] as boolean;
    const excludeCharacters = readConfigString(
      config,
      'ExcludeCharacters',
      '',
      'AWS::SecretsManager::Secret GenerateSecretString'
    );

    let chars = '';
    if (!excludeUppercase) chars += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    if (!excludeLowercase) chars += 'abcdefghijklmnopqrstuvwxyz';
    if (!excludeNumbers) chars += '0123456789';
    if (!excludePunctuation) chars += '!@#$%^&*()_+-=[]{}|;:,.<>?';

    // Remove excluded characters
    if (excludeCharacters) {
      for (const c of excludeCharacters) {
        chars = chars.replaceAll(c, '');
      }
    }

    if (chars.length === 0) {
      chars = 'abcdefghijklmnopqrstuvwxyz';
    }

    // Generate random password
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    let password = '';
    for (let i = 0; i < length; i++) {
      password += chars[bytes[i]! % chars.length];
    }

    // If GenerateStringKey is specified, wrap in JSON
    const generateStringKey = config['GenerateStringKey'] as string | undefined;
    const secretStringTemplate = config['SecretStringTemplate'] as string | undefined;

    if (generateStringKey && secretStringTemplate) {
      try {
        const template = JSON.parse(secretStringTemplate) as Record<string, unknown>;
        template[generateStringKey] = password;
        return JSON.stringify(template);
      } catch {
        return password;
      }
    }

    return password;
  }

  /**
   * Read the AWS-current secret configuration in CFn-property shape.
   *
   * Issues `DescribeSecret` and surfaces `Name`, `Description`, `KmsKeyId`,
   * and `ReplicaRegions` (re-shaping `ReplicationStatus[]` to CFn's
   * `[{Region, KmsKeyId}]`).
   *
   * Intentionally omitted:
   *   - `SecretString` / `GenerateSecretString`: `DescribeSecret` does not
   *     return the secret value (that's `GetSecretValue`, which we never
   *     call to avoid surfacing plaintext through drift). Cdkd state holds
   *     the user-supplied string verbatim; comparing against AWS would
   *     require pulling the value, so this is deliberately deferred.
   *
   * `Tags` is surfaced from the same `DescribeSecret` response (no extra
   * round-trip). CDK's `aws:*` auto-tags are filtered out; the result key
   * is omitted entirely when AWS reports no user tags.
   *
   * Returns `undefined` when the secret is gone (`ResourceNotFoundException`).
   */
  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    _resourceType: string
  ): Promise<Record<string, unknown> | undefined> {
    try {
      const resp = await this.smClient.send(new DescribeSecretCommand({ SecretId: physicalId }));
      const result: Record<string, unknown> = {};
      if (resp.Name !== undefined) result['Name'] = resp.Name;
      result['Description'] = resp.Description ?? '';
      result['KmsKeyId'] = resp.KmsKeyId ?? '';
      result['ReplicaRegions'] = (resp.ReplicationStatus ?? []).map((r) => {
        const out: Record<string, unknown> = {};
        if (r.Region) out['Region'] = r.Region;
        if (r.KmsKeyId) out['KmsKeyId'] = r.KmsKeyId;
        return out;
      });
      // Tags from the same DescribeSecret response.
      const tags = normalizeAwsTagsToCfn(resp.Tags);
      result['Tags'] = tags;
      // `Type`: emit-when-present. AWS returns undefined for the typical
      // (non-partner-managed) secret; emitting a `''` placeholder would
      // force a guaranteed drift on every clean run for the common case.
      if (resp.Type !== undefined) result['Type'] = resp.Type;
      return result;
    } catch (err) {
      if (err instanceof ResourceNotFoundException) return undefined;
      throw err;
    }
  }

  /**
   * `SecretString` and `GenerateSecretString` are set on create but
   * `DescribeSecret` does not return the secret value (that lives behind
   * `GetSecretValue`, which we deliberately never call to avoid surfacing
   * plaintext through drift). Tell the drift comparator to skip both keys
   * so they don't fire guaranteed false-positive drift on every clean run.
   */
  getDriftUnknownPaths(): string[] {
    return ['SecretString', 'GenerateSecretString'];
  }

  /**
   * Adopt an existing Secrets Manager secret into cdkd state.
   *
   * Secrets Manager physical IDs are full secret ARNs. The CDK template's
   * `Properties.Name` (secret name) is enough to fetch the ARN via
   * `DescribeSecret`.
   *
   * Lookup order:
   *  1. `--resource` override (ARN) → verify via `DescribeSecret`.
   *  2. `Properties.Name` → `DescribeSecret` (accepts name).
   */
  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    if (input.knownPhysicalId) {
      try {
        const resp = await this.smClient.send(
          new DescribeSecretCommand({ SecretId: input.knownPhysicalId })
        );
        return resp.ARN ? { physicalId: resp.ARN, attributes: {} } : null;
      } catch (err) {
        if (err instanceof ResourceNotFoundException) return null;
        throw err;
      }
    }

    const name =
      typeof input.properties?.['Name'] === 'string' ? input.properties['Name'] : undefined;
    if (name) {
      try {
        const resp = await this.smClient.send(new DescribeSecretCommand({ SecretId: name }));
        return resp.ARN ? { physicalId: resp.ARN, attributes: {} } : null;
      } catch (err) {
        if (err instanceof ResourceNotFoundException) return null;
        throw err;
      }
    }

    // No `aws:cdk:path` tag walk: AWS rejects `aws:`-prefixed tag writes, so
    // that tag never exists on a real resource and the walk could not match
    // (issue #1134). Auto-mode import resolves ids from CloudFormation's
    // DescribeStackResources or the template's physical-name property; a secret
    // reaching here needs an explicit `--resource` override.
    return null;
  }
}
