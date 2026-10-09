import type { NextConfig } from "next";

const nextConfig: NextConfig = {
	// Publishing builds into a separate directory so the running dev server is not disturbed.
	distDir: process.env.NEXT_DIST_DIR || ".next",
	output: "standalone",
	serverExternalPackages: ["pg"],
	devIndicators: false,
	// The preview is served on <app>-preview.<domain>; Next blocks dev requests (HMR) from origins it does not know.
	allowedDevOrigins: process.env.AGENCY_DEV_ORIGINS?.split(",") ?? [],
};

export default nextConfig;
