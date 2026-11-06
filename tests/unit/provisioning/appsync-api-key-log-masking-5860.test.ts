import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

/**
 * An `AWS::AppSync::ApiKey` id IS the credential a client sends as
 * `x-api-key` (go-to-k/cdkd#5860). Every path that can name it — create,
 * update, delete, read, import, getAttribute, the orphan report — is driven
 * with a known key, and every logger line and thrown message is checked: the
 * full key never appears, the `****last4` form does where the line names it.
 */

const { mockSend, logged, accountInfo } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  /** Every logger call, any level, as one string. */
  logged: [] as Array<{ level: string; text: string }>,
  /** `getAccountInfo`, swappable to a refusal to reach the ARN-failure warns. */
  accountInfo: {
    impl: async (_region: string): Promise<unknown> => ({
      partition: 'aws',
      region: 'us-east-1',
      accountId: '123456789012',
    }),
  },
}));

vi.mock('@aws-sdk/client-appsync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-appsync')>();
  return {
    ...actual,
    AppSyncClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: {
        region: () => Promise.resolve('us-east-1'),
        retryStrategy: async () => ({
          acquireInitialRetryToken: async () => 'token',
          refreshRetryTokenForRetry: async () => 'retry-token',
          recordSuccess: () => undefined,
        }),
      },
    })),
  };
});

vi.mock('../../../src/deployment/intrinsic-function-resolver.js', () => ({
  getAccountInfo: (region: string) => accountInfo.impl(region),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const record =
    (level: string) =>
    (...args: unknown[]): void => {
      logged.push({ level, text: args.map(String).join(' ') });
    };
  const logger = {
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
  };
  return {
    getLogger: () => ({ ...logger, child: () => ({ ...logger, child: () => logger }) }),
  };
});

import {
  AppSyncProvider,
  resetGraphqlApiCreateRetryStateForTests,
} from '../../../src/provisioning/providers/appsync-provider.js';

const KEY = 'da2-abcdefghijklmnopqrstuvwxyz';
const MASKED = '****wxyz';
const API = 'api1';
const PID = `${API}|${KEY}`;
const SHOWN_PID = `${API}|${MASKED}`;
const TYPE = 'AWS::AppSync::ApiKey';

/** An AWS-authored failure whose own text quotes the key back. */
const awsErrorQuotingKey = (name: string): Error =>
  Object.assign(new Error(`API key ${KEY} cannot be used here`), {
    name,
    $fault: 'client',
    $metadata: { httpStatusCode: 400 },
  });

const refuseAccount = (): void => {
  accountInfo.impl = async () => {
    throw new Error('Unable to resolve the AWS account id');
  };
};

/** Run `fn`, returning its thrown message (or `undefined` when it resolved). */
async function thrownBy(fn: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await fn();
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** The full key reaches neither a logger line nor `thrown`. */
function expectKeyNowhere(thrown?: string): void {
  for (const { level, text } of logged) {
    expect(text, `${level} line leaked the key`).not.toContain(KEY);
  }
  if (thrown !== undefined) expect(thrown).not.toContain(KEY);
}

function lineWith(level: string, needle: string): string {
  const line = logged.find((l) => l.level === level && l.text.includes(needle));
  expect(line, `no ${level} line containing ${JSON.stringify(needle)}`).toBeDefined();
  return line!.text;
}

describe('AppSync ApiKey id is masked in every log line and message (go-to-k/cdkd#5860)', () => {
  let provider: AppSyncProvider;

  beforeEach(() => {
    mockSend.mockReset();
    logged.length = 0;
    accountInfo.impl = async () => ({
      partition: 'aws',
      region: 'us-east-1',
      accountId: '123456789012',
    });
    resetGraphqlApiCreateRetryStateForTests();
    provider = new AppSyncProvider();
  });

  describe('create', () => {
    it('the success debug line names the key masked', async () => {
      mockSend.mockResolvedValueOnce({ apiKey: { id: KEY } });

      const result = await provider.create('Key', TYPE, { ApiId: API });

      expect(result.physicalId).toBe(PID);
      expect(lineWith('debug', 'Successfully created ApiKey Key')).toContain(MASKED);
      expectKeyNowhere();
    });

    it('the orphan report after an SDK replay names every candidate masked', async () => {
      const ORPHAN = 'da2-orphanorphanorphanorph9';
      mockSend.mockImplementation(async (command: { constructor: { name: string } }) => {
        if (command.constructor.name === 'CreateApiKeyCommand') {
          return { apiKey: { id: KEY }, $metadata: { attempts: 2 } };
        }
        if (command.constructor.name === 'ListApiKeysCommand') {
          return { apiKeys: [{ id: KEY }, { id: ORPHAN }] };
        }
        throw new Error(`unexpected ${command.constructor.name}`);
      });

      await provider.create('Key', TYPE, { ApiId: API });

      const report = lineWith('warn', 'CreateApiKey');
      expect(report).toContain('****rph9');
      expect(report).not.toContain(ORPHAN);
      expect(lineWith('debug', 'Successfully created ApiKey Key')).toContain(MASKED);
      expectKeyNowhere();
    });

    it("the ARN-build warn names the key's physical id masked", async () => {
      refuseAccount();
      mockSend.mockResolvedValueOnce({ apiKey: { id: KEY } });

      await provider.create('Key', TYPE, { ApiId: API });

      expect(lineWith('warn', 'could not build its ARN attribute')).toContain(
        `Created Key (${SHOWN_PID})`
      );
      expectKeyNowhere();
    });

    it('a composite-id refusal quoting the key segment masks it', async () => {
      // AWS never mints a `|` in a key id; the refusal is a fence against a
      // future id-shape change, and it quotes the offending segment.
      const PIPED = 'da2-abcdefghij|klmnopqrstuvwxyz';
      mockSend.mockResolvedValueOnce({ apiKey: { id: PIPED } });

      const thrown = await thrownBy(() => provider.create('Key', TYPE, { ApiId: API }));

      expect(thrown).toBeDefined();
      expect(thrown).toContain(MASKED);
      expect(thrown).not.toContain(PIPED);
      for (const { text } of logged) expect(text).not.toContain(PIPED);
    });

    it('a composite-id refusal downgraded to a warn on a state replay masks the key segment', async () => {
      const PIPED = 'da2-abcdefghij|klmnopqrstuvwxyz';
      mockSend.mockResolvedValueOnce({ apiKey: { id: PIPED } });

      const result = await provider.create('Key', TYPE, { ApiId: API }, { replayingState: true });

      expect(result.physicalId).toBe(`${API}|${PIPED}`);
      expect(lineWith('warn', 'Continuing with the ambiguous id')).toContain(MASKED);
      for (const { text } of logged) expect(text).not.toContain(PIPED);
    });
  });

  describe('update', () => {
    it("AWS's own failure text quoting the key is masked in the debug line and the throw", async () => {
      mockSend.mockRejectedValueOnce(awsErrorQuotingKey('BadRequestException'));

      const thrown = await thrownBy(() =>
        provider.update(
          'Key',
          PID,
          TYPE,
          { ApiId: API, Description: 'new' },
          { ApiId: API, Description: 'old' }
        )
      );

      expect(thrown).toBeDefined();
      expect(lineWith('debug', 'cannot be used here')).toContain(MASKED);
      expectKeyNowhere(thrown);
    });

    it('the attribute-rebuild warn names the physical id masked', async () => {
      refuseAccount();
      mockSend.mockResolvedValueOnce({});

      await provider.update(
        'Key',
        PID,
        TYPE,
        { ApiId: API, Description: 'new' },
        { ApiId: API, Description: 'old' }
      );

      expect(lineWith('warn', 'could not rebuild its ARN attribute')).toContain(
        `Updated ${TYPE} (${SHOWN_PID})`
      );
      expectKeyNowhere();
    });

    it('a malformed physical id is masked whole in the refusal', async () => {
      const thrown = await thrownBy(() =>
        provider.update('Key', KEY, TYPE, { ApiId: API }, { ApiId: API })
      );

      expect(thrown).toContain(`got "${MASKED}"`);
      expectKeyNowhere(thrown);
    });
  });

  describe('delete', () => {
    it('the deleting debug line names the physical id masked', async () => {
      mockSend.mockResolvedValueOnce({});

      await provider.delete('Key', PID, TYPE);

      expect(lineWith('debug', 'Deleting ApiKey Key')).toContain(SHOWN_PID);
      expectKeyNowhere();
    });

    it('the already-gone debug line names the physical id masked', async () => {
      mockSend.mockRejectedValueOnce(
        Object.assign(new Error('API key not found'), { name: 'NotFoundException' })
      );

      await provider.delete('Key', PID, TYPE);

      expect(lineWith('debug', 'does not exist, skipping deletion')).toContain(
        `ApiKey ${SHOWN_PID}`
      );
      expectKeyNowhere();
    });

    it('a malformed physical id is masked whole in the skip warn', async () => {
      await provider.delete('Key', KEY, TYPE);

      expect(lineWith('warn', 'Invalid physicalId format')).toContain(`got "${MASKED}"`);
      expectKeyNowhere();
    });

    it('a cdkd- or Node-authored failure quoting the key is masked in the throw', async () => {
      mockSend.mockRejectedValueOnce(new TypeError(`socket closed while deleting ${KEY}`));

      const thrown = await thrownBy(() => provider.delete('Key', PID, TYPE));

      expect(thrown).toContain(`socket closed while deleting ${MASKED}`);
      expectKeyNowhere(thrown);
    });

    it("AWS's own failure text quoting the key is masked in the debug line and the throw", async () => {
      mockSend.mockRejectedValueOnce(awsErrorQuotingKey('AccessDeniedException'));

      const thrown = await thrownBy(() => provider.delete('Key', PID, TYPE));

      expect(thrown).toBeDefined();
      expect(lineWith('debug', 'cannot be used here')).toContain(MASKED);
      expectKeyNowhere(thrown);
    });
  });

  describe('read, import, getAttribute', () => {
    it('readCurrentState logs nothing carrying the key', async () => {
      mockSend.mockResolvedValueOnce({ apiKeys: [{ id: KEY, description: 'd' }] });

      const state = await provider.readCurrentState(PID, 'Key', TYPE, {});

      expect(state).toEqual({ ApiId: API, Description: 'd' });
      expectKeyNowhere();
    });

    it('getAttribute names the physical id masked', async () => {
      await provider.getAttribute(PID, TYPE, 'ApiKey');

      expect(lineWith('debug', 'getAttribute for')).toContain(SHOWN_PID);
      expectKeyNowhere();
    });

    it('an import whose ARN cannot be built names the physical id masked', async () => {
      refuseAccount();

      const result = await provider.import({
        logicalId: 'Key',
        resourceType: TYPE,
        stackName: 'S',
        region: 'us-east-1',
        properties: {},
        knownPhysicalId: PID,
      });

      expect(result).toEqual({ physicalId: PID, attributes: { ApiKey: KEY } });
      expect(lineWith('warn', 'ARN attribute was NOT recorded')).toContain(
        `Imported ${TYPE} (${SHOWN_PID})`
      );
      expectKeyNowhere();
    });

    it('an import whose attribute rebuild throws names the physical id masked', async () => {
      vi.spyOn(provider, 'childRefAttributes').mockRejectedValueOnce(new Error('boom'));

      await provider.childImportAttributes(TYPE, PID, 'us-east-1');

      expect(lineWith('warn', 'could not build its ARN attribute')).toContain(
        `Imported ${TYPE} (${SHOWN_PID})`
      );
      expectKeyNowhere();
    });

    it("an import from another region's CloudFormation ARN masks the key in the refusal", async () => {
      const thrown = await thrownBy(() =>
        provider.import({
          logicalId: 'Key',
          resourceType: TYPE,
          stackName: 'S',
          region: 'us-east-1',
          properties: {},
          knownPhysicalId: `arn:aws:appsync:eu-west-1:123456789012:apis/${API}/apikeys/${KEY}`,
        })
      );

      expect(thrown).toContain(`apis/${API}/apikeys/${MASKED}`);
      expectKeyNowhere(thrown);
    });
  });
});

describe('buildAppSyncArnOrWarn names the created resource (clients.ts)', () => {
  let provider: AppSyncProvider;

  beforeEach(() => {
    mockSend.mockReset();
    logged.length = 0;
    refuseAccount();
    resetGraphqlApiCreateRetryStateForTests();
    provider = new AppSyncProvider();
  });

  it('a DataSource whose ARN cannot be built: logicalId first, physical id in parentheses', async () => {
    mockSend.mockResolvedValueOnce({ dataSource: {} });

    const result = await provider.create('MyDs', 'AWS::AppSync::DataSource', {
      ApiId: API,
      Name: 'myds',
      Type: 'NONE',
    });

    expect(result.physicalId).toBe(`${API}|myds`);
    expect(lineWith('warn', 'could not build its ARN attribute')).toContain(
      `Created MyDs (${API}|myds) but could not build its ARN attribute: `
    );
  });
});
