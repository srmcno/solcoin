import { lamportsToSol } from '@solcoin/shared';
import { AppError } from '../core/errors.js';
import { newId } from '../core/ids.js';
import { componentLogger } from '../core/logger.js';
import type { Db } from '../db/client.js';

/**
 * Double-sided ledger of every economic event the platform causes.
 *
 * This is the module an accountant is handed, so it is written to a different
 * standard than a dashboard: nothing is smoothed, nothing is estimated, and
 * anything that cannot be valued is reported as unvalued rather than filled in.
 *
 * Two decisions run through the whole file:
 *
 *  1. **USD is a recording, not a conversion.** Where a SOL price was captured
 *     at the moment of the event, the USD figure is that price times that
 *     amount. Where no price was captured, `amountUsd` is `null`. The ledger
 *     never back-fills a historical event with today's price: doing so would
 *     silently restate past results every time SOL moves, and the restated
 *     numbers would look exactly as authoritative as the real ones. `summary`
 *     therefore also reports how many entries lack a USD valuation, so the
 *     coverage of any USD total is visible next to the total itself.
 *
 *  2. **Nothing is counted twice.** On-chain launch spend lives on the launch
 *     row (`total_cost_lamports`); the mirror expense kinds are excluded from
 *     the expense stream. Wallet transfers between the platform's own accounts
 *     are movements, not profit or loss, so they appear in the ledger for
 *     completeness with `countsTowardPnl: false` and only their network fee is
 *     treated as a cost.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Expense kinds that duplicate what the launch row already records. Summing
 * both `launches.total_cost_lamports` and these rows would double-count every
 * launch, which is the single easiest way to make this ledger wrong.
 */
const LAUNCH_MIRROR_EXPENSE_KINDS = ['launch_sol', 'network_fee', 'priority_fee'] as const;

/** Internal account-to-account movements. Real, recorded, but not P&L. */
const TRANSFER_CATEGORY = 'wallet_transfer';

export const ACCOUNTING_DISCLAIMER =
  'These records are produced for bookkeeping only and do not constitute tax, accounting or legal advice. ' +
  'They are a transaction log of on-chain and operating events as this platform observed them: cost basis, ' +
  'lot selection, capital-gains treatment, income characterisation, VAT/GST and every other ' +
  'jurisdiction-specific determination are NOT computed here. USD amounts, where present, are the value ' +
  'recorded at the time of the event using whatever SOL price was available then; entries with no recorded ' +
  'price carry a null USD amount and are excluded from USD totals rather than being converted at a later ' +
  'rate. On-chain data may be incomplete where the platform was offline. Have a qualified professional in ' +
  'your jurisdiction review these records before relying on them for any filing.';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LedgerEntryType = 'revenue' | 'expense';

export type LedgerSource = 'creator_fee_events' | 'expenses' | 'launches' | 'wallet_transactions';

export interface RecordExpenseInput {
  /** Free-form category, e.g. 'ai_image', 'ai_text', 'rpc', 'hosting'. */
  kind: string;
  description?: string;
  amountUsd?: number;
  amountLamports?: number;
  /** SOL/USD at the moment the cost was incurred, if known. Stored, never guessed. */
  solPriceUsd?: number;
  refType?: string;
  refId?: string;
  provider?: string;
  incurredAt?: number;
}

export interface ExpenseRecord {
  id: string;
  kind: string;
  description: string | null;
  amountUsd: number;
  amountLamports: number;
  solPriceUsd: number | null;
  refType: string | null;
  refId: string | null;
  provider: string | null;
  incurredAt: number;
}

export interface LedgerOptions {
  sinceMs?: number;
  untilMs?: number;
  /** Filter by ledger category (the `category` field), e.g. ['creator_fees']. */
  kinds?: string[];
  limit?: number;
  offset?: number;
}

export interface LedgerEntry {
  /** Stable id of the underlying row, suffixed where one row yields two entries. */
  id: string;
  /** ISO-8601 UTC timestamp of the event. */
  date: string;
  occurredAtMs: number;
  type: LedgerEntryType;
  category: string;
  description: string;
  amountSol: number;
  /** Null when no SOL price was recorded for this event. Never back-filled. */
  amountUsd: number | null;
  solPriceUsd: number | null;
  /** Transaction signature where one exists, otherwise the reference id. */
  reference: string | null;
  network: string | null;
  refType: string | null;
  refId: string | null;
  source: LedgerSource;
  /**
   * False for movements between the platform's own wallets. They belong in the
   * ledger — money moved — but adding them to revenue or costs would invent
   * profit out of a transfer.
   */
  countsTowardPnl: boolean;
  /** True when amountSol was computed from a USD amount at the recorded rate. */
  solDerivedFromUsd: boolean;
}

export interface CategoryTotal {
  category: string;
  /**
   * Bucketing is by category *and* direction. `wallet_transfer` carries both:
   * a sweep out and a top-up in are the same category, and summing them into
   * one signed total would report the gross traffic as though it were a
   * position.
   */
  type: LedgerEntryType;
  entryCount: number;
  amountSol: number;
  /** Sum over entries that carry a USD valuation only. */
  amountUsd: number;
  /** Entries in this bucket with no recorded price. `amountUsd` omits them. */
  entriesMissingUsd: number;
  /** Null when no entry in the bucket carried a USD valuation. */
  usdCoverage: number | null;
  countsTowardPnl: boolean;
}

export interface AccountingSummary {
  rangeStart: string | null;
  rangeEnd: string | null;
  entryCount: number;
  byCategory: CategoryTotal[];

  revenueSol: number;
  costSol: number;
  netSol: number;

  /**
   * USD totals over the subset of entries that carry a recorded valuation, or
   * null where that subset is empty. Null means unvalued; 0 would read as
   * "no money", which is a different and usually false statement.
   */
  revenueUsd: number | null;
  costUsd: number | null;
  /**
   * Null unless *both* sides carried a valuation. Netting a valued revenue
   * total against an unvalued cost total would manufacture a profit out of
   * missing prices.
   */
  netUsd: number | null;

  /**
   * Coverage of the USD figures. `entriesMissingUsd` of `entryCount` entries
   * had no recorded SOL price, so the USD totals above describe only part of
   * the ledger. Read them together or not at all.
   */
  entriesMissingUsd: number;
  usdCoverage: number;
  /**
   * Coverage of each side separately. A net USD figure is only as good as the
   * worse of the two, and the two routinely differ: launch spend carries no
   * price at all while AI costs are billed in dollars.
   */
  revenueEntryCount: number;
  revenueEntriesMissingUsd: number;
  costEntryCount: number;
  costEntriesMissingUsd: number;
  /** Entries whose SOL amount is zero because only a USD cost was recorded. */
  entriesMissingSol: number;

  /**
   * Internal transfers, reported separately because they are not P&L. In and
   * out are kept apart: one 3 SOL sweep out and one 3 SOL top-up in is 6 SOL of
   * movement and 0 SOL of position, and a single total cannot say both.
   */
  transferCount: number;
  transferInSol: number;
  transferOutSol: number;
  /** Gross movement, `transferInSol + transferOutSol`. Not a balance. */
  transferSol: number;

  /** Facts a reader needs in order not to misread the totals above. */
  notes: string[];
  disclaimer: string;
}

export interface MonthlyBreakdownRow {
  /** UTC calendar month, 'YYYY-MM'. */
  month: string;
  revenueSol: number;
  costSol: number;
  netSol: number;
  /** Null when no *revenue* entry in the month carried a recorded USD valuation. */
  revenueUsd: number | null;
  /** Null when no *cost* entry in the month carried a recorded USD valuation. */
  costUsd: number | null;
  /** Null unless both sides of the month are valued; see `AccountingSummary.netUsd`. */
  netUsd: number | null;
  /** P&L entries in the month, and how many of them had no recorded price. */
  entryCount: number;
  entriesMissingUsd: number;
  launches: number;
}

export interface LedgerExportEnvelope {
  generatedAt: string;
  rangeStart: string | null;
  rangeEnd: string | null;
  entryCount: number;
  disclaimer: string;
  entries: LedgerEntry[];
}

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

interface FeeEventRow {
  id: string;
  token_mint: string | null;
  vault: string;
  wallet_address: string | null;
  lamports: number;
  usd_value: number | null;
  sol_price_usd: number | null;
  transaction_signature: string | null;
  network_fee_lamports: number;
  observed_at: number;
  network: string | null;
}

interface ExpenseRow {
  id: string;
  kind: string;
  description: string | null;
  amount_usd: number;
  amount_lamports: number;
  sol_price_usd: number | null;
  ref_type: string | null;
  ref_id: string | null;
  provider: string | null;
  incurred_at: number;
}

interface LaunchRow {
  id: string;
  concept_id: string;
  network: string;
  status: string;
  transaction_signature: string | null;
  total_cost_lamports: number;
  dev_buy_lamports: number;
  network_fee_lamports: number;
  occurred_at: number;
  symbol: string | null;
}

interface WalletTxRow {
  id: string;
  wallet_address: string;
  network: string;
  signature: string | null;
  direction: string;
  purpose: string;
  lamports: number;
  fee_lamports: number;
  counterparty: string | null;
  status: string;
  ref_type: string | null;
  ref_id: string | null;
  occurred_at: number;
}

export class AccountingService {
  private readonly log = componentLogger('accounting');

  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

  /**
   * Record an operating cost.
   *
   * Both a USD amount and a lamport amount are accepted because the platform
   * genuinely incurs both kinds: AI providers bill in dollars, the chain bills
   * in lamports. Whichever is authoritative is stored as given, along with the
   * SOL price at the time if the caller knows it. Nothing is converted on the
   * way in — conversion happens at read time, and only where a rate was
   * actually recorded.
   */
  async recordExpense(input: RecordExpenseInput): Promise<ExpenseRecord> {
    const kind = input.kind.trim();
    if (!kind) throw new AppError('validation_failed', 'An expense needs a kind.');

    const amountUsd = input.amountUsd ?? 0;
    const amountLamports = Math.round(input.amountLamports ?? 0);
    if (!Number.isFinite(amountUsd) || amountUsd < 0) {
      throw new AppError('validation_failed', `Expense amountUsd must be a non-negative number, received ${String(input.amountUsd)}.`);
    }
    if (!Number.isFinite(amountLamports) || amountLamports < 0) {
      throw new AppError('validation_failed', `Expense amountLamports must be a non-negative number, received ${String(input.amountLamports)}.`);
    }
    if (input.solPriceUsd !== undefined && (!Number.isFinite(input.solPriceUsd) || input.solPriceUsd <= 0)) {
      throw new AppError('validation_failed', 'solPriceUsd must be a positive number when supplied.');
    }

    const incurredAt = input.incurredAt ?? this.now();
    const id = newId('exp', incurredAt);

    this.db.$raw
      .prepare(
        `INSERT INTO expenses
           (id, kind, description, amount_usd, amount_lamports, sol_price_usd, ref_type, ref_id, provider, incurred_at, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        kind,
        input.description ?? null,
        amountUsd,
        amountLamports,
        input.solPriceUsd ?? null,
        input.refType ?? null,
        input.refId ?? null,
        input.provider ?? null,
        incurredAt,
        this.now(),
      );

    // A zero-cost record is legitimate (a free-tier provider call still belongs
    // in the log) but it is worth surfacing, because it is also what a broken
    // cost-reporting call looks like.
    if (amountUsd === 0 && amountLamports === 0) {
      this.log.debug({ kind, provider: input.provider }, 'expense recorded with a zero amount');
    }

    return {
      id,
      kind,
      description: input.description ?? null,
      amountUsd,
      amountLamports,
      solPriceUsd: input.solPriceUsd ?? null,
      refType: input.refType ?? null,
      refId: input.refId ?? null,
      provider: input.provider ?? null,
      incurredAt,
    };
  }

  // -------------------------------------------------------------------------
  // Ledger
  // -------------------------------------------------------------------------

  /**
   * The unified ledger, oldest first.
   *
   * Chronological ascending order is the accountant's convention and it is what
   * makes the CSV export directly importable; a dashboard that wants the most
   * recent rows should read the tail.
   */
  async ledger(options: LedgerOptions = {}): Promise<LedgerEntry[]> {
    const entries = this.collect(options);
    const offset = Math.max(0, options.offset ?? 0);
    const limit = options.limit === undefined ? entries.length : Math.max(0, options.limit);
    return entries.slice(offset, offset + limit);
  }

  /**
   * Totals for the filtered range.
   *
   * `limit` and `offset` are deliberately ignored here: a total computed over a
   * page of a ledger is not a total, and returning one would invite it to be
   * read as the period's result.
   */
  async summary(options: LedgerOptions = {}): Promise<AccountingSummary> {
    const entries = this.collect({ ...options, limit: undefined, offset: undefined });

    const byCategory = new Map<string, CategoryTotal>();
    let revenueSol = 0;
    let costSol = 0;
    let revenueUsd = 0;
    let costUsd = 0;
    let entriesMissingUsd = 0;
    let entriesMissingSol = 0;
    let transferCount = 0;
    let transferSol = 0;

    for (const entry of entries) {
      const bucket = byCategory.get(entry.category) ?? {
        category: entry.category,
        type: entry.type,
        entryCount: 0,
        amountSol: 0,
        amountUsd: 0,
        entriesMissingUsd: 0,
        countsTowardPnl: entry.countsTowardPnl,
      };
      bucket.entryCount += 1;
      bucket.amountSol += entry.amountSol;
      if (entry.amountUsd === null) bucket.entriesMissingUsd += 1;
      else bucket.amountUsd += entry.amountUsd;
      byCategory.set(entry.category, bucket);

      if (entry.amountUsd === null) entriesMissingUsd += 1;
      if (entry.amountSol === 0 && entry.amountUsd !== null && entry.amountUsd > 0) entriesMissingSol += 1;

      if (!entry.countsTowardPnl) {
        transferCount += 1;
        transferSol += entry.amountSol;
        continue;
      }
      if (entry.type === 'revenue') {
        revenueSol += entry.amountSol;
        if (entry.amountUsd !== null) revenueUsd += entry.amountUsd;
      } else {
        costSol += entry.amountSol;
        if (entry.amountUsd !== null) costUsd += entry.amountUsd;
      }
    }

    const notes: string[] = [
      'Revenue is creator fees actually collected on-chain (cash basis). Fees accrued in a vault but not yet claimed are not revenue here.',
      'Launch spend is taken from the launch record; the mirror expense kinds (launch_sol, network_fee, priority_fee) are excluded from the expense stream so nothing is counted twice.',
      "Transfers between the platform's own wallets are listed for completeness but excluded from revenue, costs and net; only their network fee is treated as a cost.",
    ];
    if (entriesMissingUsd > 0) {
      notes.push(
        `${entriesMissingUsd} of ${entries.length} entries have no recorded SOL price and are therefore absent from the USD totals. The USD figures describe ${((entries.length > 0 ? 1 - entriesMissingUsd / entries.length : 0) * 100).toFixed(0)}% of the ledger.`,
      );
    }
    if (entriesMissingSol > 0) {
      notes.push(
        `${entriesMissingSol} entries were billed in USD with no SOL price recorded, so they contribute to the USD costs but not to the SOL costs. The SOL net is understated by that amount.`,
      );
    }
    notes.push(
      'Creator fee collections are wallet-level on-chain events; the fee ledger does not carry a network, so those entries show a network only where the event is attributed to a token.',
    );

    return {
      rangeStart: entries.length > 0 ? new Date(entries[0]!.occurredAtMs).toISOString() : null,
      rangeEnd: entries.length > 0 ? new Date(entries[entries.length - 1]!.occurredAtMs).toISOString() : null,
      entryCount: entries.length,
      byCategory: [...byCategory.values()].sort((a, b) => b.amountSol - a.amountSol),
      revenueSol,
      costSol,
      netSol: revenueSol - costSol,
      revenueUsd,
      costUsd,
      netUsd: revenueUsd - costUsd,
      entriesMissingUsd,
      usdCoverage: entries.length > 0 ? 1 - entriesMissingUsd / entries.length : 0,
      entriesMissingSol,
      transferCount,
      transferSol,
      notes,
      disclaimer: ACCOUNTING_DISCLAIMER,
    };
  }

  /**
   * RFC 4180 CSV of the ledger: CRLF line endings, a header row, and every
   * field containing a comma, quote or newline wrapped in quotes with embedded
   * quotes doubled.
   *
   * Amounts are written at full precision (9 decimals for SOL, one lamport)
   * rather than display-rounded, because a rounded ledger does not reconcile.
   */
  async exportCsv(options: LedgerOptions = {}): Promise<string> {
    const entries = await this.ledger(options);
    const header = [
      'date',
      'type',
      'category',
      'description',
      'amount_sol',
      'amount_usd',
      'sol_price_usd',
      'reference',
      'network',
      'ref_type',
      'ref_id',
    ];

    const lines = [header.map(csvField).join(',')];
    for (const entry of entries) {
      lines.push(
        [
          csvField(entry.date),
          csvField(entry.type),
          csvField(entry.category),
          csvField(entry.description),
          csvField(entry.amountSol.toFixed(9)),
          csvField(entry.amountUsd === null ? '' : entry.amountUsd.toFixed(6)),
          csvField(entry.solPriceUsd === null ? '' : String(entry.solPriceUsd)),
          csvField(entry.reference),
          csvField(entry.network),
          csvField(entry.refType),
          csvField(entry.refId),
        ].join(','),
      );
    }
    // RFC 4180 permits a trailing CRLF on the last record; including it means a
    // concatenated export never runs two records together.
    return `${lines.join('\r\n')}\r\n`;
  }

  /** The same rows as `exportCsv`, wrapped in a provenance envelope. */
  async exportJson(options: LedgerOptions = {}): Promise<string> {
    const entries = await this.ledger(options);
    const envelope: LedgerExportEnvelope = {
      generatedAt: new Date(this.now()).toISOString(),
      rangeStart: entries.length > 0 ? entries[0]!.date : null,
      rangeEnd: entries.length > 0 ? entries[entries.length - 1]!.date : null,
      entryCount: entries.length,
      disclaimer: ACCOUNTING_DISCLAIMER,
      entries,
    };
    return JSON.stringify(envelope, null, 2);
  }

  /**
   * Per-calendar-month totals over the whole ledger, oldest month first.
   *
   * Months are UTC because every timestamp in the system is; a local-time month
   * boundary would move entries between periods depending on where the report
   * was run. USD columns are null for a month in which no entry carried a
   * recorded valuation, rather than zero, which would read as "no money".
   */
  async monthlyBreakdown(): Promise<MonthlyBreakdownRow[]> {
    const entries = this.collect({});
    const months = new Map<
      string,
      { revenueSol: number; costSol: number; revenueUsd: number; costUsd: number; usdEntries: number; launches: number }
    >();

    for (const entry of entries) {
      const month = new Date(entry.occurredAtMs).toISOString().slice(0, 7);
      const bucket = months.get(month) ?? { revenueSol: 0, costSol: 0, revenueUsd: 0, costUsd: 0, usdEntries: 0, launches: 0 };
      if (entry.source === 'launches') bucket.launches += 1;
      if (entry.countsTowardPnl) {
        if (entry.type === 'revenue') {
          bucket.revenueSol += entry.amountSol;
          if (entry.amountUsd !== null) bucket.revenueUsd += entry.amountUsd;
        } else {
          bucket.costSol += entry.amountSol;
          if (entry.amountUsd !== null) bucket.costUsd += entry.amountUsd;
        }
        if (entry.amountUsd !== null) bucket.usdEntries += 1;
      }
      months.set(month, bucket);
    }

    return [...months.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, b]) => ({
        month,
        revenueSol: b.revenueSol,
        costSol: b.costSol,
        netSol: b.revenueSol - b.costSol,
        revenueUsd: b.usdEntries > 0 ? b.revenueUsd : null,
        costUsd: b.usdEntries > 0 ? b.costUsd : null,
        netUsd: b.usdEntries > 0 ? b.revenueUsd - b.costUsd : null,
        launches: b.launches,
      }));
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** Gather every source into one chronological list, filtered but unpaged. */
  private collect(options: LedgerOptions): LedgerEntry[] {
    const since = options.sinceMs ?? 0;
    const until = options.untilMs ?? Number.MAX_SAFE_INTEGER;
    const entries: LedgerEntry[] = [
      ...this.feeEntries(since, until),
      ...this.expenseEntries(since, until),
      ...this.launchEntries(since, until),
      ...this.walletEntries(since, until),
    ];

    const kinds = options.kinds && options.kinds.length > 0 ? new Set(options.kinds) : null;
    const filtered = kinds ? entries.filter((e) => kinds.has(e.category)) : entries;

    // Ties are broken on id so that two events in the same millisecond keep a
    // stable order between exports; a ledger whose row order shifts between
    // runs cannot be diffed.
    return filtered.sort((a, b) => a.occurredAtMs - b.occurredAtMs || a.id.localeCompare(b.id));
  }

  /**
   * Realised creator fees, plus the network fee each claim cost.
   *
   * Only `kind = 'collection'` becomes revenue. Accrual snapshots are
   * observations of an unclaimed balance, not income, and counting them would
   * book the same lamports twice — once when they appear in the vault and again
   * when they are claimed.
   */
  private feeEntries(since: number, until: number): LedgerEntry[] {
    const rows = this.db.$raw
      .prepare(
        `SELECT e.id, e.token_mint, e.vault, e.wallet_address, e.lamports, e.usd_value, e.sol_price_usd,
                e.transaction_signature, e.network_fee_lamports, e.observed_at, t.network AS network
           FROM creator_fee_events e
           LEFT JOIN tokens t ON t.mint = e.token_mint
          WHERE e.kind = 'collection' AND e.observed_at >= ? AND e.observed_at <= ?`,
      )
      .all(since, until) as FeeEventRow[];

    const out: LedgerEntry[] = [];
    for (const row of rows) {
      const amountSol = lamportsToSol(row.lamports);
      out.push({
        id: row.id,
        date: new Date(row.observed_at).toISOString(),
        occurredAtMs: row.observed_at,
        type: 'revenue',
        category: 'creator_fees',
        description: `Creator fees claimed from the ${row.vault} vault${row.wallet_address ? ` to ${row.wallet_address}` : ''}`,
        amountSol,
        amountUsd: this.usdFor(amountSol, row.usd_value, row.sol_price_usd),
        solPriceUsd: row.sol_price_usd,
        reference: row.transaction_signature,
        network: row.network,
        refType: row.token_mint ? 'token' : 'wallet',
        refId: row.token_mint ?? row.wallet_address,
        source: 'creator_fee_events',
        countsTowardPnl: true,
        solDerivedFromUsd: false,
      });

      if (row.network_fee_lamports > 0) {
        const feeSol = lamportsToSol(row.network_fee_lamports);
        out.push({
          id: `${row.id}:fee`,
          date: new Date(row.observed_at).toISOString(),
          occurredAtMs: row.observed_at,
          type: 'expense',
          category: 'fee_claim_network_fee',
          description: `Network fee for the ${row.vault} fee claim`,
          amountSol: feeSol,
          amountUsd: this.usdFor(feeSol, null, row.sol_price_usd),
          solPriceUsd: row.sol_price_usd,
          reference: row.transaction_signature,
          network: row.network,
          refType: row.token_mint ? 'token' : 'wallet',
          refId: row.token_mint ?? row.wallet_address,
          source: 'creator_fee_events',
          countsTowardPnl: true,
          solDerivedFromUsd: false,
        });
      }
    }
    return out;
  }

  /**
   * Operating costs.
   *
   * The launch mirror kinds are excluded here; see LAUNCH_MIRROR_EXPENSE_KINDS.
   * An expense billed in USD with a recorded SOL price is converted to SOL *at
   * that recorded rate* and flagged `solDerivedFromUsd`, so a reader can tell a
   * measured lamport amount from a converted dollar amount.
   */
  private expenseEntries(since: number, until: number): LedgerEntry[] {
    const placeholders = LAUNCH_MIRROR_EXPENSE_KINDS.map(() => '?').join(',');
    const rows = this.db.$raw
      .prepare(
        `SELECT id, kind, description, amount_usd, amount_lamports, sol_price_usd, ref_type, ref_id, provider, incurred_at
           FROM expenses
          WHERE incurred_at >= ? AND incurred_at <= ? AND kind NOT IN (${placeholders})`,
      )
      .all(since, until, ...LAUNCH_MIRROR_EXPENSE_KINDS) as ExpenseRow[];

    return rows.map((row) => {
      const hasLamports = row.amount_lamports > 0;
      const price = row.sol_price_usd !== null && row.sol_price_usd > 0 ? row.sol_price_usd : null;
      const derived = !hasLamports && row.amount_usd > 0 && price !== null;
      const amountSol = hasLamports ? lamportsToSol(row.amount_lamports) : derived ? row.amount_usd / price! : 0;
      const amountUsd =
        row.amount_usd > 0 ? row.amount_usd : hasLamports && price !== null ? lamportsToSol(row.amount_lamports) * price : null;

      return {
        id: row.id,
        date: new Date(row.incurred_at).toISOString(),
        occurredAtMs: row.incurred_at,
        type: 'expense' as const,
        category: row.kind,
        description: row.description ?? (row.provider ? `${row.kind} (${row.provider})` : row.kind),
        amountSol,
        amountUsd,
        solPriceUsd: price,
        // Operating costs have no transaction; the reference is what the cost
        // was incurred for.
        reference: row.ref_id,
        // The expenses table carries no network column; an off-chain cost is
        // not attributable to one, so it is reported as unknown rather than
        // guessed from the current configuration.
        network: null,
        refType: row.ref_type,
        refId: row.ref_id,
        source: 'expenses' as const,
        countsTowardPnl: true,
        solDerivedFromUsd: derived,
      };
    });
  }

  /**
   * On-chain launch spend.
   *
   * `total_cost_lamports` is the authoritative figure: it already includes the
   * dev buy, the network fee and the priority fee. Only launches that actually
   * spent something appear, so an abandoned draft does not show up as a
   * zero-cost line. No SOL price is recorded against a launch, so these entries
   * carry a null USD amount rather than a conversion at today's rate.
   */
  private launchEntries(since: number, until: number): LedgerEntry[] {
    const rows = this.db.$raw
      .prepare(
        `SELECT l.id, l.concept_id, l.network, l.status, l.transaction_signature, l.total_cost_lamports,
                l.dev_buy_lamports, l.network_fee_lamports,
                COALESCE(l.confirmed_at, l.submitted_at, l.created_at) AS occurred_at,
                c.symbol AS symbol
           FROM launches l
           LEFT JOIN concepts c ON c.id = l.concept_id
          WHERE l.total_cost_lamports > 0
            AND COALESCE(l.confirmed_at, l.submitted_at, l.created_at) >= ?
            AND COALESCE(l.confirmed_at, l.submitted_at, l.created_at) <= ?`,
      )
      .all(since, until) as LaunchRow[];

    return rows.map((row) => ({
      id: row.id,
      date: new Date(row.occurred_at).toISOString(),
      occurredAtMs: row.occurred_at,
      type: 'expense' as const,
      category: 'launch_onchain',
      description: `Launch ${row.symbol ?? row.id}${row.status === 'confirmed' ? '' : ` (${row.status})`}: dev buy ${lamportsToSol(row.dev_buy_lamports).toFixed(6)} SOL plus fees`,
      amountSol: lamportsToSol(row.total_cost_lamports),
      amountUsd: null,
      solPriceUsd: null,
      reference: row.transaction_signature ?? row.id,
      network: row.network,
      refType: 'launch' as const,
      refId: row.id,
      source: 'launches' as const,
      countsTowardPnl: true,
      solDerivedFromUsd: false,
    }));
  }

  /**
   * Wallet movements.
   *
   * A sweep to treasury is not income and a top-up is not a cost: both are the
   * same money in a different account. They are listed so the ledger reconciles
   * against on-chain balances, with `countsTowardPnl: false`. The network fee
   * the movement cost is a genuine expense and is emitted as its own entry.
   * Failed transactions are excluded — they moved nothing.
   */
  private walletEntries(since: number, until: number): LedgerEntry[] {
    const rows = this.db.$raw
      .prepare(
        `SELECT id, wallet_address, network, signature, direction, purpose, lamports, fee_lamports,
                counterparty, status, ref_type, ref_id, occurred_at
           FROM wallet_transactions
          WHERE status != 'failed' AND occurred_at >= ? AND occurred_at <= ?`,
      )
      .all(since, until) as WalletTxRow[];

    const out: LedgerEntry[] = [];
    for (const row of rows) {
      out.push({
        id: row.id,
        date: new Date(row.occurred_at).toISOString(),
        occurredAtMs: row.occurred_at,
        // The direction is preserved so the movement reads correctly against a
        // bank-style statement, even though neither side is P&L.
        type: row.direction === 'in' ? 'revenue' : 'expense',
        category: TRANSFER_CATEGORY,
        description: `${row.purpose} ${row.direction === 'in' ? 'from' : 'to'} ${row.counterparty ?? 'an unrecorded counterparty'} (internal movement, not profit or loss)${row.status === 'confirmed' ? '' : ` [${row.status}]`}`,
        amountSol: lamportsToSol(row.lamports),
        // No SOL price is captured on a transfer, and a transfer has no income
        // effect, so no USD figure is asserted.
        amountUsd: null,
        solPriceUsd: null,
        reference: row.signature ?? row.id,
        network: row.network,
        refType: row.ref_type ?? 'wallet',
        refId: row.ref_id ?? row.wallet_address,
        source: 'wallet_transactions',
        countsTowardPnl: false,
        solDerivedFromUsd: false,
      });

      if (row.fee_lamports > 0) {
        out.push({
          id: `${row.id}:fee`,
          date: new Date(row.occurred_at).toISOString(),
          occurredAtMs: row.occurred_at,
          type: 'expense',
          category: 'wallet_network_fee',
          description: `Network fee for the ${row.purpose} transfer`,
          amountSol: lamportsToSol(row.fee_lamports),
          amountUsd: null,
          solPriceUsd: null,
          reference: row.signature ?? row.id,
          network: row.network,
          refType: row.ref_type ?? 'wallet',
          refId: row.ref_id ?? row.wallet_address,
          source: 'wallet_transactions',
          countsTowardPnl: true,
          solDerivedFromUsd: false,
        });
      }
    }
    return out;
  }

  /**
   * The USD value of an entry, or null.
   *
   * Preference order: the USD value recorded with the event, then the SOL
   * amount at the price recorded with the event. There is no third option on
   * purpose — no latest-known price, no daily average, no zero.
   */
  private usdFor(amountSol: number, recordedUsd: number | null, solPriceUsd: number | null): number | null {
    if (recordedUsd !== null && Number.isFinite(recordedUsd) && recordedUsd !== 0) return recordedUsd;
    if (solPriceUsd !== null && Number.isFinite(solPriceUsd) && solPriceUsd > 0) return amountSol * solPriceUsd;
    return null;
  }
}

/**
 * RFC 4180 field encoding: quote a field that contains a comma, a quote or a
 * line break, and double any embedded quote. Everything else is written bare.
 */
function csvField(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  if (!/[",\r\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}
