import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import { getLogger } from '../utils/logger.js';

/**
 * Resolve `ContainerDefinitions[].Secrets[].ValueFrom` references to real
 * values via the AWS SDK so containers can be started with the secret
 * material injected as plain env vars.
 *
 * Same resolution rules as the ECS Agent: `valueFrom` is either a
 * Secrets Manager secret ARN (optionally with a `:<json-key>::` suffix for
 * key extraction from a JSON blob) or an SSM Parameter ARN. Resolution
 * happens once at startup, before any container boots — partial resolution
 * is meaningless because a "missing" secret would otherwise look like a
 * literal empty string and break the container silently.
 *
 * Failure mode is hard-fail. Mirrors `cdkd local invoke --from-state`'s
 * philosophy: explicit failure beats silently-empty. The user fixes their
 * AWS creds / IAM policy / parameter name and re-runs.
 */

export class EcsSecretsResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EcsSecretsResolutionError';
    Object.setPrototypeOf(this, EcsSecretsResolutionError.prototype);
  }
}

export interface SecretEntry {
  /** Container name (only used to thread richer error messages). */
  containerName: string;
  /** Env var name the resolved value lands at. */
  name: string;
  /** Raw ValueFrom (Secrets Manager ARN or SSM Parameter ARN). */
  valueFrom: string;
}

/**
 * Result of secret resolution: each entry maps to the container that
 * requested it plus the resolved value. Returned as a flat list (not
 * grouped) so the caller can populate per-container env maps in one pass.
 */
export interface ResolvedSecret extends SecretEntry {
  value: string;
}

export interface ResolveEcsSecretsOptions {
  /** Region for the AWS SDK clients. Falls back to env defaults when unset. */
  region?: string;
  /**
   * Hook for tests: supply pre-built SDK clients. Production callers
   * leave both unset and let the resolver construct + destroy its own
   * clients.
   */
  secretsManagerClient?: SecretsManagerClient;
  ssmClient?: SSMClient;
}

/**
 * Resolve every secret entry in parallel. Returns successfully only when
 * every entry resolved — a single failure aborts the whole batch with the
 * offending container + secret name in the error message.
 */
export async function resolveEcsSecrets(
  entries: SecretEntry[],
  options: ResolveEcsSecretsOptions = {}
): Promise<ResolvedSecret[]> {
  if (entries.length === 0) return [];
  const logger = getLogger().child('ecs-secrets');

  const secretsClient =
    options.secretsManagerClient ??
    new SecretsManagerClient({ ...(options.region && { region: options.region }) });
  const ssmClient =
    options.ssmClient ?? new SSMClient({ ...(options.region && { region: options.region }) });
  const ownsSecretsClient = options.secretsManagerClient === undefined;
  const ownsSsmClient = options.ssmClient === undefined;

  try {
    const results = await Promise.all(
      entries.map(async (entry) => {
        const value = await resolveOne(entry, secretsClient, ssmClient);
        logger.debug(`Resolved secret ${entry.containerName}.${entry.name} (${entry.valueFrom})`);
        return { ...entry, value };
      })
    );
    return results;
  } finally {
    if (ownsSecretsClient) secretsClient.destroy();
    if (ownsSsmClient) ssmClient.destroy();
  }
}

async function resolveOne(
  entry: SecretEntry,
  secretsClient: SecretsManagerClient,
  ssmClient: SSMClient
): Promise<string> {
  const arn = entry.valueFrom;
  const shape = classifySecretArn(arn);
  switch (shape.kind) {
    case 'secrets-manager':
      return resolveSecretsManager(entry, shape, secretsClient);
    case 'ssm':
      return resolveSsm(entry, shape, ssmClient);
    case 'unknown':
      throw new EcsSecretsResolutionError(
        `Container '${entry.containerName}' secret '${entry.name}' references an unsupported ValueFrom shape '${arn}'. ` +
          'Expected Secrets Manager ARN (optionally with :<json-key>::) or SSM Parameter ARN.'
      );
  }
}

interface SecretsManagerShape {
  kind: 'secrets-manager';
  /** Full ARN minus the optional `:<json-key>::` suffix. */
  baseArn: string;
  /** When set, extract this top-level key from the JSON-decoded SecretString. */
  jsonKey?: string;
}

interface SsmShape {
  kind: 'ssm';
  /** Parameter name (with leading `/`). */
  name: string;
}

interface UnknownShape {
  kind: 'unknown';
}

/**
 * Classify the `ValueFrom` string per the AWS ECS Agent rules. Three
 * accepted shapes:
 *   - `arn:aws:secretsmanager:<region>:<account>:secret:<name>`
 *   - `arn:aws:secretsmanager:<region>:<account>:secret:<name>:<json-key>::`
 *   - `arn:aws:ssm:<region>:<account>:parameter/<name>`
 */
export function classifySecretArn(arn: string): SecretsManagerShape | SsmShape | UnknownShape {
  if (!arn.startsWith('arn:')) return { kind: 'unknown' };

  // Secrets Manager: 7 colon-delimited segments minimum
  // (arn:aws:secretsmanager:region:account:secret:name). The optional
  // json-key suffix appends `:<json-key>::` — exactly two trailing colons
  // because the SecretsManager ARN convention reserves `version-stage`
  // and `version-id` slots that follow.
  const smMatch = /^(arn:[^:]+:secretsmanager:[^:]+:\d+:secret:[^:]+)(?::([^:]+)::?)?$/.exec(arn);
  if (smMatch) {
    const out: SecretsManagerShape = { kind: 'secrets-manager', baseArn: smMatch[1]! };
    if (smMatch[2]) out.jsonKey = smMatch[2];
    return out;
  }

  const ssmMatch = /^arn:[^:]+:ssm:[^:]+:\d+:parameter(\/.+)$/.exec(arn);
  if (ssmMatch) {
    return { kind: 'ssm', name: ssmMatch[1]! };
  }

  return { kind: 'unknown' };
}

async function resolveSecretsManager(
  entry: SecretEntry,
  shape: SecretsManagerShape,
  client: SecretsManagerClient
): Promise<string> {
  let secretString: string | undefined;
  try {
    const resp = await client.send(new GetSecretValueCommand({ SecretId: shape.baseArn }));
    secretString = resp.SecretString;
  } catch (err) {
    throw new EcsSecretsResolutionError(
      `Failed to resolve Secrets Manager secret for container '${entry.containerName}' / env '${entry.name}' (${shape.baseArn}): ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
  if (secretString === undefined) {
    throw new EcsSecretsResolutionError(
      `Secrets Manager returned no SecretString for container '${entry.containerName}' / env '${entry.name}' (${shape.baseArn}). ` +
        'Binary secrets are not supported.'
    );
  }
  if (shape.jsonKey === undefined) return secretString;

  let parsed: unknown;
  try {
    parsed = JSON.parse(secretString);
  } catch (err) {
    throw new EcsSecretsResolutionError(
      `Container '${entry.containerName}' secret '${entry.name}' specified json-key '${shape.jsonKey}' but the secret value is not valid JSON: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new EcsSecretsResolutionError(
      `Container '${entry.containerName}' secret '${entry.name}' specified json-key '${shape.jsonKey}' but the secret root is not a JSON object.`
    );
  }
  const value = (parsed as Record<string, unknown>)[shape.jsonKey];
  if (value === undefined) {
    throw new EcsSecretsResolutionError(
      `Container '${entry.containerName}' secret '${entry.name}' specified json-key '${shape.jsonKey}' but no such key exists in the secret JSON.`
    );
  }
  return typeof value === 'string' ? value : JSON.stringify(value);
}

async function resolveSsm(entry: SecretEntry, shape: SsmShape, client: SSMClient): Promise<string> {
  try {
    const resp = await client.send(
      new GetParameterCommand({ Name: shape.name, WithDecryption: true })
    );
    const value = resp.Parameter?.Value;
    if (value === undefined) {
      throw new EcsSecretsResolutionError(
        `SSM parameter '${shape.name}' returned no Value for container '${entry.containerName}' / env '${entry.name}'.`
      );
    }
    return value;
  } catch (err) {
    if (err instanceof EcsSecretsResolutionError) throw err;
    throw new EcsSecretsResolutionError(
      `Failed to resolve SSM parameter for container '${entry.containerName}' / env '${entry.name}' (${shape.name}): ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
}
