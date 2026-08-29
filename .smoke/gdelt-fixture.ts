import { readFileSync } from 'node:fs';
import { createGdeltProvider } from '../packages/server/src/providers/trends/gdelt.js';

const tl = readFileSync(new URL('./tl2.json', import.meta.url), 'utf8');
const al = readFileSync(new URL('./al.json', import.meta.url), 'utf8');
const throttle = readFileSync(new URL('./tl.json', import.meta.url), 'utf8');

let mode: 'live' | 'throttle' = 'live';
const seen: string[] = [];
globalThis.fetch = (async (url: any) => {
  const u = String(url);
  seen.push(u);
  const body = mode === 'throttle' ? throttle : u.includes('mode=timelinevol') ? tl : al;
  return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

const p = createGdeltProvider({ seedTerms: ['climate', 'artificial intelligence'], maxDiscoverTerms: 2 });

const m = await p.measure!('climate change', {});
console.log('URL issued:', seen[0]);
console.log('measure ->', {
  externalId: m?.externalId, title: m?.title, rawValue: m?.rawValue,
  historyPoints: m?.history?.length, stage: m?.sourceStage,
  engagement: m?.engagement, audience: m?.audience,
});
console.log('summary ->', m?.summary?.slice(0, 90));
console.log('metadata ->', m?.metadata);

const d = await p.discover({ limit: 5 });
console.log('discover ->', d.length, d.map((s) => s.externalId));

mode = 'throttle';
const p2 = createGdeltProvider({ seedTerms: ['climate'] });
console.log('throttled measure ->', await p2.measure!('climate', {}));
console.log('throttled health ->', (await p2.healthCheck()).state);

const p3 = createGdeltProvider({});
console.log('no-seed discover ->', await p3.discover({ limit: 5 }));
