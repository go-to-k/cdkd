---
title: Connect a Frontend to Your Stack
description: "Hand a deployed stack's outputs, such as an API URL or a Cognito user pool ID, to a web frontend: write them to a file with cdkd deploy --outputs-file, turn the file into the frontend's config, and build."
---

# Connect a Frontend to Your Stack

A web frontend needs values that exist only after the backend is deployed:
the API's URL, the Cognito user pool ID, the bucket uploads go to. This page
shows how to get them from `cdkd deploy` into the frontend's configuration,
for local development and for a CI build.

The values travel as stack outputs. `cdkd deploy --outputs-file` writes them
to a JSON file, and a one-line script turns that file into whatever the
frontend reads.

## Publish the values the frontend needs

Declare each value as a `CfnOutput` directly in the stack:

```ts
new cdk.CfnOutput(this, 'ApiUrl', { value: api.url });
new cdk.CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId });
new cdk.CfnOutput(this, 'UserPoolClientId', { value: client.userPoolClientId });
```

The construct ID becomes the output's key in the file. An output declared
inside a nested construct gets a key built from its construct path plus a
hash, so declare the ones a script reads at the stack level.

## Local development

::: steps

1. Deploy and write the outputs

   ```bash
   cdkd deploy ApiStack --outputs-file cdk-outputs.json
   ```

   ```json
   {
     "ApiStack": {
       "ApiUrl": "https://abc123.execute-api.us-east-1.amazonaws.com/prod/",
       "UserPoolId": "us-east-1_AbCdEfGhI",
       "UserPoolClientId": "1example23456789"
     }
   }
   ```

2. Turn the file into the frontend's config

   For a Vite app, write a `.env.local` with `jq`:

   ```bash
   jq -r '.ApiStack | "VITE_API_URL=\(.ApiUrl)
   VITE_USER_POOL_ID=\(.UserPoolId)
   VITE_USER_POOL_CLIENT_ID=\(.UserPoolClientId)"' cdk-outputs.json > web/.env.local
   ```

3. Start the frontend

   ```bash
   cd web && npm run dev
   ```

   The app reads `import.meta.env.VITE_API_URL` and the other values.

:::

To skip the flag on every deploy, set the path once in `cdk.json`:

```json
{
  "app": "npx ts-node --prefer-ts-exts bin/app.ts",
  "outputsFile": "cdk-outputs.json"
}
```

Each deploy replaces the file with the outputs of the stacks it deployed. A
later `cdkd deploy OtherStack` leaves no `ApiStack` entry, and `jq` then
writes `null` without an error, so regenerate the config right after
deploying `ApiStack`.

The file holds one environment's values, so keep it and `.env.local` out of
version control.

## Build and host in CI

When the frontend is hosted by the same CDK app, for example an S3 bucket
deployed with `BucketDeployment` from `web/dist`, split it into its own stack.
The backend deploys first, the frontend builds from its outputs, and the
hosting stack uploads the build:

```bash
mkdir -p web/dist   # the first deploy synthesizes WebStack too, which needs the directory
cdkd deploy ApiStack --outputs-file cdk-outputs.json
jq -r '.ApiStack | "VITE_API_URL=\(.ApiUrl)"' cdk-outputs.json > web/.env.production
(cd web && npm ci && npm run build)
cdkd deploy WebStack
```

Every `cdkd deploy` synthesizes the whole app, so `web/dist` must exist
before the first command even though only `ApiStack` is deployed then.

## When the frontend reads its config at runtime

Building the values into the bundle needs a rebuild whenever they change. The
other way is to deploy a `config.json` next to the frontend and fetch it when
the app starts. CDK's `Source.jsonData` resolves the values during the deploy,
so this needs no outputs file and works within one stack:

```ts
new s3deploy.BucketDeployment(this, 'Deploy', {
  destinationBucket: siteBucket,
  sources: [
    s3deploy.Source.asset('web/dist'),
    s3deploy.Source.jsonData('config.json', {
      apiUrl: api.url,
      userPoolId: userPool.userPoolId,
    }),
  ],
});
```

```ts
const config = await fetch('/config.json').then((r) => r.json());
```

| | Outputs file + build | `config.json` at runtime |
| --- | --- | --- |
| Where values come from | `cdkd deploy --outputs-file` | The deploy itself |
| Stacks needed | Backend and hosting in separate stacks | One stack is enough |
| A value changes | Rebuild and redeploy the frontend | Redeploy; no rebuild |
| Local development | The same file feeds `npm run dev` | Still needs the outputs file, or a copy of `config.json` |

## Keep secrets out of the frontend

Everything the frontend receives ends up in the browser. Publish IDs and
URLs, never keys. An output whose value comes from a secret is written to the
file as `***`, not the real value: see
[Secrets in outputs are masked](stack-outputs.md#secrets-in-outputs-are-masked).

## Related

- [Read Stack Outputs](stack-outputs.md): the outputs file's behavior, and
  reading outputs with `cdkd state show`
- [`cdkd deploy`](cli-deploy.md): every flag, including `--outputs-file`
- [Create Per-PR Environments in CI](ci-per-pr.md): deploying a copy of the
  stacks for each pull request
