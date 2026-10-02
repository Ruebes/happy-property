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
      // left-4.5 (Schalter-Knopf im Rechner-Assistenten), 1.125rem = 18 px
      spacing: {
        '4.5': '1.125rem',
      },
      // animate-fade-in (Kontextmenü und Hinweise) und animate-slide-up
      // (Hinweise unten rechts): kurz und dezent, Endzustand = normale Ansicht.
      keyframes: {
        'fade-in': {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        'slide-up': {
          from: { opacity: '0', transform: 'translateY(8px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        'fade-in': 'fade-in 150ms ease-out',
        'slide-up': 'slide-up 200ms ease-out',
      },
    },
  },
  plugins: [],
}
