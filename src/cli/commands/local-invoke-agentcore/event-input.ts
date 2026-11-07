import { readFileSync } from 'node:fs';
import { getLogger } from '../../../utils/logger.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import {
  describeJsonParseFailure,
  parseFailureDebugDetail,
  utf8ByteLength,
} from '../../../utils/json-parse-failure.js';
import { safeMsg } from '../../../utils/display-safe.js';
import { CdkdError } from '../../../utils/error-handler.js';
import { type EnvOverrideFile } from '../../../local/env-resolver.js';
import type { LocalInvokeAgentCoreOptions } from './types.js';

export async function readEvent(options: LocalInvokeAgentCoreOptions): Promise<unknown> {
  if (options.event && options.eventStdin) {
    throw new CdkdError(
      '--event and --event-stdin are mutually exclusive.',
      'LOCAL_INVOKE_AGENTCORE_EVENT_FLAG_CONFLICT'
    );
  }
  if (options.eventStdin) {
    return parseEvent(await readStdin(), '<stdin>');
  }
  if (options.event) {
    let raw: string;
    try {
      raw = readFileSync(options.event, 'utf-8');
    } catch (err) {
      throw new CdkdError(
        `Failed to read --event file '${options.event}': ${describeAwsFailure(err).detail}`,
        'LOCAL_INVOKE_AGENTCORE_EVENT_READ_FAILED'
      );
    }
    return parseEvent(raw, options.event);
  }
  return {};
}

export function parseEvent(raw: string, source: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (err) {
    // V8's `SyntaxError` quotes a window of the payload, so the message names
    // only the failure's offset and size; V8's text goes to `debug` only
    // (issue #5254).
    getLogger().debug(safeMsg`Event payload failed to parse: ${parseFailureDebugDetail(err)}`);
    throw new CdkdError(
      `Failed to parse event payload from ${source} as JSON: ${describeJsonParseFailure(err, utf8ByteLength(raw))}`,
      'LOCAL_INVOKE_AGENTCORE_EVENT_PARSE_FAILED'
    );
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin as AsyncIterable<Buffer | string>) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

/**
 * Read `process.stdin` line-buffered and yield each line as a string (trailing
 * `\r?\n` stripped). The async iterable completes when stdin EOFs (Ctrl-D /
 * end-of-pipe), and surrenders the underlying stream when its `return()` is
 * called — so the WS client can close down the source when the server closes
 * first without leaving stdin held open.
 *
 * Exported so a unit test can drive the iterable shape directly.
 */
export async function* readStdinLines(): AsyncIterable<string> {
  const { createInterface } = await import('node:readline');
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      // Skip strictly-empty lines in interactive mode. Without this, pressing
      // Enter without typing sends an empty WS text frame; a loop-mode agent
      // (e.g. the integ fixture's EchoAgent) then replies with a half-line
      // like `loop-echo:` that visually corrupts the REPL. A whitespace-only
      // line is NOT skipped — sending spaces can be a deliberate signal for
      // some agents.
      if (line.length === 0) continue;
      yield line;
    }
  } finally {
    rl.close();
  }
}

/**
 * REPL prompt indicator for the auto-detected TTY mode. Written to stdout (no
 * trailing newline) after each received agent frame, so the user has a clear
 * visual signal that the REPL is waiting for input.
 *
 * Exported so a unit test can assert the prompt shape.
 */
export const WS_REPL_PROMPT = '> ';

/**
 * Wrap `onMessage` so each agent WS text frame lands on its own line when the
 * auto-REPL is active AND a `> ` prompt indicator follows. WS frames carry no
 * trailing `\n` by protocol (each frame is a discrete message); the cloud
 * `/ws` endpoint behaves the same. That's correct on the wire but visually
 * run-on in an interactive terminal — the user's next keystroke concatenates
 * onto the last frame's tail char and they have no signal that the REPL is
 * waiting for input. When the prompt is on, we append `\n` (unless already
 * present) and then write a `> ` prompt, so each agent message is presented as
 * its own line and the next input prompt is visible.
 *
 * The gate is `promptOnStdout` — stdin a TTY AND stdout a TTY — not stdin
 * alone (issue [#2410](https://github.com/go-to-k/cdkd/issues/2410)). Reading
 * follow-up frames from stdin is a stdin question and keeps its own check at
 * the call site; writing a prompt is a STDOUT question, and stdout is this
 * command's payload stream. With a REDIRECTED stdout the raw
 * WS-protocol-faithful pass-through is what a consumer parses, so a terminal
 * stdin no longer drags a `> ` into it.
 *
 * Exported so a unit test can drive the wrapping without the full WS pipeline.
 */
export function wrapWsOnMessage(
  sink: (text: string) => void,
  promptOnStdout: boolean
): (text: string) => void {
  if (!promptOnStdout) return sink;
  return (text) => {
    sink(text.endsWith('\n') ? text : `${text}\n`);
    sink(WS_REPL_PROMPT);
  };
}

export function readEnvOverridesFile(filePath: string | undefined): EnvOverrideFile | undefined {
  if (!filePath) return undefined;
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch (err) {
    throw new CdkdError(
      `Failed to read --env-vars file '${filePath}': ${describeAwsFailure(err).detail}`,
      'LOCAL_INVOKE_AGENTCORE_ENV_VARS_READ_FAILED'
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // V8's `SyntaxError` quotes a window of the file, which holds env values
    // (often secrets), so the message names only the failure's offset and
    // size; V8's text goes to `debug` only (issue #5254).
    getLogger().debug(safeMsg`--env-vars file failed to parse: ${parseFailureDebugDetail(err)}`);
    throw new CdkdError(
      `Failed to parse --env-vars file '${filePath}' as JSON: ${describeJsonParseFailure(err, utf8ByteLength(raw))}`,
      'LOCAL_INVOKE_AGENTCORE_ENV_VARS_PARSE_FAILED'
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CdkdError(
      `--env-vars file '${filePath}' must contain a JSON object at the top level.`,
      'LOCAL_INVOKE_AGENTCORE_ENV_VARS_NOT_OBJECT'
    );
  }
  return parsed as EnvOverrideFile;
}
