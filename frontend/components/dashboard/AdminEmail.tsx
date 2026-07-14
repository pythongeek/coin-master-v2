'use client';
/**
 * =============================================================
 *  ADMIN EMAIL - recipients, templates, queue, SMTP status
 * =============================================================
 *  4 sub-tabs:
 *    Recipients  - CRUD admin email addresses + per-event toggles
 *    Templates   - edit HTML/text templates for each event type
 *    Queue       - view sent/pending/failed emails + retry
 *    Settings    - SMTP status + send test email
 */

import { useEffect, useState, useCallback } from 'react';
import {
  Mail, Plus, Trash2, Save, RefreshCw, AlertCircle, CheckCircle2,
  XCircle, Loader2, Send, Eye, Edit3, X,
} from 'lucide-react';
import { getApiBase } from '@/lib/api/base';
import { useToast } from '@/components/providers/ToastProvider';

const API = getApiBase();

type SubTab = 'recipients' | 'templates' | 'queue' | 'settings';

interface Recipient {
  id: number;
  email: string;
  display_name: string | null;
  role: string;
  is_enabled: boolean;
  notify_deposit_credited: boolean;
  notify_withdrawal_critical: boolean;
  notify_withdrawal_held: boolean;
  notify_withdrawal_rejected: boolean;
  notify_withdrawal_approved: boolean;
  notify_user_kyc_approved: boolean;
  notify_system_error: boolean;
  notes: string | null;
}

interface Template {
  id: number;
  event_type: string;
  display_name: string;
  subject_template: string;
  body_html_template: string;
  body_text_template: string;
  is_enabled: boolean;
  available_variables: string[];
}

interface QueueRow {
  id: number;
  recipient: string;
  recipient_kind: string;
  event_type: string;
  subject: string;
  status: 'pending' | 'sending' | 'sent' | 'failed' | 'cancelled';
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  last_attempt_at: string | null;
  next_attempt_at: string;
  sent_at: string | null;
  created_at: string;
}

interface SmtpStatus {
  configured: boolean;
  host?: string;
  port?: number;
  fromAddress?: string;
  fromName?: string;
  auth?: string;
  message?: string;
}

const TOOLTIPS: Record<string, string> = {
  notify_deposit_credited: 'Customer receives this when a deposit is credited',
  notify_withdrawal_critical: 'Admin gets alerted when a withdrawal scores high/critical risk',
  notify_withdrawal_held: 'Admin gets alerted when a withdrawal needs manual review',
  notify_withdrawal_rejected: 'Customer receives this when withdrawal is rejected',
  notify_withdrawal_approved: 'Customer receives this when withdrawal is approved',
  notify_user_kyc_approved: 'Customer receives this when KYC is approved',
  notify_system_error: 'Admin gets critical system errors',
};

export default function AdminEmail() {
  const [subTab, setSubTab] = useState<SubTab>('recipients');
  const { addToast } = useToast();
  const token = typeof window !== 'undefined' ? localStorage.getItem('cf_token') : '';
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Mail size={20} className="text-text-primary" />
        <h2 className="text-lg font-mono text-text-primary">Email Notifications</h2>
      </div>

      {/* Sub-tabs */}
      <div className="flex gap-2 border-b border-border pb-2">
        {([
          { id: 'recipients', label: 'Recipients' },
          { id: 'templates', label: 'Templates' },
          { id: 'queue', label: 'Queue' },
          { id: 'settings', label: 'Settings' },
        ] as { id: SubTab; label: string }[]).map((t) => (
          <button
            key={t.id}
            onClick={() => setSubTab(t.id)}
            className={`px-3 py-1.5 rounded text-xs font-mono transition ${
              subTab === t.id
                ? 'bg-brand-green/20 text-brand-green border border-brand-green/40'
                : 'text-text-muted hover:text-text-primary border border-transparent'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {subTab === 'recipients' && <RecipientsTab headers={headers} addToast={addToast} />}
      {subTab === 'templates' && <TemplatesTab headers={headers} addToast={addToast} />}
      {subTab === 'queue' && <QueueTab headers={headers} addToast={addToast} />}
      {subTab === 'settings' && <SettingsTab headers={headers} addToast={addToast} />}
    </div>
  );
}

// =============================================================
//  RECIPIENTS TAB
// =============================================================

function RecipientsTab({ headers, addToast }: any) {
  const [items, setItems] = useState<Recipient[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Partial<Recipient> | null>(null);
  const [showNew, setShowNew] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${API}/admin/email/recipients`, { headers });
      const j = await r.json();
      if (j.success) setItems(j.recipients);
    } catch (e: unknown) {
      addToast(`Load failed: ${(e as Error).message}`, 'error');
    }
    setLoading(false);
  }, [headers, addToast]);

  useEffect(() => { load(); }, [load]);

  async function save() {
    if (!editing || !editing.email) return;
    try {
      const method = editing.id ? 'PATCH' : 'POST';
      const url = editing.id
        ? `${API}/admin/email/recipients/${editing.id}`
        : `${API}/admin/email/recipients`;
      const r = await fetch(url, { method, headers, body: JSON.stringify(editing) });
      const j = await r.json();
      if (j.success) {
        addToast(`Recipient ${method === 'POST' ? 'added' : 'updated'}`, 'success');
        setEditing(null);
        setShowNew(false);
        load();
      } else {
        addToast(j.error || 'Save failed', 'error');
      }
    } catch (e: unknown) {
      addToast(`Save error: ${(e as Error).message}`, 'error');
    }
  }

  async function remove(id: number) {
    if (!confirm('Delete this recipient? Emails will no longer be sent to this address.')) return;
    try {
      const r = await fetch(`${API}/admin/email/recipients/${id}`, { method: 'DELETE', headers });
      const j = await r.json();
      if (j.success) { addToast('Deleted', 'success'); load(); }
      else addToast(j.error || 'Delete failed', 'error');
    } catch (e: unknown) {
      addToast(`Delete error: ${(e as Error).message}`, 'error');
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex justify-between items-center">
        <p className="text-xs text-text-muted font-mono">
          Admin email recipients. Each can opt into specific event types independently.
        </p>
        <button
          onClick={() => { setEditing({ is_enabled: true, role: 'admin' }); setShowNew(true); }}
          className="flex items-center gap-1 px-3 py-1.5 rounded bg-brand-green/20 text-brand-green hover:bg-brand-green/30 text-xs font-mono"
        >
          <Plus size={14} /> Add recipient
        </button>
      </div>

      {showNew && (
        <RecipientEditor
          recipient={editing}
          onChange={setEditing}
          onSave={save}
          onCancel={() => { setShowNew(false); setEditing(null); }}
        />
      )}

      {loading ? (
        <p className="text-sm text-text-muted font-mono">Loading...</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-text-muted font-mono p-4 text-center bg-bg-elevated rounded">
          No recipients yet. Click "Add recipient" to get started.
        </p>
      ) : (
        <div className="space-y-2">
          {items.map((r) => (
            <RecipientCard key={r.id} recipient={r} onEdit={() => setEditing(r)} onDelete={() => remove(r.id)} />
          ))}
        </div>
      )}
    </div>
  );
}

function RecipientCard({ recipient: r, onEdit, onDelete }: any) {
  const toggleCols: (keyof Recipient)[] = [
    'notify_deposit_credited', 'notify_withdrawal_critical', 'notify_withdrawal_held',
    'notify_withdrawal_rejected', 'notify_withdrawal_approved',
    'notify_user_kyc_approved', 'notify_system_error',
  ];
  return (
    <div className={`glass-card p-4 rounded-xl ${!r.is_enabled ? 'opacity-50' : ''}`}>
      <div className="flex items-start justify-between gap-2 mb-2">
        <div>
          <div className="text-text-primary font-mono">{r.email}</div>
          <div className="text-xs text-text-muted font-mono">
            {r.display_name || '(no name)'} · role: {r.role} {r.is_enabled ? '· enabled' : '· DISABLED'}
          </div>
          {r.notes && <div className="text-xs text-text-muted mt-1">{r.notes}</div>}
        </div>
        <div className="flex gap-1">
          <button onClick={onEdit} className="p-1.5 rounded hover:bg-bg-elevated text-text-muted" title="Edit">
            <Edit3 size={14} />
          </button>
          <button onClick={onDelete} className="p-1.5 rounded hover:bg-red-500/20 text-red-400" title="Delete">
            <Trash2 size={14} />
          </button>
        </div>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-[10px] font-mono">
        {toggleCols.map((col) => (
          <div key={col} className={`flex items-center gap-1 ${r[col] ? 'text-brand-green' : 'text-text-muted'}`} title={TOOLTIPS[col]}>
            {r[col] ? <CheckCircle2 size={10} /> : <XCircle size={10} />}
            <span className="truncate">{col.replace('notify_', '').replace(/_/g, ' ')}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function RecipientEditor({ recipient, onChange, onSave, onCancel }: any) {
  if (!recipient) return null;
  const toggleCols: (keyof Recipient)[] = [
    'notify_deposit_credited', 'notify_withdrawal_critical', 'notify_withdrawal_held',
    'notify_withdrawal_rejected', 'notify_withdrawal_approved',
    'notify_user_kyc_approved', 'notify_system_error',
  ];
  return (
    <div className="glass-card p-4 rounded-xl border border-brand-green/40">
      <h3 className="text-text-primary font-mono mb-3">{recipient.id ? 'Edit recipient' : 'New recipient'}</h3>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">
        <div>
          <label className="block text-xs text-text-muted font-mono mb-1">Email *</label>
          <input
            type="email"
            value={recipient.email || ''}
            onChange={(e) => onChange({ ...recipient, email: e.target.value })}
            className="w-full px-3 py-2 bg-bg-elevated border border-border-default rounded font-mono text-sm text-text-primary"
          />
        </div>
        <div>
          <label className="block text-xs text-text-muted font-mono mb-1">Display name</label>
          <input
            type="text"
            value={recipient.display_name || ''}
            onChange={(e) => onChange({ ...recipient, display_name: e.target.value })}
            className="w-full px-3 py-2 bg-bg-elevated border border-border-default rounded font-mono text-sm text-text-primary"
          />
        </div>
        <div>
          <label className="block text-xs text-text-muted font-mono mb-1">Role</label>
          <select
            value={recipient.role || 'admin'}
            onChange={(e) => onChange({ ...recipient, role: e.target.value })}
            className="w-full px-3 py-2 bg-bg-elevated border border-border-default rounded font-mono text-sm text-text-primary"
          >
            <option value="admin">admin</option>
            <option value="super_admin">super_admin</option>
            <option value="finance">finance</option>
            <option value="fraud_ops">fraud_ops</option>
          </select>
        </div>
        <div>
          <label className="block text-xs text-text-muted font-mono mb-1">Notes</label>
          <input
            type="text"
            value={recipient.notes || ''}
            onChange={(e) => onChange({ ...recipient, notes: e.target.value })}
            className="w-full px-3 py-2 bg-bg-elevated border border-border-default rounded font-mono text-sm text-text-primary"
          />
        </div>
      </div>
      <div className="mb-3">
        <label className="block text-xs text-text-muted font-mono mb-2">Event notifications</label>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          {toggleCols.map((col) => (
            <label key={col} className="flex items-center gap-2 text-xs font-mono text-text-primary cursor-pointer" title={TOOLTIPS[col]}>
              <input
                type="checkbox"
                checked={!!recipient[col]}
                onChange={(e) => onChange({ ...recipient, [col]: e.target.checked })}
              />
              <span>{col.replace('notify_', '').replace(/_/g, ' ')}</span>
            </label>
          ))}
        </div>
      </div>
      <div className="flex gap-2 justify-end">
        <label className="flex items-center gap-2 text-xs font-mono text-text-primary">
          <input
            type="checkbox"
            checked={recipient.is_enabled !== false}
            onChange={(e) => onChange({ ...recipient, is_enabled: e.target.checked })}
          />
          Enabled
        </label>
        <button onClick={onCancel} className="px-3 py-1.5 rounded text-xs text-text-muted hover:text-text-primary font-mono">
          Cancel
        </button>
        <button onClick={onSave} className="flex items-center gap-1 px-3 py-1.5 rounded bg-brand-green/20 text-brand-green hover:bg-brand-green/30 text-xs font-mono">
          <Save size={14} /> Save
        </button>
      </div>
    </div>
  );
}

// =============================================================
//  TEMPLATES TAB
// =============================================================

function TemplatesTab({ headers, addToast }: any) {
  const [items, setItems] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Template | null>(null);
  const [preview, setPreview] = useState<{ subject: string; body_html: string; body_text: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${API}/admin/email/templates`, { headers });
      const j = await r.json();
      if (j.success) setItems(j.templates);
    } catch (e: unknown) {
      addToast(`Load failed: ${(e as Error).message}`, 'error');
    }
    setLoading(false);
  }, [headers, addToast]);

  useEffect(() => { load(); }, [load]);

  async function save() {
    if (!editing) return;
    try {
      const r = await fetch(`${API}/admin/email/templates/${editing.event_type}`, {
        method: 'PATCH', headers, body: JSON.stringify(editing),
      });
      const j = await r.json();
      if (j.success) { addToast('Template saved', 'success'); setEditing(null); load(); }
      else addToast(j.error || 'Save failed', 'error');
    } catch (e: unknown) {
      addToast(`Save error: ${(e as Error).message}`, 'error');
    }
  }

  async function doPreview(tpl: Template) {
    const sampleContext: Record<string, any> = {};
    tpl.available_variables.forEach((v) => {
      if (v === 'amount_usdt' || v === 'amount_usd' || v === 'amount_bdt') sampleContext[v] = '123.45';
      else if (v === 'username') sampleContext[v] = 'sample_user';
      else if (v === 'risk_score') sampleContext[v] = '85';
      else if (v === 'risk_level') sampleContext[v] = 'critical';
      else if (v === 'risk_suggestion') sampleContext[v] = 'manual_review_required';
      else if (v === 'chain') sampleContext[v] = 'BSC';
      else if (v === 'chain_full') sampleContext[v] = 'BNB Smart Chain';
      else if (v === 'tx_hash') sampleContext[v] = '0xabc123...';
      else if (v === 'admin_url') sampleContext[v] = 'http://46.62.247.167:3002/admin';
      else if (v === 'risk_reasons') sampleContext[v] = '- large amount\n- new account';
      else sampleContext[v] = `[${v}]`;
    });
    try {
      const r = await fetch(`${API}/admin/email/templates/${tpl.event_type}/preview`, {
        method: 'POST', headers, body: JSON.stringify({ context: sampleContext }),
      });
      const j = await r.json();
      if (j.success) setPreview(j.preview);
      else addToast(j.error || 'Preview failed', 'error');
    } catch (e: unknown) {
      addToast(`Preview error: ${(e as Error).message}`, 'error');
    }
  }

  if (editing) {
    return (
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-text-primary font-mono">{editing.event_type}</h3>
          <button onClick={() => setEditing(null)} className="text-text-muted hover:text-text-primary p-1">
            <X size={18} />
          </button>
        </div>
        <div>
          <label className="block text-xs text-text-muted font-mono mb-1">Subject</label>
          <input
            value={editing.subject_template}
            onChange={(e) => setEditing({ ...editing, subject_template: e.target.value })}
            className="w-full px-3 py-2 bg-bg-elevated border border-border-default rounded font-mono text-sm text-text-primary"
          />
        </div>
        <div>
          <label className="block text-xs text-text-muted font-mono mb-1">
            HTML body · variables: {editing.available_variables.map((v) => `{{${v}}}`).join(' ')}
          </label>
          <textarea
            value={editing.body_html_template}
            onChange={(e) => setEditing({ ...editing, body_html_template: e.target.value })}
            rows={12}
            className="w-full px-3 py-2 bg-bg-elevated border border-border-default rounded font-mono text-xs text-text-primary"
          />
        </div>
        <div>
          <label className="block text-xs text-text-muted font-mono mb-1">Text body</label>
          <textarea
            value={editing.body_text_template}
            onChange={(e) => setEditing({ ...editing, body_text_template: e.target.value })}
            rows={8}
            className="w-full px-3 py-2 bg-bg-elevated border border-border-default rounded font-mono text-xs text-text-primary"
          />
        </div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-2 text-xs font-mono text-text-primary">
            <input
              type="checkbox"
              checked={editing.is_enabled}
              onChange={(e) => setEditing({ ...editing, is_enabled: e.target.checked })}
            />
            Enabled
          </label>
        </div>
        <div className="flex justify-end gap-2">
          <button onClick={() => doPreview(editing)} className="flex items-center gap-1 px-3 py-1.5 rounded bg-bg-elevated text-text-primary hover:bg-bg-elevated/70 text-xs font-mono">
            <Eye size={14} /> Preview
          </button>
          <button onClick={save} className="flex items-center gap-1 px-3 py-1.5 rounded bg-brand-green/20 text-brand-green hover:bg-brand-green/30 text-xs font-mono">
            <Save size={14} /> Save
          </button>
        </div>
        {preview && (
          <div className="glass-card p-4 rounded-xl">
            <h4 className="text-xs text-text-muted font-mono mb-2">Preview (with sample data)</h4>
            <div className="text-xs text-text-primary font-mono mb-2">Subject: {preview.subject}</div>
            <iframe
              srcDoc={preview.body_html}
              title="preview"
              className="w-full h-96 bg-white rounded"
            />
            <pre className="mt-2 p-2 bg-bg-elevated rounded text-xs font-mono text-text-secondary whitespace-pre-wrap">{preview.body_text}</pre>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-text-muted font-mono mb-2">
        HTML + text templates per event type. Variables use {`{{var_name}}`} syntax.
      </p>
      {loading ? <p className="text-sm text-text-muted">Loading...</p> : items.map((t) => (
        <div key={t.id} className={`glass-card p-3 rounded-xl flex items-center justify-between ${!t.is_enabled ? 'opacity-50' : ''}`}>
          <div>
            <div className="text-text-primary font-mono">{t.event_type}</div>
            <div className="text-xs text-text-muted font-mono">{t.display_name} · {t.is_enabled ? 'enabled' : 'DISABLED'}</div>
          </div>
          <button onClick={() => setEditing(t)} className="flex items-center gap-1 px-3 py-1.5 rounded bg-bg-elevated text-text-primary hover:bg-bg-elevated/70 text-xs font-mono">
            <Edit3 size={14} /> Edit
          </button>
        </div>
      ))}
    </div>
  );
}

// =============================================================
//  QUEUE TAB
// =============================================================

function QueueTab({ headers, addToast }: any) {
  const [items, setItems] = useState<QueueRow[]>([]);
  const [stats, setStats] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<string>('all');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${API}/admin/email/queue?status=${statusFilter}&limit=200`, { headers });
      const j = await r.json();
      if (j.success) {
        setItems(j.queue);
        const map: Record<string, number> = {};
        j.stats.forEach((s: any) => { map[s.status] = parseInt(s.count); });
        setStats(map);
      }
    } catch (e: unknown) {
      addToast(`Load failed: ${(e as Error).message}`, 'error');
    }
    setLoading(false);
  }, [statusFilter, headers, addToast]);

  useEffect(() => { load(); }, [load]);

  async function retry(id: number) {
    try {
      const r = await fetch(`${API}/admin/email/queue/${id}/retry`, { method: 'POST', headers });
      const j = await r.json();
      if (j.success) { addToast('Retry queued', 'success'); load(); }
      else addToast(j.error || 'Retry failed', 'error');
    } catch (e: unknown) {
      addToast(`Error: ${(e as Error).message}`, 'error');
    }
  }

  async function drain() {
    try {
      const r = await fetch(`${API}/admin/email/queue/drain`, { method: 'POST', headers });
      const j = await r.json();
      if (j.success) addToast(`Drain: sent=${j.sent} failed=${j.failed} skipped=${j.skipped}`, 'success');
      load();
    } catch (e: unknown) {
      addToast(`Error: ${(e as Error).message}`, 'error');
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex gap-2">
          {(['all', 'pending', 'sent', 'failed', 'sending'] as const).map((s) => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className={`px-3 py-1 rounded text-xs font-mono border ${
                statusFilter === s
                  ? 'bg-brand-green/20 text-brand-green border-brand-green/40'
                  : 'border-border text-text-muted hover:text-text-primary'
              }`}
            >
              {s} {stats[s] ? `(${stats[s]})` : ''}
            </button>
          ))}
        </div>
        <div className="ml-auto flex gap-2">
          <button onClick={drain} className="px-3 py-1.5 rounded text-xs font-mono bg-bg-elevated text-text-primary hover:bg-bg-elevated/70">
            Drain now
          </button>
          <button onClick={load} className="p-1.5 rounded hover:bg-bg-elevated text-text-muted">
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {loading ? (
        <p className="text-sm text-text-muted">Loading...</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-text-muted p-4 text-center bg-bg-elevated rounded">No emails in queue.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs font-mono">
            <thead>
              <tr className="border-b border-border text-text-muted text-left">
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Recipient</th>
                <th className="px-3 py-2">Event</th>
                <th className="px-3 py-2">Subject</th>
                <th className="px-3 py-2">Attempts</th>
                <th className="px-3 py-2">Next / Sent</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {items.map((q) => (
                <tr key={q.id} className="border-b border-border/50 hover:bg-bg-elevated/30">
                  <td className="px-3 py-2">
                    <span className={`px-2 py-0.5 rounded text-[10px] ${
                      q.status === 'sent' ? 'bg-brand-green/20 text-brand-green' :
                      q.status === 'failed' ? 'bg-red-500/20 text-red-400' :
                      q.status === 'sending' ? 'bg-blue-500/20 text-blue-400' :
                      q.status === 'pending' ? 'bg-amber-500/20 text-amber-400' :
                      'bg-text-muted/20 text-text-muted'
                    }`}>{q.status}</span>
                  </td>
                  <td className="px-3 py-2 text-text-primary">{q.recipient}</td>
                  <td className="px-3 py-2 text-text-secondary">{q.event_type}</td>
                  <td className="px-3 py-2 text-text-secondary max-w-xs truncate" title={q.subject}>{q.subject}</td>
                  <td className="px-3 py-2 text-text-muted">{q.attempts}/{q.max_attempts}</td>
                  <td className="px-3 py-2 text-text-muted text-[10px]">
                    {q.status === 'sent' && q.sent_at ? `sent ${new Date(q.sent_at).toLocaleString()}` :
                     q.next_attempt_at ? `next ${new Date(q.next_attempt_at).toLocaleString()}` : '-'}
                  </td>
                  <td className="px-3 py-2">
                    {q.status === 'failed' && (
                      <button onClick={() => retry(q.id)} className="text-[10px] px-2 py-0.5 rounded bg-amber-500/20 text-amber-400 hover:bg-amber-500/30">
                        Retry
                      </button>
                    )}
                    {q.last_error && (
                      <span className="ml-2 text-[10px] text-red-400" title={q.last_error}>
                        ⚠
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// =============================================================
//  SETTINGS TAB - SMTP status + test email
// =============================================================

function SettingsTab({ headers, addToast }: any) {
  const [status, setStatus] = useState<SmtpStatus | null>(null);
  const [testEmail, setTestEmail] = useState('');
  const [sending, setSending] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`${API}/admin/email/smtp-status`, { headers });
      const j = await r.json();
      if (j.success) setStatus(j);
    } catch (e: unknown) {
      addToast(`Load failed: ${(e as Error).message}`, 'error');
    }
  }, [headers, addToast]);

  useEffect(() => { load(); }, [load]);

  async function sendTest() {
    if (!testEmail.includes('@')) {
      addToast('Valid email required', 'error');
      return;
    }
    setSending(true);
    try {
      const r = await fetch(`${API}/admin/email/test`, {
        method: 'POST', headers, body: JSON.stringify({ recipient: testEmail }),
      });
      const j = await r.json();
      if (j.success) addToast(`Test sent to ${testEmail}`, 'success');
      else addToast(j.error || 'Test failed', 'error');
    } catch (e: unknown) {
      addToast(`Error: ${(e as Error).message}`, 'error');
    }
    setSending(false);
  }

  return (
    <div className="space-y-4">
      <div className="glass-card p-4 rounded-xl">
        <h3 className="text-text-primary font-mono mb-2">SMTP Status</h3>
        {!status ? (
          <Loader2 size={16} className="animate-spin text-text-muted" />
        ) : status.configured ? (
          <div className="text-xs font-mono text-text-secondary space-y-1">
            <div>Host: <span className="text-text-primary">{status.host}</span>:<span className="text-text-primary">{status.port}</span> {status.auth === 'configured' ? '(authenticated)' : '(no auth)'}</div>
            <div>From: <span className="text-text-primary">{status.fromName} &lt;{status.fromAddress}&gt;</span></div>
            <div className="text-brand-green flex items-center gap-1 mt-2"><CheckCircle2 size={12} /> Ready to send</div>
          </div>
        ) : (
          <div className="text-xs font-mono text-text-secondary">
            <p>{status.message || 'SMTP not configured'}</p>
            <p className="mt-2 text-text-muted">Set SMTP_HOST in /root/coin-master/.env and restart backend to enable sending.</p>
          </div>
        )}
      </div>

      <div className="glass-card p-4 rounded-xl">
        <h3 className="text-text-primary font-mono mb-2">Send test email</h3>
        <p className="text-xs text-text-muted font-mono mb-2">Verifies SMTP connectivity. Bypasses templates + recipient config.</p>
        <div className="flex gap-2">
          <input
            type="email"
            placeholder="recipient@example.com"
            value={testEmail}
            onChange={(e) => setTestEmail(e.target.value)}
            className="flex-1 px-3 py-2 bg-bg-elevated border border-border-default rounded font-mono text-sm text-text-primary"
          />
          <button
            onClick={sendTest}
            disabled={sending || !status?.configured}
            className="flex items-center gap-1 px-3 py-2 rounded bg-brand-green/20 text-brand-green hover:bg-brand-green/30 text-xs font-mono disabled:opacity-50"
          >
            {sending ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
            Send test
          </button>
        </div>
      </div>
    </div>
  );
}
