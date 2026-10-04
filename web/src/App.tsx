import { motion } from "motion/react";

/**
 * Temporary scaffold root.
 *
 * Proves the toolchain end to end (React + Tailwind v4 tokens + Motion +
 * Radix + Lucide) BEFORE the design system is built on top of it. If the build
 * pipeline or the Workers asset layout is wrong, this is the cheapest place to
 * find out. Replaced by the real router + shell in Phase 6.
 */
export function App() {
  return (
    <div className="min-h-dvh bg-[var(--surface-0)] text-[var(--foreground)]">
      <motion.header
        initial={{ opacity: 0, y: -6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
        className="flex h-14 items-center gap-3 border-b border-[var(--border)] px-6"
      >
        <span className="size-[22px] rounded-md bg-[var(--accent)] glow-accent" />
        <span className="text-label font-semibold tracking-wide">SQANNY</span>
      </motion.header>

      <main className="mx-auto w-full max-w-[1440px] px-6 py-10">
        <h1 className="text-display font-semibold tracking-tight">
          Toolchain verified
        </h1>
        <p className="mt-3 max-w-[52ch] text-body text-[var(--foreground-muted)]">
          React, Tailwind tokens, Motion and Radix are compiling. The QR redirect
          path never loads this bundle.
        </p>
        <div className="mt-8 grid grid-cols-3 gap-4">
          {["Surface", "Accent", "Status"].map((label) => (
            <div
              key={label}
              className="rounded-xl bg-[var(--surface-1)] p-5 text-label text-[var(--foreground-muted)]"
            >
              {label}
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}