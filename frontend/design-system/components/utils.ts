/**
 * ═══════════════════════════════════════════════════════════════
 *  cn() — className utility
 * ═══════════════════════════════════════════════════════════════
 *
 *  Tiny className combinator: filters out falsy values, joins with spaces.
 *  Use this everywhere you compose Tailwind classes conditionally:
 *
 *    <div className={cn('base', isActive && 'active', className)} />
 *
 *  Equivalent to the popular `clsx`/`classnames` packages but 0-dep.
 * ═══════════════════════════════════════════════════════════════
 */

export type ClassValue =
  | string
  | number
  | null
  | false
  | undefined
  | ClassValue[]
  | { [key: string]: boolean | null | undefined };

export function cn(...inputs: ClassValue[]): string {
  const out: string[] = [];
  const walk = (v: ClassValue) => {
    if (!v) return;
    if (typeof v === 'string' || typeof v === 'number') {
      out.push(String(v));
    } else if (Array.isArray(v)) {
      v.forEach(walk);
    } else if (typeof v === 'object') {
      for (const [k, val] of Object.entries(v)) {
        if (val) out.push(k);
      }
    }
  };
  inputs.forEach(walk);
  return out.join(' ');
}