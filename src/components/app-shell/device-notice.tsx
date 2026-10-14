import { MonitorSmartphone } from 'lucide-react';

/**
 * Shown instead of the app on phone-sized screens.
 *
 * Lumina's deck viewer, animation editor and lesson studio are laid out for a
 * laptop, desktop or tablet, so a phone gets this message rather than a
 * squeezed app. Visibility is pure CSS (`.device-gate-*` in globals.css), so the
 * server sends both and the browser shows the right one on first paint, with
 * no flash of the app on a phone.
 */
export function DeviceNotice() {
  return (
    <div
      role="alert"
      className="device-gate-notice min-h-dvh flex-col items-center justify-center bg-white px-8 text-center text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100"
    >
      <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-indigo-600 text-lg font-bold text-white">
        L
      </span>
      <MonitorSmartphone className="mt-8 h-9 w-9 text-indigo-500" strokeWidth={1.6} aria-hidden />
      <h1 className="mt-4 text-xl font-semibold tracking-tight">This device is not supported</h1>
      <p className="mt-3 max-w-xs text-sm leading-relaxed text-neutral-500 dark:text-neutral-400">
        Open Lumina on a laptop, desktop or tablet. Phone screens are too small for the slide and lesson editors.
      </p>
    </div>
  );
}
