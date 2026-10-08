export const THEME_COOKIE = 'lumina_theme';

export type Theme = 'light' | 'dark';

/**
 * Light is the default, deliberately — not the OS preference.
 *
 * Anything other than the literal string 'dark' resolves to light, so a
 * missing or corrupted cookie lands on white rather than a surprise dark app.
 */
export function resolveTheme(cookieValue: string | undefined): Theme {
  return cookieValue === 'dark' ? 'dark' : 'light';
}
