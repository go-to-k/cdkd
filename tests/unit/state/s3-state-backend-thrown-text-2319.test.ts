/**
 * `S3StateBackend`'s thrown messages name an AWS failure by its CLASS
 * (go-to-k/cdkd#2319).
 *
 * A thrown state message is persisted: `listStacks` runs inside the
 * `Fn::ImportValue` fallback scan mid-deploy, and its refusal reaches
 * `deployments/{runId}.jsonl` through `extractDeploymentEventError`, which
 * keeps a cdkd-authored message whole. On an `AccessDenied` S3's text names
 * the caller's assumed-role ARN and account id. Each converted site is driven
 * with that failure and must:
 *
 * - keep its cdkd prefix and name the class plus the `--verbose` pointer;
 * - drop AWS's text and the account id (the fake error carries both: the
 *   positive control);
 * - keep the original error as `cause`, stamped `markRedactedCause`, so a
 *   retry classifier still reads `not authorized` on the chain;
 * - log AWS's text at `debug`, under the logger's bound-secret mask;
 * - mask a secret spelled in the CLASS (it is AWS-authored text too), and
 *   flatten a class that forges a line.
 *
 * A cdkd-authored failure (`normalizeAwsError`'s rewrite of S3's body-less
 * `Unknown`) keeps its text, unstamped.
 */
import { describe, it, expect, beforeEach, vi } from 'vite-plus/test';
import { S3Client, S3ServiceException, NoSuchKey } from '@aws-sdk/client-s3';
import { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import type { StateBackendConfig } from '../../../src/types/config.js';
import type { StackState } from '../../../src/types/state.js';
import { VERBOSE_POINTER } from '../../../src/utils/aws-failure-text.js';
import { hasRedactedCause } from '../../../src/deployment/retryable-errors/marks.js';
import { retryClassificationText } from '../../../src/deployment/retryable-errors/transient.js';
import { withPrintingSecrets } from '../../../src/deployment/resource-secrets-scope.js';
import { recordLogOnlyValue, SECRET_MASK } from '../../../src/deployment/secret-redaction.js';
import { currentLogLineMasker } from '../../../src/utils/log-line-masker.js';

const { logs } = vi.hoisted(() => ({
  logs: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({ child: () => logs, ...logs }),
}));

vi.mock('../../../src/utils/expected-bucket-owner.js', () => ({
  expectedOwnerParam: vi.fn().mockResolvedValue({}),
}));

vi.mock('../../../src/utils/aws-region-resolver.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/utils/aws-region-resolver.js')>(
    '../../../src/utils/aws-region-resolver.js'
  );
  return { ...actual, resolveBucketRegion: vi.fn().mockResolvedValue('us-east-1') };
});

const ACCOUNT = '123456789012';
const AWS_TEXT =
  `User: arn:aws:sts::${ACCOUNT}:assumed-role/Deployer/session-x is not authorized ` +
  `to perform: s3:Op on resource: "arn:aws:s3:::b/stacks/MyStack/us-east-1/state.json"`;

const s3err = (name = 'AccessDenied', message = AWS_TEXT): S3ServiceException =>
  new S3ServiceException({
    name,
    message,
    $fault: 'client',
    $metadata: { httpStatusCode: 403 },
  } as never);

type Reply = () => unknown;
const fail =
  (error: unknown): Reply =>
  () => {
    throw error;
  };

/** A client double driven by per-command queues; unqueued calls succeed empty. */
function makeClient(): { client: S3Client; queue: (command: string, ...r: Reply[]) => void } {
  const queues = new Map<string, Reply[]>();
  const send = vi.fn(async (command: { constructor: { name: string } }) => {
    const next = queues.get(command.constructor.name)?.shift();
    if (next) return next();
    return {};
  });
  return {
    client: {
      send,
      config: {
        region: () => Promise.resolve('us-east-1'),
        credentials: () => Promise.resolve({ accessKeyId: 'AKIAFAKE', secretAccessKey: 'x' }),
      },
    } as unknown as S3Client,
    queue: (command, ...replies) => {
      queues.set(command, [...(queues.get(command) ?? []), ...replies]);
    },
  };
}

const config: StateBackendConfig = { bucket: 'b', prefix: 'stacks' };
const STACK = 'MyStack';
const REGION = 'us-east-1';
const state = {
  version: 1,
  stackName: STACK,
  resources: {},
  outputs: {},
  lastModified: 0,
} as unknown as StackState;
const noSuchKey = (): NoSuchKey => new NoSuchKey({ message: 'gone', $metadata: {} });

interface Site {
  site: string;
  prefix: string;
  /** Queue `error` where this site's S3 call will meet it. */
  arm: (c: ReturnType<typeof makeClient>, error: unknown) => void;
  run: (b: S3StateBackend) => Promise<unknown>;
}

const SITES: Site[] = [
  {
    site: 'verifyBucketExists',
    prefix: "Failed to verify state bucket 'b': ",
    arm: (c, e) => c.queue('HeadBucketCommand', fail(e)),
    run: (b) => b.verifyBucketExists(),
  },
  {
    site: 'getState (region-scoped key)',
    prefix: `Failed to get state for stack ${STACK} (${REGION}): `,
    arm: (c, e) => c.queue('GetObjectCommand', fail(e)),
    run: (b) => b.getState(STACK, REGION),
  },
  {
    site: 'getState (legacy key)',
    prefix: `Failed to get legacy state for stack ${STACK}: `,
    arm: (c, e) => c.queue('GetObjectCommand', fail(noSuchKey()), fail(e)),
    run: (b) => b.getState(STACK, REGION),
  },
  {
    site: 'saveState',
    prefix: `Failed to save state for stack ${STACK} (${REGION}): `,
    arm: (c, e) => c.queue('PutObjectCommand', fail(e)),
    run: (b) => b.saveState(STACK, REGION, state),
  },
  {
    site: 'deleteState',
    // The create-token ledger and the write-ahead sibling go first.
    prefix: `Failed to delete state for stack ${STACK} (${REGION}): `,
    arm: (c, e) =>
      c.queue(
        'DeleteObjectCommand',
        () => ({}),
        () => ({}),
        fail(e)
      ),
    run: (b) => b.deleteState(STACK, REGION),
  },
  {
    site: 'deleteLegacyState',
    prefix: `Failed to delete legacy state for stack ${STACK}: `,
    arm: (c, e) => c.queue('DeleteObjectCommand', fail(e)),
    run: (b) => b.deleteLegacyState(STACK),
  },
  {
    site: 'listStacks',
    prefix: 'Failed to list stacks: ',
    arm: (c, e) => c.queue('ListObjectsV2Command', fail(e)),
    run: (b) => b.listStacks(),
  },
  {
    site: 'rotateCreateTokenNonce',
    prefix: `Failed to renew the create-token ledger of stack ${STACK} (${REGION}): `,
    arm: (c, e) => c.queue('GetObjectCommand', fail(e)),
    run: (b) => b.rotateCreateTokenNonce(STACK, REGION, ['X']),
  },
  {
    site: 'deleteCreateTokenLedger',
    prefix: `Failed to delete the create-token ledger for stack ${STACK} (${REGION}): `,
    arm: (c, e) => c.queue('DeleteObjectCommand', fail(e)),
    run: (b) => b.deleteCreateTokenLedger(STACK, REGION),
  },
  {
    site: 'readStackInstanceSibling',
    prefix: `Failed to read the write-ahead stack instance id of stack ${STACK} (${REGION}) `,
    arm: (c, e) => c.queue('GetObjectCommand', fail(e)),
    run: (b) => b.readStackInstanceSibling(STACK, REGION),
  },
  {
    site: 'stackInstanceIdForFirstWrite',
    prefix: `Failed to read or write the write-ahead stack instance id of stack ${STACK} (${REGION}) `,
    arm: (c, e) => c.queue('GetObjectCommand', fail(e)),
    run: (b) => b.stackInstanceIdForFirstWrite(STACK, REGION, { writeAhead: true }),
  },
  {
    site: 'deleteStackInstanceSibling',
    prefix: `Failed to delete the write-ahead stack instance id for stack ${STACK} (${REGION}): `,
    arm: (c, e) => c.queue('DeleteObjectCommand', fail(e)),
    run: (b) => b.deleteStackInstanceSibling(STACK, REGION),
  },
];

async function rejection(site: Site, error: unknown): Promise<Error> {
  const c = makeClient();
  site.arm(c, error);
  const b = new S3StateBackend(c.client, config);
  const thrown = await site.run(b).then(
    () => undefined,
    (e: unknown) => e
  );
  expect(thrown, `${site.site} did not reject`).toBeInstanceOf(Error);
  return thrown as Error;
}

const debugLines = (): string[] => logs.debug.mock.calls.map((c) => String(c[0]));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('S3StateBackend thrown messages name an AWS failure by its class (go-to-k/cdkd#2319)', () => {
  it('the fake failure carries the account id and AWS text (positive control)', () => {
    expect(s3err().message).toContain(ACCOUNT);
    expect(s3err().message).toContain('not authorized');
  });

  it.each(SITES)('$site: the class, no AWS text, cause kept and stamped', async (site) => {
    const original = s3err();
    const thrown = await rejection(site, original);
    expect(thrown.message.startsWith(site.prefix), thrown.message).toBe(true);
    expect(thrown.message).toContain(`AccessDenied. ${VERBOSE_POINTER}`);
    // No double period where a remedy sentence follows the clause.
    expect(thrown.message).not.toContain('..');
    expect(thrown.message).not.toContain(ACCOUNT);
    expect(thrown.message).not.toContain('not authorized');
    expect(thrown.cause).toBe(original);
    expect(hasRedactedCause(thrown)).toBe(true);
    expect(retryClassificationText(thrown)).toContain('not authorized');
  });

  it.each(SITES)("$site: AWS's text is on the debug line, after the same prefix", async (site) => {
    await rejection(site, s3err());
    const lines = debugLines().filter((l) => l.startsWith(site.prefix));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(AWS_TEXT);
  });

  it.each(SITES)('$site: a bound secret is masked in the class and on the debug line', async (site) => {
    const SECRET = 'class-secret-q7';
    const bag = new Map<string, string>();
    recordLogOnlyValue(bag, SECRET);
    let debugMasked = '<not run>';
    const thrown = await withPrintingSecrets(bag, async () => {
      const t = await rejection(site, s3err(`Denied${SECRET}`, `${AWS_TEXT} ${SECRET}`));
      const line = debugLines().find((l) => l.startsWith(site.prefix)) ?? '<no debug line>';
      const mask = currentLogLineMasker();
      debugMasked = mask === undefined ? '<no masker bound>' : mask(line);
      return t;
    });
    expect(thrown.message).not.toContain(SECRET);
    expect(thrown.message).toContain(`Denied${SECRET_MASK}. ${VERBOSE_POINTER}`);
    expect(debugMasked).not.toContain(SECRET);
    expect(debugMasked).toContain(SECRET_MASK);
  });

  it.each(SITES)('$site: a class forging a line is flattened', async (site) => {
    const thrown = await rejection(site, s3err('Bad\n[ok] FORGED\u001b[2J'));
    expect(thrown.message).toContain('Bad [ok] FORGED [2J.');
    // eslint-disable-next-line no-control-regex
    expect(thrown.message).not.toMatch(/[\u0000-\u001f]/);
  });

  it.each(SITES)("$site: normalizeAwsError's cdkd-written rewrite keeps its text, unstamped", async (site) => {
    // S3's body-less 403: the SDK's synthetic `Unknown`.
    const unknown = Object.assign(new Error('UnknownError'), {
      name: 'Unknown',
      $metadata: { httpStatusCode: 403 },
    });
    const thrown = await rejection(site, unknown);
    if (site.site.startsWith('getState')) {
      // These two wrap the raw error, never normalizing it: an `Unknown` is
      // AWS-authored by its status code there, and reduced to its class.
      expect(thrown.message).toContain(`Unknown. ${VERBOSE_POINTER}`);
      return;
    }
    expect(thrown.message).toContain("Access denied to bucket 'b'. Verify credentials and bucket policy.");
    expect(thrown.message).not.toContain(VERBOSE_POINTER);
    expect(thrown.message).not.toContain('..');
    expect(hasRedactedCause(thrown)).toBe(false);
  });
});

describe('deleteRawObjects names each key failure by its code (go-to-k/cdkd#2319)', () => {
  const KEY = 'stacks/MyStack/us-east-1/deployments/a.jsonl';
  const run = async (code: string, message: string): Promise<string> => {
    const c = makeClient();
    c.queue('DeleteObjectsCommand', () => ({ Errors: [{ Key: KEY, Code: code, Message: message }] }));
    const thrown = await new S3StateBackend(c.client, config).deleteRawObjects([KEY]).then(
      () => undefined,
      (e: unknown) => e
    );
    expect(thrown).toBeInstanceOf(Error);
    return (thrown as Error).message;
  };

  it("the code, no AWS text, and AWS's text at debug", async () => {
    const message = await run('AccessDenied', AWS_TEXT);
    expect(message).toBe(
      `Failed to delete 1 object(s) from bucket 'b': ${KEY} (AccessDenied). ${VERBOSE_POINTER}`
    );
    expect(message).not.toContain(ACCOUNT);
    const lines = debugLines().filter((l) => l.startsWith('DeleteObjects failed for'));
    expect(lines).toEqual([`DeleteObjects failed for ${KEY} (AccessDenied): ${AWS_TEXT}`]);
  });

  it('a bound secret spelled in the code is masked', async () => {
    const SECRET = 'code-secret-r4';
    const bag = new Map<string, string>();
    recordLogOnlyValue(bag, SECRET);
    const message = await withPrintingSecrets(bag, () => run(`Denied${SECRET}`, AWS_TEXT));
    expect(message).not.toContain(SECRET);
    expect(message).toContain(`(Denied${SECRET_MASK})`);
  });
});
