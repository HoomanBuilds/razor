import { spawn, execFileSync } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { freemem, setPriority } from "node:os";
import { dirname, resolve } from "node:path";

const [major, minor, patch] = process.versions.node.split(".").map(Number);
if (major < 24 || major === 24 && (minor < 22 || minor === 22 && patch < 1)) {
  console.error("Use Node 24.22.1 or later. Run nvm install and nvm use in this repository first.");
  process.exit(1);
}

const [mode, ...args] = process.argv.slice(2);
if (!["build", "dev", "typecheck"].includes(mode)) throw new Error("Choose build, dev or typecheck.");

function availableMb() {
  if (process.platform === "linux") {
    const available = readFileSync("/proc/meminfo", "utf8").match(/^MemAvailable:\s+(\d+) kB/m);
    if (available) return Number(available[1]) / 1024;
  }
  return freemem() / 1024 / 1024;
}

if (availableMb() < 4096) {
  console.error("Wait for at least 4 GB of available memory before starting Razor compilation.");
  process.exit(1);
}

let commonDirectory;
try { commonDirectory = resolve(execFileSync("git", ["rev-parse", "--git-common-dir"], { encoding: "utf8" }).trim(), ".."); }
catch { commonDirectory = process.cwd(); }
const lockPath = resolve(commonDirectory, ".tools/next-build.lock");
mkdirSync(dirname(lockPath), { recursive: true });
for (let attempt = 0; attempt < 2; attempt++) {
  try {
    const descriptor = openSync(lockPath, "wx", 0o600);
    writeFileSync(descriptor, String(process.pid));
    closeSync(descriptor);
    break;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const pid = Number(readFileSync(lockPath, "utf8"));
    let active = true;
    try { process.kill(pid, 0); } catch (cause) { if (cause.code === "ESRCH") active = false; }
    if (active || attempt) { console.error("Another Razor compiler or development server is active. Stop it before compiling."); process.exit(1); }
    unlinkSync(lockPath);
  }
}

const heapOptions = (process.env.NODE_OPTIONS ?? "").replace(/--max-old-space-size(?:=|\s+)\d+/g, "");
const command = mode === "typecheck"
  ? [resolve("node_modules/typescript/bin/tsc"), "--noEmit", ...args]
  : [resolve("node_modules/next/dist/bin/next"), mode, "--webpack", ...args];
const child = spawn(process.execPath, command, {
  stdio: "inherit",
  detached: process.platform !== "win32",
  env: { ...process.env, NODE_OPTIONS: `${heapOptions} --max-old-space-size=1536`.trim() },
});
try { setPriority(child.pid, 10); } catch {}
let stopped = false, lowReadings = 0;
function stop(signal = "SIGTERM") {
  if (stopped) return;
  stopped = true;
  try { process.kill(process.platform === "win32" ? child.pid : -child.pid, signal); } catch {}
  const timeout = setTimeout(() => { try { process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGKILL"); } catch {} }, 5000);
  timeout.unref();
}
const monitor = setInterval(() => {
  lowReadings = availableMb() < 3072 ? lowReadings + 1 : 0;
  if (lowReadings >= 2) { console.error("Stopping Razor compilation to preserve 3 GB of available memory for the laptop."); stop(); }
}, 1500);
function cleanup() {
  clearInterval(monitor);
  try { if (readFileSync(lockPath, "utf8") === String(process.pid)) unlinkSync(lockPath); } catch {}
}
process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop());
child.on("error", (error) => { console.error(error.message); cleanup(); process.exitCode = 1; });
child.on("exit", (code) => { cleanup(); process.exitCode = code ?? 1; });
