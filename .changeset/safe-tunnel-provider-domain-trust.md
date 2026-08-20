---
"@jmfederico/pi-web": patch
---

Trust the Safe Tunnel provider domain for browser API reads and mutations: a saved registration now trusts its generated tunnel hostname and sibling hostnames beneath its provider base domain, so Enable/Disable work through the tunnel — including the plaintext local development edge — without adding tunnel hostnames to `allowedHosts`. Mutation Origins on provider hostnames must use HTTPS, with plaintext accepted only on loopback development names; arbitrary non-provider hostnames and `allowedHosts: true` remain non-authoritative.
