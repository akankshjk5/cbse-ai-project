'use client';

import { useState } from 'react';
import { PanelLeftOpen } from 'lucide-react';

import { Sidebar } from './sidebar';

export const SIDEBAR_COOKIE = 'lumina_sidebar';

/**
 * Client wrapper that owns sidebar open/closed state.
 *
 * The preference is persisted in a cookie, not localStorage, so the server
 * already knows it at render time (see src/app/app/layout.tsx). localStorage
 * would mean rendering "open" on the server and correcting after mount — a
 * hydration mismatch and a visible flicker on every load.
 *
 * `children` and `account` are server-rendered content passed through this
 * client boundary, which keeps them server-rendered.
 */
export function AppShell({
  defaultOpen,
  account,
  themeToggle,
  children,
}: {
  defaultOpen: boolean;
  account: React.ReactNode;
  themeToggle: React.ReactNode;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);

  function toggle() {
    setOpen((previous) => {
      const next = !previous;
      // One year, site-wide. Not sensitive — a UI preference.
      document.cookie = `${SIDEBAR_COOKIE}=${next ? 'open' : 'closed'}; path=/; max-age=31536000; samesite=lax`;
      return next;
    });
  }

  return (
    <div className="flex h-dvh overflow-hidden bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      {open ? (
        <Sidebar onCollapse={toggle} account={account} themeToggle={themeToggle} />
      ) : (
        // A slim strip rather than a floating button: it reopens the sidebar
        // without overlapping the page's own header.
        <div className="flex w-12 shrink-0 flex-col items-center gap-4 border-r border-black/8 py-4 dark:border-white/10">
          <button
            type="button"
            onClick={toggle}
            aria-label="Open sidebar"
            aria-expanded={false}
            title="Open sidebar"
            className="h-8 w-8 rounded-lg text-neutral-500 transition-colors hover:bg-black/5 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-white/10 dark:hover:text-neutral-100"
          >
            <PanelLeftOpen className="mx-auto h-[18px] w-[18px]" strokeWidth={1.8} />
          </button>
          {themeToggle}
          {/* Account stays reachable while collapsed. */}
          <div className="mt-auto">{account}</div>
        </div>
      )}

      <main className="flex-1 overflow-y-auto">{children}</main>
    </div>
  );
}
