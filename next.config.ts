import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Emit .next/standalone — a self-contained server bundle with only the
  // node_modules it actually uses. The Dockerfile's runner stage copies this,
  // so removing it breaks the production image.
  output: "standalone",

  // Native/binary packages that must stay external to the server bundle rather
  // than being traced and inlined by the compiler.
  serverExternalPackages: ["pdf-parse", "mammoth", "playwright"],

  // Don't advertise the framework to every caller.
  poweredByHeader: false,

  // Baseline hardening for a locally-hosted dashboard. No CSP here: the app
  // relies on Next's inline runtime scripts, and a nonce-based policy needs
  // per-request middleware — tracked in the roadmap rather than half-done.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-DNS-Prefetch-Control", value: "off" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), interest-cohort=()",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
