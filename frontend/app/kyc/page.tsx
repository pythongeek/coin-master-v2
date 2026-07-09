'use client';
/**
 * ═══════════════════════════════════════════════════════════════
 *  KYC VERIFICATION PAGE — Real AI-powered KYC using MiniMax M3
 * ═══════════════════════════════════════════════════════════════
 */
import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ShieldCheck, UploadCloud, Camera, Loader2, ArrowLeft, CheckCircle2, AlertTriangle, RefreshCw, Fingerprint, Check, Sparkles } from 'lucide-react';
import { useGameStore } from '@/lib/store';
import { getApiBase } from '@/lib/api/base';

const API = getApiBase();

interface KycVerifyResponse {
  success: boolean;
  sessionId?: string;
  status?: 'pending' | 'approved' | 'review' | 'rejected';
  riskScore?: number;
  riskTier?: string;
  decision?: string;
  documentValid?: boolean;
  faceMatch?: boolean;
  faceSimilarity?: number;
  livenessPassed?: boolean;
  sanctionsClear?: boolean;
  extractedFields?: Record<string, string | undefined>;
  fraudSignals?: string[];
  complianceReasoning?: string;
  error?: string;
}

interface KycSession {
  id: string;
  status: 'pending' | 'approved' | 'review' | 'rejected';
  risk_score: number | null;
  risk_tier: string | null;
  final_decision: string | null;
  document_valid: boolean | null;
  face_match: boolean | null;
  face_similarity: number | null;
  liveness_passed: boolean | null;
  sanctions_clear: boolean | null;
  extracted_fields: Record<string, string | undefined> | null;
  fraud_signals: string[] | null;
  compliance_reasoning: string | null;
  created_at: string;
  completed_at: string | null;
  reviewed_at: string | null;
}

interface KycStatusResponse {
  success: boolean;
  kycStatus: 'unverified' | 'pending' | 'approved' | 'review' | 'rejected' | 'verified';
  verifiedAt: string | null;
  provider: string;
  latestSession: KycSession | null;
}

export default function KYCPage() {
  const router = useRouter();
  const { user } = useGameStore();

  const [loading, setLoading] = useState(true);
  const [kycStatus, setKycStatus] = useState<KycStatusResponse['kycStatus']>('unverified');
  const [verifiedAt, setVerifiedAt] = useState<string | null>(null);
  const [provider, setProvider] = useState<string>('manual');
  const [latestSession, setLatestSession] = useState<KycSession | null>(null);

  const [docBase64, setDocBase64] = useState<string | null>(null);
  const [selfieBase64, setSelfieBase64] = useState<string | null>(null);
  const [docFileName, setDocFileName] = useState<string | null>(null);
  const [isCameraActive, setIsCameraActive] = useState(false);
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [verifyStep, setVerifyStep] = useState<string>('');
  const [result, setResult] = useState<KycVerifyResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const token = typeof window !== 'undefined' ? localStorage.getItem('cf_token') || '' : '';
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const steps = [
    'Uploading document and selfie...',
    'Running open-source OCR...',
    'Analyzing document and face with MiniMax M3...',
    'Running sanctions and fraud checks...',
    'Calculating final risk score...',
  ];

  async function fetchKYCStatus() {
    setLoading(true);
    try {
      const res = await fetch(`${API}/kyc/status`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = (await res.json()) as KycStatusResponse;
      if (data.success) {
        setKycStatus(data.kycStatus);
        setVerifiedAt(data.verifiedAt);
        setProvider(data.provider);
        setLatestSession(data.latestSession);
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
    return () => stopCamera();
  }, [token]);

  async function startCamera() {
    try {
      setIsCameraActive(true);
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: 480, height: 480 },
        audio: false,
      });
      setCameraStream(stream);
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.play();
      }
    } catch (err) {
      console.error('Failed to open camera:', err);
      alert('Could not start camera. Please allow camera permission or upload a selfie file.');
      setIsCameraActive(false);
    }
  }

  function stopCamera() {
    if (cameraStream) {
      cameraStream.getTracks().forEach((track) => track.stop());
      setCameraStream(null);
    }
    setIsCameraActive(false);
  }

  function captureSelfie() {
    if (!videoRef.current) return;
    const video = videoRef.current;
    const canvas = document.createElement('canvas');
    const size = Math.min(video.videoWidth, video.videoHeight);
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const sx = (video.videoWidth - size) / 2;
    const sy = (video.videoHeight - size) / 2;
    ctx.drawImage(video, sx, sy, size, size, 0, 0, size, size);
    setSelfieBase64(canvas.toDataURL('image/jpeg', 0.85));
    stopCamera();
  }

  function handleDocumentChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setDocFileName(file.name);
    const reader = new FileReader();
    reader.onload = () => setDocBase64(reader.result as string);
    reader.readAsDataURL(file);
  }

  function handleSelfieFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setSelfieBase64(reader.result as string);
    reader.readAsDataURL(file);
  }

  async function runVerify() {
    if (!docBase64 || !selfieBase64) return;

    setVerifying(true);
    setResult(null);
    setError(null);

    let currentStep = 0;
    setVerifyStep(steps[0]);
    const interval = setInterval(() => {
      currentStep = Math.min(currentStep + 1, steps.length - 1);
      setVerifyStep(steps[currentStep]);
    }, 2000);

    try {
      const res = await fetch(`${API}/kyc/verify`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ document: docBase64, selfie: selfieBase64 }),
      });

      const data = (await res.json()) as KycVerifyResponse;
      clearInterval(interval);
      setVerifyStep('');

      if (!data.success) {
        setError(data.error || 'Verification failed');
      } else {
        setResult(data);
        setKycStatus(data.status === 'approved' ? 'approved' : data.status === 'rejected' ? 'rejected' : 'review');
      }
    } catch (err) {
      clearInterval(interval);
      setError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setVerifying(false);
    }
  }

  const statusMap: Record<string, string> = {
    approved: 'Verified',
    verified: 'Verified',
    pending: 'Pending Review',
    review: 'Under Review',
    rejected: 'Rejected',
    unverified: 'Not Verified',
  };

  const statusColor = (s: string) => {
    if (s === 'approved' || s === 'verified') return 'text-brand-green';
    if (s === 'rejected') return 'text-brand-red';
    if (s === 'pending' || s === 'review') return 'text-brand-info';
    return 'text-text-muted';
  };

  return (
    <main className="min-h-screen p-4 md:p-6 max-w-2xl mx-auto flex flex-col justify-center">
      <div className="mb-6">
        <Link href="/dashboard" className="inline-flex items-center gap-1.5 text-text-muted hover:text-text-primary text-sm font-mono transition-colors">
          <ArrowLeft size={16} />
          Back to Dashboard
        </Link>
      </div>

      <div className="glass-card p-6 md:p-8 rounded-2xl relative overflow-hidden shadow-elevate-lg border border-border">
        <div className="absolute top-0 right-0 w-48 h-48 bg-brand-green/5 rounded-full blur-3xl -z-10 pointer-events-none" />

        {loading ? (
          <div className="flex flex-col items-center justify-center py-16 space-y-4">
            <Loader2 size={48} className="text-brand-green animate-spin" />
            <p className="text-text-secondary text-sm font-mono">Checking verification status...</p>
          </div>
        ) : verifying ? (
          <div className="flex flex-col items-center justify-center py-16 space-y-6 text-center animate-lift-in">
            <div className="relative">
              <div className="w-20 h-20 rounded-full border-2 border-brand-green/30 border-t-brand-green animate-spin flex items-center justify-center">
                <Sparkles className="text-brand-green animate-pulse" size={32} />
              </div>
              <div className="absolute -inset-1 rounded-full border border-brand-green/10 animate-ping pointer-events-none" />
            </div>
            <div>
              <h2 className="heading-display text-xl text-text-primary mb-1">AI KYC Verification</h2>
              <p className="text-text-muted text-xs font-mono max-w-sm mx-auto">{verifyStep}</p>
            </div>
            <div className="w-full max-w-xs bg-surface2 h-1 rounded-full overflow-hidden">
              <div className="h-full bg-brand-green animate-progress-indefinite rounded-full" />
            </div>
          </div>
        ) : (
          <>
            {(kycStatus === 'approved' || kycStatus === 'verified') && (
              <div className="text-center py-8 space-y-6 animate-lift-in">
                <div className="inline-flex items-center justify-center w-20 h-20 rounded-full bg-brand-green/10 border border-brand-green/20 text-brand-green">
                  <ShieldCheck size={44} strokeWidth={1.5} />
                </div>
                <div>
                  <h1 className="heading-display text-2xl text-text-primary mb-2">KYC Verified!</h1>
                  <p className="text-text-secondary text-sm">Your identity has been confirmed. Your account is fully active.</p>
                  {verifiedAt && (
                    <p className="text-text-muted text-xs font-mono mt-1">Verified at: {new Date(verifiedAt).toLocaleString()}</p>
                  )}
                </div>

                {latestSession?.extracted_fields && (
                  <div className="glass-card max-w-sm mx-auto p-4 rounded-xl space-y-2.5 border border-border text-left font-mono text-xs">
                    <h4 className="text-text-primary font-display font-semibold text-[13px] border-b border-border/50 pb-1.5 flex items-center gap-1.5">
                      <Sparkles size={13} className="text-brand-green" />
                      Extracted Information
                    </h4>
                    {Object.entries(latestSession.extracted_fields).map(([key, value]) => (
                      <div className="flex justify-between" key={key}>
                        <span className="text-text-muted capitalize">{key.replace(/_/g, ' ')}:</span>
                        <span className="text-text-primary font-semibold">{value || '—'}</span>
                      </div>
                    ))}
                    <div className="flex justify-between border-t border-border/50 pt-1.5">
                      <span className="text-text-muted">Face similarity:</span>
                      <span className="text-brand-green font-semibold">
                        {latestSession.face_similarity ? `${(latestSession.face_similarity * 100).toFixed(1)}%` : '—'}
                      </span>
                    </div>
                  </div>
                )}

                <Link href="/game" className="btn-brand py-3 px-6 rounded-xl font-display font-semibold text-center inline-block">
                  Play Game
                </Link>
              </div>
            )}

            {(kycStatus === 'rejected' || error) && (
              <div className="text-center py-8 space-y-6 animate-lift-in">
                <div className="inline-flex items-center justify-center w-20 h-20 rounded-full bg-brand-red/10 border border-brand-red/20 text-brand-red">
                  <AlertTriangle size={44} strokeWidth={1.5} />
                </div>
                <div>
                  <h1 className="heading-display text-2xl text-text-primary mb-2">Verification Failed</h1>
                  <p className="text-text-secondary text-sm max-w-md mx-auto">
                    {error || result?.complianceReasoning || 'We could not verify your identity. Please review the requirements and try again.'}
                  </p>
                  {result?.fraudSignals && result.fraudSignals.length > 0 && (
                    <ul className="mt-3 text-xs text-brand-red font-mono list-disc list-inside max-w-sm mx-auto text-left">
                      {result.fraudSignals.map((s, i) => (
                        <li key={i}>{s}</li>
                      ))}
                    </ul>
                  )}
                </div>
                <button
                  onClick={() => {
                    setDocBase64(null);
                    setSelfieBase64(null);
                    setDocFileName(null);
                    setResult(null);
                    setError(null);
                    setKycStatus('unverified');
                  }}
                  className="btn-brand py-3 px-6 rounded-xl font-display font-semibold"
                >
                  Try Again
                </button>
              </div>
            )}

            {(kycStatus === 'pending' || kycStatus === 'review') && (
              <div className="text-center py-8 space-y-6 animate-lift-in">
                <div className="inline-flex items-center justify-center w-20 h-20 rounded-full bg-brand-info/10 border border-brand-info/20 text-brand-info">
                  <Loader2 size={44} strokeWidth={1.5} className="animate-spin" />
                </div>
                <div>
                  <h1 className="heading-display text-2xl text-text-primary mb-2">Under Review</h1>
                  <p className="text-text-secondary text-sm max-w-md mx-auto">
                    Your submission is being reviewed by our compliance team. This usually takes a few minutes to a few hours.
                  </p>
                  {latestSession && (
                    <div className="mt-4 text-xs font-mono text-text-muted space-y-1">
                      <div>Risk score: {latestSession.risk_score ?? '—'} ({latestSession.risk_tier ?? '—'})</div>
                      <div>Submitted: {new Date(latestSession.created_at).toLocaleString()}</div>
                    </div>
                  )}
                </div>
                <button onClick={fetchKYCStatus} className="btn-secondary py-2 px-5 rounded-xl text-sm">
                  <RefreshCw size={14} className="inline mr-1" />
                  Refresh Status
                </button>
              </div>
            )}

            {kycStatus === 'unverified' && (
              <div className="space-y-6 animate-lift-in">
                <div className="flex items-center justify-between border-b border-border pb-4">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-brand-green/10 border border-brand-green/20 flex items-center justify-center text-brand-green">
                      <Fingerprint size={18} />
                    </div>
                    <div>
                      <h1 className="heading-display text-xl text-text-primary">Identity Verification</h1>
                      <p className="text-text-muted text-xs font-mono">Provider: {provider === 'manual' ? 'Manual Review' : 'MiniMax M3 Vision'}</p>
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-3">
                    <label className="text-xs font-semibold text-text-secondary block font-mono">Step 1: Upload ID (NID/Passport)</label>
                    {docBase64 ? (
                      <div className="border border-brand-green/30 bg-brand-green/5 rounded-xl p-4 text-center relative">
                        <div className="w-10 h-10 rounded-full bg-brand-green/10 text-brand-green flex items-center justify-center mx-auto mb-2">
                          <Check size={16} />
                        </div>
                        <p className="text-xs text-text-primary font-semibold truncate max-w-[200px] mx-auto">{docFileName || 'Document image'}</p>
                        <button onClick={() => setDocBase64(null)} className="text-[10px] text-text-muted hover:text-brand-red font-mono underline mt-1.5 block mx-auto">
                          Change
                        </button>
                      </div>
                    ) : (
                      <div className="relative border border-dashed border-border hover:border-brand-green/30 bg-surface/20 hover:bg-surface/35 transition-all rounded-xl p-6 text-center cursor-pointer group">
                        <input type="file" accept="image/*" onChange={handleDocumentChange} className="absolute inset-0 opacity-0 cursor-pointer z-10" />
                        <UploadCloud size={28} className="text-text-muted group-hover:text-brand-green mx-auto mb-2 transition-colors" />
                        <span className="text-xs font-semibold text-text-secondary block">Upload ID/Passport</span>
                        <span className="text-[9px] text-text-muted font-mono block mt-0.5">Select image</span>
                      </div>
                    )}
                  </div>

                  <div className="space-y-3">
                    <label className="text-xs font-semibold text-text-secondary block font-mono">Step 2: Face Selfie (Liveness)</label>
                    {selfieBase64 ? (
                      <div className="border border-brand-green/30 bg-brand-green/5 rounded-xl p-4 text-center relative">
                        <div className="w-12 h-12 rounded-full overflow-hidden border border-brand-green/20 mx-auto mb-2">
                          <img src={selfieBase64} alt="Captured Selfie" className="w-full h-full object-cover" />
                        </div>
                        <p className="text-xs text-brand-green font-semibold">Selfie captured</p>
                        <button onClick={() => setSelfieBase64(null)} className="text-[10px] text-text-muted hover:text-brand-red font-mono underline mt-1.5 block mx-auto">
                          Retake
                        </button>
                      </div>
                    ) : isCameraActive ? (
                      <div className="border border-border bg-void rounded-xl overflow-hidden relative flex flex-col items-center p-2">
                        <div className="w-32 h-32 rounded-full overflow-hidden border-2 border-brand-info relative bg-surface">
                          <video ref={videoRef} className="w-full h-full object-cover transform -scale-x-100" playsInline muted />
                          <div className="absolute inset-0 border border-brand-info/10 animate-pulse pointer-events-none" />
                        </div>
                        <div className="flex gap-2 w-full mt-3">
                          <button onClick={captureSelfie} className="flex-1 py-1.5 rounded-lg bg-brand-info text-void text-[11px] font-display font-semibold hover:bg-brand-info/90">
                            Capture
                          </button>
                          <button onClick={stopCamera} className="px-2 py-1.5 rounded-lg bg-surface hover:bg-surface2 border border-border text-[11px] text-text-secondary">
                            Close
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="grid grid-cols-1 gap-2">
                        <button
                          onClick={startCamera}
                          className="border border-dashed border-border hover:border-brand-info/30 bg-surface/20 hover:bg-surface/35 transition-all rounded-xl p-4 text-center flex flex-col items-center gap-1.5 group"
                        >
                          <Camera size={20} className="text-text-muted group-hover:text-brand-info transition-colors" />
                          <div>
                            <span className="text-xs font-semibold text-text-secondary block">Take live selfie</span>
                            <span className="text-[8px] text-text-muted font-mono block mt-0.5">Webcam selfie</span>
                          </div>
                        </button>
                        <div className="relative border border-dashed border-border hover:border-brand-info/30 bg-surface/10 hover:bg-surface/20 transition-all rounded-xl p-2.5 text-center flex items-center justify-center gap-2 cursor-pointer group">
                          <input type="file" accept="image/*" onChange={handleSelfieFileChange} className="absolute inset-0 opacity-0 cursor-pointer z-10" />
                          <UploadCloud size={14} className="text-text-muted group-hover:text-brand-info" />
                          <span className="text-[10px] text-text-muted font-mono">Upload selfie file (alternative)</span>
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                <div className="border-t border-border pt-4">
                  <button
                    onClick={runVerify}
                    disabled={!docBase64 || !selfieBase64}
                    className="w-full btn-brand py-3 rounded-xl font-display font-semibold flex items-center justify-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <Sparkles size={16} />
                    Verify Identity
                  </button>
                  <p className="text-center text-[10px] font-mono text-text-muted mt-2">
                    Images are processed securely and not stored permanently. Provider: {provider === 'manual' ? 'Manual review' : 'MiniMax M3 Vision'}.
                  </p>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </main>
  );
}
