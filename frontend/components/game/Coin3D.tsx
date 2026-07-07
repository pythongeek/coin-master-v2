'use client';
/**
 * ═══════════════════════════════════════════════════════════════
 *  COIN 3D — CSS-3D Coin (Water Lily + Family)
 * ═══════════════════════════════════════════════════════════════
 *
 *  শুধু CSS transform দিয়ে তৈরি 3D Coin — React Three Fiber
 *  . HEADS shows water lily (Bangladesh's national flower) and
 *  TAILS shows a family silhouette and "BANGLADESH" arc text.
 *
 *  Design reference: /tmp/coin-design-reference.html
 *  (আই-স্টুডিও দিয়ে তৈরি 3D Coin ডেমো)
 *
 *  Animation state machine:
 *  ① IDLE     → Coin ধীরে ভাসছে (CSS keyframe)
 *  ② SPINNING → 3D rotateY spinning (5 or 5.5 times)
 *  ③ RESULT   → lands on the correct face
 * ═══════════════════════════════════════════════════════════════
 */

import { useRef, useEffect, useState } from 'react';
import styles from './Coin3D.module.css';

export type GameStatus = 'idle' | 'spinning' | 'result';
export type CoinSide = 'heads' | 'tails';

interface CoinProps {
  gameStatus: GameStatus;
  result: CoinSide | null;
  won?: boolean | null;
}

// ─── SVG Face Components (no PNG textures needed) ──────────────

/** HEADS face: Water Lily over waves with grain-stalk wreath */
function HeadsFace() {
  return (
    <svg viewBox="0 0 500 500" className="w-full h-full select-none">
      <defs>
        <radialGradient id="gold-front" cx="35%" cy="35%" r="65%">
          <stop offset="0%" stopColor="#FFF8D1" />
          <stop offset="30%" stopColor="#FBCE3B" />
          <stop offset="70%" stopColor="#C27A05" />
          <stop offset="100%" stopColor="#5B2D02" />
        </radialGradient>
        <linearGradient id="gold-highlight" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#FFFBEB" stopOpacity="0.5" />
          <stop offset="50%" stopColor="#FCD34D" stopOpacity="0" />
          <stop offset="100%" stopColor="#78350F" stopOpacity="0.8" />
        </linearGradient>
      </defs>

      {/* Coin base rim */}
      <circle cx="250" cy="250" r="235" fill="url(#gold-front)" stroke="#451A03" strokeWidth="4" />
      <circle cx="250" cy="250" r="222" fill="none" stroke="#FFFBEB" strokeWidth="2" opacity="0.3" />

      {/* Octagon Interior */}
      <polygon points="250,55 388,112 445,250 388,388 250,445 112,388 55,250 112,112" fill="none" stroke="#5B2D02" strokeWidth="4" opacity="0.75" />

      {/* Wreath (grain stalks) wrapping the sides */}
      <path d="M 145,310 C 105,250 115,175 155,155 M 355,310 C 395,250 385,175 345,155" fill="none" stroke="#5B2D02" strokeWidth="4.5" strokeDasharray="10 13" strokeLinecap="round" />

      {/* Water Lily rising from waves */}
      {/* Waves */}
      <path d="M 160,320 Q 205,310 250,320 T 340,320 M 150,340 Q 200,330 250,340 T 350,340 M 175,360 Q 212,350 250,360 T 325,360" fill="none" stroke="#5B2D02" strokeWidth="5.5" strokeLinecap="round" />

      {/* Petals — outer layer (large) */}
      <path d="M 250,165 C 240,210 240,270 250,290 C 260,270 260,210 250,165 Z" fill="#FFF8D1" stroke="#451A03" strokeWidth="4.5" />
      {/* Petals — middle layer (left, right) */}
      <path d="M 250,290 C 210,240 210,195 220,180 C 230,195 240,240 250,290 Z" fill="#FDE68A" stroke="#451A03" strokeWidth="4" />
      <path d="M 250,290 C 290,240 290,195 280,180 C 270,195 260,240 250,290 Z" fill="#FDE68A" stroke="#451A03" strokeWidth="4" />
      {/* Petals — outer layer (far left, far right) */}
      <path d="M 250,290 C 180,260 170,225 180,210 C 195,225 225,260 250,290 Z" fill="#FBCE3B" stroke="#451A03" strokeWidth="4" />
      <path d="M 250,290 C 320,260 330,225 320,210 C 305,225 275,260 250,290 Z" fill="#FBCE3B" stroke="#451A03" strokeWidth="4" />

      {/* Three jute leaves at top center */}
      <path d="M 250,110 C 245,125 245,135 250,150 C 255,135 255,125 250,110 Z" fill="#FFF8D1" stroke="#451A03" strokeWidth="2.5" />
      <path d="M 250,150 C 235,145 225,145 210,150 C 225,155 235,155 250,150 Z" fill="#FDE68A" stroke="#451A03" strokeWidth="2" />
      <path d="M 250,150 C 265,145 275,145 290,150 C 275,155 265,155 250,150 Z" fill="#FDE68A" stroke="#451A03" strokeWidth="2" />

      {/* 4 stars perfectly positioned */}
      <g fill="#FBCE3B" stroke="#451A03" strokeWidth="2">
        <polygon points="175,150 178,158 186,158 180,163 182,171 175,166 168,171 170,163 164,158 172,158" />
        <polygon points="215,130 218,138 226,138 220,143 222,151 215,146 208,151 210,143 204,138 212,138" />
        <polygon points="285,130 288,138 296,138 290,143 292,151 285,146 278,151 280,143 274,138 282,138" />
        <polygon points="325,150 328,158 336,158 330,163 332,171 325,166 318,171 320,163 314,158 322,158" />
      </g>

      {/* Metallic highlight sweep */}
      <circle cx="250" cy="250" r="235" fill="url(#gold-highlight)" opacity="0.45" pointerEvents="none" />
    </svg>
  );
}

/** TAILS face: Family silhouettes + BANGLADESH arc + Bengali text */
function TailsFace() {
  return (
    <svg viewBox="0 0 500 500" className="w-full h-full select-none">
      <defs>
        <radialGradient id="gold-back" cx="65%" cy="35%" r="65%">
          <stop offset="0%" stopColor="#FFF8D1" />
          <stop offset="30%" stopColor="#FBCE3B" />
          <stop offset="70%" stopColor="#C27A05" />
          <stop offset="100%" stopColor="#5B2D02" />
        </radialGradient>
        <linearGradient id="gold-highlight-back" x1="100%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="#FFFBEB" stopOpacity="0.5" />
          <stop offset="50%" stopColor="#FCD34D" stopOpacity="0" />
          <stop offset="100%" stopColor="#78350F" stopOpacity="0.8" />
        </linearGradient>
      </defs>

      {/* Coin base rim */}
      <circle cx="250" cy="250" r="235" fill="url(#gold-back)" stroke="#451A03" strokeWidth="4" />
      <circle cx="250" cy="250" r="222" fill="none" stroke="#FFFBEB" strokeWidth="2" opacity="0.3" />

      {/* Octagon Interior */}
      <polygon points="250,55 388,112 445,250 388,388 250,445 112,388 55,250 112,112" fill="none" stroke="#5B2D02" strokeWidth="4" opacity="0.75" />

      {/* Family silhouettes in center */}
      <g fill="none" stroke="#5B2D02" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round">
        {/* Father (left tall figure) */}
        <circle cx="225" cy="190" r="13" fill="#FFF8D1" strokeWidth="4.5" />
        <path d="M 225,204 L 225,275 L 215,325 M 225,275 L 235,325" />
        <path d="M 210,220 Q 220,235 225,245" />

        {/* Mother (right tall figure) */}
        <circle cx="275" cy="195" r="13" fill="#FFF8D1" strokeWidth="4.5" />
        <path d="M 275,209 L 275,275 L 265,325 M 275,275 L 285,325" />
        <path d="M 290,225 Q 280,240 275,250" />

        {/* Child 1 (left-center) */}
        <circle cx="245" cy="245" r="9.5" fill="#FDE68A" strokeWidth="3.5" />
        <path d="M 245,255 L 245,302 M 245,302 L 240,325 M 245,302 L 249,325" strokeWidth="4.5" />

        {/* Child 2 (right-center) */}
        <circle cx="260" cy="253" r="7.5" fill="#FDE68A" strokeWidth="3.5" />
        <path d="M 260,261 L 260,305 M 260,305 L 257,325 M 260,305 L 263,325" strokeWidth="4" />
      </g>

      {/* Upward-facing arc text — BANGLADESH (top) */}
      <path id="curve-top" d="M 105,250 A 145,145 0 0,1 395,250" fill="none" />
      <text fontFamily="system-ui, sans-serif" fontWeight="900" fontSize="28" fill="#451A03" textAnchor="middle" letterSpacing="1.5">
        <textPath href="#curve-top" startOffset="50%">BANGLADESH</textPath>
      </text>

      {/* Bottom arc — Bengali slogan */}
      <path id="curve-bottom" d="M 105,250 A 145,145 0 0,0 395,250" fill="none" />
      <text fontFamily="system-ui, sans-serif" fontWeight="900" fontSize="16.5" fill="#451A03" textAnchor="middle" letterSpacing="0.4">
        <textPath href="#curve-bottom" startOffset="50%">Planned Family — Food for All</textPath>
      </text>

      {/* Metallic highlight sweep (mirrored) */}
      <circle cx="250" cy="250" r="235" fill="url(#gold-highlight-back)" opacity="0.45" pointerEvents="none" />
    </svg>
  );
}

// ─── Sparkle decorations removed during loading (UX-135) ─────
function Sparkles() {
  return null;
}

// ─── 3D Coin Component (CSS transforms only) ─────────────────
export default function Coin3D({ gameStatus, result, won }: CoinProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const coinRef = useRef<HTMLDivElement>(null);

  // Reset animation classes when idling
  useEffect(() => {
    if (!coinRef.current) return;
    if (gameStatus === 'idle') {
      coinRef.current.classList.remove('show-heads', 'show-tails', 'spinning');
    }
  }, [gameStatus]);

  const containerClass = [
    styles.coinPerspective,
    gameStatus === 'idle' ? styles.float : '',
  ].filter(Boolean).join(' ');

  const glowClass = [
    styles.glow,
    gameStatus === 'result' && won === true ? styles.glowWin : '',
    gameStatus === 'result' && won === false ? styles.glowLoss : '',
  ].filter(Boolean).join(' ');

  const coinClass = [
    styles.coin3d,
    gameStatus === 'spinning' ? styles.spinning : '',
    gameStatus === 'result' && result === 'heads' ? styles.showHeads : '',
    gameStatus === 'result' && result === 'tails' ? styles.showTails : '',
    gameStatus === 'result' ? styles.resultPulse : '',
  ]
    .filter(Boolean)
    .join(' ');

  const ariaLabel =
    gameStatus === 'spinning'
      ? 'Coin is flipping, waiting for result'
      : gameStatus === 'result'
      ? `Result: ${result === 'heads' ? 'Heads' : 'Tails'}. You ${won ? 'won' : 'lost'}.`
      : 'Coin — choose Heads or Tails and place a bet';

  return (
    <div
      ref={containerRef}
      className={containerClass}
      role="img"
      aria-label={ariaLabel}
      aria-live={gameStatus === 'result' ? 'polite' : 'off'}
    >
      {/* Decorative background ring */}
      <div className={styles.orbitalRing} aria-hidden="true" />

      <div className={glowClass} />
      <Sparkles />

      {/* Floor shadow for depth */}
      <div className={styles.floorShadow} aria-hidden="true" />

      <div ref={coinRef} className={coinClass}>
        {/* 9 stacked Z-translated slices for the 3D edge (visual thickness) */}
        {Array.from({ length: 9 }, (_, i) => {
          const z = 4 - i; // 4, 3, 2, 1, 0, -1, -2, -3, -4
          return <div key={i} className={styles.coinEdge} style={{ transform: `translateZ(${z}px)` }} />;
        })}

        {/* HEADS face (front — Water Lily) */}
        <div className={`${styles.coinSide} ${styles.frontSide}`}>
          <div className={styles.shineOverlay} />
          <HeadsFace />
        </div>

        {/* TAILS face (back — Family) */}
        <div className={`${styles.coinSide} ${styles.backSide}`}>
          <div className={styles.shineOverlay} />
          <TailsFace />
        </div>
      </div>
    </div>
  );
}
