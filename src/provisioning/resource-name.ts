import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';

/**
 * Per-async-context stack name. Resource-name generation reads this so that
 * concurrent deploys (`cdkd deploy --all` runs stacks in parallel up to
 * `--stack-concurrency`) don't fight over a single shared variable.
 *
 * History: this was `let currentStackName: string | undefined` until
 * 2026-05-01. Two parallel `deploy()` calls would each call
 * `setCurrentStackName(...)` and the second would overwrite the first;
 * any IAM Role / SQS Queue / etc. created by the first stack while the
 * second was active would get the second stack's prefix in its physical
 * name, then the second stack's own create attempt for the same logical
 * id would collide ("Role with name X already exists"). Switching to
 * `AsyncLocalStorage` scopes the value to each deploy's async chain.
 */
const stackNameStore = new AsyncLocalStorage<string>();

/**
 * Run `fn` with `stackName` set as the stack name visible to
 * `generateResourceName` for the duration of the callback (and any
 * `await`s inside). Concurrent invocations each get an independent scope
 * — this is the safe API for parallel deploys.
 */
export function withStackName<T>(stackName: string, fn: () => Promise<T>): Promise<T>;
export function withStackName<T>(stackName: string, fn: () => T): T;
export function withStackName<T>(stackName: string, fn: () => T | Promise<T>): T | Promise<T> {
  return stackNameStore.run(stackName, fn);
}

/**
 * Read the current async context's stack name, if any.
 *
 * Returns `undefined` outside any `withStackName` / `setCurrentStackName`
 * scope. Used by the live renderer to scope per-stack in-flight task
 * entries so concurrent deploys don't clobber each other's tasks (same
 * `logicalId` in two stacks would collide on the singleton renderer's
 * task Map without this).
 */
export function getCurrentStackName(): string | undefined {
  return stackNameStore.getStore();
}

/**
 * Set the current async context's stack name.
 *
 * @deprecated Use {@link withStackName} for new code — it makes the scope
 *   obvious at the call site. This setter now uses
 *   `AsyncLocalStorage.enterWith` so it remains safe under
 *   `--stack-concurrency > 1` (each `deploy()` call has its own async
 *   resource, so the value does NOT leak across siblings), but
 *   `withStackName` is structurally clearer.
 */
export function setCurrentStackName(stackName: string): void {
  stackNameStore.enterWith(stackName);
}

/**
 * Per-async-context "skip the stack-name prefix on user-supplied physical
 * names" flag. Read by `generateResourceName` when its caller passes
 * `userSupplied: true`; auto-generated-name paths
 * (`generateResourceName(logicalId, ...)`) ignore this flag.
 *
 * Scoped via AsyncLocalStorage so that `--stack-concurrency > 1` runs
 * cannot cross-contaminate — each deploy's body is wrapped in its own
 * `withSkipPrefix(...)` scope (the deploy CLI plumbs the resolved
 * `--no-prefix-user-supplied-names` value through here). Default
 * `false` preserves pre-PR behavior when the flag is not set.
 */
const skipPrefixStore = new AsyncLocalStorage<boolean>();

/**
 * Run `fn` with the "skip prefix on user-supplied names" flag set to
 * `skip`. Mirrors {@link withStackName} — concurrent invocations each
 * get an independent scope so parallel deploys do not fight over a
 * single shared variable.
 *
 * Wrap this around `withStackName(...)` (innermost is `fn`) in the
 * deploy CLI: `withSkipPrefix(flag, () => withStackName(name, body))`.
 * Order does not matter — the two stores are independent — but
 * consistent ordering keeps the call sites readable.
 */
export function withSkipPrefix<T>(skip: boolean, fn: () => Promise<T>): Promise<T>;
export function withSkipPrefix<T>(skip: boolean, fn: () => T): T;
export function withSkipPrefix<T>(skip: boolean, fn: () => T | Promise<T>): T | Promise<T> {
  return skipPrefixStore.run(skip, fn);
}

/**
 * Read the current async context's skip-prefix flag. Defaults to
 * `false` when no `withSkipPrefix` scope is active.
 *
 * Public for unit tests; `generateResourceName` consumes this
 * internally.
 */
export function getCurrentSkipPrefix(): boolean {
  return skipPrefixStore.getStore() ?? false;
}

/**
 * Options for generating a resource name.
 */
export interface ResourceNameOptions {
  /** Maximum length for the name (e.g., 32 for ALB/TG, 64 for IAM, 63 for S3) */
  maxLength: number;
  /** Whether to force lowercase (e.g., S3 buckets) */
  lowercase?: boolean;
  /** Allowed character regex pattern. Characters not matching will be removed.
   *  Default: /[^a-zA-Z0-9-]/ (alphanumeric + hyphen) */
  allowedPattern?: RegExp;
  /**
   * `true` when the caller is passing a name the user explicitly
   * declared in their CDK code (e.g. `new iam.Role(this, 'X', {
   *   roleName: 'my-role' })`). `false` (default) when the caller is
   * passing the logical-id fallback or any other cdkd-generated value.
   *
   * Combined with the per-deploy `withSkipPrefix(true)` flag, a
   * `userSupplied: true` call skips the stack-name prefix and returns
   * the user's declared name verbatim (after the same sanitize /
   * truncate pipeline). When `userSupplied` is `false` OR
   * `withSkipPrefix` is unset / `false`, the stack-name prefix is
   * applied (pre-PR behavior).
   *
   * This split is load-bearing: cdkd's stack-scoping concern (prefix
   * for cross-stack uniqueness on auto-generated names) must stay
   * coupled to the auto-generated path, NOT to user-declared names —
   * those belong to the user.
   */
  userSupplied?: boolean;
}

/**
 * Generate a unique resource name from the logical ID.
 *
 * Generates names in CloudFormation-compatible format:
 * `{StackName}-{LogicalId}-{Hash}` (truncated to maxLength).
 *
 * @param name The raw name (from properties or logicalId fallback)
 * @param options Length and character constraints
 * @returns A sanitized, truncated name that fits the constraints
 */
export function generateResourceName(name: string, options: ResourceNameOptions): string {
  const {
    maxLength,
    lowercase = false,
    allowedPattern = /[^a-zA-Z0-9-]/g,
    userSupplied = false,
  } = options;

  // Include stack name for uniqueness (like CloudFormation does).
  //
  // The prefix is suppressed when the caller marked the name as
  // user-supplied AND the per-deploy `withSkipPrefix(true)` flag is
  // active — the user owns that name and cdkd should not rewrite it.
  // Every other path (logical-id fallback, no withSkipPrefix scope,
  // flag set to false) keeps the prefix for cross-stack uniqueness.
  const currentStackName = stackNameStore.getStore();
  const shouldPrefix = currentStackName && !(userSupplied && getCurrentSkipPrefix());
  const fullName = shouldPrefix ? `${currentStackName}-${name}` : name;

  // Apply lowercase BEFORE pattern matching (so A-Z aren't removed by /[^a-z0-9.-]/)
  let sanitized = lowercase ? fullName.toLowerCase() : fullName;
  sanitized = sanitized.replace(allowedPattern, '-');

  // Collapse consecutive hyphens and remove leading/trailing
  sanitized = sanitized.replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '');

  if (sanitized.length <= maxLength) {
    return sanitized;
  }

  // Truncate with hash suffix for uniqueness
  const hash = createHash('sha256').update(fullName).digest('hex').substring(0, 8);
  const maxPrefixLength = maxLength - hash.length - 1; // -1 for separator
  const prefix = sanitized.substring(0, maxPrefixLength).replace(/-+$/, '');

  return `${prefix}-${hash}`;
}

/**
 * Generate a resource name from a user-declared physical name OR
 * fall back to the logical id.
 *
 * Wraps {@link generateResourceName} to express the Pattern B call-site
 * shape (`generateResourceName((properties['Name'] as string | undefined)
 * || logicalId, opts)`) as a single typed helper. The user-supplied
 * branch passes `userSupplied: true`, which makes the per-deploy
 * `withSkipPrefix(true)` flag drop the stack-name prefix on that name.
 * The fallback (logical-id) branch is `userSupplied: false` and keeps
 * the prefix regardless of the flag — auto-generated names rely on
 * the prefix for cross-stack uniqueness.
 *
 * Use at every Pattern B provider call site (currently IAM Role, IAM
 * User, IAM Group, IAM InstanceProfile, ELBv2 LoadBalancer, ELBv2
 * TargetGroup) so the `--no-prefix-user-supplied-names` flag controls
 * those types consistently. Pattern A providers (Lambda, S3, SNS,
 * SQS, DynamoDB, etc.) do NOT need this helper — they already
 * short-circuit the user-supplied name out of the
 * `generateResourceName` call entirely, so the prefix is never
 * applied to user-supplied names regardless of the flag.
 */
export function generateResourceNameWithFallback(
  userSuppliedName: string | undefined,
  logicalId: string,
  options: Omit<ResourceNameOptions, 'userSupplied'>
): string {
  if (userSuppliedName !== undefined && userSuppliedName !== '') {
    return generateResourceName(userSuppliedName, { ...options, userSupplied: true });
  }
  return generateResourceName(logicalId, { ...options, userSupplied: false });
}

/**
 * Default name generation rules for CC API fallback.
 *
 * When an SDK provider falls back to CC API, the resource may need a
 * default name that the SDK provider would have generated. This map
 * defines the name property and generation options for each resource type.
 *
 * Format: resourceType → { nameProperty, options, postProcess? }
 */
const FALLBACK_NAME_RULES: Record<
  string,
  {
    nameProperty: string;
    options: ResourceNameOptions;
  }
> = {
  'AWS::S3::Bucket': { nameProperty: 'BucketName', options: { maxLength: 63, lowercase: true } },
  'AWS::SQS::Queue': { nameProperty: 'QueueName', options: { maxLength: 80 } },
  'AWS::SNS::Topic': { nameProperty: 'TopicName', options: { maxLength: 256 } },
  'AWS::Lambda::Function': { nameProperty: 'FunctionName', options: { maxLength: 64 } },
  'AWS::Lambda::LayerVersion': { nameProperty: 'LayerName', options: { maxLength: 64 } },
  'AWS::IAM::Role': { nameProperty: 'RoleName', options: { maxLength: 64 } },
  'AWS::IAM::Policy': { nameProperty: 'PolicyName', options: { maxLength: 64 } },
  'AWS::IAM::User': { nameProperty: 'UserName', options: { maxLength: 64 } },
  'AWS::IAM::Group': { nameProperty: 'GroupName', options: { maxLength: 128 } },
  'AWS::IAM::InstanceProfile': {
    nameProperty: 'InstanceProfileName',
    options: { maxLength: 128 },
  },
  'AWS::DynamoDB::Table': { nameProperty: 'TableName', options: { maxLength: 255 } },
  'AWS::ECR::Repository': {
    nameProperty: 'RepositoryName',
    options: { maxLength: 256, lowercase: true },
  },
  'AWS::ECS::Cluster': { nameProperty: 'ClusterName', options: { maxLength: 255 } },
  'AWS::ECS::Service': { nameProperty: 'ServiceName', options: { maxLength: 255 } },
  'AWS::Logs::LogGroup': { nameProperty: 'LogGroupName', options: { maxLength: 512 } },
  'AWS::CloudWatch::Alarm': { nameProperty: 'AlarmName', options: { maxLength: 256 } },
  'AWS::Events::Rule': { nameProperty: 'Name', options: { maxLength: 64 } },
  'AWS::Events::EventBus': { nameProperty: 'Name', options: { maxLength: 256 } },
  'AWS::Kinesis::Stream': { nameProperty: 'Name', options: { maxLength: 128 } },
  'AWS::StepFunctions::StateMachine': {
    nameProperty: 'StateMachineName',
    options: { maxLength: 80 },
  },
  'AWS::SecretsManager::Secret': {
    nameProperty: 'Name',
    options: { maxLength: 512, allowedPattern: /[^a-zA-Z0-9-/_]/g },
  },
  'AWS::SSM::Parameter': { nameProperty: 'Name', options: { maxLength: 2048 } },
  'AWS::Cognito::UserPool': { nameProperty: 'UserPoolName', options: { maxLength: 128 } },
  'AWS::ElastiCache::SubnetGroup': {
    nameProperty: 'CacheSubnetGroupName',
    options: { maxLength: 255, lowercase: true },
  },
  'AWS::ElastiCache::CacheCluster': {
    nameProperty: 'ClusterName',
    options: { maxLength: 40, lowercase: true },
  },
  'AWS::RDS::DBSubnetGroup': {
    nameProperty: 'DBSubnetGroupName',
    options: { maxLength: 255, lowercase: true },
  },
  'AWS::RDS::DBCluster': {
    nameProperty: 'DBClusterIdentifier',
    options: { maxLength: 63, lowercase: true },
  },
  'AWS::RDS::DBInstance': {
    nameProperty: 'DBInstanceIdentifier',
    options: { maxLength: 63, lowercase: true },
  },
  // DocumentDB — RDS-shaped API; same name constraints.
  'AWS::DocDB::DBSubnetGroup': {
    nameProperty: 'DBSubnetGroupName',
    options: { maxLength: 255, lowercase: true },
  },
  'AWS::DocDB::DBCluster': {
    nameProperty: 'DBClusterIdentifier',
    options: { maxLength: 63, lowercase: true },
  },
  'AWS::DocDB::DBInstance': {
    nameProperty: 'DBInstanceIdentifier',
    options: { maxLength: 63, lowercase: true },
  },
  // Neptune — RDS-shaped API; same name constraints.
  'AWS::Neptune::DBSubnetGroup': {
    nameProperty: 'DBSubnetGroupName',
    options: { maxLength: 255, lowercase: true },
  },
  'AWS::Neptune::DBCluster': {
    nameProperty: 'DBClusterIdentifier',
    options: { maxLength: 63, lowercase: true },
  },
  'AWS::Neptune::DBInstance': {
    nameProperty: 'DBInstanceIdentifier',
    options: { maxLength: 63, lowercase: true },
  },
  'AWS::ElasticLoadBalancingV2::LoadBalancer': {
    nameProperty: 'Name',
    options: { maxLength: 32 },
  },
  'AWS::ElasticLoadBalancingV2::TargetGroup': {
    nameProperty: 'Name',
    options: { maxLength: 32 },
  },
  'AWS::WAFv2::WebACL': { nameProperty: 'Name', options: { maxLength: 128 } },
  'AWS::CodeBuild::Project': { nameProperty: 'Name', options: { maxLength: 255 } },
  'AWS::S3Express::DirectoryBucket': {
    nameProperty: 'BucketName',
    options: { maxLength: 63, lowercase: true },
  },
};

/**
 * Apply default name generation for CC API fallback.
 *
 * When a resource doesn't have an explicit name property set,
 * generates the same default name that the SDK provider would have created.
 * This ensures consistent naming regardless of whether SDK or CC API handles the resource.
 *
 * @param logicalId Logical ID from the template
 * @param resourceType CloudFormation resource type
 * @param properties Resource properties (will not be mutated)
 * @returns Properties with default name applied if needed, or original properties if no rule exists
 */
export function applyDefaultNameForFallback(
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>
): Record<string, unknown> {
  const rule = FALLBACK_NAME_RULES[resourceType];
  if (!rule) return properties;

  // If the name property is already set, no need to generate
  if (properties[rule.nameProperty]) return properties;

  const generatedName = generateResourceName(logicalId, rule.options);

  return {
    ...properties,
    [rule.nameProperty]: generatedName,
  };
}
