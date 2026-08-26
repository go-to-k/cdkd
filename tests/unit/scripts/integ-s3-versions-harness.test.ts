import { describe, it, expect, beforeAll, afterAll } from 'vite-plus/test';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  chmodSync,
  readdirSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

/**
 * The fake-AWS HARNESS for `tests/integration/s3-versions.sh` (issue #2106).
 *
 * SIBLING FILE, and the split is deliberate. `integ-s3-versions-helper.test.ts`
 * covers the one class that needs no AWS stand-in at all -- the prefix guard --
 * and pins the STRONGER property there: that the guard fires BEFORE any AWS
 * call, via a fake `aws` that records its own invocation. Its docstring names
 * everything else as "its own piece of infrastructure ... tracked separately in
 * issue #2106". This file is that infrastructure. Where the two touch the same
 * prefixes, THAT file owns "no request was issued" and this one owns "and
 * nothing was deleted"; neither is a copy of the other.
 *
 * The helper is sourced by sixteen fixtures and is the only shared shell code
 * in the tree, yet nothing in CI ever RAN it: `integ-verify-bash-compat` is a
 * static bash-4-ism scan and `bash -n` only parses. Its three documented traps
 * are all SILENT PARTIAL sweeps -- the run still exits 0 and the script still
 * reads as if it cleaned up -- so review was the only thing standing behind
 * them. That is the same shape as the bug the helper exists to prevent: the
 * sweep regressed silently because nothing asserted the result.
 *
 * HOW THIS WORKS. A fake `aws` is put on PATH, backed by a local JSON version
 * store, and the real helper is sourced by a bash driver under `/bin/bash`
 * (3.2 on macOS -- the version the bash-compat lint exists for). The fake
 * replays `ListObjectVersions` response SHAPES with a configurable page size
 * and an injectable list failure.
 *
 * THE FAKE MUST APPLY `--query` PER PAGE. That is not a detail: trap 3 IS the
 * AWS CLI's per-page application of `--query`, so a fake that applies the query
 * once to a concatenated result makes trap 3 unreachable and the probe for it
 * vacuous.
 *
 * FIDELITY OF THE FAKE IS PINNED TO REAL-AWS MEASUREMENTS, not assumed. The
 * helper's own header records four numbers taken against the real bucket on
 * 2026-08-20 over a 1189-entry multi-page prefix (all 1189 / noncurrent 1064 /
 * latest-only 125) plus the `1000\n189` two-line output that `length(...)`
 * produces under `--output text`, and the observation that the UNparenthesised
 * `[Versions, DeleteMarkers][][?...]` form reports 0 where the parenthesised
 * one reports 347. The `reproduces the real-AWS measurements` test below
 * replays all of those against the fake.
 *
 * HERMETICITY. `childEnv` builds the child environment from an ALLOW-LIST
 * rather than inheriting the caller's. Every pinned variable is READ BACK from
 * inside a real child and asserted by value, so deleting any one of them from
 * `childEnv` fails by name; three of them (PATH, HOME/BASH_ENV/ENV, and the
 * AWS_* omission) additionally carry an adversarial probe that plants a decoy
 * `aws`, a hostile `.bashrc`, and `AWS_DEFAULT_OUTPUT=yaml`. The by-value
 * assertions came second: an earlier round CLAIMED each pin was probed when
 * only PATH and TMPDIR were load-bearing.
 *
 * THE AXES, and each one's disposition -- written down because this file's own
 * hermeticity fence was broken twice by an axis nobody had enumerated (a shell
 * whose diagnostics are worded differently, then a process supervisor):
 *
 *   shell identity/version  RECEIPT only; no assertion reads a diagnostic's
 *                           WORDING, because that is the shell's to choose.
 *   PATH / HOME / TMPDIR    PINNED, read back by value, adversarially probed.
 *   BASH_ENV / ENV          PINNED empty (both rc hooks a non-interactive
 *                           shell honours).
 *   LC_ALL / LANG / TZ      PINNED; locale also decides the LANGUAGE of the
 *                           shell's diagnostics.
 *   cwd                     PINNED to the workdir.
 *   AWS_*                   NOT forwarded, asserted STRICTLY (no control
 *                           subtraction) -- it is the family that changes what
 *                           the helper does.
 *   jq / python3 / date     MEASURED NEGATIVE: the helper uses none.
 *   clock                   MEASURED NEGATIVE: the helper reads none.
 *   PROCESS SUPERVISOR      OUT OF SCOPE BY CONSTRUCTION. A sandbox, debugger
 *                           or profiler injects into every spawned child AFTER
 *                           `childEnv` has run (observed: DYLD_INSERT_LIBRARIES,
 *                           FSPY_PAYLOAD, __CF_USER_TEXT_ENCODING). No
 *                           env-building function can prevent that, so the leak
 *                           check subtracts a CONTROL spawn instead of naming
 *                           them -- see `leakedNames`.
 *   filesystem layout       ASSUMED, not pinned: `/bin/bash`, `/usr/bin`,
 *                           `/bin`. Stated rather than fenced; a distro that
 *                           puts them elsewhere fails loudly at the first
 *                           spawn rather than silently. A mocked test that agrees with a wrong
 * wire assumption is worth nothing, so the fake is calibrated against what was
 * actually observed rather than against what the query looks like it should do.
 */

const INTEG_ROOT = join(import.meta.dirname, '../../../tests/integration');
const HELPER_PATH = join(INTEG_ROOT, 's3-versions.sh');
/**
 * The system bash, pinned. macOS ships 3.2 and that is the floor the helper
 * has to clear; running this under a Homebrew bash 5 would let a 4-ism through
 * exactly where it matters least to catch it.
 */
const BASH = '/bin/bash';

/**
 * The multi-page cases spawn a real bash plus a fake-`aws` node process per
 * LIST, and the 1189-entry / page-size-sweep cases do that many times over.
 * They land around 5 s, i.e. straddling vitest's 5 s default, which showed up
 * as the same test passing and failing on alternate runs. Given a real budget
 * rather than trimmed: the cases are what pin the fake to the measured
 * real-AWS numbers, so shrinking them to fit a timeout would be trading the
 * evidence for the clock.
 */
const slowIt = (name: string, fn: () => void): void => {
  it(name, fn, 120_000);
};

/** One entry in the fake bucket's version listing. */
interface StoreObject {
  Key: string;
  VersionId: string | null;
  IsLatest: boolean;
  IsDeleteMarker: boolean;
}

interface Store {
  objects: StoreObject[];
  /** Emulates the CLI's auto-pagination page size. */
  pageSize: number;
  /** 1-based index of the list call that must fail, or 0 for none. */
  failListOnCall: number;
  /** Keys that DeleteObjects reports as per-object failures (Quiet mode). */
  perObjectErrorKeys: string[];
  listCalls: number;
  /** Every deletion the helper actually REQUESTED, in order. */
  deleteCalls: { op: string; Key: string; VersionId: string }[];
  /** Keys whose single-object `delete-object` must fail. */
  failDeleteObjectKeys: string[];
}

const FAKE_AWS = `#!/usr/bin/env node
// Fake \`aws\` for the s3-versions.sh harness. Emulates ONLY the calls the
// helper makes, and emulates the CLI behaviours the helper's traps are about:
// per-page --query application, text output, and the flatten-projection quirk.
'use strict';
const { readFileSync, writeFileSync } = require('node:fs');

const STORE = process.env.S3V_STORE;
const argv = process.argv.slice(2);

function die(msg, code) {
  process.stderr.write(msg + '\\n');
  process.exit(code);
}
function loadStore() {
  return JSON.parse(readFileSync(STORE, 'utf8'));
}
function saveStore(s) {
  writeFileSync(STORE, JSON.stringify(s, null, 2));
}
function flag(name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

// --- a JMESPath subset covering exactly the shapes this helper emits -------
// Plus the BROKEN twins the mutation probes need, so a probe can reintroduce a
// trap and be seen to fail.
function evalPred(pred, o) {
  return pred.split('&&').every(function (partRaw) {
    const part = partRaw.trim();
    let m = /^Key\\s*==\\s*'([^']*)'$/.exec(part);
    if (m) return o.Key === m[1];
    m = /^IsLatest\\s*==\\s*\\x60(true|false)\\x60$/.exec(part);
    if (m) return Boolean(o.IsLatest) === (m[1] === 'true');
    throw new Error('fake-aws: unsupported predicate: ' + part);
  });
}

function evalList(exprRaw, resp) {
  const expr = exprRaw.trim();
  let parenthesised = false;
  let m = /^\\(\\s*\\[Versions,\\s*DeleteMarkers\\]\\[\\]\\s*\\)([\\s\\S]*)$/.exec(expr);
  if (m) {
    parenthesised = true;
  } else {
    m = /^\\[Versions,\\s*DeleteMarkers\\]\\[\\]([\\s\\S]*)$/.exec(expr);
    if (!m) throw new Error('fake-aws: unsupported query: ' + expr);
  }
  let tail = m[1].trim();
  // \`[Versions, DeleteMarkers]\` builds a two-element list; a key AWS omitted
  // yields null there, and the \`[]\` flatten drops it.
  let items = [].concat(resp.Versions || [], resp.DeleteMarkers || []);

  const fm = /^\\[\\?([^\\]]*)\\]([\\s\\S]*)$/.exec(tail);
  if (fm) {
    tail = fm[2].trim();
    if (parenthesised) {
      items = items.filter(function (o) {
        return evalPred(fm[1], o);
      });
    } else {
      // MEASURED, not inferred: the helper's header records that the
      // unparenthesised flatten projection SWALLOWS the filter -- the CLI
      // reported 0 where the parenthesised form reported 347. Reproducing the
      // observation is what makes the parentheses testable.
      items = [];
    }
  }
  const flat = /^\\[\\]([\\s\\S]*)$/.exec(tail);
  if (flat) tail = flat[1].trim();

  if (tail === '.[Key,VersionId]' || tail === '.[Key, VersionId]') {
    return items.map(function (o) {
      return [o.Key, o.VersionId];
    });
  }
  if (tail === '') return items;
  throw new Error('fake-aws: unsupported query tail: ' + tail);
}

function evalQuery(query, page) {
  const versions = page.filter(function (o) {
    return !o.IsDeleteMarker;
  });
  const markers = page.filter(function (o) {
    return o.IsDeleteMarker;
  });
  // AWS OMITS the key entirely when the list is empty; that omission is what
  // the \`[]\` flatten has to cope with, so do not emit empty arrays.
  const resp = {};
  if (versions.length) resp.Versions = versions;
  if (markers.length) resp.DeleteMarkers = markers;

  const lm = /^length\\(([\\s\\S]*)\\)$/.exec(query.trim());
  if (lm) return { kind: 'scalar', value: evalList(lm[1], resp).length };
  return { kind: 'rows', value: evalList(query, resp) };
}

function chunk(arr, size) {
  if (arr.length === 0) return [[]];
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

const service = argv[0];
const verb = argv[1];
if (service !== 's3api') die('fake-aws: unsupported service ' + String(service), 2);

if (verb === 'list-object-versions') {
  const store = loadStore();
  store.listCalls = (store.listCalls || 0) + 1;
  saveStore(store);
  // KNOWN DIVERGENCE, recorded rather than emulated. The real CLI streams
  // page 1's rows to stdout and THEN exits non-zero when page 2 fails; this
  // fake dies before emitting anything. The helper treats both identically --
  // \`_s3v_rows\` captures stdout in a command substitution and discards it
  // whenever the exit status is non-zero, so partial output cannot reach the
  // delete path either way. Emulating the flush would add a second path to the
  // fake and change nothing it can detect.
  if (store.failListOnCall && store.listCalls === store.failListOnCall) {
    die(
      'An error occurred (SlowDown) when calling the ListObjectVersions operation: Please reduce your request rate.',
      254
    );
  }
  const prefix = flag('--prefix') || '';
  const query = flag('--query');
  const output = flag('--output');
  if (output !== 'text') {
    die('fake-aws: list-object-versions is only emulated for --output text (got ' + String(output) + ')', 2);
  }
  const matched = store.objects.filter(function (o) {
    return o.Key.indexOf(prefix) === 0;
  });
  // PER PAGE -- this is trap 3. Do not hoist the query out of this loop.
  const lines = [];
  chunk(matched, store.pageSize || 1000).forEach(function (page) {
    const r = evalQuery(query, page);
    if (r.kind === 'scalar') {
      lines.push(String(r.value));
    } else {
      r.value.forEach(function (row) {
        lines.push(
          row
            .map(function (v) {
              return v === null || v === undefined ? 'None' : String(v);
            })
            .join('\\t')
        );
      });
    }
  });
  // NOT \`process.exit(0)\` -- Node does not flush an async pipe write before
  // exiting, and a 2300-row listing came back TRUNCATED to 1515 rows. Top-level
  // \`return\` is valid in a CJS module and lets the stream drain.
  if (lines.length) process.stdout.write(lines.join('\\n') + '\\n');
  process.exitCode = 0;
  return;
}

if (verb === 'delete-objects') {
  const store = loadStore();
  if (flag('--output') !== 'json') {
    die('fake-aws: delete-objects must pin --output json (got ' + String(flag('--output')) + ')', 2);
  }
  const body = JSON.parse(flag('--delete'));
  const errors = [];
  // RECORD every requested deletion, before any filtering. Without this the
  // "skips a None version id" case could not tell "the helper refused to ask"
  // from "the store had nothing to remove" -- the fake dropped the row either
  // way, so deleting the helper's guard left the test green.
  store.deleteCalls = (store.deleteCalls || []).concat(
    body.Objects.map(function (o) {
      return { op: 'delete-objects', Key: o.Key, VersionId: String(o.VersionId) };
    })
  );
  body.Objects.forEach(function (o) {
    if ((store.perObjectErrorKeys || []).indexOf(o.Key) >= 0) {
      errors.push({ Key: o.Key, VersionId: o.VersionId, Code: 'AccessDenied' });
      return;
    }
    store.objects = store.objects.filter(function (v) {
      return !(v.Key === o.Key && String(v.VersionId) === String(o.VersionId));
    });
  });
  saveStore(store);
  // Quiet:true -> a fully successful call returns {} and lists ONLY failures.
  process.stdout.write(errors.length ? JSON.stringify({ Errors: errors }) + '\\n' : '{}\\n');
  process.exitCode = 0;
  return;
}

if (verb === 'delete-object') {
  const store = loadStore();
  const key = flag('--key');
  const vid = flag('--version-id');
  if ((store.failDeleteObjectKeys || []).indexOf(key) >= 0) {
    die('An error occurred (AccessDenied) when calling the DeleteObject operation', 254);
  }
  store.deleteCalls = (store.deleteCalls || []).concat([
    { op: 'delete-object', Key: key, VersionId: String(vid) },
  ]);
  store.objects = store.objects.filter(function (v) {
    return !(v.Key === key && String(v.VersionId) === String(vid));
  });
  saveStore(store);
  process.stdout.write('{}\\n');
  process.exitCode = 0;
  return;
}

die('fake-aws: unsupported verb ' + String(verb), 2);
`;

/**
 * Drives one helper function with the fake `aws` on PATH.
 *
 * `s3_assert_versions_swept` terminates the shell with `exit 1`, so the
 * PROCESS exit code is the source of truth rather than an echoed marker line.
 */
const DRIVER = `#!/bin/bash
set -u
. "\${HELPER}"
op="\$1"; shift
case "\${op}" in
  count)     s3_count_versions "\${BUCKET}" "\$1" "\${2:-all}" ;;
  purge)     s3_purge_prefix_versions "\${BUCKET}" "\$1" "\${2:-all}" ;;
  purge_key) s3_purge_key_versions "\${BUCKET}" "\$1" "\${2:-all}" ;;
  count_key) s3_count_key_versions "\${BUCKET}" "\$1" "\${2:-all}" ;;
  assert_key) s3_assert_key_versions_swept "\${BUCKET}" "\$1" "\${2:-noncurrent}" "\${3:-key teardown}" ;;
  assert)    s3_assert_versions_swept "\${BUCKET}" "\$1" "\${2:-teardown}" ;;
  prefix)    s3_stack_prefix "\$1" "\$2" ;;
  *) echo "driver: unknown op \${op}" >&2; exit 99 ;;
esac
`;

let workdir: string;

/**
 * The scratch ROOT.
 *
 * `CDKD_TEST_SCRATCH_DIR` wins when set, because parallel agents share `/tmp`
 * and converge on the same obvious names; a run of this suite lost twelve probe
 * iterations that way. `mkdtempSync` already appends random characters, so the
 * remaining risk is not a name collision but a shared BLAST RADIUS -- one
 * agent's `rm -rf /tmp/cdkd-*` takes another's live run with it. The env var
 * lets each lane point at its own private directory; the default keeps the file
 * portable for anyone running the suite normally. The pid is in the prefix so a
 * leftover directory can be attributed to the run that made it.
 */
const SCRATCH_ROOT = process.env['CDKD_TEST_SCRATCH_DIR'] ?? tmpdir();

beforeAll(() => {
  mkdirSync(SCRATCH_ROOT, { recursive: true });
  workdir = mkdtempSync(join(SCRATCH_ROOT, `cdkd-s3v-${process.pid}-`));
  // RECEIPT. Every artefact this suite writes -- the fake `aws`, the version
  // stores, every mutant helper, and (via TMPDIR below) the helper's own
  // `mktemp` scratch -- lands under this one directory. Printed so a failure
  // naming a path can be traced to the run that produced it.
  process.stdout.write(`[s3-versions harness] scratch dir: ${workdir}\n`);
  mkdirSync(join(workdir, 'bin'), { recursive: true });
  writeFileSync(join(workdir, 'fake-aws.cjs'), FAKE_AWS);
  // A shim rather than a shebang'd .cjs, so PATH lookup finds a file literally
  // named `aws` the way the helper invokes it.
  writeFileSync(
    join(workdir, 'bin', 'aws'),
    `#!/bin/sh\nexec "${process.execPath}" "${join(workdir, 'fake-aws.cjs')}" "$@"\n`
  );
  chmodSync(join(workdir, 'bin', 'aws'), 0o755);
  writeFileSync(join(workdir, 'driver.sh'), DRIVER);
});

afterAll(() => {
  if (workdir) rmSync(workdir, { recursive: true, force: true });
});

let storeSeq = 0;

function writeStore(objects: StoreObject[], opts: Partial<Store> = {}): string {
  const path = join(workdir, `store-${storeSeq++}.json`);
  const store: Store = {
    objects,
    pageSize: opts.pageSize ?? 1000,
    failListOnCall: opts.failListOnCall ?? 0,
    perObjectErrorKeys: opts.perObjectErrorKeys ?? [],
    listCalls: 0,
    deleteCalls: [],
    failDeleteObjectKeys: opts.failDeleteObjectKeys ?? [],
  };
  writeFileSync(path, JSON.stringify(store, null, 2));
  return path;
}

function readStore(path: string): Store {
  return JSON.parse(readFileSync(path, 'utf8')) as Store;
}

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

/**
 * The child environment, built from an ALLOW-LIST rather than by spreading
 * `process.env`.
 *
 * Spreading is what let the ambient environment reach the shell, and this file
 * had already been bitten once on an axis that was invisible from where it was
 * written (see the trap-3 case). An allow-list makes each axis a deliberate,
 * greppable decision instead of a default:
 *
 *   PATH      the fake `aws` FIRST, then only /usr/bin:/bin. The ambient PATH
 *             is dropped entirely, so a user-installed real `aws` -- or a
 *             shimmed `awk` / `mktemp`, both of which the helper uses -- cannot
 *             win. Keeping the system dirs is what makes "the fake was reached"
 *             mean something rather than being an artefact of a stripped PATH.
 *   HOME      the workdir, which is empty. A shell that reads dotfiles on
 *             startup then finds none, so no user rc can define an `aws`
 *             function or change `IFS`.
 *   BASH_ENV  emptied: bash sources it for NON-interactive shells, which is
 *   ENV       exactly what this is. `ENV` is the ksh/POSIX spelling of the
 *             same hole. Emptied rather than unset so an inherited value
 *             cannot survive.
 *   TMPDIR    the workdir, so the helper's own `mktemp` stderr files land in
 *             this run's scratch dir instead of the shared /tmp.
 *   LC_ALL    pinned to C. Locale changes collation and numeric formatting,
 *   LANG      and it changes the LANGUAGE of the shell's own diagnostics --
 *             which is the same class as the trap-3 wording failure.
 *   TZ        pinned to UTC. The helper reads no clock (asserted below), so
 *             this is belt-and-braces rather than load-bearing.
 *   AWS_*     nothing is forwarded. Credentials, region, profile and above all
 *             `AWS_DEFAULT_OUTPUT` are ambient, and the helper's header says
 *             the `--output` pins exist because of that last one. The
 *             `ambient AWS_* cannot change the helper's behaviour` case below
 *             asserts the pin by feeding a hostile value deliberately.
 */
/**
 * Names that reached the child and can only have come from the PARENT.
 *
 * THE PROPERTY, stated because the next reader will otherwise "tighten" this
 * back into an exact-match assertion. `childEnv` exists so the helper cannot
 * read the PARENT PROCESS's own state -- its AWS credentials and region, its
 * `HOME`, its shell rc hooks, its locale, its `TMPDIR`. It does NOT exist to
 * stop a debugger, a profiler or a sandbox from instrumenting a child; that is
 * outside any env-building function's control and always will be.
 *
 * So the question is not "is the child's environment exactly the allow-list"
 * (it never is: macOS Core Foundation adds `__CF_USER_TEXT_ENCODING`, and an
 * agent sandbox adds `DYLD_INSERT_LIBRARIES` + its tracer payload, AFTER this
 * function has built its object). The question is "did anything the PARENT
 * carries get through". A CONTROL spawn answers it without naming anybody:
 * whatever the platform injects appears in a child spawned with a minimal
 * environment too, so subtracting the control removes every such name by
 * construction -- including ones that do not exist yet.
 *
 * An ignore-list of the three names observed in 2026-08 would have been the
 * spelling-not-property move: the next supervisor injects a different name and
 * the fence goes quiet.
 */
function leakedNames(
  actual: readonly string[],
  control: readonly string[],
  allowed: ReadonlySet<string>
): string[] {
  const platform = new Set(control);
  return actual.filter((n) => n !== '' && !platform.has(n) && !allowed.has(n)).sort();
}

/**
 * The DECLARED pin contract.
 *
 * Separate from `childEnv` on purpose. The leak check below must not take its
 * allow-list from the function it is testing: derived that way, anything
 * `childEnv` emits is allowed BY CONSTRUCTION, so a `childEnv` that started
 * spreading the parent's environment would put every leaked name into its own
 * allow-list and the check would pass. Measured: with the allow-list derived
 * from `Object.keys(childEnv({}))`, injecting `NVM_DIR` into the returned
 * object was GREEN. Same shape as deriving a population from the defect.
 *
 * So the names live here, the values live in `childEnv`, and
 * `the pin contract and childEnv agree` below fails if the two drift.
 */
const PIN_NAMES = ['PATH', 'HOME', 'TMPDIR', 'BASH_ENV', 'ENV', 'LC_ALL', 'LANG', 'TZ'] as const;

/** Set per call by `run` / `runBash`, plus the names any shell defines itself. */
const NON_PIN_ALLOWED = new Set(['S3V_STORE', 'HELPER', 'BUCKET', 'PWD', 'SHLVL', '_', 'OLDPWD']);

function childEnv(extra: Record<string, string>): Record<string, string> {
  const pins: Record<string, string> = {
    PATH: `${join(workdir, 'bin')}:/usr/bin:/bin`,
    HOME: workdir,
    TMPDIR: workdir,
    BASH_ENV: '',
    ENV: '',
    LC_ALL: 'C',
    LANG: 'C',
    TZ: 'UTC',
  };
  // A per-call extra may NOT shadow a pin. Spreading `...extra` last made the
  // pins overridable per call site, so a pin could be declared here and still
  // not reach the child -- and the read-back test, which drives one call site,
  // would not see it. Making the collision impossible beats asserting the
  // absence of one at every call site.
  for (const k of Object.keys(extra)) {
    if (k in pins) throw new Error(`childEnv: '${k}' would shadow a pinned variable`);
  }
  return { ...pins, ...extra };
}

/** Run `bash -c <snippet>` with the fake `aws` on PATH, same pinned env. */
function runBash(snippet: string, storePath: string, args: string[] = []): RunResult {
  const r = spawnSync(BASH, ['-c', snippet, '_', ...args], {
    env: childEnv({ S3V_STORE: storePath }),
    cwd: workdir,
    encoding: 'utf8',
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function run(storePath: string, args: string[], helper = HELPER_PATH): RunResult {
  const r = spawnSync(BASH, [join(workdir, 'driver.sh'), ...args], {
    env: childEnv({
      S3V_STORE: storePath,
      HELPER: helper,
      BUCKET: 'cdkd-state-000000000000',
    }),
    // Pinned: the driver and the helper are addressed absolutely, but the
    // helper's `mktemp` and any future relative read are not, and vitest's cwd
    // is not something this file should depend on.
    cwd: workdir,
    encoding: 'utf8',
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** `n` noncurrent versions plus one current, under one stack prefix. */
function versions(
  prefix: string,
  file: string,
  n: number,
  opts: { latestIsDeleteMarker?: boolean } = {}
): StoreObject[] {
  const out: StoreObject[] = [];
  for (let i = 0; i < n; i++) {
    out.push({ Key: `${prefix}${file}`, VersionId: `v${i}`, IsLatest: false, IsDeleteMarker: false });
  }
  out.push({
    Key: `${prefix}${file}`,
    VersionId: `v${n}`,
    IsLatest: true,
    IsDeleteMarker: opts.latestIsDeleteMarker ?? false,
  });
  return out;
}

const P = 'cdkd/CdkdExample/us-east-1/';

// ---------------------------------------------------------------------------

describe('s3-versions.sh: the fake aws reproduces the measured real-AWS shapes', () => {
  /**
   * Everything below rests on the fake behaving like the CLI, so the fake is
   * checked against the numbers the helper's header records from real S3
   * BEFORE it is trusted to judge the helper. A negative result needs its own
   * evidence, and so does a positive one.
   */
  const big: StoreObject[] = [];
  for (let i = 0; i < 1064; i++) {
    big.push({ Key: `${P}k${i % 9}.json`, VersionId: `v${i}`, IsLatest: false, IsDeleteMarker: i % 7 === 0 });
  }
  for (let i = 0; i < 125; i++) {
    big.push({ Key: `${P}k${i % 9}.json`, VersionId: `L${i}`, IsLatest: true, IsDeleteMarker: i % 5 === 0 });
  }

  slowIt('counts 1189 all / 1064 noncurrent over a multi-page prefix (header, 2026-08-20)', () => {
    const s = writeStore(big, { pageSize: 1000 });
    expect(run(s, ['count', P, 'all']).stdout.trim()).toBe('1189');
    const s2 = writeStore(big, { pageSize: 1000 });
    expect(run(s2, ['count', P, 'noncurrent']).stdout.trim()).toBe('1064');
    // 1064 + 125 == 1189: the IsLatest axis really does partition the response,
    // so `noncurrent` is not a no-op. If it were, the two counts would agree
    // and every noncurrent-mode assertion in this file would be vacuous.
    expect(1064 + 125).toBe(1189);
  });

  slowIt('is page-size independent for the ROW projection (auto-pagination is relied upon)', () => {
    for (const pageSize of [1, 7, 50, 999, 1000, 5000]) {
      const s = writeStore(big, { pageSize });
      expect(run(s, ['count', P, 'all']).stdout.trim(), `pageSize=${pageSize}`).toBe('1189');
    }
  });

  slowIt('reproduces trap 3: `length(...)` under --output text prints ONE NUMBER PER PAGE', () => {
    // The measured shape was `1000\n189`, not `1189`. This is the CLI
    // behaviour the helper's row-counting exists to avoid, so the fake has to
    // exhibit it or the trap-3 probe below proves nothing.
    const s = writeStore(big, { pageSize: 1000 });
    const r = runBash(
      'aws s3api list-object-versions --bucket b --prefix "$1" --query "length(([Versions, DeleteMarkers][])[])" --output text',
      s,
      [P]
    );
    expect(r.stdout.trim().split('\n')).toEqual(['1000', '189']);
  });

  slowIt('reproduces the QUERY SHAPE finding: the unparenthesised flatten swallows the filter', () => {
    const s = writeStore(big, { pageSize: 1000 });
    const call = (q: string) =>
      runBash(
        'aws s3api list-object-versions --bucket b --prefix "$1" --query "$2" --output text | grep -c . || true',
        s,
        [P, q]
      ).stdout.trim();
    expect(call("([Versions, DeleteMarkers][])[?IsLatest==`false`][].[Key,VersionId]")).toBe('1064');
    expect(call("[Versions, DeleteMarkers][][?IsLatest==`false`][].[Key,VersionId]")).toBe('0');
  });
});

describe('s3-versions.sh: counting and sweeping', () => {
  it('zero versions counts 0 and the assertion passes', () => {
    const s = writeStore([]);
    const c = run(s, ['count', P, 'all']);
    expect(c.status).toBe(0);
    expect(c.stdout.trim()).toBe('0');
    expect(run(writeStore([]), ['assert', P]).status).toBe(0);
  });

  it('ONE version is counted and swept -- the exact off-by-one trap 2 produces', () => {
    // The broken `printf '%s' | while read` form saw 0 of 1 against real S3.
    // A single-version key is therefore the smallest case that discriminates.
    const s = writeStore([{ Key: `${P}state.json`, VersionId: 'v0', IsLatest: true, IsDeleteMarker: false }]);
    expect(run(s, ['count', P, 'all']).stdout.trim()).toBe('1');
    expect(run(s, ['purge', P, 'all']).status).toBe(0);
    expect(readStore(s).objects).toEqual([]);
  });

  slowIt('many versions across several keys are swept to zero', () => {
    const objs = [
      ...versions(P, 'state.json', 40),
      ...versions(P, 'lock.json', 60),
      ...versions(P, 'rollback-journal.json', 3),
      ...versions(P, 'deployments/index.json', 5),
    ];
    const s = writeStore(objs, { pageSize: 1000 });
    expect(run(s, ['count', P, 'all']).stdout.trim()).toBe(String(objs.length));
    expect(run(s, ['purge', P, 'all']).status).toBe(0);
    expect(readStore(s).objects).toEqual([]);
    expect(run(s, ['assert', P]).status).toBe(0);
  });

  slowIt('sweeps across a FORCED page boundary (batching + pagination interact)', () => {
    // 2300 entries at pageSize 50 is 46 list pages, and the delete batcher
    // flushes at 1000, so this crosses both boundaries in one run.
    const objs = versions(P, 'state.json', 2299);
    const s = writeStore(objs, { pageSize: 50 });
    expect(run(s, ['count', P, 'all']).stdout.trim()).toBe('2300');
    expect(run(s, ['purge', P, 'all']).status).toBe(0);
    expect(readStore(s).objects).toEqual([]);
  });

  it('the noncurrent/all split leaves the CURRENT entry alone, and `all` takes it', () => {
    const objs = versions(P, 'state.json', 5);
    const sn = writeStore(objs, {});
    expect(run(sn, ['count', P, 'noncurrent']).stdout.trim()).toBe('5');
    expect(run(sn, ['purge', P, 'noncurrent']).status).toBe(0);
    // The live state.json survives -- this is what makes `noncurrent` safe to
    // call from a cleanup that cannot know whether the run failed.
    expect(readStore(sn).objects).toEqual([
      { Key: `${P}state.json`, VersionId: 'v5', IsLatest: true, IsDeleteMarker: false },
    ]);
    // ...and it is exactly why a noncurrent sweep must NOT be the last word:
    // the zero-assertion still fails, because something survives.
    expect(run(sn, ['assert', P]).status).toBe(1);

    const sa = writeStore(objs, {});
    expect(run(sa, ['purge', P, 'all']).status).toBe(0);
    expect(readStore(sa).objects).toEqual([]);
  });

  it('DELETE-MARKER-LATEST: `all` removes the marker a noncurrent sweep would strand', () => {
    // After `aws s3 rm` the DELETE MARKER is the entry carrying IsLatest==true.
    // A noncurrent-only sweep leaves one marker per key behind FOREVER and the
    // zero-assertion then never passes -- the helper's mode comment says so,
    // and this is that sentence made executable.
    const objs = versions(P, 'state.json', 4, { latestIsDeleteMarker: true });
    const sn = writeStore(objs, {});
    expect(run(sn, ['purge', P, 'noncurrent']).status).toBe(0);
    const left = readStore(sn).objects;
    expect(left).toHaveLength(1);
    expect(left[0]!.IsDeleteMarker).toBe(true);
    expect(run(sn, ['assert', P]).status).toBe(1);
    expect(run(sn, ['assert', P]).stderr).toContain('delete marker(s) survive');

    const sa = writeStore(objs, {});
    expect(run(sa, ['purge', P, 'all']).status).toBe(0);
    expect(readStore(sa).objects).toEqual([]);
    expect(run(sa, ['assert', P]).status).toBe(0);
  });

  it('skips `None` (an ABSENT id) but deletes the literal "null" version', () => {
    // TWO different things that look alike, and the helper must treat them
    // differently:
    //   `None`  is the AWS CLI's TEXT rendering of an ABSENT JMESPath key. It
    //           is not an id, and `list-object-versions` never produces one for
    //           a real entry -- handing it to `delete-object --version-id None`
    //           would be a malformed request.
    //   "null"  is a REAL version id: the one S3 assigns to an object written
    //           while versioning was suspended. It must be deleted like any
    //           other, and it is what real S3 actually emits here.
    // The previous version of this test asserted only that the null-id row
    // survived in the store -- which the fake produced whether or not the
    // helper skipped it, so deleting `s3-versions.sh`'s guard was GREEN.
    // Assert what the helper REQUESTED instead.
    const s = writeStore([
      { Key: `${P}state.json`, VersionId: null, IsLatest: true, IsDeleteMarker: false },
      { Key: `${P}state.json`, VersionId: 'null', IsLatest: false, IsDeleteMarker: false },
      { Key: `${P}state.json`, VersionId: 'v1', IsLatest: false, IsDeleteMarker: false },
    ]);
    expect(run(s, ['purge', P, 'all']).status).toBe(0);
    const asked = readStore(s).deleteCalls;
    expect(
      asked.filter((c) => c.VersionId === 'None'),
      'the helper asked S3 to delete version id "None", which is an absent key, not an id'
    ).toEqual([]);
    // ...and it DID ask for the two real ids, so the skip is a skip and not a
    // sweep that quietly did nothing.
    expect(asked.map((c) => c.VersionId).sort()).toEqual(['null', 'v1']);
  });
});

describe('s3-versions.sh: scoping', () => {
  it('EXACT-KEY scoping does not take a sibling key under the same prefix', () => {
    // `--prefix` matches by prefix, so `state.json` would otherwise drag
    // `state.json.bak` along with it. The `?Key==` term is the whole point.
    const objs = [
      ...versions(P, 'state.json', 3),
      ...versions(P, 'state.json.bak', 3),
      ...versions(P, 'state.json.tmp', 2),
    ];
    const s = writeStore(objs);
    expect(run(s, ['purge_key', `${P}state.json`, 'all']).status).toBe(0);
    const left = readStore(s).objects.map((o) => o.Key);
    expect(left.filter((k) => k === `${P}state.json`)).toEqual([]);
    expect(left.filter((k) => k === `${P}state.json.bak`)).toHaveLength(4);
    expect(left.filter((k) => k === `${P}state.json.tmp`)).toHaveLength(3);
  });

  it('the stack prefix keeps CdkdFoo from matching CdkdFooBar', () => {
    const r = run(writeStore([]), ['prefix', 'CdkdFoo', 'us-east-1']);
    expect(r.stdout.trim()).toBe('cdkd/CdkdFoo/us-east-1/');
    const objs = [
      ...versions('cdkd/CdkdFoo/us-east-1/', 'state.json', 2),
      ...versions('cdkd/CdkdFooBar/us-east-1/', 'state.json', 2),
    ];
    const s = writeStore(objs);
    expect(run(s, ['purge', 'cdkd/CdkdFoo/us-east-1/', 'all']).status).toBe(0);
    expect(readStore(s).objects.every((o) => o.Key.startsWith('cdkd/CdkdFooBar/'))).toBe(true);
    expect(readStore(s).objects).toHaveLength(3);
  });

  it.each([
    ['whole bucket', ''],
    ['no cdkd/ root', 'foo/bar/'],
    ['no trailing slash', 'cdkd/CdkdFoo/us-east-1'],
    ['empty stack segment', 'cdkd//us-east-1/'],
    ['empty region segment', 'cdkd/CdkdFoo//'],
    ['stack only', 'cdkd/CdkdFoo/'],
  ])('refuses the malformed prefix (%s) and DELETES NOTHING', (_label, prefix) => {
    // This is a SAFETY guard: these run under `set +eu` inside cleanup, so an
    // unset STACK would otherwise expand to an over-broad prefix and delete a
    // concurrent lane's LIVE state. The sibling file proves no REQUEST is
    // issued; what is added here is the outcome that matters to the other lane
    // -- the version store is provably untouched afterwards.
    const objs = [...versions('cdkd/CdkdFoo/us-east-1/', 'state.json', 3)];
    const s = writeStore(objs);
    const purge = run(s, ['purge', prefix, 'all']);
    expect(purge.status).not.toBe(0);
    expect(readStore(s).objects).toHaveLength(4);
    // ...and the ASSERTION refuses too, rather than reporting a truthful 0
    // about the wrong key space -- the vacuous green.
    const a = run(s, ['assert', prefix]);
    expect(a.status).toBe(1);
    expect(a.stderr).toContain('malformed prefix');
  });
});

describe('s3-versions.sh: the paths only reachable through s3_purge_key_versions', () => {
  // `noncurrent` is the ONLY mode any real call site passes to this function
  // (cross-stack-secret-import and dynamic-ref-cross-region both use it
  // mid-run), and it was the one arm nothing exercised: replacing the whole
  // `noncurrent` branch of `_s3v_key_query` with a broken query left the suite
  // green, because the harness only ever drove `purge_key` in `all` mode.
  it('purge_key noncurrent removes the historical versions and KEEPS the current one', () => {
    const objs = [...versions(P, 'state.json', 5), ...versions(P, 'state.json.bak', 2)];
    const s = writeStore(objs);
    expect(run(s, ['purge_key', `${P}state.json`, 'noncurrent']).status).toBe(0);
    const left = readStore(s).objects;
    // The exact-key term still holds in this mode: the sibling is untouched.
    expect(left.filter((o) => o.Key === `${P}state.json.bak`)).toHaveLength(3);
    // ...and of the target key, only the CURRENT entry survives.
    const target = left.filter((o) => o.Key === `${P}state.json`);
    expect(target).toHaveLength(1);
    expect(target[0]!.IsLatest).toBe(true);
    expect(target[0]!.VersionId).toBe('v5');
  });

  it('purge_key noncurrent leaves a delete-marker-latest in place (mode really filters)', () => {
    const objs = versions(P, 'state.json', 3, { latestIsDeleteMarker: true });
    const s = writeStore(objs);
    expect(run(s, ['purge_key', `${P}state.json`, 'noncurrent']).status).toBe(0);
    const left = readStore(s).objects;
    expect(left).toHaveLength(1);
    expect(left[0]!.IsDeleteMarker).toBe(true);
    // The contrast that proves the filter is not a no-op.
    const sa = writeStore(objs);
    expect(run(sa, ['purge_key', `${P}state.json`, 'all']).status).toBe(0);
    expect(readStore(sa).objects).toEqual([]);
  });

  it('a key or version id carrying a quote falls back to single-object delete', () => {
    // Unreachable for cdkd's key shapes, which is exactly why it would stay
    // silent forever if it ever fired -- in a file whose whole premise is that
    // a quiet sweep is the bug. Deleting the whole branch was green before.
    const quoted = `${P}state".json`;
    const s = writeStore([
      { Key: quoted, VersionId: 'v0', IsLatest: false, IsDeleteMarker: false },
      { Key: `${P}state.json`, VersionId: 'v1', IsLatest: false, IsDeleteMarker: false },
    ]);
    expect(run(s, ['purge', P, 'all']).status).toBe(0);
    const calls = readStore(s).deleteCalls;
    // The quoted key went through `delete-object`, NOT the batch -- a batch
    // would have interpolated the quote into hand-assembled JSON.
    expect(calls.find((c) => c.Key === quoted)?.op).toBe('delete-object');
    expect(calls.find((c) => c.Key === `${P}state.json`)?.op).toBe('delete-objects');
    expect(readStore(s).objects).toEqual([]);
  });

  it('a failing single-object delete WARNs rather than passing in silence', () => {
    const quoted = `${P}state".json`;
    const s = writeStore([{ Key: quoted, VersionId: 'v0', IsLatest: false, IsDeleteMarker: false }], {
      failDeleteObjectKeys: [quoted],
    });
    const r = run(s, ['purge', P, 'all']);
    expect(r.stderr).toContain('single-object delete failed');
  });

  it('s3_purge_key_versions with an EMPTY key FAILs instead of sweeping the prefix', () => {
    // An unset `STATE_KEY` under `set +u` expands to empty; without this guard
    // the `?Key==''` term matches nothing and the call is a silent no-op, or
    // worse a caller reads the 0 as success.
    const s = writeStore(versions(P, 'state.json', 3));
    const r = run(s, ['purge_key', '', 'all']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('s3_purge_key_versions needs a key');
    expect(readStore(s).objects).toHaveLength(4);
  });
});

describe('s3-versions.sh: the KEY-scoped count and assertion (shared keys)', () => {
  // The shared exports index `cdkd/_index/<region>/exports.json` is the reason
  // these exist: a key a fixture writes but does not OWN. Its current object
  // belongs to whichever stack wrote it last, so the only thing a run may
  // certify is that no HISTORICAL version it wrote survives.
  const IDX = 'cdkd/_index/us-east-1/exports.json';

  it('counts noncurrent versions of one key, ignoring siblings and the current object', () => {
    const objs = [
      ...versions(IDX, '', 4),
      ...versions('cdkd/_index/us-east-1/exports.json.bak', '', 3),
    ];
    const s = writeStore(objs);
    expect(run(s, ['count_key', IDX, 'noncurrent']).stdout.trim()).toBe('4');
    expect(run(s, ['count_key', IDX, 'all']).stdout.trim()).toBe('5');
  });

  it('the assertion DEFAULTS to noncurrent, so a live shared index passes', () => {
    // The opposite default from the prefix assertion, and deliberately so:
    // demanding `all` on a shared key would demand a state no correct run can
    // reach, because another lane's current object is supposed to be there.
    const s = writeStore(versions(IDX, '', 3));
    expect(run(s, ['purge_key', IDX, 'noncurrent']).status).toBe(0);
    const r = run(s, ['assert_key', IDX]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('0 noncurrent versions');
    // ...and the current object really did survive.
    expect(readStore(s).objects).toHaveLength(1);
    expect(readStore(s).objects[0]!.IsLatest).toBe(true);
  });

  it('FAILS when historical versions survive', () => {
    const s = writeStore(versions(IDX, '', 3));
    const r = run(s, ['assert_key', IDX, 'noncurrent', 'exports-index teardown']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('3 noncurrent version(s) survive');
    expect(r.stderr).toContain('exports-index teardown');
  });

  it('FAILS rather than reading a failed LIST as zero', () => {
    const s = writeStore(versions(IDX, '', 3), { failListOnCall: 1 });
    const r = run(s, ['assert_key', IDX]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('could not count');
  });

  it('refuses an EMPTY key instead of counting the whole bucket', () => {
    const s = writeStore(versions(IDX, '', 3));
    const r = run(s, ['count_key', '', 'all']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('s3_count_key_versions needs a key');
  });
});

describe('s3-versions.sh: a listing failure must FAIL, never read as zero', () => {
  it('s3_count_versions returns non-zero (not "0") when the LIST itself fails', () => {
    const objs = versions(P, 'state.json', 9);
    const s = writeStore(objs, { failListOnCall: 1 });
    const r = run(s, ['count', P, 'all']);
    expect(r.status).not.toBe(0);
    expect(r.stdout.trim()).not.toBe('0');
    expect(r.stderr).toContain('could not list versions');
  });

  it('s3_assert_versions_swept FAILS the run rather than certifying an unverified sweep', () => {
    const s = writeStore(versions(P, 'state.json', 9), { failListOnCall: 1 });
    const r = run(s, ['assert', P, 'demo teardown']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('could not list object versions');
    expect(r.stderr).toContain('An unverified sweep is not a clean teardown');
  });

  it('a throttle mid-sweep aborts the purge instead of silently purging nothing', () => {
    // The tri-state matters here: piping the listing into `while` would hide
    // the status and a transient throttle would look exactly like "there is
    // nothing here".
    const s = writeStore(versions(P, 'state.json', 9), { failListOnCall: 2 });
    const r = run(s, ['purge', P, 'all']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('could not list versions');
  });

  it('per-object DeleteObjects errors surface as a WARN and leave the assertion red', () => {
    // Quiet:true makes a fully successful call return {} and list ONLY the
    // failures, so a non-empty `Errors` is a per-object failure the call itself
    // reported as overall success.
    const s = writeStore(versions(P, 'state.json', 2), { perObjectErrorKeys: [`${P}state.json`] });
    const r = run(s, ['purge', P, 'all']);
    expect(r.stderr).toContain('delete-objects reported per-object errors');
    expect(readStore(s).objects).toHaveLength(3);
    expect(run(s, ['assert', P]).status).toBe(1);
  });
});


// ---------------------------------------------------------------------------
// HERMETICITY. Every axis this suite could silently depend on, each either
// PINNED (in `childEnv`) or recorded as a MEASURED NEGATIVE here.
//
// Prefer pinning to normalising: a normalisation layer sits between the
// implementation and the assertions, and that is exactly where a fence goes
// green-but-inert. The cases below therefore assert the PIN from inside a real
// child process, rather than asserting that some helper produced tidy output.
// ---------------------------------------------------------------------------

describe('the harness is hermetic on every axis it could depend on', () => {
  it('records the interpreter it actually ran under (receipt, not an assertion)', () => {
    // `/bin/bash` is pinned as a PATH, but a path is not an identity: the
    // full-suite environment resolved something whose diagnostics differ from
    // GNU bash's, which is what broke the trap-3 case. Nothing here asserts
    // WHICH shell it is -- the helper is meant to run under whatever `bash`
    // resolves to on the host -- but the identity is printed so the next
    // wording-shaped failure can be diagnosed in one read instead of a bisect.
    const r = runBash(
      'echo "shell=${BASH_VERSION:-<not bash>}"; echo "argv0=$0"; command -v awk mktemp',
      writeStore([])
    );
    process.stdout.write(`[s3-versions harness] interpreter: ${BASH}\n${r.stdout}`);
    expect(r.status).toBe(0);
    // The two external tools the helper actually uses must resolve from the
    // PINNED PATH. If either vanished, the count and the temp-file plumbing
    // would fail in ways that look like helper bugs.
    expect(r.stdout).toMatch(/\/awk/);
    expect(r.stdout).toMatch(/mktemp/);
  });

  it('PATH is pinned: a real `aws` earlier in the AMBIENT PATH cannot win', () => {
    // The threat is the AMBIENT PATH -- a developer's real `aws`, or a shimmed
    // `awk` / `mktemp`. `childEnv` never reads `process.env.PATH`, so the test
    // has to put the decoy where the leak WOULD come from: on process.env.PATH
    // itself. The earlier version created the decoy and never placed it on any
    // PATH, so deleting the whole decoy setup was green -- it proved nothing.
    const decoy = join(workdir, 'decoy');
    mkdirSync(decoy, { recursive: true });
    writeFileSync(join(decoy, 'aws'), '#!/bin/sh\necho "DECOY AWS" >&2\nexit 7\n');
    chmodSync(join(decoy, 'aws'), 0o755);
    const savedPath = process.env['PATH'];
    try {
      process.env['PATH'] = `${decoy}:${savedPath ?? ''}`;
      // Positive control: the decoy really does shadow `aws` for anyone who
      // inherits this PATH. Without this, "no DECOY output" could just mean the
      // decoy was never executable.
      const inherited = spawnSync('/bin/sh', ['-c', 'aws s3api list-object-versions'], {
        encoding: 'utf8',
      });
      expect(inherited.stderr, 'decoy is not actually shadowing aws — probe is inert').toContain(
        'DECOY AWS'
      );
      // ...and the harness is unaffected, because childEnv builds PATH itself.
      const s = writeStore(versions(P, 'state.json', 2));
      const r = run(s, ['count', P, 'all']);
      expect(r.stderr).not.toContain('DECOY AWS');
      expect(r.stdout.trim()).toBe('3');
    } finally {
      if (savedPath === undefined) delete process.env['PATH'];
      else process.env['PATH'] = savedPath;
    }
  });

  it('ambient AWS_* cannot change the helper behaviour it pins `--output` against', () => {
    // The helper's header says `--output json` / `--output text` are pinned
    // because the CLI's output format is AMBIENT -- `AWS_DEFAULT_OUTPUT`, or
    // `output = yaml` in the active profile. `childEnv` forwards no AWS_* at
    // all; this feeds the hostile value back in ON TOP to prove the pin, not
    // merely the omission. The fake refuses any format but the pinned one, so
    // a helper that dropped its `--output` flag would fail here.
    const s = writeStore(versions(P, 'state.json', 4));
    const r = spawnSync(BASH, [join(workdir, 'driver.sh'), 'count', P, 'all'], {
      env: {
        ...childEnv({ S3V_STORE: s, HELPER: HELPER_PATH, BUCKET: 'b' }),
        AWS_DEFAULT_OUTPUT: 'yaml',
        AWS_PROFILE: 'nonexistent-profile',
        AWS_REGION: 'eu-central-1',
        AWS_DEFAULT_REGION: 'eu-central-1',
      },
      cwd: workdir,
      encoding: 'utf8',
    });
    expect((r.stdout ?? '').trim()).toBe('5');
  });

  it('HOME / BASH_ENV / ENV are pinned, so no dotfile can redefine `aws`', () => {
    // A user rc that defines an `aws` shell function would shadow the fake and
    // every case in this file would be testing that function instead. HOME
    // points at the (empty) workdir and both non-interactive rc hooks are
    // emptied. Planting the hostile rc is what makes this a test.
    writeFileSync(join(workdir, '.bashrc'), 'aws() { echo "RC AWS" >&2; return 9; }\n');
    writeFileSync(join(workdir, 'hostile-env.sh'), 'aws() { echo "BASH_ENV AWS" >&2; return 9; }\n');
    const s = writeStore(versions(P, 'state.json', 1));
    const r = run(s, ['count', P, 'all']);
    expect(r.stderr).not.toContain('RC AWS');
    expect(r.stderr).not.toContain('BASH_ENV AWS');
    expect(r.stdout.trim()).toBe('2');
  });

  it('cwd is pinned: the helper works from a directory that is not the repo', () => {
    // `run` sets cwd to the workdir. The helper is sourced by absolute path and
    // must not reach for anything relative -- a relative read would resolve
    // against the CALLER's cwd, which is the documented reason the fixtures
    // source it absolutely in the first place.
    const s = writeStore(versions(P, 'state.json', 3));
    expect(run(s, ['count', P, 'all']).stdout.trim()).toBe('4');
  });

  it('EVERY pinned variable is asserted from inside the child, not just listed', () => {
    // Deleting HOME / BASH_ENV / ENV / LC_ALL / LANG / TZ from `childEnv` left
    // the suite green: only PATH and TMPDIR were load-bearing, while the code
    // comments, the changelog and docs/testing.md all claimed each pin was
    // probed. This reads every pin back out of a real child process, so
    // removing ANY of them fails here by name.
    //
    // THE LIST IS DERIVED FROM `childEnv` ITSELF, not hand-enumerated. A
    // hand-written list is a second place to remember, so a pin added later
    // would be unasserted and nothing would say so -- the same parallel-array
    // bug as the retired-samples list above.
    const pins = childEnv({});
    const names = Object.keys(pins).sort();
    expect(names.length, 'childEnv pins nothing — the fence would be vacuous').toBeGreaterThanOrEqual(8);

    const script = names
      .map((n) => `printf '%s=%s\\n' ${JSON.stringify(n)} "\${${n}-<UNSET>}"`)
      .join('\n');
    const r = runBash(script, writeStore([]));
    expect(r.status).toBe(0);
    const seen = Object.fromEntries(
      r.stdout
        .trim()
        .split('\n')
        .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])
    );
    for (const n of names) {
      expect(seen[n], `${n} is declared in childEnv but does not reach the child with its pinned value`).toBe(
        pins[n]
      );
    }
    // AWS_* is asserted STRICTLY, with no control subtraction, and the
    // asymmetry is deliberate: no supervisor injects AWS credentials, and if
    // one ever did it would still change what the helper does -- the `--output`
    // pins exist precisely because that family is ambient. For this family,
    // "who put it there" does not change the answer.
    const leakedAws = runBash('env | sed -n "s/^\\(AWS_[A-Z_]*\\)=.*/\\1/p" | sort', writeStore([]));
    expect(leakedAws.stdout.trim(), 'an AWS_* variable reached the child').toBe('');

    // Everything else: subtract a CONTROL spawn. See `leakedNames` for why this
    // is the property rather than an exact-match on the allow-list.
    const NAMES_CMD = 'env | sed -n "s/^\\([A-Za-z_][A-Za-z0-9_]*\\)=.*/\\1/p" | sort';
    const envNames = (r: RunResult): string[] => r.stdout.trim().split('\n').filter((n) => n !== '');
    const control = spawnSync(BASH, ['-c', NAMES_CMD], {
      // Deliberately minimal: PATH only. Anything ELSE this child reports was
      // put there by the platform or a process supervisor, not by us.
      env: { PATH: '/usr/bin:/bin' },
      cwd: workdir,
      encoding: 'utf8',
    });
    expect(control.status, 'the control spawn failed, so the subtraction is unsound').toBe(0);
    const controlNames = envNames({
      status: control.status ?? -1,
      stdout: control.stdout ?? '',
      stderr: control.stderr ?? '',
    });
    // The control must at least see the PATH we handed it; a control that saw
    // nothing would subtract nothing and this would silently become the old
    // exact-match assertion again.
    expect(controlNames, 'control spawn reported no PATH — subtraction would be inert').toContain('PATH');

    // From the DECLARED contract, never from `childEnv`'s own output -- see
    // PIN_NAMES for the measurement that forced this.
    const allowed = new Set<string>([...PIN_NAMES, ...NON_PIN_ALLOWED]);
    const leaked = leakedNames(envNames(runBash(NAMES_CMD, writeStore([]))), controlNames, allowed);
    expect(leaked, "a variable the PARENT carries reached the child — childEnv is not sealing it").toEqual(
      []
    );
  });

  it('the pin contract and childEnv agree (neither may drift from the other)', () => {
    // Adding a key to `childEnv` without declaring it -- the shape a
    // `...process.env` spread takes -- fails HERE as well as in the leak check,
    // and adding a name to PIN_NAMES that `childEnv` never sets fails too.
    expect(Object.keys(childEnv({})).sort()).toEqual([...PIN_NAMES].sort());
  });

  it('leakedNames: a supervisor injection is out of scope, a parent leak is not', () => {
    // Both directions of the property, as pure set arithmetic, so neither
    // depends on whether a supervisor happens to be attached to THIS run --
    // which is exactly the axis that made the previous version of this fence
    // pass locally, pass in CI, and fail under the agent sandbox.
    //
    // These three names are TEST DATA for the arithmetic, not an ignore list in
    // the production path: they are observed values used to demonstrate the
    // subtraction, and `leakedNames` never mentions them.
    const SUPERVISOR = ['DYLD_INSERT_LIBRARIES', 'FSPY_PAYLOAD', '__CF_USER_TEXT_ENCODING'];
    const allowed = new Set(['PATH', 'HOME']);

    // Injected into EVERY child, so it shows up in the control too -> not a leak.
    expect(
      leakedNames(['PATH', 'HOME', ...SUPERVISOR], ['PATH', ...SUPERVISOR], allowed)
    ).toEqual([]);

    // Carried by the parent and NOT by the control -> a leak, and still caught
    // while a supervisor is attached.
    expect(
      leakedNames(['PATH', 'HOME', 'AWS_PROFILE', ...SUPERVISOR], ['PATH', ...SUPERVISOR], allowed)
    ).toEqual(['AWS_PROFILE']);

    // A whole spread of the parent's environment, the shape `childEnv` exists
    // to prevent, is still caught name by name.
    expect(
      leakedNames(
        ['PATH', 'HOME', 'AWS_REGION', 'NVM_DIR', 'EDITOR', ...SUPERVISOR],
        ['PATH', ...SUPERVISOR],
        allowed
      )
    ).toEqual(['AWS_REGION', 'EDITOR', 'NVM_DIR']);

    // An empty control subtracts nothing -- the degenerate case the
    // `toContain('PATH')` guard above exists to rule out.
    expect(leakedNames(['PATH', 'HOME', 'FSPY_PAYLOAD'], [], allowed)).toEqual(['FSPY_PAYLOAD']);
  });

  it('MEASURED NEGATIVE: the helper needs no `jq`, `python3`, or any clock', () => {
    // Not pinned but MEASURED, because the right answer is that the dependency
    // does not exist rather than that it is controlled. `jq` is the load-bearing
    // one: the helper's header promises it assembles the DeleteObjects payload
    // by hand precisely so that sourcing it does not add a `jq` dependency to
    // sixteen fixtures, and this is that promise made executable.
    const body = readFileSync(HELPER_PATH, 'utf8')
      .split('\n')
      .map((l) => l.replace(/(^|\s)#.*$/, ''))
      .join('\n');
    for (const tool of ['jq', 'python3', 'python', 'perl', 'date', 'gdate']) {
      expect(new RegExp(`(^|[|;&(\\s])${tool}\\b`).test(body), `helper now shells out to ${tool}`).toBe(
        false
      );
    }
    // No clock read of any spelling, so TZ and the wall clock cannot reach it.
    expect(/\$SECONDS|\$EPOCHSECONDS|\bdate\s+\+/.test(body)).toBe(false);
  });

  it('MEASURED NEGATIVE: the suite writes nothing outside its own scratch dir', () => {
    // The blast-radius half of the shared-/tmp problem. Every path this file
    // hands to a child is under `workdir`, which is under SCRATCH_ROOT.
    expect(workdir.startsWith(SCRATCH_ROOT)).toBe(true);
    for (const entry of readdirSync(workdir)) {
      expect(join(workdir, entry).startsWith(workdir)).toBe(true);
    }
    // The helper's own `mktemp` inherits TMPDIR, so its stderr scratch files
    // land here too rather than in the shared /tmp.
    const s = writeStore(versions(P, 'state.json', 1));
    const r = runBash('. "$1"; echo "TMPDIR=${TMPDIR}"', s, [HELPER_PATH]);
    expect(r.stdout.trim()).toBe(`TMPDIR=${workdir}`);
  });
});

// ---------------------------------------------------------------------------
// MUTATION PROBES. A harness that passes against the broken forms is worth
// nothing, so each trap is reintroduced into a COPY of the helper and the
// harness is watched going red.
// ---------------------------------------------------------------------------

describe('s3-versions.sh: mutation probes reintroducing each documented trap', () => {
  /**
   * Applies an edit to a COPY of the real helper and refuses a no-op.
   *
   * Every replacement is a FUNCTION rather than a string. In a JS replacement
   * string `$'` means "the portion after the match", and the shell form being
   * reintroduced here is literally `IFS=$'\t'` -- passing it as a string
   * spliced the rest of the file in at that point and the mutant died with a
   * syntax error, which reads from the outside exactly like a probe that
   * "went red" for the right reason. It did not.
   */
  function mutant(name: string, edit: (src: string) => string): string {
    const src = readFileSync(HELPER_PATH, 'utf8');
    const out = edit(src);
    expect(out, `mutation "${name}" did not change the helper -- the probe is vacuous`).not.toBe(src);
    const path = join(workdir, `mutant-${name}.sh`);
    writeFileSync(path, out);
    // A mutant that does not PARSE proves nothing: the helper would be
    // "broken" in a way no reviewer could ship, and every assertion below
    // would pass for the wrong reason.
    const syntax = spawnSync(BASH, ['-n', path], { encoding: 'utf8' });
    expect(syntax.status, `mutant "${name}" does not parse: ${syntax.stderr}`).toBe(0);
    return path;
  }

  const dropNewlineGuard = (s: string): string =>
    s.replace(/printf '%s\\n' "\$\{rows\}" \| _s3v_delete_rows/g, () => `printf '%s' "\${rows}" | _s3v_delete_rows`);
  const dropReadGuard = (s: string): string =>
    s.replace(
      /while IFS=\$'\\t' read -r key vid \|\| \[ -n "\$\{key\}" \]; do/,
      () => `while IFS=$'\\t' read -r key vid; do`
    );

  const ONE_VERSION: StoreObject[] = [
    { Key: `${P}state.json`, VersionId: 'v0', IsLatest: true, IsDeleteMarker: false },
  ];

  it('trap 2 (both guards removed): the LAST version is dropped -- 0 of 1 swept', () => {
    // The helper carries BELT AND BRACES: `printf '%s\n'` AND the
    // `|| [ -n "${key}" ]` read guard. Removing EITHER alone still sweeps
    // correctly (asserted in the two probes below), which is exactly why a
    // probe that removed only one would report a false all-clear. Deleting
    // what the fence REQUIRES means deleting BOTH.
    const m = mutant('trap2-both', (s) => dropReadGuard(dropNewlineGuard(s)));
    const s = writeStore(ONE_VERSION);
    const r = run(s, ['purge', P, 'all'], m);
    expect(r.status).toBe(0); // SILENT: the sweep still "succeeds"...
    expect(readStore(s).objects).toHaveLength(1); // ...having deleted nothing.
    // The assertion is what makes it loud -- the whole thesis of the file:
    // a sweep with no assertion is indistinguishable from no sweep.
    expect(run(s, ['assert', P], m).status).toBe(1);
  });

  it('trap 2 (newline guard alone) still sweeps -- proving the probe above needed BOTH', () => {
    const m = mutant('trap2-printf-only', dropNewlineGuard);
    const s = writeStore(ONE_VERSION);
    expect(run(s, ['purge', P, 'all'], m).status).toBe(0);
    expect(readStore(s).objects).toEqual([]);
  });

  it('trap 2 (read guard alone) still sweeps -- the other half of the same point', () => {
    const m = mutant('trap2-read-only', dropReadGuard);
    const s = writeStore(ONE_VERSION);
    expect(run(s, ['purge', P, 'all'], m).status).toBe(0);
    expect(readStore(s).objects).toEqual([]);
  });

  slowIt('trap 2 at scale: a 347-entry listing sweeps 346 with both guards gone', () => {
    // Repeated passes take a key to 1 and then stop, which is what a silent
    // off-by-one looks like from outside. Measured against real S3 on
    // 2026-08-20: the broken form swept 346 of 347.
    const m = mutant('trap2-both-scale', (s) => dropReadGuard(dropNewlineGuard(s)));
    const objs = versions(P, 'state.json', 346);
    expect(objs).toHaveLength(347);
    const s = writeStore(objs, { pageSize: 1000 });
    expect(run(s, ['purge', P, 'all'], m).status).toBe(0);
    expect(readStore(s).objects).toHaveLength(1);
  });

  slowIt('trap 3 (length() instead of row counting): a multi-page count is not a number', () => {
    // The AWS CLI applies --query PER PAGE and concatenates, so a >1000-entry
    // listing prints one number per page: the measured output was `1000\n189`,
    // not `1189`. `[ "$n" -ne 0 ]` on that is a bash error, not a comparison.
    const m = mutant('trap3-length', (s) =>
      s.replace(
        /rows="\$\(_s3v_rows "\$\{bucket\}" "\$\{prefix\}" "\$\(_s3v_prefix_query "\$\{mode\}"\)"\)" \|\| return 1\n  printf '%s\\n' "\$\{rows\}" \| awk 'NF\{n\+\+\} END\{print n\+0\}'/,
        () =>
          `rows="$(_s3v_rows "\${bucket}" "\${prefix}" "length(([Versions, DeleteMarkers][])[])")" || return 1\n  printf '%s\\n' "\${rows}"`
      )
    );
    const objs = versions(P, 'state.json', 1188);
    expect(objs).toHaveLength(1189);
    const s = writeStore(objs, { pageSize: 1000 });
    expect(run(s, ['count', P, 'all']).stdout.trim()).toBe('1189');
    const bad = run(s, ['count', P, 'all'], m);
    expect(bad.stdout.trim()).not.toBe('1189');
    expect(bad.stdout.trim().split('\n')).toEqual(['1000', '189']);
    // And the consequence is WORSE than a crash, which is why the header calls
    // it a silent partial rather than an error. `[ "$n" -ne 0 ]` on a two-line
    // value is not a comparison: the `[` builtin rejects the operand and
    // returns non-zero, the `if` is therefore FALSE, and the assertion falls
    // through to announce a CLEAN teardown -- exit 0, "OK: 0 surviving object
    // versions" -- while 1189 versions are still sitting in the bucket. A probe
    // that expected a NON-ZERO exit here would have read this vacuous green as
    // the trap being caught.
    //
    // AXIS CLOSED -- SHELL IDENTITY. This assertion used to match the stderr
    // WORDING (`integer expression expected`, which is bash's phrasing). That
    // passed under bash 3.2 and 5.x and failed in the full suite, where the
    // resolved interpreter says `Invalid integer` instead; two agreeing shells
    // made the axis invisible. The wording is the SHELL's to choose, so it is
    // no longer asserted. What IS asserted is what no shell can reword: that
    // the comparison was rejected at all (no shell silently accepts a two-line
    // integer, so stderr is non-empty), and the vacuous green that follows.
    // The evidence that `length()` was applied PER PAGE is the `1000` / `189`
    // pair already asserted on the count's stdout above -- that comes from the
    // AWS CLI emulation, not from a shell's diagnostic, so it is the right
    // place to pin the substance.
    const badAssert = run(s, ['assert', P], m);
    expect(badAssert.status).toBe(0);
    expect(badAssert.stdout).toContain('OK:');
    expect(badAssert.stdout).toContain('0 surviving object versions');
    expect(
      badAssert.stderr.trim(),
      'no shell accepts a two-line value as an integer, so it must have complained'
    ).not.toBe('');
    // The real helper, on the same store, is loud.
    const goodAssert = run(s, ['assert', P]);
    expect(goodAssert.status).toBe(1);
    expect(goodAssert.stderr).toContain('1189 object version(s)/delete marker(s) survive');
  });

  it('trap 1 backstop: the assertion is the only thing that makes a partial sweep loud', () => {
    // Trap 1 (sweeping only from an EXIT trap that the success path disarms) is
    // a CALLER property and cannot be mutated into the helper. What the helper
    // owes is that a survivor is always LOUD -- checked here; the caller half
    // is linted statically below.
    const s = writeStore(versions(P, 'state.json', 30));
    const r = run(s, ['assert', P, 'sibling key teardown']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('31 object version(s)/delete marker(s) survive');
    expect(r.stderr).toContain('sibling key teardown');
    expect(r.stderr).toContain('list-object-versions');
  });
});

// ---------------------------------------------------------------------------
// The helper's CALLER contract, linted (issue #2225 + trap 1).
// ---------------------------------------------------------------------------

interface Fixture {
  name: string;
  script: string;
}

/**
 * One LOGICAL line per entry, with the 1-based line number it started on.
 *
 * Backslash continuations have to be joined before anything is matched. A
 * fixture is free to write
 *
 *     ${CDKD} destroy "${STACK}" \
 *       --state-bucket "${STATE_BUCKET}" --force 2>&1 | tail -5 || true
 *
 * and a per-physical-line scan sees `destroy` on one line and the pipe on the
 * next, matching neither. That is the commonest spelling in this tree for any
 * invocation with more than two flags, so a line-based predicate would have
 * had a false-NEGATIVE rate concentrated on exactly the fixtures most likely
 * to carry the bug.
 */
function logicalLines(script: string): { text: string; line: number }[] {
  const out: { text: string; line: number }[] = [];
  let buf = '';
  let start = 0;
  script.split('\n').forEach((l, i) => {
    if (buf === '') start = i + 1;
    if (/\\$/.test(l)) {
      buf += l.replace(/\\$/, ' ');
      return;
    }
    out.push({ text: buf + l, line: start });
    buf = '';
  });
  if (buf !== '') out.push({ text: buf, line: start });
  return out;
}

const uncomment = (text: string): string => text.replace(/(^|\s)#.*$/, '');

/**
 * A cdkd destroy INVOCATION.
 *
 * The marker list is the part that needed measuring rather than guessing: the
 * first cut keyed on `${CDKD}` / `cdkd` / `dist/cli.js`, and the probe for the
 * spelling `node "${LOCAL_DIST}" destroy ... | tail -5 || true` -- which is
 * what several fixtures in this tree actually write -- went straight through
 * it. A predicate derived from the one known site had no way to know that.
 */
const CDKD_INVOCATION_MARKERS = [
  // Braced and UNBRACED alike. `$CDKD` without braces is live at
  // tests/integration/acm-certificate/verify.sh:77,392,553 -- the earlier
  // "every spelling was enumerated from the tree" claim missed it, which is
  // why `markerCoverage` below is an executable floor rather than a comment.
  /\$\{?(CDKD|CLI|LOCAL_DIST)\}?\b/,
  /\bcdkd\b/,
  /dist\/cli\.js/,
] as const;

/**
 * Quoted spans blanked, so a word can be tested as a COMMAND VERB.
 *
 * `assert_gone "state file still exists after destroy" aws s3api head-object …`
 * is the single commonest line shape in this tree, and `destroy` there is part
 * of a human-readable DESCRIPTION, not an invocation. Testing the raw line
 * produced 200+ false candidates from that one idiom alone.
 */
function stripQuoted(code: string): string {
  // SINGLE quotes first. Shell single quotes cannot nest and cannot contain an
  // escape, so they are the unambiguous span; doing double quotes first
  // mis-paired them on
  //   HAS_DESTROY="$(echo "${X}" | jq '… select(.command == "destroy") …'
  // and left the word exposed. The over-strip risk this creates (an apostrophe
  // in prose opening a bogus span) can only cause a MISSED candidate, and that
  // direction is fenced by the recognised-count floor in the coverage test:
  // if stripping ever eats real invocations, that floor fails loudly.
  return code.replace(/'(?:[^'\\]|\\.)*'/g, ' ').replace(/"(?:[^"\\]|\\.)*"/g, ' ');
}

/** Does this line INVOKE a destroy (verb outside quotes)? Broader than cdkd. */
function looksLikeDestroyInvocation(text: string): boolean {
  const code = uncomment(text);
  if (code.trim() === '') return false;
  if (/^\s*(echo|printf)\b/.test(code)) return false;
  // Whitespace-delimited, NOT `\bdestroy\b`: `-` and `"` are word boundaries, so
  // `\b` also matched the FILENAME `destroy-blocked.log` (three fixtures tail
  // one) and a jq selector `select(.command == "destroy")`. A verb is a word
  // with space on both sides.
  return /(^|\s)destroy(\s|$)/.test(stripQuoted(code));
}

function isCdkdDestroy(text: string): boolean {
  if (!looksLikeDestroyInvocation(text)) return false;
  const code = uncomment(text);
  return CDKD_INVOCATION_MARKERS.some((re) => re.test(code));
}

/**
 * Bare `cdk destroy` / `npx cdk destroy` is the AWS CDK CLI tearing down a
 * CloudFormation stack, NOT cdkd. Deliberately excluded above (`\bcdkd\b`
 * cannot match `cdk`): its status says nothing about whether cdkd's state
 * record is still needed, so gating a version purge on it would be wrong.
 */
const NON_CDKD_DESTROY = /(^|\s)(npx\s+)?cdk\s+destroy\b/;

/** ...whose exit status is thrown away by a pipe and/or a trailing `|| true`. */
function swallowsStatus(text: string): boolean {
  const code = uncomment(text);
  return /\|[^|]/.test(code) || /\|\|\s*true\s*$/.test(code);
}

/** `foo_rc=${PIPESTATUS[0]}` / `foo_rc=$?` — the captured-status variable. */
function capturedStatusVar(text: string): string | undefined {
  // The two spellings are matched SEPARATELY rather than with an optional
  // brace on each side: `\$\{?...\}?` also accepts `x=$PIPESTATUS[0]`, which is
  // `$PIPESTATUS` (the array's FIRST element) followed by a literal `[0]` --
  // right answer by luck for element 0, wrong the moment anyone writes
  // `$PIPESTATUS[1]`, and not what the fixture means.
  const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)=(?:\$\{PIPESTATUS\[0\]\}|\$\?)\s*$/.exec(uncomment(text));
  return m ? m[1] : undefined;
}

const capturesPipestatus = (text: string): boolean => /=\$\{PIPESTATUS\[0\]\}/.test(uncomment(text));

/** The next line after `idx` that actually EXECUTES (skipping comments/blanks). */
function nextExecuting(
  body: { text: string; line: number }[],
  idx: number
): { text: string; line: number } | undefined {
  for (let i = idx + 1; i < body.length; i++) {
    const c = uncomment(body[i]!.text).trim();
    if (c !== '') return body[i];
  }
  return undefined;
}

/** The body of `cleanup() { ... }`, as logical lines, or undefined. */
function cleanupBody(lines: { text: string; line: number }[]): { text: string; line: number }[] | undefined {
  const start = lines.findIndex((l) => /^\s*cleanup\(\)\s*\{/.test(l.text));
  if (start < 0) return undefined;
  // Depth-counted, and the closing brace is matched at ANY indent. Anchoring it
  // at column 0 (`/^\}/`) meant an indented `}` did not close the function, so
  // the "body" ran to end-of-file and swallowed the SUCCESS path -- every
  // success-path `all` purge would then be judged by a rule written for
  // cleanup. House style happens to put it at column 0, which is exactly why
  // the bug was invisible.
  let depth = 1;
  for (let i = start + 1; i < lines.length; i++) {
    const c = uncomment(lines[i]!.text);
    if (/^\s*\}\s*$/.test(c)) {
      depth -= 1;
      if (depth === 0) return lines.slice(start, i);
      continue;
    }
    if (/\{\s*$/.test(c)) depth += 1;
  }
  return lines.slice(start);
}

/**
 * The #2225 rule.
 *
 * SCOPED TO `cleanup()`, and that scoping is the difference between a rule and
 * a noise generator. Fourteen of the sixteen callers purge `all` on the SUCCESS
 * path, after an unpiped `set -e`-guarded destroy that cannot be reached if it
 * failed -- they are already correct, and an unscoped "an `all` purge must be
 * guarded" rule flagged one of them (`lambda-esm-self-managed-kafka`) by
 * walking back to an unrelated `if gone_probe ...` twenty lines above. Inside
 * `cleanup` the situation is the opposite: it runs under `set +e` on every
 * exit path, so nothing there is guarded by anything unless it says so.
 */
/**
 * The `if` / `elif` / `else` construct that ENCLOSES `idx`, depth-aware.
 *
 * Not the nearest preceding `if` LINE: a closed `if … fi` sitting above the
 * purge governs nothing, and keying on the token made an UNGUARDED `all` purge
 * read as guarded by whatever block happened to close before it. `fi` opens a
 * depth the matching `if` closes, so only an `if` seen at depth 0 is enclosing.
 * Returns `undefined` when the line sits at the top level of the body -- which,
 * for an `all` purge, is itself the violation.
 */
function enclosingGuard(
  body: { text: string; line: number }[],
  idx: number
): { text: string; idx: number } | undefined {
  let depth = 0;
  for (let i = idx - 1; i >= 0; i--) {
    const c = uncomment(body[i]!.text);
    if (/^\s*fi\b/.test(c)) {
      depth += 1;
      continue;
    }
    if (/^\s*if\s/.test(c)) {
      if (depth === 0) return { text: c, idx: i };
      depth -= 1;
      continue;
    }
    // `elif` / `else` at depth 0 are branches of the construct we are inside,
    // so they ARE the governing condition for a purge in that branch.
    if (depth === 0 && /^\s*el(se\b|if\s)/.test(c)) return { text: c, idx: i };
  }
  return undefined;
}

/** One recognised cdkd destroy, with the variable its status was captured into. */
interface DestroyRecord {
  readonly line: number;
  readonly varName: string;
  readonly captureLine: number;
}

function purgeModeViolations(name: string, script: string): string[] {
  const body = cleanupBody(logicalLines(script));
  if (body === undefined) return [];
  const allPurges = body.filter((l) => /s3_purge_prefix_versions[^\n]*\ball\b/.test(uncomment(l.text)));
  if (allPurges.length === 0) return [];

  const out: string[] = [];
  const destroys: DestroyRecord[] = [];

  // PER DESTROY, not a single `sawDestroy` flag. With one flag, a fixture with
  // two destroys where only ONE spelling is recognised stays "seen", and the
  // unrecognised one is silently exempted from the capture requirement.
  for (const [idx, l] of body.entries()) {
    if (!looksLikeDestroyInvocation(l.text)) continue;
    if (NON_CDKD_DESTROY.test(uncomment(l.text))) continue; // AWS CDK CLI, not cdkd
    if (!isCdkdDestroy(l.text)) {
      out.push(
        `${name}/verify.sh:${l.line}: cleanup() purges in 'all' mode and this line invokes a destroy, but ` +
          `isCdkdDestroy() does not RECOGNISE the spelling, so its exit status would go unchecked. ` +
          `Extend CDKD_INVOCATION_MARKERS rather than editing the fixture's guard.`
      );
      continue;
    }
    // The capture must be the next thing that RUNS. Comments and blank lines
    // are skipped because they cannot clobber PIPESTATUS -- and an explaining
    // comment is exactly what a person writes there, so a rule demanding
    // literal adjacency would reject the corrected form it just asked for.
    // Anything that executes, though, overwrites PIPESTATUS and is rejected.
    const next = nextExecuting(body, idx);
    const v = next ? capturedStatusVar(next.text) : undefined;
    if (v === undefined) {
      out.push(
        `${name}/verify.sh:${l.line}: cleanup() purges in 'all' mode, but this cdkd destroy's exit status is ` +
          `never captured. Add \`destroy_rc=\${PIPESTATUS[0]}\` on the next line and gate the purge MODE on it. ` +
          `Gating on the SCRIPT's rc lets a run that passed every assertion and then FAILED to destroy take the ` +
          `'all' branch, deleting the state.json a later \`cdkd state destroy\` needs. ` +
          `See tests/integration/s3-versions.sh -> "MODE matters".`
      );
      continue;
    }
    if (swallowsStatus(l.text) && !capturesPipestatus(next!.text)) {
      out.push(
        `${name}/verify.sh:${next!.line}: '${v}=$?' after a PIPED destroy reads the status of the LAST stage ` +
          `of the pipe (tail), not the destroy -- which is the very thing that hid the failure. ` +
          `Use \${PIPESTATUS[0]}.`
      );
      continue;
    }
    destroys.push({ line: l.line, varName: v, captureLine: next!.line });
  }
  if (out.length > 0) return out;

  if (destroys.length === 0) {
    return [
      `${name}/verify.sh: cleanup() purges in 'all' mode but no cdkd destroy invocation was RECOGNISED ` +
        `in it. Either the teardown really is missing, or this fixture spells the invocation in a way ` +
        `isCdkdDestroy() does not know yet — extend CDKD_INVOCATION_MARKERS rather than editing the guard.`,
    ];
  }

  // EACH DESTROY MUST HAVE ITS OWN OBSERVABLE STATUS when the guard runs.
  //
  // This is the property; "the captured NAMES are distinct" is only its
  // symptom. Tracking a list of names let the natural two-destroy spelling
  // through -- copy-paste the one-destroy idiom and both capture into
  // `destroy_rc=$?`, so `statusVars` was ['destroy_rc','destroy_rc'] and a
  // guard reading it ONCE satisfied `.every`. The second capture has already
  // overwritten the first, so the first destroy's status is not observable at
  // all: a run whose FIRST destroy failed takes the `all` branch and deletes
  // that stack's live state.json. Records carry identity (a line), so the
  // clobber is visible.
  const byVar = new Map<string, DestroyRecord>();
  for (const d of destroys) {
    const prev = byVar.get(d.varName);
    if (prev !== undefined) {
      out.push(
        `${name}/verify.sh:${prev.line}: this destroy's exit status is CLOBBERED before any guard reads it — ` +
          `the destroy at line ${d.line} captures into the SAME variable \`${d.varName}\` at line ` +
          `${d.captureLine}, so only the LAST destroy's status survives. Give each destroy its own variable ` +
          `(e.g. \`consumer_destroy_rc\` / \`producer_destroy_rc\`) and read every one of them in the guard.`
      );
    }
    byVar.set(d.varName, d);
  }
  if (out.length > 0) return out;

  const firstGuard = enclosingGuard(body, body.indexOf(allPurges[0]!));

  // An UNCONDITIONAL `aws s3 rm` over a swept prefix, sitting ABOVE the
  // enclosing guard, makes the `noncurrent` arm INERT: it writes a DELETE
  // MARKER over the live state.json, demoting it to a noncurrent version, which
  // the safe arm then deletes -- destroying exactly the record the failure path
  // exists to keep.
  if (firstGuard !== undefined && firstGuard.idx > 0) {
    for (const l of body.slice(0, firstGuard.idx)) {
      const code = uncomment(l.text);
      if (!/aws\s+s3\s+rm\b/.test(code)) continue;
      // Keyed on the BUCKET, not on a literal `cdkd/` path. A fixture that
      // builds its target from a variable -- `aws s3 rm "s3://${STATE_BUCKET}/${PREFIX}" --recursive`,
      // which is how several fixtures already spell their state keys -- has no
      // literal `cdkd/` on the line and slipped straight through. What makes
      // the line dangerous is that it targets the VERSIONED state bucket, and
      // that is the thing it cannot omit.
      if (!/cdkd\//.test(code) && !/STATE_BUCKET/.test(code)) continue;
      out.push(
        `${name}/verify.sh:${l.line}: this \`aws s3 rm\` over a cdkd prefix runs UNCONDITIONALLY, above the ` +
          `purge-mode branch. It writes a delete marker over the live state.json, demoting it to a NONCURRENT ` +
          `version that the 'noncurrent' arm then deletes -- so the safe mode is inert and the failure path ` +
          `loses the record a later \`cdkd state destroy\` needs. Move it inside the success branch.`
      );
    }
  }
  if (out.length > 0) return out;

  for (const purge of allPurges) {
    const guard = enclosingGuard(body, body.indexOf(purge));
    const guardText = guard?.text ?? '';
    // EVERY destroy, by identity. Names are already proven unique above.
    const unread = destroys.filter((d) => !new RegExp(`\\b${d.varName}\\b`).test(guardText));
    if (guard === undefined || unread.length > 0) {
      out.push(
        `${name}/verify.sh:${purge.line}: this 'all'-mode purge inside cleanup() ` +
          `${guard === undefined ? 'is not inside any if/else block at all' : `does not read every destroy's status (unread: ${unread.map((d) => `${d.varName} (destroy at line ${d.line})`).join(', ')})`} ` +
          `(guard: ${guardText.trim() || '<none>'}). 'all' removes every version AND every delete marker, so a run ` +
          `whose assertions passed but whose destroy FAILED would delete the state.json needed to recover. ` +
          `Gate on the script rc AND every destroy rc.`
      );
    }
  }
  return out;
}

describe('the #2225 predicate, probed in every spelling a person would write', () => {
  function inCleanup(destroy: string, capture: string, guard: string): string {
    return `
cleanup() {
  rc=$?
  set +e
  ${destroy}
${capture === '' ? '' : `  ${capture}\n`}  if [ "\${rc}" -eq 0 ]${guard}; then
    s3_purge_prefix_versions "\${B}" "\${P}" all || true
    s3_assert_versions_swept "\${B}" "\${P}" "x"
  else
    s3_purge_prefix_versions "\${B}" "\${P}" noncurrent || true
  fi
}
`;
  }

  const PIPED = '${CDKD} destroy "${STACK}" --force 2>&1 | tail -5 || true';
  const GOOD_GUARD = ' && [ "${destroy_rc}" -eq 0 ]';

  // Every spelling of "the destroy's status is thrown away", written the way a
  // person writes them rather than the way they are easiest to inject.
  it.each([
    ['pipe to tail plus || true', PIPED],
    ['pipe to tail alone', '${CDKD} destroy "${STACK}" --force 2>&1 | tail -5'],
    ['pipe to head', '${CDKD} destroy "${STACK}" --force | head -20'],
    ['pipe to grep', 'cdkd destroy "${STACK}" --force | grep -v Progress'],
    ['bare || true', 'cdkd destroy "${STACK}" --force || true'],
    ['node ${LOCAL_DIST} form', 'node "${LOCAL_DIST}" destroy "${STACK}" --force 2>&1 | tail -5 || true'],
    ['${CLI} form', '${CLI} destroy "${STACK}" --force 2>&1 | tail -5 || true'],
    [
      '${CLI} with a leading AWS_REGION assignment',
      'AWS_REGION="${CONSUMER_REGION}" ${CLI} destroy "${STACK}" --force 2>&1 | tail -5 || true',
    ],
    ['bare "${LOCAL_DIST}" form', '"${LOCAL_DIST}" destroy "${STACK}" --force | tail -5'],
    ['state destroy form', '${CDKD} state destroy "${STACK}" --yes 2>&1 | tail -3 || true'],
    ['redirect, no pipe', 'node "${LOCAL_DIST}" destroy "${STACK}" --force >/dev/null 2>&1'],
    [
      'backslash continuation',
      '${CDKD} destroy "${STACK}" \\\n    --state-bucket "${STATE_BUCKET}" --force 2>&1 | tail -5 || true',
    ],
    [
      'continuation with the pipe on the last line only',
      'node "${LOCAL_DIST}" destroy "${STACK}" \\\n    --region "${REGION}" \\\n    --force | tail -5',
    ],
  ])('flags an uncaptured destroy in a cleanup that purges `all` (%s)', (_label, destroy) => {
    expect(purgeModeViolations('f', inCleanup(destroy, '', '')).join('\n')).toMatch(
      /exit status is never captured/
    );
  });

  it('flags `$?` after a PIPED destroy -- the wrong status, which is the bug in the fix', () => {
    expect(purgeModeViolations('f', inCleanup(PIPED, 'destroy_rc=$?', GOOD_GUARD)).join('\n')).toMatch(
      /reads the status of the LAST stage of the pipe/
    );
  });

  it('flags an `all` purge whose guard never reads the captured status', () => {
    expect(
      purgeModeViolations('f', inCleanup(PIPED, 'destroy_rc=${PIPESTATUS[0]}', '')).join('\n')
    ).toMatch(/does not read every destroy's status \(unread: destroy_rc \(destroy at line \d+\)\)/);
  });

  // ---- TWO destroys: the case the `.some` bug made invisible ----------------
  function twoDestroys(guard: string): string {
    return `
cleanup() {
  rc=$?
  set +e
  AWS_REGION="\${CONSUMER_REGION}" \${CLI} destroy "\${CONSUMER_STACK}" --force >/dev/null 2>&1
  consumer_destroy_rc=$?
  AWS_REGION="\${PRODUCER_REGION}" \${CLI} destroy "\${PRODUCER_STACK}" --force >/dev/null 2>&1
  producer_destroy_rc=$?
  if [ "\${rc}" -eq 0 ]${guard}; then
    s3_purge_prefix_versions "\${B}" "\${CONSUMER_PREFIX}" all || true
    s3_purge_prefix_versions "\${B}" "\${PRODUCER_PREFIX}" all || true
  else
    s3_purge_prefix_versions "\${B}" "\${CONSUMER_PREFIX}" noncurrent || true
  fi
  exit "\${rc}"
}
`;
  }

  it.each([
    ['reads NEITHER status', ''],
    ['reads only the consumer status', ' && [ "${consumer_destroy_rc}" -eq 0 ]'],
    ['reads only the producer status', ' && [ "${producer_destroy_rc}" -eq 0 ]'],
  ])('with two destroys, a guard that %s is a violation', (_label, guard) => {
    // THE DODGE THIS RULE EXISTS FOR. `statusVars.some(...)` accepted any ONE
    // captured status, so dropping half the guard from a two-stack fixture was
    // green -- and a run whose consumer destroy succeeded while the PRODUCER's
    // failed would then take the `all` branch and delete the live producer
    // state.json along with every version of it.
    const v = purgeModeViolations('f', twoDestroys(guard)).join('\n');
    expect(v).toMatch(/does not read/);
    if (guard !== '') {
      const missing = guard.includes('consumer') ? 'producer_destroy_rc' : 'consumer_destroy_rc';
      expect(v, `must name the status the guard forgot (${missing})`).toContain(missing);
    }
  });

  it('two destroys capturing into the SAME variable is a clobber, not a pass', () => {
    // THE DODGE `.every` DID NOT CATCH. Copy-paste the one-destroy idiom and
    // both destroys capture `destroy_rc=$?`; `statusVars` was
    // ['destroy_rc','destroy_rc'] and a guard reading it ONCE satisfied every
    // element. Measured 0 violations. But the second `$?` has already
    // overwritten the first, so the FIRST destroy has no observable status at
    // all: a run whose first destroy failed takes the `all` branch and deletes
    // that stack's live state.json. The property is per-destroy observability;
    // distinct names are only how it is achieved.
    const script = `
cleanup() {
  rc=$?
  set +e
  \${CLI} destroy "\${CONSUMER_STACK}" --force >/dev/null 2>&1
  destroy_rc=$?
  \${CLI} destroy "\${PRODUCER_STACK}" --force >/dev/null 2>&1
  destroy_rc=$?
  if [ "\${rc}" -eq 0 ] && [ "\${destroy_rc}" -eq 0 ]; then
    s3_purge_prefix_versions "\${B}" "\${P}" all || true
  else
    s3_purge_prefix_versions "\${B}" "\${P}" noncurrent || true
  fi
}
`;
    const v = purgeModeViolations('f', script).join('\n');
    expect(v).toMatch(/CLOBBERED before any guard reads it/);
    expect(v).toContain('destroy_rc');
  });

  it('an `all` purge AFTER a closed `if … fi` is unguarded, not guarded by it', () => {
    // THE DODGE THE NEAREST-TOKEN WALK DID NOT CATCH. `fi` was never consulted,
    // so the purge below adopted the condition of a block that had already
    // closed -- measured 0 violations for a purge that runs unconditionally.
    const script = `
cleanup() {
  rc=$?
  set +e
  \${CLI} destroy "\${S}" --force >/dev/null 2>&1
  destroy_rc=$?
  if [ "\${rc}" -eq 0 ] && [ "\${destroy_rc}" -eq 0 ]; then
    echo "teardown ok"
  fi
  s3_purge_prefix_versions "\${B}" "\${P}" all || true
}
`;
    expect(purgeModeViolations('f', script).join('\n')).toMatch(
      /is not inside any if\/else block at all/
    );
  });

  it('a NESTED closed block does not hide the real enclosing guard', () => {
    // The depth counter must not overshoot: an inner `if … fi` INSIDE the
    // governing branch is skipped, and the outer `if` is still found.
    const script = `
cleanup() {
  rc=$?
  set +e
  \${CLI} destroy "\${S}" --force >/dev/null 2>&1
  destroy_rc=$?
  if [ "\${rc}" -eq 0 ] && [ "\${destroy_rc}" -eq 0 ]; then
    if [ -n "\${q_url}" ]; then
      aws sqs delete-queue --queue-url "\${q_url}" >/dev/null 2>&1
    fi
    s3_purge_prefix_versions "\${B}" "\${P}" all || true
  else
    s3_purge_prefix_versions "\${B}" "\${P}" noncurrent || true
  fi
}
`;
    expect(purgeModeViolations('f', script)).toEqual([]);
  });

  it('with two destroys, a guard reading BOTH statuses is accepted', () => {
    expect(
      purgeModeViolations(
        'f',
        twoDestroys(' && [ "${consumer_destroy_rc}" -eq 0 ] && [ "${producer_destroy_rc}" -eq 0 ]')
      )
    ).toEqual([]);
  });

  it('with two destroys, an UNRECOGNISED sibling is not covered by the recognised one', () => {
    // The `sawDestroy` flag stayed true from the recognised destroy, so the
    // unrecognised sibling's status went unchecked in silence.
    const script = twoDestroys(
      ' && [ "${consumer_destroy_rc}" -eq 0 ] && [ "${producer_destroy_rc}" -eq 0 ]'
    ).replace('AWS_REGION="${PRODUCER_REGION}" ${CLI} destroy', 'AWS_REGION="${PRODUCER_REGION}" ${SOME_NEW_TOOL} destroy');
    expect(purgeModeViolations('f', script).join('\n')).toMatch(/does not RECOGNISE the spelling/);
  });

  it('flags an `all` purge with no guard at all inside cleanup', () => {
    const script = `
cleanup() {
  rc=$?
  \${CDKD} destroy "\${STACK}" --force 2>&1 | tail -5 || true
  destroy_rc=\${PIPESTATUS[0]}
  s3_purge_prefix_versions "\${B}" "\${P}" all || true
}
`;
    expect(purgeModeViolations('f', script).join('\n')).toMatch(/guard: <none>/);
  });

  it('ACCEPTS an explaining COMMENT between the pipeline and the capture', () => {
    // A comment cannot clobber PIPESTATUS, and an explaining comment is
    // exactly what a person writes at this spot -- the fix in
    // local-run-task-from-state has eight lines of it. A rule demanding
    // literal line adjacency would have rejected the very form it asked for,
    // which is how this case was found.
    const script = `
cleanup() {
  rc=$?
  set +e
  \${CDKD} destroy "\${STACK}" --force 2>&1 | tail -5 || true
  # PIPESTATUS[0], not $?: the pipe to tail is what hides the failure.

  destroy_rc=\${PIPESTATUS[0]}
  if [ "\${rc}" -eq 0 ] && [ "\${destroy_rc}" -eq 0 ]; then
    s3_purge_prefix_versions "\${B}" "\${P}" all || true
  else
    s3_purge_prefix_versions "\${B}" "\${P}" noncurrent || true
  fi
}
`;
    expect(purgeModeViolations('f', script)).toEqual([]);
  });

  it('REJECTS an executing command between the pipeline and the capture', () => {
    // Anything that runs overwrites PIPESTATUS, so the capture would read the
    // echo's status. This is the half the comment-skipping must not let through.
    const script = `
cleanup() {
  rc=$?
  set +e
  \${CDKD} destroy "\${STACK}" --force 2>&1 | tail -5 || true
  echo "destroy attempted"
  destroy_rc=\${PIPESTATUS[0]}
  if [ "\${rc}" -eq 0 ] && [ "\${destroy_rc}" -eq 0 ]; then
    s3_purge_prefix_versions "\${B}" "\${P}" all || true
  else
    s3_purge_prefix_versions "\${B}" "\${P}" noncurrent || true
  fi
}
`;
    expect(purgeModeViolations('f', script).join('\n')).toMatch(/exit status is never captured/);
  });

  it('ACCEPTS the corrected form (PIPESTATUS captured AND read by the guard)', () => {
    expect(purgeModeViolations('f', inCleanup(PIPED, 'destroy_rc=${PIPESTATUS[0]}', GOOD_GUARD))).toEqual(
      []
    );
  });

  it('ACCEPTS `$?` after an UNPIPED destroy (there is no pipe to read past)', () => {
    expect(
      purgeModeViolations(
        'f',
        inCleanup('node "${LOCAL_DIST}" state destroy "${STACK}" --yes >/dev/null 2>&1', 'destroy_rc=$?', GOOD_GUARD)
      )
    ).toEqual([]);
  });

  it('flags an unconditional `aws s3 rm` that makes the noncurrent arm inert', () => {
    // NOTE the unrelated `if` above the rm. Without it this probe passed
    // against a predicate that keyed on the FIRST `if` in the body -- which is
    // a re-entry latch in two real fixtures, not the purge's guard.
    const script = `
cleanup() {
  rc=$?
  if [ "\${cleaned}" -eq 1 ]; then
    exit "\${rc}"
  fi
  cleaned=1
  \${CLI} destroy "\${S}" --force >/dev/null 2>&1
  destroy_rc=$?
  aws s3 rm "s3://\${B}/cdkd/\${S}/" --recursive >/dev/null 2>&1
  if [ "\${rc}" -eq 0 ] && [ "\${destroy_rc}" -eq 0 ]; then
    s3_purge_prefix_versions "\${B}" "\${P}" all || true
  else
    s3_purge_prefix_versions "\${B}" "\${P}" noncurrent || true
  fi
}
`;
    expect(purgeModeViolations('f', script).join('\n')).toMatch(/runs UNCONDITIONALLY, above the purge-mode branch/);
  });

  it('flags an unconditional `aws s3 rm` whose path is built from a VARIABLE', () => {
    // The dodge the literal-`cdkd/` check missed: no `cdkd/` on the line at all.
    const script = `
cleanup() {
  rc=$?
  \${CLI} destroy "\${S}" --force >/dev/null 2>&1
  destroy_rc=$?
  aws s3 rm "s3://\${STATE_BUCKET}/\${STATE_PREFIX}" --recursive >/dev/null 2>&1
  if [ "\${rc}" -eq 0 ] && [ "\${destroy_rc}" -eq 0 ]; then
    s3_purge_prefix_versions "\${B}" "\${P}" all || true
  else
    s3_purge_prefix_versions "\${B}" "\${P}" noncurrent || true
  fi
}
`;
    expect(purgeModeViolations('f', script).join('\n')).toMatch(/runs UNCONDITIONALLY/);
  });

  it('ACCEPTS the same `aws s3 rm` once it is inside the success branch', () => {
    const script = `
cleanup() {
  rc=$?
  \${CLI} destroy "\${S}" --force >/dev/null 2>&1
  destroy_rc=$?
  if [ "\${rc}" -eq 0 ] && [ "\${destroy_rc}" -eq 0 ]; then
    aws s3 rm "s3://\${B}/cdkd/\${S}/" --recursive >/dev/null 2>&1
    s3_purge_prefix_versions "\${B}" "\${P}" all || true
  else
    s3_purge_prefix_versions "\${B}" "\${P}" noncurrent || true
  fi
}
`;
    expect(purgeModeViolations('f', script)).toEqual([]);
  });

  it('ACCEPTS a cleanup that only ever purges `noncurrent` (the safe mode)', () => {
    // This is what fourteen of the sixteen callers do, and flagging them would
    // be an 88% false-positive rate on the population the rule runs over.
    const script = `
cleanup() {
  rc=$?
  node "\${LOCAL_DIST}" state destroy "\${STACK}" --yes >/dev/null 2>&1
  s3_purge_prefix_versions "\${B}" "\${P}" noncurrent || true
}
`;
    expect(purgeModeViolations('f', script)).toEqual([]);
  });

  it('ACCEPTS an `all` purge on the SUCCESS PATH, outside cleanup', () => {
    const script = `
cleanup() {
  s3_purge_prefix_versions "\${B}" "\${P}" noncurrent || true
}
trap cleanup EXIT
node "\${LOCAL_DIST}" destroy "\${STACK}" --force
cleanup
trap - EXIT INT TERM
s3_purge_prefix_versions "\${B}" "\${P}" all || true
s3_assert_versions_swept "\${B}" "\${P}" "x"
`;
    expect(purgeModeViolations('f', script)).toEqual([]);
  });

  it('classifies the AWS CDK CLI as NOT a cdkd destroy', () => {
    // `cdk destroy` tears down a CloudFormation stack; its status says nothing
    // about whether cdkd's state record is still needed. Three fixtures in the
    // tree use it, so this is a real distinction rather than a hypothetical.
    for (const line of ['npx cdk destroy --force', '(cd "${TEST_DIR}" && cdk destroy --force)']) {
      expect(isCdkdDestroy(line), line).toBe(false);
      expect(NON_CDKD_DESTROY.test(line), line).toBe(true);
    }
    expect(isCdkdDestroy('${CLI} destroy "${S}" --force')).toBe(true);
    expect(NON_CDKD_DESTROY.test('${CLI} destroy "${S}" --force')).toBe(false);
  });

  it('reports an UNRECOGNISED invocation as such, not as a missing guard', () => {
    const script = `
cleanup() {
  rc=$?
  \${SOME_NEW_SPELLING} destroy "\${STACK}" --force
  if [ "\${rc}" -eq 0 ]; then
    s3_purge_prefix_versions "\${B}" "\${P}" all || true
  fi
}
`;
    expect(purgeModeViolations('f', script).join('\n')).toMatch(/does not RECOGNISE the spelling/);
  });

  it('a cleanup with NO destroy line at all still reports the missing teardown', () => {
    const script = `
cleanup() {
  rc=$?
  aws s3 rm "s3://\${B}/\${K}" >/dev/null 2>&1 || true
  if [ "\${rc}" -eq 0 ]; then
    s3_purge_prefix_versions "\${B}" "\${P}" all || true
  fi
}
`;
    expect(purgeModeViolations('f', script).join('\n')).toMatch(
      /no cdkd destroy invocation was RECOGNISED/
    );
  });

  it('the marker list has no DEAD entries and covers every spelling in the tree', () => {
    // An executable floor on the claim "every spelling was enumerated from the
    // tree", which was asserted in prose and was WRONG (unbraced `$CDKD`). Every
    // destroy-looking line in every fixture must be classified as either a cdkd
    // destroy or the AWS CDK CLI -- nothing may fall through unlabelled.
    const unclassified: string[] = [];
    let cdkdCount = 0;
    for (const e of readdirSync(INTEG_ROOT, { withFileTypes: true })) {
      const f = join(INTEG_ROOT, e.name, 'verify.sh');
      if (!e.isDirectory() || !existsSync(f)) continue;
      for (const l of logicalLines(readFileSync(f, 'utf8'))) {
        if (!looksLikeDestroyInvocation(l.text)) continue;
        const code = uncomment(l.text);
        if (NON_CDKD_DESTROY.test(code)) continue;
        if (isCdkdDestroy(l.text)) {
          cdkdCount += 1;
          continue;
        }
        // Prose inside a string, or a genuinely new spelling. Only the latter
        // matters, so ignore lines with no command-ish shape.
        if (/^\s*[A-Za-z_"'`$(\[]/.test(code.trim())) unclassified.push(`${e.name}: ${code.trim().slice(0, 100)}`);
      }
    }
    expect(cdkdCount, 'no cdkd destroy invocations found — the classifier is inert').toBeGreaterThan(150);
    expect(unclassified.sort()).toEqual([]);
    // ...and no marker may be DEAD. `${BIN}` was in the list with zero
    // occurrences in the tree, which is a fence guarding nothing.
    const allScripts = readdirSync(INTEG_ROOT, { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(INTEG_ROOT, e.name, 'verify.sh')))
      .map((e) => readFileSync(join(INTEG_ROOT, e.name, 'verify.sh'), 'utf8'))
      .join('\n');
    const dead = CDKD_INVOCATION_MARKERS.filter((re) => !re.test(allScripts));
    expect(dead.map(String), 'marker matches nothing in the tree — drop it or measure it').toEqual([]);
  });

  it('does NOT fire on prose, comments, or a non-cdkd teardown command', () => {
    for (const line of [
      '# ${CDKD} destroy "${STACK}" --force 2>&1 | tail -5 || true',
      'echo "then run cdkd destroy | tail -5"',
      'aws secretsmanager delete-secret --secret-id "${S}" 2>&1 | tail -1 || true',
      'aws s3 rm "s3://${B}/${K}" >/dev/null 2>&1 || true',
      'docker ps -a --filter name=x | xargs -r docker rm -f || true',
    ]) {
      expect(
        purgeModeViolations('f', inCleanup(`${line}\n  node "\${LOCAL_DIST}" destroy "\${S}" --force\n  destroy_rc=$?`, '', GOOD_GUARD)),
        line
      ).toEqual([]);
    }
  });
});

/**
 * Every fixture that SOURCES the helper.
 *
 * Derived from the source line -- a relation a purging fixture cannot omit.
 * Deriving the population from the DEFECT instead (say, "fixtures that pipe a
 * destroy") would drop each subject OUT of the set the moment it was fixed,
 * and the suite would then pass by scanning nothing.
 */
function helperCallers(): Fixture[] {
  return readdirSync(INTEG_ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(INTEG_ROOT, e.name, 'verify.sh')))
    .map((e) => ({ name: e.name, script: readFileSync(join(INTEG_ROOT, e.name, 'verify.sh'), 'utf8') }))
    .filter((f) => /^[ \t]*(\.|source)[ \t]+.*s3-versions\.sh/m.test(f.script));
}

/**
 * Claims about this helper are repeated in prose across docs, rules and test
 * comments, and correcting one site at a time has now failed three times in a
 * single lane: a count was fixed in `docs/testing.md` while four more copies
 * stood, and the "no fixture in the swept set has a nested stack" and "every
 * caller wraps the purge in `|| true`" sentences each survived their own
 * correction in two other files.
 *
 * So the correction is a FENCE, not an edit. Each entry is a claim that was
 * MEASURED FALSE; the residual must stay zero everywhere prose about this
 * subsystem lives. The fix for a failure here is to correct the new site, not
 * to narrow the pattern.
 */
/**
 * Each claim carries its OWN retired sentence, exactly as `Pattern.sample` does
 * in the sweep lint. A hand-written parallel `retired` array indexed against
 * this one meant a fourth claim would silently get no liveness sample -- the
 * same structural bug the sweep lint had already been taught to avoid, repeated
 * here because the two lists were written months apart.
 */
const FALSIFIED_CLAIMS: readonly {
  readonly why: string;
  readonly re: RegExp;
  /** A sentence this pattern MUST still match, so a rotted regex fails loudly. */
  readonly retired: string;
}[] = [
  {
    retired: 'and since every caller wraps the purge in `|| true`, a mis-derived prefix', // falsified sample
    why:
      'FALSE: three call sites omit `|| true` (nested-stack-secret twice, stack-lock-renewal). ' +
      'They are safe because they sit inside `cleanup` under `set +e`, which is what the prose must say.',
    re: /every caller wrap(s|ping) the purge in/i,
  },
  {
    retired: 'not reached — no fixture in the swept set has one today; tracked', // falsified sample
    why:
      'FALSE since nested-stack-secret joined the swept set: it builds a real cdk.NestedStack and ' +
      'already sweeps both PARENT_PREFIX and CHILD_PREFIX.',
    re: /no fixture in the swept set (has|creates) one today/i,
  },
  {
    retired: 'a bash-4-ism in a file twelve fixtures source is where it does the most damage', // falsified sample
    why: 'STALE COUNT: sixteen fixtures source the helper, not twelve or fifteen.',
    re: /\b(twelve|fifteen) fixtures\b/i,
  },
];

describe('claims this lane corrected stay corrected TREE-WIDE', () => {
  const ROOTS = ['docs', '.claude/rules', 'tests/unit/scripts', 'tests/integration'];

  function proseFiles(): { path: string; text: string }[] {
    const out: { path: string; text: string }[] = [];
    const repo = join(import.meta.dirname, '../../..');
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name.startsWith('.git')) continue;
        const full = join(dir, e.name);
        if (e.isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.(md|sh|ts)$/.test(e.name)) continue;
        out.push({ path: full.slice(repo.length + 1), text: readFileSync(full, 'utf8') });
      }
    };
    for (const r of ROOTS) {
      const d = join(repo, r);
      if (existsSync(d)) walk(d);
    }
    return out;
  }

  const files = proseFiles();

  it('scans a real corpus (guards against passing by reading nothing)', () => {
    expect(files.length).toBeGreaterThan(300);
    expect(files.some((f) => f.path === 'docs/testing.md')).toBe(true);
    expect(files.some((f) => f.path === '.claude/rules/testing.md')).toBe(true);
    expect(files.some((f) => f.path === 'tests/integration/s3-versions.sh')).toBe(true);
  });

  it.each(FALSIFIED_CLAIMS.map((c) => [c.re.source, c] as const))(
    'no file still asserts /%s/',
    (_src, claim) => {
      const hits = files
        .flatMap((f) =>
          f.text
            .split('\n')
            .map((line, i) => ({ line, n: i + 1 }))
            // The claim text is QUOTED in the corrections themselves ("this
            // used to say ..."), so a line that explicitly marks it as former
            // is not a residual.
            .filter(({ line }) => claim.re.test(line) && !/used to|no longer|FALSE|falsified/i.test(line))
            .map(({ n }) => `${f.path}:${n}`)
        )
        .sort();
      expect(hits, claim.why).toEqual([]);
    }
  );

  it('the patterns are LIVE: each still matches the sentence it retired', () => {
    // Derived from the records themselves, so a claim added later cannot arrive
    // without a sample.
    for (const claim of FALSIFIED_CLAIMS) {
      expect(claim.retired.trim().length, `claim /${claim.re.source}/ has no retired sample`).toBeGreaterThan(20);
      expect(claim.re.test(claim.retired), `pattern /${claim.re.source}/ no longer matches its own subject`).toBe(
        true
      );
    }
  });
});

describe('helper callers: the purge MODE must follow the DESTROY, not the script (#2225)', () => {
  const callers = helperCallers();

  it('finds the caller population', () => {
    // A FLOOR that names PERIPHERAL members, not only the central one: a
    // population that quietly shrank to the single fixture this rule was
    // written against would let the rule pass while covering nothing.
    expect(callers.length).toBeGreaterThanOrEqual(16);
    const names = callers.map((f) => f.name);
    for (const required of [
      'local-run-task-from-state',
      'secrets-dynamic-ref',
      'cross-stack-secret-import',
      'dynamic-ref-cross-region',
      'nested-stack-secret',
      'stack-lock-renewal',
      'apigw-usage-plan-key',
      'deletion-policy-snapshot-heavy',
      'iam-access-key',
      'lambda-esm-self-managed-kafka',
      'rollback-cross-region-secret',
    ]) {
      expect(names, `${required} stopped sourcing the sweep helper`).toContain(required);
    }
  });

  it('the rule has a SUBJECT: callers purge, and at least one does so inside cleanup', () => {
    // Without this, the rule below could pass over a tree in which nothing
    // purges at all -- "found nothing" reading as "everything complies".
    // COMMENT-STRIPPED, like every other predicate in this file. Reading the
    // raw script let a comment MENTIONING an `all` purge satisfy the floor,
    // which is the one place a floor must not be satisfiable by prose.
    const purging = callers.filter((f) =>
      logicalLines(f.script).some((l) => /s3_purge_prefix_versions[^\n]*\ball\b/.test(uncomment(l.text)))
    );
    expect(purging.length).toBeGreaterThanOrEqual(14);
    const inCleanupBody = callers.filter((f) => {
      const b = cleanupBody(logicalLines(f.script));
      return b !== undefined && b.some((l) => /s3_purge_prefix_versions[^\n]*\ball\b/.test(uncomment(l.text)));
    });
    // BOTH cleanup-scoped callers named, not just the one that prompted the
    // rule: if either dropped out the rule would still have a subject and the
    // loss would be invisible.
    for (const n of ['local-run-task-from-state', 'rollback-cross-region-secret']) {
      expect(
        inCleanupBody.map((f) => f.name),
        `${n} no longer purges \`all\` from cleanup, so the #2225 rule covers less than it did`
      ).toContain(n);
    }
  });

  it('no caller gates a version purge on the wrong exit status', () => {
    expect(callers.flatMap((f) => purgeModeViolations(f.name, f.script)).sort()).toEqual([]);
  });

  it('a fixture that DISARMS its trap must assert AFTER the disarm (trap 1)', () => {
    // Trap 1: `trap - EXIT INT TERM` on the success path means a trap-only
    // sweep never runs on the normal path. If a fixture disarms, the assertion
    // has to come after -- otherwise nothing looks at the bucket at the end.
    const violations: string[] = [];
    for (const f of callers) {
      const lines = f.script.split('\n');
      const disarm = lines.findIndex((l) => /^[^\n#]*\btrap\b[ \t]+-[ \t]+.*EXIT/.test(l));
      if (disarm < 0) continue;
      const after = lines.slice(disarm + 1).join('\n');
      if (!/^[^\n#]*\bs3_assert_versions_swept[ \t]+\S/m.test(after)) {
        violations.push(
          `${f.name}/verify.sh:${disarm + 1}: disarms its EXIT trap but never calls s3_assert_versions_swept ` +
            `afterwards -- a trap-only sweep runs on the FAILURE path and never on the normal one (trap 1).`
        );
      }
    }
    expect(violations.sort()).toEqual([]);
  });
});
