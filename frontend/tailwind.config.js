/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './lib/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      // ═══════════════════════════════════════════════════════
      //  COLOR SYSTEM — Stake.com-এর crisp casino-dark বেস +
      //  বাংলাদেশী সাংস্কৃতিক রঙ (পতাকার সবুজ-লাল, উৎসবের সোনালী)
      // ═══════════════════════════════════════════════════════
      colors: {
        // ── বেস ব্যাকগ্রাউন্ড (Stake-স্টাইল ডিপ নেভি-ব্ল্যাক, খাঁটি কালো নয়) ──
        'void':    '#0B0E11',   // মূল ব্যাকগ্রাউন্ড
        'surface': '#141920',   // কার্ড/প্যানেল
        'surface2':'#1B212B',   // উঁচু স্তরের কার্ড (elevated)
        'border':  '#262C36',   // স্ট্যান্ডার্ড বর্ডার
        'border2': '#343C49',   // হাইলাইট বর্ডার (hover/focus)

        // ── ব্র্যান্ড রঙ — বাংলাদেশের পতাকা + উৎসবের রঙ থেকে অনুপ্রাণিত ──
        'brand': {
          // প্রাইমারি: পতাকার গাঢ় সবুজ থেকে Stake-গ্রেড vivid emerald
          'green':      '#00C566',
          'green-dim':  '#0A9A52',
          // পতাকার লাল বৃত্ত — হার/বিপদ নির্দেশক
          'red':        '#E8384F',
          'red-dim':    '#B82B3D',
          // উৎসবের সোনালী (পহেলা বৈশাখ, ঈদ) — প্রিমিয়াম/স্ট্রিক/রেইন
          'gold':       '#E8A93D',
          'gold-dim':   '#C28A28',
          // নকশী কাঁথা মেরুন/বেগুনি — স্কোয়াড ফিচারের জন্য আলাদা পরিচয়
          'maroon':     '#A8395C',
          'maroon-dim': '#822C47',
          // নিরপেক্ষ তথ্য — প্রশমিত স্লেট-নীল (চোখ ধাঁধানো নয়)
          'info':       '#5B8DEF',
          'info-dim':   '#3F6BC4',
        },

        // ── টেক্সট হায়ারার্কি ──────────────────────────────────
        'text': {
          'primary':   '#F4F6F8',
          'secondary': '#9AA3B2',
          'muted':     '#5B6472',
        },
      },

      // ── ফন্ট — Stake-গ্রেড: জ্যামিতিক geometric display + পরিষ্কার বডি ──
      fontFamily: {
        'display': ['"Space Grotesk"', 'sans-serif'],
        'body':    ['Inter', 'sans-serif'],
        'mono':    ['"JetBrains Mono"', 'monospace'],
      },

      // ── অ্যানিমেশন — সূক্ষ্ম, পেশাদার (গ্লো-হীন) ─────────────
      animation: {
        'float-up':    'floatUp 0.4s cubic-bezier(0.16,1,0.3,1) forwards',
        'spin-slow':   'spin 3s linear infinite',
        'rain-drop':   'rainDrop 1s ease-in forwards',
        'pulse-soft':  'pulseSoft 2.4s ease-in-out infinite',
        'lift-in':     'liftIn 0.25s cubic-bezier(0.16,1,0.3,1) forwards',
      },
      keyframes: {
        floatUp: {
          '0%':   { opacity: '0', transform: 'translateY(8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        rainDrop: {
          '0%':   { opacity: '1', transform: 'translateY(-20px)' },
          '100%': { opacity: '0.2', transform: 'translateY(100vh)' },
        },
        pulseSoft: {
          '0%, 100%': { opacity: '1' },
          '50%':      { opacity: '0.55' },
        },
        liftIn: {
          '0%':   { opacity: '0', transform: 'translateY(4px) scale(0.98)' },
          '100%': { opacity: '1', transform: 'translateY(0) scale(1)' },
        },
      },

      // ── এলিভেশন শ্যাডো — Stake-স্টাইল লেয়ার্ড ডেপথ (গ্লো নয়, real shadow) ──
      boxShadow: {
        'elevate-sm': '0 1px 2px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.03) inset',
        'elevate-md': '0 2px 8px rgba(0,0,0,0.45), 0 1px 0 rgba(255,255,255,0.04) inset',
        'elevate-lg': '0 8px 24px rgba(0,0,0,0.5), 0 12px 40px rgba(0,0,0,0.3), 0 1px 0 rgba(255,255,255,0.05) inset',
        'brand-green': '0 4px 14px rgba(0,197,102,0.28), 0 1px 0 rgba(255,255,255,0.15) inset',
        'brand-red':   '0 4px 14px rgba(232,56,79,0.28), 0 1px 0 rgba(255,255,255,0.1) inset',
        'brand-gold':  '0 4px 14px rgba(232,169,61,0.28), 0 1px 0 rgba(255,255,255,0.15) inset',
        'brand-maroon':'0 4px 14px rgba(168,57,92,0.28), 0 1px 0 rgba(255,255,255,0.1) inset',
        'brand-info':  '0 4px 14px rgba(91,141,239,0.22), 0 1px 0 rgba(255,255,255,0.1) inset',
      },

      // ── গ্র্যাডিয়েন্ট — সূক্ষ্ম বেভেল/embossed ইফেক্টের জন্য ──
      backgroundImage: {
        'card-bevel':    'linear-gradient(180deg, rgba(255,255,255,0.035) 0%, rgba(255,255,255,0) 100%)',
        'btn-bevel':     'linear-gradient(180deg, rgba(255,255,255,0.18) 0%, rgba(255,255,255,0) 60%)',
        'win-gradient':  'linear-gradient(135deg, #00C566 0%, #0A9A52 100%)',
        'lose-gradient': 'linear-gradient(135deg, #E8384F 0%, #B82B3D 100%)',
        'squad-gradient':'linear-gradient(135deg, #A8395C 0%, #822C47 100%)',
        'gold-gradient': 'linear-gradient(135deg, #E8A93D 0%, #C28A28 100%)',
        'vignette':      'radial-gradient(ellipse 80% 50% at 50% -10%, rgba(0,197,102,0.06), transparent)',
      },
    },
  },
  plugins: [],
};
