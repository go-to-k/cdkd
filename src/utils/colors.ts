/**
 * ANSI color helpers for inline wrapping. Always emit ANSI escape codes —
 * the terminal (or vhs / a downstream piped consumer) decides whether to
 * render them.
 *
 * Kept in its own module so unit tests that mock `logger.ts` (a common
 * pattern) do not also strip color helpers and crash any code path that
 * uses them. Import from here, not from `logger.ts`, in production code.
 */

const codes = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
} as const;

export const green = (s: string | number): string => `${codes.green}${s}${codes.reset}`;
export const yellow = (s: string | number): string => `${codes.yellow}${s}${codes.reset}`;
export const red = (s: string | number): string => `${codes.red}${s}${codes.reset}`;
export const cyan = (s: string | number): string => `${codes.cyan}${s}${codes.reset}`;
export const gray = (s: string | number): string => `${codes.gray}${s}${codes.reset}`;
export const bold = (s: string | number): string => `${codes.bright}${s}${codes.reset}`;
export const dim = (s: string | number): string => `${codes.dim}${s}${codes.reset}`;
