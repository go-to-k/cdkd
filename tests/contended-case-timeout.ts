/**
 * The per-case bound for a unit test whose cost is a walk of the REAL source
 * tree, a copy of it, a generator run over the providers, or an equally
 * CPU-bound enumeration — as opposed to a test of one function on a fixture
 * (go-to-k/cdkd#3607).
 *
 * Vitest's 5 s default, and the 15 s / 60 s / 120 s bounds these files carried
 * before, were sized from local or CI timings that never included a second
 * suite on the same machine. A full suite runs one worker per
 * core, and another session's suite on the same machine doubles that, so a
 * CPU-bound case slows by whatever the contention is. Measured on 2026-09-26
 * over the files #3607 names: the slowest case took 33.5 s alone and the worst
 * contended slowdown was about 8x (a case that took 11.3 s alone took 90.5 s
 * with another session's suite running), which is where 300 s comes from —
 * 33.5 s x 8 is 268 s. Those are one machine's numbers; re-measure before
 * narrowing this.
 *
 * A bound here exists to stop a HANG, not to police latency — and only a hang
 * that yields to the event loop: Vitest cannot interrupt a synchronous loop or
 * a blocking `spawnSync`, so a spawning case passes the same value as the
 * spawn's own `timeout` option. A case that
 * regresses from 2 s to 20 s is a real finding, but the 5 s default reports it
 * as a timeout indistinguishable from a machine that was busy. Prefer removing
 * the repeated work first (a scan shared at collection time, where no per-case
 * bound applies) and use this for what remains.
 */
export const CONTENDED_CASE_TIMEOUT_MS = 300_000;
