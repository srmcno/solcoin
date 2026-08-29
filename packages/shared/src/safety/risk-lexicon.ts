import type { RiskFlag } from '../domain/enums.js';
import { normalise } from '../text/normalise.js';

/**
 * Deterministic pre-screen for concept risk.
 *
 * This runs *before* any AI risk review and is not optional: it is cheap, it
 * cannot be argued out of by a persuasive model, and it catches the categories
 * where a mistake is expensive (impersonation, protected IP, financial claims).
 *
 * It is intentionally conservative and will produce false positives. Anything it
 * flags is either blocked outright or routed to human review — never silently
 * launched.
 */

export interface RiskRule {
  flag: RiskFlag;
  /** `block` prevents launch entirely; `review` forces human approval. */
  severity: 'block' | 'review' | 'note';
  label: string;
  test: RegExp;
}

/**
 * Well-known marks and characters. Not exhaustive by any means — it is a
 * high-signal starting set, and the AI risk reviewer plus the human approval
 * gate cover the long tail.
 */
const PROTECTED_MARKS = [
  'disney', 'pixar', 'marvel', 'dc comics', 'nintendo', 'pokemon', 'pokémon', 'pikachu',
  'mario', 'zelda', 'sonic the hedgehog', 'star wars', 'jedi', 'darth vader', 'harry potter',
  'hogwarts', 'lord of the rings', 'game of thrones', 'minecraft', 'fortnite', 'roblox',
  'hello kitty', 'spongebob', 'simpsons', 'south park', 'rick and morty', 'family guy',
  'batman', 'superman', 'spiderman', 'spider-man', 'iron man', 'avengers', 'barbie',
  'coca cola', 'coca-cola', 'pepsi', 'mcdonald', 'nike', 'adidas', 'gucci', 'louis vuitton',
  'apple inc', 'iphone', 'google', 'youtube', 'meta platforms', 'facebook', 'instagram',
  'tiktok', 'netflix', 'amazon', 'microsoft', 'openai', 'chatgpt', 'anthropic', 'claude ai',
  'tesla', 'spacex', 'nvidia', 'binance', 'coinbase', 'solana foundation', 'pump.fun',
  'nfl', 'nba', 'fifa', 'olympics', 'ufc', 'premier league', 'formula 1', 'ferrari',
];

const IMPERSONATION_PATTERNS = [
  /\bofficial\b/i,
  /\bverified\b/i,
  /\bpartnership with\b/i,
  /\bendorsed by\b/i,
  /\bbacked by\b/i,
  /\bin collaboration with\b/i,
  /\bteam\b.*\b(token|coin)\b/i,
  /\bthe real\b/i,
];

const FINANCIAL_CLAIM_PATTERNS = [
  /\bguaranteed\b/i,
  /\bguarantee(s|d)? (returns?|profits?|gains?)\b/i,
  /\brisk[- ]free\b/i,
  /\bcan'?t lose\b/i,
  /\bassured (returns?|profits?)\b/i,
  /\b(1000|100|10)x guaranteed\b/i,
  /\bpassive income\b/i,
  /\bwill (moon|pump|explode|10x|100x)\b/i,
  /\bnext (bitcoin|ethereum|solana|doge)\b/i,
  /\binvestment opportunity\b/i,
  /\bfinancial advice\b/i,
  /\byield\b.*\bguaranteed\b/i,
];

export const RISK_RULES: RiskRule[] = [
  ...PROTECTED_MARKS.map(
    (mark): RiskRule => ({
      flag: mark.match(/inc|google|apple|microsoft|tesla|binance|coinbase|nike|adidas|pepsi|mcdonald|amazon|netflix|meta|openai|anthropic|nvidia|spacex|pump\.fun/)
        ? 'company_impersonation'
        : 'copyrighted_character',
      severity: 'block',
      label: `References protected mark or property: "${mark}"`,
      test: new RegExp(`\\b${mark.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i'),
    }),
  ),
  ...IMPERSONATION_PATTERNS.map(
    (test, i): RiskRule => ({
      flag: 'company_impersonation',
      severity: 'review',
      label: `Implies an official relationship or endorsement (pattern ${i + 1})`,
      test,
    }),
  ),
  ...FINANCIAL_CLAIM_PATTERNS.map(
    (test, i): RiskRule => ({
      flag: 'misleading_financial_claim',
      severity: 'block',
      label: `Makes a financial promise or return claim (pattern ${i + 1})`,
      test,
    }),
  ),
  {
    flag: 'hate_or_harassment',
    severity: 'block',
    label: 'Slur, hate symbol or targeted harassment language',
    test: /\b(n[i1]gg|f[a4]gg|k[i1]ke|sp[i1]c\b|ch[i1]nk\b|tr[a4]nn[yi]|retard|holocaust|nazi|hitler|kkk|white power|gas the)\b/i,
  },
  {
    flag: 'sexual_content',
    severity: 'block',
    label: 'Explicit sexual content',
    test: /\b(porn|xxx|hentai|onlyfans|nsfw|cum\b|milf|escort)\b/i,
  },
  {
    flag: 'minor_related',
    severity: 'block',
    label: 'Sexualised or exploitative reference involving minors',
    test: /\b(loli|shota|jailbait|underage|child\s?(porn|sex))\b/i,
  },
  {
    flag: 'violence',
    severity: 'block',
    label: 'Glorification of violence or a real attack',
    test: /\b(school shoot|mass shoot|terror(ist)? attack|behead|genocide|bomb (making|threat)|assassinat)\w*/i,
  },
  {
    flag: 'tragedy_exploitation',
    severity: 'block',
    label: 'Appears to monetise a real tragedy or disaster',
    test: /\b(9\/11|earthquake victim|plane crash|mass casualt|death toll|hurricane victim|wildfire victim|shooting victim|missing (child|children))\b/i,
  },
  {
    flag: 'illegal_activity',
    severity: 'block',
    label: 'References illegal goods or services',
    test: /\b(fentanyl|meth\b|cocaine|heroin|hitman|money launder|dark ?web|stolen (card|data)|carding)\b/i,
  },
  {
    flag: 'medical_or_legal_claim',
    severity: 'review',
    label: 'Makes a medical or legal claim',
    test: /\b(cure(s|d)?\s+(cancer|covid|disease)|treats?\s+\w+\s+disease|fda[- ]approved|clinically proven)\b/i,
  },
  {
    flag: 'election_related',
    severity: 'review',
    label: 'Election or active political-campaign content',
    test: /\b(vote for|ballot|election fraud|rigged election|campaign 20\d\d|presidential (race|campaign))\b/i,
  },
  {
    flag: 'real_person',
    severity: 'review',
    label: 'Appears to reference a specific named private or public individual',
    // Two capitalised words that are not at the start of a sentence is a weak
    // but useful proper-noun signal; the AI reviewer adjudicates.
    test: /\b(?:mr|mrs|ms|dr|president|senator|ceo|prince|princess|king|queen)\.?\s+[A-Z][a-z]+/,
  },
];

export interface RiskScreenResult {
  flags: Array<{ flag: RiskFlag; severity: RiskRule['severity']; label: string; matched: string }>;
  blocked: boolean;
  requiresReview: boolean;
}

export function screenRisk(...texts: Array<string | undefined>): RiskScreenResult {
  const haystack = texts.filter(Boolean).join('\n');
  const normalised = normalise(haystack);
  const flags: RiskScreenResult['flags'] = [];
  const seen = new Set<string>();

  for (const rule of RISK_RULES) {
    // Run case-sensitive rules against the original text, others against the
    // normalised form so that leetspeak and casing tricks do not evade them.
    const target = rule.test.flags.includes('i') ? normalised : haystack;
    const match = target.match(rule.test);
    if (!match) continue;
    const key = `${rule.flag}:${rule.label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    flags.push({ flag: rule.flag, severity: rule.severity, label: rule.label, matched: match[0] });
  }

  return {
    flags,
    blocked: flags.some((f) => f.severity === 'block'),
    requiresReview: flags.some((f) => f.severity === 'review'),
  };
}
