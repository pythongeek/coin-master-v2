'use client';

import { useEffect } from 'react';
import { useGameStore } from '@/lib/store';

declare global {
  interface Window {
    $crisp: any[];
    CRISP_WEBSITE_ID: string;
  }
}

export default function SupportChat() {
  const { user } = useGameStore();

  // 1. Crisp Chat script loader
  useEffect(() => {
    if (typeof window === 'undefined') return;

    // If the script is already loaded, don't reload it
    if (document.getElementById('crisp-chat-script')) return;

    window.$crisp = window.$crisp || [];
    window.CRISP_WEBSITE_ID = process.env.NEXT_PUBLIC_CRISP_WEBSITE_ID || 'd3e098a5-cf3b-4c55-bfa3-94c6934c9c1b';

    const d = document;
    const s = d.createElement('script');
    s.id = 'crisp-chat-script';
    s.src = 'https://client.crisp.chat/l.js';
    s.async = true;
    
    const head = d.getElementsByTagName('head')[0];
    if (head) {
      head.appendChild(s);
    }
  }, []);

  // 2. ইউজারের অথেনটিকেশন ডাটা এবং মেটাডাটা সিঙ্ক করা
  useEffect(() => {
    if (typeof window === 'undefined' || !window.$crisp) return;

    if (user) {
      // ইউজার লগইন থাকলে Crisp-এ ডাটা পুশ করো
      window.$crisp.push(['set', 'user:nickname', [user.username]]);
      
      if (user.email) {
        window.$crisp.push(['set', 'user:email', [user.email]]);
      }
      
      // কাস্টম সেশন মেটাডাটা
      window.$crisp.push([
        'set',
        'session:data',
        [[
          ['userId', user.userId],
          ['walletAddress', user.walletAddress || 'none'],
          ['isAdmin', String(user.isAdmin)],
        ]],
      ]);
    } else {
      // Reset session on logout so prior info doesn't remain
      window.$crisp.push(['do', 'session:reset']);
    }
  }, [user]);

  return null;
}
