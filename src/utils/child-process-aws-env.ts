/**
 * The AWS environment a child process cdkd starts (the CDK app's synth)
 * runs with, when it must differ from cdkd's own process environment.
 *
 * AWS Emulator mixed mode (go-to-k/cdkd#6150): `--aws-emulator` sends every
 * AWS call to the emulator, and a `"real-aws"` exception applies only to the
 * workload's calls and cdkd's own pre-start calls — never to synth. cdkd's own
 * process keeps the real identity for those excepted calls (they escape the
 * emulator default through `runWithRealAws` / `realAws`), so the synth child
 * gets the emulator's environment and keys here instead, exactly as in full
 * emulator mode, where the process environment itself is pointed at the
 * emulator. Registered by `src/cli/aws-emulator.ts`; `undefined` otherwise.
 */
let transform: ((env: Record<string, string>) => Record<string, string>) | undefined;

/** Install (or clear) the transform {@link childProcessAwsEnv} applies. */
export function setChildProcessAwsEnv(
  fn: ((env: Record<string, string>) => Record<string, string>) | undefined
): void {
  transform = fn;
}

/** `env` with the registered transform applied (a new object), or `env` itself when none is. */
export function childProcessAwsEnv(env: Record<string, string>): Record<string, string> {
  return transform ? transform({ ...env }) : env;
}
