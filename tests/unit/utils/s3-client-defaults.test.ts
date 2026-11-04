import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { S3Client } from '@aws-sdk/client-s3';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';

import {
  pathStyleRule,
  resetS3ClientDefaults,
  resolveS3ClientDefaults,
  s3AddressingDecision,
  s3ClientDefaults,
  setS3ClientDefaultsDebugLog,
} from '../../../src/utils/s3-client-defaults.js';
import { resetAwsClientDefaults } from '../../../src/utils/aws-client-defaults.js';

/**
 * The S3 addressing-style resolver (issue #5745): botocore's rule over the
 * SDK's own endpoint resolver plus the profile's `s3.addressing_style`.
 * Everything is local: scratch config files, no request is ever sent.
 */

const AWS_ENV = [
  'HOME',
  'USERPROFILE',
  'AWS_CONFIG_FILE',
  'AWS_SHARED_CREDENTIALS_FILE',
  'AWS_PROFILE',
  'AWS_REGION',
  'AWS_DEFAULT_REGION',
  'AWS_ENDPOINT_URL',
  'AWS_ENDPOINT_URL_S3',
  'AWS_IGNORE_CONFIGURED_ENDPOINT_URLS',
  'AWS_USE_FIPS_ENDPOINT',
  'AWS_USE_DUALSTACK_ENDPOINT',
  'CDK_S3_FORCE_PATH_STYLE',
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'ALL_PROXY',
  'all_proxy',
] as const;

const scratch: string[] = [];
let saved: Record<string, string | undefined>;
let debugLines: string[];

/**
 * A FRESH file per case: the SDK's ini loader caches by path, so reusing one
 * path across cases would answer from the first case's contents.
 */
function configFile(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'cdkd-s3-addressing-'));
  scratch.push(dir);
  const path = join(dir, 'config');
  writeFileSync(path, contents);
  return path;
}

beforeEach(() => {
  saved = Object.fromEntries(AWS_ENV.map((n) => [n, process.env[n]]));
  for (const n of AWS_ENV) delete process.env[n];
  const empty = configFile('');
  process.env['AWS_CONFIG_FILE'] = empty;
  process.env['AWS_SHARED_CREDENTIALS_FILE'] = configFile('');
  process.env['HOME'] = join(empty, '..');
  resetS3ClientDefaults();
  debugLines = [];
  setS3ClientDefaultsDebugLog((line) => debugLines.push(line));
});

afterEach(() => {
  for (const n of AWS_ENV) {
    const v = saved[n];
    if (v === undefined) delete process.env[n];
    else process.env[n] = v;
  }
  resetS3ClientDefaults();
  resetAwsClientDefaults();
  setS3ClientDefaultsDebugLog(undefined);
});

afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

describe('pathStyleRule (botocore args.py)', () => {
  it.each([
    ['auto', false, false],
    ['auto', true, true],
    ['path', false, true],
    ['path', true, true],
    ['virtual', false, false],
    ['virtual', true, false],
  ] as const)('addressing_style=%s, override=%s -> %s', (style, override, expected) => {
    expect(pathStyleRule(style, override)).toBe(expected);
  });
});

interface Case {
  name: string;
  env?: Record<string, string>;
  config?: string;
  /** The shared CREDENTIALS file's contents. */
  credentials?: string;
  profile?: string;
  expected: {
    forcePathStyle: boolean;
    endpointOverride: boolean;
    addressingStyle: string;
    forcedByCdkEnv?: boolean;
  };
}

const CASES: Case[] = [
  // CDK_S3_FORCE_PATH_STYLE: the CDK CLI's `if (process.env.X)` truthiness.
  {
    name: 'CDK_S3_FORCE_PATH_STYLE set, no override: path-style ON',
    env: { CDK_S3_FORCE_PATH_STYLE: '1' },
    expected: { forcePathStyle: true, endpointOverride: false, addressingStyle: 'auto', forcedByCdkEnv: true },
  },
  {
    name: 'CDK_S3_FORCE_PATH_STYLE wins over override + addressing_style = virtual',
    env: { CDK_S3_FORCE_PATH_STYLE: 'true', AWS_ENDPOINT_URL_S3: 'http://s3:4566' },
    config: '[default]\ns3 =\n  addressing_style = virtual\n',
    expected: { forcePathStyle: true, endpointOverride: true, addressingStyle: 'virtual', forcedByCdkEnv: true },
  },
  {
    name: 'CDK_S3_FORCE_PATH_STYLE empty string means unset',
    env: { CDK_S3_FORCE_PATH_STYLE: '' },
    expected: { forcePathStyle: false, endpointOverride: false, addressingStyle: 'auto', forcedByCdkEnv: false },
  },
  {
    name: 'CDK_S3_FORCE_PATH_STYLE=false still means ON (CDK parity quirk)',
    env: { CDK_S3_FORCE_PATH_STYLE: 'false' },
    expected: { forcePathStyle: true, endpointOverride: false, addressingStyle: 'auto', forcedByCdkEnv: true },
  },
  {
    name: 'CDK_S3_FORCE_PATH_STYLE=0 still means ON (CDK parity quirk)',
    env: { CDK_S3_FORCE_PATH_STYLE: '0' },
    expected: { forcePathStyle: true, endpointOverride: false, addressingStyle: 'auto', forcedByCdkEnv: true },
  },
  // The shared credentials file, merged the way botocore merges it.
  {
    name: 'credentials-file s3 addressing_style alone is read',
    credentials: '[default]\ns3 =\n  addressing_style = path\n',
    expected: { forcePathStyle: true, endpointOverride: false, addressingStyle: 'path' },
  },
  {
    name: 'credentials-file s3 section WINS over the config file (botocore dict.update)',
    config: '[default]\ns3 =\n  addressing_style = path\n',
    credentials: '[default]\ns3 =\n  addressing_style = virtual\n',
    expected: { forcePathStyle: false, endpointOverride: false, addressingStyle: 'virtual' },
  },
  {
    name: 'a credentials-file s3 section WITHOUT addressing_style replaces the config one whole',
    config: '[default]\ns3 =\n  addressing_style = path\n',
    credentials: '[default]\ns3 =\n  signature_version = s3v4\n',
    expected: { forcePathStyle: false, endpointOverride: false, addressingStyle: 'auto' },
  },
  {
    name: 'a credentials-file profile with no s3 section leaves the config one in place',
    config: '[default]\ns3 =\n  addressing_style = path\n',
    credentials: '[default]\naws_access_key_id = AKIAIOSFODNN7EXAMPLE\n',
    expected: { forcePathStyle: true, endpointOverride: false, addressingStyle: 'path' },
  },
  {
    name: 'the credentials-file section of ANOTHER profile is not read',
    env: { AWS_PROFILE: 'emu' },
    config: '[profile emu]\ns3 =\n  addressing_style = path\n',
    credentials: '[default]\ns3 =\n  addressing_style = virtual\n',
    expected: { forcePathStyle: true, endpointOverride: false, addressingStyle: 'path' },
  },
  {
    name: 'unset: nothing configured',
    expected: { forcePathStyle: false, endpointOverride: false, addressingStyle: 'auto' },
  },
  {
    name: 'AWS_ENDPOINT_URL_S3',
    env: { AWS_ENDPOINT_URL_S3: 'http://s3:4566' },
    expected: { forcePathStyle: true, endpointOverride: true, addressingStyle: 'auto' },
  },
  {
    name: 'AWS_ENDPOINT_URL (the global override)',
    env: { AWS_ENDPOINT_URL: 'http://localhost:4566' },
    expected: { forcePathStyle: true, endpointOverride: true, addressingStyle: 'auto' },
  },
  {
    name: 'AWS_IGNORE_CONFIGURED_ENDPOINT_URLS=true beside an override',
    env: { AWS_ENDPOINT_URL_S3: 'http://s3:4566', AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: 'true' },
    expected: { forcePathStyle: false, endpointOverride: false, addressingStyle: 'auto' },
  },
  {
    name: 'profile endpoint_url selected through AWS_PROFILE',
    env: { AWS_PROFILE: 'emu' },
    config: '[profile emu]\nendpoint_url = http://s3:4566\n',
    expected: { forcePathStyle: true, endpointOverride: true, addressingStyle: 'auto' },
  },
  {
    name: 'a profile endpoint_url on a profile NOT selected',
    config: '[profile emu]\nendpoint_url = http://s3:4566\n',
    expected: { forcePathStyle: false, endpointOverride: false, addressingStyle: 'auto' },
  },
  {
    name: 'services section s3 endpoint_url',
    config: '[default]\nservices = emu\n\n[services emu]\ns3 =\n  endpoint_url = http://s3:4566\n',
    expected: { forcePathStyle: true, endpointOverride: true, addressingStyle: 'auto' },
  },
  {
    name: 'profile ignore_configured_endpoint_urls = true',
    config: '[default]\nendpoint_url = http://s3:4566\nignore_configured_endpoint_urls = true\n',
    expected: { forcePathStyle: false, endpointOverride: false, addressingStyle: 'auto' },
  },
  {
    name: 'override + addressing_style = virtual (the opt-out)',
    env: { AWS_ENDPOINT_URL_S3: 'http://s3:4566' },
    config: '[default]\ns3 =\n  addressing_style = virtual\n',
    expected: { forcePathStyle: false, endpointOverride: true, addressingStyle: 'virtual' },
  },
  {
    name: 'addressing_style = path without any override',
    config: '[default]\ns3 =\n  addressing_style = path\n',
    expected: { forcePathStyle: true, endpointOverride: false, addressingStyle: 'path' },
  },
  {
    name: 'the issue reporter\'s typo "address_style" is ignored',
    config: '[default]\ns3 =\n  address_style = path\n',
    expected: { forcePathStyle: false, endpointOverride: false, addressingStyle: 'auto' },
  },
  {
    name: 'an unrecognized addressing_style value reads as auto',
    config: '[default]\ns3 =\n  addressing_style = Path\n',
    expected: { forcePathStyle: false, endpointOverride: false, addressingStyle: 'auto' },
  },
  {
    name: 'the run --profile (mirrored into AWS_PROFILE) selects the profile',
    profile: 'emu',
    env: { AWS_PROFILE: 'emu' },
    config: '[profile emu]\nendpoint_url = http://s3:4566\ns3 =\n  addressing_style = auto\n',
    expected: { forcePathStyle: true, endpointOverride: true, addressingStyle: 'auto' },
  },
  {
    name: 'the run --profile selects the addressing_style profile',
    profile: 'emu',
    env: { AWS_PROFILE: 'emu' },
    config: '[default]\ns3 =\n  addressing_style = virtual\n\n[profile emu]\ns3 =\n  addressing_style = path\n',
    expected: { forcePathStyle: true, endpointOverride: false, addressingStyle: 'path' },
  },
  {
    name: 'the profile argument alone selects the addressing_style profile',
    profile: 'emu',
    config: '[default]\ns3 =\n  addressing_style = virtual\n\n[profile emu]\ns3 =\n  addressing_style = path\n',
    expected: { forcePathStyle: true, endpointOverride: false, addressingStyle: 'path' },
  },
  {
    name: 'addressing_style read from the SELECTED profile, not [default]',
    env: { AWS_PROFILE: 'emu' },
    config: '[default]\ns3 =\n  addressing_style = path\n\n[profile emu]\nregion = us-east-1\n',
    expected: { forcePathStyle: false, endpointOverride: false, addressingStyle: 'auto' },
  },
];

describe('resolveS3ClientDefaults', () => {
  it.each(CASES)('$name', async (c) => {
    for (const [k, v] of Object.entries(c.env ?? {})) process.env[k] = v;
    if (c.config !== undefined) process.env['AWS_CONFIG_FILE'] = configFile(c.config);
    if (c.credentials !== undefined) {
      process.env['AWS_SHARED_CREDENTIALS_FILE'] = configFile(c.credentials);
    }
    const decision = await resolveS3ClientDefaults(
      c.profile !== undefined ? { profile: c.profile } : {}
    );
    expect(decision).toEqual({ forcedByCdkEnv: false, ...c.expected, source: 'resolved' });
    expect(s3ClientDefaults()).toEqual(c.expected.forcePathStyle ? { forcePathStyle: true } : {});
  });

  it('a client `profile` key alone does NOT select the SDK endpoint (AWS_PROFILE does)', async () => {
    // SDK contract (3.1161): the configured-endpoint lookup ignores a client's
    // `profile` key and reads AWS_PROFILE. So cdkd's real clients and this
    // resolver both key on AWS_PROFILE, which preAction sets from --profile. If
    // an SDK bump starts honouring the key, a site whose `profile` differs from
    // AWS_PROFILE could disagree with the resolver: re-decide then.
    process.env['AWS_CONFIG_FILE'] = configFile('[profile emu]\nendpoint_url = http://s3:4566\n');
    const client = new S3Client({ profile: 'emu', region: 'us-east-1' });
    try {
      expect(await client.config.serviceConfiguredEndpoint?.()).toBeUndefined();
    } finally {
      client.destroy();
    }
    expect((await resolveS3ClientDefaults({ profile: 'emu' })).endpointOverride).toBe(false);
  });

  it('a reset while resolution is in flight drops that resolution', async () => {
    process.env['AWS_ENDPOINT_URL_S3'] = 'http://s3:4566';
    const stale = resolveS3ClientDefaults();
    resetS3ClientDefaults();
    delete process.env['AWS_ENDPOINT_URL_S3'];
    await stale;
    // The stale decision (path-style on) must not have been committed.
    expect(s3AddressingDecision().source).toBe('env-fallback');
    expect((await resolveS3ClientDefaults()).forcePathStyle).toBe(false);
    s3ClientDefaults();
    expect(debugLines.filter((l) => l.includes('path-style addressing enabled'))).toEqual([]);
  });

  it('a non-probe client built WHILE resolution is in flight still gets the fallback notice', async () => {
    const pending = resolveS3ClientDefaults();
    s3ClientDefaults();
    await pending;
    expect(debugLines.filter((l) => l.includes('before the S3 addressing style was resolved'))).toHaveLength(1);
  });

  it('is memoized once per process: a later environment change is not re-read', async () => {
    await resolveS3ClientDefaults();
    process.env['AWS_ENDPOINT_URL_S3'] = 'http://s3:4566';
    expect((await resolveS3ClientDefaults()).forcePathStyle).toBe(false);
    expect(s3ClientDefaults()).toEqual({});
  });

  it('never rejects: an unreadable configuration falls back to the environment-only answer', async () => {
    process.env['AWS_ENDPOINT_URL_S3'] = 'http://s3:4566';
    // Whitespace-only proxy: awsClientDefaults() throws inside the probe.
    process.env['HTTPS_PROXY'] = '   ';
    resetAwsClientDefaults();
    const decision = await resolveS3ClientDefaults();
    expect(decision).toMatchObject({ source: 'env-fallback', forcePathStyle: true });
    s3ClientDefaults();
    expect(debugLines.some((l) => l.includes('Could not read the S3 endpoint'))).toBe(true);
  });

  it('a probe that throws while being BUILT still clears the probe flag', async () => {
    process.env['HTTPS_PROXY'] = '   ';
    resetAwsClientDefaults();
    const pending = resolveS3ClientDefaults();
    // In flight, after the probe construction threw: an early client here is
    // a real one and must be reported.
    s3ClientDefaults();
    await pending;
    expect(
      debugLines.filter((l) => l.includes('before the S3 addressing style was resolved'))
    ).toHaveLength(1);
  });
});

describe('s3ClientDefaults', () => {
  it('no override, no profile setting: the key is ABSENT and the SDK resolves false', async () => {
    await resolveS3ClientDefaults();
    const defaults = s3ClientDefaults();
    expect(defaults).toEqual({});
    expect(Object.prototype.hasOwnProperty.call(defaults, 'forcePathStyle')).toBe(false);
    const client = new S3Client({ region: 'us-east-1', ...defaults });
    try {
      expect(await client.config.forcePathStyle).toBe(false);
    } finally {
      client.destroy();
    }
  });

  it('a plain boolean, never a function, when on', async () => {
    process.env['AWS_ENDPOINT_URL_S3'] = 'http://s3:4566';
    await resolveS3ClientDefaults();
    expect(s3ClientDefaults()).toStrictEqual({ forcePathStyle: true });
  });

  it('explicitEndpoint counts as an override, still honouring addressing_style = virtual', async () => {
    await resolveS3ClientDefaults();
    expect(s3ClientDefaults()).toEqual({});
    expect(s3ClientDefaults({ explicitEndpoint: true })).toEqual({ forcePathStyle: true });
    resetS3ClientDefaults();
    process.env['AWS_CONFIG_FILE'] = configFile('[default]\ns3 =\n  addressing_style = virtual\n');
    await resolveS3ClientDefaults();
    expect(s3ClientDefaults({ explicitEndpoint: true })).toEqual({});
  });

  it('before resolution: the environment-only fallback, with ONE debug line', () => {
    process.env['AWS_ENDPOINT_URL_S3'] = 'http://s3:4566';
    expect(s3AddressingDecision()).toMatchObject({ source: 'env-fallback', forcePathStyle: true });
    expect(s3ClientDefaults()).toEqual({ forcePathStyle: true });
    s3ClientDefaults();
    expect(debugLines.filter((l) => l.includes('before the S3 addressing style was resolved'))).toHaveLength(1);
  });

  it.each([
    [{}, false],
    [{ AWS_ENDPOINT_URL: 'http://x:1' }, true],
    // Matches the SDK, which treats any non-empty value as an override.
    [{ AWS_ENDPOINT_URL_S3: '  ' }, true],
    [{ AWS_ENDPOINT_URL_S3: '' }, false],
    [{ AWS_ENDPOINT_URL_S3: 'http://x:1', AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: 'true' }, false],
    // The SDK accepts exactly `true` / `false`; anything else is not `true`.
    [{ AWS_ENDPOINT_URL_S3: 'http://x:1', AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: 'TRUE' }, true],
    // CDK_S3_FORCE_PATH_STYLE, read by the fallback too, CDK truthiness.
    [{ CDK_S3_FORCE_PATH_STYLE: 'false' }, true],
    [{ CDK_S3_FORCE_PATH_STYLE: '' }, false],
    [{ CDK_S3_FORCE_PATH_STYLE: '1', AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: 'true' }, true],
    [{ AWS_ENDPOINT_URL_S3: 'http://x:1', AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: 'false' }, true],
  ])('env fallback %o -> %s', (env, expected) => {
    for (const [k, v] of Object.entries(env)) process.env[k] = v;
    expect(s3AddressingDecision().forcePathStyle).toBe(expected);
  });

  it('announces path-style once, at the first client build after resolution, naming the opt-out', async () => {
    process.env['AWS_ENDPOINT_URL_S3'] = 'http://s3:4566';
    await resolveS3ClientDefaults();
    // Not yet: `--verbose` is applied by the command action, after preAction.
    expect(debugLines).toEqual([]);
    s3ClientDefaults();
    s3ClientDefaults();
    expect(debugLines).toHaveLength(1);
    expect(debugLines[0]).toContain('S3 path-style addressing enabled');
    expect(debugLines[0]).toContain('addressing_style = virtual');
    // The endpoint value itself is never logged.
    expect(debugLines[0]).not.toContain('s3:4566');
  });

  it('CDK_S3_FORCE_PATH_STYLE also forces the explicit-endpoint (presign) client over virtual', async () => {
    process.env['CDK_S3_FORCE_PATH_STYLE'] = 'yes';
    process.env['AWS_CONFIG_FILE'] = configFile('[default]\ns3 =\n  addressing_style = virtual\n');
    await resolveS3ClientDefaults();
    expect(s3ClientDefaults({ explicitEndpoint: true })).toEqual({ forcePathStyle: true });
  });

  it('names CDK_S3_FORCE_PATH_STYLE and how to turn it off when it is the reason', async () => {
    process.env['CDK_S3_FORCE_PATH_STYLE'] = '1';
    await resolveS3ClientDefaults();
    s3ClientDefaults();
    expect(debugLines).toHaveLength(1);
    expect(debugLines[0]).toContain('CDK_S3_FORCE_PATH_STYLE is set');
    expect(debugLines[0]).toContain('Unset it');
  });

  it('says nothing when path-style is off', async () => {
    await resolveS3ClientDefaults();
    s3ClientDefaults();
    expect(debugLines).toEqual([]);
  });
});

describe('public API (library callers resolve it themselves)', () => {
  it('exports resolveS3ClientDefaults and s3AddressingDecision from the package entry', async () => {
    const api = await import('../../../src/index.js');
    expect(api.resolveS3ClientDefaults).toBe(resolveS3ClientDefaults);
    expect(api.s3AddressingDecision).toBe(s3AddressingDecision);
  });
});
