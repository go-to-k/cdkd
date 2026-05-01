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

Reference implementations to copy from:

- **Tag[] array, name field present**: `s3-bucket-provider.ts`, `iam-role-provider.ts`, `dynamodb-table-provider.ts`, `kinesis-provider.ts`, `firehose-provider.ts`, `eventbridge-rule-provider.ts`, `wafv2-provider.ts`, `route53-provider.ts`, `elasticache-provider.ts`
- **Tag map (`Record<string,string>`)**: `lambda-function-provider.ts`, `sqs-queue-provider.ts`, `glue-provider.ts` (via `GetTags(ResourceArn)`)
- **Tags inline on the list response (no extra `ListTags` round-trip)**: `efs-provider.ts` (`DescribeFileSystems` / `DescribeAccessPoints` return `Tags` on each item)
- **No name field, ARN required for tag lookup**: `cloudfront-distribution-provider.ts`, `cognito-provider.ts`, `stepfunctions-provider.ts`
- **Batch tag fetch (single `Describe*` call for many ARNs)**: `elbv2-provider.ts` uses `DescribeTags(ResourceArns: [...])` (up to 20 per call) on top of `DescribeLoadBalancers` / `DescribeTargetGroups`
- **Filter-based one-shot lookup (no per-item ListTags)**: `ec2-provider.ts` uses `Filters: [{Name: 'tag:aws:cdk:path', Values: [path]}]` directly on `Describe*`
- **Lowercase `key`/`value` tag shape**: `ecs-provider.ts`, `codebuild-provider.ts`, `stepfunctions-provider.ts` (the few services that use lowercase tag keys — `matchesCdkPath` from `import-helpers.ts` does NOT apply; match the lowercase fields manually)
- **Explicit-override only** (auto lookup is impractical, the resource is not taggable, or it is a sub-resource / attachment): `apigateway-provider.ts`, `apigatewayv2-provider.ts`, `appsync-provider.ts` for sub-resources scoped under a parent RestApi / HttpApi / GraphqlApi; `route53-provider.ts` for RecordSets (not taggable); `efs-provider.ts` for MountTargets (not taggable); `elbv2-provider.ts` for Listeners (no taggable identity tying them to a CDK construct); `sns-subscription-provider.ts`, `sns-topic-policy-provider.ts`, `sqs-queue-policy-provider.ts`, `s3-bucket-policy-provider.ts`, `lambda-permission-provider.ts`, `lambda-eventsource-provider.ts`, `lambda-url-provider.ts`, `custom-resource-provider.ts`, `cloudfront-oai-provider.ts`, `agentcore-runtime-provider.ts` for attachments / handler-returned identity. Pattern: `if (input.knownPhysicalId) return { physicalId: input.knownPhysicalId, attributes: {} }; return null;` — JSDoc the override-only choice naming the reason (no tag API, sub-resource scoping, attachment, identity carried by handler-returned PhysicalResourceId, etc).

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

### Step 6: Create Tests

`tests/unit/provisioning/providers/xxx-resource-provider.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
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
