import type { NextConfig } from "next";

const config: NextConfig = {
  serverExternalPackages: ["@nearai/inference-sdk", "@phala/dcap-qvl"],
  experimental: {
    cpus: 1,
    workerThreads: false,
    webpackBuildWorker: false,
    webpackMemoryOptimizations: true,
  },
  outputFileTracingExcludes: { "*": ["./inspiration/**/*", "./research/**/*", "./.worktrees/**/*", "./.tools/**/*"] },
};

export default config;
