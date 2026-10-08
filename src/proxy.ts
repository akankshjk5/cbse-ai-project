import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';

/**
 * Next.js 16 renamed Middleware to Proxy. One file per project, beside `app/`.
 *
 * The rule is a **deny-list of public routes**, not an allow-list of protected
 * ones. Everything that is not named here needs a session, so a new route is
 * protected the moment it exists rather than the moment someone remembers to
 * add it to a matcher — which is the failure mode the old
 * `isProtectedRoute(['/', '/app(.*)'])` shape had waiting in it.
 *
 * Public, and deliberately short:
 *  - `/` — the landing page. It used to be protected, which meant a signed-out
 *    visitor's first impression of the product was a login form for something
 *    they had never heard of. `src/app/page.tsx` forwards a signed-IN visitor
 *    to /app, so nobody loses their decks to this change.
 *  - `/sign-in`, `/sign-up` — Clerk's own screens.
 *  - `/api/webhooks(.*)` — Clerk calls these with no session and its own
 *    signature. `auth.protect()` here would answer 401 to Clerk itself; the
 *    handler verifies `verifyWebhook` instead, which is the real check.
 *  - A future shared-deck viewer (`/d/<id>`) belongs here too, or link-shared
 *    decks will demand a login and the `visibility in ('public','unlisted')`
 *    RLS policies stay unreachable.
 *
 * Still only the outer gate. Pages and Server Actions re-check with
 * `requireUserId()`, and RLS re-checks under both.
 */
const isPublicRoute = createRouteMatcher([
  '/',
  '/sign-in(.*)',
  '/sign-up(.*)',
  '/api/webhooks(.*)',
]);

export default clerkMiddleware(async (auth, request) => {
  if (!isPublicRoute(request)) await auth.protect();
});

export const config = {
  matcher: [
    // Skip Next internals and static files unless found in search params.
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    // Always run for API routes.
    '/(api|trpc)(.*)',
    // Clerk's auto-proxy path.
    '/__clerk/:path*',
  ],
};
