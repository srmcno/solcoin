import { charNgrams, contentTokens } from './normalise.js';
import { cosine } from './similarity.js';

export const LOCAL_EMBEDDING_DIM = 384;

function hash32(str: string, salt: number): number {
  let h = (2166136261 ^ salt) >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/**
 * Deterministic hashed bag-of-features embedding.
 *
 * This is a LEXICAL embedding, not a semantic one: it captures surface form
 * (shared words, shared character trigrams) and is excellent at catching
 * near-duplicate names, tickers and re-skinned concepts. It requires no API
 * key, so collision detection works on a fresh install.
 *
 * When a real embedding provider is configured the platform stores those
 * vectors instead and labels them accordingly; the two are never mixed in a
 * single similarity comparison.
 */
export function localEmbed(text: string, dim = LOCAL_EMBEDDING_DIM): number[] {
  const vec = new Array<number>(dim).fill(0);
  const words = contentTokens(text);
  const grams = charNgrams(text, 3);
  const bigrams: string[] = [];
  for (let i = 0; i + 1 < words.length; i++) bigrams.push(`${words[i]}_${words[i + 1]}`);

  const add = (feature: string, weight: number, salt: number) => {
    const h = hash32(feature, salt);
    const idx = h % dim;
    // Signed hashing keeps the expected inner product unbiased under collisions.
    const sign = (h >>> 31) & 1 ? -1 : 1;
    vec[idx] = (vec[idx] ?? 0) + sign * weight;
  };

  for (const w of words) add(w, 1.0, 1);
  for (const b of bigrams) add(b, 0.8, 2);
  for (const g of grams) add(g, 0.35, 3);

  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < dim; i++) vec[i] = vec[i]! / norm;
  return vec;
}

export function embeddingSimilarity(a: readonly number[], b: readonly number[]): number {
  return Math.max(0, cosine(a, b));
}

/** Pack a float vector into a compact base64 blob for database storage. */
export function packEmbedding(vec: readonly number[]): string {
  const buf = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) buf[i] = vec[i] ?? 0;
  return Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength).toString('base64');
}

export function unpackEmbedding(blob: string): number[] {
  const raw = Buffer.from(blob, 'base64');
  const view = new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.byteLength / 4));
  return Array.from(view);
}

/**
 * Greedy agglomerative clustering over unit vectors.
 *
 * Used to group raw trend observations from many platforms into a single
 * conceptual trend ("the same thing, seen five ways") which is what the
 * cross-platform confirmation signal is built on.
 */
export function clusterByCosine<T>(
  items: readonly T[],
  getVector: (item: T) => readonly number[],
  threshold = 0.62,
): T[][] {
  const clusters: Array<{ centroid: number[]; members: T[] }> = [];
  for (const item of items) {
    const vec = getVector(item);
    let best: { idx: number; sim: number } | null = null;
    for (let i = 0; i < clusters.length; i++) {
      const sim = cosine(clusters[i]!.centroid, vec);
      if (sim >= threshold && (!best || sim > best.sim)) best = { idx: i, sim };
    }
    if (best) {
      const cluster = clusters[best.idx]!;
      cluster.members.push(item);
      const n = cluster.members.length;
      for (let d = 0; d < cluster.centroid.length; d++) {
        cluster.centroid[d] = (cluster.centroid[d]! * (n - 1) + (vec[d] ?? 0)) / n;
      }
      let norm = 0;
      for (const v of cluster.centroid) norm += v * v;
      norm = Math.sqrt(norm);
      if (norm > 0) for (let d = 0; d < cluster.centroid.length; d++) cluster.centroid[d] = cluster.centroid[d]! / norm;
    } else {
      clusters.push({ centroid: [...vec], members: [item] });
    }
  }
  return clusters.map((c) => c.members);
}
