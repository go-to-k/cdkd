import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';
import { getDockerCmd } from '../../../src/utils/docker-cmd.js';

describe('getDockerCmd', () => {
  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env['CDK_DOCKER'];
    delete process.env['CDK_DOCKER'];
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env['CDK_DOCKER'];
    else process.env['CDK_DOCKER'] = originalEnv;
  });

  it("returns 'docker' when CDK_DOCKER is unset", () => {
    delete process.env['CDK_DOCKER'];
    expect(getDockerCmd()).toBe('docker');
  });

  it('returns the CDK_DOCKER override when set', () => {
    process.env['CDK_DOCKER'] = 'podman';
    expect(getDockerCmd()).toBe('podman');
  });

  it("treats an empty CDK_DOCKER as unset (falls back to 'docker')", () => {
    process.env['CDK_DOCKER'] = '';
    expect(getDockerCmd()).toBe('docker');
  });

  it('passes nerdctl / finch / lima paths through verbatim', () => {
    process.env['CDK_DOCKER'] = '/opt/homebrew/bin/finch';
    expect(getDockerCmd()).toBe('/opt/homebrew/bin/finch');
  });
});
