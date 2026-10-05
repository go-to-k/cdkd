import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// go-to-k/cdkd#3869: the create() / delete() lines and every error leaving
// create() / update() / delete() withhold a secret-derived identifier the way
// update()'s lines already did. The provider builds its logger via
// getLogger().child(...), so the child's methods must be the shared spies.
const mockCcSend = vi.fn();
const mockDebug = vi.fn();
const mockInfo = vi.fn();
const mockWarn = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    cloudControl: { send: mockCcSend, config: { region: () => Promise.resolve('us-east-1') } },
    cloudFormation: { send: vi.fn() },
  }),
}));

vi.mock('../../../src/deployment/intrinsic-function-resolver.js', () => ({
  getAccountInfo: () =>
    Promise.resolve({ partition: 'aws', region: 'us-east-1', accountId: '123456789012' }),
}));

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => {
    const child = {
      debug: mockDebug,
      info: mockInfo,
      warn: mockWarn,
      error: vi.fn(),
      child: vi.fn(() => child),
    };
    return { child: () => child, debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  },
}));

import {
  CloudControlProvider,
  CloudControlWaitAbandonedError,
} from '../../../src/provisioning/cloud-control-provider.js';
import { isWaitAbandonedError } from '../../../src/provisioning/wait-abandoned.js';
import { RESUME_COMMAND } from '../../../src/provisioning/cloud-control-provider.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';
import { createSecretMasker, SECRET_MASK } from '../../../src/deployment/secret-redaction.js';
import {
  isNameCollisionErrorFrom,
  isUpdateUnsupportedError,
} from '../../../src/deployment/retryable-errors.js';

const TYPE = 'AWS::Logs::MetricFilter';
const REFERENCE = '{{resolve:secretsmanager:filter-name:SecretString:::}}';
// The current secret, in the desired bag and known to the masker.
const SECRET = 'Secret-Filter-Name';
// What Cloud Control names the resource: DERIVED from the secret (lowercased),
// so the literal masker cannot recognise it.
const DERIVED = 'secret-filter-name';
const ID = `my-log-group|${DERIVED}`;

function allLines(): string {
  return [...mockDebug.mock.calls, ...mockInfo.mock.calls, ...mockWarn.mock.calls]
    .map((c) => c.map(String).join(' '))
    .join('\n');
}

function commandName(command: unknown): string {
  return (command as { constructor: { name: string } }).constructor.name;
}

/** CreateResource answered, then a status poll answering `event`. */
function primeCreate(event: Record<string, unknown>): void {
  mockCcSend.mockImplementation((command: unknown) => {
    switch (commandName(command)) {
      case 'CreateResourceCommand':
        return Promise.resolve({ ProgressEvent: { RequestToken: 'tok-create' } });
      case 'GetResourceRequestStatusCommand':
        return Promise.resolve({ ProgressEvent: { TypeName: TYPE, ...event } });
      case 'DeleteResourceCommand':
        return Promise.resolve({ ProgressEvent: { RequestToken: 'tok-delete' } });
      case 'GetResourceCommand':
        return Promise.resolve({
          ResourceDescription: {
            Identifier: ID,
            Properties: JSON.stringify({ LogGroupName: 'my-log-group', FilterName: DERIVED }),
          },
        });
      default:
        return Promise.reject(new Error(`unexpected ${commandName(command)}`));
    }
  });
}

async function caught(promise: Promise<unknown>): Promise<Error> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e
  );
  expect(error).toBeInstanceOf(Error);
  return error as Error;
}

describe('CloudControlProvider create()/delete()/errors withhold a secret-derived id (go-to-k/cdkd#3869)', () => {
  beforeEach(() => {
    mockCcSend.mockReset();
    mockDebug.mockReset();
    mockInfo.mockReset();
    mockWarn.mockReset();
  });

  describe('create()', () => {
    const desired = { LogGroupName: 'my-log-group', FilterName: SECRET, FilterPattern: 'ERROR' };
    const context = () => ({ maskSecrets: createSecretMasker(new Map([[SECRET, REFERENCE]])) });

    it('withholds the id Cloud Control named, in every line, and still returns it raw', async () => {
      primeCreate({
        OperationStatus: 'SUCCESS',
        Identifier: ID,
        ResourceModel: JSON.stringify({ LogGroupName: 'my-log-group', FilterName: DERIVED }),
      });
      const provider = new CloudControlProvider();
      const result = await provider.create('MyFilter', TYPE, desired, context());

      expect(result.physicalId).toBe(ID);
      const created = mockDebug.mock.calls
        .map((c) => String(c[0]))
        .find((m) => m.startsWith('Created resource MyFilter'));
      expect(created).toBe(`Created resource MyFilter, physical ID: ${SECRET_MASK}`);
      expect(allLines()).not.toContain(DERIVED);
    });

    it('scrubs a FAILED create: its status text, error fields, and the remnant cleanup lines', async () => {
      primeCreate({
        OperationStatus: 'FAILED',
        Identifier: ID,
        ErrorCode: 'GeneralServiceException',
        StatusMessage: `Filter ${DERIVED} could not be stabilized`,
      });
      const provider = new CloudControlProvider();
      const error = await caught(provider.create('MyFilter', TYPE, desired, context()));

      expect(error.message).toContain('CREATE failed for MyFilter');
      expect(error.message).toContain(`Filter ${SECRET_MASK} could not be stabilized`);
      expect(error.message).not.toContain(DERIVED);
      expect(error).toBeInstanceOf(ProvisioningError);
      expect(String((error as ProvisioningError).physicalId)).not.toContain(DERIVED);
      // The remnant cleanup ran (its info line and the nested delete's debug
      // line both name the id) and printed none of it.
      const cleanup = mockInfo.mock.calls
        .map((c) => String(c[0]))
        .find((m) => m.startsWith('CREATE of MyFilter failed after materializing'));
      expect(cleanup).toBeDefined();
      expect(mockDebug.mock.calls.map((c) => String(c[0]))).toContain(
        `Deleting resource MyFilter (${TYPE}), physical ID: ${SECRET_MASK}`
      );
      expect(allLines()).not.toContain(DERIVED);
    });

    it('scrubs an abandoned wait by the identifier its last progress event named, keeping the marker and token', async () => {
      let polls = 0;
      mockCcSend.mockImplementation((command: unknown) => {
        switch (commandName(command)) {
          case 'CreateResourceCommand':
            return Promise.resolve({ ProgressEvent: { RequestToken: 'tok-create' } });
          case 'GetResourceRequestStatusCommand':
            polls++;
            return polls === 1
              ? Promise.resolve({ ProgressEvent: { OperationStatus: 'IN_PROGRESS', Identifier: ID } })
              : Promise.reject(
                  Object.assign(new Error('not authorized'), { name: 'AccessDeniedException' })
                );
          default:
            return Promise.reject(new Error(`unexpected ${commandName(command)}`));
        }
      });
      const provider = new CloudControlProvider();
      vi.spyOn(provider as unknown as { sleep: () => Promise<void> }, 'sleep').mockResolvedValue();
      const error = await caught(provider.create('MyFilter', TYPE, desired, context()));

      expect(isWaitAbandonedError(error)).toBe(true);
      expect(error).toBeInstanceOf(CloudControlWaitAbandonedError);
      expect((error as CloudControlWaitAbandonedError).requestToken).toBe('tok-create');
      expect(error.message).toContain('tok-create');
      expect(error.message).not.toContain(DERIVED);
      expect(String((error as CloudControlWaitAbandonedError).lastSeenIdentifier)).not.toContain(
        DERIVED
      );
    });

    it('scrubs the WARN of a remnant delete that itself failed', async () => {
      mockCcSend.mockImplementation((command: unknown) => {
        switch (commandName(command)) {
          case 'CreateResourceCommand':
            return Promise.resolve({ ProgressEvent: { RequestToken: 'tok-create' } });
          case 'GetResourceRequestStatusCommand':
            return Promise.resolve({
              ProgressEvent: {
                TypeName: TYPE,
                OperationStatus: 'FAILED',
                Identifier: ID,
                ErrorCode: 'GeneralServiceException',
                StatusMessage: 'could not be stabilized',
              },
            });
          default:
            return Promise.reject(new Error(`DeleteResource refused for ${ID}`));
        }
      });
      const provider = new CloudControlProvider();
      await caught(provider.create('MyFilter', TYPE, desired, context()));

      const warn = mockWarn.mock.calls
        .map((c) => String(c[0]))
        .find((m) => m.startsWith('Failed to delete the remnant'));
      expect(warn).toBeDefined();
      expect(warn).toContain(`DeleteResource refused for ${SECRET_MASK}`);
      expect(allLines()).not.toContain(DERIVED);
    });

    it('keeps an abandoned wait\'s request token and resume command whole when a short id part occurs in them', async () => {
      // `1` occurs in the token and the region; scrubbed as text, the pasteable
      // command would name another request.
      const shortId = `${DERIVED}|1`;
      const token = 'tok-1a2b-11';
      let polls = 0;
      mockCcSend.mockImplementation((command: unknown) => {
        switch (commandName(command)) {
          case 'CreateResourceCommand':
            return Promise.resolve({ ProgressEvent: { RequestToken: token } });
          case 'GetResourceRequestStatusCommand':
            return ++polls === 1
              ? Promise.resolve({
                  ProgressEvent: { OperationStatus: 'IN_PROGRESS', Identifier: shortId },
                })
              : Promise.reject(
                  Object.assign(new Error('not authorized'), { name: 'AccessDeniedException' })
                );
          default:
            return Promise.reject(new Error(`unexpected ${commandName(command)}`));
        }
      });
      const provider = new CloudControlProvider();
      vi.spyOn(provider as unknown as { sleep: () => Promise<void> }, 'sleep').mockResolvedValue();
      const error = await caught(provider.create('MyFilter', TYPE, desired, context()));

      expect(isWaitAbandonedError(error)).toBe(true);
      expect((error as CloudControlWaitAbandonedError).requestToken).toBe(token);
      const command = error.message.split('\n').find((line) => line.includes('get-resource-request-status'));
      expect(command).toContain(`--request-token ${token}`);
      expect(command).toContain('--region us-east-1');
      // Everywhere else the short part is scrubbed, like the rest of the id.
      expect(error.message.replace(command as string, '')).not.toContain(DERIVED);
    });

    it('withholds the display spelling of an id part carrying a non-ASCII run', async () => {
      const unicodeName = 'secret-\u30ed\u30b0-filter';
      const unicodeId = `my-log-group|${unicodeName}`;
      let polls = 0;
      mockCcSend.mockImplementation((command: unknown) => {
        switch (commandName(command)) {
          case 'CreateResourceCommand':
            return Promise.resolve({ ProgressEvent: { RequestToken: 'tok-create' } });
          case 'GetResourceRequestStatusCommand':
            return ++polls === 1
              ? Promise.resolve({ ProgressEvent: { OperationStatus: 'IN_PROGRESS', Identifier: unicodeId } })
              : Promise.reject(
                  Object.assign(new Error('not authorized'), { name: 'AccessDeniedException' })
                );
          default:
            return Promise.reject(new Error(`unexpected ${commandName(command)}`));
        }
      });
      const provider = new CloudControlProvider();
      vi.spyOn(provider as unknown as { sleep: () => Promise<void> }, 'sleep').mockResolvedValue();
      const error = await caught(provider.create('MyFilter', TYPE, desired, context()));

      expect(error.message).toContain(`named the resource ${SECRET_MASK}`);
      expect(error.message).not.toContain('secret-');
      expect(error.message).not.toContain('-filter');
    });

    it('prints the id and leaves the error untouched when the desired bag holds no secret', async () => {
      primeCreate({
        OperationStatus: 'FAILED',
        Identifier: ID,
        ErrorCode: 'AlreadyExists',
        StatusMessage: `Filter ${DERIVED} already exists`,
      });
      const provider = new CloudControlProvider();
      const error = await caught(
        provider.create(
          'MyFilter',
          TYPE,
          { LogGroupName: 'my-log-group', FilterName: DERIVED },
          context()
        )
      );

      expect(error.message).toContain(`Filter ${DERIVED} already exists`);
      expect((error as ProvisioningError).physicalId).toBe(ID);
    });

    it('scopes the withholding to its own call: a concurrent plain create still prints its id', async () => {
      // Shares the secret id's log-group part: run under the secret call's sink,
      // the line would lose it.
      const plainId = 'my-log-group|plain-filter';
      mockCcSend.mockImplementation((command: unknown) => {
        const input = (command as { input: Record<string, unknown> }).input;
        switch (commandName(command)) {
          case 'CreateResourceCommand':
            return Promise.resolve({
              ProgressEvent: {
                RequestToken: String(input['DesiredState']).includes(SECRET) ? 'tok-s' : 'tok-p',
              },
            });
          case 'GetResourceRequestStatusCommand': {
            const secret = input['RequestToken'] === 'tok-s';
            return Promise.resolve({
              ProgressEvent: {
                TypeName: TYPE,
                OperationStatus: 'SUCCESS',
                Identifier: secret ? ID : plainId,
                ResourceModel: JSON.stringify({ FilterName: secret ? DERIVED : 'plain-filter' }),
              },
            });
          }
          default:
            return Promise.resolve({
              ResourceDescription: { Properties: JSON.stringify({ FilterName: 'x' }) },
            });
        }
      });
      const provider = new CloudControlProvider();
      await Promise.all([
        provider.create('SecretFilter', TYPE, desired, context()),
        provider.create('PlainFilter', TYPE, { FilterName: 'plain-filter' }, context()),
      ]);

      const debug = mockDebug.mock.calls.map((c) => String(c[0]));
      expect(debug).toContain(`Created resource SecretFilter, physical ID: ${SECRET_MASK}`);
      expect(debug).toContain(`Created resource PlainFilter, physical ID: ${plainId}`);
      expect(allLines()).not.toContain(DERIVED);
    });
  });

  describe('delete()', () => {
    const recorded = { LogGroupName: 'my-log-group', FilterName: REFERENCE };

    it('withholds the id in its lines and in a FAILED delete error when the record keeps a {{resolve: reference', async () => {
      mockCcSend.mockImplementation((command: unknown) =>
        commandName(command) === 'DeleteResourceCommand'
          ? Promise.resolve({ ProgressEvent: { RequestToken: 'tok-delete' } })
          : Promise.resolve({
              ProgressEvent: {
                TypeName: TYPE,
                OperationStatus: 'FAILED',
                Identifier: ID,
                ErrorCode: 'GeneralServiceException',
                StatusMessage: `Filter ${DERIVED} is busy`,
              },
            })
      );
      const provider = new CloudControlProvider();
      const error = await caught(provider.delete('MyFilter', ID, TYPE, recorded));

      expect(error.message).toContain(`Filter ${SECRET_MASK} is busy`);
      expect(error.message).not.toContain(DERIVED);
      expect((error as ProvisioningError).physicalId).toBeDefined();
      expect(String((error as ProvisioningError).physicalId)).not.toContain(DERIVED);
      expect(mockDebug.mock.calls.map((c) => String(c[0]))).toContain(
        `Deleting resource MyFilter (${TYPE}), physical ID: ${SECRET_MASK}`
      );
      expect(allLines()).not.toContain(DERIVED);
    });

    it('scrubs a helper line the delete reaches: the global-cluster WARN', async () => {
      const clusterId = 'secret-derived-cluster';
      mockCcSend.mockImplementation((command: unknown) =>
        commandName(command) === 'DeleteResourceCommand'
          ? Promise.resolve({ ProgressEvent: { RequestToken: 'tok-delete' } })
          : Promise.resolve({ ProgressEvent: { OperationStatus: 'SUCCESS' } })
      );
      const provider = new CloudControlProvider();
      await provider.delete(
        'MyCluster',
        clusterId,
        'AWS::Neptune::DBCluster',
        { GlobalClusterIdentifier: 'global-1', DBClusterIdentifier: REFERENCE },
        { deletionPolicy: 'Delete' }
      );

      const warn = mockWarn.mock.calls
        .map((c) => String(c[0]))
        .find((m) => m.includes('records a GlobalClusterIdentifier'));
      expect(warn).toBeDefined();
      expect(warn).toContain(`manual final snapshot of ${SECRET_MASK}`);
      expect(allLines()).not.toContain(clusterId);
    });

    it('prints the id when the record holds no secret-derived leaf', async () => {
      mockCcSend.mockRejectedValue(new Error(`DeleteResource refused for ${DERIVED}`));
      const provider = new CloudControlProvider();
      const error = await caught(
        provider.delete('MyFilter', ID, TYPE, { LogGroupName: 'my-log-group', FilterName: DERIVED })
      );

      expect(error.message).toContain(DERIVED);
      expect(mockDebug.mock.calls.map((c) => String(c[0]))).toContain(
        `Deleting resource MyFilter (${TYPE}), physical ID: ${ID}`
      );
    });
  });

  describe('update()', () => {
    it('scrubs the error an UpdateResource refusal throws, which quotes the pre-rotation name', async () => {
      const rotatedName = 'old-rotated-filter-name';
      mockCcSend.mockRejectedValue(
        Object.assign(new Error(`Filter ${rotatedName} cannot be updated`), {
          name: 'InvalidRequestException',
        })
      );
      const provider = new CloudControlProvider();
      const error = await caught(
        provider.update(
          'MyFilter',
          `my-log-group|${rotatedName}`,
          TYPE,
          { LogGroupName: 'my-log-group', FilterName: 'new-rotated-filter-name', Pattern: 'A' },
          { LogGroupName: 'my-log-group', FilterName: REFERENCE, Pattern: 'B' },
          {}
        )
      );

      expect(error.message).toBe(`UPDATE failed for MyFilter: Filter ${SECRET_MASK} cannot be updated`);
      expect(String((error as ProvisioningError).physicalId)).not.toContain(rotatedName);
      // The cause chain is scrubbed too, and its classifier field kept.
      const cause = (error as Error & { cause?: Error }).cause;
      expect(cause?.message).toBe(`Filter ${SECRET_MASK} cannot be updated`);
      expect(cause?.name).toBe('InvalidRequestException');
    });
  });

  // A short `|` part (`1`) occurs inside the logical id, the token and the
  // region: the scrub must leave each of them whole.
  describe('fields and commands the scrub keeps whole (go-to-k/cdkd#3869)', () => {
    const SHORT_ID = `my-log-group|1`;
    const desired = { LogGroupName: 'my-log-group', FilterName: SECRET, FilterPattern: 'ERROR' };
    const context = () => ({ maskSecrets: createSecretMasker(new Map([[SECRET, REFERENCE]])) });
    const recorded = { LogGroupName: 'my-log-group', FilterName: REFERENCE };

    /** The operation's request answered with `token`, every status poll denied after `first`. */
    function primeAbandon(token: string, first?: Record<string, unknown>): void {
      let polls = 0;
      mockCcSend.mockImplementation((command: unknown) => {
        if (commandName(command) === 'GetResourceRequestStatusCommand') {
          polls++;
          return polls === 1 && first !== undefined
            ? Promise.resolve({ ProgressEvent: first })
            : Promise.reject(
                Object.assign(new Error('not authorized'), { name: 'AccessDeniedException' })
              );
        }
        if (commandName(command) === 'GetResourceCommand') {
          return Promise.reject(new Error('no read'));
        }
        return Promise.resolve({ ProgressEvent: { RequestToken: token } });
      });
    }

    function resumeLine(text: string): string {
      const line = text.split('\n').find((l) => l.includes('get-resource-request-status'));
      expect(line).toBeDefined();
      return line as string;
    }

    it('keeps logicalId and resourceType, so an update-unsupported refusal still classifies', async () => {
      // `Logs` occurs in the resource type, `1` in the logical id.
      const typeAndIdParts = 'Logs|1';
      mockCcSend.mockRejectedValue(
        Object.assign(new Error(`Resource ${typeAndIdParts} does not support update`), {
          name: 'UnsupportedActionException',
        })
      );
      const provider = new CloudControlProvider();
      const error = await caught(
        provider.update(
          'SecretFilter1',
          typeAndIdParts,
          TYPE,
          { ...recorded, FilterName: 'x', FilterPattern: 'A' },
          { ...recorded, FilterPattern: 'B' },
          {}
        )
      );

      expect(error.message).not.toContain(typeAndIdParts);
      expect(error.message).not.toContain('Logs|');
      expect((error as ProvisioningError).logicalId).toBe('SecretFilter1');
      expect((error as ProvisioningError).resourceType).toBe(TYPE);
      expect(isUpdateUnsupportedError(error, 'SecretFilter1')).toBe(true);
    });

    it('keeps the logical id a name-collision anchor compares', async () => {
      primeCreate({
        OperationStatus: 'FAILED',
        Identifier: SHORT_ID,
        ErrorCode: 'AlreadyExists',
        StatusMessage: `Filter ${SHORT_ID} already exists`,
      });
      const provider = new CloudControlProvider();
      const error = await caught(provider.create('Filter1', TYPE, desired, context()));

      expect(error.message).not.toContain(SHORT_ID);
      expect((error as ProvisioningError).logicalId).toBe('Filter1');
      expect(isNameCollisionErrorFrom(error, 'Filter1')).toBe(true);
    });

    it('keeps the resume command whole on an abandoned DELETE', async () => {
      primeAbandon('tok-1-del');
      const provider = new CloudControlProvider();
      vi.spyOn(provider as unknown as { sleep: () => Promise<void> }, 'sleep').mockResolvedValue();
      const error = await caught(provider.delete('Filter1', SHORT_ID, TYPE, recorded));

      expect(isWaitAbandonedError(error)).toBe(true);
      expect(resumeLine(error.message)).toContain('--request-token tok-1-del --region us-east-1');
      expect((error as CloudControlWaitAbandonedError).requestToken).toBe('tok-1-del');
    });

    it('keeps the resume command whole on an abandoned UPDATE', async () => {
      primeAbandon('tok-1-upd');
      const provider = new CloudControlProvider();
      vi.spyOn(provider as unknown as { sleep: () => Promise<void> }, 'sleep').mockResolvedValue();
      const error = await caught(
        provider.update(
          'Filter1',
          SHORT_ID,
          TYPE,
          { ...recorded, FilterName: 'x', FilterPattern: 'A' },
          { ...recorded, FilterPattern: 'B' },
          {}
        )
      );

      expect(isWaitAbandonedError(error)).toBe(true);
      expect(resumeLine(error.message)).toContain('--request-token tok-1-upd --region us-east-1');
    });

    it('keeps the resume command whole in the WARN of a remnant delete that abandoned', async () => {
      let polls = 0;
      mockCcSend.mockImplementation((command: unknown) => {
        switch (commandName(command)) {
          case 'CreateResourceCommand':
            return Promise.resolve({ ProgressEvent: { RequestToken: 'tok-create' } });
          case 'DeleteResourceCommand':
            return Promise.resolve({ ProgressEvent: { RequestToken: 'tok-1-rem' } });
          case 'GetResourceRequestStatusCommand':
            polls++;
            return polls === 1
              ? Promise.resolve({
                  ProgressEvent: {
                    TypeName: TYPE,
                    OperationStatus: 'FAILED',
                    Identifier: SHORT_ID,
                    ErrorCode: 'GeneralServiceException',
                    StatusMessage: 'could not be stabilized',
                  },
                })
              : Promise.reject(
                  Object.assign(new Error('not authorized'), { name: 'AccessDeniedException' })
                );
          default:
            return Promise.reject(new Error(`unexpected ${commandName(command)}`));
        }
      });
      const provider = new CloudControlProvider();
      vi.spyOn(provider as unknown as { sleep: () => Promise<void> }, 'sleep').mockResolvedValue();
      await caught(provider.create('Filter1', TYPE, desired, context()));

      const warn = mockWarn.mock.calls
        .map((c) => String(c[0]))
        .find((m) => m.startsWith('Could not confirm whether the remnant'));
      expect(warn).toBeDefined();
      expect(warn).toContain('--request-token tok-1-rem --region us-east-1');
      expect(warn).toContain(`remnant ${SECRET_MASK} left by`);
    });

    it('keeps nothing when no wait was abandoned: command-shaped status text is scrubbed', async () => {
      mockCcSend.mockImplementation((command: unknown) =>
        commandName(command) === 'DeleteResourceCommand'
          ? Promise.resolve({ ProgressEvent: { RequestToken: 'tok-delete' } })
          : Promise.resolve({
              ProgressEvent: {
                TypeName: TYPE,
                OperationStatus: 'FAILED',
                Identifier: ID,
                ErrorCode: 'GeneralServiceException',
                StatusMessage: `see aws cloudcontrol get-resource-request-status --request-token ${DERIVED}`,
              },
            })
      );
      const provider = new CloudControlProvider();
      const error = await caught(provider.delete('MyFilter', ID, TYPE, recorded));

      expect(error.message).toContain(`--request-token ${SECRET_MASK}`);
      expect(error.message).not.toContain(DERIVED);
    });

    it('scrubs the reason of a skipped delete', async () => {
      const provider = new CloudControlProvider();
      vi.spyOn(
        provider as unknown as { deleteInIdLogScope: () => Promise<unknown> },
        'deleteInIdLogScope'
      ).mockResolvedValue({ outcome: 'skipped', reason: `could not address ${ID}` });
      const result = await provider.delete('MyFilter', ID, TYPE, recorded);

      expect(result).toEqual({ outcome: 'skipped', reason: `could not address ${SECRET_MASK}` });
    });

    it('withholds on a delete whose record keeps the secret leaf as the mask itself', async () => {
      mockCcSend.mockRejectedValue(new Error(`DeleteResource refused for ${ID}`));
      const provider = new CloudControlProvider();
      const error = await caught(
        provider.delete('MyFilter', ID, TYPE, { LogGroupName: 'my-log-group', FilterName: SECRET_MASK })
      );

      expect(error.message).toContain(`DeleteResource refused for ${SECRET_MASK}`);
      expect(mockDebug.mock.calls.map((c) => String(c[0]))).toContain(
        `Deleting resource MyFilter (${TYPE}), physical ID: ${SECRET_MASK}`
      );
    });

    it('passes a FAILED create that names no identifier through unscrubbed (the stated bound)', async () => {
      primeCreate({
        OperationStatus: 'FAILED',
        ErrorCode: 'GeneralServiceException',
        StatusMessage: `Filter ${DERIVED} is invalid`,
      });
      const provider = new CloudControlProvider();
      const error = await caught(provider.create('MyFilter', TYPE, desired, context()));

      expect(error.message).toBe(`CREATE failed for MyFilter: Filter ${DERIVED} is invalid`);
      expect((error as ProvisioningError).physicalId).toBeUndefined();
    });
  });

  describe('RESUME_COMMAND', () => {
    const tail = 'cloudcontrol get-resource-request-status --request-token tok-1 --region us-east-1';

    it.each([
      ['no profile', `aws ${tail}`],
      ['a bare profile', `aws --profile dev ${tail}`],
      ['a command hole', `aws --profile '<profile>' ${tail}`],
      ['a single-quoted profile with a space', `aws --profile 'my profile' ${tail}`],
      ['a quoted profile with an escaped quote', `aws --profile 'it'\\''s' ${tail}`],
    ])('matches the whole command with %s', (_label, command) => {
      expect(RESUME_COMMAND.exec(`Check what it did with: ${command} trailing`)?.[0]).toBe(command);
    });
  });
});
