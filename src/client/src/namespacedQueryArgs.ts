import type { QualifiedContributionId } from "./plugins/ids";

export type QueryValue = string | number | boolean | readonly (string | number | boolean)[];
export type ContributionQueryValue = string | readonly string[];
export type ContributionQuerySnapshot = Readonly<Record<string, ContributionQueryValue>>;
export type ContributionQueryRecord = Record<string, string | string[]>;

const qualifiedContributionIdPattern = /^[a-z][a-z0-9.-]*:[a-z][a-z0-9.-]*$/u;
const localQueryKeyPattern = /^[a-z][a-z0-9.-]*$/u;
const contributionQueryParameterPattern = /^[a-z][a-z0-9.-]*\.[a-z][a-z0-9.-]*--[a-z][a-z0-9.-]*$/u;
const MAX_CONTRIBUTION_QUERY_PARAMETERS = 64;
const MAX_CONTRIBUTION_QUERY_VALUES = 16;
const MAX_CONTRIBUTION_QUERY_PARAMETER_LENGTH = 256;
const MAX_CONTRIBUTION_QUERY_VALUE_LENGTH = 4_096;
const MAX_CONTRIBUTION_QUERY_RECORD_LENGTH = 65_536;

export function queryNamespace(contributionId: string): string {
  return contributionId.replaceAll(":", ".");
}

export function readNamespacedQuery(namespace: string): Record<string, string | string[]> {
  return readNamespacedQueryFromParams(new URLSearchParams(window.location.search), namespace);
}

export function readNamespacedString(namespace: string, key: string): string | undefined {
  const value = readNamespacedQuery(namespace)[key];
  if (Array.isArray(value)) return value[0];
  return value === "" ? undefined : value;
}

/** Read one contribution's canonical query snapshot, falling back to aliases per key. */
export function readContributionQuery(
  contributionId: QualifiedContributionId,
  aliases: readonly QualifiedContributionId[] = [],
): ContributionQuerySnapshot {
  const params = new URLSearchParams(window.location.search);
  const query: Record<string, string | string[]> = {};
  for (const id of uniqueContributionIds(contributionId, aliases)) {
    const candidate = readNamespacedQueryFromParams(params, queryNamespace(id));
    for (const [key, value] of Object.entries(candidate)) {
      if (!isContributionQueryLocalKey(key) || Object.hasOwn(query, key)) continue;
      query[key] = Array.isArray(value) ? [...value] : value;
    }
  }
  return freezeContributionQuery(query);
}

/** Capture only bounded, syntactically valid contribution-owned query parameters. */
export function readContributionQueryRecord(): ContributionQueryRecord {
  const raw: Record<string, string | string[]> = {};
  for (const [key, value] of new URLSearchParams(window.location.search)) {
    if (!isContributionQueryParameter(key)) continue;
    const existing = raw[key];
    if (existing === undefined) raw[key] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else raw[key] = [existing, value];
  }
  return normalizeContributionQueryRecord(raw);
}

/** Validate and bound a record loaded from browser memory or another untyped boundary. */
export function normalizeContributionQueryRecord(value: unknown): ContributionQueryRecord {
  if (!isRecord(value)) return {};
  const result: ContributionQueryRecord = {};
  let parameterCount = 0;
  let recordLength = 0;
  for (const [key, candidate] of Object.entries(value)) {
    if (parameterCount >= MAX_CONTRIBUTION_QUERY_PARAMETERS) break;
    if (!isContributionQueryParameter(key) || key.length > MAX_CONTRIBUTION_QUERY_PARAMETER_LENGTH) continue;
    const values = typeof candidate === "string"
      ? [candidate]
      : Array.isArray(candidate) && candidate.every((item) => typeof item === "string")
        ? candidate.slice(0, MAX_CONTRIBUTION_QUERY_VALUES)
        : undefined;
    if (values === undefined || values.length === 0 || values.some((item) => item.length > MAX_CONTRIBUTION_QUERY_VALUE_LENGTH)) continue;
    const candidateLength = key.length + values.reduce((total, item) => total + item.length, 0);
    if (recordLength + candidateLength > MAX_CONTRIBUTION_QUERY_RECORD_LENGTH) break;
    result[key] = values.length === 1 ? values[0] ?? "" : values;
    parameterCount += 1;
    recordLength += candidateLength;
  }
  return result;
}

/** Replace all contribution-owned parameters while preserving route, unrelated query, path, and hash. */
export function writeContributionQueryRecord(
  record: Readonly<Record<string, string | readonly string[]>>,
  options?: { replace?: boolean | undefined },
): boolean {
  const normalized = normalizeContributionQueryRecord(record);
  const url = new URL(window.location.href);
  for (const key of [...url.searchParams.keys()]) {
    if (isContributionQueryParameter(key)) url.searchParams.delete(key);
  }
  for (const [key, value] of Object.entries(normalized)) {
    if (Array.isArray(value)) {
      for (const item of value) url.searchParams.append(key, item);
    } else {
      url.searchParams.set(key, value);
    }
  }
  return commitUrl(url, options);
}

/** Canonicalize one key by removing canonical and alias values, then writing canonical only. */
export function setContributionQueryKey(
  contributionId: QualifiedContributionId,
  aliases: readonly QualifiedContributionId[],
  key: string,
  value: QueryValue | undefined | null,
  options?: { replace?: boolean | undefined },
): boolean {
  assertQualifiedContributionId(contributionId);
  for (const alias of aliases) assertQualifiedContributionId(alias);
  if (!isContributionQueryLocalKey(key)) throw new Error(`Invalid contribution navigation key: ${key}`);

  const serializedValues = value === undefined || value === null ? [] : serializeContributionQueryValue(key, value);
  const url = new URL(window.location.href);
  for (const id of uniqueContributionIds(contributionId, aliases)) {
    url.searchParams.delete(`${queryNamespace(id)}--${key}`);
  }
  const canonicalKey = `${queryNamespace(contributionId)}--${key}`;
  for (const item of serializedValues) url.searchParams.append(canonicalKey, item);
  return commitUrl(url, options);
}

export function setNamespacedQueryKey(namespace: string, key: string, value: QueryValue | undefined | null, options?: { replace?: boolean | undefined }): void {
  const url = new URL(window.location.href);
  const namespacedKey = `${namespace}--${key}`;
  url.searchParams.delete(namespacedKey);
  if (value !== undefined && value !== null && value !== "") {
    if (Array.isArray(value)) {
      for (const item of value) url.searchParams.append(namespacedKey, String(item));
    } else {
      url.searchParams.set(namespacedKey, String(value));
    }
  }
  commitUrl(url, options);
}

export function isContributionQueryParameter(value: string): boolean {
  return contributionQueryParameterPattern.test(value);
}

export function isContributionQueryLocalKey(value: string): boolean {
  return localQueryKeyPattern.test(value);
}

function readNamespacedQueryFromParams(params: URLSearchParams, namespace: string): Record<string, string | string[]> {
  const prefix = `${namespace}--`;
  const result: Record<string, string | string[]> = {};
  for (const [key, value] of params.entries()) {
    if (!key.startsWith(prefix)) continue;
    const localKey = key.slice(prefix.length);
    const existing = result[localKey];
    if (existing === undefined) result[localKey] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else result[localKey] = [existing, value];
  }
  return result;
}

function uniqueContributionIds(
  contributionId: QualifiedContributionId,
  aliases: readonly QualifiedContributionId[],
): QualifiedContributionId[] {
  return [...new Set([contributionId, ...aliases])];
}

function freezeContributionQuery(query: Record<string, string | string[]>): ContributionQuerySnapshot {
  const snapshot: Record<string, string | readonly string[]> = {};
  for (const [key, value] of Object.entries(query)) {
    snapshot[key] = Array.isArray(value) ? Object.freeze([...value]) : value;
  }
  return Object.freeze(snapshot);
}

function assertQualifiedContributionId(value: string): asserts value is QualifiedContributionId {
  if (!qualifiedContributionIdPattern.test(value)) throw new Error(`Invalid qualified contribution id: ${value}`);
}

function serializeContributionQueryValue(key: string, value: unknown): string[] {
  const values: unknown[] = Array.isArray(value) ? value : [value];
  if (values.length > MAX_CONTRIBUTION_QUERY_VALUES) throw new Error(`Contribution navigation value has too many items for key: ${key}`);
  const serialized = values.map((item) => {
    if (typeof item !== "string" && typeof item !== "number" && typeof item !== "boolean") {
      throw new Error(`Invalid contribution navigation value for key: ${key}`);
    }
    return String(item);
  });
  if (serialized.some((item) => item.length > MAX_CONTRIBUTION_QUERY_VALUE_LENGTH)
    || serialized.reduce((total, item) => total + item.length, 0) > MAX_CONTRIBUTION_QUERY_RECORD_LENGTH) {
    throw new Error(`Contribution navigation value is too long for key: ${key}`);
  }
  return serialized;
}

function commitUrl(url: URL, options?: { replace?: boolean | undefined }): boolean {
  const next = `${url.pathname}${url.search}${url.hash}`;
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (next === current) return false;
  if (options?.replace === true) window.history.replaceState({}, "", url);
  else window.history.pushState({}, "", url);
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
