/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        brand: {
          50: "#EFF6FF",
          100: "#DBEAFE",
          500: "#3B82F6",
          600: "#2563EB",
          700: "#1E40AF",
        },
      },
      fontFamily: {
        sans: ["PingFang SC", "Microsoft YaHei", "system-ui", "sans-serif"],
      },
      boxShadow: {
        glass: "0 8px 32px rgba(15, 23, 42, 0.12)",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
};
