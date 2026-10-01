# Security Policy

## Reporting a Vulnerability

Please do **not** report security vulnerabilities through public GitHub issues.

Instead, use GitHub's private vulnerability reporting:

1. Go to the repository's **Security** tab
2. Click **Report a vulnerability**
3. Fill in the details (affected version, reproduction steps, impact)

This opens a private channel with the maintainer. You can also reach the
maintainer through the contact links on their GitHub profile if you prefer.

## What to Expect

- An acknowledgment as soon as possible (typically within a few days)
- An assessment of the report and, if confirmed, a remediation plan shared
  with you before any public disclosure
- Credit in the published security advisory (and a CVE where applicable),
  unless you prefer to remain anonymous

## Supported Versions

cdkd is intended for dev/test workflows and is early in development. Only the
latest released version receives security fixes.

## Scope Notes

cdkd deploys AWS resources with the caller's AWS credentials and stores
deployment state in the caller's own S3 bucket. Reports about the handling
of sensitive data in state files, logs, or CLI output are in scope and
welcome.

In scope:

- A secret (a `NoEcho` parameter, a `{{resolve:...}}` dynamic reference, a
  value derived from one) reaching state, logs, CLI output, deployment events
  or an exports index in plaintext.
- Terminal control characters or escape sequences from a template, resource,
  state or AWS value reaching the terminal unstripped.
- A secret or credential placed on a child process's command line, left on
  disk, or handed to a process or container that does not need it.
- cdkd itself passing an untrusted value to a shell or a child process, or
  resolving a file path outside where it belongs.
- A local emulator's authorizer or signature check accepting a request AWS
  would reject.
- Deletion or modification of a resource cdkd does not own, or deleting one it
  does own without the snapshot or retention the template asks for.

Out of scope:

- **A value cdkd prints that would run if an operator copied the line into a
  shell.** The values in question — logical ids, stack names, physical ids,
  state keys, AWS error text — come from the operator's own CDK app (which
  already runs arbitrary code at synth), the operator's own state bucket
  (whose writers can already make cdkd change any resource), or a principal
  in the account who can already change the deployed resources directly. The
  attack also needs the operator to paste a crafted line. The AWS CDK CLI
  prints the same values as-is.
