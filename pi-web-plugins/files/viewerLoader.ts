export type FilesViewerDependencies = typeof import("./viewerDependencies.js");

/** Keep the CodeMirror graph lazy while Files is showing non-code content. */
export function loadFilesViewerDependencies(): Promise<FilesViewerDependencies> {
  return import("./viewerDependencies.js");
}
