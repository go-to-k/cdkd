import {
  SFNClient,
  CreateStateMachineCommand,
  DeleteStateMachineCommand,
  DescribeStateMachineCommand,
  StateMachineDoesNotExist,
  type CreateStateMachineCommandInput,
  type Tag,
  type StateMachineType,
} from '@aws-sdk/client-sfn';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getLogger, type ConsoleLogger } from '../../utils/logger.js';
import { describeAwsFailure } from '../../utils/aws-failure-text.js';
import {
  markRedactedCause,
  relayedNameCollision,
  wrapMaskedAwsError,
} from '../../deployment/retryable-errors.js';
import { markNotGone } from '../not-gone.js';
import { maskerOrIdentity, type MaskerFn } from '../masked-retry-logger.js';
import { definedAttributes } from '../attribute-map.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import { generatedNameFor } from '../resource-name.js';
import { SECRET_MASK } from '../../deployment/secret-redaction.js';
import { refuseMalformedDesiredTags } from '../tag-list.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  UpdateContext,
  CreateContext,
  ResourceImportInput,
  ResourceImportResult,
  ResourceNotFound,
} from '../../types/resource.js';
import { ambientClientDefaults } from '../../utils/ambient-client-defaults.js';
import { ambientRegion } from '../../utils/stack-aws-scope.js';
import { s3ClientDefaults } from '../../utils/s3-client-defaults.js';
import {
  stateMachineRevisionId,
  mapEncryptionConfiguration,
  mapLoggingConfiguration,
  mapTracingConfiguration,
} from './stepfunctions/shared.js';
import { update, applyTagDiff } from './stepfunctions/update.js';
import { readCurrentState, importImpl } from './stepfunctions/read-state.js';

/**
 * AWS Step Functions State Machine Provider
 *
 * Implements resource provisioning for AWS::StepFunctions::StateMachine using the SFN SDK.
 * WHY: SFN CreateStateMachine is synchronous - the CC API adds unnecessary polling
 * overhead (1s->2s->4s->8s) for an operation that completes immediately.
 * This SDK provider eliminates that polling and returns instantly.
 */
export class StepFunctionsProvider implements ResourceProvider {
  private sfnClient?: SFNClient;
  private s3Client?: S3Client;
  private readonly providerRegion = ambientRegion();
  logger: ConsoleLogger = getLogger().child('StepFunctionsProvider');

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::StepFunctions::StateMachine',
      new Set([
        'StateMachineName',
        'RoleArn',
        'StateMachineType',
        'LoggingConfiguration',
        'TracingConfiguration',
        'Tags',
        'DefinitionString',
        'Definition',
        'DefinitionS3Location',
        'DefinitionSubstitutions',
        'EncryptionConfiguration',
      ]),
    ],
  ]);

  getClient(): SFNClient {
    if (!this.sfnClient) {
      this.sfnClient = new SFNClient({
        ...ambientClientDefaults(),
        ...(this.providerRegion ? { region: this.providerRegion } : {}),
      });
    }
    return this.sfnClient;
  }

  private getS3Client(): S3Client {
    if (!this.s3Client) {
      this.s3Client = new S3Client({
        ...ambientClientDefaults(),
        ...s3ClientDefaults(),
        ...(this.providerRegion ? { region: this.providerRegion } : {}),
      });
    }
    return this.s3Client;
  }

  /**
   * Create a Step Functions state machine
   */
  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating Step Functions state machine ${logicalId}`);
    // go-to-k/cdkd#3994: a malformed Tags is refused before any call.
    const desiredTags = refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId);

    const stateMachineName =
      (properties['StateMachineName'] as string | undefined) ||
      (this.generatedCreateName(resourceType, logicalId, properties) as string);
    const roleArn = properties['RoleArn'] as string | undefined;

    if (!roleArn) {
      throw new ProvisioningError(
        `RoleArn is required for Step Functions state machine ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    try {
      // Build definition string - handle inline string/object forms AND the
      // S3-sourced form (DefinitionS3Location), applying DefinitionSubstitutions
      // to whichever body wins. The S3 path fetches the object, so this is async.
      const definitionString = await this.buildDefinitionString(properties);

      // Build tags: CDK uses [{Key, Value}], SFN SDK uses [{key, value}]
      const tags: Tag[] | undefined =
        properties['Tags'] !== undefined && properties['Tags'] !== null
          ? desiredTags.map((tag) => ({ key: tag.Key, value: tag.Value }))
          : undefined;

      // Translate every CFn-PascalCase nested object to the SDK's
      // camelCase shape (see helpers at file scope). All three mappers
      // also fold the Class 2 empty-placeholder case to `undefined` so
      // `cdkd drift --revert` round-trips through `update()` without AWS
      // rejecting a structurally incomplete payload.
      const encryptionConfiguration = mapEncryptionConfiguration(
        properties['EncryptionConfiguration']
      );
      const loggingConfiguration = mapLoggingConfiguration(properties['LoggingConfiguration']);
      const tracingConfiguration = mapTracingConfiguration(properties['TracingConfiguration']);

      const createParams: CreateStateMachineCommandInput = {
        name: stateMachineName,
        definition: definitionString,
        roleArn: roleArn,
        type: properties['StateMachineType'] as StateMachineType | undefined,
        loggingConfiguration,
        tracingConfiguration,
        tags: tags,
        encryptionConfiguration,
      };

      const response = await this.getClient().send(new CreateStateMachineCommand(createParams));

      const stateMachineArn = response.stateMachineArn;
      if (!stateMachineArn) {
        throw new Error('CreateStateMachine did not return stateMachineArn');
      }

      this.logger.debug(
        `Successfully created Step Functions state machine ${logicalId}: ${stateMachineArn}`
      );

      // Extract name from ARN (last segment after :)
      const name = stateMachineArn.split(':').pop() || stateMachineName;

      // `StateMachineRevisionId` is the state machine's `revisionId`, which
      // `CreateStateMachine` does not return (`stateMachineVersionArn`, recorded
      // here before, is a VERSION ARN and null without `publish`) — read it
      // back, as `update()` does (issue #3627). The resource exists by now, so
      // a failed read omits the attribute rather than failing the create; the
      // #1852 heal fills it on the next deploy.
      let revisionId: string | undefined;
      try {
        revisionId = stateMachineRevisionId(
          await this.getClient().send(new DescribeStateMachineCommand({ stateMachineArn }))
        );
      } catch (describeError) {
        this.logger.debug(
          `Could not read the revision id of ${logicalId} after create: ${describeAwsFailure(describeError).detail}`
        );
      }

      return {
        physicalId: stateMachineArn,
        attributes: definedAttributes({
          Arn: stateMachineArn,
          Name: name,
          StateMachineRevisionId: revisionId,
        }),
      };
    } catch (error) {
      if (error instanceof ProvisioningError) throw error;
      const cause = error instanceof Error ? error : undefined;
      throw this.wrapCaughtError(
        maskerOrIdentity(context?.maskSecrets),
        error,
        (text) =>
          new ProvisioningError(
            `Failed to create Step Functions state machine ${logicalId}: ${text}`,
            resourceType,
            logicalId,
            stateMachineName,
            cause
          )
      );
    }
  }

  update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    context?: UpdateContext
  ): Promise<ResourceUpdateResult> {
    return update.call(
      this,
      logicalId,
      physicalId,
      resourceType,
      properties,
      previousProperties,
      context
    );
  }

  /**
   * The failure wrap the create, update and delete catches throw.
   *
   * An AWS-authored failure reaches `build` as its CLASS plus the `--verbose`
   * pointer (go-to-k/cdkd#2319): a thrown message is persisted to
   * `deployments/{runId}.jsonl`, and an `AccessDenied` names the caller's
   * assumed-role ARN. AWS's own text goes to `debug` through `mask`, and the
   * wrap is stamped `markRedactedCause`, so the retry classifiers read the
   * withheld text on the `cause` chain. An "already exists" is restated
   * ({@link relayedNameCollision}) so a create-first replacement still
   * recognises the collision. A non-`Error` throw is withheld the same way,
   * unstamped: it has no chain.
   *
   * A cdkd-authored or transport error keeps its text, masked, stamped exactly
   * when the mask changed it (`wrapMaskedAwsError`, issue #4244). The delete
   * tests its typed not-found before it wraps.
   *
   * `build` must thread `error` as `cause`, and runs twice, so it must stay a
   * side-effect-free constructor call.
   */
  wrapCaughtError(
    mask: MaskerFn,
    error: unknown,
    build: (text: string) => ProvisioningError
  ): ProvisioningError {
    const failure = describeAwsFailure(error);
    if (!failure.redacted) return wrapMaskedAwsError(mask, error, build);
    this.logger.debug(mask(build(mask(failure.detail)).message));
    const wrapped = build(`${mask(failure.summary)}${relayedNameCollision(failure.detail)}`);
    return error instanceof Error ? markRedactedCause(wrapped) : wrapped;
  }

  /**
   * Delete a Step Functions state machine
   */
  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting Step Functions state machine ${logicalId}: ${physicalId}`);

    try {
      await this.getClient().send(new DeleteStateMachineCommand({ stateMachineArn: physicalId }));
      this.logger.debug(`Successfully deleted Step Functions state machine ${logicalId}`);
    } catch (error) {
      if (error instanceof StateMachineDoesNotExist) {
        const clientRegion = await this.getClient().config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(
          `Step Functions state machine ${physicalId} does not exist, skipping deletion`
        );
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      const thrown = this.wrapCaughtError(
        maskerOrIdentity(context?.maskSecrets),
        error,
        (text) =>
          new ProvisioningError(
            `Failed to delete Step Functions state machine ${logicalId}: ${text}`,
            resourceType,
            logicalId,
            physicalId,
            cause
          )
      );
      // The wrap names an AWS failure by its CLASS, and the delete classifiers
      // read `NotFoundException` in a message as "already deleted": only the
      // typed not-found above means this resource is gone (go-to-k/cdkd#2319).
      throw error instanceof Error && error.name.includes('NotFound')
        ? markNotGone(thrown)
        : thrown;
    }
  }

  /**
   * Fold a drift comparison bag's inline definition into the shape
   * {@link readCurrentState} reports (go-to-k/cdkd#5298).
   *
   * The readback carries only `Definition` — the definition AWS holds, already
   * substituted, parsed from JSON — and never `DefinitionString` or
   * `DefinitionSubstitutions`. An `observedProperties` baseline is that same
   * shape and passes through by identity. The `properties`-fallback baseline (a
   * record with no observed capture) is the template's: `DefinitionString`
   * and/or a `Definition` still holding `${name}` placeholders, plus the map.
   * Compared as-is, every substituted leaf and both template-only keys read as
   * drift. So a bag carrying `DefinitionString` or `DefinitionSubstitutions` is
   * rewritten to `Definition` = the substituted inline body, parsed the way
   * `readCurrentState` parses it, with those two keys dropped. A bag with no
   * inline form (`DefinitionS3Location`, which would need an S3 read) is
   * returned unchanged. Pure and non-mutating.
   *
   * Known limit: `cdkd drift --accept` on such a record writes the drifted
   * `Definition.*` leaf onto the RAW `properties`, beside the `DefinitionString`
   * it still holds. The fold keeps CloudFormation's precedence (`DefinitionString`
   * over `Definition`), so the accepted leaf is not what the next drift compares
   * and the same drift is reported again. It is harmless (the next deploy sends
   * the template), and `--revert` or a redeploy (which captures an observed
   * baseline) clears it. An object-`Definition` record accepts normally.
   */
  canonicalizeDriftProperties(
    _resourceType: string,
    properties: Record<string, unknown>
  ): Record<string, unknown> {
    if (
      properties['DefinitionString'] === undefined &&
      properties['DefinitionSubstitutions'] === undefined
    ) {
      return properties;
    }
    // A substitution whose recorded value is the redaction mask (a NoEcho value)
    // must not be SPLICED into a longer leaf: `"Bearer ***"` is not a mask to
    // any whole-leaf reader, so `drift --revert` would write it to AWS. Such a
    // name is substituted with a sentinel instead, and every leaf carrying it
    // becomes the WHOLE mask, which detection classifies and revert preserves.
    const substitutions = properties['DefinitionSubstitutions'];
    const maskedNames =
      substitutions !== null && typeof substitutions === 'object' && !Array.isArray(substitutions)
        ? Object.keys(substitutions).filter(
            (name) => (substitutions as Record<string, unknown>)[name] === SECRET_MASK
          )
        : [];
    const body = inlineDefinitionBody(
      properties,
      maskedNames.length === 0
        ? undefined
        : {
            ...(substitutions as Record<string, unknown>),
            ...Object.fromEntries(maskedNames.map((name) => [name, MASKED_SUBSTITUTION_SENTINEL])),
          }
    );
    if (body === undefined) return properties;
    let definition: unknown;
    try {
      definition = JSON.parse(body) as unknown;
    } catch {
      definition = body;
    }
    if (maskedNames.length > 0) definition = maskSentinelLeaves(definition);
    const folded: Record<string, unknown> = { ...properties, Definition: definition };
    delete folded['DefinitionString'];
    delete folded['DefinitionSubstitutions'];
    return folded;
  }

  /**
   * The same fold as {@link canonicalizeDriftProperties}, applied to the
   * BASELINE side only. `cdkd drift` compares through the per-side pass, so here
   * the baseline is already folded and this returns both bags by identity. It
   * exists for `cdkd drift --revert`, which sends its DESIRED bag (the recorded
   * baseline, secrets resolved) through this pair hook and NOT through the
   * per-side one. Unfolded, a properties-fallback record's desired bag holds
   * the template's `${name}` body, and the revert overlay pairs the folded change
   * paths (`Definition.*`) with it on top of the AWS bag, which has no
   * `DefinitionSubstitutions`, so `update()` would write the literal placeholders
   * over the live values. Folded, the overlaid `Definition` is the substituted
   * body `cdkd deploy` sends (go-to-k/cdkd#5298).
   */
  async canonicalizeDriftPair(
    resourceType: string,
    baseline: Record<string, unknown>,
    aws: Record<string, unknown>
  ): Promise<{ baseline: Record<string, unknown>; aws: Record<string, unknown> }> {
    return { baseline: this.canonicalizeDriftProperties(resourceType, baseline), aws };
  }

  /**
   * The `Definition` positions a secret-bearing `DefinitionSubstitutions` value
   * lands in (go-to-k/cdkd#5332). {@link canonicalizeDriftProperties} folds the
   * map into `Definition`, and the readback carries the substituted definition
   * too, so a secret proven at `DefinitionSubstitutions.<name>` is compared at
   * every `Definition` leaf whose template text holds `${name}`. Those leaves are
   * returned (an array's path when the leaf sits inside one, since drift
   * compares arrays whole). When the template body cannot be walked — a
   * `DefinitionS3Location` body, or a `DefinitionString` that is not JSON until
   * substituted (a bare numeric `${name}`) — the whole `Definition` is returned:
   * over-masking is the safe direction.
   */
  getDriftSecretPathAliases(
    _resourceType: string,
    properties: Record<string, unknown>,
    secretPaths: ReadonlySet<string>
  ): string[] {
    const substitutions = properties['DefinitionSubstitutions'];
    if (
      substitutions === null ||
      typeof substitutions !== 'object' ||
      Array.isArray(substitutions)
    ) {
      return [];
    }
    const secretNames = Object.keys(substitutions).filter(
      (name) =>
        secretPaths.has('DefinitionSubstitutions') ||
        [...secretPaths].some(
          (p) =>
            p === `DefinitionSubstitutions.${name}` ||
            p.startsWith(`DefinitionSubstitutions.${name}.`)
        )
    );
    if (secretNames.length === 0) return [];

    const definitionString = properties['DefinitionString'];
    const raw = definitionString !== undefined ? definitionString : properties['Definition'];
    let body: unknown = raw;
    if (typeof raw === 'string') {
      try {
        body = JSON.parse(raw) as unknown;
      } catch {
        return ['Definition'];
      }
    }
    if (body === undefined || body === null || typeof body !== 'object') return ['Definition'];

    const tokens = secretNames.map((name) => `\${${name}}`);
    const carries = (text: string): boolean => tokens.some((t) => text.includes(t));
    const aliases: string[] = [];
    const walk = (value: unknown, path: string, arrayPath: string | undefined): void => {
      if (typeof value === 'string') {
        if (carries(value)) aliases.push(arrayPath ?? path);
        return;
      }
      if (Array.isArray(value)) {
        value.forEach((item, i) => walk(item, `${path}.${i}`, arrayPath ?? path));
        return;
      }
      if (value !== null && typeof value === 'object') {
        for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
          // A placeholder in a KEY moves the secret into the path itself; mask
          // the enclosing object (the path text is the value scan's job).
          if (carries(key)) aliases.push(arrayPath ?? path);
          walk(child, `${path}.${key}`, arrayPath);
        }
      }
    };
    walk(body, 'Definition', undefined);
    return [...new Set(aliases)];
  }

  readCurrentState(
    physicalId: string,
    _logicalId: string,
    _resourceType: string
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    return readCurrentState.call(this, physicalId, _logicalId, _resourceType);
  }

  /**
   * Adopt an existing Step Functions state machine into cdkd state.
   *
   * Lookup order:
   *  1. `--resource <id>=<arn>` override → verify with `DescribeStateMachine`.
   *
   * SFN state machines do not expose a template-supplied name field
   * usable as a stable physicalId — the physicalId is the ARN — so the
   * fallback to `Properties.<NameField>` in `resolveExplicitPhysicalId`
   * is skipped here.
   */
  /** go-to-k/cdkd#4705: the name `create()` sends when the template names none. */
  generatedCreateName(
    _resourceType: string,
    logicalId: string,
    properties: Record<string, unknown>
  ): string | undefined {
    if (properties['StateMachineName']) return undefined;
    return generatedNameFor('AWS::StepFunctions::StateMachine', logicalId);
  }

  /**
   * go-to-k/cdkd#4705: the state machine's `creationDate` (epoch ms), so a
   * kept one licenses only a holder created no later than it was kept.
   */
  async holderCreatedAt(_resourceType: string, physicalId: string): Promise<number | undefined> {
    const resp = await this.getClient().send(
      new DescribeStateMachineCommand({ stateMachineArn: physicalId })
    );
    return resp.creationDate instanceof Date ? resp.creationDate.getTime() : undefined;
  }

  import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    return importImpl.call(this, input);
  }

  applyTagDiff(
    stateMachineArn: string,
    resourceType: string,
    logicalId: string,
    oldTagsRaw: unknown,
    newTagsRaw: unknown
  ): Promise<void> {
    return applyTagDiff.call(
      this,
      stateMachineArn,
      resourceType,
      logicalId,
      oldTagsRaw,
      newTagsRaw
    );
  }

  /**
   * Build the state-machine definition string from CDK properties.
   *
   * Precedence (mirrors CloudFormation): an inline `DefinitionString` /
   * `Definition` wins over `DefinitionS3Location`.
   *
   * `DefinitionSubstitutions` is applied to EVERY form, inline included
   * (go-to-k/cdkd#5298). aws-cdk-lib's `StateMachine` emits the body as
   * `DefinitionString` and the map as a separate `DefinitionSubstitutions`
   * property — it is NOT folded into an `Fn::Sub` — and SAM's
   * `AWS::Serverless::StateMachine` transform emits the same pair, so the
   * `${name}` placeholders in an inline body reach cdkd as plain text that the
   * intrinsic resolver leaves alone (it substitutes only inside `Fn::Sub`).
   * CloudFormation applies the map to the inline forms too; returning the body
   * verbatim deployed a state machine holding literal `${name}` placeholders.
   *
   * `DefinitionS3Location` ({@link https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-properties-stepfunctions-statemachine-s3location.html S3Location})
   * has no SDK `CreateStateMachine` field — CloudFormation reads the S3 object
   * and inlines its contents as the `definition`. cdkd does the same: fetch
   * the object body, then apply `DefinitionSubstitutions` like any other body.
   */
  async buildDefinitionString(properties: Record<string, unknown>): Promise<string> {
    const inline = inlineDefinitionBody(properties);
    if (inline !== undefined) return inline;

    const substitutions = properties['DefinitionSubstitutions'];
    const s3Location = properties['DefinitionS3Location'] as
      | { Bucket?: string; Key?: string; Version?: string }
      | undefined;
    if (s3Location?.Bucket && s3Location.Key) {
      const body = await this.fetchDefinitionFromS3(
        s3Location.Bucket,
        s3Location.Key,
        s3Location.Version
      );
      return applyDefinitionSubstitutions(body, substitutions);
    }

    // Empty definition - SFN API will reject this, but let it through
    // for consistent error reporting from the API
    return '{}';
  }

  /**
   * Fetch a state-machine definition (Amazon States Language JSON/YAML) from
   * S3 and return its body as a UTF-8 string. Honors an optional object
   * version for versioning-enabled buckets.
   */
  private async fetchDefinitionFromS3(
    bucket: string,
    key: string,
    version?: string
  ): Promise<string> {
    this.logger.debug(
      `Fetching state-machine definition from s3://${bucket}/${key}${version ? `?versionId=${version}` : ''}`
    );
    const resp = await this.getS3Client().send(
      new GetObjectCommand({ Bucket: bucket, Key: key, ...(version && { VersionId: version }) })
    );
    if (!resp.Body) {
      throw new Error(`DefinitionS3Location object s3://${bucket}/${key} returned no body`);
    }
    const body = await resp.Body.transformToString();
    if (body.length === 0) {
      // A zero-byte object has a present Body whose transformToString() is ''.
      // Fail here with a clear message rather than send '' to CreateStateMachine
      // (which AWS rejects with a generic validation error).
      throw new Error(`DefinitionS3Location object s3://${bucket}/${key} returned an empty body`);
    }
    return body;
  }
}

/**
 * Apply CloudFormation `DefinitionSubstitutions` (a `{ name: value }` map) to
 * a definition body by replacing each `${name}` token with its value.
 * Returns the body unchanged when no substitutions are supplied.
 *
 * One pass over the body: an inserted value is never re-scanned, so a value
 * that itself contains `${OtherName}` stays literal and the result does not
 * depend on the map's key order. A token whose name is not an own key of the
 * map is left untouched. The name excludes `{` as well as `}`, so a stray
 * unclosed `${` in the body cannot swallow the next real token.
 */
export function applyDefinitionSubstitutions(body: string, substitutions: unknown): string {
  if (substitutions === null || typeof substitutions !== 'object' || Array.isArray(substitutions)) {
    return body;
  }
  const map = substitutions as Record<string, unknown>;
  return body.replace(/\$\{([^{}]+)\}/g, (token, name: string) => {
    if (!Object.hasOwn(map, name)) return token;
    const value = map[name];
    // Substitution values are scalars (cdkd's intrinsic resolver has already
    // resolved any intrinsic in them, as CFn does before substituting).
    // Coerce to string; objects/arrays are not valid substitution values, so
    // skip them rather than emit "[object Object]".
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      return token;
    }
    return String(value);
  });
}

/**
 * The definition text an INLINE `DefinitionString` / `Definition` (string or
 * object) puts on the wire, with `DefinitionSubstitutions` applied
 * (go-to-k/cdkd#5298). `DefinitionString` wins over `Definition`, as in
 * CloudFormation. `undefined` when neither inline form is present (the
 * `DefinitionS3Location` form, which needs an S3 read). `substitutionsOverride`
 * replaces the recorded map (the drift fold's masked-value sentinel). Pure.
 */
export function inlineDefinitionBody(
  properties: Record<string, unknown>,
  substitutionsOverride?: Record<string, unknown>
): string | undefined {
  const substitutions = substitutionsOverride ?? properties['DefinitionSubstitutions'];
  const definitionString = properties['DefinitionString'];
  const definition = properties['Definition'];
  const value = definitionString !== undefined ? definitionString : definition;
  if (value === undefined) return undefined;
  const body = typeof value === 'string' ? value : JSON.stringify(value);
  return applyDefinitionSubstitutions(body, substitutions);
}

/** Stands in for a masked substitution value inside the folded body. */
const MASKED_SUBSTITUTION_SENTINEL = '\u{E000}cdkd-masked-substitution\u{E000}';

/**
 * Replace every string leaf carrying {@link MASKED_SUBSTITUTION_SENTINEL} with
 * the WHOLE {@link SECRET_MASK}, and every object whose KEY carries it with the
 * mask too. A body that is still a string (it did not parse) and carries the
 * sentinel becomes the mask outright. Pure; builds a new tree.
 */
function maskSentinelLeaves(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.includes(MASKED_SUBSTITUTION_SENTINEL) ? SECRET_MASK : value;
  }
  if (Array.isArray(value)) return value.map((item) => maskSentinelLeaves(item));
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.some(([key]) => key.includes(MASKED_SUBSTITUTION_SENTINEL))) return SECRET_MASK;
    return Object.fromEntries(entries.map(([key, child]) => [key, maskSentinelLeaves(child)]));
  }
  return value;
}
