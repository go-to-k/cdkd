import { Option } from 'commander';
import { awsEmulatorEnvName } from 'cdk-local/internal';

/**
 * A fresh `--aws-emulator [url]` option for one non-`local` command
 * (go-to-k/cdkd#6138); commander binds an `Option` to one command, so
 * `addAwsEmulatorOptions` (`src/cli/aws-emulator.ts`) builds one per command.
 * The `cdkd local` commands take cdk-local's own declaration.
 */
export function awsEmulatorOption(): Option {
  return new Option(
    '--aws-emulator [url]',
    'Run against a local AWS Emulator (default https://127.0.0.1:9297; the port selects ' +
      "~/.aws/emulator/<port>/): every AWS call uses the emulator's endpoint, CA and keys " +
      `only; --profile, --role-arn and credential env vars are ignored (env: ${awsEmulatorEnvName()})`
  );
}
