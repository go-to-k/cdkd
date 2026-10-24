import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import type { S3Client } from '@aws-sdk/client-s3';

const mockStsSend = vi.hoisted(() => vi.fn());
const loggerSpies = vi.hoisted(() => ({ warn: vi.fn(), debug: vi.fn(), info: vi.fn() }));

vi.mock('@aws-sdk/client-sts', async () => {
  const actual =
    await vi.importActual<typeof import('@aws-sdk/client-sts')>('@aws-sdk/client-sts');
  return {
    ...actual,
    STSClient: vi.fn().mockImplementation(() => ({ send: mockStsSend, destroy: vi.fn() })),
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  const l = {
    debug: loggerSpies.debug,
    info: loggerSpies.info,
    warn: loggerSpies.warn,
    error: vi.fn(),
    setLevel: vi.fn(),
    child: () => l,
  };
  return { getLogger: () => l };
});

import { ExportIndexStore } from '../../../src/state/export-index-store.js';
import { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import { parseRollbackJournal } from '../../../src/types/rollback-journal.js';
import { describeFileReadFailure } from '../../../src/utils/assembly-path.js';
import {
  applyRoleArnIfSet,
  assumeRoleForCrossAccountStateRead,
  clearCrossAccountCredentialsCache,
} from '../../../src/utils/role-arn.js';
import { resetAwsClientDefaults } from '../../../src/utils/aws-client-defaults.js';

/**
 * Issue [#3361](https://github.com/go-to-k/cdkd/issues/3361), the
 * `src/state` / `src/utils` / `src/types` remainder:
 * `x instanceof Error ? x.message : String(x)` THROWS for a value `String()`
 * cannot convert -- `String(Object.create(null))` raises
 * `TypeError: Cannot convert object to primitive value` -- so the handler
 * reporting a failure replaced it with an unrelated TypeError. Each site now
 * reads `describeAwsFailure(x).detail`, byte-identical for every value
 * `String()` can convert.
 *
 * Every case asserts the REPORTED failure (its own wording plus the
 * placeholder), never merely "something was thrown": the pre-fix code threw
 * too, just the wrong error.
 */

/** What `describeAwsFailure(x).detail` renders for a value `String()` cannot convert. */
const PLACEHOLDER = 'a value that could not be converted to text';

/** A value whose `String()` throws. */
const unconvertible = (): unknown => Object.create(null) as unknown;

const warnings = (): string[] => loggerSpies.warn.mock.calls.map((c) => String(c[0]));

beforeEach(() => {
  vi.clearAllMocks();
  mockStsSend.mockReset();
  clearCrossAccountCredentialsCache();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('JSON.parse catches render an unconvertible throw (#3361)', () => {
  it('S3StateBackend.parseStateBody throws its own StateError, not a TypeError', () => {
    const backend = new S3StateBackend({} as S3Client, { bucket: 'b', prefix: 'cdkd' });
    vi.spyOn(JSON, 'parse').mockImplementationOnce(() => {
      throw unconvertible();
    });
    const parse = (
      backend as unknown as { parseStateBody(body: string, stack: string): unknown }
    ).parseStateBody.bind(backend);

    expect(() => parse('{}', 'MyStack')).toThrow(
      // The size-only form since #5247, which never renders the thrown value.
      'State file for stack MyStack is not valid JSON: invalid JSON; 2 byte(s) read'
    );
  });

  it('parseRollbackJournal throws its own refusal, not a TypeError', () => {
    vi.spyOn(JSON, 'parse').mockImplementationOnce(() => {
      throw unconvertible();
    });

    expect(() => parseRollbackJournal('{}', 'MyStack')).toThrow(
      // The size-only form since #5247, which never renders the thrown value.
      "Rollback journal for 'MyStack' is not valid JSON: invalid JSON; 2 byte(s) read"
    );
  });

  it('describeFileReadFailure describes an unconvertible read failure', () => {
    expect(describeFileReadFailure(unconvertible(), '/assembly/x.json')).toBe(PLACEHOLDER);
  });
});

describe('ExportIndexStore corrupt-index warning (#3361)', () => {
  function store(body: string): { store: ExportIndexStore; puts: string[] } {
    const puts: string[] = [];
    const client = {
      send: vi.fn((cmd: { constructor: { name: string }; input: { Body?: string } }) => {
        if (cmd.constructor.name === 'GetObjectCommand') {
          return Promise.resolve({ Body: { transformToString: async () => body }, ETag: '"e1"' });
        }
        if (cmd.constructor.name === 'PutObjectCommand') {
          puts.push(cmd.input.Body ?? '');
          return Promise.resolve({ ETag: '"e2"' });
        }
        return Promise.reject(new Error(`unexpected command ${cmd.constructor.name}`));
      }),
      destroy: vi.fn(),
    } as unknown as S3Client;
    const stateBackend = { listStacks: vi.fn(async () => []) } as unknown as S3StateBackend;
    return {
      store: new ExportIndexStore(client, 'b', 'cdkd', 'us-east-1', stateBackend),
      puts,
    };
  }

  it('still rebuilds when the parse failure is unconvertible', async () => {
    // `doLoad`'s corrupt arm warns and REBUILDS; the warning's `String()`
    // threw first, so the rebuild never ran and the lookup rejected.
    vi.spyOn(JSON, 'parse').mockImplementationOnce(() => {
      throw unconvertible();
    });
    const { store: s, puts } = store('{}');

    await expect(s.lookup('Anything')).resolves.toBeUndefined();

    expect(puts).toHaveLength(1);
    const corrupt = warnings().filter((w) => w.startsWith('Exports index corrupt'));
    expect(corrupt).toEqual([
      'Exports index corrupt (invalid JSON; 2 byte(s) read); rebuilding from state.json files',
    ]);
  });

  it('does not echo the index body that V8 quotes into its parse message', async () => {
    // The index holds resolved Output VALUES. V8's `Unexpected token` family
    // quotes the body in its message, which this warning printed verbatim --
    // the leak `describeJsonParseFailure` already closes for `readPersistedEntries`.
    const body = '{"value": hunter2-plaintext}';
    expect(() => JSON.parse(body)).toThrow(/hunter2/);
    const { store: s } = store(body);

    await expect(s.lookup('Anything')).resolves.toBeUndefined();

    const corrupt = warnings().filter((w) => w.startsWith('Exports index corrupt'));
    expect(corrupt).toEqual([
      `Exports index corrupt (invalid JSON; ${Buffer.byteLength(body, 'utf8')} byte(s) read); rebuilding from state.json files`,
    ]);
    expect(warnings().join('\n')).not.toContain('hunter2');
  });
});

describe('role-arn AssumeRole failure messages (#3361)', () => {
  const PRESERVED_ENV = [
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
    'AWS_PROFILE',
    'CDKD_ROLE_ARN',
  ];
  let originalEnv: Record<string, string | undefined>;

  beforeEach(() => {
    resetAwsClientDefaults();
    originalEnv = {};
    for (const key of PRESERVED_ENV) {
      originalEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    resetAwsClientDefaults();
    for (const key of PRESERVED_ENV) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  });

  it('assumeRoleForCrossAccountStateRead names the failed hop for an unconvertible rejection', async () => {
    mockStsSend.mockRejectedValueOnce(unconvertible());

    await expect(
      assumeRoleForCrossAccountStateRead('arn:aws:iam::123456789012:role/Producer')
    ).rejects.toThrow(
      new RegExp(`^AssumeRole into .*Producer.* failed: ${PLACEHOLDER}\\. If this is a trust-policy`)
    );
    expect(mockStsSend).toHaveBeenCalledTimes(1);
  });

  it('applyRoleArnIfSet names the failed hop for an unconvertible rejection', async () => {
    mockStsSend.mockRejectedValueOnce(unconvertible());

    await expect(
      applyRoleArnIfSet({ roleArn: 'arn:aws:iam::123456789012:role/Deploy', region: 'us-east-1' })
    ).rejects.toThrow(new RegExp(`^AssumeRole for .*Deploy.* failed: ${PLACEHOLDER}$`));
    expect(mockStsSend).toHaveBeenCalledTimes(1);
    expect(process.env['AWS_ACCESS_KEY_ID']).toBeUndefined();
  });
});
