/**
 * The provider sites of issue
 * [#4239](https://github.com/go-to-k/cdkd/issues/4239): a pasted line with
 * cdkd's own ` -> ` before a value the template or AWS chose redirected into a
 * file named by that value. Each line now says `from <a> to <b>` (or `with
 * value`), which carries no shell operator.
 *
 * Every case drives the provider with a value naming one of the paste
 * harness's decoys, reads the emitted line, and pastes it through
 * `spansThatRun` under bash and zsh. The non-provider sites are in
 * `tests/unit/utils/arrow-paste-sites-4239.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const logLines = vi.hoisted(() => [] as string[]);
vi.mock('../../../src/utils/logger.js', () => {
  const capture = (...args: unknown[]): void => {
    logLines.push(args.map(String).join(' '));
  };
  const fns = {
    setLevel: vi.fn(),
    debug: capture,
    info: capture,
    warn: capture,
    error: capture,
    child: () => fns,
  };
  return { getLogger: () => fns };
});

/** Every SDK call a case reaches; each case scripts it. */
const send = vi.hoisted(() => vi.fn());
const client = vi.hoisted(() => ({
  send,
  config: { region: () => Promise.resolve('us-east-1') },
}));
vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({ iam: client,
    s3: client,
    acm: client,
    lambdaMicrovms: client,
    cloudWatchLogs: client, }),
}));
vi.mock('@aws-sdk/client-kinesis', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-kinesis')>();
  return { ...actual, KinesisClient: vi.fn().mockImplementation(() => client) };
});
vi.mock('@aws-sdk/client-codecommit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-codecommit')>();
  return { ...actual, CodeCommitClient: vi.fn().mockImplementation(() => client) };
});

import { IAMRoleProvider } from '../../../src/provisioning/providers/iam-role-provider.js';
import { S3BucketProvider } from '../../../src/provisioning/providers/s3-bucket-provider.js';
import { KinesisStreamProvider } from '../../../src/provisioning/providers/kinesis-provider.js';
import { LambdaMicrovmImageProvider } from '../../../src/provisioning/providers/lambda-microvm-image-provider.js';
import { ACMCertificateProvider } from '../../../src/provisioning/providers/acm-certificate-provider.js';
import { LogsLogGroupProvider } from '../../../src/provisioning/providers/logs-loggroup-provider.js';
import { RepositoryDoesNotExistException } from '@aws-sdk/client-codecommit';
import { CodeCommitRepositoryProvider } from '../../../src/provisioning/providers/codecommit-repository-provider.js';
import {
  PASTE_PAYLOADS,
  spansThatRun,
  withPasteDir,
} from '../utils/paste-harness.js';

/** The one line of the log starting with `prefix`, asserted present. */
function lineStarting(prefix: string): string {
  const found = logLines.filter((l) => l.startsWith(prefix));
  expect(found, `no single ${JSON.stringify(prefix)} line among ${JSON.stringify(logLines)}`).toHaveLength(1);
  return found[0]!;
}

/** The paste property, asserted BEFORE each spelling pin. */
function expectInert(text: string): void {
  withPasteDir((dir) => {
    expect(spansThatRun(text, dir)).toEqual([]);
  });
}

/**
 * The before/after pair inside a line's parentheses, as an operator selects
 * it (a drag between the brackets). The harness splits a line at sentence and
 * clause breaks only, and a `(` or `)` around the pair is a syntax error that
 * stops both shells before any redirect, so such a line pasted whole was inert
 * even on the pre-fix spelling; the pair on its own truncated its right side.
 */
function pairInParens(text: string): string {
  const m = /\(([^()]* (?:to|->) [^()]*)\)/.exec(text);
  expect(m, `no parenthesized pair in ${JSON.stringify(text)}`).not.toBeNull();
  return m![1]!;
}

/** Run `p`, which may reject once the line under test is logged. */
async function settle(p: Promise<unknown>): Promise<unknown> {
  try {
    return await p;
  } catch (error) {
    return error;
  }
}

const stop = (): Promise<never> => Promise.reject(new Error('stop here'));

beforeEach(() => {
  logLines.length = 0;
  send.mockReset();
  send.mockImplementation(stop);
});

describe('a pasted provider ` -> ` line redirects nothing (#4239)', () => {
  it('iam-role: the RoleName replacement line', async () => {
    await settle(
      new IAMRoleProvider().update(
        'Role',
        'old-role',
        'AWS::IAM::Role',
        { RoleName: 'logicalId', AssumeRolePolicyDocument: {} },
        { RoleName: 'old-role', AssumeRolePolicyDocument: {} }
      )
    );
    const line = lineStarting('RoleName changed, replacing role: ');
    expectInert(line);
    expectInert(pairInParens(line));
    expect(line).toContain('(RoleName: from old-role to logicalId)');
  }, 60_000);

  it('s3-bucket: the bucket-name replacement line', async () => {
    await settle(
      new S3BucketProvider().update(
        'B',
        'old-bucket',
        'AWS::S3::Bucket',
        { BucketName: 'bucket' },
        { BucketName: 'old-bucket' }
      )
    );
    const line = lineStarting('Bucket name changed');
    expectInert(line);
    expectInert(pairInParens(line));
    expect(line).toBe('Bucket name changed (from old-bucket to bucket), replacement required');
  }, 60_000);

  it('lambda-microvm-image: the create-only Name refusal', async () => {
    const error = (await settle(
      new LambdaMicrovmImageProvider().update(
        'Img',
        'arn:img',
        'AWS::Lambda::MicrovmImage',
        { Name: 'name' },
        { Name: 'old-name' }
      )
    )) as Error;
    expect(error).toBeInstanceOf(Error);
    expectInert(error.message);
    expectInert(pairInParens(error.message));
    expect(error.message).toContain('(from old-name to name); this requires replacement.');
  }, 60_000);

  it('lambda-microvm-image: an absent recorded Name is a word', async () => {
    const error = (await settle(
      new LambdaMicrovmImageProvider().update('Img', 'arn:img', 'AWS::Lambda::MicrovmImage', { Name: 'name' }, {})
    )) as Error;
    expectInert(error.message);
    expectInert(pairInParens(error.message));
    expect(error.message).toContain('(from no value to name); this requires replacement.');
  }, 60_000);

  it('kinesis: the stream-mode switch line', async () => {
    send.mockImplementation((cmd: { constructor: { name: string } }) =>
      cmd.constructor.name === 'DescribeStreamSummaryCommand'
        ? Promise.resolve({ StreamDescriptionSummary: { StreamARN: 'arn:stream' } })
        : stop()
    );
    await settle(
      new KinesisStreamProvider().update(
        'S',
        'stream',
        'AWS::Kinesis::Stream',
        { StreamModeDetails: { StreamMode: 'name' } },
        { StreamModeDetails: { StreamMode: 'PROVISIONED' } }
      )
    );
    const line = lineStarting('Switching stream mode for stream: ');
    expectInert(line);
    expect(line).toBe('Switching stream mode for stream: from PROVISIONED to name');
  }, 60_000);

  // go-to-k/cdkd#1710: a non-numeric RetentionPeriodHours is refused before
  // any call, so only a number reaches this line.
  it('kinesis: the retention line', async () => {
    await settle(
      new KinesisStreamProvider().update(
        'S',
        'stream',
        'AWS::Kinesis::Stream',
        { RetentionPeriodHours: '48' },
        {}
      )
    );
    const line = lineStarting('Updating retention period for stream: ');
    expectInert(line);
    expect(line).toBe('Updating retention period for stream: from 24 to 48');
    await expect(
      new KinesisStreamProvider().update(
        'S',
        'stream',
        'AWS::Kinesis::Stream',
        { RetentionPeriodHours: 'id' },
        {}
      )
    ).rejects.toThrow(/RetentionPeriodHours must be a number/);
  }, 60_000);

  it('kinesis: the shard-count line', async () => {
    await settle(
      new KinesisStreamProvider().update(
        'S',
        'stream',
        'AWS::Kinesis::Stream',
        { ShardCount: 4 },
        { ShardCount: 2 }
      )
    );
    const line = lineStarting('Updating shard count for stream: ');
    expectInert(line);
    expect(line).toBe('Updating shard count for stream: from 2 to 4');
  }, 60_000);

  it.each([
    { previous: 1024, shown: 'from 1024 to 2048' },
    // An absent recorded size is a word, not `undefined`.
    { previous: undefined, shown: 'from no value to 2048' },
  ])('kinesis: the max-record-size line ($shown)', async ({ previous, shown }) => {
    await settle(
      new KinesisStreamProvider().update(
        'S',
        'stream',
        'AWS::Kinesis::Stream',
        { MaxRecordSizeInKiB: 2048 },
        previous === undefined ? {} : { MaxRecordSizeInKiB: previous }
      )
    );
    const line = lineStarting('Updating max record size for stream: ');
    expectInert(line);
    expect(line).toBe(`Updating max record size for stream: ${shown}`);
  }, 60_000);

  it('acm-certificate: the DNS validation record row', () => {
    const rendered = (
      new ACMCertificateProvider() as unknown as {
        renderValidationOptions: (v: unknown[]) => string | undefined;
      }
    ).renderValidationOptions([
      {
        DomainName: 'example.com',
        ValidationMethod: 'DNS',
        ResourceRecord: { Type: 'CNAME', Name: '_x.example.com.', Value: 'id' },
      },
    ]);
    expect(rendered).toBeDefined();
    expectInert(rendered!);
    expect(rendered).toContain('  example.com — CNAME _x.example.com. with value id');
  }, 60_000);

  it('codecommit-repository: the rename line', async () => {
    send.mockImplementation((cmd: { constructor: { name: string } }) => {
      switch (cmd.constructor.name) {
        case 'GetRepositoryCommand':
          return Promise.resolve({ repositoryMetadata: { repositoryId: 'r-1' } });
        case 'UpdateRepositoryNameCommand':
          return Promise.resolve({});
        default:
          return stop();
      }
    });
    await settle(
      new CodeCommitRepositoryProvider().update(
        'Repo',
        'old-repo',
        'AWS::CodeCommit::Repository',
        { RepositoryName: 'name' },
        { RepositoryName: 'old-repo' }
      )
    );
    const line = lineStarting('Renamed CodeCommit Repository ');
    expectInert(line);
    expect(line).toBe('Renamed CodeCommit Repository from old-repo to name');
  }, 60_000);
});

describe('the other provider arms (#4252 review)', () => {
  it('iam-role: the Path-only refusal (#4739)', async () => {
    const error = await settle(
      new IAMRoleProvider().update(
        'Role',
        'role',
        'AWS::IAM::Role',
        { RoleName: 'role', Path: '/id/', AssumeRolePolicyDocument: {} },
        { RoleName: 'role', Path: '/name/', AssumeRolePolicyDocument: {} }
      )
    );
    // The paths are now named in the thrown refusal, not a replacement line.
    // An IAM Path starts and ends with `/`, so the pre-fix redirect target
    // was a directory: defence in depth, as the RoleName arm is not.
    const text = (error as Error).message;
    expectInert(text);
    expect(text).toContain('Path changed from /name/ to /id/');
  }, 60_000);

  it('codecommit-repository: the rename a previous attempt already applied', async () => {
    send.mockImplementation((cmd: { constructor: { name: string }; input: Record<string, unknown> }) => {
      if (cmd.constructor.name === 'GetRepositoryCommand') {
        return cmd.input['repositoryName'] === 'name'
          ? Promise.resolve({ repositoryMetadata: { repositoryId: 'r-1' } })
          : Promise.reject(
              new RepositoryDoesNotExistException({ message: 'does not exist', $metadata: {} })
            );
      }
      return stop();
    });
    await settle(
      new CodeCommitRepositoryProvider().update(
        'Repo',
        'old-repo',
        'AWS::CodeCommit::Repository',
        { RepositoryName: 'name' },
        { RepositoryName: 'old-repo' },
        { recordedAttributes: { RepositoryId: 'r-1' } } as never
      )
    );
    const line = logLines.find((l) => l.endsWith(' already applied by a previous attempt'));
    expect(line, JSON.stringify(logLines)).toBeDefined();
    expectInert(line!);
    expect(line).toBe('Rename from old-repo to name already applied by a previous attempt');
  }, 60_000);

  it('logs-loggroup: the LogGroupClass refusal', async () => {
    // `normalizeClass` passes any non-empty string through, so the template
    // chooses the right side. A plain identifier prints bare.
    const error = (await settle(
      new LogsLogGroupProvider().update(
        'Lg',
        '/lg',
        'AWS::Logs::LogGroup',
        { LogGroupClass: 'name' },
        { LogGroupClass: 'STANDARD' }
      )
    )) as Error;
    expect(error).toBeInstanceOf(Error);
    expectInert(error.message);
    expectInert(pairInParens(error.message));
    expect(error.message).toContain('the LogGroupClass (from STANDARD to name) cannot be changed');
  }, 60_000);

  // A value that is not a plain identifier is DESCRIBED, never shown. cdkd
  // used to put its OWN `'...'` around it, which a `'` in it closed; a
  // JSON `"..."` would still run a `$( )` or backtick. Every harness payload
  // plus the one that measured the `'` breakout, on each side (the desired
  // class comes from the template, the recorded one from state): nothing in the
  // refusal or in the pair may run, for ANY family.
  it.each(
    [...PASTE_PAYLOADS.map((p) => p.value), "x';touch OWNED;'"].flatMap((value) => [
      { value, side: 'desired' as const },
      { value, side: 'recorded' as const },
    ])
  )('logs-loggroup: a $side LogGroupClass $value runs nothing', async ({ value, side }) => {
    const error = (await settle(
      new LogsLogGroupProvider().update(
        'Lg',
        '/lg',
        'AWS::Logs::LogGroup',
        { LogGroupClass: side === 'desired' ? value : 'STANDARD' },
        { LogGroupClass: side === 'desired' ? 'STANDARD' : value }
      )
    )) as Error;
    // The value may itself hold a paren, so the pair is cut at its fixed ends.
    const pair = error.message.split('LogGroupClass (')[1]!.split(') cannot be changed')[0]!;
    withPasteDir((dir) => {
      expect(spansThatRun(error.message, dir), value).toEqual([]);
      expect(spansThatRun(pair, dir), `${value} (the pair)`).toEqual([]);
    });
    // The spelling after the paste, so a revert reds on the property.
    const described = 'a class value that is not a plain identifier';
    expect(pair).toBe(
      side === 'desired' ? `from STANDARD to ${described}` : `from ${described} to STANDARD`
    );
    expect(error.message).not.toContain(value);
  }, 60_000);
});
