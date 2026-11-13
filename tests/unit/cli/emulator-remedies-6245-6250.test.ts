import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

const { mockResolveWiring } = vi.hoisted(() => ({ mockResolveWiring: vi.fn() }));
vi.mock('cdk-local/internal', async (importOriginal) => ({
  ...(await importOriginal<typeof import('cdk-local/internal')>()),
  resolveWorkloadAwsWiring: mockResolveWiring,
}));

import { buildProgram } from '../../../src/cli/program.js';
import {
  activateAwsEmulatorForCommand,
  plainHttpHint,
} from '../../../src/cli/aws-emulator-activation.js';
import {
  resetAwsClientDefaults,
  setAwsEndpointOverrideSource,
} from '../../../src/utils/aws-client-defaults.js';
import { CdkdError, formatError } from '../../../src/utils/error-handler.js';
import { missingStateBucketRemedy } from '../../../src/utils/missing-state-bucket-remedy.js';
import { cdkdRemedy, deployReplaceCommand } from '../../../src/utils/pasteable-command.js';
import {
  setPasteableRunFlags,
  setPasteableVerbFlags,
} from '../../../src/utils/pasteable-run-context.js';

/**
 * go-to-k/cdkd#6245: a remedy cdkd spells from its own words carries the
 * run's typed `--aws-emulator`, so pasting it does not reach real AWS.
 * go-to-k/cdkd#6250: the emulator health-check failure prints once, and an
 * `http://` URL against the HTTPS emulator is told so.
 */

afterEach(() => {
  setPasteableRunFlags({});
  setPasteableVerbFlags(undefined);
  resetAwsClientDefaults();
});

const URL = 'https://127.0.0.1:9493';

describe('literal remedies carry the run flags (#6245)', () => {
  it('is unchanged when the run typed no flag', () => {
    buildProgram();
    expect(deployReplaceCommand()).toBe('cdkd deploy --replace');
    expect(deployReplaceCommand(true)).toBe('cdkd deploy --replace --force-stateful-recreation');
    expect(cdkdRemedy('cdkd import')).toBe('cdkd import');
  });

  it('appends a typed --aws-emulator URL, and a bare flag as typed', () => {
    buildProgram();
    setPasteableRunFlags({ awsEmulator: URL });
    expect(deployReplaceCommand(true)).toBe(
      `cdkd deploy --replace --force-stateful-recreation --aws-emulator=${URL}`
    );
    expect(cdkdRemedy('cdkd import')).toBe(`cdkd import --aws-emulator=${URL}`);
    expect(cdkdRemedy('cdkd bootstrap', '--force')).toBe(
      `cdkd bootstrap --force --aws-emulator=${URL}`
    );
    setPasteableRunFlags({ awsEmulator: true });
    expect(deployReplaceCommand()).toBe('cdkd deploy --replace --aws-emulator');
  });
});

describe('missing state bucket (#6245)', () => {
  it('real AWS keeps the bootstrap pointer as it was', () => {
    expect(missingStateBucketRemedy("'cdkd-state-1'")).toBe(
      "Run 'cdkd bootstrap' to create 'cdkd-state-1'."
    );
  });

  it('under --aws-emulator says why, that a deploy bootstraps it, and keeps the flag on bootstrap', () => {
    // The program first: building it resets the endpoint override.
    buildProgram();
    setAwsEndpointOverrideSource(() => ({ endpoint: URL }) as never);
    setPasteableRunFlags({ awsEmulator: URL });
    const text = missingStateBucketRemedy("'cdkd-state-000000000000'");
    expect(text).toContain('AWS Emulator keeps nothing across restarts');
    expect(text).toContain('A cdkd deploy without --dry-run creates the state bucket on its own');
    expect(text).not.toContain("Run 'cdkd bootstrap'");
    expect(text).toMatch(new RegExp(`\\ncdkd bootstrap --aws-emulator=${URL.replace(/\./g, '\\.')}$`));
  });
});

describe('emulator health check (#6250)', () => {
  const healthText = (url: string, reason: string): string =>
    `--aws-emulator ${url}: no AWS Emulator answers its health check at ${url}/__admin/health (${reason}). ` +
    'Check that it is running on port 9493.';

  it('prints the message once, not again as a Caused by line', async () => {
    mockResolveWiring.mockRejectedValueOnce(new Error(healthText(URL, 'ECONNREFUSED')));
    const error = await activateAwsEmulatorForCommand(URL).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CdkdError);
    const printed = formatError(error);
    expect(printed).toBe(`CdkdError: ${healthText(URL, 'ECONNREFUSED')}`);
    expect(printed).not.toContain('Caused by');
  });

  it('still prints a cause that adds something', () => {
    const printed = formatError(new CdkdError('outer', 'X', new Error('inner detail')));
    expect(printed).toBe('CdkdError: outer\nCaused by: inner detail');
  });

  it('tells an http:// URL that the emulator serves HTTPS', async () => {
    const httpUrl = 'http://127.0.0.1:9493';
    mockResolveWiring.mockRejectedValueOnce(new Error(healthText(httpUrl, 'HPE_INVALID_CONSTANT')));
    const error = await activateAwsEmulatorForCommand(httpUrl).catch((e: unknown) => e);
    const printed = formatError(error);
    expect(printed).toContain(
      'The port answered, but not in plain HTTP (HPE_INVALID_CONSTANT): if this port is AWS Emulator, it serves HTTPS, so use --aws-emulator https://127.0.0.1:9493.'
    );
    expect(printed).not.toContain('Caused by');
  });

  it('adds no scheme hint to an https URL or a refused connection', () => {
    expect(plainHttpHint(healthText(URL, 'HPE_INVALID_CONSTANT'))).toBe('');
    expect(plainHttpHint(healthText('http://127.0.0.1:9493', 'ECONNREFUSED'))).toBe('');
  });
});
