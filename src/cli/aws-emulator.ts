/**
 * `--aws-emulator [url]` / `CDKD_AWS_EMULATOR` on every cdkd command that talks
 * to AWS for a stack (go-to-k/cdkd#6138). The `cdkd local` commands register
 * the flag themselves through cdk-local (go-to-k/cdkd#6132); this module adds
 * it to every OTHER command that declares `--profile`, and runs the flag's
 * process-wide setup from `buildProgram`'s `preAction` hook.
 *
 * Under the flag the emulator's identity is the ONLY identity:
 *
 * - every SDK client cdkd builds goes through `awsClientDefaults`, whose
 *   endpoint override (cdk-local's `getAwsEndpointOverride`, activated here)
 *   supplies the endpoint, a handler trusting the emulator's CA, and the
 *   emulator's keys — outranking `--profile`, a `--role-arn` role and the
 *   environment;
 * - `--profile`, `--role-arn` / `CDKD_ROLE_ARN`, `AWS_PROFILE` and the
 *   credential environment are dropped with one notice, so nothing resolves
 *   or assumes a real identity first (no SSO refresh, no `sts:AssumeRole`);
 * - the process environment is pointed at the emulator too
 *   (`AWS_ENDPOINT_URL`, the run's `config` / `emulator_credentials`, IMDS
 *   off), so a client that ever escaped the override resolves the emulator's
 *   endpoint and keys or none at all: it fails against the emulator and never
 *   signs a request to real AWS.
 *
 * AWS Emulator mixed mode is the one exception (go-to-k/cdkd#6150): a
 * `cdkd local` command whose `--env-vars` file excepts a service to real AWS
 * (`"AWS_ENDPOINT_URL_<SERVICE>": "real-aws"`) keeps the host's real identity,
 * for the excepted services' calls alone: every other call — cdkd's own
 * included — still goes to the emulator, signed with its keys (the process
 * default, `mixedModeEmulatorOverride`). Every non-local command stays
 * emulator-only.
 */

import { existsSync, readFileSync } from 'node:fs';
import { devNull } from 'node:os';
import { join } from 'node:path';

import type { Command } from 'commander';
import {
  DEFAULT_AWS_EMULATOR_URL,
  EMULATOR_SCRUBBED_ENV_KEYS,
  getAwsEndpointOverride,
  parseAwsEndpoint,
  readAwsEmulatorEnvVarsFile,
  realAwsServicesOf,
  readEmulatorRunFiles,
  resolveAwsEmulatorOption,
} from 'cdk-local/internal';

import { assertAwsEmulatorValue } from '../local/local-aws-wiring.js';
import { activateAwsEmulatorForCommand } from './aws-emulator-activation.js';
import { awsEmulatorOption } from './options/aws-emulator.js';
import { setAwsEndpointOverrideSource } from '../utils/aws-client-defaults.js';
import {
  getLogger,
  isStdoutReservedForPayload,
  releaseStdoutForPayload,
  reserveStdoutForPayload,
} from '../utils/logger.js';
import { safeMsg } from '../utils/display-safe.js';
import { setPasteableAwsCaBundle } from '../utils/pasteable-aws-profile.js';
import { setChildProcessAwsEnv } from '../utils/child-process-aws-env.js';

/** The command whose subtree registers `--aws-emulator` through cdk-local. */
const LOCAL_COMMAND = 'local';

/** The credential environment the flag drops, beyond cdk-local's scrubbed set. */
const CREDENTIAL_ENV_KEYS = [
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
] as const;

/**
 * Add `--aws-emulator` to every command declaring `--profile` — the commands
 * that talk to AWS — outside the `cdkd local` subtree, which carries its own.
 * Walking the built tree (as `guardStackRegionOptions` does) is what keeps a
 * command added later from silently missing the flag.
 */
export function addAwsEmulatorOptions(cmd: Command): void {
  for (const sub of cmd.commands) {
    if (cmd.parent === null && sub.name() === LOCAL_COMMAND) continue;
    const declares = (long: string): boolean => sub.options.some((o) => o.long === long);
    if (declares('--profile') && !declares('--aws-emulator')) sub.addOption(awsEmulatorOption());
    addAwsEmulatorOptions(sub);
  }
}

/** Does `cmd` (or an ancestor) declare `--aws-emulator`? */
function declaresAwsEmulator(cmd: Command): boolean {
  for (let c: Command | null = cmd; c !== null; c = c.parent) {
    if (c.options.some((o) => o.long === '--aws-emulator')) return true;
  }
  return false;
}

/** True when `cmd` sits under `cdkd local` (which activates the wiring itself). */
function underLocalCommand(cmd: Command): boolean {
  for (let c: Command | null = cmd; c !== null; c = c.parent) {
    if (c.parent !== null && c.parent.parent === null && c.name() === LOCAL_COMMAND) return true;
  }
  return false;
}

/** Clear `--<attr>` on `cmd` and every ancestor that declares it. */
function clearOption(cmd: Command, attr: string): boolean {
  let cleared = false;
  for (let c: Command | null = cmd; c !== null; c = c.parent) {
    if (c.getOptionValue(attr) !== undefined) {
      c.setOptionValueWithSource(attr, undefined, 'default');
      cleared = true;
    }
  }
  return cleared;
}

/**
 * The `preAction` half, for every action command. Refuses a malformed
 * `--aws-emulator` value on any command declaring the flag (the `cdkd local`
 * ones included). A set flag drops the real identity and points the
 * environment at the emulator; on the non-local commands it also activates
 * the emulator wiring.
 *
 * SYNCHRONOUS, and run BEFORE the hook records or mirrors `--profile`, so
 * that work sees the cleared options in the same tick. Returns the activation
 * still to await (a health probe, so asynchronous) for a non-local command
 * under the flag, else `undefined`; await it before any AWS client is built.
 */
export function prepareAwsEmulatorForCommand(
  actionCommand: Command
): (() => Promise<void>) | undefined {
  if (!declaresAwsEmulator(actionCommand)) return undefined;
  const flag = actionCommand.optsWithGlobals<{ awsEmulator?: string | boolean }>().awsEmulator;
  assertAwsEmulatorValue(flag);
  const value = resolveAwsEmulatorOption(flag);
  if (value === undefined) return undefined;
  // `cdkd local` keeps its own activation (inside each command's handler, or
  // cdk-local's) and its `--role-arn` order (go-to-k/cdkd#6132): the role hop
  // runs against the emulator's STS there, and the override outranks the
  // role's keys anyway. Everything else applies to it too.
  const local = underLocalCommand(actionCommand);
  // Mixed mode: the real identity is kept for the excepted services' calls, so
  // no credential is dropped and the environment is not pointed at the
  // emulator (a client that escaped the emulator default would carry a
  // real-key signature there). The command's activation validates the
  // exceptions and starts the re-signing wiring.
  const endpoint = parseAwsEndpoint(
    value === true ? DEFAULT_AWS_EMULATOR_URL : value,
    '--aws-emulator'
  );
  // cdk-local's spelling: `localhost` becomes `127.0.0.1`, so S3 stays path-style.
  const url =
    endpoint.hostname === 'localhost'
      ? endpoint.url.replace('//localhost', '//127.0.0.1')
      : endpoint.url;
  if (local && localCommandIsMixedMode(actionCommand)) {
    keepHostClientsOnRealAws();
    pointChildProcessesAtEmulator(url, endpoint.port);
    return undefined;
  }

  const ignored: string[] = [];
  if (clearOption(actionCommand, 'profile')) ignored.push('--profile');
  if (!local && clearOption(actionCommand, 'roleArn')) ignored.push('--role-arn');
  const scrubbed = [
    ...(local ? [] : ['CDKD_ROLE_ARN']),
    ...EMULATOR_SCRUBBED_ENV_KEYS,
    ...CREDENTIAL_ENV_KEYS,
  ];
  for (const key of scrubbed) {
    if (process.env[key] !== undefined) {
      if (process.env[key] !== '') ignored.push(key);
      delete process.env[key];
    }
  }
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('AWS_ENDPOINT_URL') || key === 'AWS_IGNORE_CONFIGURED_ENDPOINT_URLS') {
      if (process.env[key] !== '') ignored.push(key);
      delete process.env[key];
    }
  }
  if (ignored.length > 0) {
    const names = ignored.join(', ');
    onStderr(() =>
      getLogger().info(
        safeMsg`--aws-emulator: ignoring ${names}; every AWS call uses the emulator's keys.`
      )
    );
  }

  // A typed `--ca-bundle` (the `cdkd local` commands) is the CA the run trusts.
  const caBundle = actionCommand.optsWithGlobals<{ caBundle?: string }>().caBundle;
  pointEnvironmentAtEmulator(url, endpoint.port, caBundle);
  if (local) return undefined;
  setAwsEndpointOverrideSource(getAwsEndpointOverride);
  return () => onStderr(() => activateAwsEmulatorForCommand(flag));
}

/**
 * Mixed mode signs the excepted services' cdkd-side calls with the REAL
 * identity, so they must go to real AWS: a shell `AWS_ENDPOINT_URL*` (or a
 * profile's `endpoint_url`) aimed at the emulator would carry a real-key
 * signature to it. The containers never get these (cdk-local's mixed wiring
 * forwards no host endpoint); the host clients ignore them too, with one
 * notice. Every emulator-bound client sets its endpoint explicitly, which this
 * does not touch.
 */
function keepHostClientsOnRealAws(): void {
  const ignored: string[] = [];
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('AWS_ENDPOINT_URL')) {
      if (process.env[key] !== '') ignored.push(key);
      delete process.env[key];
    }
  }
  process.env['AWS_IGNORE_CONFIGURED_ENDPOINT_URLS'] = 'true';
  if (ignored.length > 0) {
    const names = ignored.join(', ');
    onStderr(() =>
      getLogger().info(
        safeMsg`--aws-emulator (mixed mode): ignoring ${names}; the "real-aws" exceptions go to real AWS.`
      )
    );
  }
}

/**
 * True when a `cdkd local` command's `--env-vars` file excepts at least one
 * service to real AWS with `"real-aws"`. One on the bare `AWS_ENDPOINT_URL`
 * names no service, and the old `"aws-emulator"` value is no exception: such
 * a run stays full-emulator here (fail closed), and the command's activation
 * refuses the value.
 */
function localCommandIsMixedMode(actionCommand: Command): boolean {
  const envVars = actionCommand.optsWithGlobals<{ envVars?: unknown }>().envVars;
  if (typeof envVars !== 'string' || envVars === '') return false;
  // `readAwsEmulatorEnvVarsFile` reads through cdk-local's
  // `readEnvVarsFileText`: a pipe-backed path is read once and kept, so the
  // command's own read still gets the text.
  return realAwsServicesOf(readAwsEmulatorEnvVarsFile(envVars).exceptions).length > 0;
}

/**
 * Run `fn` with cdkd's logger off stdout. These lines print BEFORE the action
 * that reserves stdout for a payload (`synth`, `list`, `state list --json`,
 * `local invoke`, ...), so on stdout they would land inside it; on stderr they
 * are notices for every command alike. cdk-local's activation line goes
 * through cdkd's logger too (the embed config).
 */
function onStderr<T>(fn: () => T): T {
  if (isStdoutReservedForPayload()) return fn();
  reserveStdoutForPayload();
  let result: T;
  try {
    result = fn();
  } catch (err) {
    releaseStdoutForPayload();
    throw err;
  }
  if (result instanceof Promise) {
    return result.finally(releaseStdoutForPayload) as T;
  }
  releaseStdoutForPayload();
  return result;
}

/**
 * The backstop for a client built outside `awsClientDefaults` (none under
 * `src/**` today; `tests/unit/cli/aws-emulator-client-factories.test.ts`
 * enumerates them): the SDK's own environment then names the emulator's
 * endpoint, its run's config (region) and keys — or no file at all, so the
 * default chain finds no real credential.
 */
function pointEnvironmentAtEmulator(url: string, port: number, caBundle?: string): void {
  Object.assign(process.env, emulatorEnvironment(url, port, process.env));
  const run = readEmulatorRunFiles(port);
  const caPath = join(run.dir, 'ca.pem');
  const runCa = run.present && existsSync(caPath) ? caPath : devNull;
  const ca = caBundle !== undefined && caBundle !== '' ? caBundle : runCa;
  setPasteableAwsCaBundle(url.startsWith('https:') && ca !== devNull ? ca : undefined);
}

/**
 * The environment that points an AWS SDK at the emulator: its endpoint, its
 * run's `config` (region, CA) and `emulator_credentials`, or no file at all,
 * so the default chain finds no real credential. `env` decides whether the
 * run's region is added (only when it names none).
 */
function emulatorEnvironment(
  url: string,
  port: number,
  env: Readonly<Record<string, string | undefined>>
): Record<string, string> {
  const run = readEmulatorRunFiles(port);
  const runFile = (name: string): string => {
    const p = join(run.dir, name);
    return run.present && existsSync(p) ? p : devNull;
  };
  const config = runFile('config');
  const out: Record<string, string> = {
    AWS_ENDPOINT_URL: url,
    AWS_CONFIG_FILE: config,
    AWS_SHARED_CREDENTIALS_FILE: runFile('emulator_credentials'),
    AWS_EC2_METADATA_DISABLED: 'true',
  };
  // The run's region when the shell names none, so every reader agrees on it —
  // the SDK chain reads the file, while some `cdkd local` paths read only the
  // environment.
  if (!env['AWS_REGION'] && !env['AWS_DEFAULT_REGION'] && config !== devNull) {
    const region = defaultProfileRegion(readFileSync(config, 'utf8'));
    if (region !== undefined) out['AWS_REGION'] = region;
  }
  return out;
}

/**
 * Mixed mode: the CDK app's synth runs on the emulator with its keys, as in
 * full emulator mode — a `"real-aws"` exception applies to the workload and
 * to cdkd's own pre-start calls, never to synth — while cdkd's own process
 * keeps the real identity for the excepted calls.
 */
function pointChildProcessesAtEmulator(url: string, port: number): void {
  setChildProcessAwsEnv((env) => {
    for (const key of ['CDKD_ROLE_ARN', ...EMULATOR_SCRUBBED_ENV_KEYS, ...CREDENTIAL_ENV_KEYS]) {
      delete env[key];
    }
    for (const key of Object.keys(env)) {
      if (key.startsWith('AWS_ENDPOINT_URL') || key === 'AWS_IGNORE_CONFIGURED_ENDPOINT_URLS') {
        delete env[key];
      }
    }
    return Object.assign(env, emulatorEnvironment(url, port, env));
  });
}

/** The `region` of the `[default]` section of an AWS config file, if any. */
export function defaultProfileRegion(ini: string): string | undefined {
  let inDefault = false;
  for (const raw of ini.split(/\r?\n/)) {
    const line = raw.trim();
    const section = /^\[\s*(.+?)\s*\]$/.exec(line);
    if (section) {
      inDefault = section[1] === 'default' || section[1] === 'profile default';
      continue;
    }
    const kv = /^region\s*=\s*([a-z0-9-]+)\s*$/i.exec(line);
    if (inDefault && kv) return kv[1]!.toLowerCase();
  }
  return undefined;
}
