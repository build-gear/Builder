import {
  spawnSync,
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncReturns
} from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);

export function spawnTsx(
  args: string[],
  options: SpawnSyncOptionsWithStringEncoding = { encoding: "utf8" }
): SpawnSyncReturns<string> {
  const { encoding: _encoding, shell: _shell, ...safeOptions } = options;
  void _encoding;
  void _shell;

  return spawnSync(process.execPath, [tsxCliPath(), ...args], {
    ...safeOptions,
    encoding: "utf8"
  });
}

function tsxCliPath(): string {
  return path.join(path.dirname(require.resolve("tsx/package.json")), "dist", "cli.cjs");
}
