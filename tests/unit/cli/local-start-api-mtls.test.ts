/**
 * Unit tests for the `resolveMtlsConfig` CLI helper (issue #446).
 *
 * The helper enforces the all-or-none invariant for the three
 * `--mtls-truststore` / `--mtls-cert` / `--mtls-key` flags at CLI parse
 * time so the server never boots in a half-configured state.
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vite-plus/test';
import { resolveMtlsConfig } from '../../../src/cli/commands/local-start-api.js';

describe('resolveMtlsConfig', () => {
  let tmp: string;
  let truststore: string;
  let cert: string;
  let key: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'cdkd-mtls-cli-'));
    truststore = join(tmp, 'truststore.pem');
    cert = join(tmp, 'cert.pem');
    key = join(tmp, 'key.pem');
    writeFileSync(truststore, 'CA-PEM');
    writeFileSync(cert, 'CERT-PEM');
    writeFileSync(key, 'KEY-PEM');
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns undefined when none of the three flags is set (plain HTTP)', () => {
    const out = resolveMtlsConfig({});
    expect(out).toBeUndefined();
  });

  it('returns undefined when every flag is an empty string (treated as unset)', () => {
    const out = resolveMtlsConfig({
      mtlsTruststore: '',
      mtlsCert: '',
      mtlsKey: '',
    });
    expect(out).toBeUndefined();
  });

  it('reads all three PEMs when all three flags are set', () => {
    const out = resolveMtlsConfig({
      mtlsTruststore: truststore,
      mtlsCert: cert,
      mtlsKey: key,
    });
    expect(out).toBeDefined();
    expect(out!.caPem.toString()).toBe('CA-PEM');
    expect(out!.certPem.toString()).toBe('CERT-PEM');
    expect(out!.keyPem.toString()).toBe('KEY-PEM');
  });

  it('rejects --mtls-truststore alone (cert + key missing)', () => {
    expect(() => resolveMtlsConfig({ mtlsTruststore: truststore })).toThrow(
      /mTLS configuration is incomplete: --mtls-truststore set but --mtls-cert, --mtls-key missing/
    );
  });

  it('rejects --mtls-cert + --mtls-key alone (truststore missing)', () => {
    expect(() => resolveMtlsConfig({ mtlsCert: cert, mtlsKey: key })).toThrow(
      /mTLS configuration is incomplete: --mtls-cert, --mtls-key set but --mtls-truststore missing/
    );
  });

  it('rejects --mtls-truststore + --mtls-cert alone (key missing)', () => {
    expect(() =>
      resolveMtlsConfig({ mtlsTruststore: truststore, mtlsCert: cert })
    ).toThrow(/--mtls-key missing/);
  });

  it('surfaces a clear error naming the flag when a PEM file does not exist', () => {
    expect(() =>
      resolveMtlsConfig({
        mtlsTruststore: join(tmp, 'does-not-exist.pem'),
        mtlsCert: cert,
        mtlsKey: key,
      })
    ).toThrow(/--mtls-truststore: cannot read PEM file at/);
  });
});
