import type { NextConfig } from "next";
import { execFileSync } from "node:child_process";

let sourceRevision =
  process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.GITHUB_SHA ?? "";
let sourceState = "unknown";
try {
  sourceRevision = execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
    timeout: 3000,
    maxBuffer: 1024,
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  sourceState = execFileSync(
    "git",
    ["status", "--porcelain", "--untracked-files=normal"],
    {
      encoding: "utf8",
      timeout: 3000,
      maxBuffer: 65536,
      stdio: ["ignore", "pipe", "ignore"],
    },
  ).trim()
    ? "modified"
    : "clean";
} catch {}
if (!/^[a-f0-9]{40,64}$/i.test(sourceRevision)) sourceRevision = "";

const config: NextConfig = {
  env: {
    NEXT_PUBLIC_RAZOR_SOURCE_REVISION: sourceRevision,
    NEXT_PUBLIC_RAZOR_SOURCE_STATE: sourceState,
    NEXT_PUBLIC_RAZOR_BUILT_AT: new Date().toISOString(),
  },
  serverExternalPackages: ["@nearai/inference-sdk", "@phala/dcap-qvl"],
  experimental: {
    optimizePackageImports: ["viem/chains"],
    cpus: 1,
    workerThreads: false,
    webpackBuildWorker: false,
    webpackMemoryOptimizations: true,
  },
  outputFileTracingExcludes: {
    "*": [
      "./inspiration/**/*",
      "./research/**/*",
      "./.worktrees/**/*",
      "./.tools/**/*",
    ],
  },
};

export default config;
