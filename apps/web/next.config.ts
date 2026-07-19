import path from "node:path";
import { fileURLToPath } from "node:url";

import type { NextConfig } from "next";

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

const nextConfig: NextConfig = {
  images: {
    unoptimized: true,
  },
  output: "export",
  reactStrictMode: true,
  transpilePackages: ["@reflo/config", "@reflo/contracts"],
  turbopack: {
    root: workspaceRoot,
  },
};

export default nextConfig;
