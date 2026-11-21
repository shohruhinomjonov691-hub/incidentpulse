import type { NextConfig } from "next";

const config: NextConfig = {
  poweredByHeader: false,
  transpilePackages: [
    "@incidentpulse/orchestrator",
    "@incidentpulse/mcp-actions",
    "@incidentpulse/schemas",
    "@incidentpulse/redact",
  ],
  experimental: { serverActions: { bodySizeLimit: "8kb" } },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Cache-Control", value: "private, no-store" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "no-referrer" },
        ],
      },
    ];
  },
};

export default config;
