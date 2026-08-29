import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRng, hashSeed } from '@solcoin/shared';
import { AppError, safeErrorText } from '../core/errors.js';
import { componentLogger } from '../core/logger.js';
import type { Db } from '../db/client.js';
import type { ImageProvider, MetadataStorageProvider } from '../providers/types.js';
import type { ConceptService } from './concept.service.js';
import type { AccountingService } from './accounting.service.js';

/**
 * Visual identity and metadata production.
 *
 * Two paths, and the distinction is stated honestly everywhere it matters:
 *
 *  1. **Generated artwork**, when an image provider is configured. This is what
 *     a real launch should use.
 *  2. **Procedural artwork**, when one is not. This is a genuine deterministic
 *     vector composition derived from the concept's name — not a placeholder,
 *     not a grey box — so the platform is fully functional on a fresh install
 *     with no image API key. It is labelled `procedural` in the record so the
 *     operator always knows which they are looking at, and the artwork-quality
 *     feature is scored lower for it, because a generated mark genuinely does
 *     perform worse than bespoke art and the model should learn that rather
 *     than being told a comfortable fiction.
 */

export type ArtworkSource = 'ai_generated' | 'procedural' | 'operator_supplied';

export interface ArtworkResult {
  source: ArtworkSource;
  imagePath: string;
  imageUri: string;
  metadataUri: string;
  imageHash: string;
  mimeType: string;
  quality: number;
  costUsd: number;
}

export class ArtworkService {
  private readonly log = componentLogger('artwork');

  constructor(
    private readonly db: Db,
    private readonly concepts: ConceptService,
    private readonly storage: MetadataStorageProvider,
    private readonly imageProvider: ImageProvider | null,
    private readonly accounting: AccountingService | null,
    private readonly dataDir: string,
    private readonly now: () => number = Date.now,
  ) {}

  async produce(
    conceptId: string,
    input: { name: string; symbol: string; description: string; imagePrompt: string },
  ): Promise<ArtworkResult> {
    const { image, mimeType, source, costUsd, quality } = await this.renderImage(conceptId, input);

    const imageHash = createHash('sha256').update(image).digest('hex');
    const duplicate = this.db.$raw
      .prepare('SELECT id, name FROM concepts WHERE image_hash = ? AND id != ? LIMIT 1')
      .get(imageHash, conceptId) as { id: string; name: string } | undefined;
    if (duplicate) {
      // Identical artwork across two tokens is a duplicate-concept signal, and
      // shipping it would make both look like copies of each other.
      throw new AppError(
        'conflict',
        `The generated artwork is byte-identical to the artwork for "${duplicate.name}". Regenerate with a different prompt.`,
      );
    }

    const dir = resolve(this.dataDir, 'artwork');
    mkdirSync(dir, { recursive: true });
    const extension = mimeType === 'image/svg+xml' ? 'svg' : mimeType === 'image/png' ? 'png' : 'bin';
    const imagePath = join(dir, `${conceptId}.${extension}`);
    writeFileSync(imagePath, image);

    const uploaded = await this.storage.upload({
      image,
      imageMimeType: mimeType,
      name: input.name,
      symbol: input.symbol,
      description: input.description,
    });

    this.concepts.setArtwork(conceptId, {
      imagePath,
      imageUri: uploaded.imageUri,
      metadataUri: uploaded.metadataUri,
      imageHash,
      quality,
    });

    if (costUsd > 0 && this.accounting) {
      await this.accounting
        .recordExpense({
          kind: 'ai_image',
          description: `Artwork for ${input.symbol}`,
          amountUsd: costUsd,
          refType: 'concept',
          refId: conceptId,
          provider: this.imageProvider?.id,
        })
        .catch((e: unknown) => this.log.warn({ err: safeErrorText(e, 120) }, 'could not record the artwork expense'));
    }

    this.log.info({ conceptId, source, provider: uploaded.provider }, 'artwork and metadata produced');

    return {
      source,
      imagePath,
      imageUri: uploaded.imageUri,
      metadataUri: uploaded.metadataUri,
      imageHash,
      mimeType,
      quality,
      costUsd,
    };
  }

  private async renderImage(
    conceptId: string,
    input: { name: string; symbol: string; imagePrompt: string },
  ): Promise<{ image: Buffer; mimeType: string; source: ArtworkSource; costUsd: number; quality: number }> {
    if (this.imageProvider) {
      try {
        const generated = await this.imageProvider.generate({
          prompt: this.buildSafePrompt(input.imagePrompt),
          size: '1024x1024',
          refType: 'concept',
          refId: conceptId,
        });
        return {
          image: generated.data,
          mimeType: generated.mimeType,
          source: 'ai_generated',
          costUsd: generated.costUsd,
          quality: 0.75,
        };
      } catch (e) {
        this.log.warn(
          { err: safeErrorText(e, 200) },
          'image generation failed; falling back to procedural artwork so the launch is not blocked',
        );
      }
    }

    return {
      image: Buffer.from(renderProceduralArtwork(input.name, input.symbol), 'utf8'),
      mimeType: 'image/svg+xml',
      source: 'procedural',
      costUsd: 0,
      // Deliberately below the neutral 0.6 baseline: procedural marks are real
      // artwork but they are not bespoke, and the model should learn the
      // difference from outcomes rather than be told they are equivalent.
      quality: 0.45,
    };
  }

  /**
   * Harden the prompt before it reaches an image model.
   *
   * The prompt originates from a language model that read untrusted internet
   * content, so it gets an explicit set of prohibitions appended rather than
   * being trusted to have complied.
   */
  private buildSafePrompt(prompt: string): string {
    return [
      prompt.slice(0, 700),
      'Style: bold, high-contrast, readable as a small circular avatar.',
      'Do not include any text, letters, numbers, watermarks, logos, brand marks, trademarked characters,',
      'recognisable real people, or anything resembling an existing company identity.',
    ].join(' ');
  }
}

/**
 * Deterministic procedural artwork.
 *
 * Produces a distinctive abstract composition seeded by the concept name: a
 * layered gradient field, an orbital arrangement of shapes whose count, sizes
 * and rotations derive from the seed, and the ticker's initial as a bold
 * geometric mark. Two different concepts never produce the same image, and the
 * same concept always produces the same one.
 */
export function renderProceduralArtwork(name: string, symbol: string, size = 1024): string {
  const rng = createRng(hashSeed(`${name}|${symbol}`));

  // Pick a hue anchor and build an analogous-plus-accent palette so the result
  // reads as a designed mark rather than random colour.
  const baseHue = Math.floor(rng.next() * 360);
  const scheme = rng.next();
  const accentHue = (baseHue + (scheme < 0.4 ? 180 : scheme < 0.7 ? 120 : 40)) % 360;
  const bgA = `hsl(${baseHue} ${55 + rng.next() * 25}% ${12 + rng.next() * 10}%)`;
  const bgB = `hsl(${(baseHue + 30) % 360} ${60 + rng.next() * 25}% ${22 + rng.next() * 14}%)`;
  const accent = `hsl(${accentHue} ${70 + rng.next() * 25}% ${58 + rng.next() * 15}%)`;
  const accentSoft = `hsl(${accentHue} ${60 + rng.next() * 20}% ${70 + rng.next() * 12}%)`;

  const centre = size / 2;
  const shapeCount = 5 + Math.floor(rng.next() * 6);
  const shapes: string[] = [];

  for (let i = 0; i < shapeCount; i++) {
    const angle = (i / shapeCount) * Math.PI * 2 + rng.next() * 0.6;
    const radius = size * (0.18 + rng.next() * 0.24);
    const cx = centre + Math.cos(angle) * radius;
    const cy = centre + Math.sin(angle) * radius;
    const r = size * (0.045 + rng.next() * 0.1);
    const opacity = (0.25 + rng.next() * 0.5).toFixed(2);
    const kind = rng.next();

    if (kind < 0.4) {
      shapes.push(`<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r.toFixed(1)}" fill="${accent}" opacity="${opacity}"/>`);
    } else if (kind < 0.7) {
      const rot = (rng.next() * 90).toFixed(1);
      shapes.push(
        `<rect x="${(cx - r).toFixed(1)}" y="${(cy - r).toFixed(1)}" width="${(r * 2).toFixed(1)}" height="${(r * 2).toFixed(1)}" rx="${(r * 0.25).toFixed(1)}" fill="${accentSoft}" opacity="${opacity}" transform="rotate(${rot} ${cx.toFixed(1)} ${cy.toFixed(1)})"/>`,
      );
    } else {
      const p1 = `${cx.toFixed(1)},${(cy - r).toFixed(1)}`;
      const p2 = `${(cx - r).toFixed(1)},${(cy + r * 0.8).toFixed(1)}`;
      const p3 = `${(cx + r).toFixed(1)},${(cy + r * 0.8).toFixed(1)}`;
      shapes.push(`<polygon points="${p1} ${p2} ${p3}" fill="${accent}" opacity="${opacity}"/>`);
    }
  }

  const ringCount = 2 + Math.floor(rng.next() * 3);
  const rings: string[] = [];
  for (let i = 0; i < ringCount; i++) {
    const r = size * (0.28 + i * 0.08 + rng.next() * 0.03);
    rings.push(
      `<circle cx="${centre}" cy="${centre}" r="${r.toFixed(1)}" fill="none" stroke="${accentSoft}" stroke-width="${(size * 0.004).toFixed(1)}" opacity="${(0.12 + rng.next() * 0.2).toFixed(2)}"/>`,
    );
  }

  const initial = (symbol[0] ?? name[0] ?? '?').toUpperCase();
  const markRadius = size * 0.2;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="${escapeXml(name)} token mark">
  <title>${escapeXml(name)} ($${escapeXml(symbol)})</title>
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${bgA}"/>
      <stop offset="100%" stop-color="${bgB}"/>
    </linearGradient>
    <radialGradient id="glow" cx="50%" cy="45%" r="55%">
      <stop offset="0%" stop-color="${accent}" stop-opacity="0.45"/>
      <stop offset="100%" stop-color="${accent}" stop-opacity="0"/>
    </radialGradient>
    <filter id="soften" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="${(size * 0.012).toFixed(1)}"/>
    </filter>
  </defs>
  <rect width="${size}" height="${size}" fill="url(#bg)"/>
  <rect width="${size}" height="${size}" fill="url(#glow)"/>
  <g filter="url(#soften)">${shapes.join('')}</g>
  ${rings.join('')}
  <circle cx="${centre}" cy="${centre}" r="${markRadius.toFixed(1)}" fill="${bgA}" opacity="0.82"/>
  <circle cx="${centre}" cy="${centre}" r="${markRadius.toFixed(1)}" fill="none" stroke="${accent}" stroke-width="${(size * 0.008).toFixed(1)}"/>
  <text x="${centre}" y="${centre}" text-anchor="middle" dominant-baseline="central"
        font-family="Inter, Helvetica, Arial, sans-serif" font-weight="800"
        font-size="${(markRadius * 1.1).toFixed(0)}" fill="${accentSoft}">${escapeXml(initial)}</text>
</svg>`;
}

function escapeXml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
