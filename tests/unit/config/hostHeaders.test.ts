// Coordinator-owned. The E2E suite tests the headers that `vite preview` serves
// (`securityHeaders`). This guards the production host config against drifting from them.
import { describe, expect, it } from 'vitest';
import { securityHeaders } from '../../../vite.config';
import vercel from '../../../vercel.json';

type HeaderRule = { source: string; headers: { key: string; value: string }[] };
const rules = vercel.headers as HeaderRule[];

function headersFor(source: string): Record<string, string> {
  const rule = rules.find((r) => r.source === source);
  if (!rule) throw new Error(`no header rule for ${source}`);
  return Object.fromEntries(rule.headers.map((h) => [h.key, h.value]));
}

describe('A16 host security headers (vercel.json)', () => {
  const all = headersFor('/(.*)');

  it('applies every tested security header, byte for byte, to every path', () => {
    for (const [key, value] of Object.entries(securityHeaders)) {
      expect(all[key], key).toBe(value);
    }
  });

  it('adds HSTS on the real HTTPS origin', () => {
    expect(all['Strict-Transport-Security']).toMatch(/^max-age=\d{8,}; includeSubDomains$/);
  });

  it('never allows unsafe-inline or unsafe-eval', () => {
    expect(all['Content-Security-Policy']).not.toMatch(/unsafe-(inline|eval)/);
  });

  it('revalidates the page but caches fingerprinted assets for a year', () => {
    expect(headersFor('/(index.html)?')['Cache-Control']).toBe('no-cache');
    expect(headersFor('/assets/(.*)')['Cache-Control']).toBe('public, max-age=31536000, immutable');
  });
});
