/**
 * Unit tests for `cdkd local start-api` mTLS support (issue #446).
 *
 * Covers:
 *   - `peerCertificateToAws` shape extraction from Node's PeerCertificate
 *     (the load-bearing pure-functional conversion).
 *   - `extractClientCert` socket-type guard (returns undefined on
 *     non-TLS sockets, which is the safety net for the mtls === undefined
 *     branch).
 *   - `readMtlsMaterialsFromDisk` PEM-read failure mode (missing file
 *     gets a typed error naming the offending flag).
 *   - End-to-end scheme reporting: a plain HTTP server reports
 *     `scheme: 'http'`; the https branch is verified by spawning
 *     openssl to generate a real cert pair when available, skipped
 *     otherwise (the integ test at `tests/integration/local-start-api/`
 *     covers the handshake-rejects-unknown-CA end-to-end).
 *
 * The TLS handshake itself (rejection of unknown-CA / self-signed
 * client certs) is enforced by Node's `tls` module; we do NOT
 * re-implement that check in cdkd, so the unit tests focus on the
 * pure-functional helpers + the plumbing into the event shape.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage } from 'node:http';
import type { PeerCertificate } from 'node:tls';
import { describe, expect, it, vi, beforeEach } from 'vite-plus/test';
import {
  extractClientCert,
  peerCertificateToAws,
  readMtlsMaterialsFromDisk,
  startApiServer,
  type ServerState,
  type MtlsServerConfig,
} from '../../../src/local/http-server.js';
import type { ContainerPool } from '../../../src/local/container-pool.js';

vi.mock('../../../src/local/rie-client.js', () => ({
  invokeRie: vi.fn(),
}));

function makePool(): ContainerPool {
  return {
    acquire: vi.fn(async () => ({
      containerId: 'c1',
      containerHost: '127.0.0.1',
      hostPort: 1234,
      logicalId: 'X',
      release: vi.fn(),
    })),
    release: vi.fn(),
    dispose: vi.fn(async () => undefined),
  } as unknown as ContainerPool;
}

function makeState(): ServerState {
  return {
    routes: [],
    pool: makePool(),
    corsConfigByApiId: new Map(),
  };
}

/**
 * Try to find an openssl binary on PATH. Returns the path on success,
 * `undefined` when openssl is unavailable (in which case the
 * scheme=https test self-skips).
 */
function findOpenssl(): string | undefined {
  // Try the common locations; covers macOS Homebrew + Linux defaults.
  for (const candidate of ['openssl', '/usr/bin/openssl', '/opt/homebrew/bin/openssl']) {
    try {
      execFileSync(candidate, ['version'], { stdio: 'ignore' });
      return candidate;
    } catch {
      /* try next */
    }
  }
  return undefined;
}

describe('peerCertificateToAws', () => {
  it('converts a populated PeerCertificate to the AWS clientCert shape', () => {
    // Synthetic 4-byte "DER" so we can assert the base64 PEM wrap.
    const rawDer = Buffer.from([0x30, 0x82, 0x01, 0x02]);
    const cert: Partial<PeerCertificate> = {
      subject: { CN: 'client', O: 'example', C: 'US' } as PeerCertificate['subject'],
      issuer: { CN: 'My CA', O: 'example', C: 'US' } as PeerCertificate['issuer'],
      serialNumber: '0123456789ABCDEF',
      valid_from: 'May 22 03:30:00 2026 GMT',
      valid_to: 'May 22 03:30:00 2027 GMT',
      raw: rawDer,
    };
    const out = peerCertificateToAws(cert as PeerCertificate);
    expect(out).toBeDefined();
    expect(out!['subjectDN']).toBe('CN=client,O=example,C=US');
    expect(out!['issuerDN']).toBe('CN=My CA,O=example,C=US');
    expect(out!['serialNumber']).toBe('0123456789ABCDEF');
    expect(out!['validity']).toEqual({
      notBefore: 'May 22 03:30:00 2026 GMT',
      notAfter: 'May 22 03:30:00 2027 GMT',
    });
    const pem = out!['clientCertPem'] as string;
    expect(pem.startsWith('-----BEGIN CERTIFICATE-----')).toBe(true);
    expect(pem.includes(rawDer.toString('base64'))).toBe(true);
    expect(pem.endsWith('-----END CERTIFICATE-----\n')).toBe(true);
  });

  it('orders DN fields canonical (CN, OU, O, L, ST, C) and skips missing fields', () => {
    const cert: Partial<PeerCertificate> = {
      subject: { C: 'US', CN: 'client', OU: 'engineering' } as PeerCertificate['subject'],
      issuer: { CN: 'CA' } as PeerCertificate['issuer'],
      serialNumber: 'AA',
      valid_from: 'X',
      valid_to: 'Y',
      raw: Buffer.alloc(0),
    };
    const out = peerCertificateToAws(cert as PeerCertificate);
    expect(out!['subjectDN']).toBe('CN=client,OU=engineering,C=US');
    expect(out!['issuerDN']).toBe('CN=CA');
  });

  it('returns undefined on an empty cert object (handshake passed but no peer cert)', () => {
    expect(peerCertificateToAws({})).toBeUndefined();
  });

  it('returns undefined on null / undefined input', () => {
    expect(peerCertificateToAws(undefined)).toBeUndefined();
    expect(peerCertificateToAws(null)).toBeUndefined();
  });

  it('falls back to empty strings on missing subject/issuer/serial/validity fields', () => {
    const out = peerCertificateToAws({ raw: Buffer.from([0x00]) } as unknown as PeerCertificate);
    expect(out).toBeDefined();
    expect(out!['subjectDN']).toBe('');
    expect(out!['issuerDN']).toBe('');
    expect(out!['serialNumber']).toBe('');
    expect(out!['validity']).toEqual({ notBefore: '', notAfter: '' });
  });

  it('emits empty clientCertPem when `raw` is not a Buffer (parsed-metadata-only path)', () => {
    const out = peerCertificateToAws({
      subject: { CN: 'x' },
      issuer: { CN: 'y' },
      serialNumber: 'aa',
      valid_from: 'a',
      valid_to: 'b',
    } as unknown as PeerCertificate);
    expect(out!['clientCertPem']).toBe('');
  });
});

describe('extractClientCert', () => {
  it('returns undefined when the socket is not a TLSSocket (no getPeerCertificate method)', () => {
    // Plain `net.Socket` shape — no `getPeerCertificate`.
    const req = { socket: {} } as unknown as IncomingMessage;
    expect(extractClientCert(req)).toBeUndefined();
  });

  it('routes through peerCertificateToAws when the socket exposes getPeerCertificate', () => {
    const fakeCert: Partial<PeerCertificate> = {
      subject: { CN: 'client' } as PeerCertificate['subject'],
      issuer: { CN: 'My CA' } as PeerCertificate['issuer'],
      serialNumber: 'AA',
      valid_from: 'X',
      valid_to: 'Y',
      raw: Buffer.from([0x00]),
    };
    const req = {
      socket: {
        getPeerCertificate: () => fakeCert,
      },
    } as unknown as IncomingMessage;
    const out = extractClientCert(req);
    expect(out).toBeDefined();
    expect(out!['subjectDN']).toBe('CN=client');
    expect(out!['issuerDN']).toBe('CN=My CA');
  });

  it('returns undefined when the TLSSocket reports an empty cert', () => {
    const req = {
      socket: {
        getPeerCertificate: () => ({}),
      },
    } as unknown as IncomingMessage;
    expect(extractClientCert(req)).toBeUndefined();
  });
});

describe('readMtlsMaterialsFromDisk', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'cdkd-mtls-test-'));
  });

  it('reads three valid PEM files', () => {
    const ca = join(tmp, 'ca.pem');
    const cert = join(tmp, 'cert.pem');
    const key = join(tmp, 'key.pem');
    writeFileSync(ca, 'CA');
    writeFileSync(cert, 'CERT');
    writeFileSync(key, 'KEY');
    const out = readMtlsMaterialsFromDisk({
      truststorePath: ca,
      certPath: cert,
      keyPath: key,
    });
    expect(out.caPem.toString()).toBe('CA');
    expect(out.certPem.toString()).toBe('CERT');
    expect(out.keyPem.toString()).toBe('KEY');
    rmSync(tmp, { recursive: true, force: true });
  });

  it('surfaces a clear error naming the offending flag + path on ENOENT', () => {
    expect(() =>
      readMtlsMaterialsFromDisk({
        truststorePath: join(tmp, 'missing.pem'),
        certPath: join(tmp, 'cert.pem'),
        keyPath: join(tmp, 'key.pem'),
      })
    ).toThrow(/--mtls-truststore: cannot read PEM file at/);
    rmSync(tmp, { recursive: true, force: true });
  });
});

describe('startApiServer scheme reporting', () => {
  it('plain HTTP server reports scheme=http', async () => {
    const server = await startApiServer({
      state: makeState(),
      rieTimeoutMs: 1000,
      host: '127.0.0.1',
      port: 0,
    });
    try {
      expect(server.scheme).toBe('http');
    } finally {
      await server.close();
    }
  });

  // The mTLS scheme test needs a real RSA private key + matching cert
  // for `https.createServer` to accept. We generate it once via openssl
  // at test start. When openssl is unavailable (uncommon — every CI
  // image we target ships it), the test self-skips with a clear message
  // so the suite stays green on minimal environments. The
  // handshake-against-unknown-CA path is the integ test's responsibility
  // (`tests/integration/local-start-api/` --mtls variant).
  const opensslBin = findOpenssl();
  const itMaybe = opensslBin ? it : it.skip;
  itMaybe('mTLS server reports scheme=https', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'cdkd-mtls-bootscheme-'));
    try {
      const certPath = join(tmp, 'cert.pem');
      const keyPath = join(tmp, 'key.pem');
      // Generate a one-shot self-signed RSA cert for localhost. The
      // -nodes flag leaves the key unencrypted so Node's tls module
      // can read it without a passphrase callback.
      execFileSync(
        opensslBin!,
        [
          'req',
          '-x509',
          '-newkey',
          'rsa:2048',
          '-nodes',
          '-keyout',
          keyPath,
          '-out',
          certPath,
          '-subj',
          '/CN=localhost',
          '-days',
          '1',
        ],
        { stdio: 'ignore' }
      );
      // Sanity-check both files were written.
      expect(existsSync(certPath)).toBe(true);
      expect(existsSync(keyPath)).toBe(true);
      const mtls: MtlsServerConfig = {
        caPem: readFileSync(certPath),
        certPem: readFileSync(certPath),
        keyPem: readFileSync(keyPath),
      };
      const server = await startApiServer({
        state: makeState(),
        rieTimeoutMs: 1000,
        host: '127.0.0.1',
        port: 0,
        mtls,
      });
      try {
        expect(server.scheme).toBe('https');
      } finally {
        await server.close();
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
