// SDK calls verify.sh needs and the AWS CLI lacks: `lambda-core` (the
// customer-managed runtime APIs) is not a CLI service, and the CLI's
// `get-function-configuration` drops `RuntimeConfig`. Every failure exits
// non-zero with the AWS error class, so a caller's `|| return 1` sees it.
//
//   node runtime.mjs setup <name> <imageUri>   -> prints the runtime ARN
//   node runtime.mjs teardown-prefix <prefix>  -> deletes every runtime under it
//   node runtime.mjs state <name>              -> runtime State, or GONE
//   node runtime.mjs fncfg <functionName>      -> {"Runtime":..,"RuntimeConfig":..}
import * as Core from '@aws-sdk/client-lambda-core';
import { LambdaClient, GetFunctionConfigurationCommand } from '@aws-sdk/client-lambda';

const region = process.env.AWS_REGION ?? 'us-east-1';
const core = new Core.LambdaCoreClient({ region });
const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));
const NOT_FOUND = 'ResourceNotFoundException';

async function waitActive(read, what) {
  for (let i = 0; i < 60; i++) {
    const r = await core.send(read());
    if (r.State === 'ACTIVE') return;
    if (r.State !== 'CREATING' && r.State !== 'PENDING') {
      throw new Error(`${what} reached ${r.State}, not ACTIVE`);
    }
    await sleep(5);
  }
  throw new Error(`${what} still not ACTIVE after 300s`);
}

async function setup(name, imageUri) {
  const rt = await core.send(
    new Core.CreateRuntimeCommand({ Name: name, Description: 'cdkd integ lambda-runtime-config' })
  );
  await core.send(
    new Core.CreateRuntimeVersionCommand({ RuntimeName: name, Name: 'v1', ImageUri: imageUri })
  );
  await waitActive(
    () => new Core.GetRuntimeVersionCommand({ RuntimeName: name, Name: 'v1' }),
    'runtime version v1'
  );
  for (const alias of ['a', 'b']) {
    await core.send(
      new Core.CreateRuntimeAliasCommand({ RuntimeName: name, Name: alias, RuntimeVersion: 'v1' })
    );
    await waitActive(
      () => new Core.GetRuntimeAliasCommand({ RuntimeName: name, Name: alias }),
      `runtime alias ${alias}`
    );
  }
  process.stdout.write(rt.Arn);
}

async function ignoreNotFound(p) {
  try {
    await p;
  } catch (e) {
    if (e?.name !== NOT_FOUND) throw e;
  }
}

async function teardownPrefix(prefix) {
  // A prefix shorter than the fixture's own literal would widen the sweep.
  if (!prefix.startsWith('cdkditrtcfg')) throw new Error(`teardown sweep refused: ${prefix}`);
  let token;
  const names = [];
  do {
    const page = await core.send(new Core.ListRuntimesCommand({ Marker: token }));
    for (const r of page.Items ?? []) {
      if (r.Name?.startsWith(prefix) && r.State !== 'PENDING_DELETION') names.push(r.Name);
    }
    token = page.NextMarker;
  } while (token);
  for (const name of names) {
    for (const alias of ['a', 'b']) {
      await ignoreNotFound(
        core.send(new Core.DeleteRuntimeAliasCommand({ RuntimeName: name, Name: alias }))
      );
    }
    await ignoreNotFound(
      core.send(new Core.DeleteRuntimeVersionCommand({ RuntimeName: name, Name: 'v1' }))
    );
    await ignoreNotFound(core.send(new Core.DeleteRuntimeCommand({ RuntimeName: name })));
  }
  process.stdout.write(String(names.length));
}

async function state(name) {
  try {
    const r = await core.send(new Core.GetRuntimeCommand({ RuntimeName: name }));
    process.stdout.write(r.State ?? 'UNKNOWN');
  } catch (e) {
    if (e?.name !== NOT_FOUND) throw e;
    process.stdout.write('GONE');
  }
}

async function fncfg(fn) {
  const r = await new LambdaClient({ region }).send(
    new GetFunctionConfigurationCommand({ FunctionName: fn })
  );
  process.stdout.write(JSON.stringify({ Runtime: r.Runtime, RuntimeConfig: r.RuntimeConfig ?? null }));
}

const [cmd, ...args] = process.argv.slice(2);
const handlers = { setup, 'teardown-prefix': teardownPrefix, state, fncfg };
if (!handlers[cmd]) {
  console.error(`unknown command: ${cmd}`);
  process.exit(2);
}
try {
  await handlers[cmd](...args);
} catch (e) {
  console.error(`runtime.mjs ${cmd} failed: ${e?.name}: ${e?.message}`);
  process.exit(1);
}
