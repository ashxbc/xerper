import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Allow loading the dev server over the LAN address, not just localhost
  allowedDevOrigins: ["192.168.1.8"],
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "pbs.twimg.com",
        pathname: "/profile_images/**",
      },
    ],
  },
};

export default nextConfig;
