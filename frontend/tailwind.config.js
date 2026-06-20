/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './lib/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      // ── সাইবারপাংক কালার প্যালেট ──────────────────
      colors: {
        // Dark backgrounds
        'void':    '#050508',    // গেমের মূল ব্যাকগ্রাউন্ড
        'surface': '#0D0D14',    // কার্ড/প্যানেলের ব্যাকগ্রাউন্ড
        'border':  '#1A1A2E',    // বর্ডার কালার

        // Neon accents
        'neon': {
          'green':  '#00FF94',   // জেতার রঙ / প্রাইমারি অ্যাকসেন্ট
          'blue':   '#00D4FF',   // ইনফো / হাইলাইট
          'purple': '#B44FFF',   // স্পেশাল ইভেন্ট / Squad
          'gold':   '#FFD700',   // জ্যাকপট / উইন স্ট্রিক
          'red':    '#FF3A3A',   // হারার রঙ / ওয়ার্নিং
        },

        // Text hierarchy
        'text': {
          'primary':   '#FFFFFF',
          'secondary': '#A0A0B8',
          'muted':     '#4A4A6A',
        },
      },

      // ── ফন্ট ──────────────────────────────────────
      fontFamily: {
        'display': ['Orbitron', 'monospace'],   // হেডিং - সাইবারপাংক
        'body':    ['Inter', 'sans-serif'],      // বডি টেক্সট
        'mono':    ['JetBrains Mono', 'monospace'], // নম্বর/কোড
      },

      // ── অ্যানিমেশন ─────────────────────────────────
      animation: {
        'glow-pulse':   'glowPulse 2s ease-in-out infinite',
        'float-up':     'floatUp 0.6s ease-out forwards',
        'spin-slow':    'spin 3s linear infinite',
        'rain-drop':    'rainDrop 1s ease-in forwards',
        'neon-flicker': 'neonFlicker 0.15s infinite',
      },
      keyframes: {
        glowPulse: {
          '0%, 100%': { boxShadow: '0 0 20px rgba(0, 255, 148, 0.3)' },
          '50%':      { boxShadow: '0 0 40px rgba(0, 255, 148, 0.7)' },
        },
        floatUp: {
          '0%':   { opacity: '0', transform: 'translateY(20px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        rainDrop: {
          '0%':   { opacity: '1', transform: 'translateY(-20px)' },
          '100%': { opacity: '0', transform: 'translateY(100vh)' },
        },
        neonFlicker: {
          '0%, 19%, 21%, 23%, 25%, 54%, 56%, 100%': { opacity: '1' },
          '20%, 24%, 55%':                            { opacity: '0.4' },
        },
      },

      // ── বক্স শ্যাডো (নিয়ন গ্লো) ──────────────────
      boxShadow: {
        'neon-green':  '0 0 20px rgba(0, 255, 148, 0.5)',
        'neon-blue':   '0 0 20px rgba(0, 212, 255, 0.5)',
        'neon-purple': '0 0 20px rgba(180, 79, 255, 0.5)',
        'neon-gold':   '0 0 20px rgba(255, 215, 0, 0.5)',
        'neon-red':    '0 0 20px rgba(255, 58, 58, 0.5)',
      },

      // ── ব্যাকগ্রাউন্ড গ্র্যাডিয়েন্ট ──────────────
      backgroundImage: {
        'grid-pattern':   'radial-gradient(circle, #1A1A2E 1px, transparent 1px)',
        'hero-gradient':  'radial-gradient(ellipse at center, #0D0D1A 0%, #050508 100%)',
        'win-gradient':   'linear-gradient(135deg, #00FF94 0%, #00D4FF 100%)',
        'lose-gradient':  'linear-gradient(135deg, #FF3A3A 0%, #B44FFF 100%)',
        'squad-gradient': 'linear-gradient(135deg, #B44FFF 0%, #00D4FF 100%)',
      },
    },
  },
  plugins: [],
};
