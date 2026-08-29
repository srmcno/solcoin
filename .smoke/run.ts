import { ProxyAgent, setGlobalDispatcher } from 'undici';
setGlobalDispatcher(new ProxyAgent(process.env.HTTPS_PROXY!));
import { createHackerNewsProvider } from '../packages/server/src/providers/trends/hackernews.js';
import { createGdeltProvider } from '../packages/server/src/providers/trends/gdelt.js';
import { createStackExchangeProvider } from '../packages/server/src/providers/trends/stackexchange.js';

const brief = (s: any) => ({
  externalId: s.externalId, title: s.title.slice(0, 55), rawValue: Number(s.rawValue.toFixed(3)),
  eng: s.engagement === undefined ? undefined : Number(s.engagement.toFixed(3)),
  rank: s.rank, stage: s.sourceStage, cat: s.category, hist: s.history?.length,
  pts: s.metadata?.points ?? s.metadata?.views,
});

const which = process.argv[2];

if (which === 'hn') {
  const p = createHackerNewsProvider({});
  console.log('health', await p.healthCheck());
  const d = await p.discover({ limit: 6 });
  console.log('discover', d.length); d.slice(0, 5).forEach((s) => console.log(' ', brief(s)));
  console.log('measure', brief((await p.measure!('rust', {}))!));
}

if (which === 'se') {
  const p = createStackExchangeProvider({});
  const d = await p.discover({ limit: 5 });
  console.log('discover', d.length); d.forEach((s) => console.log(' ', brief(s)));
  console.log('health', await p.healthCheck());
}

if (which === 'gdelt') {
  const p = createGdeltProvider({ seedTerms: ['labubu', 'artificial intelligence'] });
  console.log('health', await p.healthCheck());
  const m = await p.measure!('artificial intelligence', {});
  console.log('measure', m ? brief(m) : null, m?.summary?.slice(0, 60), JSON.stringify(m?.metadata).slice(0, 300));
  const d = await p.discover({ limit: 5 });
  console.log('discover', d.length, d.map((s) => s.externalId));
  const empty = createGdeltProvider({});
  console.log('no-seed discover ->', await empty.discover({ limit: 5 }));
}
