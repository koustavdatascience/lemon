/** @type {import('tailwindcss').Config} */
export default {
  // Only scan side-panel and options source files so Tailwind doesn't
  // accidentally purge styles used in the extension UI.
  content: [
    "./side-panel/**/*.{js,jsx,ts,tsx,html}",
    "./options/**/*.{js,jsx,ts,tsx,html}",
  ],
  theme: {
    extend: {
      colors: {
        lemon: {
          50:  "#fefce8",
          100: "#fef9c3",
          200: "#fef08a",
          300: "#fde047",
          400: "#facc15",
          500: "#eab308",
          600: "#ca8a04",
          700: "#a16207",
          800: "#854d0e",
          900: "#713f12",
        },
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
      },
    },
  },
  plugins: [],
};
