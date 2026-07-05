'use client';
/**
 * ═══════════════════════════════════════════════════════════════
 *  PROFIT CHART — দৈনিক লাভ/লোকসান চার্ট (SVG)
 * ═══════════════════════════════════════════════════════════════
 *
 *  বাইরের লাইব্রেরি ছাড়া শুধু SVG দিয়ে তৈরি।
 *  দুটি ভিউ:
 *  ① Bar Chart  → প্রতিদিনের P&L
 *  ② Line Chart → ক্রমবর্ধমান (Cumulative) P&L
 * ═══════════════════════════════════════════════════════════════
 */

import { useState, useMemo } from 'react';

interface ChartPoint {
  date:          string;
  pnl:           number;
  cumulativePnl: number;
  bets:          number;
}

interface Props {
  data:    ChartPoint[];
  loading: boolean;
}

const W = 600;  // SVG প্রস্থ
const H = 180;  // SVG উচ্চতা
const PAD = { top: 20, right: 20, bottom: 35, left: 55 };
const CHART_W = W - PAD.left - PAD.right;
const CHART_H = H - PAD.top - PAD.bottom;

export default function ProfitChart({ data, loading }: Props) {
  const [view, setView] = useState<'daily' | 'cumulative'>('cumulative');

  // ── চার্ট গণনা ──────────────────────────────────────────────
  const { points, minY, maxY, yLines, xLabels } = useMemo(() => {
    if (!data.length) return { points: [], minY: 0, maxY: 0, yLines: [], xLabels: [] };

    const values = data.map(d => view === 'daily' ? d.pnl : d.cumulativePnl);
    const rawMin = Math.min(...values, 0);
    const rawMax = Math.max(...values, 0);
    const padding = (rawMax - rawMin) * 0.15 || 1;
    const minY = rawMin - padding;
    const maxY = rawMax + padding;
    const range = maxY - minY;

    // Y অক্ষ গ্রিড লাইন (৫টি)
    const yLines = Array.from({ length: 5 }, (_, i) => {
      const val = maxY - (range / 4) * i;
      const y   = PAD.top + (CHART_H * i) / 4;
      return { val: parseFloat(val.toFixed(2)), y };
    });

    // X অক্ষ লেবেল (সর্বোচ্চ ৭টি)
    const step = Math.max(1, Math.floor(data.length / 7));
    const xLabels = data
      .filter((_, i) => i % step === 0 || i === data.length - 1)
      .map((d, j) => {
        const i = j * step;
        const x = PAD.left + (i / (data.length - 1)) * CHART_W;
        const date = new Date(d.date);
        return {
          x,
          label: `${date.getDate()}/${date.getMonth() + 1}`,
        };
      });

    // পয়েন্টগুলো SVG কোঅর্ডিনেটে রূপান্তর
    const points = values.map((val, i) => ({
      x: PAD.left + (i / Math.max(data.length - 1, 1)) * CHART_W,
      y: PAD.top + ((maxY - val) / range) * CHART_H,
      val,
      date: data[i].date,
      bets: data[i].bets,
    }));

    return { points, minY, maxY, yLines, xLabels };
  }, [data, view]);

  // ── শূন্য রেখার Y পজিশন ─────────────────────────────────────
  const zeroY = maxY !== minY
    ? PAD.top + ((maxY - 0) / (maxY - minY)) * CHART_H
    : PAD.top + CHART_H / 2;

  // ── SVG Path তৈরি ───────────────────────────────────────────
  const linePath = points.length > 1
    ? points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')
    : '';

  // Area fill path (শূন্য রেখা পর্যন্ত)
  const areaPath = points.length > 1
    ? `${linePath} L${points[points.length - 1].x.toFixed(1)},${zeroY.toFixed(1)} L${points[0].x.toFixed(1)},${zeroY.toFixed(1)} Z`
    : '';

  if (loading) {
    return <div className="glass-card p-4 h-64 flex items-center justify-center animate-pulse">
      <span className="text-text-muted text-sm font-mono">Loading chart...</span>
    </div>;
  }

  if (!data.length) {
    return <div className="glass-card p-4 h-40 flex items-center justify-center">
      <span className="text-text-muted text-sm font-mono">No bets yet. Start playing!</span>
    </div>;
  }

  return (
    <div className="glass-card p-4">
      {/* হেডার */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="heading-display text-sm text-text-primary">Profit / Loss Chart</h3>
          <p className="text-text-muted text-xs font-mono">Last 30 days</p>
        </div>
        <div className="flex gap-1">
          {(['cumulative', 'daily'] as const).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={`px-3 py-1 rounded text-xs font-mono transition-all ${
                view === v
                  ? 'bg-brand-green/20 text-brand-green border border-brand-green/40'
                  : 'text-text-muted border border-border hover:border-brand-green/30'
              }`}
            >
              {v === 'cumulative' ? 'ক্রমবর্ধমান' : 'দৈনিক'}
            </button>
          ))}
        </div>
      </div>

      {/* SVG চার্ট */}
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full"
        role="img"
        aria-label="লাভ-লোকসানের লাইন চার্ট"
      >
        {/* Y গ্রিড লাইন ও লেবেল */}
        {yLines.map(({ val, y }) => (
          <g key={val}>
            <line
              x1={PAD.left} y1={y} x2={W - PAD.right} y2={y}
              stroke={val === 0 ? '#5B6472' : '#262C36'}
              strokeWidth={val === 0 ? 1 : 0.5}
              strokeDasharray={val === 0 ? '4 4' : '2 4'}
            />
            <text
              x={PAD.left - 8} y={y + 4}
              textAnchor="end" fontSize="10"
              fill={val === 0 ? '#5B6472' : '#5B6472'}
              fontFamily="monospace"
            >
              {val >= 0 ? '+' : ''}{val.toFixed(1)}
            </text>
          </g>
        ))}

        {/* Area fill */}
        {areaPath && (
          <path
            d={areaPath}
            fill={
              points[points.length - 1]?.val >= 0
                ? 'rgba(0, 197, 102, 0.08)'
                : 'rgba(232, 56, 79, 0.08)'
            }
          />
        )}

        {/* মূল লাইন */}
        {linePath && (
          <path
            d={linePath}
            fill="none"
            stroke={points[points.length - 1]?.val >= 0 ? '#00C566' : '#E8384F'}
            strokeWidth="1.5"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        )}

        {/* ডেটা পয়েন্ট (শুধু বড় মুভমেন্টে) */}
        {points
          .filter((_, i) => i % Math.max(1, Math.floor(points.length / 15)) === 0)
          .map((p, i) => (
            <circle
              key={i}
              cx={p.x} cy={p.y} r={2.5}
              fill={p.val >= 0 ? '#00C566' : '#E8384F'}
            />
          ))}

        {/* X অক্ষ লেবেল */}
        {xLabels.map(({ x, label }) => (
          <text
            key={label}
            x={x} y={H - 6}
            textAnchor="middle" fontSize="10"
            fill="#5B6472"
            fontFamily="monospace"
          >
            {label}
          </text>
        ))}
      </svg>

      {/* সারসংক্ষেপ */}
      <div className="flex gap-4 mt-2 pt-2 border-t border-border">
        {[
          { label: 'Start', val: data[0]?.cumulativePnl ?? 0 },
          { label: 'End', val: data[data.length - 1]?.cumulativePnl ?? 0 },
          { label: 'Total Bets', val: null, count: data.reduce((s, d) => s + d.bets, 0) },
        ].map((item) => (
          <div key={item.label} className="text-center">
            <div className="text-text-muted text-xs font-mono">{item.label}</div>
            <div className={`font-mono text-sm font-bold ${
              item.val === null ? 'text-text-primary' :
              (item.val ?? 0) >= 0 ? 'text-brand-green' : 'text-brand-red'
            }`}>
              {item.val !== null && item.val !== undefined
                ? `${item.val >= 0 ? '+' : ''}$${item.val.toFixed(2)}`
                : item.count?.toLocaleString()
              }
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
