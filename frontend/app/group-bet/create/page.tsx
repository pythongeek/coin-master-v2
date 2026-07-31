/**\n * ════════════════════════════════════════════════════════════════\n *  GROUP-BET CREATE WIZARD — Phase 2 / Day 12
 *  ════════════════════════════════════════════════════════════════
 *
 *  Multi-step wizard for creating a new group-bet room. Has 4 steps:
 *    1. Game  — pick coinflip/dice/crash (others marked "soon")
 *    2. Params — creator choice, stake, max members, payout & turn
 *    3. Review + create (POST /api/group-bet)
 *    4. On success, redirect to /group-bet/room/[shortCode] and show
 *       the share modal so the creator can invite friends.
 *
 *  Per group-bet-create-route schema: creator_choice (heads/tails),
 *  creatorStake, perMemberStake, minMembers, maxMembers, payoutMode,
 *  turnMode, autoFlipSeconds.
 * ════════════════════════════════════════════════════════════════
 */

'use client';

import { useState, useMemo, useCallback } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Coins,
  Users,
  Crown,
  Equal,
  Sparkles,
  Hash,
  ChevronRight,
  ChevronLeft,
  Check,
  AlertCircle,
  CircleDot,
  Loader2,
  Copy,
  Eye,
} from 'lucide-react';
import { useToast } from '@/components/providers/ToastProvider';
import { getApiBase } from '@/lib/api/base';
import { GroupShareModal } from '@/components/dashboard/GroupShareModal';

const API = getApiBase();

function getToken(): string {
  if (typeof window === 'undefined') return '';
  return localStorage.getItem('cf_token') || '';
}

type Step = 1 | 2 | 3;
type GameType = 'coinflip' | 'dice' | 'crash' | 'plinko' | 'limbo';
type PayoutMode = 'equal' | 'proportional' | 'founder_boost';
type TurnMode = 'creator' | 'auto_on_full' | 'random_lottery';
type Choice = 'heads' | 'tails';

const PAYOUT_OPTIONS: Array<{ mode: PayoutMode; label: string; desc: string; icon: any }> = [
  { mode: 'equal',          label: 'Equal split',      desc: 'Pool split equally among winners',                  icon: Equal },
  { mode: 'proportional',   label: 'Proportional',     desc: 'Each win stake weight × pool (matches stake)',  icon: Sparkles },
  { mode: 'founder_boost',  label: 'Founder +10%',     desc: 'Creator gets +10% bonus on top of their share',   icon: Crown },
];

const TURN_OPTIONS: Array<{ mode: TurnMode; label: string; desc: string }> = [
  { mode: 'creator',         label: 'Only the creator flips',            desc: 'No countdown — the creator kicks the flip when ready' },
  { mode: 'auto_on_full',    label: 'Auto when full',                   desc: 'Flip triggers once the room hits maxMembers' },
  { mode: 'random_lottery',  label: 'Random lottery',                   desc: 'A random member (weighted by stake) gets the flip' },
];

export default function CreateGroupRoomPage() {
  const router = useRouter();
  const toast = useToast();
  const [hasToken, setHasToken] = useState<boolean>(false);
  const [step, setStep] = useState<Step>(1);

  // Form state
  const [gameType, setGameType] = useState<GameType>('coinflip');
  const [creatorChoice, setCreatorChoice] = useState<Choice>('heads');
  const [creatorStake, setCreatorStake] = useState<number>(50);
  const [perMemberStake, setPerMemberStake] = useState<number>(50);
  const [minMembers, setMinMembers] = useState<number>(2);
  const [maxMembers, setMaxMembers] = useState<number>(5);
  const [autoFlipSeconds, setAutoFlipSeconds] = useState<number>(5);
  const [payoutMode, setPayoutMode] = useState<PayoutMode>('equal');
  const [turnMode, setTurnMode] = useState<TurnMode>('creator');
  const [name, setName] = useState<string>('');
  const [description, setDescription] = useState<string>('');

  const [busy, setBusy] = useState<boolean>(false);
  const [createdRoom, setCreatedRoom] = useState<{ id: string; shortCode: string } | null>(null);
  const [showShareModal, setShowShareModal] = useState<boolean>(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  // Auth gate
  if (typeof window !== 'undefined' && !hasToken) {
    setTimeout(() => {
      const t = getToken();
      setHasToken(Boolean(t));
      if (!t) {
        // soft gate — let the user read the wizard, but show a banner
      }
    }, 0);
  }

  const validateStep1 = (): boolean => {
    const e: Record<string, string> = {};
    if (creatorStake <= 0 || creatorStake > 50_000) e.creatorStake = 'Must be 1–50,000';
    if (perMemberStake <= 0 || perMemberStake > 50_000) e.perMemberStake = 'Must be 1–50,000';
    if (minMembers < 2 || minMembers > 10) e.minMembers = 'Must be 2–10';
    if (maxMembers < minMembers || maxMembers > 10) e.maxMembers = 'Must be ≥ min and ≤ 10';
    if (autoFlipSeconds < 1 || autoFlipSeconds > 60) e.autoFlipSeconds = 'Must be 1–60';
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const goNext = useCallback(() => {
    if (step === 1) {
      if (!validateStep1()) return;
      setStep(2);
    } else if (step === 2) {
      setStep(3);
    }
  }, [step]);

  const goBack = useCallback(() => {
    setErrors({});
    if (step > 1) setStep((s) => (s - 1) as Step);
  }, [step]);

  const handleCreate = async () => {
    const token = getToken();
    if (!token) {
      toast.addToast('Please log in first to create a group', 'error');
      return;
    }
    setBusy(true);
    try {
      const r = await fetch(`${API}/group-bet`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          creatorChoice,
          creatorStake,
          perMemberStake,
          minMembers,
          maxMembers,
          payoutMode,
          turnMode,
          autoFlipSeconds,
          // future fields: name, description (not in current schema; persisted as client-only for now)
          // name: name || undefined,
          // description: description || undefined,
        }),
      });
      const j = await r.json();
      if (!r.ok || !j.success) {
        toast.addToast(j?.error || `HTTP ${r.status}`, 'error');
        return;
      }
      setCreatedRoom({ id: j.data.id, shortCode: j.data.shortCode });
      setShowShareModal(true);
      toast.addToast('Group created! Invite friends to join.', 'success');
    } catch (e: any) {
      toast.addToast(`Create failed: ${e?.message ?? 'unknown'}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const allowNext = useMemo(() => {
    if (step === 1) {
      return creatorStake > 0 && perMemberStake > 0 && minMembers >= 2 && maxMembers >= minMembers && maxMembers <= 10;
    }
    return true;
  }, [step, creatorStake, perMemberStake, minMembers, maxMembers]);

  const totalPoolEstimate = creatorStake + (maxMembers - 1) * perMemberStake;

  return (
    <div className="min-h-screen bg-surface/50 px-4 sm:px-6 lg:px-8 py-6">
      <div className="max-w-3xl mx-auto">
        {/* header */}
        <div className="flex items-center justify-between mb-3">
          <h1 className="text-2xl sm:text-3xl font-bold text-text-primary flex items-center gap-2">
            <CircleDot className="text-brand-green" />
            Create a group room
          </h1>
          <Link href="/group-bet/lobby" className="text-text-muted hover:text-text-primary text-sm font-mono">
            ← Back to lobby
          </Link>
        </div>

        {/* step indicator */}
        <div className="flex items-center justify-center mb-4 gap-2 text-xs font-mono">
          {[1, 2, 3].map((n) => (
            <span
              key={n}
              className={`flex items-center gap-1 px-2 py-1 rounded ${
                step === n ? 'text-brand-green'
                  : step > n ? 'text-text-secondary'
                  : 'text-text-muted/40'
              }`}
            >
              <span className={`inline-flex w-4 h-4 rounded-full text-[10px] items-center justify-center ${
                step === n ? 'bg-brand-green text-surface'
                  : step > n ? 'bg-text-secondary/30'
                  : 'bg-text-muted/20'
              }`}>
                {step > n ? '✓' : n}
              </span>
              {n === 1 ? 'Configure' : n === 2 ? 'Distribution & turn' : 'Review'}
            </span>
          ))}
        </div>

        {!hasToken && (
          <div className="glass-card p-3 mb-4 text-text-secondary text-sm flex items-center gap-3">
            <AlertCircle size={16} className="text-amber-400" />
            You'll need to <Link href="/login" className="text-brand-green hover:underline">log in</Link> before you can create a group.
          </div>
        )}

        <div className="glass-card p-5">
          {step === 1 && (
            <Step1
              gameType={gameType} onGameType={setGameType}
              creatorChoice={creatorChoice} onChoice={setCreatorChoice}
              creatorStake={creatorStake} onCreatorStake={setCreatorStake}
              perMemberStake={perMemberStake} onPerMemberStake={setPerMemberStake}
              minMembers={minMembers} onMinMembers={setMinMembers}
              maxMembers={maxMembers} onMaxMembers={setMaxMembers}
              autoFlipSeconds={autoFlipSeconds} onAutoFlipSeconds={setAutoFlipSeconds}
              name={name} onName={setName}
              description={description} onDescription={setDescription}
              errors={errors}
              totalPoolEstimate={totalPoolEstimate}
            />
          )}
          {step === 2 && (
            <Step2
              payoutMode={payoutMode} onPayoutMode={setPayoutMode}
              turnMode={turnMode} onTurnMode={setTurnMode}
            />
          )}
          {step === 3 && (
            <Step3
              creatorChoice={creatorChoice}
              creatorStake={creatorStake}
              perMemberStake={perMemberStake}
              minMembers={minMembers}
              maxMembers={maxMembers}
              autoFlipSeconds={autoFlipSeconds}
              payoutMode={payoutMode}
              turnMode={turnMode}
              name={name}
              description={description}
              totalPoolEstimate={totalPoolEstimate}
            />
          )}
        </div>

        {/* nav buttons */}
        <div className="flex items-center justify-between mt-4">
          <button
            type="button"
            onClick={goBack}
            disabled={step === 1 || busy}
            className="flex items-center gap-1 px-4 py-2 rounded-lg border border-border text-text-secondary hover:text-text-primary disabled:opacity-30"
          >
            <ChevronLeft size={14} />
            Back
          </button>

          {step < 3 ? (
            <button
              type="button"
              onClick={goNext}
              disabled={!allowNext}
              className="flex items-center gap-1 px-4 py-2 rounded-lg border border-brand-green/60 bg-brand-green/10 text-brand-green hover:bg-brand-green/20 disabled:opacity-30"
            >
              Next
              <ChevronRight size={14} />
            </button>
          ) : (
            <button
              type="button"
              onClick={handleCreate}
              disabled={busy || !hasToken}
              className="flex items-center gap-1 px-4 py-2 rounded-lg border border-brand-green/60 bg-brand-green text-surface hover:bg-brand-green/90 disabled:opacity-30 font-bold"
            >
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
              {busy ? 'Creating…' : 'Create room'}
            </button>
          )}
        </div>
      </div>

      {/* share modal after creation */}
      {createdRoom && (
        <GroupShareModal
          open={showShareModal}
          onClose={() => {
            setShowShareModal(false);
            router.push(`/group-bet/room/${createdRoom.shortCode}`);
          }}
          roomId={createdRoom.id}
          roomShortCode={createdRoom.shortCode}
          api={API}
          authed={hasToken}
        />
      )}
    </div>
  );
}

// ─── Step 1: Configure ────────────────────────────────────────────
function Step1(props: any) {
  const {
    gameType, onGameType,
    creatorChoice, onChoice,
    creatorStake, onCreatorStake,
    perMemberStake, onPerMemberStake,
    minMembers, onMinMembers,
    maxMembers, onMaxMembers,
    autoFlipSeconds, onAutoFlipSeconds,
    name, onName,
    description, onDescription,
    errors, totalPoolEstimate,
  } = props;

  const GAMES: Array<{ id: GameType; label: string; soon?: boolean }> = [
    { id: 'coinflip', label: 'Coinflip' },
    { id: 'dice',     label: 'Dice', soon: true },
    { id: 'crash',    label: 'Crash', soon: true },
  ];

  return (
    <div className="space-y-5">
      {/* game picker */}
      <section>
        <h2 className="text-sm font-bold text-text-primary mb-2">1. Pick a game</h2>
        <div className="grid grid-cols-3 gap-2">
          {GAMES.map((g) => (
            <button
              key={g.id}
              type="button"
              onClick={() => !g.soon && onGameType(g.id)}
              disabled={g.soon}
              className={`relative py-3 rounded-lg border text-sm font-mono uppercase tracking-widest transition ${
                gameType === g.id
                  ? 'border-brand-green/60 bg-brand-green/10 text-brand-green'
                  : g.soon
                    ? 'border-border text-text-muted/40 cursor-not-allowed'
                    : 'border-border text-text-secondary hover:bg-surface/50'
              }`}
            >
              {g.label}
              {g.soon && (
                <span className="absolute top-1 right-2 text-[8px] uppercase tracking-widest text-text-muted/60">soon</span>
              )}
            </button>
          ))}
        </div>
      </section>

      {/* choice */}
      <section>
        <h2 className="text-sm font-bold text-text-primary mb-2">2. Pick your side</h2>
        <div className="grid grid-cols-2 gap-2">
          {(['heads', 'tails'] as Choice[]).map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => onChoice(c)}
              className={`py-3 rounded-lg border text-sm font-mono uppercase tracking-widest transition ${
                creatorChoice === c
                  ? 'border-brand-green/60 bg-brand-green/10 text-brand-green'
                  : 'border-border text-text-secondary hover:bg-surface/50'
              }`}
            >
              {c}
            </button>
          ))}
        </div>
      </section>

      {/* stakes + members */}
      <section className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <NumberField
          label="Your stake"
          value={creatorStake}
          onChange={onCreatorStake}
          suffix="$"
          error={errors.creatorStake}
          hint="Locked in immediately"
        />
        <NumberField
          label="Per-member"
          value={perMemberStake}
          onChange={onPerMemberStake}
          suffix="$/seat"
          error={errors.perMemberStake}
          hint="Each joiner pays this much"
        />
        <NumberField
          label="Auto-flip countdown"
          value={autoFlipSeconds}
          onChange={onAutoFlipSeconds}
          suffix="sec"
          error={errors.autoFlipSeconds}
          hint="When full + turn=auto"
        />
      </section>

      <section className="grid grid-cols-2 gap-3">
        <NumberField
          label="Min members"
          value={minMembers}
          onChange={onMinMembers}
          error={errors.minMembers}
          hint="Start at 2"
        />
        <NumberField
          label="Max members"
          value={maxMembers}
          onChange={onMaxMembers}
          error={errors.maxMembers}
          hint="Hard cap of 10"
        />
      </section>

      {/* name + description (future-proof fields — names are not yet in the create API) */}
      <section>
        <h2 className="text-sm font-bold text-text-primary mb-2">Name (optional)</h2>
        <input
          type="text"
          value={name}
          maxLength={50}
          onChange={(e) => onName(e.target.value)}
          placeholder="e.g. Friday Night Coinflip"
          className="w-full bg-surface/60 border border-border rounded-lg px-3 py-2 text-sm text-text-primary"
        />
        <h2 className="text-sm font-bold text-text-primary mt-3 mb-2">Description (optional)</h2>
        <textarea
          value={description}
          maxLength={200}
          onChange={(e) => onDescription(e.target.value)}
          rows={2}
          placeholder="Tell your friends what this is about…"
          className="w-full bg-surface/60 border border-border rounded-lg px-3 py-2 text-sm text-text-primary resize-none"
        />
      </section>

      {/* pool estimate */}
      <div className="border border-border rounded-lg p-3 flex items-center gap-2 bg-surface/20">
        <Coins size={16} className="text-brand-green" />
        <span className="text-sm text-text-secondary">
          Estimated total pool when full:
          <span className="ml-2 font-mono font-bold text-brand-green">
            ${totalPoolEstimate.toFixed(2)}
          </span>
        </span>
      </div>
    </div>
  );
}

// ─── Step 2: distribution + turn ──────────────────────────────────
function Step2({ payoutMode, onPayoutMode, turnMode, onTurnMode }: any) {
  return (
    <div className="space-y-5">
      <section>
        <h2 className="text-sm font-bold text-text-primary mb-2">Distribution</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {PAYOUT_OPTIONS.map((opt) => {
            const Icon = opt.icon;
            const active = payoutMode === opt.mode;
            return (
              <button
                key={opt.mode}
                type="button"
                onClick={() => onPayoutMode(opt.mode)}
                className={`text-left p-3 rounded-lg border transition ${
                  active
                    ? 'border-brand-green/60 bg-brand-green/10'
                    : 'border-border text-text-secondary hover:bg-surface/50'
                }`}
              >
                <Icon size={16} className={active ? 'text-brand-green' : 'text-text-muted'} />
                <div className={`mt-1 font-bold text-sm ${active ? 'text-brand-green' : 'text-text-primary'}`}>
                  {opt.label}
                </div>
                <div className="text-[11px] text-text-muted mt-0.5">{opt.desc}</div>
              </button>
            );
          })}
        </div>
      </section>

      <section>
        <h2 className="text-sm font-bold text-text-primary mb-2">Turn decision</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {TURN_OPTIONS.map((opt) => {
            const active = turnMode === opt.mode;
            return (
              <button
                key={opt.mode}
                type="button"
                onClick={() => onTurnMode(opt.mode)}
                className={`text-left p-3 rounded-lg border transition ${
                  active
                    ? 'border-brand-info/60 bg-brand-info/10'
                    : 'border-border text-text-secondary hover:bg-surface/50'
                }`}
              >
                <div className={`mt-0.5 font-bold text-sm ${active ? 'text-brand-info' : 'text-text-primary'}`}>
                  {opt.label}
                </div>
                <div className="text-[11px] text-text-muted mt-0.5">{opt.desc}</div>
              </button>
            );
          })}
        </div>
      </section>
    </div>
  );
}

// ─── Step 3: Review ────────────────────────────────────────────────
function Step3(p: any) {
  const { totalPoolEstimate } = p;
  const rows = [
    { label: 'Game',           value: p.gameType ?? 'coinflip' },
    { label: 'Your side',      value: p.creatorChoice },
    { label: 'Your stake',     value: `$${p.creatorStake.toFixed(2)}` },
    { label: 'Per-member',     value: `$${p.perMemberStake.toFixed(2)}` },
    { label: 'Min members',    value: String(p.minMembers) },
    { label: 'Max members',    value: String(p.maxMembers) },
    { label: 'Auto-flip',      value: `${p.autoFlipSeconds}s` },
    { label: 'Distribution',   value: p.payoutMode },
    { label: 'Turn decision',  value: p.turnMode },
    { label: 'Name',           value: p.name || '—' },
    { label: 'Description',    value: p.description || '—' },
    { label: 'Estimated pool (full room)', value: `$${totalPoolEstimate.toFixed(2)}` },
  ];
  return (
    <div>
      <h2 className="text-sm font-bold text-text-primary mb-3">Review</h2>
      <ul className="divide-y divide-border border border-border rounded-lg">
        {rows.map((r, i) => (
          <li key={i} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
            <span className="text-text-muted text-xs uppercase tracking-widest font-mono">{r.label}</span>
            <span className="text-text-primary font-mono truncate">{r.value}</span>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs text-text-muted">
        Press <span className="font-mono text-brand-green">Create room</span> to lock the stake — it can't be edited
        afterwards. After creation you'll get a share link to invite friends.
      </p>
    </div>
  );
}

// ─── small numeric input ────────────────────────────────────────────
function NumberField({ label, value, onChange, suffix, error, hint, step, min, max }: any) {
  return (
    <label className="block">
      <span className="text-xs uppercase tracking-widest font-mono text-text-muted">{label}</span>
      <div className="flex items-center gap-2 mt-1">
        <input
          type="number"
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          step={step ?? 1}
          min={min ?? 0}
          max={max ?? 1_000_000}
          className={`flex-1 bg-surface/60 border rounded-lg px-3 py-2 text-sm font-mono text-text-primary ${
            error ? 'border-rose-500' : 'border-border'
          }`}
        />
        {suffix && <span className="text-xs text-text-muted font-mono">{suffix}</span>}
      </div>
      {error && <span className="text-rose-400 text-xs mt-1 block">{error}</span>}
      {hint && !error && <span className="text-text-muted/60 text-xs mt-0.5 block">{hint}</span>}
    </label>
  );
}
