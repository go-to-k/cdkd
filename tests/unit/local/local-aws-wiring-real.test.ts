import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';

// go-to-k/cdkd#6129 / #6132 through cdk-local's REAL wiring (nothing in
// cdk-local is doubled here): CDKD_AWS_EMULATOR activation against a local
// health endpoint, the --from-cfn-stack client config, and the default chain
// under a recorded --role-arn.

import {
  getActiveWorkloadAwsWiring,
  recordAssumedRole,
  resetWorkloadIdentity,
  resolveAwsEmulatorOption,
  setActiveWorkloadAwsWiring,
  setAwsEndpointOverride,
  workloadClientConfig,
  type WorkloadAwsWiring,
} from 'cdk-local/internal';
import { createLocalCommand } from '../../../src/cli/commands/local-invoke.js';
import { activateLocalAwsWiring, applyLocalAwsWiring } from '../../../src/local/local-aws-wiring.js';
import { awsClientDefaults } from '../../../src/utils/aws-client-defaults.js';

const saved = { ...process.env };
let home: string;

beforeEach(() => {
  // cdkd's embed config (CDKD_ env prefix) and the endpoint-override source.
  createLocalCommand();
  home = mkdtempSync(join(tmpdir(), 'cdkd-6132-real-'));
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('AWS_') || k.startsWith('CDKD_AWS') || k.startsWith('CDK_LOCAL_AWS')) {
      delete process.env[k];
    }
  }
  process.env['HOME'] = home;
  // Keep the suite's machine-independence fences (tests/setup.ts).
  process.env['AWS_CONFIG_FILE'] = '/nonexistent/cdkd-unit-test-aws-config';
  process.env['AWS_SHARED_CREDENTIALS_FILE'] = '/nonexistent/cdkd-unit-test-aws-credentials';
  process.env['AWS_EC2_METADATA_DISABLED'] = 'true';
});

afterEach(() => {
  setActiveWorkloadAwsWiring(undefined);
  setAwsEndpointOverride(undefined);
  resetWorkloadIdentity();
  restoreProcessEnv(saved);
  rmSync(home, { recursive: true, force: true });
});

function healthServer(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      res.statusCode = req.url === '/__admin/health' ? 200 : 404;
      res.end('{}');
    });
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, port: (server.address() as AddressInfo).port })
    );
  });
}

describe('CDKD_AWS_EMULATOR turns --aws-emulator on', () => {
  it.each(['1', 'true', 'TRUE'])('%s selects the default URL', (value) => {
    process.env['CDKD_AWS_EMULATOR'] = value;
    expect(resolveAwsEmulatorOption(undefined)).toBe(true);
  });

  it('a URL value activates the emulator wiring with no flag: run keys, cdkd and cdk-local clients', async () => {
    const { server, port } = await healthServer();
    try {
      const run = join(home, '.aws', 'emulator', String(port));
      mkdirSync(run, { recursive: true });
      writeFileSync(
        join(run, 'emulator_credentials'),
        '[default]\naws_access_key_id = EMULATORENVKEY000000\naws_secret_access_key = emu-env-secret\n'
      );
      const url = `http://127.0.0.1:${port}`;
      process.env['CDKD_AWS_EMULATOR'] = url;
      await activateLocalAwsWiring({});
      const wiring = getActiveWorkloadAwsWiring();
      expect(wiring?.mode).toBe('emulator');
      expect(wiring?.emulatorCredentials?.accessKeyId).toBe('EMULATORENVKEY000000');
      // cdkd's own clients (--from-state, {{resolve:}}, STS)
      expect(awsClientDefaults().endpoint).toBe(url);
      // cdk-local's --from-cfn-stack CloudFormation client is built from
      // `workloadClientConfig` (CfnLocalStateProvider.getClient).
      const cfn = workloadClientConfig({});
      expect(cfn.endpoint).toBe(url);
      const creds = await (cfn.credentials as () => Promise<{ accessKeyId: string }>)();
      expect(creds.accessKeyId).toBe('EMULATORENVKEY000000');
    } finally {
      server.close();
    }
  });
});

describe('--role-arn with no static caller keys: the container gets the env-less chain, never the role', () => {
  it('fills the caller profile from the shared files, not the role triple in process.env', async () => {
    const creds = join(home, 'credentials');
    writeFileSync(
      creds,
      '[default]\naws_access_key_id = CALLERPROFILEKEY0000\naws_secret_access_key = caller-secret\n'
    );
    writeFileSync(join(home, 'config'), '[default]\nregion = us-east-1\n');
    process.env['AWS_SHARED_CREDENTIALS_FILE'] = creds;
    process.env['AWS_CONFIG_FILE'] = join(home, 'config');
    // What applyRoleArnIfSet leaves behind: the ROLE in the env triple.
    process.env['AWS_ACCESS_KEY_ID'] = 'ROLEKEYID00000000000';
    process.env['AWS_SECRET_ACCESS_KEY'] = 'role-secret';
    process.env['AWS_SESSION_TOKEN'] = 'role-token';
    recordAssumedRole(undefined, {
      accessKeyId: 'ROLEKEYID00000000000',
      secretAccessKey: 'role-secret',
      sessionToken: 'role-token',
    });
    const wiring: WorkloadAwsWiring = {
      mode: 'forward',
      env: {},
      scrubEnvKeys: [],
      mounts: [],
      loopbackPorts: [],
      probeHealth: false,
      dispose: () => {},
    };
    // The env the restore left: the role was stripped (no caller snapshot).
    const out = await applyLocalAwsWiring(wiring, {}, [], []);
    expect(out.env['AWS_ACCESS_KEY_ID']).toBe('CALLERPROFILEKEY0000');
    expect(Object.values(out.env)).not.toContain('role-token');
  });
});

/** Restore the environment IN PLACE: replacing `process.env` unlinks it from the real one. */
function restoreProcessEnv(snapshot: Record<string, string | undefined>): void {
  for (const k of Object.keys(process.env)) if (!(k in snapshot)) delete process.env[k];
  for (const [k, v] of Object.entries(snapshot)) if (v !== undefined) process.env[k] = v;
}
