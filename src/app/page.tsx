import { auth } from '@clerk/nextjs/server';
import { redirect } from 'next/navigation';

/**
 * `/` has no page of its own: a signed-in visitor goes to their decks, everyone
 * else to sign-in (which links to sign-up). The marketing landing page was
 * removed on purpose; this is a tool for invited schools, not a public product.
 *
 * `/` stays public in `src/proxy.ts` so this redirect, not `auth.protect()`,
 * decides where a visitor lands.
 */
export default async function Home() {
  const { userId } = await auth();
  redirect(userId ? '/app' : '/sign-in');
}
