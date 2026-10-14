'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Clapperboard, Film, Presentation, PanelLeftClose } from 'lucide-react';

/**
 * The single sidebar: brand, sections, account.
 *
 * Everything here is backed by real data. Nav entries are added when the page
 * and its table exist — not before, so nothing in this shell is a button that
 * does nothing.
 */
const NAV_ITEMS = [
  { href: '/app', label: 'Presentations', icon: Presentation },
  { href: '/app/videos', label: 'Videos', icon: Clapperboard },
  { href: '/app/cloud-lessons', label: 'Lesson Video', icon: Film },
] as const;

export function Sidebar({
  onCollapse,
  account,
  themeToggle,
}: {
  onCollapse: () => void;
  account: React.ReactNode;
  themeToggle: React.ReactNode;
}) {
  const pathname = usePathname();

  return (
    <aside className="flex w-[260px] shrink-0 flex-col border-r border-black/8 bg-neutral-50/60 px-3 py-4 dark:border-white/10 dark:bg-neutral-900/40">
      <div className="flex items-center justify-between gap-1 px-2 py-1">
        <Link href="/app" className="flex items-center gap-2 text-[15px] font-semibold tracking-tight">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-indigo-600 text-sm font-bold text-white">
            L
          </span>
          Lumina
        </Link>
        <div className="flex items-center gap-0.5">
        {themeToggle}
        <button
          type="button"
          onClick={onCollapse}
          aria-label="Close sidebar"
          aria-expanded
          title="Close sidebar"
          className="h-8 w-8 shrink-0 rounded-lg text-neutral-500 transition-colors hover:bg-black/5 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-white/10 dark:hover:text-neutral-100"
        >
          <PanelLeftClose className="mx-auto h-[18px] w-[18px]" strokeWidth={1.8} />
        </button>
        </div>
      </div>

      <nav aria-label="Sections" className="mt-4 flex flex-col gap-0.5">
        {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
          const active = href === '/app' ? pathname === '/app' : pathname.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? 'page' : undefined}
              className={`flex items-center gap-3 rounded-lg px-3 py-2.5 text-[15px] transition-colors ${
                active
                  ? 'bg-black/6 font-medium dark:bg-white/10'
                  : 'text-neutral-700 hover:bg-black/4 dark:text-neutral-300 dark:hover:bg-white/5'
              }`}
            >
              <Icon className="h-[18px] w-[18px] shrink-0" strokeWidth={1.8} />
              {label}
            </Link>
          );
        })}
      </nav>

      <div className="mt-auto flex items-center gap-3 border-t border-black/8 px-2 pt-3 dark:border-white/10">
        {account}
      </div>
    </aside>
  );
}
