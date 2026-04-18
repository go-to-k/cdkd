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

5. **Create the provider file** at `src/provisioning/providers/{service}-{resource}-provider.ts`:
   - Import the AWS SDK client and commands
   - Implement `ResourceProvider` interface (create, update, delete, getAttribute)
   - Use `getAwsClient` from `../../utils/aws-client-factory.js` for client creation
   - Follow ESM import conventions (`.js` extension)
   - Return proper `physicalId` and `attributes` from create

6. **Register the provider** in `src/provisioning/register-providers.ts`:
   - Add import for the new provider
   - Add `registry.register('AWS::Service::Resource', new ServiceResourceProvider())` in `registerAllProviders()`

7. **Create test file** at `tests/unit/provisioning/providers/{service}-{resource}-provider.test.ts`:
   - Mock the AWS SDK client
   - Test create (verify API call, physicalId, attributes)
   - Test update (verify API call)
   - Test delete (verify API call)
   - Test delete idempotency (not-found treated as success)

8. **Check if `@aws-sdk/client-{service}` is already in package.json**. If not, tell the user to run `pnpm add @aws-sdk/client-{service}`.

9. **Run typecheck, lint, build, and tests** to verify everything works.

## Important

- Follow the exact patterns used by existing providers
- Always use `.js` extension in imports (ESM)
- Physical ID should match what CloudFormation uses for that resource type
- Include delete idempotency (not-found errors treated as success)
- Do NOT add the SDK client package yourself; tell the user if it's missing
