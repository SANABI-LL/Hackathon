import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // pdf-parse/pdfjs-dist need runtime DOM polyfills from @napi-rs/canvas
  // (native binary) — keep all three out of the webpack bundle and let
  // Node require them from node_modules on the Amplify SSR compute.
  serverExternalPackages: ["pdf-parse", "pdfjs-dist", "@napi-rs/canvas"],
};

export default nextConfig;
