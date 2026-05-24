import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import crossSpawn from "cross-spawn";

const WINDOWS_SCRIPT_EXTS = new Set([".cmd", ".bat", ".ps1"]);

function pathEntries(env = process.env) {
  return String(env.PATH || env.Path || "")
    .split(path.delimiter)
    .filter(Boolean);
}

function pathextEntries(env = process.env) {
  const exts = String(env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((ext) => ext.trim().toLowerCase())
    .filter(Boolean);
  return exts.includes(".ps1") ? exts : [...exts, ".ps1"];
}

function isFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function candidateFiles(command, env = process.env) {
  const hasDir = /[\\/]/.test(command);
  const ext = path.extname(command);
  const bases = hasDir ? [command] : pathEntries(env).map((dir) => path.join(dir, command));
  if (ext) return bases;
  return bases.flatMap((base) => [base, ...pathextEntries(env).map((pathext) => base + pathext)]);
}

export function resolveWindowsCommand(command, env = process.env, platform = process.platform) {
  if (platform !== "win32") return null;
  return candidateFiles(command, env).find(isFile) || null;
}

function quoteCmdArg(arg) {
  const s = String(arg);
  if (s.length === 0) return '""';
  return `"${s.replace(/(\\*)"/g, '$1$1\\"').replace(/\\+$/g, "$&$&")}"`;
}

export function prepareSpawn(command, args, env = process.env, platform = process.platform) {
  if (platform !== "win32") return { command, args };

  const resolved = resolveWindowsCommand(command, env, platform);
  const ext = path.extname(resolved || command).toLowerCase();
  if (!WINDOWS_SCRIPT_EXTS.has(ext)) return { command: resolved || command, args };

  if (ext === ".ps1") {
    return {
      command: "powershell.exe",
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", resolved || command, ...args],
    };
  }

  const comspec = env.ComSpec || env.COMSPEC || "cmd.exe";
  const commandLine = ["call", quoteCmdArg(resolved || command), ...args.map(quoteCmdArg)].join(" ");
  return { command: comspec, args: ["/d", "/c", commandLine], windowsVerbatimArguments: true };
}

export function spawnCommand(command, args, options) {
  // cross-spawn handles Windows .cmd/.ps1 shim resolution more reliably than
  // our manual PATH scan (covers edge cases like mixed-case PATH env keys).
  if (process.platform === "win32") {
    return crossSpawn(command, args, options);
  }
  return spawn(command, args, options);
}