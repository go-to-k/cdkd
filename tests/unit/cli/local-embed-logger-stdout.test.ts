import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetEmbedConfig } from 'cdk-local';
import { buildContainerImage } from 'cdk-local/internal';
import { createLocalCommand } from '../../../src/cli/commands/local-invoke.js';
import {
  getLogger,
  releaseStdoutForPayload,
  reserveStdoutForPayload,
} from '../../../src/utils/logger.js';

// go-to-k/cdkd#2429: a line cdk-local logs from INSIDE its own bundle (here
// `buildContainerImage`'s `--no-build` progress line, the same `logger.info`
// path as `Building container image ...`) must honor cdkd's stdout
// reservation once `createLocalCommand` has installed cdkd's logger into the
// embed config. Nothing at the shim boundary is mocked: the line is produced
// by cdk-local's own logger module.
describe("cdk-local's own log lines under cdkd's stdout reservation", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    releaseStdoutForPayload();
    resetEmbedConfig();
    vi.restoreAllMocks();
  });

  it('never writes a cdk-local progress line to stdout while the payload owns it', async () => {
    createLocalCommand();
    reserveStdoutForPayload();
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const cdkOut = mkdtempSync(join(tmpdir(), 'cdkd-2429-'));
    dirs.push(cdkOut);
    // `--no-build` logs its progress line and then looks the tag up; the
    // lookup's outcome (no Docker on the host, or no such image) is not under
    // test.
    await buildContainerImage({ source: { directory: 'asset.x' } } as never, cdkOut, {
      architecture: 'x86_64',
      noBuild: true,
    }).catch(() => undefined);

    const stderrLines = err.mock.calls.map((c) => String(c[0]));
    expect(stderrLines.some((l) => l.includes('Skipping docker build (--no-build)'))).toBe(true);
    expect(info).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(out.mock.calls.map((c) => String(c[0])).join('')).not.toContain('Skipping docker build');
  });

  it('masks a build-arg value on the --verbose docker build line (go-to-k/cdkd#4967)', async () => {
    // Obviously fake: the value only has to be recognisable in the output.
    const SENTINEL = 'FAKE-SENTINEL-NOT-A-SECRET-7f1e';
    const dir = mkdtempSync(join(tmpdir(), 'cdkd-4967-'));
    dirs.push(dir);
    const cdkOut = join(dir, 'cdk.out');
    mkdirSync(join(cdkOut, 'asset.x'), { recursive: true });
    // A fake docker that accepts every call, so the build line is logged and
    // nothing is built.
    const fake = join(dir, 'docker');
    writeFileSync(fake, '#!/bin/sh\nexit 0\n');
    chmodSync(fake, 0o755);
    const savedDocker = process.env['CDK_DOCKER'];
    process.env['CDK_DOCKER'] = fake;

    createLocalCommand();
    const savedLevel = getLogger().getLevel();
    getLogger().setLevel('debug');
    const debug = vi.spyOn(getLogger(), 'debug').mockImplementation(() => undefined);
    const consoleCalls = (['log', 'info', 'debug', 'warn', 'error'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined)
    );
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await buildContainerImage(
        { source: { directory: 'asset.x', dockerBuildArgs: { CDKD_SENTINEL_ARG: SENTINEL } } } as never,
        cdkOut,
        { architecture: 'x86_64' }
      ).catch(() => undefined);

      const debugText = debug.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
      // Positive: the build line WAS logged, with the key and the marker.
      expect(debugText).toContain('--build-arg CDKD_SENTINEL_ARG=***');
      // Negative, across every sink a line could take.
      const everything = [
        debugText,
        ...consoleCalls.flatMap((spy) => spy.mock.calls.map((c) => c.map(String).join(' '))),
        ...stderr.mock.calls.map((c) => String(c[0])),
        ...stdout.mock.calls.map((c) => String(c[0])),
      ].join('\n');
      expect(everything).not.toContain(SENTINEL);
    } finally {
      getLogger().setLevel(savedLevel);
      if (savedDocker === undefined) delete process.env['CDK_DOCKER'];
      else process.env['CDK_DOCKER'] = savedDocker;
    }
  });
});
