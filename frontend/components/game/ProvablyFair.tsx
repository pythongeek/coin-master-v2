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
import { ShieldCheck, ChevronDown, ChevronUp, Search, Loader2, CheckCircle2, XCircle, BookOpen } from 'lucide-react';

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
  // Server seedের Hash মিলছে কিনা
  const computedHash = createHash('sha256').update(input.serverSeed).digest('hex');
  const hashMatches = computedHash === input.serverSeedHash;

  // রেজাল্ট কম্পিউট
  const message = `${input.clientSeed}:${input.nonce}`;
  const rawHash = createHmac('sha256', input.serverSeed).update(message).digest('hex');
  const rawValue = parseInt(rawHash.slice(0, 8), 16);
  const result: 'heads' | 'tails' = rawValue % 2 === 0 ? 'heads' : 'tails';

  const explanation = hashMatches
    ? `Server seed Hash মিলেছে। Result: ${result === 'heads' ? 'হেডস 🪷' : 'টেইলস 🐯'}`
    : `Hash মিলছে না! সম্ভাব্য কারচুপি সনাক্ত হয়েছে!`;

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
      <div className="p-4 border-b border-border">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-brand-green/10 flex items-center justify-center text-brand-green">
            <ShieldCheck size={16} />
          </div>
          <div className="text-left">
            <div className="heading-display text-sm text-brand-green">PROVABLY FAIR</div>
            <div className="text-text-muted text-xs font-mono">Verify your game</div>
          </div>
        </div>
      </div>
      <div className="p-4 space-y-4">
          {/* ব্যাখ্যা */}
          <div className="bg-void rounded-lg p-3 border border-brand-green/20">
            <p className="text-text-secondary text-xs font-mono leading-relaxed">
              After the game you will receive the <span className="text-brand-green">Server Seed</span> .
              নিচে সব তথ্য পেস্ট করুন — সিস্টেম নিজেই প্রমাণ করবে রেজাল্ট আগে থেকে নির্ধারিত ছিল
              এবং কোনো কারচুপি হয়নি।
            </p>
          </div>

          {/* ইনপুট ফিল্ডগুলো */}
          <div className="space-y-3">
            <div>
              <label className="text-text-secondary text-xs font-mono block mb-1">
                Server seed Hash <span className="text-brand-info">((received before the game))</span>
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
                Server seed <span className="text-brand-green">((revealed after the game))</span>
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
                <label className="text-text-secondary text-xs font-mono block mb-1">Client seed</label>
                <input
                  className="input-cyber text-xs"
                  placeholder="আপনার সিড"
                  value={input.clientSeed}
                  onChange={e => setInput(p => ({ ...p, clientSeed: e.target.value }))}
                />
              </div>
              <div>
                <label className="text-text-secondary text-xs font-mono block mb-1">Nonce (game number)</label>
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
            className="w-full flex items-center justify-center gap-2 py-3 rounded-lg font-display font-semibold text-sm transition-all duration-150
                       bg-brand-green text-void shadow-brand-green hover:bg-brand-green-dim hover:-translate-y-0.5
                       disabled:opacity-40 disabled:cursor-not-allowed disabled:translate-y-0"
          >
            {loading ? <Loader2 size={15} className="animate-spin" /> : <Search size={15} />}
            {loading ? 'যাচাই হচ্ছে...' : 'যাচাই করুন'}
          </button>

          {/* রেজাল্ট */}
          {result && (
            <div className={`rounded-lg p-4 border ${result.isValid ? 'border-brand-green/40 bg-brand-green/5' : 'border-brand-red/40 bg-brand-red/5'}`}>
              <p className={`flex items-center gap-2 font-mono text-sm font-medium mb-2 ${result.isValid ? 'text-brand-green' : 'text-brand-red'}`}>
                {result.isValid ? <CheckCircle2 size={15} className="shrink-0" /> : <XCircle size={15} className="shrink-0" />}
                {result.explanation}
              </p>
              {result.isValid && (
                <div className="space-y-1 text-xs font-mono text-text-muted">
                  <div>Result: <span className="text-white">{result.result === 'heads' ? '🪷 HEADS' : '🐯 TAILS'}</span></div>
                  <div className="break-all">Raw Hash: <span className="text-brand-info">{result.rawHash.slice(0, 32)}...</span></div>
                </div>
              )}
            </div>
          )}

          {/* বিস্তারিত ব্যাখ্যা */}
          <details className="text-xs font-mono text-text-muted">
            <summary className="flex items-center gap-1.5 cursor-pointer hover:text-text-secondary">
              <BookOpen size={12} />
              কীভাবে কাজ করে?
            </summary>
            <div className="mt-2 space-y-1 bg-void p-3 rounded-lg border border-border leading-relaxed">
              <p>1. Before the game the server creates a secret seed → SHA-256 hash is given to you.</p>
              <p>2. You provide your client seed (or it is auto-generated).</p>
              <p>৩. Result: HMAC-SHA256(serverSeed, clientSeed:nonce) → প্রথম ৪ বাইট → জোড় = Heads</p>
              <p>4. After the game the server reveals the real seed — you can verify the math yourself.</p>
            </div>
          </details>
        </div>
    </div>
  );
}
