'use client';

/**
 * ═══════════════════════════════════════════════════════════════
 *  COIN 3D — CSS-3D flipping coin
 * ═══════════════════════════════════════════════════════════════
 *
 *  Replaced WebGL/R3F Canvas with a lightweight CSS-3D coin to avoid
 *  WebGL context-loss issues on low-end GPUs and reduce bundle size.
 *  Design source: attached ai_studio_code-1.html (water-lily heads,
 *  family tails, gold coin, sparkles + shine sweep).
 *
 *  Props:
 *    gameStatus: 'idle' | 'spinning' | 'result'
 *    result:     'heads' | 'tails' | null
 * ═══════════════════════════════════════════════════════════════
 */

import { useEffect, useRef, useState } from 'react';
import styles from './Coin3D.module.css';

type GameStatus = 'idle' | 'spinning' | 'result';
type FlipChoice = 'heads' | 'tails';

interface CoinProps {
  gameStatus: GameStatus;
  result: FlipChoice | null;
}

/* Each flip adds 5 full rotations to heads, or 5.5 to tails.
   We keep a running total so repeated spins always spin forward. */
const HEADS_DELTA = 5;   // 1800deg = 5 * 360
const TAILS_DELTA = 5.5; // 1980deg = 5.5 * 360

export default function Coin3D({ gameStatus, result }: CoinProps) {
  const [rotation, setRotation] = useState(0);
  const [spinning, setSpinning] = useState(false);
  const latestResult = useRef<FlipChoice | null>(null);
  const spinCount = useRef(0);

  useEffect(() => {
    if (gameStatus === 'spinning') {
      setSpinning(true);
      spinCount.current += 1;
    }

    if (gameStatus === 'result' && result) {
      latestResult.current = result;
      // Spin at least once even if result hasn't changed, so add current spin count + delta.
      const delta = result === 'heads' ? HEADS_DELTA : TAILS_DELTA;
      // Normalize previous rotation to be a multiple of 1 so we always move forward cleanly.
      setRotation((prev) => {
        const full = Math.floor(prev);
        return full + delta;
      });

      const timer = setTimeout(() => setSpinning(false), 1600);
      return () => clearTimeout(timer);
    }
  }, [gameStatus, result]);

  const isHeads = result === 'heads' || (gameStatus !== 'result' && latestResult.current === 'heads');
  const ariaLabel = gameStatus === 'spinning'
    ? 'Coin spinning'
    : gameStatus === 'result'
      ? `Result: ${isHeads ? 'Heads' : 'Tails'}`
      : 'Coin — place your bet';

  const coinTransform = `rotateY(${rotation * 360}deg)`;

  return (
    <div className="w-full h-full flex items-center justify-center">
      <div className={`${styles.coinPerspective} ${spinning ? styles.spinning : ''}`}>
        {/* Outer sparkles */}
        <svg className={`${styles.sparkle} ${styles.sparkle1} w-8 h-8 text-yellow-300`} viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 0L14.6 9.4L24 12L14.6 14.6L12 24L9.4 14.6L0 12L9.4 9.4L12 0Z"/>
        </svg>
        <svg className={`${styles.sparkle} ${styles.sparkle2} w-10 h-10 text-yellow-200`} viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 0L14.6 9.4L24 12L14.6 14.6L12 24L9.4 14.6L0 12L9.4 9.4L12 0Z"/>
        </svg>
        <svg className={`${styles.sparkle} ${styles.sparkle3} w-7 h-7 text-white`} viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 0L14.6 9.4L24 12L14.6 14.6L12 24L9.4 14.6L0 12L9.4 9.4L12 0Z"/>
        </svg>

        <div className={`${styles.floatWrapper} ${gameStatus === 'idle' ? styles.float : ''}`}>
          <div
            className={styles.coin3d}
            style={{ transform: coinTransform }}
            aria-label={ariaLabel}
            role="img"
          >
            {/* Edge slices stacked in Z-space for thickness */}
            {[4, 3, 2, 1, 0, -1, -2, -3, -4].map((z) => (
              <div key={z} className={styles.coinEdge} style={{ transform: `translateZ(${z}px)` }} />
            ))}

            {/* FRONT — Water Lily (Heads) */}
            <div className={`${styles.coinSide} ${styles.frontSide}`}>
              <div className={styles.shineOverlay} />
              <svg viewBox="0 0 500 500" className="w-full h-full select-none">
                <defs>
                  <radialGradient id="gold-front" cx="35%" cy="35%" r="65%">
                    <stop offset="0%" stopColor="#FFF8D1" />
                    <stop offset="30%" stopColor="#FBCE3B" />
                    <stop offset="70%" stopColor="#C27A05" />
                    <stop offset="100%" stopColor="#5B2D02" />
                  </radialGradient>
                  <linearGradient id="gold-highlight" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stopColor="#FFFBEB" stopOpacity="0.5"/>
                    <stop offset="50%" stopColor="#FCD34D" stopOpacity="0"/>
                    <stop offset="100%" stopColor="#78350F" stopOpacity="0.8"/>
                  </linearGradient>
                </defs>
                <circle cx="250" cy="250" r="235" fill="url(#gold-front)" stroke="#451A03" strokeWidth="4"/>
                <circle cx="250" cy="250" r="222" fill="none" stroke="#FFFBEB" strokeWidth="2" opacity="0.3"/>
                <polygon points="250,55 388,112 445,250 388,388 250,445 112,388 55,250 112,112" fill="none" stroke="#5B2D02" strokeWidth="4" opacity="0.75"/>
                <path d="M 145,310 C 105,250 115,175 155,155 M 355,310 C 395,250 385,175 345,155" fill="none" stroke="#5B2D02" strokeWidth="4.5" strokeDasharray="10 13" strokeLinecap="round"/>
                <path d="M 160,320 Q 205,310 250,320 T 340,320 M 150,340 Q 200,330 250,340 T 350,340 M 175,360 Q 212,350 250,360 T 325,360" fill="none" stroke="#5B2D02" strokeWidth="5.5" strokeLinecap="round"/>
                <path d="M 250,165 C 240,210 240,270 250,290 C 260,270 260,210 250,165 Z" fill="#FFF8D1" stroke="#451A03" strokeWidth="4.5"/>
                <path d="M 250,290 C 210,240 210,195 220,180 C 230,195 240,240 250,290 Z" fill="#FDE68A" stroke="#451A03" strokeWidth="4"/>
                <path d="M 250,290 C 290,240 290,195 280,180 C 270,195 260,240 250,290 Z" fill="#FDE68A" stroke="#451A03" strokeWidth="4"/>
                <path d="M 250,290 C 180,260 170,225 180,210 C 195,225 225,260 250,290 Z" fill="#FBCE3B" stroke="#451A03" strokeWidth="4"/>
                <path d="M 250,290 C 320,260 330,225 320,210 C 305,225 275,260 250,290 Z" fill="#FBCE3B" stroke="#451A03" strokeWidth="4"/>
                <path d="M 250,110 C 245,125 245,135 250,150 C 255,135 255,125 250,110 Z" fill="#FFF8D1" stroke="#451A03" strokeWidth="2.5"/>
                <path d="M 250,150 C 235,145 225,145 210,150 C 225,155 235,155 250,150 Z" fill="#FDE68A" stroke="#451A03" strokeWidth="2"/>
                <path d="M 250,150 C 265,145 275,145 290,150 C 275,155 265,155 250,150 Z" fill="#FDE68A" stroke="#451A03" strokeWidth="2"/>
                <g fill="#FBCE3B" stroke="#451A03" strokeWidth="2">
                  <polygon points="175,150 178,158 186,158 180,163 182,171 175,166 168,171 170,163 164,158 172,158" />
                  <polygon points="215,130 218,138 226,138 220,143 222,151 215,146 208,151 210,143 204,138 212,138" />
                  <polygon points="285,130 288,138 296,138 290,143 292,151 285,146 278,151 280,143 274,138 282,138" />
                  <polygon points="325,150 328,158 336,158 330,163 332,171 325,166 318,171 320,163 314,158 322,158" />
                </g>
                <circle cx="250" cy="250" r="235" fill="url(#gold-highlight)" opacity="0.45" pointerEvents="none"/>
              </svg>
            </div>

            {/* BACK — Family (Tails) */}
            <div className={`${styles.coinSide} ${styles.backSide}`}>
              <div className={styles.shineOverlay} />
              <svg viewBox="0 0 500 500" className="w-full h-full select-none">
                <circle cx="250" cy="250" r="235" fill="url(#gold-front)" stroke="#451A03" strokeWidth="4"/>
                <circle cx="250" cy="250" r="222" fill="none" stroke="#FFFBEB" strokeWidth="2" opacity="0.3"/>
                <polygon points="250,55 388,112 445,250 388,388 250,445 112,388 55,250 112,112" fill="none" stroke="#5B2D02" strokeWidth="4" opacity="0.75"/>
                <g fill="none" stroke="#5B2D02" strokeWidth="7" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="225" cy="190" r="13" fill="#FFF8D1" strokeWidth="4.5" />
                  <path d="M 225,204 L 225,275 L 215,325 M 225,275 L 235,325" />
                  <path d="M 210,220 Q 220,235 225,245" />
                  <circle cx="275" cy="195" r="13" fill="#FFF8D1" strokeWidth="4.5" />
                  <path d="M 275,209 L 275,275 L 265,325 M 275,275 L 285,325" />
                  <path d="M 290,225 Q 280,240 275,250" />
                  <circle cx="245" cy="245" r="9.5" fill="#FDE68A" strokeWidth="3.5" />
                  <path d="M 245,255 L 245,302 M 245,302 L 240,325 M 245,302 L 249,325" strokeWidth="4.5" />
                  <circle cx="260" cy="253" r="7.5" fill="#FDE68A" strokeWidth="3.5" />
                  <path d="M 260,261 L 260,305 M 260,305 L 257,325 M 260,305 L 263,325" strokeWidth="4" />
                </g>
                <path id="curve-top" d="M 105,250 A 145,145 0 0,1 395,250" fill="none" />
                <text fontFamily="system-ui, sans-serif" fontWeight="900" fontSize="28" fill="#451A03" textAnchor="middle" letterSpacing="1.5">
                  <textPath href="#curve-top" startOffset="50%">BANGLADESH</textPath>
                </text>
                <path id="curve-bottom" d="M 105,250 A 145,145 0 0,0 395,250" fill="none" />
                <text fontFamily="system-ui, sans-serif" fontWeight="900" fontSize="16.5" fill="#451A03" textAnchor="middle" letterSpacing="0.4">
                  <textPath href="#curve-bottom" startOffset="50%">পরিকল্পিত পরিবার - সবার জন্য খাদ্য</textPath>
                </text>
                <circle cx="250" cy="250" r="235" fill="url(#gold-highlight)" opacity="0.45" pointerEvents="none"/>
              </svg>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
