'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Moon, Sun } from 'lucide-react';

import { THEME_COOKIE, type Theme } from '@/lib/theme';

/**
 * Light/dark switch.
 *
 * Flips the `dark` class immediately so the UI responds without waiting on the
 * network, then refreshes so the server re-renders with the new cookie — that
 * second step is what re-themes Clerk's components, whose appearance is chosen
 * server-side in the root layout.
 */
export function ThemeToggle({
  initialTheme,
  compact = false,
}: {
  initialTheme: Theme;
  compact?: boolean;
}) {
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const router = useRouter();

  function toggle() {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    document.documentElement.classList.toggle('dark', next === 'dark');
    document.cookie = `${THEME_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
    router.refresh();
  }

  const label = theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
  const Icon = theme === 'dark' ? Sun : Moon;

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={label}
      title={label}
      className={
        compact
          ? 'h-8 w-8 rounded-lg text-neutral-500 transition-colors hover:bg-black/5 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-white/10 dark:hover:text-neutral-100'
          : 'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-neutral-500 transition-colors hover:bg-black/5 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-white/10 dark:hover:text-neutral-100'
      }
    >
      <Icon className="mx-auto h-[18px] w-[18px]" strokeWidth={1.8} />
    </button>
  );
}
