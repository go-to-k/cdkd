/**
 * Unit tests for the boot-time SSRF warning helpers in
 * `src/local/rest-v1-integrations.ts`.
 */

import { describe, expect, it } from 'vite-plus/test';

import {
  classifyInternalHost,
  warnSsrfRiskyUri,
} from '../../../src/local/rest-v1-integrations.js';

describe('Fix 2: SSRF warning helpers', () => {
  describe('classifyInternalHost', () => {
    it.each([
      ['169.254.169.254', 'AWS IMDS'],
      ['127.0.0.1', 'IPv4 loopback'],
      ['127.42.7.9', 'IPv4 loopback'],
      ['::1', 'IPv6 loopback'],
      ['169.254.5.5', 'IPv4 link-local'],
      ['fe80::1', 'IPv6 link-local'],
      ['10.0.0.1', 'RFC1918 private (10.'],
      ['10.255.255.255', 'RFC1918 private (10.'],
      ['172.16.0.1', 'RFC1918 private (172.16'],
      ['172.31.255.254', 'RFC1918 private (172.16'],
      ['192.168.1.1', 'RFC1918 private (192.168'],
    ])('classifies %s as internal', (host, expectedSubstring) => {
      const result = classifyInternalHost(host);
      expect(result).toBeDefined();
      expect(result).toContain(expectedSubstring);
    });

    it.each([
      'example.com',
      'api.example.com',
      '8.8.8.8',
      '1.1.1.1',
      '172.32.0.1', // OUTSIDE 172.16-172.31
      '172.15.0.1', // OUTSIDE the range too
      '11.0.0.1', // OUTSIDE 10.0.0.0/8 boundary
    ])('returns undefined for safe host %s', (host) => {
      expect(classifyInternalHost(host)).toBeUndefined();
    });
  });

  describe('warnSsrfRiskyUri', () => {
    it('emits a warn for an IMDS URI', () => {
      const warns: string[] = [];
      warnSsrfRiskyUri('http://169.254.169.254/latest/meta-data/', 'GET /imds', (m) =>
        warns.push(m)
      );
      expect(warns.length).toBe(1);
      expect(warns[0]).toMatch(/AWS IMDS/);
      expect(warns[0]).toMatch(/GET \/imds/);
    });
    it('emits no warn for a public DNS URI', () => {
      const warns: string[] = [];
      warnSsrfRiskyUri('https://api.example.com/v1/things', 'GET /things', (m) =>
        warns.push(m)
      );
      expect(warns.length).toBe(0);
    });
    it('tolerates {placeholder} path segments without crashing', () => {
      const warns: string[] = [];
      warnSsrfRiskyUri(
        'http://10.0.0.1/users/{userId}',
        'GET /users/{userId}',
        (m) => warns.push(m)
      );
      expect(warns.length).toBe(1);
      expect(warns[0]).toMatch(/RFC1918/);
    });
    it('silently skips malformed URIs (route discovery handles them)', () => {
      const warns: string[] = [];
      warnSsrfRiskyUri('not-a-url', 'GET /broken', (m) => warns.push(m));
      expect(warns.length).toBe(0);
    });
    it('emits a warn for IPv6 loopback', () => {
      const warns: string[] = [];
      warnSsrfRiskyUri('http://[::1]/health', 'GET /health', (m) => warns.push(m));
      expect(warns.length).toBe(1);
      expect(warns[0]).toMatch(/IPv6 loopback/);
    });
  });
});
