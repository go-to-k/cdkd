import { afterAll, beforeAll, describe, expect, it, vi } from 'vite-plus/test';
import { IAMClient } from '@aws-sdk/client-iam';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { describeWireCases, record, setOutputOverrides } from './sdk-wire-harness.js';

// The client classes these cases reach (`sdk-wire-cases-iam-secrets.ts`), wrapped
// as in `sdk-wire-coverage.test.ts`: every instance, shared or provider-built
// (the IAM create client), is captured.
const { wrap } = vi.hoisted(() => ({
  wrap: async (orig: () => Promise<Record<string, unknown>>, className: string) =>
    (await import('./sdk-wire-harness.js')).wrapClientModule(await orig(), className),
}));
vi.mock('@aws-sdk/client-iam', (orig) => wrap(orig, 'IAMClient'));
vi.mock('@aws-sdk/client-secrets-manager', (orig) => wrap(orig, 'SecretsManagerClient'));

const clients = {
  iam: new IAMClient({}),
  secretsManager: new SecretsManagerClient({}),
};

vi.mock('../../../src/utils/aws-clients.js', () => ({ getAwsClients: () => clients }));

import { CASES_IAM_SECRETS, deterministicRandomValues } from './sdk-wire-cases-iam-secrets.js';
import { IAMUserGroupProvider } from '../../../src/provisioning/providers/iam-user-group-provider.js';

// A generated secret value is drawn from `crypto.getRandomValues`.
beforeAll(() => {
  vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(deterministicRandomValues);
});
afterAll(() => {
  vi.restoreAllMocks();
});

describe('SDK wire coverage (IAM users and groups, Secrets Manager)', () => {
  describeWireCases(CASES_IAM_SECRETS);
});

// The UserToGroupAddition case's probes only ever hold a recorded side with
// no GroupName, so a move between groups is proved here.
describe('AWS::IAM::UserToGroupAddition moved to another group', () => {
  it('removes each recorded user from the old group, then adds each desired user to the new one', async () => {
    setOutputOverrides(undefined);
    const outcome = await record(() =>
      new IAMUserGroupProvider().update(
        'L',
        'L',
        'AWS::IAM::UserToGroupAddition',
        { GroupName: 'g2', Users: ['u1', 'u3'] },
        { GroupName: 'g1', Users: ['u1', 'u2'] }
      )
    );
    expect(outcome).toMatchObject({ threw: false });
    const calls = (outcome as { wire: string }).wire.split('\n').map((line) => {
      const entry = JSON.parse(line) as string[];
      const body = new URLSearchParams(entry[entry.length - 1]);
      return [entry[0], body.get('GroupName'), body.get('UserName')];
    });
    expect(calls).toEqual([
      ['RemoveUserFromGroupCommand', 'g1', 'u1'],
      ['RemoveUserFromGroupCommand', 'g1', 'u2'],
      ['AddUserToGroupCommand', 'g2', 'u1'],
      ['AddUserToGroupCommand', 'g2', 'u3'],
    ]);
  });
});
