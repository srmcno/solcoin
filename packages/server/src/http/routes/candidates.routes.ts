import type { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { z } from 'zod';
import { lamportsToSol } from '@solcoin/shared';
import { AppError } from '../../core/errors.js';
import { parseJson } from '../../core/json.js';
import { AUDIT_ACTIONS } from '../../security/audit.js';
import { actorFrom, requirePermission } from '../server.js';
import { explainPrediction } from '../../services/prediction.service.js';
import type { AppContainer } from '../../container.js';

/**
 * Candidate review and approval.
 *
 * The response shape is built so a reviewer can answer "why this one?" without
 * leaving the page: the trend it came from, the competitors it was measured
 * against, every gate check with its threshold, the panel's disagreement, and
 * the prediction with its uncertainty band.
 */
export default async function candidateRoutes(
  app: FastifyInstance,
  options: FastifyPluginOptions & { container: AppContainer },
): Promise<void> {
  const { container } = options;

  app.get('/api/candidates', async (request) => {
    requirePermission(request, 'view');
    const query = z
      .object({
        status: z.string().default('awaiting_approval'),
        limit: z.coerce.number().min(1).max(200).default(50),
      })
      .parse(request.query);

    const rows = container.db.$raw
      .prepare(
        `SELECT c.*, p.p_ten_holders, p.p_graduation, p.expected_creator_fees_sol, p.expected_value_sol,
                p.probability_profitable, p.confidence, p.expected_volume_24h_sol,
                t.title AS trend_title, t.slug AS trend_slug, t.opportunity_score AS trend_score
           FROM concepts c
           LEFT JOIN predictions p ON p.concept_id = c.id
           LEFT JOIN trends t ON t.id = c.trend_id
          WHERE c.status = ?
          ORDER BY p.expected_value_sol DESC NULLS LAST, c.created_at DESC
          LIMIT ?`,
      )
      .all(query.status, query.limit) as Array<Record<string, unknown>>;

    return {
      candidates: rows.map(shapeCandidate),
      counts: countsByStatus(container),
      autonomy: container.settings.get().autonomy.launch,
      network: container.settings.get().execution.network,
    };
  });

  app.get('/api/candidates/:id', async (request) => {
    requirePermission(request, 'view');
    const { id } = z.object({ id: z.string() }).parse(request.params);

    const concept = await container.concepts.getById(id);
    if (!concept) throw new AppError('not_found', 'No such candidate.');

    const [prediction, evaluations, trend] = await Promise.all([
      container.predictions.getPrediction(id),
      container.evaluation.getEvaluations(id),
      concept.trend_id ? container.trends.getById(String(concept.trend_id)) : Promise.resolve(null),
    ]);

    const saturationDetail = parseJson<Record<string, unknown>>(concept.saturation_detail as string | null, {});
    const originalityDetail = parseJson<Record<string, unknown>>(concept.originality_detail as string | null, {});

    return {
      candidate: shapeCandidate(concept),
      trend,
      prediction: prediction
        ? {
            ...prediction,
            features: parseJson(prediction.features as string, {}),
            drivers: parseJson(prediction.drivers as string | null, []),
            economics: parseJson(prediction.economics as string | null, {}),
          }
        : null,
      explanation: prediction ? explainPrediction(prediction) : [],
      evaluations: evaluations.map((e) => ({
        ...e,
        concerns: parseJson(e.concerns as string | null, []),
        strengths: parseJson(e.strengths as string | null, []),
        riskFlags: parseJson(e.risk_flags as string | null, []),
      })),
      saturation: saturationDetail,
      originality: originalityDetail,
      gateChecks: (originalityDetail.gateChecks as unknown[]) ?? (saturationDetail.gateChecks as unknown[]) ?? [],
      riskFlags: parseJson(concept.risk_flags as string | null, []),
    };
  });

  app.post('/api/candidates/:id/approve', async (request) => {
    const actor = requirePermission(request, 'approve_candidate');
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const { note } = z.object({ note: z.string().max(500).optional() }).parse(request.body ?? {});

    const concept = await container.concepts.getById(id);
    if (!concept) throw new AppError('not_found', 'No such candidate.');
    if (concept.status !== 'awaiting_approval' && concept.status !== 'draft' && concept.status !== 'evaluating') {
      throw new AppError('conflict', `This candidate is "${String(concept.status)}" and cannot be approved.`);
    }

    container.concepts.setStatus(id, 'approved', { actorId: actor.id });
    container.audit.record({
      actorType: 'user',
      actorId: actor.id,
      actorLabel: actor.displayName,
      action: AUDIT_ACTIONS.conceptApproved,
      targetType: 'concept',
      targetId: id,
      reason: note ?? null,
      ipAddress: request.ip,
    });
    container.events.emit('concept.approved', { conceptId: id, approvedBy: actor.id });

    return { ok: true, message: 'Approved. It will be launched by the next launch cycle, or launch it now.' };
  });

  app.post('/api/candidates/:id/reject', async (request) => {
    const actor = requirePermission(request, 'reject_candidate');
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const { reason } = z.object({ reason: z.string().min(1).max(500) }).parse(request.body);

    container.concepts.setStatus(id, 'rejected', { reason: 'human_rejected', detail: reason, actorId: actor.id });
    container.audit.record({
      actorType: 'user',
      actorId: actor.id,
      actorLabel: actor.displayName,
      action: AUDIT_ACTIONS.conceptRejected,
      targetType: 'concept',
      targetId: id,
      reason,
      ipAddress: request.ip,
    });
    return { ok: true };
  });

  /** Launch an approved candidate immediately. */
  app.post('/api/candidates/:id/launch', async (request) => {
    const actor = requirePermission(request, 'launch_token');
    const { id } = z.object({ id: z.string() }).parse(request.params);

    const concept = await container.concepts.getById(id);
    if (!concept) throw new AppError('not_found', 'No such candidate.');
    if (concept.status === 'launched') throw new AppError('conflict', 'This candidate has already been launched.');
    if (!concept.metadata_uri) {
      throw new AppError(
        'conflict',
        'This candidate has no hosted metadata yet. Its artwork step has not completed, and a launch without a reachable metadata URI would produce a permanently broken token.',
      );
    }

    const result = await container.launchApproved(id, { actorId: actor.id, actorLabel: actor.displayName });
    if (result.status !== 'confirmed') {
      throw new AppError(result.status === 'blocked' ? 'limit_exceeded' : 'transaction_failed', result.error ?? 'The launch did not complete.', {
        details: { launchId: result.launchId, code: result.errorCode },
      });
    }
    return {
      ok: true,
      launchId: result.launchId,
      mint: result.mintAddress,
      signature: result.signature,
      network: result.network,
      simulated: result.simulated,
      costSol: result.costLamports ? lamportsToSol(result.costLamports) : 0,
    };
  });

  /** Regenerate a fresh slate of concepts for the same trend. */
  app.post('/api/candidates/:id/regenerate', async (request) => {
    const actor = requirePermission(request, 'generate_concepts');
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const concept = await container.concepts.getById(id);
    if (!concept?.trend_id) throw new AppError('not_found', 'No such candidate, or it has no source trend.');

    container.concepts.setStatus(id, 'rejected', {
      reason: 'human_rejected',
      detail: 'Superseded by a regeneration request.',
      actorId: actor.id,
    });
    container.audit.record({
      actorType: 'user',
      actorId: actor.id,
      action: AUDIT_ACTIONS.conceptRegenerated,
      targetType: 'concept',
      targetId: id,
      ipAddress: request.ip,
    });

    const generated = await container.regenerateForTrend(String(concept.trend_id));
    return { ok: true, generated: generated.length, candidates: generated.map((c) => ({ id: c.id, name: c.name, symbol: c.symbol })) };
  });

  /** Manual edits before approval, within the same safety screening. */
  app.patch('/api/candidates/:id', async (request) => {
    requirePermission(request, 'approve_candidate');
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const body = z
      .object({
        name: z.string().min(2).max(32).optional(),
        symbol: z.string().min(2).max(10).optional(),
        description: z.string().min(8).max(500).optional(),
      })
      .parse(request.body);

    const result = await container.editCandidate(id, body, actorFrom(request));
    return result;
  });

  app.get('/api/launches', async (request) => {
    requirePermission(request, 'view');
    const { limit } = z.object({ limit: z.coerce.number().min(1).max(200).default(50) }).parse(request.query);
    return { launches: await container.launches.listRecent(limit) };
  });
}

function shapeCandidate(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    trendId: row.trend_id,
    trendTitle: row.trend_title ?? null,
    trendSlug: row.trend_slug ?? null,
    trendScore: row.trend_score !== undefined && row.trend_score !== null ? Number(row.trend_score) : null,
    name: row.name,
    symbol: row.symbol,
    description: row.description,
    narrative: row.narrative,
    archetype: row.archetype,
    category: row.category,
    status: row.status,
    rejectionReason: row.rejection_reason,
    rejectionDetail: row.rejection_detail,
    imageUri: row.image_uri,
    metadataUri: row.metadata_uri,
    originalityScore: Number(row.originality_score ?? 0),
    saturationScore: Number(row.saturation_score ?? 0),
    nameQuality: Number(row.name_quality ?? 0),
    tickerQuality: Number(row.ticker_quality ?? 0),
    aiPanelScore: Number(row.ai_panel_score ?? 0),
    aiPanelDisagreement: Number(row.ai_panel_disagreement ?? 0),
    memeIntensity: Number(row.meme_intensity ?? 0),
    culturalRelevance: Number(row.cultural_relevance ?? 0),
    artworkQuality: Number(row.artwork_quality ?? 0),
    riskFlags: parseJson(row.risk_flags as string | null, []),
    hardCollision: Boolean(row.hard_collision),
    requiresHumanReview: Boolean(row.requires_human_review),
    isExploration: Boolean(row.is_exploration),
    explorationArm: row.exploration_arm ?? null,
    reasoningSummary: row.reasoning_summary,
    expectedValueSol: row.expected_value_sol !== undefined && row.expected_value_sol !== null ? Number(row.expected_value_sol) : null,
    expectedCreatorFeesSol:
      row.expected_creator_fees_sol !== undefined && row.expected_creator_fees_sol !== null
        ? Number(row.expected_creator_fees_sol)
        : null,
    expectedVolume24hSol:
      row.expected_volume_24h_sol !== undefined && row.expected_volume_24h_sol !== null ? Number(row.expected_volume_24h_sol) : null,
    probabilityTenHolders: row.p_ten_holders !== undefined && row.p_ten_holders !== null ? Number(row.p_ten_holders) : null,
    probabilityGraduation: row.p_graduation !== undefined && row.p_graduation !== null ? Number(row.p_graduation) : null,
    probabilityProfitable:
      row.probability_profitable !== undefined && row.probability_profitable !== null ? Number(row.probability_profitable) : null,
    confidence: row.confidence !== undefined && row.confidence !== null ? Number(row.confidence) : null,
    createdAt: Number(row.created_at ?? 0),
    expiresAt: row.expires_at !== undefined && row.expires_at !== null ? Number(row.expires_at) : null,
  };
}

function countsByStatus(container: AppContainer): Record<string, number> {
  const rows = container.db.$raw.prepare('SELECT status, COUNT(*) AS n FROM concepts GROUP BY status').all() as Array<{
    status: string;
    n: number;
  }>;
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}
