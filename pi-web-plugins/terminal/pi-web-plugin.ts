import type { PiWebPlugin } from "@jmfederico/pi-web/plugin-api";

/**
 * Required browser entry checkpoint. The existing core Terminal panel remains
 * active until the next extraction checkpoint moves its contributions here.
 */
const plugin: PiWebPlugin = {
  apiVersion: 2,
  name: "Terminal",
  activate: () => ({ contributions: {} }),
};

export default plugin;
