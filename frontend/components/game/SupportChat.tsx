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

  // 1. Crisp Chat স্ক্রিপ্ট লোডার
  useEffect(() => {
    if (typeof window === 'undefined') return;

    // যদি ইতিমধ্যে স্ক্রিপ্ট লোড করা থাকে, আবার লোড করার দরকার নেই
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
      // ইউজার লগআউট করলে সেশন রিসেট করো যেন আগের তথ্য না থাকে
      window.$crisp.push(['do', 'session:reset']);
    }
  }, [user]);

  return null;
}
