import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

/**
 * go-to-k/cdkd#4199: a value that is inert to the SHELL can still be acted on
 * by the aws CLI itself. A `file://` / `fileb://` prefix makes the CLI send a
 * LOCAL file's contents as the parameter (and `http(s)://` makes aws-cli v1
 * fetch the URL); a leading `-` after a list-valued flag is parsed as an
 * option, so `--endpoint-url=http://...` redirected the request. Both were
 * measured against aws-cli 2.35.13. The gate every pasteable `aws ...` value
 * goes through (`pasteableArg`, behind `renderDisableCommand` and the
 * `pasteableAwsCommand` tag) withholds such a value, and so does the one
 * hand-built `aws` hint that names a state-borne value (the scheduler's manual
 * delete).
 */

const { rdsSend, schedulerSend, childLogger } = vi.hoisted(() => ({
  rdsSend: vi.fn(),
  schedulerSend: vi.fn(),
  childLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  },
}));
childLogger.child.mockReturnValue(childLogger);

vi.mock('@aws-sdk/client-rds', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-rds')>('@aws-sdk/client-rds');
  return {
    ...actual,
    RDSClient: vi.fn().mockImplementation(() => ({
      send: rdsSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('@aws-sdk/client-scheduler', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-scheduler')>(
    '@aws-sdk/client-scheduler'
  );
  return {
    ...actual,
    SchedulerClient: vi.fn().mockImplementation(() => ({
      send: schedulerSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    child: () => childLogger,
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import {
  type PasteableAwsCommand,
  AWS_CLI_ACTIVE_ARG,
  WITHHELD_AWS_COMMAND,
  isAwsCliLiteral,
  pasteableAwsCommand,
  renderDisableCommand,
} from '../../../src/provisioning/replacement-protection-advice.js';
import { isInertUnquoted, shellQuote } from '../../../src/utils/pasteable-command.js';
import { RDSDBProxyTargetGroupProvider } from '../../../src/provisioning/providers/rds-dbproxy-targetgroup-provider.js';
import { SchedulerScheduleProvider } from '../../../src/provisioning/providers/scheduler-schedule-provider.js';

/**
 * Every value here is inert to the shell, so `PASTE_ARG_UNSAFE` admits it and
 * only the aws-CLI arm can refuse it — asserted per value below, so a case
 * cannot pass for the shell arm's reason.
 */
const CLI_ACTIVE = [
  ['a file:// prefix', 'file:///etc/passwd'],
  ['a fileb:// prefix', 'fileb://secret.bin'],
  ['an http:// prefix', 'http://127.0.0.1:9/x'],
  ['an https:// prefix', 'https://example.com/x'],
  ['an upper-case prefix', 'FILE:///etc/passwd'],
  ['a mixed-case prefix', 'Fileb://x'],
  ['an upper-case https:// prefix', 'HTTPS://example.com/x'],
  ['a shorthand @= file load mid-word', 'x,Arn@=file:///etc/passwd'],
  ['a shorthand @= at the start', 'Arn@=fileb://x'],
  ['a leading --option', '--endpoint-url=http://127.0.0.1:9'],
  ['a leading -', '-db'],
  ['a bare -', '-'],
] as const;

/** Real-id shapes the arm must NOT take: a medial `-`, `//`, scheme, `@` or `=`. */
const ADMITTED = [
  'my-db',
  'db--2',
  'arn:aws:rds:us-east-1:123456789012:db:file-db',
  'files',
  'file:/x',
  'ftp://x', // a scheme the CLI does not read
  's3://bucket/key',
  'prefix/file://x',
  'user@example.com',
  'k=v',
  'a@b=c',
] as const;

describe('AWS_CLI_ACTIVE_ARG (go-to-k/cdkd#4199)', () => {
  it.each(CLI_ACTIVE)('refuses %s, which the shell alone leaves inert', (_label, value) => {
    expect(isInertUnquoted(value), value).toBe(true);
    expect(AWS_CLI_ACTIVE_ARG.test(value), value).toBe(true);
    expect(isAwsCliLiteral(value), value).toBe(false);
  });

  it.each(ADMITTED)('admits %s', (value) => {
    expect(isAwsCliLiteral(value), value).toBe(true);
  });
});

describe('pasteableArg withholds a value the aws CLI acts on (go-to-k/cdkd#4199)', () => {
  const aws = pasteableAwsCommand();

  it.each(CLI_ACTIVE)('pasteableAwsCommand withholds the whole command for %s', (_label, value) => {
    const cmd = aws`aws logs describe-log-groups --log-group-name-prefix ${value}`;
    expect(cmd.text).toBeUndefined();
    expect(cmd.render()).toBe(WITHHELD_AWS_COMMAND);
  });

  it.each(CLI_ACTIVE)('renderDisableCommand renders no command for %s', (_label, value) => {
    expect(
      renderDisableCommand({
        before: 'aws logs delete-deletion-protection --log-group-identifier',
        identifier: value,
      })
    ).toBe('');
  });

  it.each(ADMITTED)('still names %s', (value) => {
    // `shellQuote` leaves a plain value bare and quotes one holding `=`.
    const shown = shellQuote(value);
    expect(aws`aws rds describe-db-instances --db-instance-identifier ${value}`.text).toBe(
      `aws rds describe-db-instances --db-instance-identifier ${shown}`
    );
    expect(
      renderDisableCommand({
        before: 'aws logs delete-deletion-protection --log-group-identifier',
        identifier: value,
      })
    ).toBe(`aws logs delete-deletion-protection --log-group-identifier ${shown}`);
  });
});

describe('a list-valued flag built one id at a time (the RDS DB proxy deregister shape)', () => {
  // `rds-dbproxy-targetgroup-provider.ts` builds its manual deregister command
  // exactly this way. Its own `RDS_TARGET_IDENTIFIER` refuses a leading `-`
  // before the command is built (go-to-k/cdkd#3945, pinned below), so this is
  // the gate's own guarantee for the shape, where a later word is an OPTION.
  const aws = pasteableAwsCommand();
  const build = (ids: readonly string[]): PasteableAwsCommand => {
    let targets = aws``;
    targets = aws`${targets} --db-instance-identifiers`;
    for (const id of ids) targets = aws`${targets} ${id}`;
    return aws`aws rds deregister-db-proxy-targets --db-proxy-name ${'p'}${targets}`;
  };

  it('names plain ids', () => {
    expect(build(['i-1', 'i-2']).text).toBe(
      'aws rds deregister-db-proxy-targets --db-proxy-name p --db-instance-identifiers i-1 i-2'
    );
  });

  it('withholds the command when a later id would parse as an option', () => {
    expect(build(['i-1', '--endpoint-url=http://127.0.0.1:9']).render()).toBe(
      WITHHELD_AWS_COMMAND
    );
  });

  it('the provider refuses such an id before building any command', async () => {
    rdsSend.mockReset();
    const error = await new RDSDBProxyTargetGroupProvider()
      .create('TG', 'AWS::RDS::DBProxyTargetGroup', {
        DBProxyName: 'AuroraProxy',
        DBInstanceIdentifiers: ['i-1', '--endpoint-url=http://127.0.0.1:9'],
      })
      .then(
        () => new Error('create resolved'),
        (e: unknown) => e as Error
      );
    expect(error.message).toContain('is not a list of RDS DB identifiers');
    expect(rdsSend).not.toHaveBeenCalled();
  });
});

describe("the scheduler's manual delete hint (a hand-built aws command)", () => {
  const TYPE = 'AWS::Scheduler::Schedule';

  beforeEach(() => {
    schedulerSend.mockReset();
    childLogger.warn.mockClear();
  });

  const warnedFor = async (name: string): Promise<string> => {
    schedulerSend.mockResolvedValueOnce({});
    await new SchedulerScheduleProvider().delete('Sched', name, TYPE, undefined);
    return childLogger.warn.mock.calls.map((c) => String(c[0])).join('\n');
  };

  it('names a plain schedule', async () => {
    expect(await warnedFor('my-sched')).toContain(
      "aws scheduler delete-schedule --name my-sched --group-name '<group>'"
    );
  });

  // The negative control over the same admitted shapes the gate cases use, so
  // the scheduler's own conjunct cannot be wider than the gate's.
  it.each(ADMITTED)('still names the admitted shape %s', async (value) => {
    expect(await warnedFor(value)).toContain(
      `aws scheduler delete-schedule --name ${shellQuote(value)} --group-name '<group>'`
    );
  });

  it.each(CLI_ACTIVE)('falls back to the console for %s', async (_label, value) => {
    const warned = await warnedFor(value);
    expect(warned).not.toContain('aws scheduler delete-schedule');
    expect(warned).toContain('delete it manually via the console');
    // Nor is the value shown beside the hint for an operator to copy (a
    // one- or two-character value would match the prose's own hyphens).
    if (value.length > 3) expect(warned).not.toContain(value);
  });
});
