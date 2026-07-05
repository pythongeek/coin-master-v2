'use client';
/**
 * ═══════════════════════════════════════════════════════════════
 *  KYC VERIFICATION PAGE — এআই-চালিত কেওয়াইসি ভেরিফিকেশন পেজ
 * ═══════════════════════════════════════════════════════════════
 */
import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ShieldCheck,
  UploadCloud,
  Camera,
  Loader2,
  ArrowLeft,
  CheckCircle2,
  AlertTriangle,
  RefreshCw,
  UserCheck,
  ChevronRight,
  Sparkles,
  Check,
  Fingerprint
} from 'lucide-react';
import { useGameStore } from '@/lib/store';

const API =
  typeof window !== 'undefined' && !window.location.host.startsWith('localhost:') && window.location.host !== 'localhost'
    ? '/api'
    : process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

interface AIVerifyResponse {
  success: boolean;
  verified: boolean;
  confidence: number;
  reason: string;
  documentInfo?: {
    name: string;
    dateOfBirth: string;
    docNumber: string;
  };
}

export default function KYCPage() {
  const router = useRouter();
  const { user, setUser } = useGameStore();

  const [loading, setLoading] = useState(true);
  const [kycStatus, setKycStatus] = useState<'unverified' | 'pending' | 'verified' | 'rejected'>('unverified');
  const [verifiedAt, setVerifiedAt] = useState<string | null>(null);
  const [applicantId, setApplicantId] = useState<string | null>(null);
  const [aiMockMode, setAiMockMode] = useState(true);

  // Verification Upload/Capture States
  const [docBase64, setDocBase64] = useState<string | null>(null);
  const [selfieBase64, setSelfieBase64] = useState<string | null>(null);
  const [docFileName, setDocFileName] = useState<string | null>(null);

  // Camera capture states
  const [isCameraActive, setIsCameraActive] = useState(false);
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);

  // Verification process states
  const [verifying, setVerifying] = useState(false);
  const [verifyStep, setVerifyStep] = useState<string>('');
  const [aiResult, setAiResult] = useState<AIVerifyResponse | null>(null);

  const token = typeof window !== 'undefined' ? localStorage.getItem('cf_token') || '' : '';
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // Load User KYC Info on mount
  async function fetchKYCStatus() {
    setLoading(true);
    try {
      const res = await fetch(`${API}/kyc/status`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      if (data.success) {
        setKycStatus(data.kycStatus);
        setVerifiedAt(data.verifiedAt);
        setApplicantId(data.applicantId);
        setAiMockMode(data.aiMockMode);
      }
    } catch (err) {
      console.error('Failed to load KYC status:', err);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!token) {
      router.push('/game');
      return;
    }
    fetchKYCStatus();

    // Clean up camera stream if active on unmount
    return () => {
      stopCamera();
    };
  }, [token]);

  // Start Webcam stream
  async function startCamera() {
    try {
      setIsCameraActive(true);
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: 480, height: 480 },
        audio: false
      });
      setCameraStream(stream);
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.play();
      }
    } catch (err) {
      console.error('Failed to open camera:', err);
      alert('ক্যামেরা চালু করা সম্ভব হয়নি। অনুগ্রহ করে ক্যামেরা পারমিশন চেক করুন অথবা সেলফি ফাইল আপলোড করুন।');
      setIsCameraActive(false);
    }
  }

  // Stop Webcam stream
  function stopCamera() {
    if (cameraStream) {
      cameraStream.getTracks().forEach((track) => track.stop());
      setCameraStream(null);
    }
    setIsCameraActive(false);
  }

  // Take Snapshot from video element
  function captureSelfie() {
    if (videoRef.current) {
      const video = videoRef.current;
      const canvas = document.createElement('canvas');
      // Capture a square aspect ratio
      const size = Math.min(video.videoWidth, video.videoHeight);
      canvas.width = size;
      canvas.height = size;

      const ctx = canvas.getContext('2d');
      if (ctx) {
        // Crop center
        const sx = (video.videoWidth - size) / 2;
        const sy = (video.videoHeight - size) / 2;
        ctx.drawImage(video, sx, sy, size, size, 0, 0, size, size);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
        setSelfieBase64(dataUrl);
      }
      stopCamera();
    }
  }

  // Handle Document File selection
  function handleDocumentChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) {
      setDocFileName(file.name);
      const reader = new FileReader();
      reader.onload = () => {
        setDocBase64(reader.result as string);
      };
      reader.readAsDataURL(file);
    }
  }

  // Handle Selfie File upload (fallback if no camera)
  function handleSelfieFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = () => {
        setSelfieBase64(reader.result as string);
      };
      reader.readAsDataURL(file);
    }
  }

  // Start real-time AI verification
  async function runAIVerify() {
    if (!docBase64 || !selfieBase64) return;

    setVerifying(true);
    setAiResult(null);

    // Simulated step indicators for visual polish
    const steps = [
      'ডকুমেন্ট আপলোড হচ্ছে...',
      'অপটিক্যাল ক্যারেক্টার রিকগনিশন (OCR) চালনা করা হচ্ছে...',
      'জাতীয় ডাটাবেজের সাথে তথ্য মিলিয়ে দেখা হচ্ছে...',
      'মুখের অবয়ব এবং সেলফি মেলাচ্ছেন কৃত্তিম বুদ্ধিমত্তা...',
      'চূড়ান্ত রেটিং ও সিদ্ধান্ত যাচাই হচ্ছে...'
    ];

    let currentStepIdx = 0;
    setVerifyStep(steps[0]);

    const stepInterval = setInterval(() => {
      if (currentStepIdx < steps.length - 1) {
        currentStepIdx++;
        setVerifyStep(steps[currentStepIdx]);
      }
    }, 1500);

    try {
      const res = await fetch(`${API}/kyc/verify-ai`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          document: docBase64,
          selfie: selfieBase64
        })
      });

      clearInterval(stepInterval);
      const data = (await res.json()) as AIVerifyResponse;
      setAiResult(data);

      if (data.success && data.verified) {
        setKycStatus('verified');
        if (user) {
          // Update local balance state and reload details
          setUser({ ...user, balance: user.balance });
        }
      } else {
        setKycStatus('rejected');
      }
    } catch (err) {
      clearInterval(stepInterval);
      console.error('AI verification failed:', err);
      alert('ভেরিফিকেশন প্রক্রিয়া সম্পন্ন করা সম্ভব হয়নি। অনুগ্রহ করে পুনরায় চেষ্টা করুন।');
      setVerifying(false);
    } finally {
      setVerifying(false);
    }
  }

  return (
    <main className="min-h-screen p-4 md:p-6 max-w-2xl mx-auto flex flex-col justify-center">
      {/* Back Button */}
      <div className="mb-6">
        <Link
          href="/dashboard"
          className="inline-flex items-center gap-1.5 text-text-muted hover:text-text-primary text-sm font-mono transition-colors"
        >
          <ArrowLeft size={16} />
          ড্যাশবোর্ডে ফিরে যান
        </Link>
      </div>

      <div className="glass-card p-6 md:p-8 rounded-2xl relative overflow-hidden shadow-elevate-lg border border-border">
        {/* Decorative Grid Gradient */}
        <div className="absolute top-0 right-0 w-48 h-48 bg-brand-green/5 rounded-full blur-3xl -z-10 pointer-events-none" />

        {loading ? (
          <div className="flex flex-col items-center justify-center py-16 space-y-4">
            <Loader2 size={48} className="text-brand-green animate-spin" />
            <p className="text-text-secondary text-sm font-mono">ভেরিফিকেশন স্ট্যাটাস চেক করা হচ্ছে...</p>
          </div>
        ) : verifying ? (
          /* ── AI Processing View ───────────────────────────────────────── */
          <div className="flex flex-col items-center justify-center py-16 space-y-6 text-center animate-lift-in">
            <div className="relative">
              <div className="w-20 h-20 rounded-full border-2 border-brand-green/30 border-t-brand-green animate-spin flex items-center justify-center">
                <Sparkles className="text-brand-green animate-pulse" size={32} />
              </div>
              <div className="absolute -inset-1 rounded-full border border-brand-green/10 animate-ping pointer-events-none" />
            </div>
            <div>
              <h2 className="heading-display text-xl text-text-primary mb-1">এআই ভেরিফিকেশন চলছে</h2>
              <p className="text-text-muted text-xs font-mono max-w-sm mx-auto">{verifyStep}</p>
            </div>
            <div className="w-full max-w-xs bg-surface2 h-1 rounded-full overflow-hidden">
              <div className="h-full bg-brand-green animate-progress-indefinite rounded-full" />
            </div>
          </div>
        ) : (
          <>
            {/* ── Status 1: Verified ────────────────────────────────────────── */}
            {kycStatus === 'verified' && (
              <div className="text-center py-8 space-y-6 animate-lift-in">
                <div className="inline-flex items-center justify-center w-20 h-20 rounded-full bg-brand-green/10 border border-brand-green/20 text-brand-green">
                  <ShieldCheck size={44} strokeWidth={1.5} />
                </div>
                <div>
                  <h1 className="heading-display text-2xl text-text-primary mb-2">KYC ভেরিফিকেশন সফল!</h1>
                  <p className="text-text-secondary text-sm">
                    আপনার পরিচয় সফলভাবে যাচাই করা হয়েছে। আপনার অ্যাকাউন্টটি এখন সম্পূর্ণ সক্রিয়।
                  </p>
                </div>

                {aiResult?.documentInfo && (
                  <div className="glass-card max-w-sm mx-auto p-4 rounded-xl space-y-2.5 border border-border text-left font-mono text-xs">
                    <h4 className="text-text-primary font-display font-semibold text-[13px] border-b border-border/50 pb-1.5 flex items-center gap-1.5">
                      <Sparkles size={13} className="text-brand-green" />
                      এআই দ্বারা সনাক্তকৃত তথ্য:
                    </h4>
                    <div className="flex justify-between">
                      <span className="text-text-muted">পূর্ণ নাম:</span>
                      <span className="text-text-primary font-semibold">{aiResult.documentInfo.name}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-text-muted">জন্ম তারিখ:</span>
                      <span className="text-text-primary font-semibold">{aiResult.documentInfo.dateOfBirth}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-text-muted">ডকুমেন্ট নম্বর:</span>
                      <span className="text-text-primary font-semibold">{aiResult.documentInfo.docNumber}</span>
                    </div>
                    <div className="flex justify-between border-t border-border/50 pt-1.5">
                      <span className="text-text-muted">ম্যাচিং স্কোর:</span>
                      <span className="text-brand-green font-semibold">{aiResult.confidence}% (সঠিক)</span>
                    </div>
                  </div>
                )}

                <div className="flex flex-col gap-2 max-w-xs mx-auto">
                  <Link href="/game" className="btn-brand py-3 px-6 rounded-xl font-display font-semibold text-center">
                    গেম খেলা শুরু করুন
                  </Link>
                </div>
              </div>
            )}

            {/* ── Status 2: Rejected ────────────────────────────────────────── */}
            {kycStatus === 'rejected' && (
              <div className="text-center py-8 space-y-6 animate-lift-in">
                <div className="inline-flex items-center justify-center w-20 h-20 rounded-full bg-brand-red/10 border border-brand-red/20 text-brand-red">
                  <AlertTriangle size={44} strokeWidth={1.5} />
                </div>
                <div>
                  <h1 className="heading-display text-2xl text-text-primary mb-2">ভেরিফিকেশন প্রত্যাখ্যান হয়েছে</h1>
                  <p className="text-text-secondary text-sm max-w-md mx-auto">
                    দুঃখিত, কৃত্তিম বুদ্ধিমত্তা আপনার ডকুমেন্টস এবং ফেস প্রোফাইল মেলাতে পারেনি।
                  </p>
                  {aiResult?.reason && (
                    <div className="mt-3 p-3 bg-brand-red/5 border border-brand-red/10 rounded-xl max-w-sm mx-auto text-xs text-brand-red font-mono">
                      কারণ: {aiResult.reason}
                    </div>
                  )}
                </div>
                <div className="pt-2">
                  <button
                    onClick={() => {
                      setDocBase64(null);
                      setSelfieBase64(null);
                      setDocFileName(null);
                      setAiResult(null);
                      setKycStatus('unverified');
                    }}
                    className="btn-brand py-3 px-6 rounded-xl font-display font-semibold"
                  >
                    আবার চেষ্টা করুন
                  </button>
                </div>
              </div>
            )}

            {/* ── Status 3: Unverified (Main Verification Form) ──────────────── */}
            {kycStatus === 'unverified' && (
              <div className="space-y-6 animate-lift-in">
                <div className="flex items-center justify-between border-b border-border pb-4">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-brand-green/10 border border-brand-green/20 flex items-center justify-center text-brand-green">
                      <Fingerprint size={18} />
                    </div>
                    <div>
                      <h1 className="heading-display text-xl text-text-primary">এআই কেওয়াইসি (AI KYC) ভেরিফিকেশন</h1>
                      <p className="text-text-muted text-xs font-mono">
                        {aiMockMode ? 'ডেভলপার সিমুলেটর মোড সক্রিয়' : 'Real-time AI Verification Engine'}
                      </p>
                    </div>
                  </div>
                  {aiMockMode && (
                    <span className="text-[10px] font-mono bg-brand-info/10 text-brand-info px-2 py-0.5 border border-brand-info/20 rounded">
                      MOCK ACTIVE
                    </span>
                  )}
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {/* Left Column: ID Document */}
                  <div className="space-y-3">
                    <label className="text-xs font-semibold text-text-secondary block font-mono">
                      ধাপ ১: আইডি ডকুমেন্ট আপলোড (NID/পাসপোর্ট)
                    </label>

                    {docBase64 ? (
                      <div className="border border-brand-green/30 bg-brand-green/5 rounded-xl p-4 text-center relative">
                        <div className="w-10 h-10 rounded-full bg-brand-green/10 text-brand-green flex items-center justify-center mx-auto mb-2">
                          <Check size={16} />
                        </div>
                        <p className="text-xs text-text-primary font-semibold truncate max-w-[200px] mx-auto">
                          {docFileName || 'ডকুমেন্ট ইমেজ'}
                        </p>
                        <button
                          onClick={() => setDocBase64(null)}
                          className="text-[10px] text-text-muted hover:text-brand-red font-mono underline mt-1.5 block mx-auto"
                        >
                          পরিবর্তন করুন
                        </button>
                      </div>
                    ) : (
                      <div className="relative border border-dashed border-border hover:border-brand-green/30 bg-surface/20 hover:bg-surface/35 transition-all rounded-xl p-6 text-center cursor-pointer group">
                        <input
                          type="file"
                          accept="image/*"
                          onChange={handleDocumentChange}
                          className="absolute inset-0 opacity-0 cursor-pointer z-10"
                        />
                        <UploadCloud size={28} className="text-text-muted group-hover:text-brand-green mx-auto mb-2 transition-colors" />
                        <span className="text-xs font-semibold text-text-secondary block">এনআইডি/পাসপোর্ট আপলোড</span>
                        <span className="text-[9px] text-text-muted font-mono block mt-0.5">ছবি সিলেক্ট করুন</span>
                      </div>
                    )}
                  </div>

                  {/* Right Column: Selfie Capture */}
                  <div className="space-y-3">
                    <label className="text-xs font-semibold text-text-secondary block font-mono">
                      ধাপ ২: ফেস সেলফি স্ক্যান (Liveness Selfie)
                    </label>

                    {selfieBase64 ? (
                      <div className="border border-brand-green/30 bg-brand-green/5 rounded-xl p-4 text-center relative">
                        <div className="w-12 h-12 rounded-full overflow-hidden border border-brand-green/20 mx-auto mb-2">
                          <img src={selfieBase64} alt="Captured Selfie" className="w-full h-full object-cover" />
                        </div>
                        <p className="text-xs text-brand-green font-semibold">সেলফি সফলভাবে ক্যাপচার্ড</p>
                        <button
                          onClick={() => setSelfieBase64(null)}
                          className="text-[10px] text-text-muted hover:text-brand-red font-mono underline mt-1.5 block mx-auto"
                        >
                          আবার তুলুন
                        </button>
                      </div>
                    ) : isCameraActive ? (
                      /* Live Camera Screen */
                      <div className="border border-border bg-void rounded-xl overflow-hidden relative flex flex-col items-center p-2">
                        <div className="w-32 h-32 rounded-full overflow-hidden border-2 border-brand-info relative bg-surface">
                          <video ref={videoRef} className="w-full h-full object-cover transform -scale-x-100" playsInline muted />
                          <div className="absolute inset-0 border border-brand-info/10 animate-pulse pointer-events-none" />
                        </div>
                        <div className="flex gap-2 w-full mt-3">
                          <button
                            onClick={captureSelfie}
                            className="flex-1 py-1.5 rounded-lg bg-brand-info text-void text-[11px] font-display font-semibold hover:bg-brand-info/90"
                          >
                            ছবি তুলুন
                          </button>
                          <button
                            onClick={stopCamera}
                            className="px-2 py-1.5 rounded-lg bg-surface hover:bg-surface2 border border-border text-[11px] text-text-secondary"
                          >
                            বন্ধ
                          </button>
                        </div>
                      </div>
                    ) : (
                      /* Options Choose Box */
                      <div className="grid grid-cols-1 gap-2">
                        <button
                          onClick={startCamera}
                          className="border border-dashed border-border hover:border-brand-info/30 bg-surface/20 hover:bg-surface/35 transition-all rounded-xl p-4 text-center flex flex-col items-center gap-1.5 group"
                        >
                          <Camera size={20} className="text-text-muted group-hover:text-brand-info transition-colors" />
                          <div>
                            <span className="text-xs font-semibold text-text-secondary block">লাইভ ক্যামেরা দিয়ে ছবি তুলুন</span>
                            <span className="text-[8px] text-text-muted font-mono block mt-0.5">ওয়েবক্যাম সেলফি</span>
                          </div>
                        </button>
                        <div className="relative border border-dashed border-border hover:border-brand-info/30 bg-surface/10 hover:bg-surface/20 transition-all rounded-xl p-2.5 text-center flex items-center justify-center gap-2 cursor-pointer group">
                          <input
                            type="file"
                            accept="image/*"
                            onChange={handleSelfieFileChange}
                            className="absolute inset-0 opacity-0 cursor-pointer z-10"
                          />
                          <UploadCloud size={14} className="text-text-muted group-hover:text-brand-info" />
                          <span className="text-[10px] text-text-muted font-mono">সেলফি ফাইল আপলোড করুন (বিকল্প)</span>
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                <div className="border-t border-border pt-4">
                  <button
                    onClick={runAIVerify}
                    disabled={!docBase64 || !selfieBase64}
                    className="w-full btn-brand py-3 rounded-xl font-display font-semibold flex items-center justify-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <Sparkles size={16} />
                    আইডেন্টিটি ভেরিফিকেশন সম্পন্ন করুন (AI check)
                  </button>
                  {aiMockMode && (
                    <p className="text-center text-[10px] font-mono text-text-muted mt-2">
                      💡 ডেমো মোড চালু আছে। যেকোনো ছবি সাবমিট করলেই ভেরিফাইড হয়ে যাবে।
                    </p>
                  )}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </main>
  );
}
