---
title: Mutual TLS in cdkd local start-api
description: "Serve a local API over HTTPS with cdkd local start-api and require a client certificate signed by your own CA, using the three --mtls-* flags."
---

# Mutual TLS in cdkd local start-api

Pass the three `--mtls-*` flags to [`cdkd local start-api`](local-start-api.md)
and it serves HTTPS and requires a client certificate that chains to your CA
bundle. A client with no certificate, or with one that does not chain to the
bundle, is rejected during the TLS handshake.

```bash
cdkd local start-api --port 3000 \
  --mtls-truststore ca.pem \
  --mtls-cert server-cert.pem \
  --mtls-key server-key.pem
```

| Flag | File |
| --- | --- |
| `--mtls-truststore <path>` | PEM bundle of the CAs that client certificates must chain to |
| `--mtls-cert <path>` | PEM server certificate |
| `--mtls-key <path>` | PEM server private key |

You must pass all three. Passing only one or two is an error.

## Try it with a throwaway CA

The steps below create a CA, a server certificate and a client certificate
with `openssl`, then make one request.

::: steps
1. Create a local CA

   ```bash
   openssl req -x509 -newkey rsa:2048 -nodes \
     -keyout ca-key.pem -out ca.pem \
     -subj "/CN=cdkd-local-ca" -days 365
   ```

2. Create a server certificate signed by it

   ```bash
   openssl req -newkey rsa:2048 -nodes \
     -keyout server-key.pem -out server-csr.pem \
     -subj "/CN=localhost"
   openssl x509 -req -in server-csr.pem \
     -CA ca.pem -CAkey ca-key.pem -CAcreateserial \
     -out server-cert.pem -days 365
   ```

3. Create a client certificate signed by it

   ```bash
   openssl req -newkey rsa:2048 -nodes \
     -keyout client-key.pem -out client-csr.pem \
     -subj "/CN=client"
   openssl x509 -req -in client-csr.pem \
     -CA ca.pem -CAkey ca-key.pem -CAcreateserial \
     -out client-cert.pem -days 365
   ```

4. Start the server

   ```bash
   cdkd local start-api --port 3000 \
     --mtls-truststore ca.pem \
     --mtls-cert server-cert.pem \
     --mtls-key server-key.pem
   ```

5. Call it with the client certificate

   ```bash
   curl --cacert ca.pem \
     --cert client-cert.pem --key client-key.pem \
     https://localhost:3000/items
   ```
:::

## What the handler receives

The handler receives the verified client certificate in its event. On a REST
v1 API it is at `event.requestContext.identity.clientCert`. On an HTTP API it
is at `event.requestContext.authentication.clientCert`.

```json
{
  "clientCertPem": "-----BEGIN CERTIFICATE-----\n...",
  "subjectDN": "CN=client,O=example,C=US",
  "issuerDN": "CN=My CA,O=example,C=US",
  "serialNumber": "01:23:45:...",
  "validity": {
    "notBefore": "May 22 03:30:00 2026 GMT",
    "notAfter": "May 22 03:30:00 2027 GMT"
  }
}
```

Authorizers still run. They run after the TLS handshake has accepted the
client certificate.

## Matching a deployed custom domain

cdkd does not read mutual TLS settings from `AWS::ApiGateway::DomainName` or
`AWS::ApiGatewayV2::DomainName`. The three flags are the only configuration.
To match a deployed domain, pass the CA bundle you uploaded to that domain's
trust store as `--mtls-truststore`.

## Changing the certificates

cdkd reads the trust store once, at boot. Restart the command to pick up a
new bundle. A `--watch` reload does not reload the mTLS files.

A WebSocket API served in the same run uses `wss://` under mutual TLS.

## Related

- [`cdkd local start-api`](local-start-api.md): the worked example and the
  options
- [Authorizers](local-start-api-authorizers.md): what runs after the handshake
