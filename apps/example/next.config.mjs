/** @type {import('next').NextConfig} */
const nextConfig = {
  // The example consumes @ai-router/core's TypeScript source directly via the
  // workspace (see tsconfig paths) — Next compiles it for us. Apps installing
  // the published package don't need this line.
  transpilePackages: ["@ai-router/core"],
  cacheComponents: true,
  webpack: (config) => {
    // The core's source imports use NodeNext-style ".js" specifiers
    // (correct for ESM output); teach webpack to resolve them to ".ts".
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
      ".mjs": [".mts", ".mjs"],
      ".cjs": [".cts", ".cjs"],
    };
    return config;
  },
};

export default nextConfig;
