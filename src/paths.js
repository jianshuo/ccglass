import os from "node:os";
import path from "node:path";

export function encodePath(cwd) {
  return cwd.replace(/^\//, "").replace(/[/\\]/g, "-");
}

export function globalRoot(cwd) {
  return path.join(os.homedir(), ".ccglass", "sessions", encodePath(cwd));
}

export function legacyRoot(cwd) {
  return path.join(cwd, ".ccglass");
}
