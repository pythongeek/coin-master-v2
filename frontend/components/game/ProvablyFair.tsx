'use client';
/**
 * ═══════════════════════════════════════════════════════════════
 *  PROVABLY FAIR VERIFICATION WIDGET — ইউজার ভেরিফিকেশন টুল
 * ═══════════════════════════════════════════════════════════════
 *
 *  গেম শেষে ইউজার এখানে তার সিড পেস্ট করে প্রমাণ করতে পারবে
 *  যে রেজাল্ট সত্যিই ফেয়ার ছিল।
 * ═══════════════════════════════════════════════════════════════
 */
import { useState } from 'react';
import { createHmac, createHash } from 'crypto';

interface VerifyInput {
  serverSeed: string;
  clientSeed: string;
  nonce: string;
  serverSeedHash: string;
}

interface VerifyResult {
  isValid: boolean;
  result: 'heads' | 'tails';
  rawHash: string;
  hashMatches: boolean;
  explanation: string;
}

// ── ক্লায়েন্ট-সাইড ভেরিফিকেশন (API ছাড়াই) ──────────────────
function verifyLocally(input: VerifyInput): VerifyResult {
  // সার্ভার সিডের হ্যাশ মিলছে কিনা
  const computedHash = createHash('sha256').update(input.serverSeed).digest('hex');
  const hashMatches = computedHash === input.serverSeedHash;

  // রেজাল্ট কম্পিউট
  const message = `${input.clientSeed}:${input.nonce}`;
  const rawHash = createHmac('sha256', input.serverSeed).update(message).digest('hex');
  const rawValue = parseInt(rawHash.slice(0, 8), 16);
  const result: 'heads' | 'tails' = rawValue % 2 === 0 ? 'heads' : 'tails';

  const explanation = hashMatches
    ? `✅ সার্ভার সিড হ্যাশ মিলেছে। রেজাল্ট: ${result === 'heads' ? 'হেডস 👑' : 'টেইলস 🦅'}`
    : `❌ হ্যাশ মিলছে না! সম্ভাব্য কারচুপি সনাক্ত হয়েছে!`;

  return { isValid: hashMatches, result, rawHash, hashMatches, explanation };
}

export default function ProvablyFairWidget() {
  const [input, setInput] = useState<VerifyInput>({
    serverSeed: '', clientSeed: '', nonce: '1', serverSeedHash: ''
  });
  const [result, setResult] = useState<VerifyResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const handleVerify = () => {
    if (!input.serverSeed || !input.clientSeed || !input.serverSeedHash) return;
    setLoading(true);
    setTimeout(() => {
      const res = verifyLocally(input);
      setResult(res);
      setLoading(false);
    }, 600);
  };

  return (
    <div className="glass-card border border-border overflow-hidden">
      {/* হেডার */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between p-4 hover:bg-white/5 transition-colors"
      >
        <div className="flex items-center gap-3">
          <span className="text-xl">🔐</span>
          <div className="text-left">
            <div className="heading-display text-sm text-neon-green">PROVABLY FAIR</div>
            <div className="text-text-muted text-xs font-mono">আপনার গেম যাচাই করুন</div>
          </div>
        </div>
        <span className="text-text-muted text-xs font-mono">{expanded ? '▲ বন্ধ করুন' : '▼ খুলুন'}</span>
      </button>

      {expanded && (
        <div className="border-t border-border p-4 space-y-4">
          {/* ব্যাখ্যা */}
          <div className="bg-void rounded-lg p-3 border border-neon-green/20">
            <p className="text-text-secondary text-xs font-mono leading-relaxed">
              গেম শেষে আপনাকে <span className="text-neon-green">Server Seed</span> দেওয়া হবে।
              নিচে সব তথ্য পেস্ট করুন — সিস্টেম নিজেই প্রমাণ করবে রেজাল্ট আগে থেকে নির্ধারিত ছিল
              এবং কোনো কারচুপি হয়নি।
            </p>
          </div>

          {/* ইনপুট ফিল্ডগুলো */}
          <div className="space-y-3">
            <div>
              <label className="text-text-secondary text-xs font-mono block mb-1">
                সার্ভার সিড হ্যাশ <span className="text-neon-blue">(গেমের আগে পাওয়া)</span>
              </label>
              <input
                className="input-cyber text-xs"
                placeholder="e.g. a3f2d9c1b8e7..."
                value={input.serverSeedHash}
                onChange={e => setInput(p => ({ ...p, serverSeedHash: e.target.value }))}
              />
            </div>
            <div>
              <label className="text-text-secondary text-xs font-mono block mb-1">
                সার্ভার সিড <span className="text-neon-green">(গেমের পরে প্রকাশিত)</span>
              </label>
              <input
                className="input-cyber text-xs"
                placeholder="e.g. 7f4e2b1a9c8d..."
                value={input.serverSeed}
                onChange={e => setInput(p => ({ ...p, serverSeed: e.target.value }))}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-text-secondary text-xs font-mono block mb-1">ক্লায়েন্ট সিড</label>
                <input
                  className="input-cyber text-xs"
                  placeholder="আপনার সিড"
                  value={input.clientSeed}
                  onChange={e => setInput(p => ({ ...p, clientSeed: e.target.value }))}
                />
              </div>
              <div>
                <label className="text-text-secondary text-xs font-mono block mb-1">নন্স (গেম নম্বর)</label>
                <input
                  className="input-cyber text-xs"
                  type="number"
                  min="1"
                  value={input.nonce}
                  onChange={e => setInput(p => ({ ...p, nonce: e.target.value }))}
                />
              </div>
            </div>
          </div>

          {/* ভেরিফাই বাটন */}
          <button
            onClick={handleVerify}
            disabled={loading || !input.serverSeed || !input.clientSeed || !input.serverSeedHash}
            className="w-full py-3 rounded-lg font-display font-bold text-sm transition-all duration-200
                       bg-neon-green text-void hover:shadow-neon-green hover:scale-[1.02]
                       disabled:opacity-40 disabled:cursor-not-allowed disabled:scale-100"
          >
            {loading ? '⏳ যাচাই হচ্ছে...' : '🔍 যাচাই করুন'}
          </button>

          {/* রেজাল্ট */}
          {result && (
            <div className={`rounded-lg p-4 border ${result.isValid ? 'border-neon-green/50 bg-neon-green/5' : 'border-neon-red/50 bg-neon-red/5'}`}>
              <p className={`font-mono text-sm font-bold mb-2 ${result.isValid ? 'text-neon-green' : 'text-neon-red'}`}>
                {result.explanation}
              </p>
              {result.isValid && (
                <div className="space-y-1 text-xs font-mono text-text-muted">
                  <div>রেজাল্ট: <span className="text-white">{result.result === 'heads' ? '👑 HEADS' : '🦅 TAILS'}</span></div>
                  <div className="break-all">রিড হ্যাশ: <span className="text-neon-blue">{result.rawHash.slice(0, 32)}...</span></div>
                </div>
              )}
            </div>
          )}

          {/* বিস্তারিত ব্যাখ্যা */}
          <details className="text-xs font-mono text-text-muted">
            <summary className="cursor-pointer hover:text-text-secondary">📖 কীভাবে কাজ করে?</summary>
            <div className="mt-2 space-y-1 bg-void p-3 rounded-lg border border-border leading-relaxed">
              <p>১. গেমের আগে সার্ভার একটি গোপন বীজ তৈরি করে → SHA-256 হ্যাশ আপনাকে দেয়।</p>
              <p>২. আপনি আপনার ক্লায়েন্ট সিড দেন (বা অটো তৈরি হয়)।</p>
              <p>৩. রেজাল্ট: HMAC-SHA256(serverSeed, clientSeed:nonce) → প্রথম ৪ বাইট → জোড় = Heads</p>
              <p>৪. গেমের পরে সার্ভার আসল বীজ প্রকাশ করে — আপনি নিজেই হিসাব মেলাতে পারেন।</p>
            </div>
          </details>
        </div>
      )}
    </div>
  );
}
