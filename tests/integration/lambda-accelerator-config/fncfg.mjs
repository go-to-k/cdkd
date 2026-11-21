// Reads a function's AcceleratorConfig through the fixture's own SDK client,
// which models the field (an older AWS CLI may drop it from its output).
//
//   node fncfg.mjs <function-name> [qualifier]
//     -> {"AcceleratorConfig":{...}|null,"State":..,"LastUpdateStatus":..}
import { LambdaClient, GetFunctionConfigurationCommand } from '@aws-sdk/client-lambda';

const [functionName, qualifier] = process.argv.slice(2);
if (!functionName) {
  console.error('usage: node fncfg.mjs <function-name> [qualifier]');
  process.exit(2);
}

const client = new LambdaClient({ region: process.env.AWS_REGION ?? 'us-east-1' });
const cfg = await client.send(
  new GetFunctionConfigurationCommand({
    FunctionName: functionName,
    ...(qualifier ? { Qualifier: qualifier } : {}),
  })
);
process.stdout.write(
  JSON.stringify({
    AcceleratorConfig: cfg.AcceleratorConfig ?? null,
    State: cfg.State ?? null,
    LastUpdateStatus: cfg.LastUpdateStatus ?? null,
  })
);
