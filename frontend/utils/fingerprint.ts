/**
 * ═══════════════════════════════════════════════════════════════
 *  BROWSER FINGERPRINT GENERATOR — ক্লায়েন্ট-সাইড আইডেন্টিফিকেশন
 * ═══════════════════════════════════════════════════════════════
 *
 *  ইউজারের ব্রাউজার প্যারামিটার (userAgent, language, screen size)
 *  ব্যবহার করে একটি ইউনিক SHA-256 হ্যাশ তৈরি করে যা মাল্টি-অ্যাকাউন্ট
 *  প্রতারণা বা বোনাস অ্যাবিউজ সনাক্ত করতে সাহায্য করে।
 * ═══════════════════════════════════════════════════════════════
 */

/**
 * SHA-256 hash helper using Web Crypto API
 */
async function sha256(str: string): Promise<string> {
  try {
    const msgBuffer = new TextEncoder().encode(str);
    const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  } catch (err) {
    // Fallback simple hash calculation if Web Crypto is unavailable (e.g. non-secure domains)
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return `fb_${Math.abs(hash).toString(16)}`;
  }
}

/**
 * Generates a stable browser fingerprint hash
 */
export async function getBrowserFingerprint(): Promise<string> {
  if (typeof window === 'undefined') {
    return 'server_environment';
  }

  const parts = [
    window.navigator.userAgent || '',
    window.navigator.language || '',
    String(window.screen.colorDepth || ''),
    String(window.screen.width || ''),
    String(window.screen.height || ''),
    String(new Date().getTimezoneOffset()),
    String(window.navigator.hardwareConcurrency || ''),
    // Canvas fingerprinting fallback
    getCanvasFingerprint()
  ];

  const rawFingerprint = parts.join(':::');
  return await sha256(rawFingerprint);
}

/**
 * Canvas fingerprinting helper
 */
function getCanvasFingerprint(): string {
  try {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) return 'no_canvas';

    ctx.textBaseline = 'top';
    ctx.font = "14px 'Arial'";
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#f60';
    ctx.fillRect(125, 1, 62, 20);
    ctx.fillStyle = '#069';
    ctx.fillText('CryptoFlip, Casino! 🎰', 2, 15);
    ctx.fillStyle = 'rgba(102, 204, 0, 0.7)';
    ctx.fillText('CryptoFlip, Casino! 🎰', 4, 17);

    return canvas.toDataURL();
  } catch (e) {
    return 'canvas_error';
  }
}
