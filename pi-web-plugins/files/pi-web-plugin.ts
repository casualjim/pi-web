import type { PiWebPlugin } from "@jmfederico/pi-web/plugin-api";
import filesIconUrl from "./files-icon.svg?url";
import filesStyles from "./files.css?inline";

export { filesIconUrl, filesStyles };
export type FilesViewerDependencies = typeof import("./viewerDependencies.js");

/** Keep the viewer-heavy graph lazy when Files is not selected. */
export function loadFilesViewerDependencies(): Promise<FilesViewerDependencies> {
  return import("./viewerDependencies.js");
}

const plugin: PiWebPlugin = {
  apiVersion: 2,
  name: "Files",
  // Core remains the sole Files UI until the extraction checkpoint. This
  // package is intentionally contribution-free while its artifact contract is
  // established and tested.
  activate: () => ({ contributions: {} }),
};

export default plugin;
