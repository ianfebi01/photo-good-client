import type { NextConfig } from "next";

/**
 * `NEXT_PUBLIC_STANDALONE=1` builds the server-less booth for the Android app:
 * a static export into `out/` that Capacitor bundles into the APK. The device
 * does the server's work itself (lib/photobooth/standalone.ts) and talks to the
 * booth API directly, so the route handlers and the proxy are left out of that
 * build — they are the only `.ts` files under app/, so restricting page
 * extensions to `.tsx` drops them.
 */
const standalone = process.env.NEXT_PUBLIC_STANDALONE === "1";

/**
 * With no server to hold it, the standalone build bakes the booth's API key
 * into the app. It falls back to the server-side `BOOTH_API_KEY`, so the same
 * env files configure both builds.
 */
const boothApiKey =
  process.env.NEXT_PUBLIC_BOOTH_API_KEY || process.env.BOOTH_API_KEY || "";

if ( standalone && ( !process.env.NEXT_PUBLIC_BASE_URL || !boothApiKey ) ) {
  throw new Error(
    "The standalone (Android) build calls the booth API directly: set NEXT_PUBLIC_BASE_URL and BOOTH_API_KEY (or NEXT_PUBLIC_BOOTH_API_KEY).",
  );
}

const nextConfig: NextConfig = standalone
  ? {
    output         : 'export',
    pageExtensions : ['tsx'],
    images         : { unoptimized : true },
    env            : { NEXT_PUBLIC_BOOTH_API_KEY : boothApiKey },
    // The type check covers the whole project, route handlers included, but
    // this build leaves the routes out, so their generated `RouteContext`
    // types never exist and it fails. The regular build checks the same code.
    typescript     : { ignoreBuildErrors : true },
  }
  : {
    output : 'standalone',
    images : {
      remotePatterns : [
        {
          protocol : 'https',
          hostname : 'images.unsplash.com',
        },
      ],
    },
  };

export default nextConfig;
