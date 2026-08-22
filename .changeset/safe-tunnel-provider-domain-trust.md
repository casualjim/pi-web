---
"@jmfederico/pi-web": patch
---

Trust saved Safe Tunnel ingress without manual host configuration. Browser API reads and mutations accept the registered provider scope, while the split Vite development server automatically applies the exact saved public hostname to HTTP, HMR, and proxied application-WebSocket host checks. Settings shows that hostname as managed read-only state instead of writing it to `allowedHosts`; arbitrary non-provider hosts remain denied.
