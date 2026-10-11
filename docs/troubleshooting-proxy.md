---
title: Proxies and corporate networks
description: "Set up cdkd behind a corporate proxy: the variables it reads, how NO_PROXY matches, extra CA certificates and Docker."
---

# Proxies and corporate networks

cdkd reads the standard proxy environment variables. If your first command fails with `self-signed certificate in certificate chain`, start at ["self-signed certificate in certificate chain" on the very first command](troubleshooting.md#self-signed-certificate-in-certificate-chain-on-the-very-first-command) on the main Troubleshooting page. The entries here are the details of the setup.

On this page:

- [Variables cdkd honours](#variables-cdkd-honours)
- [`NO_PROXY` matching is EXACT, unlike curl](#no-proxy-matching-is-exact-unlike-curl)
- [A TLS-terminating proxy still needs `NODE_EXTRA_CA_CERTS`](#a-tls-terminating-proxy-still-needs-node-extra-ca-certs)
- [The Docker daemon has its own egress](#the-docker-daemon-has-its-own-egress)
- [Verifying that traffic is routed](#verifying-that-traffic-is-routed)

## Variables cdkd honours

| Variable | Effect |
| --- | --- |
| `HTTPS_PROXY` / `https_proxy` | Proxy for `https://` requests, which is all AWS traffic in practice |
| `HTTP_PROXY` / `http_proxy` | Proxy for plain `http://` requests |
| `ALL_PROXY` / `all_proxy` | Fallback for either scheme |
| `NO_PROXY` / `no_proxy` | Hosts to reach directly, bypassing the proxy |

- **Spelling.** Both work, and the lower-case one wins where both are set.
  Other tools differ, so do not rely on the two agreeing.
- **Scheme.** Always include it: `HTTPS_PROXY=http://proxy.corp.example:8080`.
  The scheme says how to reach the proxy, not what is being proxied. A value
  without one inherits the request's scheme, so cdkd speaks TLS to the proxy
  and fails with an error that names neither the variable nor the scheme.
- **Per request.** `HTTPS_PROXY` and `HTTP_PROXY` may name different proxies.
- **Whitespace only.** cdkd refuses to start and names the variable. Unset it
  or give it a URL.

## `NO_PROXY` matching is EXACT, unlike curl

An entry that does not start with `.` or `*` matches only that exact
hostname. curl treats such an entry as a suffix that also matches subdomains,
and cdkd does not.

| `NO_PROXY` | `example.com` | `api.example.com` |
| --- | --- | --- |
| `example.com` | direct | **proxied** |
| `.example.com` | **proxied** | direct |
| `*.example.com` | **proxied** | direct |
| `example.com,.example.com` | direct | direct |

Covering a domain and its subdomains takes two entries. For a VPC-endpoint
setup that sends AWS traffic direct:

```bash
export NO_PROXY=.amazonaws.com,amazonaws.com
```

| Entry | Behaviour |
| --- | --- |
| A CIDR range (`10.0.0.0/8`) | Ignored without a warning; list IP addresses literally (`10.1.2.3`) |
| A trailing wildcard (`172.16.*`) | Does not work; only a leading `*` is a wildcard |
| A lone `*` | Bypasses the proxy for every host |
| An entry with a port (`example.com:443`) | Applies to that port only |

Entries may be separated by commas or whitespace, and matching is
case-insensitive. Instance-metadata (IMDS) and ECS container credentials
always bypass the proxy, so no entry for `169.254.169.254` is needed.

## A TLS-terminating proxy still needs `NODE_EXTRA_CA_CERTS`

Whether you need an extra CA certificate depends on the kind of proxy. A
proxy that opens a CONNECT tunnel passes Amazon's own certificate through, so
it needs none. A proxy that terminates TLS presents its own certificate, and
cdkd must be told to trust it:

```bash
export NODE_EXTRA_CA_CERTS=/path/to/corporate-root-ca.pem
```

The file must be PEM and readable by the cdkd process. This is a Node.js
variable, so it does not affect the AWS CLI, which uses `AWS_CA_BUNDLE`.

## The Docker daemon has its own egress

`cdkd deploy` builds and pushes container image assets through the Docker
daemon, and `cdkd local` runs containers through it. The daemon is a separate
process with its own network settings, so the variables above do not reach
it.

If image pulls or pushes fail behind a proxy while everything else works,
configure the daemon and restart it:

- Linux: a systemd drop-in with `Environment="HTTPS_PROXY=..."`.
- Docker Desktop: Settings → Resources → Proxies.

## Verifying that traffic is routed

To check that cdkd uses the variable, point it at a proxy that cannot work.
If cdkd reads the variable, the command fails. If the command succeeds
anyway, the variable is not reaching the cdkd process:

```bash
HTTPS_PROXY=http://127.0.0.1:1 cdkd state list --profile my-profile
```

## Related

- [Troubleshooting](troubleshooting.md): the common problems and the list of
  every troubleshooting page
