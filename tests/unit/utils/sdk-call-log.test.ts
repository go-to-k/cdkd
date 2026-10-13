/**
 * The SDK call log (`CDKD_SDK_CALL_LOG`, state schema v12's measurement
 * harness): off by default, so client configs are unchanged; on, every
 * command a REAL SDK client sends through its own logger middleware is counted
 * once per client and command, success or failure, and nothing of the input
 * or output is kept.
 */
import { Readable } from 'node:stream';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it, expect, afterEach } from 'vite-plus/test';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { awsClientDefaults } from '../../../src/utils/aws-client-defaults.js';
import {
  SDK_CALL_LOG_ENV,
  resetSdkCallCounts,
  sanitizedArgv,
  sdkCallCounts,
} from '../../../src/utils/sdk-call-log.js';

const MODULE = resolve(__dirname, '../../../src/utils/sdk-call-log.ts');

/** Run one real node process that loads the harness, counts one call and exits. */
function runProcess(file: string, args: string[]): void {
  const script = [
    `const m = await import(${JSON.stringify(MODULE)});`,
    `const { logger } = m.sdkCallLogConfig();`,
    `logger.info({ clientName: 'STSClient', commandName: 'GetCallerIdentityCommand', input: { Secret: 'in-input-value' } });`,
  ].join('\n');
  // Under `-e` the first argument takes `argv[1]`, the script's slot in a real
  // `node dist/cli.js ...` run, so a placeholder stands in for `cli.js`.
  execFileSync(process.execPath, ['--input-type=module', '-e', script, 'cli.js', ...args], {
    env: { ...process.env, [SDK_CALL_LOG_ENV]: file },
  });
}

/** A request handler that answers every request without a network. */
function fakeHandler(status: number, firstStatus?: number): { handle: () => Promise<unknown> } {
  let first = firstStatus;
  return {
    handle: () => {
      const code = first ?? status;
      first = undefined;
      return Promise.resolve({
        response: {
          statusCode: code,
          headers: { 'content-type': 'text/xml' },
          body: Readable.from([
            Buffer.from(
              code === 200
                ? '<GetCallerIdentityResponse><GetCallerIdentityResult><Account>123456789012</Account><Arn>arn:aws:iam::123456789012:user/x</Arn><UserId>X</UserId></GetCallerIdentityResult></GetCallerIdentityResponse>'
                : '<ErrorResponse><Error><Code>AccessDenied</Code><Message>no</Message></Error></ErrorResponse>'
            ),
          ]),
        },
      });
    },
  };
}

const client = (status: number, firstStatus?: number): STSClient =>
  new STSClient({
    ...awsClientDefaults(),
    region: 'us-east-1',
    credentials: { accessKeyId: 'AKIAFAKE', secretAccessKey: 'fake' },
    requestHandler: fakeHandler(status, firstStatus) as never,
    maxAttempts: firstStatus === undefined ? 1 : 3,
  });

afterEach(() => {
  delete process.env[SDK_CALL_LOG_ENV];
  resetSdkCallCounts();
});

describe('the SDK call log', () => {
  it('is off by default: the defaults carry no logger and nothing is counted', async () => {
    expect(Object.hasOwn(awsClientDefaults(), 'logger')).toBe(false);
    await client(200).send(new GetCallerIdentityCommand({}));
    expect(sdkCallCounts()).toEqual({});
  });

  it('counts each command once per client and command, success and failure alike', async () => {
    process.env[SDK_CALL_LOG_ENV] = '/dev/null';
    await client(200).send(new GetCallerIdentityCommand({}));
    await client(200).send(new GetCallerIdentityCommand({}));
    await client(403)
      .send(new GetCallerIdentityCommand({}))
      .catch(() => undefined);
    expect(sdkCallCounts()).toEqual({ 'STSClient.GetCallerIdentityCommand': 3 });
  });

  it('a retried command counts once, and only the two names are kept', async () => {
    process.env[SDK_CALL_LOG_ENV] = '/dev/null';
    // A 500 first, retried by the SDK, then a success: one command.
    await client(200, 500).send(new GetCallerIdentityCommand({}));
    const counts = sdkCallCounts();
    expect(counts).toEqual({ 'STSClient.GetCallerIdentityCommand': 1 });
    expect(JSON.stringify(counts)).not.toContain('123456789012');
  });

  it('each process APPENDS its own line: pid, sanitized argv, ISO time, counts', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'cdkd-call-log-')), 'calls.jsonl');
    runProcess(file, ['deploy', 'StackA', '--region', 'us-east-1']);
    runProcess(file, ['destroy', 'StackA', '--force']);
    const lines = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as {
      pid: number;
      argv: string[];
      at: string;
      counts: Record<string, number>;
    });
    expect(lines).toHaveLength(2);
    expect(lines[0]!.argv).toEqual(['deploy', 'StackA', '--region']);
    expect(lines[1]!.argv).toEqual(['destroy', 'StackA', '--force']);
    expect(lines[0]!.pid).not.toBe(lines[1]!.pid);
    for (const line of lines) {
      expect(new Date(line.at).toISOString()).toBe(line.at);
      expect(line.counts).toEqual({ 'STSClient.GetCallerIdentityCommand': 1 });
    }
    expect(readFileSync(file, 'utf8')).not.toContain('in-input-value');
  });

  it('never writes a flag value: a secret passed on the command line is not in the log', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'cdkd-call-log-')), 'calls.jsonl');
    const SECRET = 'fake-secret-Zq9x7Kp2';
    runProcess(file, [
      'deploy',
      'StackA',
      '--parameters',
      `Password=${SECRET}`,
      `--context=token=${SECRET}`,
      '-c',
      SECRET,
      `-anode app.js ${SECRET}`,
      `-c${SECRET}=v`,
      `-yc${SECRET}=v`,
      `--weird name=${SECRET}`,
    ]);
    const body = readFileSync(file, 'utf8');
    expect(body).not.toContain(SECRET);
    expect((JSON.parse(body) as { argv: string[] }).argv).toEqual([
      'deploy',
      'StackA',
      '--parameters',
      '--context',
      '-c',
      '-a',
      '-c',
      '-y',
    ]);
  });

  it('sanitizedArgv keeps the leading positionals and flag names only', () => {
    expect(sanitizedArgv(['state', 'show', 'S', '--json'])).toEqual(['state', 'show', 'S', '--json']);
    expect(sanitizedArgv(['deploy', '--all', 'S2', '--x=1', 'v', '-'])).toEqual([
      'deploy',
      '--all',
      '--x',
    ]);
  });
});
