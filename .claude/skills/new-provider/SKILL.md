---
name: new-provider
description: Scaffold a new SDK Provider for a given AWS resource type (e.g., AWS::SES::EmailIdentity). Creates provider file, registers it, and generates test boilerplate.
argument-hint: "<AWS::Service::Resource>"
---

# New Provider Scaffold

You are scaffolding a new SDK Provider for cdkd.

## Input

The user provides an AWS resource type like `AWS::SES::EmailIdentity`.

## Steps

1. **Parse the resource type** to determine:
   - Service name (e.g., `SES`)
   - Resource name (e.g., `EmailIdentity`)
   - AWS SDK client package (e.g., `@aws-sdk/client-ses`)
   - Provider file name (e.g., `ses-email-identity-provider.ts`)

2. **Check if provider already exists** in `src/provisioning/providers/` and `src/provisioning/register-providers.ts`.

3. **Read an existing provider** as reference for the pattern. Use a simple one like `src/provisioning/providers/ssm-parameter-provider.ts` or `src/provisioning/providers/logs-log-group-provider.ts`.

4. **Read the AWS SDK docs or infer the API calls** needed:
   - CREATE: Which API creates this resource? What does it return (physical ID, attributes)?
   - UPDATE: Which API updates this resource?
   - DELETE: Which API deletes this resource?
   - getAttribute: Which attributes might be needed for `Fn::GetAtt`?
   - **import**: Which API verifies a resource exists by physical id (`Get*` / `Describe*` / `Head*`), and which `List*` + `ListTags*` (or equivalent) lookup-by-tag pair lets you find a resource by its `aws:cdk:path` tag? See "Import method" under step 5 — most providers follow the same shape.

5. **Create the provider file** at `src/provisioning/providers/{service}-{resource}-provider.ts`:
   - Import the AWS SDK client and commands
   - Implement `ResourceProvider` interface (create, update, delete, getAttribute, **import**)
   - Use `getAwsClient` from `../../utils/aws-client-factory.js` for client creation
   - Follow ESM import conventions (`.js` extension)
   - Return proper `physicalId` and `attributes` from create

   **Import method** — copy this shape from a similar provider (e.g.
   `s3-bucket-provider.ts` for tag-array services, `lambda-function-provider.ts`
   for tag-map services, `kms-provider.ts` for services with no
   template name property):

   ```ts
   import { matchesCdkPath, resolveExplicitPhysicalId, CDK_PATH_TAG } from '../import-helpers.js';
   import type { ResourceImportInput, ResourceImportResult } from '../../types/resource.js';

   async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
     // 1. Explicit override OR Properties.<NameField> from template.
     const explicit = resolveExplicitPhysicalId(input, '<NameField>');  // e.g. 'BucketName' / 'FunctionName' / 'RoleName'
     if (explicit) {
       try {
         await this.client.send(new <Get|Head|Describe>Command({ ... explicit ... }));
         return { physicalId: explicit, attributes: {} };
       } catch (err) {
         if (err instanceof <NotFoundError>) return null;
         throw err;
       }
     }
     if (!input.cdkPath) return null;

     // 2. List + tag-based lookup. Walk the service's List* paginator,
     //    fetch tags per resource, match aws:cdk:path.
     let token: string | undefined;
     do {
       const list = await this.client.send(new ListCommand({ ...(token && { NextToken: token }) }));
       for (const item of list.Items ?? []) {
         if (!item.Id) continue;
         const tags = await this.client.send(new ListTagsCommand({ ResourceId: item.Id }));
         if (matchesCdkPath(tags.Tags, input.cdkPath)) {
           return { physicalId: item.Id, attributes: {} };
         }
       }
       token = list.NextToken;
     } while (token);
     return null;
   }
   ```

   Notes:
   - Return `null` (not throw) when the resource is not found — caller
     treats this as "skipped" rather than failure.
   - `attributes: {}` is fine; `Fn::GetAtt` reconstructs missing
     attributes at deploy time via `constructAttribute` (see
     `src/deployment/intrinsic-function-resolver.ts`).
   - For services whose `ListTags` returns a `Record<string,string>`
     map instead of a `Tag[]` array (Lambda, SQS), read the value at
     key `CDK_PATH_TAG` directly instead of going through
     `matchesCdkPath`.
   - For services with NO template-supplied name field (KMS Key,
     CloudFront Distribution), skip step 1's name fallback — only
     the explicit-override path and tag lookup apply.
   - Some services don't support tagging or `ListTags` requires extra
     IAM. If tag lookup is impractical, document that limitation in
     the method's doc comment and rely on `--resource` overrides.

6. **Register the provider** in `src/provisioning/register-providers.ts`:
   - Add import for the new provider
   - Add `registry.register('AWS::Service::Resource', new ServiceResourceProvider())` in `registerAllProviders()`

7. **Create test file** at `tests/unit/provisioning/providers/{service}-{resource}-provider.test.ts`:
   - Mock the AWS SDK client
   - Test create (verify API call, physicalId, attributes)
   - Test update (verify API call)
   - Test delete (verify API call)
   - Test delete idempotency (not-found treated as success)
   - Test import explicit-override path (knownPhysicalId verified, attrs returned)
   - Test import tag-based lookup (List + ListTags + cdkPath match)
   - Test import not-found (returns `null`, does not throw)

8. **Check if `@aws-sdk/client-{service}` is already in package.json**. If not, tell the user to run `pnpm add @aws-sdk/client-{service}`.

9. **Run typecheck, lint, build, and tests** to verify everything works.

10. **Create integration test** by invoking `/new-integ` with a test name based on the resource type (e.g., `ses-email-identity`). The integ test should create a minimal CDK stack using the new resource type.

## Important

- Follow the exact patterns used by existing providers
- Always use `.js` extension in imports (ESM)
- Physical ID should match what CloudFormation uses for that resource type
- Include delete idempotency (not-found errors treated as success)
- Do NOT add the SDK client package yourself; tell the user if it's missing
- Always create an integration test after the provider is implemented
