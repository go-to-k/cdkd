import type { SecretsManagerSecretProvider } from '../secretsmanager-secret-provider.js';
import { CreateSecretCommand } from '@aws-sdk/client-secrets-manager';
import { requireConfigObject } from '../../config-shape.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { generatedNameFor } from '../../resource-name.js';
import { refuseMalformedDesiredTags } from '../../tag-list.js';
import type { ResourceCreateResult, CreateContext } from '../../../types/resource.js';
import { requireSecretStringShape } from './shared.js';

/**
 * Create a Secrets Manager secret
 */
export async function create(
  this: SecretsManagerSecretProvider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  context?: CreateContext
): Promise<ResourceCreateResult> {
  // Issue #2177: ONE masked sink per operation, every bag-derived value
  // masked RAW. `context` is read for the masker only (see below).
  const log = this.operationSinks(context?.maskSecrets, [[properties['Name'], properties['Name']]]);
  const { value: v } = log;
  log.debug(`Creating secret ${logicalId}`);
  // go-to-k/cdkd#3994: a malformed Tags is refused before any call.
  const desiredTags = refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId);

  const name =
    (properties['Name'] as string | undefined) ||
    generatedNameFor('AWS::SecretsManager::Secret', logicalId);

  try {
    // Build the secret value from GenerateSecretString or SecretString
    let secretString: string | undefined;
    const rawGenerate = properties['GenerateSecretString'];

    // `!= null`, NOT truthiness — the same gate `changedSecretValue` uses.
    // A FALSY malformed container (`''`, `0`) would otherwise fall through
    // to the literal read and, with no literal declared, create a secret
    // with NO version in silence (the #1493 gate-bug shape).
    if (rawGenerate != null) {
      // DELIBERATE DEVIATION from the replay downgrade, recorded rather than
      // left implicit (`.claude/rules/provider-replay-and-refusals.md`
      // requires it to be stated). `create()` reads its `CreateContext` for
      // the masker only, never `replayingState`, so the rollback executor's
      // reverse-replacement arm does not downgrade
      // this refusal, and a state record CAN carry a malformed container
      // (pre-#3032 the old code minted a bare password and the create
      // succeeded) — so the replay could have succeeded, which is NOT the
      // rule's stated exception.
      //
      // It refuses anyway because both downgrade outcomes are worse than a
      // loud failure: generating from the malformed block mints a password
      // ignoring every declared member and returns it RAW instead of the
      // declared JSON document, and skipping the value creates a secret with
      // NO version at all — a resource that exists and breaks every consumer
      // silently. A failed rollback is loud; its remedy is a hand-edit of
      // the record in `state.json` (the value cannot be fixed from the
      // template), which is still a remedy where the two silent outcomes
      // have none. Reading `replayingState` would not change that answer, so
      // the refusal stands on a replay too — a decision, not a gap.
      const generateConfig = requireConfigObject(
        rawGenerate,
        'AWS::SecretsManager::Secret GenerateSecretString'
      );
      secretString = this.generateSecretString(generateConfig);
    } else if (properties['SecretString'] !== undefined && properties['SecretString'] !== '') {
      // `''` is skipped: a `SecretString: ''` creates a secret with NO
      // version. `update()` deliberately treats `''` as a value (issue
      // #2472, see `changedSecretValue`); the two gates differ on purpose,
      // so a later change TO `''` on a secret created empty is a no-op
      // there. Every OTHER non-string — `null`, `false`, `0`, an object —
      // is refused by the SHAPE check shared with `update()`, so a record
      // that would trip that refusal on every later update can no longer
      // be created.
      secretString = requireSecretStringShape(properties['SecretString']);
    }
    if (secretString === undefined) {
      // Legal (neither property is required by the schema) but almost never
      // meant, and on the reverse-replacement replay-create it is the shape
      // a record whose block `update()` DROPPED arrives in (issue #3048,
      // `retainPreviousGenerateBlock`) — so it must not pass in silence.
      log.warn(
        `AWS::SecretsManager::Secret ${logicalId} declares no secret value (neither ` +
          `GenerateSecretString nor a non-empty SecretString); the secret is created with NO ` +
          `version. Consumers reading it will fail until a value is set.`
      );
    }

    const createParams: import('@aws-sdk/client-secrets-manager').CreateSecretCommandInput = {
      Name: name,
    };
    if (secretString) createParams.SecretString = secretString;
    if (properties['Description']) createParams.Description = properties['Description'] as string;
    if (properties['KmsKeyId']) createParams.KmsKeyId = properties['KmsKeyId'] as string;
    if (properties['Tags'] != null) {
      createParams.Tags = desiredTags;
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

    log.debug(`Successfully created secret ${logicalId}: ${v(secretArn)}`);

    return {
      physicalId: secretArn,
      attributes: {
        Id: secretArn,
      },
    };
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapCaughtError(
      log.mask,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to create secret ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          name,
          cause
        ),
      true
    );
  }
}
