import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

/**
 * `src/local/rie-mount.ts` (issue #6018): how a container-image Lambda is run
 * under a mounted Lambda RIE, and how the binary is obtained and cached. The
 * docker CLI is mocked: `cp` writes a fake ELF whose `e_machine` the test picks.
 */

const h = vi.hoisted(() => ({
  docker: vi.fn(),
  warns: [] as string[],
}));

vi.mock('../../../src/utils/docker-cmd.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  runDockerStreaming: h.docker,
}));
vi.mock('../../../src/utils/logger.js', async (importOriginal) => {
  const log = {
    debug: () => {},
    info: () => {},
    warn: (m: string) => h.warns.push(m),
    error: () => {},
  };
  return {
    ...(await importOriginal<object>()),
    getLogger: () => ({ ...log, child: () => log }),
  };
});

import { RIE_CONTAINER_PATH, RIE_SOURCE_IMAGE } from '../../../src/local/rie-mount.js';

type RieMount = typeof import('../../../src/local/rie-mount.js');
/** A FRESH module per case: its single-flight map and warn-once latch start cold. */
let ensureRieBinary: RieMount['ensureRieBinary'];
let resolveRieWrap: RieMount['resolveRieWrap'];
let rieCacheDirectory: RieMount['rieCacheDirectory'];

const EM_X86_64 = 62;
const EM_AARCH64 = 183;

function fakeElf(machine: number): Buffer {
  const b = Buffer.alloc(64);
  b.writeUInt32BE(0x7f454c46, 0);
  b.writeUInt16LE(machine, 18);
  return b;
}

let cacheHome: string;
let savedXdg: string | undefined;
/** The image config `docker image inspect` answers with. */
let imageConfig: unknown;
/** The ELF machine `docker cp` writes. */
let copiedMachine: number;

function verbs(): string[] {
  return h.docker.mock.calls.map((c) => (c[0] as string[]).slice(0, 2).join(' '));
}

beforeEach(async () => {
  vi.resetModules();
  ({ ensureRieBinary, resolveRieWrap, rieCacheDirectory } = await import(
    '../../../src/local/rie-mount.js'
  ));
  h.warns.length = 0;
  h.docker.mockReset();
  cacheHome = mkdtempSync(join(tmpdir(), 'cdkd-rie-'));
  savedXdg = process.env['XDG_CACHE_HOME'];
  process.env['XDG_CACHE_HOME'] = cacheHome;
  imageConfig = { Entrypoint: ['/app'], Cmd: ['serve'] };
  copiedMachine = EM_X86_64;
  h.docker.mockImplementation(async (args: string[]) => {
    switch (args[0]) {
      case 'image':
        return { stdout: `${JSON.stringify(imageConfig)}\n`, stderr: '' };
      case 'create':
        return { stdout: 'cid123\n', stderr: '' };
      case 'cp':
        writeFileSync(args[2]!, fakeElf(copiedMachine));
        return { stdout: '', stderr: '' };
      default:
        return { stdout: '', stderr: '' };
    }
  });
});

afterEach(() => {
  if (savedXdg === undefined) delete process.env['XDG_CACHE_HOME'];
  else process.env['XDG_CACHE_HOME'] = savedXdg;
  rmSync(cacheHome, { recursive: true, force: true });
});

const cached = (platform: string): string =>
  join(cacheHome, 'cdkd', 'lambda-rie', platform.replace('/', '-'), 'aws-lambda-rie');

describe('resolveRieWrap', () => {
  it("wraps the image's own Entrypoint + Cmd when ImageConfig sets neither", async () => {
    const wrap = await resolveRieWrap({ image: 'img:1', platform: 'linux/amd64' });
    expect(wrap).toEqual({
      mount: { hostPath: cached('linux/amd64'), containerPath: RIE_CONTAINER_PATH, readOnly: true },
      entryPoint: [RIE_CONTAINER_PATH],
      cmd: ['/app', 'serve'],
    });
    expect(h.docker.mock.calls[0]![0]).toEqual([
      'image',
      'inspect',
      '--format',
      '{{json .Config}}',
      'img:1',
    ]);
  });

  it('ImageConfig.Command replaces only the Cmd; the image Entrypoint stays', async () => {
    const wrap = await resolveRieWrap({
      image: 'img:1',
      platform: 'linux/amd64',
      command: ['app.handler'],
    });
    expect(wrap?.cmd).toEqual(['/app', 'app.handler']);
  });

  it('ImageConfig.EntryPoint replaces only the Entrypoint; the image Cmd stays', async () => {
    const wrap = await resolveRieWrap({
      image: 'img:1',
      platform: 'linux/amd64',
      entryPoint: ['/bin/other', '-x'],
    });
    expect(wrap?.cmd).toEqual(['/bin/other', '-x', 'serve']);
  });

  it('empty ImageConfig arrays mean "the image\'s own", and both set skips the inspect', async () => {
    expect(
      (await resolveRieWrap({ image: 'i', platform: 'linux/amd64', entryPoint: [], command: [] }))
        ?.cmd
    ).toEqual(['/app', 'serve']);
    h.docker.mockClear();
    const wrap = await resolveRieWrap({
      image: 'i',
      platform: 'linux/amd64',
      entryPoint: ['/e'],
      command: ['c'],
    });
    expect(wrap?.cmd).toEqual(['/e', 'c']);
    expect(verbs()).not.toContain('image inspect');
  });

  it('a null Entrypoint / Cmd in the image config contributes nothing', async () => {
    imageConfig = { Entrypoint: null, Cmd: ['/bootstrap'] };
    expect((await resolveRieWrap({ image: 'i', platform: 'linux/amd64' }))?.cmd).toEqual([
      '/bootstrap',
    ]);
  });

  it('does not wrap an image whose effective entrypoint already IS an RIE', async () => {
    imageConfig = { Entrypoint: ['/usr/local/bin/aws-lambda-rie'], Cmd: ['/app'] };
    expect(await resolveRieWrap({ image: 'i', platform: 'linux/amd64' })).toBeUndefined();
    expect(
      await resolveRieWrap({
        image: 'i',
        platform: 'linux/amd64',
        entryPoint: ['/opt/aws-lambda-rie', '/app'],
      })
    ).toBeUndefined();
    expect(verbs()).not.toContain('create');
    expect(h.warns).toEqual([]);
  });

  it('wraps an AWS base image too (its entrypoint script is not the RIE)', async () => {
    imageConfig = { Entrypoint: ['/lambda-entrypoint.sh'], Cmd: ['app.handler'] };
    expect((await resolveRieWrap({ image: 'i', platform: 'linux/amd64' }))?.cmd).toEqual([
      '/lambda-entrypoint.sh',
      'app.handler',
    ]);
  });

  it('falls back to undefined and warns ONCE when the binary cannot be obtained', async () => {
    h.docker.mockImplementation(async (args: string[]) => {
      if (args[0] === 'image') return { stdout: JSON.stringify(imageConfig), stderr: '' };
      throw Object.assign(new Error('pull denied'), { exitCode: 1, stderr: 'denied', stdout: '' });
    });
    expect(await resolveRieWrap({ image: 'a', platform: 'linux/amd64' })).toBeUndefined();
    expect(await resolveRieWrap({ image: 'b', platform: 'linux/arm64' })).toBeUndefined();
    expect(h.warns).toHaveLength(1);
    expect(h.warns[0]).toMatch(/Could not mount the Lambda Runtime Interface Emulator/);
    expect(h.warns[0]).toMatch(/docker pull failed/);
  });

  it('falls back when the image config cannot be inspected', async () => {
    h.docker.mockRejectedValue(Object.assign(new Error('no such image'), { exitCode: 1 }));
    expect(await resolveRieWrap({ image: 'gone', platform: 'linux/amd64' })).toBeUndefined();
    expect(h.warns).toHaveLength(1);
  });
});

describe('ensureRieBinary', () => {
  it('extracts from the AWS base image for the platform, chmods 0755, and removes the container', async () => {
    copiedMachine = EM_AARCH64;
    const path = await ensureRieBinary('linux/arm64', false);
    expect(path).toBe(cached('linux/arm64'));
    expect(h.docker.mock.calls.map((c) => c[0])).toEqual([
      ['pull', '--platform', 'linux/arm64', RIE_SOURCE_IMAGE],
      ['create', '--platform', 'linux/arm64', RIE_SOURCE_IMAGE],
      ['cp', 'cid123:/usr/local/bin/aws-lambda-rie', expect.any(String)],
      ['rm', '-f', 'cid123'],
    ]);
    expect(statSync(path).mode & 0o777).toBe(0o755);
    expect(readFileSync(path).readUInt16LE(18)).toBe(EM_AARCH64);
  });

  it('--no-pull skips the pull but still copies from a locally cached base image', async () => {
    await ensureRieBinary('linux/amd64', true);
    expect(verbs()).toEqual(['create --platform', 'cp cid123:/usr/local/bin/aws-lambda-rie', 'rm -f']);
  });

  it('reuses a cached binary of the right architecture without touching docker', async () => {
    mkdirSync(dirname(cached('linux/amd64')), { recursive: true });
    writeFileSync(cached('linux/amd64'), fakeElf(EM_X86_64));
    expect(await ensureRieBinary('linux/amd64', false)).toBe(cached('linux/amd64'));
    expect(h.docker).not.toHaveBeenCalled();
  });

  it('re-extracts over a cached file of the WRONG architecture', async () => {
    mkdirSync(dirname(cached('linux/amd64')), { recursive: true });
    writeFileSync(cached('linux/amd64'), fakeElf(EM_AARCH64));
    await ensureRieBinary('linux/amd64', false);
    expect(verbs()).toContain('create --platform');
    expect(readFileSync(cached('linux/amd64')).readUInt16LE(18)).toBe(EM_X86_64);
  });

  it('refuses a copied binary that is not for the requested platform and leaves no file', async () => {
    copiedMachine = EM_AARCH64;
    await expect(ensureRieBinary('linux/amd64', false)).rejects.toThrow(
      /not a linux\/amd64 executable/
    );
    expect(() => statSync(cached('linux/amd64'))).toThrow();
    expect(verbs()).toContain('rm -f');
  });

  it('extracts once for concurrent callers of one platform', async () => {
    await Promise.all([
      ensureRieBinary('linux/amd64', false),
      ensureRieBinary('linux/amd64', false),
    ]);
    expect(verbs().filter((v) => v === 'create --platform')).toHaveLength(1);
  });

  it('retries after a failed extraction instead of memoizing the failure', async () => {
    h.docker.mockRejectedValueOnce(Object.assign(new Error('offline'), { exitCode: 1 }));
    await expect(ensureRieBinary('linux/amd64', false)).rejects.toThrow(/docker pull failed/);
    await expect(ensureRieBinary('linux/amd64', false)).resolves.toBe(cached('linux/amd64'));
  });

  it('refuses an unknown platform', async () => {
    await expect(ensureRieBinary('linux/riscv64', false)).rejects.toThrow(/unsupported platform/);
  });
});

describe('rieCacheDirectory', () => {
  it('sits under the cdkd cache home, never the temp root', () => {
    expect(rieCacheDirectory({ XDG_CACHE_HOME: '/x/cache' })).toBe('/x/cache/cdkd/lambda-rie');
    expect(rieCacheDirectory({ XDG_CACHE_HOME: 'relative' })).not.toMatch(/^relative/);
  });
});
