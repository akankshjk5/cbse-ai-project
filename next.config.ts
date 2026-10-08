import type { NextConfig } from "next";

import { SERVER_ACTION_BODY_LIMIT_BYTES } from "./src/lib/uploads";

const nextConfig: NextConfig = {
  /**
   * `Agents/pptx/browser-layout.ts` launches Playwright's Chromium to
   * measure/render slides server-side. Playwright loads its browser binary
   * natively (not via a bundler-friendly export map), so it must be excluded
   * from Next's server bundling rather than traced into it.
   */
  serverExternalPackages: ['playwright', 'playwright-core'],
  experimental: {
    serverActions: {
      /**
       * A style reference is a screenshot or an exported slide — routinely 2-6MB,
       * which the 1MB default rejects with a runtime error the form cannot catch:
       * the request dies before the Server Action runs, so there is nothing for
       * `useActionState` to render.
       *
       * The number, and the reason it is bigger than the image limit itself,
       * live in src/lib/uploads.ts alongside the checks that enforce it.
       */
      bodySizeLimit: SERVER_ACTION_BODY_LIMIT_BYTES,
    },
  },
};

export default nextConfig;
