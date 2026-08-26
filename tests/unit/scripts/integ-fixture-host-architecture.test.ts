/**
 * Fence for the arm64 RIE segfault (go-to-k/cdk-local#560, cdkd side).
 *
 * cdk-local pins `docker --platform` to each Lambda's declared `Architectures`
 * (`pullImage` / `architectureToPlatform`). A CDK `lambda.Function` that
 * declares no `architecture` defaults to `x86_64`, so on an arm64 host its
 * container runs `linux/amd64` under CPU emulation -- where the Go RIE inside
 * `public.ecr.aws/lambda/nodejs:20` faults, failing a DIFFERENT assertion on
 * every run. Measured 2026-08-27 on arm64 against `758f1c6b`:
 *
 *   local-start-api  RC=1 DUR=623s  `fatal error: qemu: uncaught target signal
 *                                    11 (Segmentation fault) - core dumped`
 *   local-invoke     RC=1 DUR=35s   same fault at step 6/6
 *
 * The two fixtures below therefore declare the HOST's architecture, which is
 * native on an Apple Silicon dev host and on an x86_64 CI runner alike.
 *
 * This test exists because the failure mode is SILENT AND ENVIRONMENT-
 * DEPENDENT in the direction that hides it: a handler added without
 * `architecture` passes on CI (amd64, where the default IS the host arch) and
 * reintroduces an arm64-only flake that costs another diagnosis cycle. CI can
 * never catch that regression by running the integ; only a source-shape check
 * can.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');

/**
 * Listed as LITERALS on purpose.
 *
 * Deriving this from a directory scan would do two harmful things at once: it
 * would go blind to a fixture being dropped from the set, and it would widen
 * the fence to fixtures nobody has run on an arm64 host. 16 further `local-*`
 * fixtures still declare no architecture (go-to-k/cdkd#2287); they join this
 * list one at a time, after a green arm64 run each.
 */
const FIXTURE_STACKS = [
  'tests/integration/local-start-api/lib/local-start-api-stack.ts',
  'tests/integration/local-invoke/lib/local-invoke-stack.ts',
];

/** The one Lambda constructor spelling both fixtures are required to use. */
const CANONICAL_CTOR = 'new lambda.Function(';

/**
 * Every `new <Something>Function(` constructor call, in any spelling.
 *
 * `lambdaFunctionCalls` below keys off the single canonical spelling, so on its
 * own it would report a clean pass for a handler added as `NodejsFunction` /
 * `lambda.DockerImageFunction` / a named-import `new Function(` / even
 * `new lambda.Function (` with a space -- i.e. it would be blind to exactly the
 * "someone adds a handler" case this file exists to catch. This is not
 * hypothetical across the wider fixture set: `local-*` currently contains four
 * spellings (`lambda.Function`, `lambda.CfnFunction`, `lambda.DockerImageFunction`,
 * `cloudfront.Function`), and the last is not a Lambda at all. Matching the
 * broad shape and then REQUIRING every hit to be canonical turns an
 * unrecognized spelling into a loud failure instead of a silent pass.
 */
const ANY_FUNCTION_CTOR = /new\s+(?:[A-Za-z_$][\w$]*\s*\.\s*)?[\w$]*Function\s*\(/g;

/**
 * The exact derivation both fixtures must carry, whitespace-normalized.
 *
 * Hardcoding either architecture merely moves the emulation to the other host:
 * `ARM_64` makes an amd64 CI runner emulate, and `X86_64` is the default that
 * caused the fault in the first place. Only the host-derived form is native on
 * both, so the fence pins the derivation rather than the outcome.
 */
const HOST_ARCH_DERIVATION =
  "const HOST_ARCHITECTURE = process.arch === 'arm64' ? " +
  'lambda.Architecture.ARM_64 : lambda.Architecture.X86_64;';

/**
 * The source text of every `new lambda.Function(...)` call in `source`,
 * delimited by paren matching rather than a line regex, so both the
 * single-line and the wrapped `new lambda.Function(\n  this,\n  'Id',\n  {...}\n)`
 * spellings are covered (`local-start-api` uses both).
 */
function lambdaFunctionCalls(source: string): string[] {
  const calls: string[] = [];
  let from = 0;
  for (;;) {
    const start = source.indexOf(CANONICAL_CTOR, from);
    if (start === -1) break;
    let depth = 0;
    let end = start + CANONICAL_CTOR.length - 1;
    for (let i = start + CANONICAL_CTOR.length - 1; i < source.length; i++) {
      const ch = source[i];
      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    calls.push(source.slice(start, end + 1));
    from = end + 1;
  }
  return calls;
}

describe('integ fixture Lambdas run at the host architecture (go-to-k/cdk-local#560)', () => {
  for (const relPath of FIXTURE_STACKS) {
    describe(relPath, () => {
      // Read inside each test rather than at collection time, so a renamed or
      // deleted fixture fails as a NAMED test rather than as a suite-level
      // ENOENT that names no expectation.
      const read = (): string => readFileSync(join(REPO_ROOT, relPath), 'utf8');

      it('derives HOST_ARCHITECTURE from process.arch rather than hardcoding either value', () => {
        expect(
          read().replace(/\s+/g, ' '),
          `${relPath} must define HOST_ARCHITECTURE from process.arch. Hardcoding ` +
            `ARM_64 makes an amd64 CI runner emulate; hardcoding X86_64 is the default ` +
            `that caused go-to-k/cdk-local#560 on arm64.`
        ).toContain(HOST_ARCH_DERIVATION);
      });

      it('defines its Lambdas only via the canonical `new lambda.Function(` spelling', () => {
        // Guards the assumption the next test depends on. Without it, a handler
        // added as `NodejsFunction` / `DockerImageFunction` / `new Function(`
        // would not be found at all, and "every construct declares the
        // architecture" would be VACUOUSLY true of it.
        const source = read();
        const found = [...source.matchAll(ANY_FUNCTION_CTOR)].map((m) => m[0]);
        const nonCanonical = found.filter((spelling) => spelling !== CANONICAL_CTOR);
        expect(
          nonCanonical,
          `${relPath}: found Lambda constructor spelling(s) this fence does not ` +
            `understand. Either use \`${CANONICAL_CTOR}\`, or teach ` +
            `lambdaFunctionCalls() the new spelling -- otherwise the architecture ` +
            `check silently skips those constructs.`
        ).toEqual([]);
        expect(found.length, `${relPath} should declare at least one Lambda`).toBeGreaterThan(0);
      });

      it('declares architecture: HOST_ARCHITECTURE on every lambda.Function', () => {
        const source = read();
        const calls = lambdaFunctionCalls(source);
        // The two counts must agree, or the paren matcher mis-delimited a call
        // and the filter below ran over the wrong text.
        expect(
          calls.length,
          `${relPath}: paren matcher and regex disagree on the Lambda count`
        ).toBe([...source.matchAll(ANY_FUNCTION_CTOR)].length);
        expect(calls.length, `${relPath} should declare at least one Lambda`).toBeGreaterThan(0);

        const missing = calls
          .filter((call) => !call.includes('architecture: HOST_ARCHITECTURE'))
          // Name the offender by its construct id, so the failure points at the
          // function to fix rather than at a count.
          .map(
            (call) =>
              /new lambda\.Function\(\s*this,\s*'([^']+)'/.exec(call)?.[1] ?? call.slice(0, 80)
          );
        expect(
          missing,
          `${relPath}: these lambda.Function constructs are missing ` +
            `\`architecture: HOST_ARCHITECTURE\`, which reintroduces the amd64-emulation ` +
            `segfault on arm64 hosts for them (go-to-k/cdk-local#560). Note this passes ` +
            `on CI, where amd64 IS the default.`
        ).toEqual([]);
      });
    });
  }

  it('pins the fixture count, so a fixture silently leaving the list is loud', () => {
    // The list is literals precisely so it can shrink by accident; this is what
    // makes that accident fail. Raise it as fixtures from go-to-k/cdkd#2287 join.
    expect(FIXTURE_STACKS.length).toBe(2);
    expect(new Set(FIXTURE_STACKS).size).toBe(FIXTURE_STACKS.length);
  });
});
