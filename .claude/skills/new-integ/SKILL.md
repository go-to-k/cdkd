---
name: new-integ
description: Scaffold a new integration test for cdkd. Creates a minimal CDK app with the specified AWS resources for deploy/destroy E2E testing.
argument-hint: "<test-name>"
---

# New Integration Test Scaffold

You are scaffolding a new integration test for cdkd.

## Input

The user provides a test name (e.g., `ses-email-identity`, `efs-lambda`).

## Steps

1. **Check if test already exists** in `tests/integration/<test-name>/`.

2. **Read an existing simple test** as reference. Use `tests/integration/basic/` for structure.

3. **Create the test directory** at `tests/integration/<test-name>/` with these files:

   **`cdk.json`**:
   ```json
   {
     "app": "npx ts-node --prefer-ts-exts bin/app.ts"
   }
   ```

   **`package.json`**:
   ```json
   {
     "name": "cdkd-integ-<test-name>",
     "version": "1.0.0",
     "private": true,
     "description": "<description>",
     "scripts": {
       "build": "tsc",
       "watch": "tsc -w"
     },
     "devDependencies": {
       "@types/node": "^20.0.0",
       "typescript": "^5.0.0",
       "ts-node": "^10.0.0"
     },
     "dependencies": {
       "aws-cdk-lib": "^2.169.0",
       "constructs": "^10.0.0"
     }
   }
   ```

   **`tsconfig.json`**:
   ```json
   {
     "compilerOptions": {
       "target": "ES2020",
       "module": "commonjs",
       "lib": ["es2020"],
       "declaration": true,
       "strict": true,
       "noImplicitAny": true,
       "strictNullChecks": true,
       "noImplicitThis": true,
       "alwaysStrict": true,
       "esModuleInterop": true,
       "outDir": "dist"
     },
     "exclude": ["node_modules", "dist"]
   }
   ```

   **`bin/app.ts`**: Entry point that creates the App and Stack.

   **`lib/<test-name>-stack.ts`**: Stack definition with the resources to test. Keep it minimal - only the resource type being tested and its required dependencies.

4. **Ask the user** what specific AWS resources the test should create, if not obvious from the test name.

5. **Install dependencies**: Run `cd tests/integration/<test-name> && npm install`.

6. **Verify synthesis works**: Run `node ../../../dist/cli.js synth --region us-east-1` from the test directory.

7. **Offer to run the full test** with `/run-integ <test-name>`.

## Important

- Keep tests minimal - only the resources needed to verify the provider works
- Do NOT include `stateBucket` in `cdk.json` context (let the CLI resolve it automatically)
- Use `RemovalPolicy.DESTROY` where applicable to ensure clean teardown
- Follow the naming convention: stack name = `<PascalCaseTestName>Stack`
- Do NOT commit `node_modules/`, `package-lock.json`, `cdk.out/`, or `dist/` (covered by `tests/integration/.gitignore`)
