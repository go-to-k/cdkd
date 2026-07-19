# cdkd Provider Development Guide

## Overview

In cdkd, AWS resource provisioning is implemented through an abstraction layer called **Provider**. SDK Providers are preferred for performance — they make direct synchronous API calls with no polling overhead. Cloud Control API serves as a fallback for resource types without an SDK Provider (requires async polling).

Adding SDK Providers for frequently used resource types is one of the most impactful performance improvements. This guide explains how to add new providers.

## Provider Interface

All providers implement the `ResourceProvider` interface.

### Definition (`src/types/resource.ts`)

```typescript
export interface ResourceProvider {
  /**
   * Create a new resource
   *
   * @param logicalId CloudFormation logical ID
   * @param resourceType CloudFormation resource type (e.g., "AWS::S3::Bucket")
   * @param properties Resource properties from template
   * @returns Physical ID and attributes
   */
  create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult>;

  /**
   * Update an existing resource
   *
   * @param logicalId CloudFormation logical ID
   * @param physicalId AWS physical ID (from state)
   * @param resourceType CloudFormation resource type
   * @param properties New properties
   * @param previousProperties Old properties
   * @returns Physical ID (may change if replaced) and attributes
   */
  update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult>;

  /**
   * Delete a resource
   *
   * @param logicalId CloudFormation logical ID
   * @param physicalId AWS physical ID
   * @param resourceType CloudFormation resource type
   * @param properties Resource properties (optional, for cleanup logic)
   * @param context Delete-time context (optional). `context.expectedRegion`
   *   is the region recorded in the stack state when the resource was
   *   created. Providers MUST verify the AWS client's region against
   *   `context.expectedRegion` before treating a `*NotFound` error as
   *   idempotent delete success — see the "DELETE idempotency" section
   *   below.
   */
  delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void>;

  /**
   * Adopt an existing AWS resource into cdkd state.
   *
   * Optional. Providers without an `import` implementation are reported
   * by `cdkd import` as `unsupported` and skipped (Cloud Control API
   * fallback handles them via `--resource <id>=<physicalId>` overrides).
   *
   * @param input Logical ID, resource type, CDK path, stack name, region,
   *   template properties, and (optionally) the user-supplied
   *   `knownPhysicalId` from `--resource` / `--resource-mapping`.
   * @returns Physical ID + attributes (same shape as `create` returns),
   *   or `null` when no matching AWS resource was found (caller treats
   *   `null` as "skipped — not deployed yet", not as a failure).
   */
  import?(input: ResourceImportInput): Promise<ResourceImportResult | null>;
}
```

### Return Types

```typescript
export interface ResourceCreateResult {
  physicalId: string                     // AWS physical ID
  attributes?: Record<string, unknown>   // Attributes for Fn::GetAtt
}

export interface ResourceUpdateResult {
  physicalId: string                     // Physical ID after update
  wasReplaced: boolean                   // Whether resource was replaced
  attributes?: Record<string, unknown>   // Attributes after update
}
```

## Provider Implementation Examples

### 1. Simple Example: S3 Bucket Policy Provider

S3 bucket policies benefit from an SDK Provider for fast, synchronous operations without CC API polling overhead.

#### File: `src/provisioning/providers/s3-bucket-policy-provider.ts`

```typescript
import {
  S3Client,
  PutBucketPolicyCommand,
  GetBucketPolicyCommand,
  DeleteBucketPolicyCommand,
  NoSuchBucketPolicy,
} from '@aws-sdk/client-s3';
import { getLogger } from '../../utils/logger.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
} from '../../types/resource.js';

export class S3BucketPolicyProvider implements ResourceProvider {
  private s3Client: S3Client;
  private logger = getLogger().child('S3BucketPolicyProvider');

  constructor() {
    const awsClients = getAwsClients();
    this.s3Client = awsClients.s3;
  }

  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.info(`Creating S3 bucket policy ${logicalId}`);

    const bucket = properties['Bucket'] as string;
    const policyDocument = properties['PolicyDocument'];

    if (!bucket || !policyDocument) {
      throw new ProvisioningError(
        `Bucket and PolicyDocument are required for ${logicalId}`,
        resourceType,
        logicalId
      );
    }

    try {
      const policy =
        typeof policyDocument === 'string'
          ? policyDocument
          : JSON.stringify(policyDocument);

      await this.s3Client.send(
        new PutBucketPolicyCommand({
          Bucket: bucket,
          Policy: policy,
        })
      );

      this.logger.info(`Successfully created S3 bucket policy ${logicalId}`);

      // Physical ID is bucket name
      return {
        physicalId: bucket,
      };
    } catch (error) {
      throw new ProvisioningError(
        `Failed to create S3 bucket policy ${logicalId}: ${String(error)}`,
        resourceType,
        logicalId,
        bucket,
        error instanceof Error ? error : undefined
      );
    }
  }

  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.info(`Updating S3 bucket policy ${logicalId}`);

    const newBucket = properties['Bucket'] as string;
    const oldBucket = previousProperties['Bucket'] as string;

    // Replace if bucket name changed
    if (newBucket !== oldBucket) {
      this.logger.info(`Bucket changed, replacing policy: ${oldBucket} -> ${newBucket}`);

      // Create new policy
      const createResult = await this.create(logicalId, resourceType, properties);

      // Delete old policy
      try {
        await this.delete(logicalId, physicalId, resourceType, previousProperties);
      } catch (error) {
        this.logger.warn(`Failed to delete old policy: ${String(error)}`);
      }

      return {
        physicalId: createResult.physicalId,
        wasReplaced: true,
      };
    }

    // Update only policy document
    try {
      const policyDocument = properties['PolicyDocument'];
      const policy =
        typeof policyDocument === 'string'
          ? policyDocument
          : JSON.stringify(policyDocument);

      await this.s3Client.send(
        new PutBucketPolicyCommand({
          Bucket: newBucket,
          Policy: policy,
        })
      );

      this.logger.info(`Successfully updated S3 bucket policy ${logicalId}`);

      return {
        physicalId,
        wasReplaced: false,
      };
    } catch (error) {
      throw new ProvisioningError(
        `Failed to update S3 bucket policy ${logicalId}: ${String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        error instanceof Error ? error : undefined
      );
    }
  }

  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>
  ): Promise<void> {
    this.logger.info(`Deleting S3 bucket policy ${logicalId}`);

    try {
      // Check if policy exists
      try {
        await this.s3Client.send(
          new GetBucketPolicyCommand({
            Bucket: physicalId,
          })
        );
      } catch (error) {
        if (error instanceof NoSuchBucketPolicy) {
          this.logger.info(`Policy does not exist for bucket ${physicalId}, skipping`);
          return;
        }
        throw error;
      }

      // Delete policy
      await this.s3Client.send(
        new DeleteBucketPolicyCommand({
          Bucket: physicalId,
        })
      );

      this.logger.info(`Successfully deleted S3 bucket policy ${logicalId}`);
    } catch (error) {
      throw new ProvisioningError(
        `Failed to delete S3 bucket policy ${logicalId}: ${String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        error instanceof Error ? error : undefined
      );
    }
  }
}
```

### 2. Complex Example: IAM Role Provider

IAM Role requires the following features:

- Inline policies (`Policies`)
- Managed policy attachment (`ManagedPolicyArns`)
- Role name length limit (64 characters)

See `src/provisioning/providers/iam-role-provider.ts` for details.

**Key Points**:

1. **Create** sets inline policies and managed policies
2. **Update** calculates diff and adds/removes/updates
3. **Delete** deletes dependent resources (policies) first

```typescript
async update(...): Promise<ResourceUpdateResult> {
  // Replace if role name changed
  if (newRoleName !== physicalId) {
    const createResult = await this.create(logicalId, resourceType, properties);

    try {
      await this.delete(logicalId, physicalId, resourceType);
    } catch (error) {
      this.logger.warn(`Failed to delete old role: ${String(error)}`);
    }

    return {
      physicalId: createResult.physicalId,
      wasReplaced: true,
      attributes: createResult.attributes,
    };
  }

  // Update properties only
  await this.iamClient.send(new UpdateRoleCommand({ ... }));

  // Apply managed policies diff
  await this.updateManagedPolicies(physicalId, newPolicies, oldPolicies);

  // Apply inline policies diff
  await this.updateInlinePolicies(physicalId, newPolicies, oldPolicies);

  return {
    physicalId,
    wasReplaced: false,
    attributes: { ... },
  };
}
```

## Provider Registration

### Provider Registry (`src/provisioning/provider-registry.ts`)

```typescript
export class ProviderRegistry {
  private providers = new Map<string, ResourceProvider>();

  // Singleton instance
  private static instance: ProviderRegistry;

  static getInstance(): ProviderRegistry {
    if (!this.instance) {
      this.instance = new ProviderRegistry();
    }
    return this.instance;
  }

  /**
   * Register a provider
   */
  register(resourceType: string, provider: ResourceProvider): void {
    this.providers.set(resourceType, provider);
    this.logger.debug(`Registered provider for ${resourceType}`);
  }

  /**
   * Get a provider
   *
   * Returns registered SDK Provider if available (preferred for performance),
   * falls back to Cloud Control Provider for unregistered types
   */
  getProvider(resourceType: string): ResourceProvider {
    const provider = this.providers.get(resourceType);

    if (provider) {
      return provider;  // SDK Provider (fast, synchronous)
    }

    // Fallback to Cloud Control API (async polling)
    return this.cloudControlProvider;
  }
}
```

### Registration Location

Register in `src/provisioning/register-providers.ts`:

```typescript
import { ProviderRegistry } from './provider-registry.js';
import { IAMRoleProvider } from './providers/iam-role-provider.js';
// ... (see register-providers.ts for full list of provider imports)

export function registerAllProviders(): void {
  const registry = ProviderRegistry.getInstance();
  registry.register('AWS::IAM::Role', new IAMRoleProvider());
  registry.register('AWS::IAM::Policy', new IAMPolicyProvider());
  registry.register('AWS::S3::Bucket', new S3BucketProvider());
  // ... see register-providers.ts for all registrations

  // Multi-type providers share a single instance:
  const ec2Provider = new EC2Provider();
  registry.register('AWS::EC2::VPC', ec2Provider);
  registry.register('AWS::EC2::Subnet', ec2Provider);
  // ... (9 EC2 types total)

  // Wildcard matching for Custom::*
  // handled by ProviderRegistry.getProvider()
}
```

## Steps to Add a New Provider

### Step 1: Research Resource Type

Check if an SDK Provider already exists for the target resource type, and whether it would benefit from a dedicated provider:

- **Performance**: SDK Providers make direct synchronous API calls (no polling), significantly faster than CC API
- **CC API limitations**: Some resources are not supported or have bugs in Cloud Control API
- **Fine-grained control**: Some resources need special handling (e.g., IAM propagation retries, inline policies)

```bash
# Check if CC API supports the resource (for reference)
# https://docs.aws.amazon.com/cloudcontrolapi/latest/userguide/supported-resources.html
```

Adding an SDK Provider is recommended for **any frequently used resource type** to improve deployment speed.

### Step 2: Check AWS SDK Client

Identify the required AWS SDK v3 client:

| Resource Type | AWS SDK Client |
|---------------|----------------|
| `AWS::IAM::Role` | `IAMClient` from `@aws-sdk/client-iam` |
| `AWS::S3::BucketPolicy` | `S3Client` from `@aws-sdk/client-s3` |
| `AWS::Lambda::Function` | `LambdaClient` from `@aws-sdk/client-lambda` |
| `AWS::DynamoDB::Table` | `DynamoDBClient` from `@aws-sdk/client-dynamodb` |

### Step 3: Create Provider Class

#### File Naming Convention

`src/provisioning/providers/{service}-{resource}-provider.ts`

Examples:

- `iam-role-provider.ts`
- `s3-bucket-policy-provider.ts`
- `lambda-function-provider.ts`

#### Template

```typescript
import { /* AWS SDK imports */ } from '@aws-sdk/client-xxx';
import { getLogger } from '../../utils/logger.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
} from '../../types/resource.js';

export class XxxResourceProvider implements ResourceProvider {
  private client: XxxClient;
  private logger = getLogger().child('XxxResourceProvider');

  constructor() {
    const awsClients = getAwsClients();
    this.client = awsClients.xxx;  // Use shared client instance
  }

  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.info(`Creating ${resourceType} ${logicalId}`);

    try {
      // 1. Validate properties
      const requiredProp = properties['RequiredProp'] as string;
      if (!requiredProp) {
        throw new ProvisioningError(
          `RequiredProp is required for ${logicalId}`,
          resourceType,
          logicalId
        );
      }

      // 2. Create with AWS SDK
      const response = await this.client.send(
        new CreateXxxCommand({
          /* ... */
        })
      );

      // 3. Return physical ID and attributes
      const physicalId = response.XxxId || response.XxxArn;
      const attributes = {
        Arn: response.XxxArn,
        Id: response.XxxId,
        // Attributes accessible via Fn::GetAtt
      };

      this.logger.info(`Successfully created ${resourceType} ${logicalId}: ${physicalId}`);

      return {
        physicalId,
        attributes,
      };
    } catch (error) {
      throw new ProvisioningError(
        `Failed to create ${resourceType} ${logicalId}: ${String(error)}`,
        resourceType,
        logicalId,
        undefined,
        error instanceof Error ? error : undefined
      );
    }
  }

  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.info(`Updating ${resourceType} ${logicalId}: ${physicalId}`);

    try {
      // Check if replacement required due to property changes
      const requiresReplacement = this.checkReplacementRequired(
        properties,
        previousProperties
      );

      if (requiresReplacement) {
        this.logger.info(`Replacement required for ${logicalId}, recreating`);

        const createResult = await this.create(logicalId, resourceType, properties);

        // Delete old resource (best effort)
        try {
          await this.delete(logicalId, physicalId, resourceType, previousProperties);
        } catch (error) {
          this.logger.warn(`Failed to delete old resource: ${String(error)}`);
        }

        return {
          physicalId: createResult.physicalId,
          wasReplaced: true,
          attributes: createResult.attributes,
        };
      }

      // Update if possible
      await this.client.send(
        new UpdateXxxCommand({
          /* ... */
        })
      );

      // Get attributes after update
      const updatedResource = await this.client.send(
        new GetXxxCommand({ /* ... */ })
      );

      const attributes = {
        Arn: updatedResource.XxxArn,
        // ...
      };

      this.logger.info(`Successfully updated ${resourceType} ${logicalId}`);

      return {
        physicalId,
        wasReplaced: false,
        attributes,
      };
    } catch (error) {
      throw new ProvisioningError(
        `Failed to update ${resourceType} ${logicalId}: ${String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        error instanceof Error ? error : undefined
      );
    }
  }

  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>
  ): Promise<void> {
    this.logger.info(`Deleting ${resourceType} ${logicalId}: ${physicalId}`);

    try {
      // Check if resource exists
      try {
        await this.client.send(new GetXxxCommand({ /* ... */ }));
      } catch (error) {
        if (error instanceof ResourceNotFoundException) {
          this.logger.info(`Resource ${physicalId} does not exist, skipping deletion`);
          return;
        }
        throw error;
      }

      // Delete
      await this.client.send(
        new DeleteXxxCommand({
          /* ... */
        })
      );

      this.logger.info(`Successfully deleted ${resourceType} ${logicalId}`);
    } catch (error) {
      throw new ProvisioningError(
        `Failed to delete ${resourceType} ${logicalId}: ${String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Check if replacement is required
   */
  private checkReplacementRequired(
    newProps: Record<string, unknown>,
    oldProps: Record<string, unknown>
  ): boolean {
    // Properties marked "Update requires: Replacement" in CloudFormation docs
    const replacementProperties = ['XxxName', 'XxxId'];

    for (const prop of replacementProperties) {
      if (newProps[prop] !== oldProps[prop]) {
        return true;
      }
    }

    return false;
  }
}
```

### Step 3.5: Implement `import` (Optional but Recommended)

The `import` method lets `cdkd import <stack> --app "..."` adopt
already-deployed AWS resources of this type into cdkd state — covering
disaster recovery (state file lost), adoption (moving from another IaC
tool), and re-syncing after rollback. Skipping `import` is allowed (CC
API fallback handles overrides), but providers without it can only be
adopted via `--resource <id>=<physicalId>` and won't participate in
tag-based auto-lookup.

The method follows a single shape across the 35+ providers that have
shipped it. Pick the variant that matches your service's tag API:

```typescript
import {
  CDK_PATH_TAG,
  matchesCdkPath,
  resolveExplicitPhysicalId,
} from '../import-helpers.js';
import type {
  ResourceImportInput,
  ResourceImportResult,
} from '../../types/resource.js';

async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
  // 1. Explicit override OR Properties.<NameField> from template.
  //    Pass `null` as the second arg if the resource type has no
  //    template-supplied name field (e.g. KMS Key, CloudFront Distribution).
  const explicit = resolveExplicitPhysicalId(input, '<NameField>');
  if (explicit) {
    try {
      await this.client.send(new <Get|Head|Describe>Command({ /* ... */ }));
      return { physicalId: explicit, attributes: {} };
    } catch (err) {
      if (err instanceof <NotFoundError>) return null;
      throw err;
    }
  }
  if (!input.cdkPath) return null;

  // 2. Walk List* + ListTags* and match aws:cdk:path tag.
  let token: string | undefined;
  do {
    const list = await this.client.send(new ListCommand({ ...(token && { NextToken: token }) }));
    for (const item of list.Items ?? []) {
      if (!item.Id) continue;
      const tags = await this.client.send(new ListTagsCommand({ ResourceId: item.Id }));
      // Choose ONE based on your service's tag API:
      //   matchesCdkPath(tags.Tags, input.cdkPath)              ← Tag[] arrays (S3, IAM, EC2, RDS, …)
      //   tags.Tags?.[CDK_PATH_TAG] === input.cdkPath           ← Record<string,string> maps (Lambda, SQS)
      //   inline (key/value lowercase, not Key/Value)           ← ECS only — see ecs-provider.ts
      if (matchesCdkPath(tags.Tags, input.cdkPath)) {
        return { physicalId: item.Id, attributes: {} };
      }
    }
    token = list.NextToken;
  } while (token);
  return null;
}
```

#### Throttle-tolerant tag walk (`importTagWalk`)

Step 2 above is an inherent **N+1** read pattern — one `ListTags*` /
`Describe*` per candidate — which is exactly what AWS rate-limits on a
busy account. Hand-rolled loops have no backoff, so a single throttled
call aborts the whole `cdkd import` run (issue
[#1091](https://github.com/go-to-k/cdkd/issues/1091)).

New providers should route the walk through the shared helper in
[src/provisioning/import-tag-walk.ts](../src/provisioning/import-tag-walk.ts)
instead of writing the loop by hand:

```typescript
import { importTagWalk } from '../import-tag-walk.js';

const match = await importTagWalk({
  cdkPath: input.cdkPath,          // empty/undefined short-circuits to null, no API call
  logicalId: input.logicalId,      // used only in retry log lines
  listPage: async (token) => {
    const list = await this.client.send(new ListCommand({ ...(token && { NextToken: token }) }));
    return { items: list.Items, nextMarker: list.NextToken };
  },
  describe: async (item) =>
    item.Id ? await this.client.send(new ListTagsCommand({ ResourceId: item.Id })) : undefined,
  tagsOf: (tags) => tags.Tags,     // return undefined to skip a candidate
});
if (!match?.summary.Id) return null;
return { physicalId: match.summary.Id, attributes: {} };
```

Both `listPage` and `describe` are individually retried with exponential
backoff (0.5s → 1s → 2s → 4s → 5s) on throttling errors only. The
classifier (`isThrottlingLikeError`) delegates the error + `.cause` walk
to the deploy engine's `isThrottlingError` and only adds the
`Rate exceeded` message backstop, but its POLICY is deliberately NARROWER
than `isRetryableTransientError`: on a read-only walk, `does not exist` /
`not authorized to perform` are terminal, and retrying them would burn
the full backoff budget per candidate before surfacing the real error.

Because that backoff is per-call, the walk also enforces its own limits
and throws `ImportTagWalkLimitError` (whose message points at the
`--resource <logicalId>=<physicalId>` escape hatch):

| `retry` option | Default | Guards against |
| --- | --- | --- |
| `maxWalkMs` | 10 min | A sustained throttle turning into `(pages + candidates) x ~12.5s` of near-silent retrying |
| `maxPages` | 1,000 | A service returning a non-advancing pagination token, looping forever |
| `isInterrupted` / `onInterrupted` | unset | Ctrl-C during a throttled sleep going unhonored (same seam `withRetry` uses on the deploy path) |
| `logger` | process logger | Silent retries — defaults so a throttled walk and every skipped candidate show up under `--verbose` |

Providers whose tag API does not fit the shape (map-shaped tags,
lowercase `key`/`value`, filter-based one-shot lookups, batch tag fetch)
can keep their own loop; `isThrottlingLikeError` is exported for reuse.
The EMR Cluster + DocDB providers are the migrated reference callers;
the remaining `aws:cdk:path` walkers are migrated incrementally.

Reference implementations to copy from:

- **Tag[] array, name field present**: `s3-bucket-provider.ts`, `iam-role-provider.ts`, `dynamodb-table-provider.ts`, `kinesis-provider.ts`, `firehose-provider.ts`, `eventbridge-rule-provider.ts`, `wafv2-provider.ts`, `route53-provider.ts`, `elasticache-provider.ts`
- **Tag map (`Record<string,string>`)**: `lambda-function-provider.ts`, `sqs-queue-provider.ts`, `glue-provider.ts` (via `GetTags(ResourceArn)`)
- **Tags inline on the list response (no extra `ListTags` round-trip)**: `efs-provider.ts` (`DescribeFileSystems` / `DescribeAccessPoints` return `Tags` on each item)
- **No name field, ARN required for tag lookup**: `cloudfront-distribution-provider.ts`, `cognito-provider.ts`, `stepfunctions-provider.ts`
- **Batch tag fetch (single `Describe*` call for many ARNs)**: `elbv2-provider.ts` uses `DescribeTags(ResourceArns: [...])` (up to 20 per call) on top of `DescribeLoadBalancers` / `DescribeTargetGroups`
- **Filter-based one-shot lookup (no per-item ListTags)**: `ec2-provider.ts` uses `Filters: [{Name: 'tag:aws:cdk:path', Values: [path]}]` directly on `Describe*`
- **Lowercase `key`/`value` tag shape**: `ecs-provider.ts`, `codebuild-provider.ts`, `stepfunctions-provider.ts` (the few services that use lowercase tag keys — `matchesCdkPath` from `import-helpers.ts` does NOT apply; match the lowercase fields manually)
- **Explicit-override only** (auto lookup is impractical, the resource is not taggable, or it is a sub-resource / attachment): `apigateway-provider.ts`, `apigatewayv2-provider.ts`, `appsync-provider.ts` for sub-resources scoped under a parent RestApi / HttpApi / GraphqlApi; `route53-provider.ts` for RecordSets (not taggable); `efs-provider.ts` for MountTargets (not taggable); `elbv2-provider.ts` for Listeners (no taggable identity tying them to a CDK construct); `sns-subscription-provider.ts`, `sns-topic-policy-provider.ts`, `sqs-queue-policy-provider.ts`, `s3-bucket-policy-provider.ts`, `lambda-permission-provider.ts`, `lambda-eventsource-provider.ts`, `lambda-url-provider.ts`, `custom-resource-provider.ts`, `cloudfront-oai-provider.ts`, `agentcore-runtime-provider.ts` for attachments / handler-returned identity; `agentcore-evaluator-provider.ts` accepts the ARN verbatim or resolves a bare evaluator id to the canonical ARN via `GetEvaluator`. Pattern: `if (input.knownPhysicalId) return { physicalId: input.knownPhysicalId, attributes: {} }; return null;` — JSDoc the override-only choice naming the reason (no tag API, sub-resource scoping, attachment, identity carried by handler-returned PhysicalResourceId, etc).
- **Singleton live auto-lookup (no override needed at all)**: `agentcore-browser-provider.ts` / `agentcore-code-interpreter-provider.ts` — the types are adopt-only representations of the AWS-managed defaults (`aws.browser.v1` / `aws.codeinterpreter.v1`), so `import` resolves them live via `GetBrowser` / `GetCodeInterpreter` and ignores overrides.

Notes:

- **Return `null`, don't throw**, when nothing matches — `cdkd import` treats `null` as "not deployed yet", not as a failure
- `attributes: {}` is fine for most types — the deploy-time `Fn::GetAtt`
  resolver reconstructs missing attributes via `constructAttribute`
  (see `src/deployment/intrinsic-function-resolver.ts`)
- Tests for `import` go in the same file as the create/update/delete
  tests, with three cases: explicit-override path, tag-based lookup
  hit, tag-based lookup miss (returns `null`)

### Step 4: Add AWS Client

Add client to `src/utils/aws-clients.ts`:

```typescript
import { XxxClient } from '@aws-sdk/client-xxx';

export class AwsClients {
  // Existing clients
  public readonly s3: S3Client;
  public readonly iam: IAMClient;
  // ...

  // New client
  public readonly xxx: XxxClient;

  constructor(region: string) {
    const config = { region };

    this.s3 = new S3Client(config);
    this.iam = new IAMClient(config);
    // ...
    this.xxx = new XxxClient(config);
  }
}
```

### Step 5: Register Provider

Register in `src/provisioning/register-providers.ts` within the `registerAllProviders()` function:

```typescript
import { XxxResourceProvider } from './providers/xxx-resource-provider.js';

// Add to registerAllProviders()
registry.register('AWS::Xxx::Resource', new XxxResourceProvider());
```

### Step 5b: Refresh CFn schema fixture (issue #391)

The `property-coverage` test will fail until the new type's schema fixture exists:

```bash
node scripts/refresh-cfn-schemas.mjs --only-missing
```

Then classify every unaccounted property into `handledProperties` (if wired) or `unhandledByDesign` (if intentionally skipped, with a one-line rationale). See [§3c handledProperties coverage check](#3c-handledproperties--cfn-schema-coverage-check-issue-391) for the full workflow.

### Step 6: Create Tests

`tests/unit/provisioning/providers/xxx-resource-provider.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vite-plus/test';
import { XxxResourceProvider } from '../../../../src/provisioning/providers/xxx-resource-provider.js';

describe('XxxResourceProvider', () => {
  let provider: XxxResourceProvider;

  beforeEach(() => {
    provider = new XxxResourceProvider();
  });

  describe('create', () => {
    it('should create resource with valid properties', async () => {
      const result = await provider.create(
        'MyResource',
        'AWS::Xxx::Resource',
        {
          RequiredProp: 'value',
        }
      );

      expect(result.physicalId).toBeDefined();
      expect(result.attributes).toBeDefined();
    });

    it('should throw error if required property is missing', async () => {
      await expect(
        provider.create('MyResource', 'AWS::Xxx::Resource', {})
      ).rejects.toThrow();
    });
  });

  // Add tests for update, delete
});
```

## Best Practices

### 1. Error Handling

- Wrap all AWS SDK calls in try-catch
- Use `ProvisioningError` to provide detailed context

```typescript
try {
  await this.client.send(new CreateXxxCommand({ ... }));
} catch (error) {
  throw new ProvisioningError(
    `Failed to create ${logicalId}: ${String(error)}`,
    resourceType,
    logicalId,
    physicalId,
    error instanceof Error ? error : undefined
  );
}
```

### 2. Idempotency

- Handle when `create` is called on existing resource
- Handle when `delete` is called on non-existent resource

**Region verification on `*NotFound`**: A `*NotFound` error during DELETE
must NOT be treated as idempotent success without confirming that the AWS
client's region matches the region the resource was deployed to. A destroy
run pointing at the wrong region would otherwise receive `NotFound` for
every resource and silently strip them all from state, leaving the actual
AWS resources orphaned in the real region (this is the silent-failure
incident that motivated PR 2 of the region/state refactor).

Providers MUST call `assertRegionMatch()` from
`src/provisioning/region-check.ts` before returning early on a `*NotFound`
error:

```typescript
import { assertRegionMatch, type DeleteContext } from '../region-check.js';

async delete(
  logicalId: string,
  physicalId: string,
  resourceType: string,
  _properties?: Record<string, unknown>,
  context?: DeleteContext,
): Promise<void> {
  try {
    await this.client.send(new DeleteXxxCommand({ Id: physicalId }));
  } catch (error) {
    if (error instanceof ResourceNotFoundException) {
      const clientRegion = await this.client.config.region();
      assertRegionMatch(
        clientRegion,
        context?.expectedRegion,
        resourceType,
        logicalId,
        physicalId,
      );
      this.logger.info('Resource not found, skipping deletion');
      return;
    }
    throw error;
  }
}
```

`assertRegionMatch` is a no-op when `context.expectedRegion` is undefined,
preserving the existing idempotent semantics for callers that have not
been threaded with state region. When set, a region mismatch throws a
`ProvisioningError` that surfaces both regions and a hint to rerun with
the correct `--region`.

### 3. Returning Attributes

Return attributes accessible via `Fn::GetAtt`:

```typescript
return {
  physicalId: bucketName,
  attributes: {
    Arn: `arn:aws:s3:::${bucketName}`,
    DomainName: `${bucketName}.s3.amazonaws.com`,
    RegionalDomainName: `${bucketName}.s3.${region}.amazonaws.com`,
  },
};
```

### 3a. `getAttribute()` for live `Fn::GetAtt` resolution

Beyond the initial create/update return value, providers should implement
`getAttribute(physicalId, resourceType, attributeName)` so that **live**
attribute reads succeed even when the value is no longer in cdkd state —
specifically the `cdkd orphan` per-resource flow, which fetches each
referenced attribute on demand to splice into sibling references.

Conventions:

- Return `undefined` for unknown attribute names. Do not throw.
- Treat `*NotFound` exceptions as `undefined` rather than re-throwing —
  the live fetch is best-effort, and `cdkd orphan` falls back to the
  cached `state.attributes` (and ultimately `--force`) when the live
  resolution comes back empty.
- Prefer derivation from `physicalId` when CFn returns derivable values
  (S3 Bucket DomainName/Arn, SNS Topic name from ARN tail, SQS QueueName
  from URL tail) so the call is free.

#### Known coverage gaps (deliberate)

The following CloudFormation `Fn::GetAtt` return values are documented but
not implemented in cdkd's `getAttribute()`. They require a separate AWS
API call beyond what cdkd already makes, are rarely referenced from CDK
code, or both. If a real-world stack hits one of these, file an issue —
the small additional call is reasonable to add.

| Resource | Unsupported attribute | Why deferred |
| --- | --- | --- |
| `AWS::SQS::Queue` | (none) | All three CFn return values are covered. |
| `AWS::S3::Bucket` | (none) | All five CFn return values are covered. |

### 3b. `readCurrentState()` for drift detection — always emit user-controllable top-level keys

`readCurrentState(physicalId, logicalId, resourceType)` returns the AWS-current snapshot of a resource for `cdkd drift` and `cdkd state refresh-observed`. The drift comparator walks **state's top-level keys only** (intentionally — to avoid surfacing every `FunctionArn` / `RevisionId` / `LastModified` / etc. that AWS auto-attaches to every response). That design has one consequence the provider author MUST account for:

> **Any user-controllable top-level CFn property `update()` can mutate must be emitted with a placeholder when AWS returns the field as undefined / empty.**

If the provider omits the key on the empty path (e.g. `if (cfg.Environment?.Variables) result['Environment'] = ...`), then on a resource that was deployed WITHOUT that key in its template, `state.observedProperties` never carries the key — and the comparator's state-keys-only walk skips the field forever. A user adding the property in the AWS console after deploy is **silently invisible** to drift.

Use these placeholders consistently:

| Type | Placeholder | Example |
| --- | --- | --- |
| Array | `?? []` | `result['ManagedPolicyArns'] = arns;` (after building the list) |
| Map / object (when AWS returns the whole object as undefined) | `?? {}` | `result['Cors'] = cors;` (after building, even if `cors` ended up empty) |
| Optional string | `?? ''` | `result['Description'] = resp.Description ?? '';` |
| Boolean / numeric scalar | `?? <semantic-default>` | `Status: resp.Status ?? 'Suspended'`, `BlockPublicAcls: cfg?.BlockPublicAcls ?? false` |
| Tags map | `?? []` (already covered for Tags by PR #145) | `result['Tags'] = normalizeAwsTagsToCfn(...);` |

**When the guard is justified — keep it**:

- **Immutable on create** — `BucketName`, `Lambda Runtime` (when create-time-only), `IAM RoleName`. The field can't change at all; AWS returning undefined is a wire-layer artifact, not a "user could add this." Skip emit.
- **AWS-managed read-only** — `FunctionArn`, `RevisionId`, `CodeSha256`, timestamps. These are not in the CFn template; cdkd state never carries them. They should NOT be in `readCurrentState` output at all.
- **Write-only** — `Code: { S3Bucket, S3Key }`, `SecretString`, `LoginProfile.Password`. AWS does not return these on read. Declare via `getDriftUnknownPaths()` so the comparator skips the entire subtree (see "Known coverage gaps" below).

**Wire-layer filtering** — the drift comparator does NOT apply per-type denylists for SDK provider results (those are reserved for the CC-API fallback path). If your provider's SDK response includes AWS-managed fields you don't want to surface, do NOT assign them in the first place.

**Test convention** (mandatory for any provider with `readCurrentState`): every provider test file MUST have an `it('emits placeholders for every user-controllable top-level key on AWS minimum response')` block that:

1. Mocks the SDK to return the resource exists with **all optional fields undefined / empty** (just required fields like Name / ARN).
2. Calls `readCurrentState(physicalId, logicalId, resourceType)`.
3. Asserts `Object.keys(result).sort()` matches the **complete expected key list** for that resource type — not a subset.
4. Spot-checks the placeholder values for the most fragile keys (`?? ''` strings, `?? []` arrays, `?? {}` objects, `?? <semantic-default>` scalars).

Example template:

```typescript
it('emits placeholders for every user-controllable top-level key on AWS minimum response', async () => {
  mockSend.mockResolvedValueOnce({
    /* SDK response: required fields only, all optionals undefined */
  });
  const result = await provider.readCurrentState('phys-id', 'L', 'AWS::My::Type');
  expect(Object.keys(result ?? {}).sort()).toEqual(
    ['Key1', 'Key2', /* ... complete list ... */ ].sort()
  );
  expect(result?.Key1).toBe('');           // string placeholder
  expect(result?.Key2).toEqual([]);        // array placeholder
  expect(result?.Key3).toEqual({});        // object placeholder
});
```

See [tests/unit/provisioning/lambda-function-provider-readcurrentstate.test.ts](../tests/unit/provisioning/lambda-function-provider-readcurrentstate.test.ts) and [tests/unit/provisioning/cognito-provider-readcurrentstate.test.ts](../tests/unit/provisioning/cognito-provider-readcurrentstate.test.ts) for canonical examples.

This is the **structural defense** against the "provider author forgets to emit a key" regression class. Without it, the bug only surfaces when a user runs drift on a resource configured exactly the way the test missed (and PR review missed). The test makes silent regression mechanically impossible — a refactor that drops a placeholder fails the key-set assertion immediately.

#### `getDriftUnknownPaths()` for unreadable fields

When AWS does not return a field that cdkd state stores (write-only fields, or a CFn property whose round-trip back to the template shape isn't worth implementing yet), declare the path so the comparator skips it instead of firing guaranteed false-positive drift on every clean run:

```typescript
getDriftUnknownPaths(): string[] {
  return ['Code'];                              // Lambda::Function: pre-signed URL only
  // or ['SecretString', 'GenerateSecretString']
  // or ['RedshiftDestinationConfiguration.Password']  // Firehose: write-only, AWS never returns it
}
```

The comparator does exact-match + `entry + '.'` prefix-match — listing `'Policies'` skips `Policies`, `Policies.Foo`, `Policies[0].PolicyDocument`, etc. Pair this with a docstring explaining why the field is unreadable so a future PR can lift the gap.

#### Two failure modes when an always-emit placeholder round-trips through `update()`

`cdkd drift --revert` round-trips `observedProperties` (the snapshot `readCurrentState` produced) back through `provider.update`. That code path is what surfaces every shape-mismatch bug between the read side (`readCurrentState` output) and the write side (AWS create/update API input). Two failure classes have been observed; both must be designed around BEFORE adding a new `readCurrentState`.

**Class 1 — type-discriminator-dependent fields.** A field is only valid on AWS when a sibling discriminator says so. Examples: SQS `DeduplicationScope` / `FifoThroughputLimit` (FIFO-only — `FifoQueue=true`), SNS `FifoThroughputScope` (`FifoTopic=true`), AppSync DataSource shape (`DynamoDBConfig` / `LambdaConfig` / `HttpConfig` discriminated by `Type`). Emitting a `''` placeholder for these on a discriminator-false resource means `--revert` pushes it back and AWS rejects with "You can specify X only when Y is set to true". **Fix:** guard the emit on the sibling discriminator — only emit when the discriminator is true. Pattern documented in `feedback_always_emit_check_type_discriminator.md`. Drift detection is not lost: the discriminator-false state cannot legally have the field on AWS, so console-side ADD is impossible.

**Class 2 — structurally-incomplete-when-empty fields.** An empty-object / empty-array placeholder is structurally invalid as AWS input because a sub-field is required. Example: SQS `RedrivePolicy: {}` rejects with "Redrive policy does not contain mandatory attribute: maxReceiveCount" because `deadLetterTargetArn` and `maxReceiveCount` are required. Other Class 2 candidates: Lambda `DeadLetterConfig` (TargetArn required), Lambda `VpcConfig` (SubnetIds + SecurityGroupIds required), EventBridge / SNS `DeadLetterConfig`, ECS `NetworkConfiguration` (awsvpcConfiguration.subnets required), various `LoggingConfiguration` shapes. **Fix:** keep the placeholder on the read side (drift detection requires it), and **sanitize at the wire layer in `create()` / `update()`** by translating the empty placeholder to whatever AWS accepts as "clear this field" — usually empty string. Canonical pattern in `serializeRedrivePolicy` ([src/provisioning/providers/sqs-queue-provider.ts](../src/provisioning/providers/sqs-queue-provider.ts)):

```typescript
function serializeRedrivePolicy(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object' && Object.keys(value as Record<string, unknown>).length === 0) {
    return '';  // AWS-documented way to clear RedrivePolicy
  }
  return JSON.stringify(value);
}
```

Pattern documented in `feedback_class2_placeholder_round_trip.md`.

#### `update()` must gate optional fields on `!== undefined`, not truthy

Truthy gates (`if (properties['X']) { ... }`) silently drop empty string `''`, numeric `0`, boolean `false`, and empty array `[]` (where the CFn type allows it). For `cdkd deploy` this is mostly invisible. For `cdkd drift --revert` it is a load-bearing bug: when state has no description but AWS does, the desired value to push back is `Description: ''`. A truthy gate drops it, the AWS update succeeds with no actual change, `--revert` reports `✓ reverted`, and the very next `cdkd drift` re-detects the same drift — silent fail mode. **Fix:** use `if (properties['X'] !== undefined)` so explicit-empty values reach AWS:

```typescript
// IAM Role example (PR #161 fix):
if (properties['Description'] !== undefined) {
  updateParams.Description = properties['Description'] as string;
}
```

Truthy gates are correct ONLY for fields where the value range excludes the falsy form (e.g. boolean flags where `false` means "use default", or `Path` where empty is invalid). Add a code comment when the truthy form is intentional. Pattern documented in `feedback_update_optional_field_undefined_check.md`.

#### Read-update round-trip test (mandatory for any provider with `readCurrentState`)

The above failure modes (Class 1, Class 2, truthy gate) all surface only on the `cdkd drift --revert` code path, which round-trips `observedProperties` (= a previous `readCurrentState` snapshot) back through `provider.update`. Document review and code grep cannot catch every instance — write a test that exercises the round-trip mechanically:

```typescript
it('round-trip: readCurrentState placeholders survive update() without AWS-invalid inputs', async () => {
  // 1. Mock SDK to return the AWS-minimum response (only required
  //    fields, optionals undefined). readCurrentState should emit
  //    every always-emit placeholder.
  mockSend.mockResolvedValueOnce({ /* minimum SDK shape */ });
  // ...

  const observed = await provider.readCurrentState(physicalId, 'L', RESOURCE_TYPE);
  // Spot-check the placeholders are present (this is the always-emit
  // contract, see "Test convention" earlier in this section).
  expect(observed?.RedrivePolicy).toEqual({});  // Class 2 placeholder
  // ...

  // 2. Reset mocks and set up update() expectations.
  vi.clearAllMocks();
  mockSend.mockResolvedValueOnce({});  // SDK update call
  // ...

  // 3. Round-trip: pass observed as both new (desired) and old (previous).
  //    No drift → update should be a logical no-op on AWS.
  await provider.update('L', physicalId, RESOURCE_TYPE, observed!, observed!);

  // 4. Assert: no SDK call sent a value AWS would reject.
  //    Per-provider — list the AWS-rejection-shaped values you know of:
  const setAttrsCall = mockSend.mock.calls.find(
    (c) => c[0] instanceof SetQueueAttributesCommand
  );
  if (setAttrsCall) {
    const attrs = setAttrsCall[0].input.Attributes;
    if (attrs.RedrivePolicy !== undefined) {
      // Class 2: '{}' would fail "Redrive policy does not contain
      // mandatory attribute: maxReceiveCount"
      expect(attrs.RedrivePolicy).not.toBe('{}');
    }
    // ... other per-provider rejection-shape checks
  }
});
```

The round-trip test catches all three classes mechanically:

- **Class 1** — discriminator-false placeholders that AWS rejects when shipped: assert the relevant `SetXxxAttributes` / `UpdateXxx` call does NOT include the discriminator-only attribute when the discriminator is false in the mock setup.
- **Class 2** — structurally-incomplete placeholders: assert the AWS API call does NOT contain the empty-object / empty-array shape AWS validates and rejects (e.g. `RedrivePolicy: '{}'`, `VpcConfig: {}`).
- **Truthy gate** — assert that empty-string / 0 / false placeholder values DO reach the relevant AWS API call (e.g. `UpdateRoleCommand` input must contain `Description: ''` when `observedProperties.Description === ''`).

See [tests/unit/provisioning/sqs-queue-provider-update.test.ts](../tests/unit/provisioning/sqs-queue-provider-update.test.ts) (Class 2 round-trip), [tests/unit/provisioning/iam-role-provider.test.ts](../tests/unit/provisioning/iam-role-provider.test.ts) (truthy-gate round-trip), and [tests/unit/provisioning/sns-topic-provider-roundtrip.test.ts](../tests/unit/provisioning/sns-topic-provider-roundtrip.test.ts) (Class 1 round-trip) for canonical examples.

### 3c. `handledProperties` ↔ CFn schema coverage check (issue #391)

Every SDK Provider declares a `handledProperties: Map<string, ReadonlySet<string>>` field naming the CFn template properties it knows how to wire to its AWS API calls. The provider registry's `getProviderFor` consults that set at routing time — a template carrying a property NOT in the set is auto-routed via Cloud Control API (which forwards the full property map to AWS, closing the silent-drop bug — see #614). `--allow-unsupported-properties Type:Prop` is the per-property opt-out that forces the SDK Provider path and accepts the silent drop.

That's a **runtime** safety net. It doesn't help during development. A provider author who simply forgets to list a property in `handledProperties` AND forgets to wire it in `create()` / `update()` ships a silent bug — exactly what PR #370 (ApiGateway::Method dropped 15+ fields) demonstrated.

The structural prevention layer lives at [tests/unit/provisioning/property-coverage.test.ts](../tests/unit/provisioning/property-coverage.test.ts). It cross-references every registered provider's `handledProperties` against the canonical CFn schema (snapshotted to [tests/fixtures/cfn-schemas/](../tests/fixtures/cfn-schemas/)) and fails when a schema property is unaccounted for.

#### The four "OK" buckets

For each schema property the test classifies it into one of four buckets (in priority order):

| Bucket | Where declared | When to use |
| --- | --- | --- |
| `handled` | `provider.handledProperties.get(type)` | The provider's `create()` / `update()` actually wires the property to the SDK call. |
| `by-design` | `provider.unhandledByDesign.get(type)` (with rationale string) | The provider INTENTIONALLY does not wire it — separate code path, deprecated, immutable post-create, AWS API doesn't accept it, etc. |
| `backfill` | [tests/fixtures/cfn-schemas/_todo-backfill.json](../tests/fixtures/cfn-schemas/_todo-backfill.json) under `types[<type>]` | Auto-generated catch-all for incremental rollout. Each entry MUST be migrated to `handled` or `by-design` eventually. |
| `read-only` | `readOnlyProperties` in the schema fixture | AWS computes the value; cdkd cannot wire it on Create/Update by definition (e.g. `Arn`). Automatically excluded. |

A property in NONE of the above → test fails with the offending type + property list + the three actions you can take.

#### Adding `unhandledByDesign` to a provider

A clean example is `AWS::ApiGatewayV2::Api`'s OpenAPI-import fields (`Body` / `BodyS3Location` / `FailOnWarnings` / `DisableSchemaValidation` / `BasePath`): they trigger an entirely separate `ImportApi` AWS API, not `CreateApi`. Listing them in `handledProperties` would be a lie; listing them in `unhandledByDesign` documents the deliberate skip:

```typescript
unhandledByDesign = new Map<string, ReadonlyMap<string, string>>([
  [
    'AWS::ApiGatewayV2::Api',
    new Map([
      ['Body', 'OpenAPI/Swagger inline spec; routed through ImportApi, not the field-by-field CreateApi path.'],
      ['BodyS3Location', 'OpenAPI/Swagger spec on S3; routed through ImportApi, not the field-by-field CreateApi path.'],
      // ...
    ]),
  ],
]);
```

Wired into the provider class:

```typescript
export class ApiGatewayV2Provider implements ResourceProvider {
  handledProperties = new Map<string, ReadonlySet<string>>([...]);
  unhandledByDesign = new Map<string, ReadonlyMap<string, string>>([...]);
  // ... rest of provider
}
```

Rationales are free text but should be greppable. Common shapes:

- `"create-only — AWS rejects on update"`
- `"AWS-managed read-only attribute"` (when not already in `readOnlyProperties`)
- `"deprecated — superseded by Y"`
- `"tags handled via per-resource Tag API, not the create input"`
- `"covered by separate AWS::Foo::Bar resource type"`
- `"OpenAPI-import-only flag; meaningful only on the ImportApi code path"`

**NON_PROVISIONABLE types: set `disableCcApiFallback`.** A template property
in neither `handledProperties` nor the allow set normally auto-routes the
resource through Cloud Control (issue #614). If your provider covers a
`ProvisioningType: NON_PROVISIONABLE` type (the reason SDK providers exist
for e.g. `AWS::FSx::FileSystem` / `AWS::DLM::LifecyclePolicy`), that route
target does not exist — Cloud Control has no handlers — and the runtime
Tier 3 set cannot catch it (it excludes SDK-covered types by design, so
`isNonProvisionable()` returns false once your provider is registered).
Declare `readonly disableCcApiFallback = true;` on the provider class: the
`ProviderRegistry` then rejects such templates pre-flight with a clear
error (property rationale + `--allow-unsupported-properties` escape hatch)
instead of failing at provisioning time with an opaque
`UnsupportedActionException`. This only matters when the type has (or may
gain) `unhandledByDesign` / not-yet-handled properties — a fully-handled
type never triggers the auto-route — but declaring it is cheap insurance
against a future schema addition.

#### Workflow when adding a new provider

1. Add the provider as usual ([§3 Provider Implementation Examples](#provider-implementation-examples)).
2. Register the new resource type in `src/provisioning/register-providers.ts`.
3. Refresh the CFn schema fixture:
   ```bash
   node scripts/refresh-cfn-schemas.mjs --only-missing
   ```
   This fetches only the newly-registered type via `cloudformation:DescribeType` and writes `tests/fixtures/cfn-schemas/<sanitized-type>.json`. Requires AWS credentials with `cloudformation:DescribeType` permission.
4. Run `vp test run property-coverage` — it will fail listing the schema properties your provider has not yet accounted for.
5. For each unaccounted property, EITHER:
   - Add it to `handledProperties` (if `create()` / `update()` already wires it), OR
   - Add it to `unhandledByDesign` with a one-line rationale.
6. Re-run the test — green.

If you really need to ship before classifying every property, you can regenerate the backfill TODO:

```bash
CDKD_GENERATE_BACKFILL=true vp test run property-coverage
```

This dumps every unaccounted property per type into `tests/fixtures/cfn-schemas/_todo-backfill.json` so the test passes. The intent is short-lived — a follow-up PR must migrate the backfill entries to `handled` or `by-design`.

#### Workflow when AWS publishes new properties

AWS adds properties to existing resource types fairly regularly. Surface them on schedule:

1. Periodically (manually) run `node scripts/refresh-cfn-schemas.mjs` to refresh ALL fixtures.
2. `git diff tests/fixtures/cfn-schemas/` shows the new properties added by AWS.
3. The next `vp test run property-coverage` run will fail naming the newly-unaccounted properties.
4. Triage each: wire it through, mark `unhandledByDesign`, or backfill (with follow-up).

The script is **not automated** today. The `cloudformation:DescribeType` API is throttled per-account, and committing a recurring CI cron would require credentials. For now this stays an on-demand operator step; see the issue thread for the open design question on CI automation.

#### "Bogus" entries and the tolerance list

A property in `handledProperties` (or `unhandledByDesign`) that is NOT in the CFn schema is a "bogus" entry — most often an SDK input field name that diverges from the CFn property name (e.g. SDK `DefaultCooldown` vs CFn `Cooldown` on `AutoScalingGroup`), a typo (`PlacementStrategy` vs `PlacementStrategies` on `ECS::Service`), or a stale alias from before AWS renamed the property.

The test reports these — but fixing each requires per-provider investigation that often touches the safety-net's runtime behavior. As a stopgap, the tolerance list at `tests/fixtures/cfn-schemas/_todo-backfill.json` under `bogusTolerated[<type>][<prop>]` accepts a one-line rationale per entry, the test stays green, and follow-up PRs investigate one at a time. Day-1 of issue #391 the test surfaced 10 such entries — see the rationale strings in that file for the canonical examples.

### 4. Logging

- `info`: Successful operations
- `debug`: Detailed information
- `warn`: Non-fatal errors
- `error`: Fatal errors

```typescript
this.logger.info(`Creating ${resourceType} ${logicalId}`);
this.logger.debug(`Using properties:`, properties);
this.logger.warn(`Old resource deletion failed: ${String(error)}`);
this.logger.error(`Failed to create ${logicalId}:`, error);
```

### 5. Resource Name Constraints

AWS services have length and character constraints on names:

```typescript
// IAM Role example (64 character limit)
private shortenRoleName(roleName: string): string {
  const MAX_LENGTH = 64;

  if (roleName.length <= MAX_LENGTH) {
    return roleName;
  }

  const hash = Buffer.from(roleName)
    .toString('base64')
    .replace(/[^a-zA-Z0-9]/g, '')
    .substring(0, 8);

  const maxPrefixLength = MAX_LENGTH - hash.length - 1;
  const prefix = roleName.substring(0, maxPrefixLength);

  return `${prefix}-${hash}`;
}
```

## Custom Resource Provider

Support for Lambda-backed custom resources (`Custom::*`):

See `src/provisioning/providers/custom-resource-provider.ts` for details.

**Key Points**:

- Invoke Lambda with same request format as CloudFormation
- Get `PhysicalResourceId` from response
- Return `Data` field as attributes

```typescript
const payload = {
  RequestType: 'Create',  // or 'Update', 'Delete'
  ServiceToken: properties['ServiceToken'],
  ResourceType: resourceType,
  LogicalResourceId: logicalId,
  ResourceProperties: properties,
};

const response = await lambdaClient.send(
  new InvokeCommand({
    FunctionName: serviceLambdaArn,
    Payload: JSON.stringify(payload),
  })
);

const result = JSON.parse(responsePayload);

return {
  physicalId: result.PhysicalResourceId,
  attributes: result.Data || {},
};
```

## Troubleshooting

### Provider is Not Being Called

**Cause**: Not registered in Registry (falling back to Cloud Control API)

**Check**:

```typescript
const provider = registry.getProvider('AWS::Xxx::Resource');
console.log(provider.constructor.name);  // → "CloudControlProvider" if SDK Provider not registered
```

### Attributes Not Resolved

**Cause**: Not returning attributes in `create()` / `update()`

**Fix**:

```typescript
return {
  physicalId: xxx,
  attributes: {
    Arn: 'arn:aws:...',
    // ...
  },
};
```

### Error on Update

**Cause**: Trying to change property requiring replacement in `update()`

**Fix**: Detect in `checkReplacementRequired()` and replace with `create()` + `delete()`

## References

- [architecture.md](./architecture.md) - Overall architecture
- [AWS Cloud Control API Supported Resources](https://docs.aws.amazon.com/cloudcontrolapi/latest/userguide/supported-resources.html)
- [CloudFormation Resource Reference](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-template-resource-type-ref.html)
- [AWS SDK for JavaScript v3](https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/)

## Future Extensions

### Provider Plugin System

Future consideration for adding Providers as external plugins:

```bash
# Install plugin
npm install cdkd-provider-custom-service

# Enable in configuration
# cdkd.config.json
{
  "providers": [
    "cdkd-provider-custom-service"
  ]
}
```

### Import Terraform Providers

Bridge Terraform Providers to cdkd Providers:

```typescript
import { TerraformProviderBridge } from 'cdkd-terraform-bridge';

const awsProvider = new TerraformProviderBridge('hashicorp/aws');
registry.register('AWS::CustomService::Resource', awsProvider);
```
