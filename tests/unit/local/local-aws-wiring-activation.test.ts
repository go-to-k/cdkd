import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

// go-to-k/cdkd#6132: `activateLocalAwsAndRoleArn` is the one entry of cdkd's
// four `cdkd local` commands. The wiring must be active BEFORE `--role-arn` is
// assumed, so the role's STS hop and every client after it follow
// `--aws-emulator`. Both halves are doubled and their calls ordered.

const order = vi.hoisted(() => [] as string[]);
const roleArnMock = vi.hoisted(() => vi.fn());
const activateMock = vi.hoisted(() => vi.fn());

vi.mock('../../../src/local/local-role-arn.js', () => ({
  applyRoleArnForLocal: roleArnMock,
}));
vi.mock('cdk-local/internal', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  activateWorkloadAwsWiring: activateMock,
}));

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activateLocalAwsAndRoleArn } from '../../../src/local/local-aws-wiring.js';
import { CdkdError } from '../../../src/utils/error-handler.js';

afterEach(() => {
  order.length = 0;
  roleArnMock.mockReset();
  activateMock.mockReset();
});

const ENV_VARS = join(mkdtempSync(join(tmpdir(), 'cdkd-activation-')), 'env.json');
writeFileSync(ENV_VARS, '{}');

describe('activateLocalAwsAndRoleArn', () => {
  it('activates the wiring with the options, THEN assumes --role-arn', async () => {
    activateMock.mockImplementation(async () => {
      order.push('activate');
    });
    roleArnMock.mockImplementation(async () => {
      order.push('role-arn');
    });
    await activateLocalAwsAndRoleArn({
      awsEmulator: true,
      caBundle: '/ca.pem',
      profile: 'dev',
      pull: false,
      envVars: ENV_VARS,
      roleArn: 'arn:aws:iam::123456789012:role/deploy',
      region: 'us-east-1',
    });
    expect(order).toEqual(['activate', 'role-arn']);
    expect(activateMock).toHaveBeenCalledWith({
      awsEmulator: true,
      caBundle: '/ca.pem',
      profile: 'dev',
      pull: false,
      // go-to-k/cdkd#6150: the file whose `aws-emulator` sentinels select mixed mode.
      envVars: ENV_VARS,
    });
    expect(roleArnMock).toHaveBeenCalledWith({
      roleArn: 'arn:aws:iam::123456789012:role/deploy',
      region: 'us-east-1',
    });
  });

  it('assumes no role when the wiring cannot be activated (an unreachable emulator)', async () => {
    activateMock.mockRejectedValue(new Error('--aws-emulator https://127.0.0.1:9297: no AWS Emulator answers'));
    const err = await activateLocalAwsAndRoleArn({ awsEmulator: true }).catch((e) => e);
    expect(err).toBeInstanceOf(CdkdError);
    expect(roleArnMock).not.toHaveBeenCalled();
  });

  it('carries the refusal text once: no cause repeating it as a second line', async () => {
    const text = '--env-vars sets AWS_ENDPOINT_URL_DYNAMODB under Parameters to "aws-emulator", which needs --aws-emulator [url]';
    activateMock.mockRejectedValue(new Error(text));
    const err = await activateLocalAwsAndRoleArn({ envVars: '/env.json' }).catch((e) => e);
    expect(err).toBeInstanceOf(CdkdError);
    expect(err.message).toBe(text);
    expect(err.cause).toBeUndefined();
  });
});
