/**
 * Issue #2177 — the Glue family's masked log sinks.
 *
 * Every Glue provider (`Database`, `Table`, `Workflow`, `SecurityConfiguration`,
 * `Job`, `Crawler`, `Connection`, `Trigger`) interpolates names read off the
 * RESOLVED `properties` bag, and the physical id recorded from one, into its own
 * log lines, which reach no engine sink, and into thrown refusals. Each
 * `create()` / `update()` now builds ONE sink set per operation from the
 * context's masker and masks every bag-derived value RAW before interpolating
 * it. A name that IS a secret also becomes a floor-less needle, so it is masked
 * inside an AWS error quoting it back; an update adds the recorded name as a
 * needle when the previous value it came from is secret-derived (a rotated
 * secret).
 *
 * Cases assert over the WHOLE transcript (every debug and warn line), not one
 * known line. The secrets are sized for the arm each case must isolate:
 *
 *  - a LONG one, which the message-level mask alone catches;
 *  - THREE-character ones (`SHORT`, ...), below the masker's substring floor
 *    (`MIN_NEEDLE_LENGTH`) but at the self-name needle floor
 *    (`SELF_NEEDLE_MIN_LENGTH`), so they are removed by EITHER the raw value
 *    mask or that needle -- they discriminate the needle and the AWS-echo sites;
 *  - TWO-character ones (`TINY_A`, `TINY_B`), below BOTH floors, so on a line
 *    cdkd writes ONLY the raw value mask `v(...)` can remove them. The TINY
 *    cases are the ones that fence the raw mask itself.
 *
 * The update cases leave the PREVIOUS name out of `previousProperties` on
 * purpose: a secret previous name makes the recorded name a floor-less derived
 * needle, which would mask every line on its own and hide a missing raw mask.
 * The rotated-secret cases are the ones that exercise that needle.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const { mockGlueSend, mockStsSend, warnSpy, debugSpy } = vi.hoisted(() => ({
  mockGlueSend: vi.fn(),
  mockStsSend: vi.fn(),
  warnSpy: vi.fn(),
  debugSpy: vi.fn(),
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
    info: vi.fn(),
    warn: warnSpy,
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: debugSpy,
      info: vi.fn(),
      warn: warnSpy,
      error: vi.fn(),
    }),
  };
});

import {
  AlreadyExistsException,
  CrawlerNotRunningException,
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
import { ResourceUpdateNotSupportedError } from '../../../src/utils/error-handler.js';
import { createSecretMasker, SECRET_MASK } from '../../../src/deployment/secret-redaction.js';
import type { RecordedSecretValues } from '../../../src/deployment/secret-redaction.js';

/** A name-safe secret, long enough for the message-level substring arm. */
const SECRET = 'glue-secret-name';
/** A secret BELOW the substring arm's floor: only a RAW value mask catches it. */
const SHORT = 'q7z';
/** A second short secret, for the other half of a table id. */
const SHORT2 = 'k4w';
/** A short secret used as a Data Catalog id. */
const SHORT_CATALOG = 'c9x';

function bagOf(...values: string[]): RecordedSecretValues {
  return new Map(values.map((v) => [v, `{{resolve:secretsmanager:${v}}}`]));
}

/** A TWO-character secret: below the self-needle floor, and a substring of `Glue`. */
const TINY = 'lu';

/** Two-character secrets in no fixed wording, so an absence assertion discriminates. */
const TINY_A = 'qx';
const TINY_B = 'jv';

const maskSecrets = createSecretMasker(
  bagOf(SECRET, SHORT, SHORT2, SHORT_CATALOG, TINY, TINY_A, TINY_B)
);

/** Neither two-character secret is in the transcript, and each line it was on shows the mask. */
function expectTinyMasked(...lines: string[]): void {
  const all = allLines();
  expect(all).not.toContain(TINY_A);
  expect(all).not.toContain(TINY_B);
  for (const line of lines) expect(all).toContain(line);
}

/**
 * A marker masker: every string it sees comes back prefixed, so a line that went
 * through the operation's masked sink STARTS with the marker and one that
 * bypassed it does not. It pins routing where the line carries no secret.
 */
const MARK = '[masked]';
const markingMasker = (text: string): string => (text.startsWith(MARK) ? text : MARK + text);

function warnLines(): string[] {
  return warnSpy.mock.calls.map((c) => String(c[0]));
}
const PLAINTEXTS = [SECRET, SHORT, SHORT2, SHORT_CATALOG];

function allLines(): string {
  return [...warnSpy.mock.calls, ...debugSpy.mock.calls].map((c) => String(c[0])).join('\n');
}

/** Every plaintext is gone from the transcript, and the mask is there instead. */
function expectTranscriptMasked(): void {
  const lines = allLines();
  for (const plaintext of PLAINTEXTS) expect(lines).not.toContain(plaintext);
  expect(lines).toContain(SECRET_MASK);
}

function expectMessageMasked(error: unknown): void {
  expect(error).toBeInstanceOf(Error);
  const message = (error as Error).message;
  for (const plaintext of PLAINTEXTS) expect(message).not.toContain(plaintext);
  expect(message).toContain(SECRET_MASK);
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

type Answer = unknown | ((input: Record<string, unknown>) => unknown);

/**
 * Answer each Glue command by name. An `Error` answer rejects; an array answer
 * is consumed one element per call (the last one repeats).
 */
function answerGlue(answers: Record<string, Answer | Answer[]> = {}): void {
  const calls: Record<string, number> = {};
  mockGlueSend.mockImplementation(
    (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      const name = command.constructor.name;
      const configured = answers[name];
      let answer: Answer = configured;
      if (Array.isArray(configured)) {
        const i = calls[name] ?? 0;
        calls[name] = i + 1;
        answer = configured[Math.min(i, configured.length - 1)];
      }
      if (typeof answer === 'function') answer = (answer as (i: unknown) => unknown)(command.input);
      if (answer instanceof Error) return Promise.reject(answer);
      return Promise.resolve(answer ?? {});
    }
  );
}

function awsEcho(message: string): Error {
  const error = new Error(message);
  error.name = 'InvalidInputException';
  (error as unknown as { $metadata: unknown }).$metadata = { httpStatusCode: 400 };
  return error;
}

/** A secret reference as state persists it; its plaintext is in no bag of this deploy. */
const REF = '{{resolve:secretsmanager:rotated}}';

beforeEach(() => {
  mockGlueSend.mockReset();
  mockStsSend.mockReset();
  mockStsSend.mockResolvedValue({ Account: '123456789012' });
  warnSpy.mockClear();
  debugSpy.mockClear();
});

describe('GlueProvider AWS::Glue::Database (issue #2177)', () => {
  const provider = new GlueProvider();
  const type = 'AWS::Glue::Database';

  it('masks a SHORT database name on every create() line', async () => {
    answerGlue();
    await provider.create('Db', type, { DatabaseInput: { Name: SHORT } }, { maskSecrets });
    expectTranscriptMasked();
  });

  it('masks the AWS message a failed create() wraps', async () => {
    answerGlue({ CreateDatabaseCommand: awsEcho(`Database ${SECRET} is invalid`) });
    const error = await caught(
      provider.create('Db', type, { DatabaseInput: { Name: SECRET } }, { maskSecrets })
    );
    expectMessageMasked(error);
  });

  it('masks a SHORT name AWS quotes back in a failed create(), below the substring floor', async () => {
    answerGlue({ CreateDatabaseCommand: awsEcho(`Database ${SHORT} already exists`) });
    const error = await caught(
      provider.create('Db', type, { DatabaseInput: { Name: SHORT } }, { maskSecrets })
    );
    expectMessageMasked(error);
  });

  it('masks a SHORT fallback DatabaseName and a SHORT CatalogId AWS quotes back', async () => {
    answerGlue({
      CreateDatabaseCommand: awsEcho(`Database ${SHORT2} in catalog ${SHORT_CATALOG} is invalid`),
    });
    const error = await caught(
      provider.create(
        'Db',
        type,
        { DatabaseInput: {}, DatabaseName: SHORT2, CatalogId: SHORT_CATALOG },
        { maskSecrets }
      )
    );
    expectMessageMasked(error);
  });

  it('renders a ROTATED 2-character recorded name as *** where cdkd prints it, at any length', async () => {
    answerGlue({ GetDatabaseCommand: { Database: { Parameters: {} } } });
    await provider.update(
      'Db',
      'zq',
      type,
      { DatabaseInput: { Description: 'd' } },
      { DatabaseInput: { Name: REF } },
      { maskSecrets }
    );
    expect(allLines()).not.toContain('zq');
    expect(allLines()).toContain(`Updating Glue Database Db: ${SECRET_MASK}`);
  });

  it('does NOT mask fixed wording for a ROTATED recorded name below the needle floor', async () => {
    // `lu` is inside `Glue`: a substring needle would print `G***e`.
    answerGlue({ GetDatabaseCommand: { Database: { Parameters: {} } } });
    await provider.update(
      'Db',
      'lu',
      type,
      { DatabaseInput: { Description: 'd' } },
      { DatabaseInput: { Name: REF } },
      { maskSecrets }
    );
    expect(allLines()).toContain(`Updating Glue Database Db: ${SECRET_MASK}`);
    expect(allLines()).toContain('Successfully updated Glue Database Db');
  });

  it('masks a ROTATED recorded name AWS quotes back in a failed update() and a failed pre-update read', async () => {
    answerGlue({
      GetDatabaseCommand: { Database: { Parameters: {} } },
      UpdateDatabaseCommand: awsEcho('Database oldplaindb is invalid'),
    });
    const wrapped = await caught(
      provider.update(
        'Db',
        'oldplaindb',
        type,
        { DatabaseInput: { Description: 'd' } },
        { DatabaseInput: { Name: REF } },
        { maskSecrets }
      )
    );
    expect((wrapped as Error).message).not.toContain('oldplaindb');
    answerGlue({ GetDatabaseCommand: awsEcho('no access to oldplaindb') });
    const read = await caught(
      provider.update(
        'Db',
        'oldplaindb',
        type,
        { DatabaseInput: { Description: 'd' } },
        { DatabaseName: SECRET_MASK },
        { maskSecrets }
      )
    );
    expect((read as Error).message).not.toContain('oldplaindb');
  });

  it('treats a previous value persisted as the whole mask (***) as secret-derived', async () => {
    answerGlue({ GetDatabaseCommand: { Database: { Parameters: {} } } });
    await provider.update(
      'Db',
      'oldplaindb',
      type,
      { DatabaseInput: { Description: 'd' } },
      { DatabaseInput: { Name: SECRET_MASK } },
      { maskSecrets }
    );
    expect(allLines()).not.toContain('oldplaindb');
    const renamed = await caught(
      provider.update(
        'Db',
        'oldplaindb',
        type,
        { DatabaseInput: { Name: 'newdb' } },
        { DatabaseName: SECRET_MASK },
        { maskSecrets }
      )
    );
    expect(renamed).toBeInstanceOf(ResourceUpdateNotSupportedError);
    expect((renamed as Error).message).not.toContain('oldplaindb');
  });

  it('masks a TWO-character name by the RAW mask alone on the create() and update() lines', async () => {
    answerGlue({ GetDatabaseCommand: { Database: { Parameters: {} } } });
    await provider.create('Db', type, { DatabaseInput: { Name: TINY_A } }, { maskSecrets });
    await provider.update(
      'Db',
      TINY_A,
      type,
      { DatabaseInput: { Description: 'd' } },
      {},
      { maskSecrets }
    );
    expectTinyMasked(
      'Creating Glue Database Db',
      `Successfully created Glue Database Db: ${SECRET_MASK}`,
      `Updating Glue Database Db: ${SECRET_MASK}`
    );
  });

  it('prints an ordinary name on the create() line -- negative control', async () => {
    answerGlue();
    await provider.create('Db', type, { DatabaseInput: { Name: 'plaindb' } }, { maskSecrets });
    expect(allLines()).toContain('Successfully created Glue Database Db: plaindb');
  });

  it('routes the state-replay create() warning through the masked sink', async () => {
    answerGlue();
    await provider.create(
      'Db',
      type,
      { DatabaseInput: { Name: 'plaindb', TargetDatabase: 'linked' } },
      { maskSecrets: markingMasker, replayingState: true }
    );
    expect(warnLines().length).toBeGreaterThan(0);
    for (const line of warnLines()) expect(line.startsWith(MARK)).toBe(true);
  });

  it('routes the state-replay update() warning (onUnusable) through the masked sink', async () => {
    answerGlue({ GetDatabaseCommand: { Database: { Parameters: {} } } });
    await provider.update(
      'Db',
      'plaindb',
      type,
      { DatabaseInput: { TargetDatabase: 'linked' } },
      {},
      { maskSecrets: markingMasker, replayingState: true }
    );
    expect(warnLines().length).toBeGreaterThan(0);
    for (const line of warnLines()) expect(line.startsWith(MARK)).toBe(true);
  });

  it('does NOT make a TWO-character secret name a needle: its masked positions would spell it', async () => {
    answerGlue();
    await provider.create('Db', type, { DatabaseInput: { Name: TINY } }, { maskSecrets });
    const lines = allLines();
    expect(lines).toContain('Creating Glue Database Db');
    expect(lines).toContain(`Successfully created Glue Database Db: ${SECRET_MASK}`);
  });

  it('masks a ROTATED recorded name in the rename refusal and the catalog-move refusal', async () => {
    const renamed = await caught(
      provider.update(
        'Db',
        'oldplaindb',
        type,
        { DatabaseInput: { Name: SECRET } },
        { DatabaseInput: { Name: REF } },
        { maskSecrets }
      )
    );
    expect(renamed).toBeInstanceOf(ResourceUpdateNotSupportedError);
    expect((renamed as Error).message).not.toContain('oldplaindb');
    const moved = await caught(
      provider.update(
        'Db',
        'oldplaindb',
        type,
        { DatabaseInput: { Description: 'd' }, CatalogId: '222222222222' },
        { DatabaseName: REF, CatalogId: '111111111111' },
        { maskSecrets }
      )
    );
    expect(moved).toBeInstanceOf(ResourceUpdateNotSupportedError);
    expect((moved as Error).message).not.toContain('oldplaindb');
    expect((moved as Error).message).toContain(`'${SECRET_MASK}'`);
  });

  it('masks a SHORT recorded name on every update() line', async () => {
    answerGlue({ GetDatabaseCommand: { Database: { Parameters: {} } } });
    await provider.update(
      'Db',
      SHORT,
      type,
      { DatabaseInput: { Description: 'd' } },
      {},
      { maskSecrets }
    );
    expectTranscriptMasked();
  });

  it('masks the AWS message a failed update() wraps', async () => {
    answerGlue({
      GetDatabaseCommand: { Database: { Parameters: {} } },
      UpdateDatabaseCommand: awsEcho(`Database ${SECRET} rejected`),
    });
    const error = await caught(
      provider.update('Db', 'db', type, { DatabaseInput: { Description: 'd' } }, {}, { maskSecrets })
    );
    expectMessageMasked(error);
  });

  it('masks a name recorded from a ROTATED secret, which no bag of this deploy holds', async () => {
    for (const previous of [{ DatabaseInput: { Name: REF } }, { DatabaseName: REF }]) {
      debugSpy.mockClear();
      answerGlue({ GetDatabaseCommand: { Database: { Parameters: {} } } });
      await provider.update(
        'Db',
        'oldplaindb',
        type,
        { DatabaseInput: { Description: 'd' } },
        previous,
        { maskSecrets }
      );
      expect(allLines()).not.toContain('oldplaindb');
      expect(allLines()).toContain(SECRET_MASK);
    }
  });

  it('leaves an ordinary recorded name visible -- negative control', async () => {
    answerGlue({ GetDatabaseCommand: { Database: { Parameters: {} } } });
    await provider.update(
      'Db',
      'plaindb',
      type,
      { DatabaseInput: { Description: 'd' } },
      { DatabaseInput: { Name: 'plaindb' } },
      { maskSecrets }
    );
    expect(allLines()).toContain('plaindb');
  });

  it('masks the DESIRED name in the rename refusal', async () => {
    const error = await caught(
      provider.update('Db', 'olddb', type, { DatabaseInput: { Name: SHORT } }, {}, { maskSecrets })
    );
    expect(error).toBeInstanceOf(ResourceUpdateNotSupportedError);
    expectMessageMasked(error);
    expect(mockGlueSend).not.toHaveBeenCalled();
  });

  it('masks the RECORDED name in the rename refusal, its consequence clause included', async () => {
    const error = await caught(
      provider.update('Db', SHORT, type, { DatabaseInput: { Name: 'newdb' } }, {}, { maskSecrets })
    );
    expect(error).toBeInstanceOf(ResourceUpdateNotSupportedError);
    expectMessageMasked(error);
    expect((error as Error).message).toContain(`UpdateDatabase would address '${SECRET_MASK}'`);
  });

  it('masks the keys of an unresolved name and the recorded name in the non-string refusal', async () => {
    const error = await caught(
      provider.update(
        'Db',
        SHORT2,
        type,
        { DatabaseInput: { Name: { [SHORT]: 'x' } } },
        {},
        { maskSecrets }
      )
    );
    expectMessageMasked(error);
    expect((error as Error).message).toContain(`keys [${SECRET_MASK}]`);
    expect((error as Error).message).toContain(`('${SECRET_MASK}' keeps`);
  });

  it('masks the entity name and a secret catalog id in the catalog-move refusal', async () => {
    const error = await caught(
      provider.update(
        'Db',
        SHORT,
        type,
        { DatabaseInput: { Description: 'd' }, CatalogId: '222222222222' },
        { CatalogId: SHORT_CATALOG },
        { maskSecrets }
      )
    );
    expect(error).toBeInstanceOf(ResourceUpdateNotSupportedError);
    expectMessageMasked(error);
    expect((error as Error).message).toContain(`Data Catalog ${SECRET_MASK}`);
  });

  it('masks the catalog id and the STS text when the caller account cannot be resolved', async () => {
    mockStsSend.mockReset();
    mockStsSend.mockRejectedValue(new Error(`sts refused ${SECRET}`));
    const error = await caught(
      new GlueProvider().update(
        'Db',
        'db',
        type,
        { DatabaseInput: { Description: 'd' } },
        { CatalogId: SHORT_CATALOG },
        { maskSecrets }
      )
    );
    expectMessageMasked(error);
    expect((error as Error).message).toContain(`CatalogId ${SECRET_MASK} is this account's`);
  });

  it('routes the unusable-recorded-catalog warning through the masked sink', async () => {
    answerGlue({ GetDatabaseCommand: { Database: { Parameters: {} } } });
    await provider.update(
      'Db',
      'plaindb',
      type,
      { DatabaseInput: { Description: 'd' }, CatalogId: SHORT_CATALOG },
      { CatalogId: { Ref: 'SomeParam' } },
      { maskSecrets }
    );
    const warns = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warns).toContain(`Data Catalog ${SECRET_MASK}`);
    expect(warns).not.toContain(SHORT_CATALOG);
  });

  it('masks the AWS text in a failed pre-update read', async () => {
    answerGlue({ GetDatabaseCommand: awsEcho(`not authorized on ${SECRET}`) });
    const error = await caught(
      provider.update('Db', 'db', type, { DatabaseInput: { Description: 'd' } }, {}, { maskSecrets })
    );
    expectMessageMasked(error);
  });

  it('behaves exactly as before when no context is supplied -- the back-compatible default', async () => {
    answerGlue();
    await provider.create('Db', type, { DatabaseInput: { Name: SHORT } });
    expect(allLines()).toContain(`Successfully created Glue Database Db: ${SHORT}`);
  });

  it('does not split a longer recorded secret AWS echoes that contains the name (issue #4193)', async () => {
    const longer = `${SHORT} owner hunter2x`;
    answerGlue({ CreateDatabaseCommand: awsEcho(`Description '${longer}' is invalid.`) });
    const error = await caught(
      provider.create('Db', type, { DatabaseInput: { Name: SHORT } }, {
        maskSecrets: createSecretMasker(bagOf(SHORT, longer)),
      })
    );
    expect((error as Error).message).toContain(`Description '${SECRET_MASK}' is invalid.`);
    expect((error as Error).message).not.toContain('owner hunter2x');
  });
});

describe('GlueProvider AWS::Glue::Table (issue #2177)', () => {
  const provider = new GlueProvider();
  const type = 'AWS::Glue::Table';

  it('masks each half of the id on every create() line', async () => {
    answerGlue();
    await provider.create(
      'Tbl',
      type,
      { DatabaseName: SHORT, TableInput: { Name: SHORT2 } },
      { maskSecrets }
    );
    expectTranscriptMasked();
    expect(allLines()).toContain(`${SECRET_MASK}|${SECRET_MASK}`);
  });

  it('masks both names and a secret catalog id in the name-collision refusal', async () => {
    answerGlue({
      CreateTableCommand: new AlreadyExistsException({ message: 'exists', $metadata: {} }),
    });
    const error = await caught(
      provider.create(
        'Tbl',
        type,
        { DatabaseName: SHORT, TableInput: { Name: SHORT2 }, CatalogId: SHORT_CATALOG },
        { maskSecrets }
      )
    );
    expectMessageMasked(error);
    expect((error as Error).message).toContain(
      `a table named '${SECRET_MASK}' is present in database '${SECRET_MASK}' (Data Catalog ${SECRET_MASK})`
    );
  });

  it('masks the AWS message a failed create() wraps', async () => {
    answerGlue({ CreateTableCommand: awsEcho(`Table ${SECRET} rejected`) });
    const error = await caught(
      provider.create('Tbl', type, { DatabaseName: 'db', TableInput: { Name: 't' } }, { maskSecrets })
    );
    expectMessageMasked(error);
  });

  it('masks a SHORT name AWS quotes back in a failed create(), below the substring floor', async () => {
    answerGlue({ CreateTableCommand: awsEcho(`Table ${SHORT2} in ${SHORT} is invalid`) });
    const error = await caught(
      provider.create(
        'Tbl',
        type,
        { DatabaseName: SHORT, TableInput: { Name: SHORT2 } },
        { maskSecrets }
      )
    );
    expectMessageMasked(error);
  });

  it('masks a SHORT top-level Name and a SHORT CatalogId AWS quotes back', async () => {
    answerGlue({
      CreateTableCommand: awsEcho(`Table ${SHORT2} in catalog ${SHORT_CATALOG} is invalid`),
    });
    const error = await caught(
      provider.create(
        'Tbl',
        type,
        { DatabaseName: 'db', TableInput: {}, Name: SHORT2, CatalogId: SHORT_CATALOG },
        { maskSecrets }
      )
    );
    expectMessageMasked(error);
  });

  it('masks TWO-character names on each half by the RAW mask alone, on create() and update()', async () => {
    answerGlue({ GetTableCommand: { Table: {} } });
    await provider.create(
      'Tbl',
      type,
      { DatabaseName: TINY_A, TableInput: { Name: TINY_B } },
      { maskSecrets }
    );
    await provider.update(
      'Tbl',
      `${TINY_A}|${TINY_B}`,
      type,
      { DatabaseName: TINY_A, TableInput: { Name: TINY_B } },
      {},
      { maskSecrets }
    );
    expectTinyMasked(
      'Creating Glue Table Tbl',
      `Successfully created Glue Table Tbl: ${SECRET_MASK}|${SECRET_MASK}`,
      `Updating Glue Table Tbl: ${SECRET_MASK}|${SECRET_MASK}`
    );
  });

  it('prints ordinary names on the create() line -- negative control', async () => {
    answerGlue();
    await provider.create(
      'Tbl',
      type,
      { DatabaseName: 'plaindb', TableInput: { Name: 'plaintbl' } },
      { maskSecrets }
    );
    expect(allLines()).toContain('Successfully created Glue Table Tbl: plaindb|plaintbl');
  });

  it('routes the Iceberg create-replay and update warnings through the masked sink', async () => {
    const iceberg = { IcebergInput: { IcebergTableInput: {} } };
    answerGlue({ GetTableCommand: { Table: {} } });
    await provider.create(
      'Tbl',
      type,
      { DatabaseName: 'plaindb', TableInput: { Name: 't' }, OpenTableFormatInput: iceberg },
      { maskSecrets: markingMasker, replayingState: true }
    );
    expect(warnLines()).toHaveLength(1);
    await provider.update(
      'Tbl',
      'plaindb|t',
      type,
      { DatabaseName: 'plaindb', TableInput: { Name: 't' }, OpenTableFormatInput: iceberg },
      {},
      { maskSecrets: markingMasker }
    );
    expect(warnLines()).toHaveLength(2);
    for (const line of warnLines()) {
      expect(line.startsWith(MARK)).toBe(true);
      expect(line).toContain('IcebergTableInput');
    }
  });

  it('masks the keys of a non-string name in the create refusal', async () => {
    const error = await caught(
      provider.create(
        'Tbl',
        type,
        { DatabaseName: 'db', TableInput: { Name: { [SHORT]: 1 } } },
        { maskSecrets }
      )
    );
    expectMessageMasked(error);
  });

  it('masks each half of the recorded id on every update() line', async () => {
    answerGlue({ GetTableCommand: { Table: {} } });
    await provider.update(
      'Tbl',
      `${SHORT}|${SHORT2}`,
      type,
      { DatabaseName: SHORT, TableInput: { Name: SHORT2 } },
      {},
      { maskSecrets }
    );
    expectTranscriptMasked();
    expect(allLines()).toContain(`${SECRET_MASK}|${SECRET_MASK}`);
  });

  it('masks each half of an id recorded from ROTATED secrets', async () => {
    answerGlue({ GetTableCommand: { Table: {} } });
    await provider.update(
      'Tbl',
      'oldplaindb|oldplaintbl',
      type,
      { DatabaseName: 'newdb', TableInput: {} },
      { DatabaseName: REF, TableInput: { Name: REF } },
      { maskSecrets }
    );
    expect(allLines()).not.toContain('oldplaindb');
    expect(allLines()).not.toContain('oldplaintbl');
    expect(allLines()).toContain(`${SECRET_MASK}|${SECRET_MASK}`);
  });

  it('masks a ROTATED recorded table half, and a ROTATED database half, AWS quotes back', async () => {
    answerGlue({
      GetTableCommand: { Table: {} },
      UpdateTableCommand: awsEcho('Table oldplaintbl rejected'),
    });
    const half = await caught(
      provider.update(
        'Tbl',
        'db|oldplaintbl',
        type,
        { DatabaseName: 'db', TableInput: {} },
        { DatabaseName: 'db', TableInput: { Name: REF } },
        { maskSecrets }
      )
    );
    expect((half as Error).message).not.toContain('oldplaintbl');
    expect((half as Error).message).toContain(SECRET_MASK);
    answerGlue({ GetTableCommand: awsEcho('no access to oldplaindb|a|b') });
    const whole = await caught(
      provider.update(
        'Tbl',
        'oldplaindb|a|b',
        type,
        { DatabaseName: 'oldplaindb', TableInput: {} },
        { DatabaseName: SECRET_MASK },
        { maskSecrets }
      )
    );
    // `oldplaindb` anchors the id, so it DECODES to (`oldplaindb`, `a|b`): the
    // database half is the rotated needle here. (An id that cannot decode is
    // refused before any AWS call, so it has no echo to test.)
    expect((whole as Error).message).not.toContain('oldplaindb');
    expect((whole as Error).message).toContain(`no access to ${SECRET_MASK}|a|b`);
  });

  it('masks a table name recorded from a ROTATED top-level Name', async () => {
    answerGlue({ GetTableCommand: { Table: {} } });
    await provider.update(
      'Tbl',
      'db|oldplaintbl',
      type,
      { DatabaseName: 'db', TableInput: {} },
      { DatabaseName: 'db', Name: REF },
      { maskSecrets }
    );
    expect(allLines()).not.toContain('oldplaintbl');
    expect(allLines()).toContain(`db|${SECRET_MASK}`);
  });

  it('leaves ordinary recorded names visible -- negative control', async () => {
    answerGlue({ GetTableCommand: { Table: {} } });
    await provider.update(
      'Tbl',
      'plaindb|plaintbl',
      type,
      { DatabaseName: 'plaindb', TableInput: { Name: 'plaintbl' } },
      { DatabaseName: 'plaindb', TableInput: { Name: 'plaintbl' }, Name: 'plaintbl' },
      { maskSecrets }
    );
    expect(allLines()).toContain('plaindb|plaintbl');
  });

  it('masks a ROTATED recorded table name in the rename refusal', async () => {
    const error = await caught(
      provider.update(
        'Tbl',
        'db|oldplaintbl',
        type,
        { DatabaseName: 'db', TableInput: { Name: SECRET } },
        { DatabaseName: 'db', TableInput: { Name: REF } },
        { maskSecrets }
      )
    );
    expect(error).toBeInstanceOf(ResourceUpdateNotSupportedError);
    expect((error as Error).message).not.toContain('oldplaintbl');
  });

  it('masks a ROTATED database name inside an id it cannot decode', async () => {
    // `oldplaindb|a|b`: neither bag's DatabaseName anchors it and it has more
    // than one `|`, so there are no halves -- the whole id is the needle.
    const error = await caught(
      provider.update(
        'Tbl',
        'oldplaindb|a|b',
        type,
        { DatabaseName: 'newdb', TableInput: {} },
        { DatabaseName: REF },
        { maskSecrets }
      )
    );
    expect((error as Error).message).not.toContain('oldplaindb');
    expect(allLines()).not.toContain('oldplaindb');
    expect(allLines()).toContain(SECRET_MASK);
  });

  it('masks an undecodable id whose ROTATED source is the table name, by either spelling', async () => {
    for (const previous of [{ TableInput: { Name: REF } }, { Name: REF }]) {
      debugSpy.mockClear();
      const error = await caught(
        provider.update(
          'Tbl',
          'db|oldplain|tbl',
          type,
          { DatabaseName: 'newdb', TableInput: {} },
          previous,
          { maskSecrets }
        )
      );
      expect((error as Error).message).not.toContain('oldplain');
      expect(allLines()).not.toContain('oldplain');
    }
  });

  it('masks a SHORT undecodable id on the update() line and in the refusal', async () => {
    const error = await caught(
      provider.update('Tbl', SHORT, type, { TableInput: {} }, {}, { maskSecrets })
    );
    expectMessageMasked(error);
    expectTranscriptMasked();
  });

  it('masks every name in the rename refusal', async () => {
    const error = await caught(
      provider.update(
        'Tbl',
        `${SHORT}|${SHORT2}`,
        type,
        { DatabaseName: SHORT, TableInput: { Name: 'renamed' } },
        {},
        { maskSecrets }
      )
    );
    expect(error).toBeInstanceOf(ResourceUpdateNotSupportedError);
    expectMessageMasked(error);
    expect((error as Error).message).toContain(
      `in database '${SECRET_MASK}' (possibly one cdkd does not manage) while the state record kept '${SECRET_MASK}'`
    );
  });

  it('masks each half of the entity name and a secret catalog id in the catalog-move refusal', async () => {
    const error = await caught(
      provider.update(
        'Tbl',
        `${SHORT}|${SHORT2}`,
        type,
        { DatabaseName: SHORT, TableInput: { Name: SHORT2 }, CatalogId: '222222222222' },
        { CatalogId: SHORT_CATALOG },
        { maskSecrets }
      )
    );
    expectMessageMasked(error);
    expect((error as Error).message).toContain(
      `'${SECRET_MASK}.${SECRET_MASK}' from Data Catalog ${SECRET_MASK}`
    );
  });

  it('masks the AWS message a failed update() wraps, and a failed pre-update read', async () => {
    answerGlue({
      GetTableCommand: { Table: {} },
      UpdateTableCommand: awsEcho(`Table ${SECRET} rejected`),
    });
    const bag = { DatabaseName: 'db', TableInput: { Name: 'tbl' } };
    expectMessageMasked(await caught(provider.update('Tbl', 'db|tbl', type, bag, {}, { maskSecrets })));
    answerGlue({ GetTableCommand: awsEcho(`no access to ${SECRET}`) });
    expectMessageMasked(await caught(provider.update('Tbl', 'db|tbl', type, bag, {}, { maskSecrets })));
  });
});

/**
 * One row per sibling provider: the bag that creates it, the desired bag an
 * update sends, where its recorded name lives in a previous bag, and the
 * create / update commands a failure is injected into.
 */
const SIBLINGS = [
  {
    label: 'Workflow',
    make: () => new GlueWorkflowProvider(),
    type: 'AWS::Glue::Workflow',
    createBag: (name: string) => ({ Name: name }),
    updateBag: {},
    previousWithName: (name: string) => ({ Name: name }),
    createCommand: 'CreateWorkflowCommand',
    updateCommand: 'UpdateWorkflowCommand',
  },
  {
    label: 'Job',
    make: () => new GlueJobProvider(),
    type: 'AWS::Glue::Job',
    createBag: (name: string) => ({ Name: name, Role: 'r', Command: { Name: 'glueetl' } }),
    updateBag: { Role: 'r' },
    previousWithName: (name: string) => ({ Name: name }),
    createCommand: 'CreateJobCommand',
    updateCommand: 'UpdateJobCommand',
  },
  {
    label: 'Crawler',
    make: () => new GlueCrawlerProvider(),
    type: 'AWS::Glue::Crawler',
    createBag: (name: string) => ({ Name: name, Role: 'r', Targets: {} }),
    updateBag: { Role: 'r' },
    previousWithName: (name: string) => ({ Name: name }),
    createCommand: 'CreateCrawlerCommand',
    updateCommand: 'UpdateCrawlerCommand',
  },
  {
    label: 'Connection',
    make: () => new GlueConnectionProvider(),
    type: 'AWS::Glue::Connection',
    createBag: (name: string) => ({ ConnectionInput: { Name: name, ConnectionType: 'JDBC' } }),
    updateBag: { ConnectionInput: { ConnectionType: 'JDBC' } },
    previousWithName: (name: string) => ({ ConnectionInput: { Name: name } }),
    createCommand: 'CreateConnectionCommand',
    updateCommand: 'UpdateConnectionCommand',
  },
  {
    label: 'Trigger',
    make: () => new GlueTriggerProvider(),
    type: 'AWS::Glue::Trigger',
    createBag: (name: string) => ({ Name: name, Type: 'ON_DEMAND', Actions: [] }),
    updateBag: {},
    previousWithName: (name: string) => ({ Name: name }),
    createCommand: 'CreateTriggerCommand',
    updateCommand: 'UpdateTriggerCommand',
  },
] as const;

describe.each(SIBLINGS)('Glue $label (issue #2177)', (row) => {
  it('masks a SHORT name on every create() line', async () => {
    answerGlue();
    await row.make().create('Res', row.type, row.createBag(SHORT), { maskSecrets });
    expectTranscriptMasked();
  });

  it('masks a TWO-character name by the RAW mask alone on the create() and update() lines', async () => {
    answerGlue();
    await row.make().create('Res', row.type, row.createBag(TINY_A), { maskSecrets });
    await row.make().update('Res', TINY_A, row.type, row.updateBag, {}, { maskSecrets });
    expectTinyMasked(
      `Creating Glue ${row.label} Res`,
      `Successfully created Glue ${row.label} Res: ${SECRET_MASK}`,
      `Updating Glue ${row.label} Res: ${SECRET_MASK}`
    );
  });

  it('prints an ordinary name on the create() line -- negative control', async () => {
    answerGlue();
    await row.make().create('Res', row.type, row.createBag('plainname'), { maskSecrets });
    expect(allLines()).toContain(`Successfully created Glue ${row.label} Res: plainname`);
  });

  it('masks the AWS message a failed create() wraps', async () => {
    answerGlue({ [row.createCommand]: awsEcho(`name ${SECRET} rejected`) });
    expectMessageMasked(
      await caught(row.make().create('Res', row.type, row.createBag('plain'), { maskSecrets }))
    );
  });

  it('masks a SHORT name AWS quotes back in a failed create(), below the substring floor', async () => {
    answerGlue({ [row.createCommand]: awsEcho(`name ${SHORT} rejected`) });
    expectMessageMasked(
      await caught(row.make().create('Res', row.type, row.createBag(SHORT), { maskSecrets }))
    );
  });

  it('masks a SHORT recorded name AWS quotes back in a failed update()', async () => {
    answerGlue({ [row.updateCommand]: awsEcho(`name ${SHORT} rejected`) });
    expectMessageMasked(
      await caught(row.make().update('Res', SHORT, row.type, row.updateBag, {}, { maskSecrets }))
    );
  });

  it('masks a SHORT recorded name on every update() line', async () => {
    answerGlue();
    await row.make().update('Res', SHORT, row.type, row.updateBag, {}, { maskSecrets });
    expectTranscriptMasked();
  });

  it('masks the AWS message a failed update() wraps', async () => {
    answerGlue({ [row.updateCommand]: awsEcho(`name ${SECRET} rejected`) });
    expectMessageMasked(
      await caught(row.make().update('Res', 'plain', row.type, row.updateBag, {}, { maskSecrets }))
    );
  });

  it('masks a ROTATED recorded name AWS quotes back in a failed update(), for either persisted shape', async () => {
    for (const previous of [REF, SECRET_MASK]) {
      answerGlue({ [row.updateCommand]: awsEcho('name oldplainname is invalid') });
      const error = await caught(
        row
          .make()
          .update('Res', 'oldplainname', row.type, row.updateBag, row.previousWithName(previous), {
            maskSecrets,
          })
      );
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain('oldplainname');
      expect((error as Error).message).toContain(SECRET_MASK);
    }
  });

  it('masks a name recorded from a ROTATED secret, and leaves an ordinary one visible', async () => {
    answerGlue();
    await row
      .make()
      .update('Res', 'oldplainname', row.type, row.updateBag, row.previousWithName(REF), {
        maskSecrets,
      });
    expect(allLines()).not.toContain('oldplainname');
    expect(allLines()).toContain(SECRET_MASK);
    debugSpy.mockClear();
    await row
      .make()
      .update('Res', 'plainname', row.type, row.updateBag, row.previousWithName('plainname'), {
        maskSecrets,
      });
    expect(allLines()).toContain('plainname');
  });
});

describe('the sibling-specific Glue message sites (issue #2177)', () => {
  it('SecurityConfiguration: masks the name on create() and the AWS message it wraps', async () => {
    const provider = new GlueSecurityConfigurationProvider();
    const type = 'AWS::Glue::SecurityConfiguration';
    answerGlue();
    await provider.create(
      'Sc',
      type,
      { Name: SHORT, EncryptionConfiguration: {} },
      { maskSecrets }
    );
    expectTranscriptMasked();
    answerGlue({ CreateSecurityConfigurationCommand: awsEcho(`name ${SECRET} taken`) });
    expectMessageMasked(
      await caught(
        provider.create('Sc', type, { Name: 'sc', EncryptionConfiguration: {} }, { maskSecrets })
      )
    );
    answerGlue({ CreateSecurityConfigurationCommand: awsEcho(`name ${SHORT} taken`) });
    expectMessageMasked(
      await caught(
        provider.create('Sc', type, { Name: SHORT, EncryptionConfiguration: {} }, { maskSecrets })
      )
    );
  });

  it('SecurityConfiguration: masks a TWO-character name by the RAW mask alone, and prints an ordinary one', async () => {
    const provider = new GlueSecurityConfigurationProvider();
    const type = 'AWS::Glue::SecurityConfiguration';
    answerGlue();
    await provider.create('Sc', type, { Name: TINY_A, EncryptionConfiguration: {} }, { maskSecrets });
    expectTinyMasked(
      'Creating Glue SecurityConfiguration Sc',
      `Successfully created Glue SecurityConfiguration Sc: ${SECRET_MASK}`
    );
    await provider.create('Sc', type, { Name: 'plainsc', EncryptionConfiguration: {} }, { maskSecrets });
    expect(allLines()).toContain('Successfully created Glue SecurityConfiguration Sc: plainsc');
  });

  it('Crawler: masks a TWO-character name by the RAW mask alone on the stop-and-retry lines', async () => {
    answerGlue({
      UpdateCrawlerCommand: [
        new CrawlerRunningException({ message: 'running', $metadata: {} }),
        {},
      ],
      StopCrawlerCommand: new CrawlerNotRunningException({ message: 'not running', $metadata: {} }),
      GetCrawlerCommand: { Crawler: { State: 'READY' } },
    });
    await new GlueCrawlerProvider().update(
      'Cr',
      TINY_A,
      'AWS::Glue::Crawler',
      { Role: 'r' },
      {},
      { maskSecrets }
    );
    expectTinyMasked(
      `Glue Crawler ${SECRET_MASK} is running`,
      `StopCrawler for ${SECRET_MASK} returned CrawlerNotRunningException`
    );
  });

  it('Crawler: masks a SHORT name on the stop-and-retry update() lines', async () => {
    answerGlue({
      UpdateCrawlerCommand: [
        new CrawlerRunningException({ message: 'running', $metadata: {} }),
        {},
      ],
      StopCrawlerCommand: new CrawlerNotRunningException({ message: 'not running', $metadata: {} }),
      GetCrawlerCommand: { Crawler: { State: 'READY' } },
    });
    await new GlueCrawlerProvider().update(
      'Cr',
      SHORT,
      'AWS::Glue::Crawler',
      { Role: 'r' },
      {},
      { maskSecrets }
    );
    expectTranscriptMasked();
    expect(allLines()).toContain(`Glue Crawler ${SECRET_MASK} is running`);
    expect(allLines()).toContain(`StopCrawler for ${SECRET_MASK}`);
  });

  it('Connection: masks the recorded name in the rename refusal', async () => {
    const error = await caught(
      new GlueConnectionProvider().update(
        'Conn',
        SHORT,
        'AWS::Glue::Connection',
        { ConnectionInput: { Name: 'other', ConnectionType: 'JDBC' } },
        {},
        { maskSecrets }
      )
    );
    expect(error).toBeInstanceOf(ResourceUpdateNotSupportedError);
    expectMessageMasked(error);
    expect((error as Error).message).toContain(`UpdateConnection would address '${SECRET_MASK}'`);
  });

  it('Connection: masks a ROTATED recorded name in the rename and catalog-move refusals', async () => {
    const renamed = await caught(
      new GlueConnectionProvider().update(
        'Conn',
        'oldplainconn',
        'AWS::Glue::Connection',
        { ConnectionInput: { Name: SECRET, ConnectionType: 'JDBC' } },
        { ConnectionInput: { Name: REF } },
        { maskSecrets }
      )
    );
    expect(renamed).toBeInstanceOf(ResourceUpdateNotSupportedError);
    expect((renamed as Error).message).not.toContain('oldplainconn');
    const moved = await caught(
      new GlueConnectionProvider().update(
        'Conn',
        'oldplainconn',
        'AWS::Glue::Connection',
        { ConnectionInput: { ConnectionType: 'JDBC' }, CatalogId: '222222222222' },
        { ConnectionInput: { Name: REF }, CatalogId: '111111111111' },
        { maskSecrets }
      )
    );
    expect(moved).toBeInstanceOf(ResourceUpdateNotSupportedError);
    expect((moved as Error).message).not.toContain('oldplainconn');
  });

  it('Connection: masks a SHORT CatalogId AWS quotes back in a failed create()', async () => {
    answerGlue({ CreateConnectionCommand: awsEcho(`catalog ${SHORT_CATALOG} not found`) });
    expectMessageMasked(
      await caught(
        new GlueConnectionProvider().create(
          'Conn',
          'AWS::Glue::Connection',
          { ConnectionInput: { Name: 'conn', ConnectionType: 'JDBC' }, CatalogId: SHORT_CATALOG },
          { maskSecrets }
        )
      )
    );
  });

  it('Connection: masks a secret catalog id in the catalog-move refusal', async () => {
    const error = await caught(
      new GlueConnectionProvider().update(
        'Conn',
        'conn',
        'AWS::Glue::Connection',
        { ConnectionInput: { ConnectionType: 'JDBC' }, CatalogId: '222222222222' },
        { CatalogId: SHORT_CATALOG },
        { maskSecrets }
      )
    );
    expectMessageMasked(error);
  });

  it('Trigger: masks a SHORT name on the pre-check line, and the AWS text through the sink', async () => {
    answerGlue({ GetTriggerCommand: awsEcho(`cannot read ${SECRET}`) });
    await new GlueTriggerProvider().update(
      'Tr',
      SHORT,
      'AWS::Glue::Trigger',
      {},
      {},
      { maskSecrets }
    );
    expectTranscriptMasked();
    expect(allLines()).toContain(`GetTrigger pre-check failed for ${SECRET_MASK}`);
  });

  it('Trigger: masks a ROTATED recorded name AWS quotes back on the pre-check line', async () => {
    answerGlue({ GetTriggerCommand: awsEcho('cannot read oldplaintrigger') });
    await new GlueTriggerProvider().update(
      'Tr',
      'oldplaintrigger',
      'AWS::Glue::Trigger',
      {},
      { Name: REF },
      { maskSecrets }
    );
    expect(allLines()).not.toContain('oldplaintrigger');
    expect(allLines()).toContain(`cannot read ${SECRET_MASK}`);
  });

  it('Trigger: masks a TWO-character name by the RAW mask alone on the pre-check and re-activation lines', async () => {
    answerGlue({ GetTriggerCommand: awsEcho('cannot read the trigger') });
    await new GlueTriggerProvider().update('Tr', TINY_A, 'AWS::Glue::Trigger', {}, {}, { maskSecrets });
    answerGlue({
      GetTriggerCommand: [{ Trigger: { State: 'ACTIVATED' } }, { Trigger: { State: 'DEACTIVATED' } }],
      UpdateTriggerCommand: awsEcho('update rejected'),
      StartTriggerCommand: awsEcho('start rejected'),
    });
    await caught(
      new GlueTriggerProvider().update('Tr', TINY_A, 'AWS::Glue::Trigger', {}, {}, { maskSecrets })
    );
    expectTinyMasked(
      `GetTrigger pre-check failed for ${SECRET_MASK}`,
      `Failed to re-activate Glue Trigger ${SECRET_MASK}`
    );
  });

  it('Trigger: masks the re-activation warning after a failed update', async () => {
    answerGlue({
      GetTriggerCommand: [{ Trigger: { State: 'ACTIVATED' } }, { Trigger: { State: 'DEACTIVATED' } }],
      UpdateTriggerCommand: awsEcho(`update of ${SECRET} rejected`),
      StartTriggerCommand: awsEcho(`start of ${SECRET} rejected`),
    });
    const error = await caught(
      new GlueTriggerProvider().update('Tr', SHORT, 'AWS::Glue::Trigger', {}, {}, { maskSecrets })
    );
    expectMessageMasked(error);
    const warns = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warns).toContain(`Failed to re-activate Glue Trigger ${SECRET_MASK}`);
    for (const plaintext of PLAINTEXTS) expect(warns).not.toContain(plaintext);
  });

  it('delete() keeps logging through the plain logger (issue #2007 owns its masker)', async () => {
    answerGlue({ DeleteJobCommand: new EntityNotFoundException({ message: 'gone', $metadata: {} }) });
    await new GlueJobProvider().delete('Job', SHORT, 'AWS::Glue::Job');
    // Pins the KNOWN residual, not a contract: flip this when #2007 threads a
    // masker into delete().
    expect(allLines()).toContain(`Glue Job ${SHORT} does not exist`);
  });
});
