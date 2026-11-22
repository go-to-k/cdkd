import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { GetResourceCommand, UpdateResourceCommand } from '@aws-sdk/client-cloudcontrol';

const mockCcSend = vi.fn();
const mockCfnSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    cloudControl: { send: mockCcSend, config: { region: () => Promise.resolve('us-east-1') } },
    // DescribeType for write-only property resolution on the update path.
    cloudFormation: { send: mockCfnSend },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => {
    const child = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn(() => child),
    };
    return { child: () => child, debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  },
}));

vi.mock('../../../src/provisioning/create-only-properties.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/provisioning/create-only-properties.js')>()),
  getCreateOnlyPropertyPaths: () => Promise.resolve([]),
}));

import { CloudControlProvider } from '../../../src/provisioning/cloud-control-provider.js';
import { withCcReadBackDefaultRemovals } from '../../../src/provisioning/cc-read-back-default-paths.js';
import {
  clearWriteOnlyPropertiesCache,
  movedReferencesRefusedOnUpdate,
  refusedOnUpdateKeysNotKeptWhenOmitted,
} from '../../../src/provisioning/write-only-properties.js';
import { createSecretMasker } from '../../../src/deployment/secret-redaction.js';
import type { JsonPatchOp } from '../../../src/provisioning/json-patch-generator.js';

const TYPE = 'AWS::Connect::User';
const USER = 'arn:aws:connect:us-east-1:123456789012:instance/i/agent/u';
// What the read model (and DescribeUser) holds for a user created without it
// (measured, #6820): no VoiceEnhancementMode, which the schema requires.
const READ_BACK_VOICE = [{ Channel: 'VOICE' }];
const LIVE = {
  UserArn: USER,
  Username: 'u',
  IdentityInfo: { FirstName: 'Alpha' },
  VoiceEnhancementConfigs: READ_BACK_VOICE,
};
const REMOVE_VOICE: JsonPatchOp = { op: 'remove', path: '/VoiceEnhancementConfigs' };
const RENAME: JsonPatchOp[] = [
  { op: 'replace', path: '/IdentityInfo', value: { FirstName: 'Beta' } },
];
const REFERENCE = '{{resolve:secretsmanager:pw:SecretString:password::}}';
const RESOLVED = 'Resolv3dPassw0rd';

describe('Connect user read-back VoiceEnhancementConfigs (go-to-k/cdkd#6820)', () => {
  it('removes the mode-less read-back entry the template does not declare', () => {
    expect(withCcReadBackDefaultRemovals(TYPE, RENAME, { Username: 'u' }, LIVE)).toEqual([
      ...RENAME,
      REMOVE_VOICE,
    ]);
  });

  it('keeps a live entry that carries a mode, and a patch that writes the key', () => {
    const withMode = [{ Channel: 'VOICE', VoiceEnhancementMode: 'VOICE_ISOLATION' }];
    expect(
      withCcReadBackDefaultRemovals(TYPE, RENAME, {}, { ...LIVE, VoiceEnhancementConfigs: withMode })
    ).toBe(RENAME);
    const writes: JsonPatchOp[] = [
      { op: 'add', path: '/VoiceEnhancementConfigs', value: withMode },
    ];
    expect(withCcReadBackDefaultRemovals(TYPE, writes, { VoiceEnhancementConfigs: withMode }, LIVE)).toBe(
      writes
    );
  });
});

describe('write-only keys refused on update (go-to-k/cdkd#6820)', () => {
  it('lists only keys the kept-when-omitted table also holds (else the row is inert)', () => {
    expect(refusedOnUpdateKeysNotKeptWhenOmitted()).toEqual([]);
  });

  it('names a re-pointed reference, and nothing for the same reference, a literal or an absent side', () => {
    const other = REFERENCE.replace('pw:', 'pw-b:');
    const moved = (d: unknown, r: unknown, type = TYPE) =>
      movedReferencesRefusedOnUpdate(type, { Password: d }, { Password: r });
    expect(moved(other, REFERENCE)).toEqual(['Password']);
    expect(moved('Literal1', REFERENCE)).toEqual(['Password']);
    expect(moved(REFERENCE, 'Literal1')).toEqual(['Password']);
    expect(moved(REFERENCE, REFERENCE)).toEqual([]);
    expect(moved('Passw0rdNew', 'Passw0rdOld')).toEqual([]);
    expect(moved(undefined, REFERENCE)).toEqual([]);
    expect(moved(other, REFERENCE, 'AWS::DMS::Endpoint')).toEqual([]);
  });
});

describe('CloudControlProvider.update for a Connect user (go-to-k/cdkd#6820)', () => {
  let sentPatch: JsonPatchOp[] | undefined;

  beforeEach(() => {
    mockCcSend.mockReset();
    mockCfnSend.mockReset();
    clearWriteOnlyPropertiesCache();
    sentPatch = undefined;
    mockCfnSend.mockResolvedValue({
      Schema: JSON.stringify({ writeOnlyProperties: ['/properties/Password'] }),
    });
    mockCcSend.mockImplementation((command: unknown) => {
      if (command instanceof GetResourceCommand) {
        return Promise.resolve({ ResourceDescription: { Properties: JSON.stringify(LIVE) } });
      }
      if (command instanceof UpdateResourceCommand) {
        sentPatch = JSON.parse(command.input.PatchDocument as string) as JsonPatchOp[];
        return Promise.reject(new Error('stop after UpdateResource'));
      }
      return Promise.reject(new Error(`unexpected command ${String(command)}`));
    });
  });

  it('leaves out an unchanged secret-derived Password and the read-back voice entry', async () => {
    await new CloudControlProvider()
      .update(
        'User',
        USER,
        TYPE,
        { Username: 'u', Password: RESOLVED, IdentityInfo: { FirstName: 'Beta' } },
        { Username: 'u', Password: REFERENCE, IdentityInfo: { FirstName: 'Alpha' } },
        { maskSecrets: createSecretMasker(new Map([[RESOLVED, REFERENCE]])) }
      )
      .catch(() => undefined);

    expect(sentPatch).toEqual([...RENAME, REMOVE_VOICE]);
  });

  it('still sends a changed literal Password (AWS refuses it visibly)', async () => {
    await new CloudControlProvider()
      .update(
        'User',
        USER,
        TYPE,
        { Username: 'u', Password: 'Passw0rdNew', IdentityInfo: { FirstName: 'Beta' } },
        { Username: 'u', Password: 'Passw0rdOld', IdentityInfo: { FirstName: 'Alpha' } },
        { maskSecrets: createSecretMasker(new Map([[RESOLVED, REFERENCE]])) }
      )
      .catch(() => undefined);

    expect(sentPatch).toContainEqual({ op: 'add', path: '/Password', value: 'Passw0rdNew' });
  });

  it('still sends a secret-derived Password the masker does not recognise', async () => {
    await new CloudControlProvider()
      .update(
        'User',
        USER,
        TYPE,
        { Username: 'u', Password: RESOLVED, IdentityInfo: { FirstName: 'Beta' } },
        { Username: 'u', Password: REFERENCE, IdentityInfo: { FirstName: 'Alpha' } },
        { maskSecrets: createSecretMasker(new Map([['other-value', REFERENCE]])) }
      )
      .catch(() => undefined);

    expect(sentPatch).toContainEqual({ op: 'add', path: '/Password', value: RESOLVED });
  });

  it("re-sends a secret-derived write-only key on a type whose handler does not refuse it", async () => {
    mockCfnSend.mockResolvedValue({
      Schema: JSON.stringify({ writeOnlyProperties: ['/properties/Password'] }),
    });
    await new CloudControlProvider()
      .update(
        'Endpoint',
        'e',
        'AWS::DMS::Endpoint',
        { Password: RESOLVED, Port: 2 },
        { Password: REFERENCE, Port: 1 },
        { maskSecrets: createSecretMasker(new Map([[RESOLVED, REFERENCE]])) }
      )
      .catch(() => undefined);

    expect(sentPatch).toContainEqual({ op: 'add', path: '/Password', value: RESOLVED });
  });
});
