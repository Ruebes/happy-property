/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        'hp-bg': '#fffcf6',
        'hp-black': '#000000',
        'hp-highlight': '#ff795d',
        'hp-slate': '#2d3748',
        'hp-navy': '#1a2332',
        'hp-cream': '#fffcf6',
      },
      fontFamily: {
        heading: ['"Playfair Display"', 'serif'],
        body: ['Montserrat', 'sans-serif'],
      },
    },
  },
  plugins: [],
}
