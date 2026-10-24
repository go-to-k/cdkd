import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const { mockSend, debug } = vi.hoisted(() => ({ mockSend: vi.fn(), debug: vi.fn() }));

vi.mock('@aws-sdk/client-codecommit', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return {
    ...actual,
    CodeCommitClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
      middlewareStack: { add: vi.fn(), addRelativeTo: vi.fn() },
    })),
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug,
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return { getLogger: () => ({ ...childLogger, child: () => childLogger }) };
});

import { CodeCommitRepositoryProvider } from '../../../src/provisioning/providers/codecommit-repository-provider.js';
import {
  hasRedactedCause,
  isMarkedNonRetryable,
  isRetryableTransientError,
  retryClassificationText,
} from '../../../src/deployment/retryable-errors.js';
import { isMarkedNotGone } from '../../../src/provisioning/not-gone.js';
import { VERBOSE_POINTER } from '../../../src/utils/aws-failure-text.js';

// go-to-k/cdkd#2319: every create / update / delete wrap is persisted to
// `deployments/{runId}.jsonl`, so an AWS-authored failure is named by its class
// plus the --verbose pointer; AWS's text (the caller's role ARN) goes to the
// masked debug line and stays on `cause` for the retry classifiers.
const ACCOUNT = '111122223333';
const DENIED = `User: arn:aws:sts::${ACCOUNT}:assumed-role/deployer/s3cr3t is not authorized to perform: codecommit:X`;
const denied = (): Error =>
  Object.assign(new Error(DENIED), {
    name: 'AccessDeniedException',
    $fault: 'client',
    $metadata: { httpStatusCode: 400 },
  });
const mask = (t: string): string => t.replaceAll('s3cr3t', '***');
const debugLines = (): string[] => debug.mock.calls.map((c) => String(c[0]));

const TYPE = 'AWS::CodeCommit::Repository';
const TOPIC = `arn:aws:sns:us-east-1:${ACCOUNT}:t`;

async function caught(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected a rejection');
}

/** Answer by command name; `fail` rejects with `error`, everything else `answers` or `{}`. */
function failOn(fail: string, error: unknown, answers: Record<string, unknown> = {}): void {
  mockSend.mockImplementation(async (cmd: { constructor: { name: string } }) => {
    const name = cmd.constructor.name;
    if (name === fail) throw error;
    return answers[name] ?? {};
  });
}

const CREATED = {
  CreateRepositoryCommand: { repositoryMetadata: { repositoryName: 'repo', repositoryId: 'id-1' } },
};

const cases: Array<{
  wrap: string;
  fail: string;
  answers?: Record<string, unknown>;
  run: (p: CodeCommitRepositoryProvider) => Promise<unknown>;
}> = [
  {
    wrap: 'Failed to create CodeCommit Repository Repo',
    fail: 'CreateRepositoryCommand',
    run: (p) => p.create('Repo', TYPE, { RepositoryName: 'repo' }, { maskSecrets: mask }),
  },
  {
    // A post-create step: the repository was created, then the trigger put failed.
    wrap: 'Failed to create CodeCommit Repository Repo',
    fail: 'PutRepositoryTriggersCommand',
    answers: CREATED,
    run: (p) =>
      p.create(
        'Repo',
        TYPE,
        {
          RepositoryName: 'repo',
          Triggers: [{ Name: 't', DestinationArn: TOPIC, Events: ['all'] }],
        },
        { maskSecrets: mask }
      ),
  },
  {
    wrap: 'Failed to update CodeCommit Repository Repo',
    fail: 'UpdateRepositoryDescriptionCommand',
    run: (p) =>
      p.update('Repo', 'repo', TYPE, { RepositoryDescription: 'a' }, { RepositoryDescription: 'b' }, {
        maskSecrets: mask,
      }),
  },
  {
    wrap: 'Failed to delete CodeCommit Repository Repo',
    fail: 'DeleteRepositoryCommand',
    run: (p) => p.delete('Repo', 'repo', TYPE, undefined, { maskSecrets: mask }),
  },
];

describe('CodeCommitRepositoryProvider thrown wraps withhold AWS text (#2319)', () => {
  let provider: CodeCommitRepositoryProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    provider = new CodeCommitRepositoryProvider();
  });

  it.each(cases)('$fail: an AWS-authored failure is named by its class', async (c) => {
    failOn(c.fail, denied(), c.answers);

    const failure = await caught(c.run(provider));

    expect(mockSend.mock.calls.some((call) => call[0].constructor.name === c.fail)).toBe(true);
    expect(failure.message).toBe(`${c.wrap}: AccessDeniedException. ${VERBOSE_POINTER}`);
    expect(failure.message).not.toContain(ACCOUNT);
    expect((failure.cause as Error).message).toBe(DENIED);
    expect(hasRedactedCause(failure)).toBe(true);
    // `not authorized to perform` is retryable (IAM propagation), read on the chain.
    expect(isRetryableTransientError(failure, retryClassificationText(failure))).toBe(true);
    expect(debugLines()).toContain(`${c.wrap}: ${mask(DENIED)}`);
    expect(debugLines().join('\n')).not.toContain('s3cr3t');
  });

  it.each(cases)('$fail: a cdkd-authored failure keeps its text, masked', async (c) => {
    failOn(c.fail, new Error('socket hang up near s3cr3t'), c.answers);

    const failure = await caught(c.run(provider));

    expect(failure.message).toBe(`${c.wrap}: socket hang up near ***`);
    // The mask changed the text, so the wrap is stamped (issue #4259).
    expect(hasRedactedCause(failure)).toBe(true);
  });

  it('a cdkd-authored failure the mask leaves alone is not stamped', async () => {
    failOn('DeleteRepositoryCommand', new Error('socket hang up'));

    const failure = await caught(cases[3]!.run(provider));

    expect(failure.message).toBe(`${cases[3]!.wrap}: socket hang up`);
    expect(hasRedactedCause(failure)).toBe(false);
  });

  it('a non-Error throw is withheld, unstamped', async () => {
    failOn('DeleteRepositoryCommand', 'raw s3cr3t value');

    const failure = await caught(provider.delete('Repo', 'repo', TYPE));

    expect(failure.message).toBe(
      `Failed to delete CodeCommit Repository Repo: a non-Error value of type string. ${VERBOSE_POINTER}`
    );
    expect(hasRedactedCause(failure)).toBe(false);
  });

  it('a delete refused for a missing KMS key never reads as already deleted', async () => {
    // The class name spells `NotFound`, which the destroy and deploy delete
    // classifiers read as "already deleted" unless the error is marked.
    failOn(
      'DeleteRepositoryCommand',
      Object.assign(new Error('No encryption key was found.'), {
        name: 'EncryptionKeyNotFoundException',
        $fault: 'client',
        $metadata: { httpStatusCode: 400 },
      })
    );

    const failure = await caught(provider.delete('Repo', 'repo', TYPE));

    expect(failure.message).toBe(
      `Failed to delete CodeCommit Repository Repo: EncryptionKeyNotFoundException. ${VERBOSE_POINTER}`
    );
    expect(isMarkedNotGone(failure)).toBe(true);
    expect(isMarkedNonRetryable(failure)).toBe(false);
  });

  it('an ordinary delete failure is not marked', async () => {
    failOn('DeleteRepositoryCommand', denied());

    const failure = await caught(provider.delete('Repo', 'repo', TYPE));

    expect(isMarkedNotGone(failure)).toBe(false);
    expect(isMarkedNonRetryable(failure)).toBe(false);
  });

  const alreadyExists = (): Error =>
    Object.assign(new Error('Repository named repo already exists'), {
      name: 'RepositoryNameExistsException',
      $fault: 'client',
      $metadata: { httpStatusCode: 400 },
    });

  it('restates an "already exists" from CreateRepository', async () => {
    failOn('CreateRepositoryCommand', alreadyExists());

    const failure = await caught(provider.create('Repo', TYPE, { RepositoryName: 'repo' }));

    expect(failure.message).toBe(
      `Failed to create CodeCommit Repository Repo: RepositoryNameExistsException. ${VERBOSE_POINTER} AWS reports that it already exists.`
    );
  });

  it('does not restate it from a post-create step', async () => {
    failOn('PutRepositoryTriggersCommand', alreadyExists(), CREATED);

    const failure = await caught(cases[1]!.run(provider));

    expect(failure.message).toBe(
      `Failed to create CodeCommit Repository Repo: RepositoryNameExistsException. ${VERBOSE_POINTER}`
    );
  });

  it('a failed trigger put beside kept live triggers names the class', async () => {
    failOn('PutRepositoryTriggersCommand', denied(), {
      GetRepositoryTriggersCommand: {
        triggers: [{ name: 'live', destinationArn: TOPIC, events: ['all'] }],
      },
    });

    const failure = await caught(
      provider.update(
        'Repo',
        'repo',
        TYPE,
        { Triggers: [{ Name: 't', DestinationArn: TOPIC, Events: ['all'] }] },
        { Triggers: {} },
        { maskSecrets: mask }
      )
    );

    expect(failure.message).toContain('with 1 live trigger(s) the desired Triggers does not name');
    expect(failure.message).toContain(
      `CodeCommit allows at most 10 triggers per repository): AccessDeniedException. ${VERBOSE_POINTER}`
    );
    expect(failure.message).not.toContain(ACCOUNT);
    expect(hasRedactedCause(failure)).toBe(true);
    expect(isRetryableTransientError(failure, retryClassificationText(failure))).toBe(true);
    expect(debugLines().join('\n')).toContain(mask(DENIED));
    expect(debugLines().join('\n')).not.toContain('s3cr3t');
  });
});
