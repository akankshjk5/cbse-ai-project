import { UserButton } from '@clerk/nextjs';
import { cookies } from 'next/headers';

import { AppShell, SIDEBAR_COOKIE } from '@/components/app-shell/app-shell';
import { ThemeToggle } from '@/components/app-shell/theme-toggle';
import { requireUserId } from '@/lib/auth/session';
import { THEME_COOKIE, resolveTheme } from '@/lib/theme';

/**
 * The signed-in shell: sidebar plus scrollable content.
 *
 * requireUserId() runs here so every page nested under /app inherits the check.
 * That is convenience, not the boundary — each page still re-checks before it
 * touches data, because a layout can be skipped on client-side navigations.
 */
export default async function AppLayout({ children }: LayoutProps<'/app'>) {
  await requireUserId();

  // Read the sidebar preference server-side so the first paint is already
  // correct — no flash of an open sidebar before collapsing it.
  const cookieStore = await cookies();
  const sidebarOpen = cookieStore.get(SIDEBAR_COOKIE)?.value !== 'closed';
  const theme = resolveTheme(cookieStore.get(THEME_COOKIE)?.value);

  return (
    <AppShell
      defaultOpen={sidebarOpen}
      themeToggle={<ThemeToggle initialTheme={theme} />}
      account={
        <UserButton
          showName
          appearance={{
            elements: {
              userButtonBox: { flexDirection: 'row-reverse' },
              userButtonAvatarBox: { width: 30, height: 30 },
            },
          }}
        />
      }
    >
      {children}
    </AppShell>
  );
}
