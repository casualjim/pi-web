import { chmodSync, existsSync } from "node:fs";

// node-pty 1.1.0 ships its darwin spawn-helper without the execute bit
// (microsoft/node-pty#850), so every pty.spawn fails with "posix_spawnp
// failed." Restore the executable mode after install.
if (process.platform === "darwin") {
  for (const arch of ["arm64", "x64"]) {
    const helper = new URL(`../node_modules/node-pty/prebuilds/darwin-${arch}/spawn-helper`, import.meta.url);
    if (existsSync(helper)) chmodSync(helper, 0o755);
  }
}
