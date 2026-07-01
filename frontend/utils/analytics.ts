'use client';

/**
 * ═══════════════════════════════════════════════════════════════
 *  ANALYTICS UTILITY — তৃতীয়-পক্ষ ট্র্যাকিং ইন্টিগ্রেশন
 * ═══════════════════════════════════════════════════════════════
 *  গ্লোবাল ট্র্যাকার যা একসাথে নিচের প্ল্যাটফর্মগুলোতে ইভেন্ট পাঠায়:
 *  ① Google Analytics 4 (GA4) / Google Tag
 *  ② Mixpanel (কনভার্সন ও ড্রপ-অফ অ্যানালিটিক্স)
 *  ③ Microsoft Clarity (হিটম্যাপ ও সেশন রেকর্ডিং ইভেন্ট)
 * ═══════════════════════════════════════════════════════════════
 */

declare global {
  interface Window {
    gtag?: (...args: any[]) => void;
    mixpanel?: {
      track: (name: string, props?: any) => void;
      identify: (id: string) => void;
      people: {
        set: (props: any) => void;
      };
      reset: () => void;
    };
    clarity?: (...args: any[]) => void;
  }
}

/**
 * যেকোনো কনভার্সন বা ড্রপ-অফ ইভেন্ট ট্র্যাক করতে এই ফাংশন ব্যবহার করুন
 */
export function trackEvent(eventName: string, properties?: Record<string, any>) {
  if (typeof window === 'undefined') return;

  // ১. Google Analytics 4 (GA4) / Google Tag
  if (window.gtag) {
    try {
      window.gtag('event', eventName, properties);
    } catch (e) {
      console.warn('GA4 track event error:', e);
    }
  }

  // ২. Mixpanel
  if (window.mixpanel) {
    try {
      window.mixpanel.track(eventName, properties);
    } catch (e) {
      console.warn('Mixpanel track event error:', e);
    }
  }

  // ৩. Microsoft Clarity Custom Events
  if (window.clarity) {
    try {
      window.clarity('event', eventName);
    } catch (e) {
      console.warn('Clarity track event error:', e);
    }
  }
}

/**
 * লগইন করা ইউজারের আইডেন্টিটি সিঙ্ক করা
 */
export function identifyUser(userId: string, traits?: Record<string, any>) {
  if (typeof window === 'undefined') return;

  // Mixpanel user identify
  if (window.mixpanel) {
    try {
      window.mixpanel.identify(userId);
      if (traits) {
        window.mixpanel.people.set(traits);
      }
    } catch (e) {
      console.warn('Mixpanel identify error:', e);
    }
  }

  // Google Analytics User ID config
  if (window.gtag) {
    try {
      const gaId = process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID || 'G-XXXXXXXXXX';
      window.gtag('config', gaId, {
        user_id: userId,
      });
    } catch (e) {
      console.warn('GA4 user config error:', e);
    }
  }

  // Microsoft Clarity user identification
  if (window.clarity && traits?.username) {
    try {
      window.clarity('identify', userId, traits.username);
    } catch (e) {
      console.warn('Clarity identify error:', e);
    }
  }
}

/**
 * ইউজার লগআউট করলে সেশন রিসেট করা
 */
export function resetSession() {
  if (typeof window === 'undefined') return;

  if (window.mixpanel) {
    try {
      window.mixpanel.reset();
    } catch (e) {
      console.warn('Mixpanel reset error:', e);
    }
  }
}
