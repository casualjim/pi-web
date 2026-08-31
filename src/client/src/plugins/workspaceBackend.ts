import type { JsonValue, Workspace } from "../api";
import {
  requestPluginBackend,
  type PluginBackendRequestOptions,
  type PluginBackendRequestTarget,
} from "../api/pluginBackends";
import type { WorkspaceBackend, WorkspaceBackendRequestOptions, WorkspacePluginBinding } from "./types";

export type PluginBackendRequester = (
  target: PluginBackendRequestTarget,
  operation: string,
  input: JsonValue,
  options?: PluginBackendRequestOptions,
) => Promise<JsonValue>;

export function createPluginWorkspaceBackend(
  binding: WorkspacePluginBinding,
  workspace: Pick<Workspace, "id" | "projectId">,
  machineId: string,
  request: PluginBackendRequester = requestPluginBackend,
): WorkspaceBackend | undefined {
  const backendRevision = binding.backendRevision;
  if (backendRevision === undefined) return undefined;
  return {
    ...(binding.backendCapabilityVersion === undefined ? {} : { capabilityVersion: binding.backendCapabilityVersion }),
    request: (operation, input, options?: WorkspaceBackendRequestOptions) => request({
      pluginId: binding.sourcePluginId,
      backendRevision,
      machineId,
      projectId: workspace.projectId,
      workspaceId: workspace.id,
    }, operation, input, options),
  };
}
