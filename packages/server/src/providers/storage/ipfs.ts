import { AppError, safeErrorText } from '../../core/errors.js';
import { componentLogger } from '../../core/logger.js';
import { HttpClient } from '../http.js';
import type { MetadataStorageProvider, ProviderStatus } from '../types.js';

/**
 * Token metadata and artwork hosting.
 *
 * Two backends, tried in order, because this step sits directly in the launch
 * path and a single point of failure here blocks every launch:
 *
 *  1. **pump.fun's own IPFS endpoint.** Undocumented and declared unsupported by
 *     third parties, but verified working unauthenticated. It produces exactly
 *     the metadata shape pump.fun expects, so it is preferred when it works.
 *  2. **Pinata**, when the operator supplies a JWT. Contractually supported,
 *     costs nothing on the free tier, and is the correct answer if pump.fun's
 *     endpoint disappears.
 *
 * A third mode, `local`, writes to disk and serves the files from this server.
 * It is only appropriate for simulation and devnet, because a token whose
 * metadata lives on a laptop is not a real token — the provider says so loudly
 * rather than pretending otherwise.
 */

export interface IpfsProviderDeps {
  getCredential: (key: string) => Promise<string | null>;
  /** Absolute base URL this server is reachable at, for the local backend. */
  publicBaseUrl?: string;
  /** Directory for the local backend. */
  localDir?: string;
  now?: () => number;
}

interface UploadInput {
  image: Buffer;
  imageMimeType: string;
  name: string;
  symbol: string;
  description: string;
  website?: string;
  twitter?: string;
  telegram?: string;
  signal?: AbortSignal;
}

export class PumpFunIpfsProvider implements MetadataStorageProvider {
  readonly id = 'pumpfun_ipfs';
  readonly label = 'pump.fun IPFS';
  readonly kind = 'storage' as const;

  private readonly log = componentLogger('ipfs');
  private readonly http: HttpClient;
  private lastSuccessAt = 0;
  private lastFailureAt = 0;
  private lastDetail = 'not yet used';

  constructor(private readonly deps: IpfsProviderDeps) {
    this.http = new HttpClient({
      name: 'pumpfun-ipfs',
      baseUrl: 'https://pump.fun',
      timeoutMs: 45_000,
      maxRetries: 2,
      // Uploads are infrequent (one per launch) but expensive to fail, so the
      // limit is generous and the retry count low.
      rateLimit: { requests: 10, intervalMs: 60_000 },
      defaultHeaders: {
        // The endpoint is Cloudflare-fronted; a browser-shaped UA avoids
        // tripping bot protection.
        'user-agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
      },
      onResult: ({ ok, error }) => {
        if (ok) {
          this.lastSuccessAt = (this.deps.now ?? Date.now)();
          this.lastDetail = 'ok';
        } else {
          this.lastFailureAt = (this.deps.now ?? Date.now)();
          this.lastDetail = error ?? 'upload failed';
        }
      },
    });
  }

  async healthCheck(): Promise<ProviderStatus> {
    return {
      id: this.id,
      label: this.label,
      kind: 'storage',
      // A real probe would cost an upload, so health here reflects recent use
      // rather than an active check. Reporting a fabricated "ok" would be worse.
      state: this.lastFailureAt > this.lastSuccessAt ? 'degraded' : this.lastSuccessAt > 0 ? 'ok' : 'unknown',
      detail: this.lastSuccessAt === 0 ? 'No upload attempted yet.' : this.lastDetail,
      requiresCredentials: false,
      lastSuccessAt: this.lastSuccessAt || undefined,
      lastFailureAt: this.lastFailureAt || undefined,
    };
  }

  async upload(input: UploadInput): Promise<{ metadataUri: string; imageUri: string; provider: string }> {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(input.image)], { type: input.imageMimeType }), 'image.png');
    form.append('name', input.name);
    form.append('symbol', input.symbol);
    form.append('description', input.description);
    form.append('twitter', input.twitter ?? '');
    form.append('telegram', input.telegram ?? '');
    form.append('website', input.website ?? '');
    form.append('showName', 'true');

    const response = await this.http.request<{
      metadata?: { name?: string; symbol?: string; description?: string; image?: string };
      metadataUri?: string;
    }>('/api/ipfs', { method: 'POST', formData: form, signal: input.signal, timeoutMs: 60_000 });

    const metadataUri = response?.metadataUri;
    if (!metadataUri || typeof metadataUri !== 'string') {
      throw new AppError('provider_error', 'pump.fun IPFS upload returned no metadataUri.', {
        details: { response: JSON.stringify(response).slice(0, 300) },
      });
    }
    return { metadataUri, imageUri: response.metadata?.image ?? metadataUri, provider: this.id };
  }
}

export class PinataIpfsProvider implements MetadataStorageProvider {
  readonly id = 'pinata';
  readonly label = 'Pinata IPFS';
  readonly kind = 'storage' as const;

  private readonly http: HttpClient;
  private lastSuccessAt = 0;
  private lastFailureAt = 0;

  constructor(private readonly deps: IpfsProviderDeps) {
    this.http = new HttpClient({
      name: 'pinata',
      baseUrl: 'https://uploads.pinata.cloud',
      timeoutMs: 60_000,
      maxRetries: 2,
      rateLimit: { requests: 30, intervalMs: 60_000 },
    });
  }

  async healthCheck(): Promise<ProviderStatus> {
    const jwt = await this.deps.getCredential('storage.pinata.jwt');
    if (!jwt) {
      return {
        id: this.id,
        label: this.label,
        kind: 'storage',
        state: 'unconfigured',
        detail: 'No Pinata JWT configured.',
        requiresCredentials: true,
        setupHint: 'Create a free Pinata account and add its JWT under Settings → Providers.',
      };
    }
    return {
      id: this.id,
      label: this.label,
      kind: 'storage',
      state: this.lastFailureAt > this.lastSuccessAt ? 'degraded' : 'ok',
      detail: 'Credential present.',
      requiresCredentials: true,
      lastSuccessAt: this.lastSuccessAt || undefined,
      lastFailureAt: this.lastFailureAt || undefined,
    };
  }

  async upload(input: UploadInput): Promise<{ metadataUri: string; imageUri: string; provider: string }> {
    const jwt = await this.deps.getCredential('storage.pinata.jwt');
    if (!jwt) throw new AppError('not_configured', 'Pinata is not configured.');
    const headers = { authorization: `Bearer ${jwt}` };

    const imageForm = new FormData();
    imageForm.append('network', 'public');
    imageForm.append('file', new Blob([new Uint8Array(input.image)], { type: input.imageMimeType }), 'image.png');
    const imageResult = await this.http.request<{ data?: { cid?: string } }>('/v3/files', {
      method: 'POST',
      formData: imageForm,
      headers,
      signal: input.signal,
    });
    const imageCid = imageResult?.data?.cid;
    if (!imageCid) throw new AppError('provider_error', 'Pinata returned no CID for the uploaded image.');
    const imageUri = `https://ipfs.io/ipfs/${imageCid}`;

    // Metadata mirrors the shape pump.fun's own endpoint produces, so a token
    // launched via either backend looks identical to indexers and wallets.
    const metadata = {
      name: input.name,
      symbol: input.symbol,
      description: input.description,
      image: imageUri,
      showName: true,
      createdOn: 'https://pump.fun',
      ...(input.twitter ? { twitter: input.twitter } : {}),
      ...(input.telegram ? { telegram: input.telegram } : {}),
      ...(input.website ? { website: input.website } : {}),
    };
    const metaForm = new FormData();
    metaForm.append('network', 'public');
    metaForm.append(
      'file',
      new Blob([JSON.stringify(metadata)], { type: 'application/json' }),
      `${input.symbol.toLowerCase()}-metadata.json`,
    );
    const metaResult = await this.http.request<{ data?: { cid?: string } }>('/v3/files', {
      method: 'POST',
      formData: metaForm,
      headers,
      signal: input.signal,
    });
    const metaCid = metaResult?.data?.cid;
    if (!metaCid) throw new AppError('provider_error', 'Pinata returned no CID for the metadata document.');

    this.lastSuccessAt = (this.deps.now ?? Date.now)();
    return { metadataUri: `https://ipfs.io/ipfs/${metaCid}`, imageUri, provider: this.id };
  }
}

/**
 * Chained storage: try each backend in order, fall through on failure.
 *
 * If every backend fails the launch must not proceed — a token whose metadata
 * URI is unreachable is permanently broken on chain — so this throws rather
 * than substituting a placeholder.
 */
export class ChainedMetadataStorage implements MetadataStorageProvider {
  readonly id = 'metadata_storage';
  readonly label = 'Metadata storage';
  readonly kind = 'storage' as const;
  private readonly log = componentLogger('storage');

  constructor(private readonly backends: MetadataStorageProvider[]) {}

  async healthCheck(): Promise<ProviderStatus> {
    const statuses = await Promise.all(this.backends.map((b) => b.healthCheck()));
    const usable = statuses.filter((s) => s.state === 'ok' || s.state === 'unknown');
    return {
      id: this.id,
      label: this.label,
      kind: 'storage',
      state: usable.length > 0 ? (usable.length === statuses.length ? 'ok' : 'degraded') : 'down',
      detail: statuses.map((s) => `${s.label}: ${s.state}`).join('; '),
      requiresCredentials: false,
    };
  }

  async upload(input: UploadInput): Promise<{ metadataUri: string; imageUri: string; provider: string }> {
    const errors: string[] = [];
    for (const backend of this.backends) {
      const status = await backend.healthCheck();
      if (status.state === 'unconfigured') {
        errors.push(`${backend.label}: not configured`);
        continue;
      }
      try {
        return await backend.upload(input);
      } catch (e) {
        const detail = safeErrorText(e, 200);
        errors.push(`${backend.label}: ${detail}`);
        this.log.warn({ backend: backend.id, err: detail }, 'metadata upload backend failed; trying the next one');
      }
    }
    throw new AppError(
      'provider_unavailable',
      `Could not host token metadata on any configured backend. A launch cannot proceed without a reachable metadata URI. Tried: ${errors.join(' | ')}`,
      { retryable: true },
    );
  }
}
