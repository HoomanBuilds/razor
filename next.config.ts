import type { NextConfig } from "next";

const config: NextConfig = {
  serverExternalPackages: ["@nearai/inference-sdk", "@phala/dcap-qvl"],
  experimental: {
    optimizePackageImports: ["viem/chains"],
    cpus: 1,
    workerThreads: false,
    webpackBuildWorker: false,
    webpackMemoryOptimizations: true,
  },
  outputFileTracingExcludes: { "*": ["./inspiration/**/*", "./research/**/*", "./.worktrees/**/*", "./.tools/**/*"] },
};

export default config;
