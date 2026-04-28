import type { Config } from "tailwindcss"

const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
  ],
  // Light-only theme. Toggle to "media" or "class" when adding a
  // dark mode pass — none of the color tokens are dark-aware today.
  darkMode: "media",
  theme: {
    extend: {
      fontFamily: {
        sans:    ["var(--font-geist-sans)", "system-ui", "sans-serif"],
        mono:    ["var(--font-geist-mono)", "ui-monospace", "monospace"],
        display: ["var(--font-display)", "Georgia", "serif"],
      },
    },
  },
}

export default config
