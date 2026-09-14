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
import {
  coerceCfnBoolean,
  coerceCfnInteger,
  configBooleanRefusal,
  configIntegerRefusal,
  configStringRefusal,
  requireConfigObject,
} from '../config-shape.js';
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
 * A `SecretString` about to go on the wire must be a string. Pre-#2472 a
 * non-string was forwarded through a cast and left to AWS; a silent drop is
 * the worse failure for a value the user wrote, so the SHAPE is named — never
 * the value. Shared by `create()` and `update()` so the two cannot disagree.
 */
function requireSecretStringShape(literal: unknown): string {
  if (typeof literal === 'string') return literal;
  const shape = literal === null ? 'null' : Array.isArray(literal) ? 'array' : typeof literal;
  throw new Error(`SecretString must be a string, got ${shape}`);
}

/**
 * The character classes a `GenerateSecretString` block leaves available,
 * after the `Exclude*` switches and `ExcludeCharacters` (issue #3068), or the
 * refusal that says why no password can be minted from it. ONE function for
 * the predicate and the generator, so the shapes the predicate refuses are
 * exactly the shapes the generator cannot serve.
 *
 * The caller has already run the member SHAPE predicates (`ExcludeCharacters`
 * is a string or absent, the booleans coerce, `PasswordLength` is an integer
 * in range) — this function reads the block by cast on that precondition.
 *
 * Three refusals, each MEASURED on CloudFormation (us-east-1, 2026-09-14): the
 * docs give the default (`RequireEachIncludedType` on) and the four-type
 * wording, but none of the refusal shapes or their messages:
 *
 * - `RequireEachIncludedType` defaults to TRUE and covers the four classes
 *   (upper, lower, number, punctuation) that are not switched off; a space is
 *   never required, only admitted. With it on, a class the `Exclude*` switch
 *   keeps but `ExcludeCharacters` empties is refused: `All characters of the
 *   desired type have been excluded`. With it OFF the same template CREATES
 *   (measured), so the refusal is scoped to REQUIRED classes.
 * - With it on, `PasswordLength` below the number of required classes is
 *   refused: `Password length is too short based on the required types`.
 * - A pool with no character at all is refused: `All characters have been
 *   excluded from selection`. The old local fallback to lowercase invented a
 *   charset the template had excluded.
 */
function generateCharset(config: Record<string, unknown>): {
  readonly required: readonly string[];
  readonly pool: string;
  readonly refusal?: string;
} {
  // Secrets Manager's own punctuation set for `GetRandomPassword` (32
  // characters, from the API reference's `ExcludePunctuation` description).
  // The local recipe used a 26-character subset until issue #3068, so an
  // `ExcludeCharacters` aimed at one of the missing six (double quote,
  // apostrophe, slash, backslash, backtick, tilde) was inert here while it
  // meant something to the service. A LOCAL const (the #2212 fence refuses
  // module-level bindings by spelling), with the backtick built from its
  // char code: that fence's string stripper takes template literals FIRST,
  // so a raw backtick inside a quoted literal desyncs its brace walk -- and
  // prettier rewrites a \u escape back into the raw character.
  const PUNCTUATION = '!"#$%&\'()*+,-./:;<=>?@[\\]^_' + String.fromCharCode(0x60) + '{|}~';
  const off = (key: string): boolean => coerceCfnBoolean(config[key]) ?? false;
  const excluded = new Set((config['ExcludeCharacters'] as string | undefined) ?? '');
  const strip = (chars: string): string => [...chars].filter((c) => !excluded.has(c)).join('');
  // [type name, its characters after ExcludeCharacters, the switch that turns
  // the whole type off] — the switch travels with the row so the refusal can
  // name it without re-deriving it from the type name.
  const classes: ReadonlyArray<readonly [name: string, chars: string, switchKey: string]> = [
    ['uppercase', strip('ABCDEFGHIJKLMNOPQRSTUVWXYZ'), 'ExcludeUppercase'],
    ['lowercase', strip('abcdefghijklmnopqrstuvwxyz'), 'ExcludeLowercase'],
    ['number', strip('0123456789'), 'ExcludeNumbers'],
    ['punctuation', strip(PUNCTUATION), 'ExcludePunctuation'],
  ];
  const requireEach = coerceCfnBoolean(config['RequireEachIncludedType']) ?? true;
  const included = classes.filter(([, , switchKey]) => !off(switchKey));
  const required: string[] = [];
  if (requireEach) {
    for (const [name, chars, switchKey] of included) {
      if (chars.length === 0) {
        return {
          required: [],
          pool: '',
          refusal: `all characters of the ${name} type have been excluded while RequireEachIncludedType requires one (exclude the type with ${switchKey} instead)`,
        };
      }
      required.push(chars);
    }
  }
  const space =
    (coerceCfnBoolean(config['IncludeSpace']) ?? false) && !excluded.has(' ') ? ' ' : '';
  const pool = included.map(([, chars]) => chars).join('') + space;
  if (pool.length === 0) {
    return {
      required: [],
      pool: '',
      refusal: 'all characters have been excluded from selection, so no password can be generated',
    };
  }
  const length = coerceCfnInteger(config['PasswordLength']) ?? 32;
  if (required.length > length) {
    return {
      required: [],
      pool: '',
      refusal: `PasswordLength ${length} is too short for the ${required.length} character types RequireEachIncludedType requires`,
    };
  }
  return { required, pool };
}

/**
 * A uniformly distributed index below `n`, by rejection: a raw draw taken
 * modulo `n` biases toward the low indexes whenever the draw's range is not
 * a multiple of `n` (2^32 never is for a 26- or 32-character class), and a
 * password generator should not.
 * The rejection IS fenced, deterministically: the unit suite stubs
 * `crypto.getRandomValues` to hand back a draw at or above `limit` and then
 * one below it, and asserts the first is thrown away (a `% n` shortcut would
 * mint from it). The bias itself is about 1 part in 2^32 / n per index at
 * this width — negligible either way; the rejection makes it zero.
 */
function randomIndex(n: number): number {
  // An empty range is a caller bug, and it must FAIL rather than spin: with
  // `n === 0` the limit is `NaN`, no draw is ever below it, and the loop never
  // returns. Measured while probing the too-short refusal above -- with that
  // refusal removed, a 3-character password under four required classes ran
  // out of positions and the test process hung instead of failing.
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`randomIndex: range must be a positive integer (got ${n})`);
  }
  const limit = Math.floor(0x1_0000_0000 / n) * n;
  const draw = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(draw);
    if (draw[0]! < limit) return draw[0]! % n;
  }
}

/**
 * The refusal for the MEMBERS of a `GenerateSecretString` block whose container
 * has already passed `requireConfigObject` (issue #3056), or `undefined` when
 * every member is usable. ONE predicate for two readers — the generator, which
 * mints from the block, and `retainPreviousGenerateBlock`, which decides
 * whether the PREVIOUS block is worth recording — per the #1653 rule that the
 * retention runs the same predicate the wire does. A module-level function
 * rather than a method so the recording helper can call it without reaching
 * `this`, which the #2212 fence confines to one logger call.
 *
 * Per member, the shared `config-shape.ts` predicate for its type: CFn is
 * stringly typed, so `PasswordLength: "32"` and `ExcludePunctuation: "true"`
 * coerce, while `null`, a blank, a non-numeric string, an object or an
 * unresolved intrinsic refuse. `PasswordLength` is capped at 4096, the
 * service's documented maximum, so a runaway length is refused before
 * `new Uint8Array` allocates it. `GenerateStringKey` / `SecretStringTemplate`
 * must be declared TOGETHER — the docs pin only key -> template; measured on
 * CloudFormation (us-east-1, 2026-09-13), a template with
 * `SecretStringTemplate` alone fails with `SecretStringTemplate and
 * GenerateStringKey must both be set or removed`, the service's own message
 * naming both directions (only that one was exercised) — the template must
 * parse to a JSON OBJECT (an array or a scalar parses and cannot take a key),
 * and the key may not be `__proto__`, which `template[key] = password` would
 * hand to the prototype setter, silently dropping the password from the
 * document. The messages name shapes only, never a value: the template can
 * carry a secret.
 */
function generateMemberRefusal(config: Record<string, unknown>): string | undefined {
  const P = 'AWS::SecretsManager::Secret GenerateSecretString';
  const shape =
    configIntegerRefusal(config, 'PasswordLength', P, 1, 4096) ??
    configBooleanRefusal(config, 'ExcludeUppercase', P) ??
    configBooleanRefusal(config, 'ExcludeLowercase', P) ??
    configBooleanRefusal(config, 'ExcludeNumbers', P) ??
    configBooleanRefusal(config, 'ExcludePunctuation', P) ??
    configBooleanRefusal(config, 'IncludeSpace', P) ??
    configBooleanRefusal(config, 'RequireEachIncludedType', P) ??
    // A blank fallback is what lets a declared `''` pass (legitimate: exclude
    // nothing); the non-blank sentinel on the next two is never TAKEN — it
    // only makes a blank value refuse, since a blank key or template is not
    // a declaration.
    configStringRefusal(config, 'ExcludeCharacters', '', P) ??
    configStringRefusal(config, 'GenerateStringKey', 'required', P) ??
    configStringRefusal(config, 'SecretStringTemplate', 'required', P);
  if (shape !== undefined) return shape;
  const charset = generateCharset(config);
  if (charset.refusal !== undefined) return `${P}: ${charset.refusal}`;
  const key = config['GenerateStringKey'];
  const template = config['SecretStringTemplate'];
  if (key === undefined && template === undefined) return undefined;
  if (key === undefined || template === undefined) {
    return `${P}.GenerateStringKey and ${P}.SecretStringTemplate must be declared together (got only ${key === undefined ? 'SecretStringTemplate' : 'GenerateStringKey'})`;
  }
  if (key === '__proto__') {
    return `${P}.GenerateStringKey must not be __proto__ (the password would be written to the prototype, not the document)`;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(template as string);
  } catch {
    return `${P}.SecretStringTemplate must be a JSON object (got a string that does not parse as JSON)`;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return `${P}.SecretStringTemplate must be a JSON object (got JSON that is not an object)`;
  }
  return undefined;
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
      const rawGenerate = properties['GenerateSecretString'];

      // `!= null`, NOT truthiness — the same gate `changedSecretValue` uses.
      // A FALSY malformed container (`''`, `0`) would otherwise fall through
      // to the literal read and, with no literal declared, create a secret
      // with NO version in silence (the #1493 gate-bug shape).
      if (rawGenerate != null) {
        // DELIBERATE DEVIATION from the replay downgrade, recorded rather than
        // left implicit (`.claude/rules/provider-replay-and-refusals.md`
        // requires it to be stated). `create()` declares no `CreateContext`,
        // so the rollback executor's reverse-replacement arm cannot downgrade
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
        // have none. Threading the context would not change that answer, so
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
        this.logger.warn(
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
      const { value: secretString, skippedGenerate } = this.changedSecretValue(
        properties,
        previousProperties
      );

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
        // A SKIPPED generate block must not be RECORDED (issue #3048 review).
        // The engine records the desired bag unless told otherwise, so without
        // this the malformed container would overwrite the usable one in
        // state — and then the next deploy compares desired == previous, takes
        // the `unchanged` early return, and the secret sits un-regenerated
        // with NO warning at all. That is worse than the throw this change
        // replaced: it converts a loud, repeating failure into a silent one,
        // and the poisoned record later reaches the reverse-replacement
        // replay-create, which refuses it.
        //
        // So state keeps describing what AWS still holds — the #1612 UPDATE
        // rule. The previous block is validated with the SAME predicate the
        // wire uses rather than a hand-written twin, and the key is DROPPED
        // when the previous side is absent or itself unusable, since there is
        // then no value cdkd can vouch for (the #1653 review rule).
        // Spelled as an always-present key rather than a conditional SPREAD so
        // it stays visible to the #2212 return-shape fence, which reads the
        // literal's top-level keys. A spread renders as `...` there, and an
        // assignment after the literal would evade the fence entirely -- the
        // failure mode that fence's own header records.
        effectiveProperties: skippedGenerate
          ? this.retainPreviousGenerateBlock(logicalId, properties, previousProperties)
          : undefined,
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
   * The bag to RECORD when the generate block was skipped: the desired
   * properties with `GenerateSecretString` restored to the previously-applied
   * value, or with the key dropped when the previous side cannot be vouched
   * for either.
   *
   * Validated through `requireConfigObject` AND `generateMemberRefusal` — the
   * same two predicates the wire read runs, container then members — rather
   * than a hand-written twin, so the two cannot disagree about a blank string,
   * an explicit null, an intrinsic, or (since issue #3056) a malformed member
   * inside a well-formed block: a pre-#3056 record holding
   * `PasswordLength: 'abc'` is dropped, not retained. The retained block is
   * COPIED, not aliased: both engine consumers spread the answer one level
   * deep only (the #1653 review rule).
   *
   * The DROP is announced rather than silent (the #1654 rule: dropping a key
   * moves a hazard unless something still says so). A record carrying
   * neither value source later reaches the reverse-replacement replay-create,
   * where `create()` — which cannot see the record's history — would create
   * the secret with NO version; the warning here is what makes that record
   * diagnosable, and `create()` warns again when it meets one.
   *
   * One shape is announced rather than reconciled: a secret created from a
   * LITERAL whose template then switches to a malformed generate block. The
   * previous side has no block, so the key is dropped, and the record then
   * carries neither source while AWS still holds the literal. Restoring the
   * previous `SecretString` would be the #1612 answer, but it re-records a
   * literal the template has REMOVED; the drop keeps the next deploy of the
   * same template an announced UPDATE (desired block vs absent), which is the
   * loud outcome this arm exists for.
   */
  private retainPreviousGenerateBlock(
    logicalId: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Record<string, unknown> {
    // An ABSENT previous (`undefined` / `null`) takes the same road as an
    // unusable one: the guard answers `undefined` for both, and the drop
    // below is the right answer for both.
    const usableContainer = requireConfigObject(
      previousProperties['GenerateSecretString'],
      'AWS::SecretsManager::Secret GenerateSecretString',
      {
        // No-op: the drop warning below is the one announcement, naming BOTH
        // sides; a second line about the previous block would name a value
        // the user did not just write.
        onUnusable: () => {},
      }
    );
    const usablePrevious =
      usableContainer !== undefined && generateMemberRefusal(usableContainer) === undefined
        ? usableContainer
        : undefined;
    const effective = { ...properties };
    if (usablePrevious === undefined) {
      delete effective['GenerateSecretString'];
      this.logger.warn(
        `AWS::SecretsManager::Secret ${logicalId}: GenerateSecretString is dropped from the ` +
          `recorded properties. The desired block is unusable and the previously recorded one ` +
          `is absent or unusable, so the record now carries no GenerateSecretString; fix the ` +
          `template so the next deploy records one.`
      );
    } else {
      effective['GenerateSecretString'] = { ...usablePrevious };
    }
    return effective;
  }

  /**
   * The `SecretString` an in-place update must send (as `value`), or
   * `undefined` when the value's SOURCE is unchanged (issue #2472) or when a
   * malformed `GenerateSecretString` block was SKIPPED (issue #3048,
   * `skippedGenerate: true` — the caller records the previous block instead).
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
   * One consequence of the precedence: a PREVIOUS bag carrying both a block
   * and an ignored `SecretString: 'x'` masks a block-to-literal switch whose
   * literal is still `'x'` (the literal compares equal, nothing is sent).
   * CloudFormation rejects a template declaring both, so such a record is
   * cdkd-created only and the miss is accepted.
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
   * direction is the unrequested re-roll.
   *
   * RESIDUAL, permanent rather than one-shot: two references in the block
   * that resolve to the SAME plaintext. The resolver records one pair per
   * plaintext (last expression wins), so this value scan rewrites BOTH leaves
   * to the survivor expression, while the persisted previous holds each
   * leaf's own expression (the state writer redacts by POSITION, with the
   * template as its source) — the two spellings differ on every in-place
   * update, and that shape re-rolls on every Tags-only deploy. Threading a
   * position source through here would close it, but the only source this
   * method holds is the PREVIOUS block, and substituting its leaves would
   * also erase a genuine reference switch in a secret leaf; left open for a
   * shape that is rare (two secrets with identical plaintext in one block).
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
  ): { value: string | undefined; skippedGenerate: boolean } {
    const rawGenerate = properties['GenerateSecretString'];
    // `!= null`, NOT truthiness: a FALSY malformed container (`''`, `0`) would
    // otherwise skip this branch entirely and fall through to the literal
    // read, which is the #1493 gate-bug shape `config-shape.ts` names —
    // silently ignoring a `GenerateSecretString` the template declared.
    if (rawGenerate != null) {
      const generateConfig = rawGenerate as Record<string, unknown>;
      const previous = previousProperties['GenerateSecretString'];
      const unchanged =
        isDeepStrictEqual(asJson(generateConfig), asJson(previous)) ||
        isDeepStrictEqual(asJson(this.asPersisted(generateConfig)), asJson(previous));
      if (unchanged) return { value: undefined, skippedGenerate: false };
      // A malformed container SKIPS the value rather than throwing (issue
      // #3048). `update()` is reached by the rollback executor's revert arms
      // with a cdkd STATE record as the desired bag, which the user cannot
      // edit from the template — so a throw here leaves the secret
      // un-rollbackable (the #1544 hazard). `cdkd drift --revert` is NOT a
      // caller of this arm: its bag is seeded from the AWS readback plus the
      // DRIFTED keys only, and `getDriftUnknownPaths` keeps this key out of
      // the comparison, so the block never rides a revert.
      //
      // The downgrade is a SKIP and NOT `onUnusable`, because at this site
      // proceeding is the harm: `generateSecretString` reads every member off
      // this container, so a malformed one indexes them all to `undefined` and
      // mints a bare default-charset password — and with `GenerateStringKey` /
      // `SecretStringTemplate` gone too, it returns that password RAW instead
      // of the JSON document the template declared. That value becomes the new
      // `AWSCURRENT`, breaking every consumer reading `{"username":…}`.
      // Omitting `SecretString` instead leaves `UpdateSecret`'s merge
      // semantics to keep the value AWS already holds.
      //
      // The downgrade is handed to `generateSecretString` as a callback
      // rather than living inside it, because `create()` calls the same
      // function with none (there is no live secret to fall back to on a
      // create, so it must keep refusing). The container and every MEMBER
      // (issue #3056) take the same road: a refusal on the update path is a
      // SKIP of the whole value, announced once.
      //
      // `requireConfigObject`'s own message already ends with the
      // template-path-create clause, so this one adds only what IS specific to
      // the site: what happens to the live value.
      const skip = (m: string): void =>
        this.logger.warn(
          `${m} No new secret value is generated; the secret keeps the value AWS ` +
            `currently holds.`
        );
      const usable = requireConfigObject(
        generateConfig,
        'AWS::SecretsManager::Secret GenerateSecretString',
        { onUnusable: skip }
      );
      const generated =
        usable === undefined ? undefined : this.generateSecretString(usable, { onUnusable: skip });
      return generated === undefined
        ? { value: undefined, skippedGenerate: true }
        : { value: generated, skippedGenerate: false };
    }
    const literal = properties['SecretString'];
    if (literal === undefined) return { value: undefined, skippedGenerate: false };
    // UNCHANGED is decided before the shape is judged: a record written by a
    // pre-#2472 binary may hold a non-string the old `create()` forwarded via
    // a cast, and an unrelated (Tags-only) update of that record must keep
    // succeeding as it always did — the refusal below applies only to a value
    // that would actually be SENT.
    if (isDeepStrictEqual(asJson(literal), asJson(previousProperties['SecretString']))) {
      return { value: undefined, skippedGenerate: false };
    }
    // An empty string is a VALUE here, not "absent": a literal changed to
    // `''` (or a switch from `GenerateSecretString` to `SecretString: ''`)
    // is a change the user wrote, so it goes on the wire and AWS accepts
    // or rejects it, rather than silently keeping the old value. (`create()`
    // still skips `''` with its truthy gate, so a secret created empty has no
    // version at all; a later change TO `''` then reads as a no-op here.)
    return { value: requireSecretStringShape(literal), skippedGenerate: false };
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
   * Generate a secret string from a USABLE `GenerateSecretString` block (the
   * caller has already run `requireConfigObject` on the container).
   *
   * Every MEMBER is read through the shared `config-shape.ts` predicate for
   * its type (issue #3056) rather than a cast: CFn is stringly typed, so
   * `PasswordLength: "32"` and `ExcludePunctuation: "true"` are legitimate
   * and coerce, while a malformed member — `null`, a blank, a non-numeric
   * string, an object, an unresolved intrinsic — REFUSES instead of taking a
   * default. The defaults it used to take were not inert: `(x as number) || 32`
   * read `PasswordLength: 'abc'` as a truthy string and `new Uint8Array('abc')`
   * minted an EMPTY password; a truthy `'false'` EXCLUDED punctuation; and a
   * malformed `SecretStringTemplate` fell into the `catch` and returned the
   * bare password RAW where the template declared a JSON document — as the
   * new `AWSCURRENT`.
   *
   * The member rules themselves live in `generateMemberRefusal` (shared with
   * the recording helper); both present means the key is written into the
   * parsed template, both absent means a bare password, which is what the
   * service does.
   *
   * With no `onUnusable` a refusal THROWS (the create path, where the block
   * is template-borne). With one, the message is handed over and `undefined`
   * is returned — the update path's SKIP, decided by the caller, so that this
   * function never mints from a block it could not read. The recipe itself —
   * the four classes, the service's punctuation set, `IncludeSpace`, and the
   * `RequireEachIncludedType` guarantee — lives in `generateCharset` (issue
   * #3068), shared with the predicate so the block it refuses and the block
   * it mints from cannot disagree.
   */
  private generateSecretString(
    config: Record<string, unknown>,
    options?: { onUnusable?: (message: string) => void }
  ): string | undefined {
    const refusal = generateMemberRefusal(config);
    if (refusal !== undefined) {
      if (options?.onUnusable) {
        options.onUnusable(
          `${refusal}. Leaving this configuration unapplied here; the same value is REFUSED on a ` +
            `template-path create.`
        );
        return undefined;
      }
      throw new Error(refusal);
    }

    const length = coerceCfnInteger(config['PasswordLength']) ?? 32;
    const { required, pool } = generateCharset(config);

    // Draw uniformly from the pool, then satisfy `RequireEachIncludedType` by
    // PLACEMENT rather than by re-drawing: one character of each required
    // class lands at a distinct random position, so the guarantee holds in
    // one pass whatever the length (the refusal above already settled
    // `length >= required.length`).
    const out: string[] = [];
    for (let i = 0; i < length; i++) out.push(pool[randomIndex(pool.length)]!);
    const positions = Array.from({ length }, (_, i) => i);
    for (const classChars of required) {
      const slot = positions.splice(randomIndex(positions.length), 1)[0]!;
      out[slot] = classChars[randomIndex(classChars.length)]!;
    }
    const password = out.join('');

    // Both present (the refusal above settled "both or neither" and that the
    // template parses to an object): write the password into the document.
    const generateStringKey = config['GenerateStringKey'] as string | undefined;
    const secretStringTemplate = config['SecretStringTemplate'] as string | undefined;
    if (generateStringKey === undefined || secretStringTemplate === undefined) return password;
    const template = JSON.parse(secretStringTemplate) as Record<string, unknown>;
    template[generateStringKey] = password;
    return JSON.stringify(template);
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
