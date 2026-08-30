import type { PiWebPlugin, PluginActivationContext, PluginActivationResult } from "@jmfederico/pi-web/plugin-api";
import { FilesCodeViewer } from "./FilesCodeViewer";
import { WorkspaceFilesPanel } from "./FilesPanel";
import { FilesRuntime } from "./FilesRuntime";
import { WorkspaceFileViewer } from "./FilesViewer";
import filesIconUrl from "./files-icon.svg?url";
import filesStyles from "./files.css?inline";

export { FilesRuntime, filesIconUrl, filesStyles };
export { loadFilesViewerDependencies } from "./viewerLoader";
export type { FilesViewerDependencies } from "./viewerLoader";

export const FILES_PANEL_ELEMENT = "pi-web-files-panel";
export const FILES_VIEWER_ELEMENT = "pi-web-files-viewer";
export const FILES_CODE_VIEWER_ELEMENT = "pi-web-files-code-viewer";

const runtime = new FilesRuntime();

const plugin: PiWebPlugin = {
  apiVersion: 2,
  name: "Files",
  activate: (context) => activateFilesPlugin(context, runtime),
};

export default plugin;

export function activateFilesPlugin(context: PluginActivationContext, filesRuntime: FilesRuntime): PluginActivationResult {
  defineFilesCustomElements();
  const panelId = `${context.runtimePluginId}:workspace.files`;
  const icon = context.svg`
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
      <path d="M3 6.5A2.5 2.5 0 0 1 5.5 4H10l2 2h6.5A2.5 2.5 0 0 1 21 8.5v8A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5z"></path>
    </svg>
  `;
  return {
    contributions: {
      workspacePanels: [{
        id: "workspace.files",
        title: "Files",
        icon,
        order: 10,
        routeAliases: ["files", "core:workspace.files"],
        navigationAliases: ["core:workspace.files"],
        invalidationResources: ["workspace.files"],
        onInvalidate: (workspaceContext, invalidation) => filesRuntime.invalidate(workspaceContext, invalidation),
        render: (workspaceContext) => context.html`<pi-web-files-panel .context=${workspaceContext} .runtime=${filesRuntime}></pi-web-files-panel>`,
      }],
      actions: [
        {
          id: "view.files",
          title: "Go to Files",
          shortcut: "mod+2",
          shortcutAliases: ["core:view.files"],
          group: "Navigation",
          enabled: (runtimeContext) => runtimeContext.state.selectedWorkspace !== undefined,
          run: (runtimeContext) => { runtimeContext.selectMainView(panelId); },
        },
        {
          id: "workspace.refresh-files",
          title: "Refresh Files",
          shortcut: "mod+shift+f",
          shortcutAliases: ["core:workspace.refresh-files"],
          group: "Workspace",
          enabled: (runtimeContext) => runtimeContext.state.selectedWorkspace !== undefined,
          run: (runtimeContext) => runtimeContext.refreshWorkspacePanels(panelId),
        },
      ],
    },
  };
}

export function defineFilesCustomElements(): void {
  if (typeof customElements === "undefined") throw new Error("Files requires browser Custom Elements support");
  defineCustomElement(FILES_CODE_VIEWER_ELEMENT, FilesCodeViewer);
  defineCustomElement(FILES_VIEWER_ELEMENT, WorkspaceFileViewer);
  defineCustomElement(FILES_PANEL_ELEMENT, WorkspaceFilesPanel);
}

function defineCustomElement(name: string, constructor: CustomElementConstructor): void {
  const existing = customElements.get(name);
  if (existing === undefined) {
    customElements.define(name, constructor);
    return;
  }
  if (existing !== constructor) throw new Error(`Files custom element name is already owned: ${name}`);
}
