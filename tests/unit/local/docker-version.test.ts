/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi } from 'vite-plus/test';
import {
  compareDockerVersions,
  HOST_GATEWAY_MIN_VERSION,
  parseDockerVersion,
  probeHostGatewaySupport,
} from '../../../src/local/docker-version.js';

describe('parseDockerVersion', () => {
  it('parses canonical "<major>.<minor>.<patch>"', () => {
    expect(parseDockerVersion('20.10.21')).toEqual({ major: 20, minor: 10, patch: 21 });
    expect(parseDockerVersion('27.3.1')).toEqual({ major: 27, minor: 3, patch: 1 });
  });
  it('parses "<major>.<minor>" with implicit patch=0', () => {
    expect(parseDockerVersion('24.0')).toEqual({ major: 24, minor: 0, patch: 0 });
  });
  it('strips Docker Desktop / rootless / podman suffixes', () => {
    expect(parseDockerVersion('24.0.7-rd')).toEqual({ major: 24, minor: 0, patch: 7 });
    expect(parseDockerVersion('27.3.1+podman')).toEqual({ major: 27, minor: 3, patch: 1 });
    expect(parseDockerVersion('20.10.21-ce')).toEqual({ major: 20, minor: 10, patch: 21 });
  });
  it('tolerates leading / trailing whitespace', () => {
    expect(parseDockerVersion('  20.10.21\n')).toEqual({ major: 20, minor: 10, patch: 21 });
  });
  it('returns null on unparseable input (podman / finch / nerdctl shapes)', () => {
    expect(parseDockerVersion('')).toBeNull();
    expect(parseDockerVersion('not-a-version')).toBeNull();
    expect(parseDockerVersion('podman version 4.6.1')).toBeNull();
  });
});

describe('compareDockerVersions', () => {
  it('orders by major, then minor, then patch', () => {
    expect(compareDockerVersions({ major: 20, minor: 10, patch: 0 }, { major: 19, minor: 99, patch: 99 })).toBeGreaterThan(0);
    expect(compareDockerVersions({ major: 20, minor: 10, patch: 0 }, { major: 20, minor: 10, patch: 1 })).toBeLessThan(0);
    expect(compareDockerVersions({ major: 20, minor: 10, patch: 0 }, { major: 20, minor: 10, patch: 0 })).toBe(0);
  });
  it('returns positive for newer-than-min versions', () => {
    expect(
      compareDockerVersions({ major: 27, minor: 3, patch: 1 }, HOST_GATEWAY_MIN_VERSION)
    ).toBeGreaterThan(0);
  });
  it('returns negative for older-than-min versions', () => {
    expect(
      compareDockerVersions({ major: 19, minor: 3, patch: 8 }, HOST_GATEWAY_MIN_VERSION)
    ).toBeLessThan(0);
    expect(
      compareDockerVersions({ major: 20, minor: 9, patch: 0 }, HOST_GATEWAY_MIN_VERSION)
    ).toBeLessThan(0);
  });
});

vi.mock('../../../src/utils/docker-cmd.js', () => ({
  runDockerStreaming: vi.fn(),
}));

const dockerCmd = (await import('../../../src/utils/docker-cmd.js')) as unknown as {
  runDockerStreaming: ReturnType<typeof vi.fn>;
};

describe('probeHostGatewaySupport', () => {
  it('returns supported=true for Docker 20.10', async () => {
    dockerCmd.runDockerStreaming.mockResolvedValueOnce({ stdout: '20.10.21\n', stderr: '' });
    const probe = await probeHostGatewaySupport();
    expect(probe).toEqual({
      rawVersion: '20.10.21',
      parsed: { major: 20, minor: 10, patch: 21 },
      supported: true,
    });
  });
  it('returns supported=true for Docker 27+', async () => {
    dockerCmd.runDockerStreaming.mockResolvedValueOnce({ stdout: '27.3.1\n', stderr: '' });
    const probe = await probeHostGatewaySupport();
    expect(probe.supported).toBe(true);
  });
  it('returns supported=false for Docker 19.x (pre-20.10)', async () => {
    dockerCmd.runDockerStreaming.mockResolvedValueOnce({ stdout: '19.03.15\n', stderr: '' });
    const probe = await probeHostGatewaySupport();
    expect(probe.supported).toBe(false);
    expect(probe.parsed).toEqual({ major: 19, minor: 3, patch: 15 });
  });
  it('returns supported=false for Docker 20.9 (just below the bar)', async () => {
    dockerCmd.runDockerStreaming.mockResolvedValueOnce({ stdout: '20.9.0\n', stderr: '' });
    const probe = await probeHostGatewaySupport();
    expect(probe.supported).toBe(false);
  });
  it('returns supported=true with parsed=null for unparseable version strings (podman / finch fallback)', async () => {
    dockerCmd.runDockerStreaming.mockResolvedValueOnce({
      stdout: 'podman version 4.6.1\n',
      stderr: '',
    });
    const probe = await probeHostGatewaySupport();
    expect(probe.parsed).toBeNull();
    expect(probe.supported).toBe(true); // defer to warn path, not hard-fail
    expect(probe.rawVersion).toBe('podman version 4.6.1');
  });
  it('returns supported=false for empty stdout (daemon unreachable / output stripped)', async () => {
    // Surfaced by PR #539 review: pre-fix the empty-stdout case
    // returned `supported=true` (warn-and-pass) because the
    // unparseable-version branch short-circuited before checking for
    // the empty string. Empty stdout from `docker version` is much
    // more likely a broken probe than a real-but-unparseable engine.
    dockerCmd.runDockerStreaming.mockResolvedValueOnce({ stdout: '', stderr: '' });
    const probe = await probeHostGatewaySupport();
    expect(probe.rawVersion).toBe('');
    expect(probe.parsed).toBeNull();
    expect(probe.supported).toBe(false);
  });
  it('returns supported=false for whitespace-only stdout', async () => {
    dockerCmd.runDockerStreaming.mockResolvedValueOnce({ stdout: '   \n  ', stderr: '' });
    const probe = await probeHostGatewaySupport();
    expect(probe.rawVersion).toBe('');
    expect(probe.supported).toBe(false);
  });
  it('lets a docker subprocess failure bubble up unchanged (binary missing / daemon down)', async () => {
    const fakeErr = new Error('Failed to find and execute \'docker\'');
    dockerCmd.runDockerStreaming.mockRejectedValueOnce(fakeErr);
    await expect(probeHostGatewaySupport()).rejects.toThrow(/Failed to find and execute/);
  });
});
