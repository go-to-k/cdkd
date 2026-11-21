/**
 * go-to-k/cdkd#6705: how a template's user data calls `cfn-init` /
 * `cfn-signal`, by the resource each call names, for the signal receiver's
 * fail-safe candidate rule (`signal-receiver.ts`'s `signalPlanOf`).
 */

/** How the template's user data calls `cfn-init` / `cfn-signal` for one resource. */
export interface BootstrapCalls {
  signedSignal: boolean;
  signedInit: boolean;
  /** A call naming the resource without credentials (`--role` etc.). */
  unsigned: boolean;
}

/** Every `cfn-init` / `cfn-signal` call in the template's user data, by the resource it names. */
export function bootstrapCallsByResource(
  resources: Record<string, unknown>
): Map<string, BootstrapCalls> {
  const out = new Map<string, BootstrapCalls>();
  for (const script of userDataScriptsOf(resources)) {
    for (const command of commandsOf(script)) {
      const call = parseBootstrapCall(command);
      if (call === undefined) continue;
      const entry = out.get(call.resource) ?? {
        signedSignal: false,
        signedInit: false,
        unsigned: false,
      };
      if (!call.signed) entry.unsigned = true;
      else if (call.kind === 'signal') entry.signedSignal = true;
      else entry.signedInit = true;
      out.set(call.resource, entry);
    }
  }
  return out;
}

const TOKEN_PLACEHOLDER = '__CDKD_TOKEN__';
const CREDENTIAL_FLAGS = new Set(['--role', '--access-key', '--credential-file', '-f']);

/** Every `UserData` value in the template (instances, launch templates, launch configurations), as script text. */
function userDataScriptsOf(resources: Record<string, unknown>): string[] {
  const out: string[] = [];
  const walk = (value: unknown, depth: number): void => {
    if (depth > 12 || value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const v of value) walk(v, depth + 1);
      return;
    }
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      if (key === 'UserData') out.push(renderScript(inner, true));
      else walk(inner, depth + 1);
    }
  };
  for (const resource of Object.values(resources)) {
    if (resource !== null && typeof resource === 'object') {
      walk((resource as { Properties?: unknown }).Properties, 0);
    }
  }
  return out;
}

/** The text a user-data value renders to; every unresolved reference becomes a placeholder. */
function renderScript(value: unknown, topLevel = false): string {
  if (typeof value === 'string') {
    if (topLevel && /^[A-Za-z0-9+/=\s]+$/.test(value) && value.length >= 8) {
      const decoded = Buffer.from(value, 'base64').toString('utf8');
      if (/^[\x09\x0a\x0d\x20-\x7e]*$/.test(decoded)) return decoded;
    }
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return TOKEN_PLACEHOLDER;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length !== 1) return TOKEN_PLACEHOLDER;
  const [fn, arg] = entries[0]!;
  if (fn === 'Fn::Base64') return renderScript(arg);
  if (
    fn === 'Fn::Join' &&
    Array.isArray(arg) &&
    typeof arg[0] === 'string' &&
    Array.isArray(arg[1])
  ) {
    return (arg[1] as unknown[]).map((part) => renderScript(part)).join(arg[0]);
  }
  if (fn === 'Fn::Sub') {
    const body = typeof arg === 'string' ? arg : Array.isArray(arg) ? arg[0] : undefined;
    if (typeof body === 'string') return body.replace(/\$\{[^!][^}]*\}/g, TOKEN_PLACEHOLDER);
  }
  return TOKEN_PLACEHOLDER;
}

/** The script's commands: line continuations joined, split at newlines and `;` `&&` `||` `|`. */
function commandsOf(script: string): string[] {
  return script
    .replace(/\\\r?\n/g, ' ')
    .split(/\r?\n|;|&&|\|\||\|/)
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
}

/**
 * A `cfn-init` / `cfn-signal` (Linux path or `.exe`) or `aws cloudformation
 * signal-resource` command: which resource it names and whether it passes
 * credentials. `undefined` for anything else, or one naming no resource.
 */
export function parseBootstrapCall(
  command: string
): { kind: 'init' | 'signal'; resource: string; signed: boolean } | undefined {
  const tokens = command
    .split(/\s+/)
    .map((t) => t.replace(/^[[("',]+|[\]),"']+$/g, ''))
    .filter((t) => t.length > 0);
  const at = tokens.findIndex((t) => /(?:^|[/\\])cfn-(?:init|signal)(?:\.exe)?$/i.test(t));
  if (at !== -1) {
    const kind = /init(?:\.exe)?$/i.test(tokens[at]!) ? 'init' : 'signal';
    const args = tokens.slice(at + 1);
    const resource = flagValue(args, ['--resource', '-r']);
    if (resource === undefined) return undefined;
    const signed = args.some((t) => CREDENTIAL_FLAGS.has(t.split('=')[0]!));
    return { kind, resource, signed };
  }
  const aws = tokens.findIndex(
    (t, i) =>
      /(?:^|[/\\])aws(?:\.exe)?$/i.test(t) &&
      tokens[i + 1] === 'cloudformation' &&
      tokens[i + 2] === 'signal-resource'
  );
  if (aws !== -1) {
    const resource = flagValue(tokens.slice(aws + 3), ['--logical-resource-id']);
    return resource === undefined ? undefined : { kind: 'signal', resource, signed: true };
  }
  return undefined;
}

function flagValue(args: string[], names: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const [flag, inline] = args[i]!.split('=', 2) as [string, string | undefined];
    if (!names.includes(flag)) continue;
    const value = inline ?? args[i + 1];
    return value === undefined || value.includes(TOKEN_PLACEHOLDER) ? undefined : value;
  }
  return undefined;
}
