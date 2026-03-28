import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  serverExternalPackages: ["playwright-core", "open-banking-chile"],
  outputFileTracingRoot: path.join(__dirname, ".."),
  webpack(config) {
    // open-banking-chile is a symlinked local package -- serverExternalPackages
    // doesn't apply to symlinks because Next.js resolves to the real path.
    // Force it external here so googleapis/exceljs (sync-only deps) don't get
    // bundled and create a duplicate `ws` that breaks playwright's CDP socket.
    config.externals = [
      ...(Array.isArray(config.externals) ? config.externals : []),
      ({ request }: { request: string }, callback: (err?: Error | null, result?: string) => void) => {
        if (request === "open-banking-chile") {
          return callback(null, "commonjs open-banking-chile");
        }
        callback();
      },
    ];
    return config;
  },
};

export default nextConfig;
