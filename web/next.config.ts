import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  trailingSlash: true,
  images: {
    unoptimized: true,
  },
};

export default nextConfig;

import("@opennextjs/cloudflare").then(
  (m) => m.initOpenNextCloudflareForDev()
);
