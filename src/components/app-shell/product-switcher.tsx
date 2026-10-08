'use client';

import { Clapperboard, Presentation } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';

const PRODUCTS = [
  { href: '/app', label: 'Presentation', description: 'Slides and PPTX', icon: Presentation },
  { href: '/app/videos', label: 'Video', description: 'AI learning clip', icon: Clapperboard },
] as const;

export function ProductSwitcher() {
  const pathname = usePathname();
  const [videoRunning, setVideoRunning] = useState(false);

  useEffect(() => {
    let stopped = false;
    const refresh = async () => {
      try {
        const response = await fetch('/api/lesson-videos/active', { cache: 'no-store' });
        if (!response.ok) return;
        const body = await response.json() as { project: { id: string } | null };
        if (!stopped) setVideoRunning(Boolean(body.project));
      } catch {
        // A transient status failure must not interrupt either product page.
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 10_000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, []);

  return (
    <nav aria-label="Create type" className="grid max-w-xl grid-cols-2 gap-2 rounded-xl bg-black/5 p-1.5 dark:bg-white/8">
      {PRODUCTS.map(({ href, label, description, icon: Icon }) => {
        const active = href === '/app' ? pathname === '/app' : pathname.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? 'page' : undefined}
            className={`flex items-center gap-3 rounded-lg px-4 py-3 transition-colors ${
              active
                ? 'bg-white text-neutral-950 shadow-sm dark:bg-neutral-800 dark:text-white'
                : 'text-neutral-600 hover:bg-white/60 dark:text-neutral-300 dark:hover:bg-white/5'
            }`}
          >
            <Icon className="h-5 w-5 shrink-0 text-indigo-600 dark:text-indigo-400" strokeWidth={1.9} />
            <span className="text-left">
              <span className="block text-sm font-semibold">{label}</span>
              <span className="block text-[11px] text-neutral-500 dark:text-neutral-400">{description}</span>
              {href === '/app/videos' && videoRunning ? <span className="mt-1 block text-[11px] font-semibold text-indigo-600 dark:text-indigo-300">● Generating in background</span> : null}
            </span>
          </Link>
        );
      })}
    </nav>
  );
}
