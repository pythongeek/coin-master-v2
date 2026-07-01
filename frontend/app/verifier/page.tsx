'use client';
/**
 * ═══════════════════════════════════════════════════════════════
 *  STANDALONE PUBLIC VERIFIER PAGE — সম্পূর্ণ গেম ও জ্যাকপট যাচাইকরণ
 * ═══════════════════════════════════════════════════════════════
 */
import { useState, useEffect } from 'react';
import Link from 'next/link';
import { createHmac, createHash } from 'crypto';
import { 
  ShieldCheck, ArrowLeft, Search, Loader2, CheckCircle2, 
  XCircle, BookOpen, Coins, HelpCircle, Info
} from 'lucide-react';

interface VerifyInput {
  serverSeed: string;
  clientSeed: string;
  nonce: string;
  serverSeedHash: string;
  choice: 'heads' | 'tails';
  targetMultiplier: string;
  houseEdge: string;
  jackpotHitChance: string;
}

interface VerifyResult {
  isValid: boolean;
  result: 'heads' | 'tails';
  rawHash: string;
  hashMatches: boolean;
  wonGame: boolean;
  roll: number;
  winChance: number;
  explanation: string;
  
  // Jackpot Verification
  jackpotSignature: string;
  jackpotHash: string;
  jackpotRoll: number;
  jackpotWon: boolean;
  jackpotExplanation: string;
}

export default function VerifierPage() {
  const [input, setInput] = useState<VerifyInput>({
    serverSeed: '',
    clientSeed: '',
    nonce: '1',
    serverSeedHash: '',
    choice: 'heads',
    targetMultiplier: '2.0',
    houseEdge: '2.0',
    jackpotHitChance: '10000'
  });
  
  const [result, setResult] = useState<VerifyResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [jackpotData, setJackpotData] = useState<{ jackpotPool: number; jackpotMinBet: number } | null>(null);

  // Fetch current live jackpot settings from backend optionally
  useEffect(() => {
    fetch('http://localhost:4000/api/game/jackpot')
      .then(res => res.json())
      .then(resData => {
        if (resData.success && resData.data) {
          setJackpotData({
            jackpotPool: parseFloat(resData.data.jackpotPool),
            jackpotMinBet: parseFloat(resData.data.jackpotMinBet)
          });
        }
      })
      .catch(() => {});
  }, []);

  const handleVerify = () => {
    if (!input.serverSeed || !input.clientSeed || !input.serverSeedHash) return;
    setLoading(true);
    
    setTimeout(() => {
      // 1. Validate server seed hash
      const computedHash = createHash('sha256').update(input.serverSeed).digest('hex');
      const hashMatches = computedHash.toLowerCase() === input.serverSeedHash.trim().toLowerCase();

      // 2. Compute flip outcome
      const targetMultiplierNum = parseFloat(input.targetMultiplier) || 2.0;
      const houseEdgeNum = parseFloat(input.houseEdge) || 2.0;
      const hitChanceNum = parseInt(input.jackpotHitChance) || 10000;
      const winChance = (100 - houseEdgeNum) / targetMultiplierNum;

      const flipSignature = `${input.clientSeed}:${input.nonce}`;
      const rawHash = createHmac('sha256', input.serverSeed).update(flipSignature).digest('hex');
      const rawValue = parseInt(rawHash.slice(0, 8), 16);
      
      // Calculate roll (0 to 99.9999...)
      const roll = (rawValue % 10000) / 100;
      const gameResult: 'heads' | 'tails' = rawValue % 2 === 0 ? 'heads' : 'tails';
      const wonGame = roll < winChance && gameResult === input.choice;

      // 3. Compute jackpot outcome
      const jackpotSignature = `${input.clientSeed}:${input.nonce}:jackpot`;
      const jackpotHash = createHmac('sha256', input.serverSeed).update(jackpotSignature).digest('hex');
      const rawJackpotVal = parseInt(jackpotHash.slice(0, 8), 16);
      const jackpotRoll = rawJackpotVal % hitChanceNum;
      const jackpotWon = jackpotRoll === 777;

      const explanation = hashMatches
        ? `যাচাই সফল! HMAC-SHA256("${input.serverSeed.slice(0, 10)}...", "${flipSignature}") = ${rawHash.slice(0, 8)}... (Roll: ${roll.toFixed(2)}%, Win Limit: < ${winChance.toFixed(2)}%)`
        : `হ্যাশ মিলছে না! সম্ভাব্য কারচুপি সনাক্ত হয়েছে!`;

      const jackpotExplanation = `HMAC-SHA256("${input.serverSeed.slice(0, 10)}...", "${jackpotSignature}") = ${jackpotHash.slice(0, 8)}... (Roll: ${jackpotRoll}, Win Target: 777)`;

      setResult({
        isValid: hashMatches,
        result: gameResult,
        rawHash,
        hashMatches,
        wonGame,
        roll,
        winChance,
        explanation,
        
        jackpotSignature,
        jackpotHash,
        jackpotRoll,
        jackpotWon,
        jackpotExplanation
      });
      setLoading(false);
    }, 500);
  };

  return (
    <main className="min-h-screen p-4 md:p-8 max-w-4xl mx-auto space-y-6">
      {/* হেডার */}
      <div className="flex items-center justify-between border-b border-border pb-4">
        <Link href="/" className="flex items-center gap-2 text-text-muted hover:text-white transition-colors text-sm font-mono">
          <ArrowLeft size={16} />
          হোমে ফিরে যান
        </Link>
        <div className="flex items-center gap-2 text-brand-green font-mono text-xs bg-brand-green/10 border border-brand-green/20 px-3 py-1 rounded-full">
          <ShieldCheck size={14} />
          PROVABLY FAIR SYSTEM
        </div>
      </div>

      {/* জ্যাকপট পুল ব্যানার */}
      {jackpotData && (
        <div className="glass-card bg-brand-green/5 border-brand-green/20 p-4 rounded-xl flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-brand-green/10 flex items-center justify-center text-brand-green">
              <Coins size={20} className="animate-pulse" />
            </div>
            <div>
              <div className="text-text-muted text-xs font-mono">লাইভ জ্যাকপট পুল</div>
              <div className="heading-display text-lg text-white font-mono">${jackpotData.jackpotPool.toFixed(4)}</div>
            </div>
          </div>
          <div className="text-right text-xs font-mono text-text-muted">
            সর্বনিম্ন বেট: <span className="text-white">${jackpotData.jackpotMinBet.toFixed(2)}</span>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-12 gap-6">
        {/* ইনপুট ফর্ম */}
        <div className="md:col-span-7 glass-card p-6 border-border space-y-4">
          <h2 className="heading-display text-base text-white">ভেরিফিকেশন ক্যালকুলেটর</h2>
          
          <div className="space-y-3">
            <div>
              <label className="text-text-secondary text-xs font-mono block mb-1">
                সার্ভার সিড হ্যাশ <span className="text-brand-info">(গেম খেলার আগের খাম)</span>
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
                সার্ভার সিড <span className="text-brand-green">(গেম খেলার পরে প্রাপ্ত চাবি)</span>
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

            <div className="grid grid-cols-3 gap-2 pt-2">
              <div>
                <label className="text-text-secondary text-2xs font-mono block mb-1">চয়েস</label>
                <select 
                  className="input-cyber text-xs bg-void py-2"
                  value={input.choice}
                  onChange={e => setInput(p => ({ ...p, choice: e.target.value as any }))}
                >
                  <option value="heads">Heads</option>
                  <option value="tails">Tails</option>
                </select>
              </div>
              <div>
                <label className="text-text-secondary text-2xs font-mono block mb-1">মাল্টিপ্লায়ার</label>
                <input
                  className="input-cyber text-xs"
                  value={input.targetMultiplier}
                  onChange={e => setInput(p => ({ ...p, targetMultiplier: e.target.value }))}
                />
              </div>
              <div>
                <label className="text-text-secondary text-2xs font-mono block mb-1">হাউজ এজ (%)</label>
                <input
                  className="input-cyber text-xs"
                  value={input.houseEdge}
                  onChange={e => setInput(p => ({ ...p, houseEdge: e.target.value }))}
                />
              </div>
            </div>

            <div>
              <label className="text-text-secondary text-xs font-mono block mb-1">জ্যাকপট জয়ের সুযোগ (১/X)</label>
              <input
                className="input-cyber text-xs"
                value={input.jackpotHitChance}
                onChange={e => setInput(p => ({ ...p, jackpotHitChance: e.target.value }))}
              />
            </div>
          </div>

          <button
            onClick={handleVerify}
            disabled={loading || !input.serverSeed || !input.clientSeed || !input.serverSeedHash}
            className="w-full flex items-center justify-center gap-2 py-3 rounded-lg font-display font-semibold text-sm transition-all duration-150
                       bg-brand-green text-void shadow-brand-green hover:bg-brand-green-dim hover:-translate-y-0.5
                       disabled:opacity-40 disabled:cursor-not-allowed disabled:translate-y-0"
          >
            {loading ? <Loader2 size={15} className="animate-spin" /> : <Search size={15} />}
            {loading ? 'হিসাব যাচাই হচ্ছে...' : 'হিসাব যাচাই করুন'}
          </button>
        </div>

        {/* কাজের নিয়মাবলি / নির্দেশিকা */}
        <div className="md:col-span-5 space-y-6">
          <div className="glass-card p-6 border-border space-y-3">
            <h2 className="heading-display text-xs text-brand-green flex items-center gap-1.5">
              <BookOpen size={14} />
              কিভাবে কাজ করে?
            </h2>
            <div className="text-text-muted text-xs font-mono leading-relaxed space-y-2">
              <p>১. গেম খেলার পূর্বে সার্ভার একটি র্যান্ডম চাবি (<span className="text-white">Server Seed</span>) তৈরি করে এবং তার হ্যাশ প্রকাশ করে।</p>
              <p>২. আপনি আপনার বীজ বা সিড প্রদান করেন।</p>
              <p>৩. সূত্র: <code className="text-brand-info">HMAC-SHA256(serverSeed, clientSeed:nonce)</code></p>
              <p>৪. উক্ত হ্যাশের প্রথম ৮ ক্যারেক্টার থেকে প্রাপ্ত মান জোড় হলে Heads, বেজোড় হলে Tails।</p>
              <p>৫. জ্যাকপট যাচাই: <code className="text-brand-info">HMAC-SHA256(serverSeed, clientSeed:nonce:jackpot)</code>, এর মানকে ১/X দিয়ে মোড করে ৭৭৭ পেলে জ্যাকপট বিজয়ী!</p>
            </div>
          </div>
          
          <div className="glass-card p-4 border-border flex items-start gap-2.5">
            <Info size={16} className="text-brand-info shrink-0 mt-0.5" />
            <p className="text-text-muted text-xs font-mono leading-relaxed">
              সার্ভার সিড ম্যাচ হওয়া মানে খেলা শুরুর পূর্বেই রেজাল্ট নিশ্চিতভাবে নির্ধারিত ছিল এবং কোনো প্রকার পরিবর্তন সম্ভব ছিল না।
            </p>
          </div>
        </div>
      </div>

      {/* যাচাইকরণ ফলাফল */}
      {result && (
        <div className={`glass-card p-6 border ${result.isValid ? 'border-brand-green/30 bg-brand-green/5' : 'border-brand-red/30 bg-brand-red/5'} rounded-xl space-y-4`}>
          <div className="flex items-center gap-3">
            <div className={`w-8 h-8 rounded-full flex items-center justify-center ${result.isValid ? 'bg-brand-green/10 text-brand-green' : 'bg-brand-red/10 text-brand-red'}`}>
              {result.isValid ? <CheckCircle2 size={18} /> : <XCircle size={18} />}
            </div>
            <div>
              <h3 className="heading-display text-sm text-white">
                {result.isValid ? 'সিড ইন্টিগ্রিটি ভেরিফাইড (ম্যাচ হয়েছে)' : 'ভেরিফিকেশন ব্যর্থ!'}
              </h3>
              <p className="text-text-muted text-xs font-mono mt-0.5">{result.explanation}</p>
            </div>
          </div>

          {result.isValid && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 border-t border-border pt-4">
              {/* গেম রেজাল্ট ব্লক */}
              <div className="bg-void/40 p-4 rounded-lg border border-border space-y-2">
                <div className="heading-display text-2xs text-brand-green">কয়েন ফ্লিপ ফলাফল</div>
                <div className="flex justify-between text-xs font-mono text-text-muted">
                  <span>কম্পিউটেড রেজাল্ট:</span>
                  <span className="text-white font-bold">{result.result === 'heads' ? '🪙 HEADS (হেডস)' : '🪙 TAILS (টেইলস)'}</span>
                </div>
                <div className="flex justify-between text-xs font-mono text-text-muted">
                  <span>প্রাপ্ত রোল:</span>
                  <span className="text-white font-bold">{result.roll.toFixed(4)}%</span>
                </div>
                <div className="flex justify-between text-xs font-mono text-text-muted">
                  <span>জয়ের সীমা:</span>
                  <span className="text-white">&lt; {result.winChance.toFixed(4)}%</span>
                </div>
                <div className="flex justify-between text-xs font-mono text-text-muted">
                  <span>প্রেডিকশন স্ট্যাটাস:</span>
                  <span className={result.wonGame ? 'text-brand-green font-bold' : 'text-text-muted'}>
                    {result.wonGame ? 'জিতেছেন (Win)' : 'হেরেছেন (Loss)'}
                  </span>
                </div>
              </div>

              {/* জ্যাকপট ব্লক */}
              <div className="bg-void/40 p-4 rounded-lg border border-border space-y-2">
                <div className="heading-display text-2xs text-brand-green">প্রোগ্রেসিভ জ্যাকপট ফলাফল</div>
                <div className="text-2xs font-mono text-text-muted break-all">
                  <span>জ্যাকপট সিগনেচার:</span> <span className="text-white">{result.jackpotSignature}</span>
                </div>
                <div className="flex justify-between text-xs font-mono text-text-muted">
                  <span>জ্যাকপট রোল:</span>
                  <span className="text-white font-bold">{result.jackpotRoll}</span>
                </div>
                <div className="flex justify-between text-xs font-mono text-text-muted">
                  <span>টার্গেট রোল:</span>
                  <span className="text-brand-green font-bold">777</span>
                </div>
                <div className="flex justify-between text-xs font-mono text-text-muted">
                  <span>জ্যাকপট স্ট্যাটাস:</span>
                  <span className={result.jackpotWon ? 'text-brand-green font-bold animate-pulse' : 'text-text-muted'}>
                    {result.jackpotWon ? 'জ্যাকপট বিজয়ী! 🏆' : 'জ্যাকপট জিতেনি'}
                  </span>
                </div>
                <div className="text-2xs font-mono text-text-muted pt-1 border-t border-border/50">
                  {result.jackpotExplanation}
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </main>
  );
}
