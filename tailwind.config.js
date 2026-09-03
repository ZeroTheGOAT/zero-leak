/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      // Colors are not declared here on purpose. Every surface and accent comes
      // from the theme tokens in nerve-theme.css via bg-[var(--token)], so it
      // follows data-theme and light/dark; a fixed palette here could not.
      fontFamily: {
        sans: ['"Outfit"', 'ui-sans-serif', 'system-ui', '-apple-system', 'BlinkMacSystemFont', '"Segoe UI"', 'sans-serif'],
        mono: ['"Iosevka"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'Monaco', 'Consolas', 'monospace'],
      },
    },
  },
  plugins: [],
}
