import { getConfig } from './admin-config';

/**
 * ═══════════════════════════════════════════════════════════════
 *  KYC SANCTIONS — Free open-source screening via OpenSanctions
 * ═══════════════════════════════════════════════════════════════
 *
 *  OpenSanctions provides a free, rate-limited search API. We use it
 *  as a coarse signal only. Matches are adjudicated by the MiniMax
 *  agent and the local risk engine.
 */

export interface SanctionsScreeningResult {
  success: boolean;
  entity_name: string;
  matches: Array<{
    name: string;
    schema: string;
    countries: string[];
    topics: string[];
    score: number;
  }>;
  error?: string;
}

export async function screenAgainstSanctions(
  fullName: string,
  birthDate?: string,
): Promise<SanctionsScreeningResult> {
  if (!fullName || fullName.trim().length < 3) {
    return { success: true, entity_name: fullName, matches: [] };
  }

  try {
    const url = new URL('https://api.opensanctions.org/search/');
    url.searchParams.set('q', fullName.trim());
    if (birthDate) url.searchParams.set('birthdate', birthDate);
    url.searchParams.set('limit', '5');

    const res = await fetch(url.toString(), {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
    });

    if (!res.ok) {
      throw new Error(`OpenSanctions HTTP ${res.status}`);
    }

    const data = (await res.json()) as any;
    const results = Array.isArray(data.results) ? data.results : [];

    const matches = results.map((r: any) => ({
      name: r.caption || r.name || fullName,
      schema: r.schema || 'Person',
      countries: r.countries || [],
      topics: r.topics || [],
      score: r.score || 0,
    }));

    return {
      success: true,
      entity_name: fullName,
      matches,
    };
  } catch (err) {
    return {
      success: false,
      entity_name: fullName,
      matches: [],
      error: err instanceof Error ? err.message : 'unknown',
    };
  }
}

export function sanctionsRiskFromMatches(matches: SanctionsScreeningResult['matches']): 'low' | 'medium' | 'high' {
  const highScore = matches.some((m) => m.score >= 0.85 && m.topics.some((t) => /sanction|crime|terror/i.test(t)));
  const mediumScore = matches.some((m) => m.score >= 0.6);

  if (highScore) return 'high';
  if (mediumScore) return 'medium';
  return 'low';
}
