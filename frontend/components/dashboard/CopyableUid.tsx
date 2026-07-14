'use client';
/**
 * CopyableUid — full user UUID, click-to-copy with brief checkmark
 * confirmation. Used wherever an admin panel surfaces a user
 * (fraud feed, cluster member, alert victim, bonus audit, drill-in
 * modal). Full UID shown (not truncated) so analysts can copy/paste
 * it into other tools without truncating guesswork.
 */
import { useState } from 'react';
import { Copy, Check } from 'lucide-react';

export default function CopyableUid({
  id,
  className = '',
  truncate = 0,
}: { id: string; className?: string; truncate?: number }) {
  const [copied, setCopied] = useState(false);
  const display = truncate && id.length > truncate
    ? id.slice(0, truncate) + '…'
    : id;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(id);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // Clipboard API blocked (insecure context) — fall back to legacy.
      const ta = document.createElement('textarea');
      ta.value = id;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); setCopied(true); setTimeout(() => setCopied(false), 1200); }
      catch { /* ignore */ }
      document.body.removeChild(ta);
    }
  };

  return (
    <button
      type="button"
      onClick={copy}
      title={`Click to copy full UID: ${id}`}
      className={`group inline-flex items-center gap-1.5 font-mono text-xs bg-surface-2 hover:bg-brand-maroon/30 border border-border hover:border-brand-gold/40 rounded px-2 py-0.5 transition-colors ${className}`}
    >
      <span>{display}</span>
      {copied
        ? <Check size={12} className="text-brand-green shrink-0" />
        : <Copy size={12} className="text-text-muted group-hover:text-brand-gold shrink-0" />}
    </button>
  );
}