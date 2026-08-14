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

cdkd is an experimental project intended for dev/test workflows. Only the
latest released version receives security fixes.

## Scope Notes

cdkd deploys AWS resources with the caller's AWS credentials and stores
deployment state in the caller's own S3 bucket. Reports about the handling
of sensitive data in state files, logs, or CLI output are in scope and
welcome.
