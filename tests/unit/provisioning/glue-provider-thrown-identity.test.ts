import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

/**
 * Every Glue create / update / pre-update-read / delete wrap must not write
 * the CALLER'S IDENTITY into a persisted store (go-to-k/cdkd#2319), nor
 * out-throw a value `String()` cannot convert (go-to-k/cdkd#3341).
 *
 * A thrown `ProvisioningError` message is captured into
 * `deployments/{runId}.jsonl`, and Glue words an `AccessDeniedException` as
 * `User: arn:aws:sts::<account>:assumed-role/<role>/<session> is not
 * authorized to perform: ...`. Every AWS fixture carries that real wording.
 */

const { mockGlueSend, mockStsSend, debugSpy, warnSpy, infoSpy, errorSpy } = vi.hoisted(() => ({
  mockGlueSend: vi.fn(),
  mockStsSend: vi.fn(),
  debugSpy: vi.fn(),
  warnSpy: vi.fn(),
  infoSpy: vi.fn(),
  errorSpy: vi.fn(),
}));

vi.mock('@aws-sdk/client-glue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-glue')>();
  return {
    ...actual,
    GlueClient: vi.fn().mockImplementation(() => ({
      send: mockGlueSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('@aws-sdk/client-sts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-sts')>();
  return {
    ...actual,
    STSClient: vi.fn().mockImplementation(() => ({ send: mockStsSend })),
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: debugSpy,
    info: infoSpy,
    warn: warnSpy,
    error: errorSpy,
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: debugSpy,
      info: infoSpy,
      warn: warnSpy,
      error: errorSpy,
    }),
  };
});

import {
  ConcurrentModificationException,
  CrawlerRunningException,
  EntityNotFoundException,
} from '@aws-sdk/client-glue';
import {
  GlueProvider,
  GlueWorkflowProvider,
  GlueSecurityConfigurationProvider,
  GlueJobProvider,
  GlueCrawlerProvider,
  GlueConnectionProvider,
  GlueTriggerProvider,
} from '../../../src/provisioning/providers/glue-provider.js';
import {
  hasRedactedCause,
  isIamPropagationError,
  isRetryableTransientError,
  retryClassificationText,
} from '../../../src/deployment/retryable-errors.js';
import { withRetry } from '../../../src/deployment/retry.js';
import { VERBOSE_POINTER } from '../../../src/utils/aws-failure-text.js';

const CALLER_ACCOUNT = '210987654321';
const CALLER_ROLE = 'cdkd-deploy-role';
const CALLER_SESSION = 'cdkd-session-8f21';
const CALLER_ARN = `arn:aws:sts::${CALLER_ACCOUNT}:assumed-role/${CALLER_ROLE}/${CALLER_SESSION}`;

/** Glue's `AccessDeniedException` as it really words it. */
function accessDeniedNamingTheCaller(): Error {
  const e = new Error(
    `User: ${CALLER_ARN} is not authorized to perform: glue:CreateDatabase on resource: ` +
      `arn:aws:glue:us-east-1:123456789012:catalog because no identity-based policy allows ` +
      `the glue:CreateDatabase action`
  );
  return Object.assign(e, {
    name: 'AccessDeniedException',
    $fault: 'client',
    $metadata: { httpStatusCode: 400 },
  });
}

type Masker = (text: string) => string;

/** Each command named in `failing` rejects with the value; every other one resolves `{}`. */
function rejectGlue(failing: readonly string[], value: unknown): void {
  mockGlueSend.mockImplementation((command: { constructor: { name: string } }) =>
    failing.includes(command.constructor.name) ? Promise.reject(value) : Promise.resolve({})
  );
}

const DB_UPDATE = { DatabaseInput: { Description: 'd' } };
const TABLE = { DatabaseName: 'db', TableInput: { Name: 'tbl' } };

/** Each wrap in the Glue family, the call that reaches it, and the prefix it throws. */
const SITES: ReadonlyArray<{
  site: string;
  prefix: string;
  arm: (failure: unknown) => void;
  run: (mask?: Masker) => Promise<unknown>;
}> = [
  ...(
    [
      ['Database', () => new GlueProvider(), 'AWS::Glue::Database', { DatabaseInput: { Name: 'db' } }],
      ['Table', () => new GlueProvider(), 'AWS::Glue::Table', TABLE],
      [
        'SecurityConfiguration',
        () => new GlueSecurityConfigurationProvider(),
        'AWS::Glue::SecurityConfiguration',
        { Name: 'sc', EncryptionConfiguration: {} },
      ],
      ['Workflow', () => new GlueWorkflowProvider(), 'AWS::Glue::Workflow', { Name: 'wf' }],
      [
        'Job',
        () => new GlueJobProvider(),
        'AWS::Glue::Job',
        { Name: 'job', Role: 'r', Command: { Name: 'glueetl' } },
      ],
      [
        'Crawler',
        () => new GlueCrawlerProvider(),
        'AWS::Glue::Crawler',
        { Name: 'cr', Role: 'r', Targets: {} },
      ],
      [
        'Connection',
        () => new GlueConnectionProvider(),
        'AWS::Glue::Connection',
        { ConnectionInput: { Name: 'conn', ConnectionType: 'JDBC' } },
      ],
      [
        'Trigger',
        () => new GlueTriggerProvider(),
        'AWS::Glue::Trigger',
        { Name: 'tr', Type: 'ON_DEMAND', Actions: [] },
      ],
    ] as const
  ).map(([label, make, type, bag]) => ({
    site: `${label} create()`,
    prefix: `Failed to create Glue ${label} Res: `,
    arm: (f: unknown) => rejectGlue([`Create${label}Command`], f),
    run: (m?: Masker) => make().create('Res', type, bag, m && { maskSecrets: m }),
  })),
  {
    site: 'Database update()',
    prefix: 'Failed to update Glue Database Res: ',
    arm: (f) => rejectGlue(['UpdateDatabaseCommand'], f),
    run: (m) =>
      new GlueProvider().update(
        'Res',
        'db',
        'AWS::Glue::Database',
        DB_UPDATE,
        {},
        m && { maskSecrets: m }
      ),
  },
  {
    site: 'Database pre-update read',
    prefix: 'Failed to read the current Glue Database Res before update: ',
    arm: (f) => rejectGlue(['GetDatabaseCommand'], f),
    run: (m) =>
      new GlueProvider().update(
        'Res',
        'db',
        'AWS::Glue::Database',
        DB_UPDATE,
        {},
        m && { maskSecrets: m }
      ),
  },
  {
    site: 'Database catalog-move account lookup (STS)',
    prefix: 'so cdkd did not update Glue database Res: ',
    arm: (f) => {
      rejectGlue([], undefined);
      mockStsSend.mockRejectedValue(f);
    },
    run: (m) =>
      new GlueProvider().update(
        'Res',
        'db',
        'AWS::Glue::Database',
        DB_UPDATE,
        { CatalogId: '222222222222' },
        m && { maskSecrets: m }
      ),
  },
  {
    site: 'Table update()',
    prefix: 'Failed to update Glue Table Res: ',
    arm: (f) => rejectGlue(['UpdateTableCommand'], f),
    run: (m) =>
      new GlueProvider().update('Res', 'db|tbl', 'AWS::Glue::Table', TABLE, {}, m && { maskSecrets: m }),
  },
  {
    site: 'Table pre-update read',
    prefix: 'Failed to read the current Glue Table Res before update: ',
    arm: (f) => rejectGlue(['GetTableCommand'], f),
    run: (m) =>
      new GlueProvider().update('Res', 'db|tbl', 'AWS::Glue::Table', TABLE, {}, m && { maskSecrets: m }),
  },
  ...(
    [
      ['Workflow', () => new GlueWorkflowProvider(), 'AWS::Glue::Workflow', {}],
      ['Job', () => new GlueJobProvider(), 'AWS::Glue::Job', { Role: 'r' }],
      ['Crawler', () => new GlueCrawlerProvider(), 'AWS::Glue::Crawler', { Role: 'r' }],
      [
        'Connection',
        () => new GlueConnectionProvider(),
        'AWS::Glue::Connection',
        { ConnectionInput: { ConnectionType: 'JDBC' } },
      ],
      ['Trigger', () => new GlueTriggerProvider(), 'AWS::Glue::Trigger', {}],
    ] as const
  ).map(([label, make, type, bag]) => ({
    site: `${label} update()`,
    prefix: `Failed to update Glue ${label} Res: `,
    arm: (f: unknown) => rejectGlue([`Update${label}Command`], f),
    run: (m?: Masker) => make().update('Res', 'name', type, bag, {}, m && { maskSecrets: m }),
  })),
  ...(
    [
      ['Database', () => new GlueProvider(), 'AWS::Glue::Database', 'db'],
      ['Table', () => new GlueProvider(), 'AWS::Glue::Table', 'db|tbl'],
      [
        'SecurityConfiguration',
        () => new GlueSecurityConfigurationProvider(),
        'AWS::Glue::SecurityConfiguration',
        'sc',
      ],
      ['Workflow', () => new GlueWorkflowProvider(), 'AWS::Glue::Workflow', 'wf'],
      ['Job', () => new GlueJobProvider(), 'AWS::Glue::Job', 'job'],
      ['Crawler', () => new GlueCrawlerProvider(), 'AWS::Glue::Crawler', 'cr'],
      ['Connection', () => new GlueConnectionProvider(), 'AWS::Glue::Connection', 'conn'],
      ['Trigger', () => new GlueTriggerProvider(), 'AWS::Glue::Trigger', 'tr'],
    ] as const
  ).map(([label, make, type, id]) => ({
    site: `${label} delete()`,
    prefix: `Failed to delete Glue ${label} Res: `,
    arm: (f: unknown) => rejectGlue([`Delete${label}Command`], f),
    run: (m?: Masker) =>
      make().delete('Res', id, type, { DatabaseName: 'db' }, m && { maskSecrets: m }),
  })),
];

const debugText = (): string => debugSpy.mock.calls.map((c) => String(c[0])).join('\n');
const defaultLevelText = (): string =>
  [...infoSpy.mock.calls, ...warnSpy.mock.calls, ...errorSpy.mock.calls]
    .map((c) => String(c[0]))
    .join('\n');

async function capture(run: () => Promise<unknown>): Promise<Error> {
  try {
    await run();
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected the operation to throw, but it resolved');
}

/** The identity fragments, asserted one by one so a PARTIAL redaction cannot pass. */
function expectNoCallerIdentity(text: string): void {
  expect(text).not.toContain(CALLER_ARN);
  expect(text).not.toContain(CALLER_ACCOUNT);
  expect(text).not.toContain(CALLER_ROLE);
  expect(text).not.toContain(CALLER_SESSION);
  expect(text).not.toContain('assumed-role');
  expect(text).not.toContain('is not authorized to perform');
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGlueSend.mockReset();
  mockStsSend.mockReset();
  mockStsSend.mockResolvedValue({ Account: '123456789012' });
});

describe('Glue thrown-failure identity redaction (go-to-k/cdkd#2319)', () => {
  it('covers every Glue wrap family (floor)', () => {
    // 8 creates + 7 updates + 2 pre-update reads + the STS lookup + 8 deletes.
    expect(SITES).toHaveLength(26);
  });

  describe.each(SITES)('$site', ({ prefix, arm, run }) => {
    it('names the CLASS and withholds the caller identity from the thrown message', async () => {
      arm(accessDeniedNamingTheCaller());

      const thrown = await capture(() => run());

      expect(thrown.name).toBe('ProvisioningError');
      expect(thrown.message).toContain(`${prefix}AccessDeniedException. ${VERBOSE_POINTER}`);
      expectNoCallerIdentity(thrown.message);
      // A builder appending its own sentence end must not double the period.
      expect(thrown.message).not.toContain('..');
    });

    it("keeps AWS's own message at logger.debug, and nowhere at default level", async () => {
      arm(accessDeniedNamingTheCaller());

      await capture(() => run());

      expect(debugText()).toContain(`${prefix}User: ${CALLER_ARN} is not authorized`);
      expect(defaultLevelText()).not.toContain(CALLER_ARN);
    });

    it('keeps the AWS error as cause and stamps the redaction for the retry classifiers', async () => {
      const aws = accessDeniedNamingTheCaller();
      arm(aws);

      const thrown = await capture(() => run());

      expect(thrown.cause).toBe(aws);
      expect(hasRedactedCause(thrown)).toBe(true);
      // Premise: the top-level message alone no longer classifies.
      expect(isRetryableTransientError(thrown, thrown.message)).toBe(false);
      const classify = retryClassificationText(thrown);
      expect(isRetryableTransientError(thrown, classify)).toBe(true);
      expect(isIamPropagationError(classify)).toBe(true);
    });

    it('does not out-throw a value String() cannot convert (go-to-k/cdkd#3341)', async () => {
      arm(Object.create(null));

      const thrown = await capture(() => run());

      expect(thrown.name).toBe('ProvisioningError');
      expect(thrown.message).toContain(`${prefix}a non-Error value of type object`);
      expect(thrown.cause).toBeUndefined();
      expect(hasRedactedCause(thrown)).toBe(false);
      expect(debugText()).toContain(`${prefix}a value that could not be converted to text`);
    });

    it('NEGATIVE CONTROL: an Error AWS did not author passes through VERBATIM, unstamped', async () => {
      // No `$fault` / numeric `$metadata.httpStatusCode`: a transport failure,
      // whose text names a host, never a caller, and is the diagnosis.
      arm(new Error('connect ECONNREFUSED 10.0.0.1:443'));

      const thrown = await capture(() => run());

      expect(thrown.message).toContain(`${prefix}connect ECONNREFUSED 10.0.0.1:443`);
      expect(thrown.message).not.toContain(VERBOSE_POINTER);
      expect(hasRedactedCause(thrown)).toBe(false);
      expect(debugText()).not.toContain(`${prefix}connect ECONNREFUSED`);
    });

    it("masks a non-AWS failure's text in the thrown message with this operation's masker", async () => {
      const secret = 'tok-SECRETVALUE-9f3a';
      arm(new Error(`connect ECONNREFUSED ${secret}:443`));

      const thrown = await capture(() => run((t: string) => t.split(secret).join('***')));

      expect(thrown.message).toContain(`${prefix}connect ECONNREFUSED ***:443`);
      expect(thrown.message).not.toContain(secret);
    });

    it("routes the debug line through this operation's masker", async () => {
      const secret = 'tok-SECRETVALUE-9f3a';
      arm(
        Object.assign(new Error(`Invalid input: ${secret}`), {
          name: 'InvalidInputException',
          $fault: 'client',
          $metadata: { httpStatusCode: 400 },
        })
      );

      await capture(() => run((t: string) => t.split(secret).join('***')));

      expect(debugText()).toContain(`${prefix}Invalid input: ***`);
      expect(debugText()).not.toContain(secret);
    });
  });

  it('Table update: the concurrent-writer hint follows the class without a doubled period', async () => {
    rejectGlue(
      ['UpdateTableCommand'],
      new ConcurrentModificationException({ message: 'Concurrent update', $metadata: {} })
    );

    const thrown = await capture(() =>
      new GlueProvider().update('Res', 'db|tbl', 'AWS::Glue::Table', TABLE, {})
    );

    expect(thrown.message).toContain(
      `Failed to update Glue Table Res: ConcurrentModificationException. ${VERBOSE_POINTER.slice(0, -1)}. Another writer`
    );
    expect(thrown.message).not.toContain('..');
  });

  it("Trigger update: the re-activate warning names the class; AWS's text is debug-only", async () => {
    const gets = [{ Trigger: { State: 'ACTIVATED' } }, { Trigger: { State: 'DEACTIVATED' } }];
    mockGlueSend.mockImplementation((command: { constructor: { name: string } }) => {
      const name = command.constructor.name;
      if (name === 'GetTriggerCommand') return Promise.resolve(gets.shift() ?? gets[0] ?? {});
      if (name === 'UpdateTriggerCommand' || name === 'StartTriggerCommand') {
        return Promise.reject(accessDeniedNamingTheCaller());
      }
      return Promise.resolve({});
    });

    await capture(() => new GlueTriggerProvider().update('Res', 'tr', 'AWS::Glue::Trigger', {}, {}));

    expect(defaultLevelText()).toContain(
      `Failed to re-activate Glue Trigger tr after a failed update: AccessDeniedException. ${VERBOSE_POINTER}`
    );
    expect(defaultLevelText()).not.toContain(CALLER_ARN);
    expect(debugText()).toContain(
      `Failed to re-activate Glue Trigger tr after a failed update: User: ${CALLER_ARN}`
    );
  });

  describe('Crawler delete: the retry after stopping a running crawler', () => {
    function runningThen(retry: unknown): void {
      let deletes = 0;
      mockGlueSend.mockImplementation((command: { constructor: { name: string } }) => {
        if (command.constructor.name !== 'DeleteCrawlerCommand') return Promise.resolve({});
        deletes++;
        return Promise.reject(
          deletes === 1
            ? new CrawlerRunningException({ message: 'Crawler is running', $metadata: {} })
            : retry
        );
      });
    }

    it('wraps a failed retry like the first attempt, withholding the caller identity', async () => {
      const aws = accessDeniedNamingTheCaller();
      runningThen(aws);

      const thrown = await capture(() =>
        new GlueCrawlerProvider().delete('Res', 'cr', 'AWS::Glue::Crawler', {})
      );

      expect(thrown.name).toBe('ProvisioningError');
      expect(thrown.message).toContain(
        `Failed to delete Glue Crawler Res: AccessDeniedException. ${VERBOSE_POINTER}`
      );
      expectNoCallerIdentity(thrown.message);
      expect(thrown.cause).toBe(aws);
      expect(hasRedactedCause(thrown)).toBe(true);
    });

    it('treats a crawler gone by the retry as already deleted', async () => {
      runningThen(new EntityNotFoundException({ message: 'Entity not found', $metadata: {} }));

      await expect(
        new GlueCrawlerProvider().delete('Res', 'cr', 'AWS::Glue::Crawler', {})
      ).resolves.toBeUndefined();
    });
  });

  it('and withRetry ITSELF re-attempts the redacted wrap', async () => {
    rejectGlue(['CreateDatabaseCommand'], accessDeniedNamingTheCaller());
    const attempts: unknown[] = [];
    const logLines: string[] = [];

    await expect(
      withRetry(
        async () => {
          attempts.push(1);
          return new GlueProvider().create('Res', 'AWS::Glue::Database', {
            DatabaseInput: { Name: 'db' },
          });
        },
        'Res',
        {
          maxRetries: 2,
          sleep: async () => {},
          logger: {
            debug: (line: string) => logLines.push(line),
            warn: (line: string) => logLines.push(line),
          },
        }
      )
    ).rejects.toThrow(/AccessDeniedException/);

    expect(attempts).toHaveLength(3);
    expect(logLines.join('\n')).not.toContain(CALLER_ARN);
  });
});
