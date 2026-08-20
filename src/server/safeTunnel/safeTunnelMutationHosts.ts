import { isIP } from "node:net";
import {
  isSafeTunnelLoopbackDevelopmentHostname,
  isSafeTunnelPublicIngressTransportAllowed,
} from "../../shared/safeTunnelUrlPolicy.js";

export interface SafeTunnelMutationHostConfig {
  /** The operator-selected web listener host. */
  readonly listenerHost?: string;
  /** Exact configured hostnames; `true` deliberately does not trust arbitrary DNS names. */
  readonly allowedHosts?: readonly string[] | true;
}

export interface SafeTunnelMutationHostHeaders {
  readonly host?: string | readonly string[] | undefined;
  readonly origin?: string | readonly string[] | undefined;
}

export interface SafeTunnelMutationHostBoundary {
  allowsRead(
    headers: SafeTunnelMutationHostHeaders,
    registeredPublicOrigin: () => Promise<string | undefined>,
  ): Promise<boolean>;
  allowsMutation(
    headers: SafeTunnelMutationHostHeaders,
    registeredPublicOrigin: () => Promise<string | undefined>,
  ): Promise<boolean>;
}

interface NormalizedOrigin {
  readonly hostname: string;
  readonly scheme: "http" | "https";
}

/**
 * Trust derived from the persisted Safe Tunnel registration, never from
 * request-controlled data: the exact registered public hostname plus, when the
 * provider issues multi-label hostnames, the provider zone that hostname lives
 * in (its parent domain).
 */
interface RegisteredProviderTrust {
  readonly hostname: string;
  readonly baseDomain?: string;
}

/**
 * Builds the feature-local Host/Origin boundary for Safe Tunnel API requests.
 * DNS names become trusted only through startup configuration or a persisted
 * registration; equality between request-controlled Host and Origin is never
 * itself evidence of trust.
 *
 * A persisted registration trusts its exact public hostname and sibling
 * hostnames beneath its provider base domain, so enable/disable work from the
 * generated tunnel hostname — including the local development edge, which
 * serves the same hostname over plaintext HTTP on a dev port — without adding
 * tunnel hostnames to `allowedHosts`. Mutation Origins on provider hostnames
 * must use HTTPS, with plaintext accepted only on loopback development names.
 * The two trust classes never mix: a configured Origin cannot stand in for a
 * provider one, and a provider Origin does not widen configured-host rules.
 */
export function createSafeTunnelMutationHostBoundary(
  config: SafeTunnelMutationHostConfig = {},
): SafeTunnelMutationHostBoundary {
  const allowedHosts = config.allowedHosts === undefined
    || config.allowedHosts === true
    ? []
    : config.allowedHosts;
  const configuredHostnames = new Set(
    [config.listenerHost, ...allowedHosts].flatMap((value) => {
      const hostname = normalizeConfiguredHostname(value);
      return hostname === undefined ? [] : [hostname];
    }),
  );
  const isConfiguredOrIntrinsic = (hostname: string): boolean => (
    isIntrinsicallyTrustedHostname(hostname) || configuredHostnames.has(hostname)
  );

  return {
    allowsRead: async (headers, registeredPublicOrigin) => {
      const host = requestAuthorityHostname(headers.host);
      if (host === undefined) return false;
      if (isConfiguredOrIntrinsic(host)) return true;

      const provider = deriveRegisteredProviderTrust(await registeredPublicOrigin());
      return provider !== undefined && providerTrustsHostname(provider, host);
    },
    allowsMutation: async (headers, registeredPublicOrigin) => {
      const host = requestAuthorityHostname(headers.host);
      if (host === undefined) return false;

      const origin = headers.origin === undefined
        ? undefined
        : requestOrigin(headers.origin);
      if (origin === undefined) return false;

      const hostIsConfigured = isConfiguredOrIntrinsic(host);
      const originIsConfigured = isConfiguredOrIntrinsic(origin.hostname);
      if (hostIsConfigured && originIsConfigured) return true;

      const provider = deriveRegisteredProviderTrust(await registeredPublicOrigin());
      if (provider === undefined) return false;

      const hostIsTrusted = hostIsConfigured || providerTrustsHostname(provider, host);
      return hostIsTrusted && providerTrustsOrigin(provider, origin);
    },
  };
}

function requestAuthorityHostname(
  value: string | readonly string[] | undefined,
): string | undefined {
  if (typeof value !== "string" || value === "" || value !== value.trim()) {
    return undefined;
  }
  return authorityHostname(value, true);
}

function requestOrigin(
  value: string | readonly string[],
): NormalizedOrigin | undefined {
  if (typeof value !== "string" || value === "" || value !== value.trim()) {
    return undefined;
  }

  try {
    const origin = new URL(value);
    const hostname = normalizeUrlHostname(origin.hostname);
    if ((origin.protocol !== "http:" && origin.protocol !== "https:")
      || origin.username !== ""
      || origin.password !== ""
      || origin.pathname !== "/"
      || origin.search !== ""
      || origin.hash !== ""
      || hostname === undefined) {
      return undefined;
    }
    return { hostname, scheme: origin.protocol === "https:" ? "https" : "http" };
  } catch {
    return undefined;
  }
}

function deriveRegisteredProviderTrust(
  value: string | undefined,
): RegisteredProviderTrust | undefined {
  const hostname = normalizeRegisteredPublicHostname(value);
  if (hostname === undefined) return undefined;
  const baseDomain = providerBaseDomain(hostname);
  return baseDomain === undefined ? { hostname } : { hostname, baseDomain };
}

function providerTrustsHostname(
  provider: RegisteredProviderTrust,
  hostname: string,
): boolean {
  return hostname === provider.hostname
    || (provider.baseDomain !== undefined
      && hostname.endsWith(`.${provider.baseDomain}`));
}

function providerTrustsOrigin(
  provider: RegisteredProviderTrust,
  origin: NormalizedOrigin,
): boolean {
  if (!providerTrustsHostname(provider, origin.hostname)) return false;
  // HTTPS keeps provenance on any provider hostname. Plaintext is a loopback
  // development exception: the local tunnel dev edge serves the registered
  // hostname over HTTP on its own port (for example
  // http://machine.namespace.tunnels.localhost:8788).
  if (origin.scheme === "https") return true;
  return isSafeTunnelLoopbackDevelopmentHostname(origin.hostname);
}

/**
 * Derives the provider zone from a registered public hostname by stripping its
 * first label (`machine.namespace.tunnels.example` -> `namespace.tunnels.example`).
 * The zone must stay a multi-label DNS name so trust can never climb to a
 * public suffix or a one-label apex; literal IP registrations trust only their
 * exact address.
 */
function providerBaseDomain(hostname: string): string | undefined {
  if (isIP(hostname) !== 0) return undefined;
  const firstDot = hostname.indexOf(".");
  if (firstDot <= 0) return undefined;
  const candidate = hostname.slice(firstDot + 1);
  if (!candidate.includes(".")) return undefined;
  if (candidate.split(".").some((label) => label === "")) return undefined;
  return candidate;
}

function normalizeRegisteredPublicHostname(value: string | undefined): string | undefined {
  if (value === undefined || value === "" || value !== value.trim()) return undefined;

  try {
    const origin = new URL(value);
    const hostname = normalizeUrlHostname(origin.hostname);
    if (!isSafeTunnelPublicIngressTransportAllowed(origin)
      || origin.username !== ""
      || origin.password !== ""
      || origin.pathname !== "/"
      || origin.search !== ""
      || origin.hash !== ""
      || hostname === undefined) {
      return undefined;
    }
    return hostname;
  } catch {
    return undefined;
  }
}

function normalizeConfiguredHostname(value: string | undefined): string | undefined {
  if (value === undefined || value === "" || value !== value.trim()) return undefined;
  // Vite supports leading-dot subdomain patterns, but Safe Tunnel requests
  // require an exact operator-selected DNS name.
  if (value.startsWith(".")) return undefined;

  if (isIP(value) === 6) return authorityHostname(`[${value}]`, false);
  return authorityHostname(value, false);
}

function authorityHostname(value: string, allowPort: boolean): string | undefined {
  if (/[\\/?#@]/u.test(value)) return undefined;

  try {
    const authority = new URL(`http://${value}`);
    if (authority.username !== ""
      || authority.password !== ""
      || authority.pathname !== "/"
      || authority.search !== ""
      || authority.hash !== ""
      || (!allowPort && authority.port !== "")) {
      return undefined;
    }
    return normalizeUrlHostname(authority.hostname);
  } catch {
    return undefined;
  }
}

function normalizeUrlHostname(value: string): string | undefined {
  const unbracketed = value.startsWith("[") && value.endsWith("]")
    ? value.slice(1, -1)
    : value;
  const withoutRootDot = unbracketed.endsWith(".")
    ? unbracketed.slice(0, -1)
    : unbracketed;
  if (withoutRootDot === "" || withoutRootDot.endsWith(".")) return undefined;
  return withoutRootDot.toLowerCase();
}

function isIntrinsicallyTrustedHostname(hostname: string): boolean {
  // Literal IP origins cannot retain a DNS name while rebinding elsewhere.
  return hostname === "localhost" || isIP(hostname) !== 0;
}
