import { ClerkProvider } from "@clerk/nextjs";
import { dark } from "@clerk/ui/themes";
import type { Metadata } from "next";
import { cookies } from "next/headers";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

import { THEME_COOKIE, resolveTheme } from "@/lib/theme";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Lumina Deck Pro",
  description: "AI-generated presentation decks.",
};

/**
 * Root layout stays chrome-free on purpose. The signed-in shell lives in
 * src/app/app/layout.tsx so it can own the full viewport height, and so
 * sign-in/sign-up render on a clean page.
 *
 * The theme is resolved here, server-side, from a cookie. That puts the `dark`
 * class in the initial HTML — no flash of white before a script corrects it —
 * and lets Clerk's components be handed a matching baseTheme.
 */
export default async function RootLayout({ children }: LayoutProps<"/">) {
  const cookieStore = await cookies();
  const theme = resolveTheme(cookieStore.get(THEME_COOKIE)?.value);

  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased${
        theme === "dark" ? " dark" : ""
      }`}
    >
      <body className="min-h-full">
        {/* ClerkProvider must sit inside <body>, not around <html>. */}
        <ClerkProvider appearance={theme === "dark" ? { theme: dark } : undefined}>
          {children}
        </ClerkProvider>
      </body>
    </html>
  );
}
