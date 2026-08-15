/**
 * Model lifecycle data, and the matching that turns a `model:` string written
 * in a config file into a lifecycle judgement.
 *
 * ## Why this is data with a date on it
 *
 * A harness accumulates model pins the way it accumulates everything else: an
 * agent written a year ago still says `claude-3-5-sonnet-20241022`, a chat mode
 * still says `gpt-4-turbo`, and nothing complains until the request fails. That
 * is exactly the sort of stale configuration this tool exists to surface.
 *
 * The catch is that "which models are old" is the one fact in this codebase
 * that rots on its own. Everything else is derived from what is on disk; this
 * table is an outside claim. So it is treated accordingly:
 *
 * - Every record comes from the vendor's own deprecation page, recorded in
 *   {@link MODEL_SOURCES}, and the whole table carries a
 *   {@link MODEL_DATA_VERIFIED_ON} date so a reader can see how stale it is.
 * - Records store the announced **shutdown date**, not a hardcoded status.
 *   Whether a model reads as `deprecated` or `retired` is computed against the
 *   current date, so the table stays correct as time passes without an edit.
 * - **Unknown model ids are never flagged.** A model this table has never heard
 *   of returns `unknown` and produces no finding. Vendors ship models faster
 *   than this file can be updated, and a false "your model is dead" is far more
 *   damaging to trust than a missed warning.
 */

/** Vendor whose lifecycle policy governs a model. */
export type ModelVendor = 'openai' | 'anthropic' | 'google';

/**
 * Lifecycle state of a model reference.
 *
 * - `active`     — listed by the vendor with no announced shutdown.
 * - `deprecated` — shutdown announced, date still in the future.
 * - `retired`    — shutdown date has passed; requests fail.
 * - `unknown`    — not in this table. Never flagged.
 */
export type ModelStatus = 'active' | 'deprecated' | 'retired' | 'unknown';

/** One model as the vendor documents it. */
export interface ModelRecord {
  /** Canonical id, exactly as the vendor writes it. */
  readonly id: string;
  readonly vendor: ModelVendor;
  /**
   * Announced shutdown date, ISO `YYYY-MM-DD`.
   *
   * Absent means the vendor lists the model with no shutdown date, which is
   * either a current model or a deprecation announced without a date.
   */
  readonly shutdownDate?: string;
  /**
   * True when the vendor has announced deprecation without giving a date.
   * Records with a `shutdownDate` do not need this.
   */
  readonly deprecatedWithoutDate?: boolean;
  /** The vendor's recommended replacement, verbatim. */
  readonly replacement?: string;
  /** Other spellings that resolve to this record. */
  readonly aliases?: readonly string[];
  /** Anything a reader needs in order to trust or discount the row. */
  readonly note?: string;
}

/** The date this table was last checked against the vendor pages. */
export const MODEL_DATA_VERIFIED_ON = '2026-08-14';

/** Where every row in {@link MODEL_RECORDS} came from. */
export const MODEL_SOURCES: Readonly<Record<ModelVendor, string>> = {
  openai: 'https://developers.openai.com/api/docs/deprecations',
  anthropic: 'https://platform.claude.com/docs/en/about-claude/model-deprecations',
  google: 'https://ai.google.dev/gemini-api/docs/deprecations',
};

/* ----------------------------------------------------------------- Data -- */

const OPENAI: readonly ModelRecord[] = [
  // Current, listed only so replacement chains have somewhere to stop.
  { id: 'gpt-5.6-sol', vendor: 'openai' },
  { id: 'gpt-5.6-terra', vendor: 'openai' },
  { id: 'gpt-5.6-luna', vendor: 'openai' },
  { id: 'gpt-5.5', vendor: 'openai' },
  { id: 'gpt-5.4', vendor: 'openai' },
  { id: 'gpt-5.3-codex', vendor: 'openai' },
  { id: 'gpt-image-2', vendor: 'openai' },
  { id: 'gpt-audio-1.5', vendor: 'openai' },
  { id: 'gpt-realtime-2.1', vendor: 'openai' },
  { id: 'gpt-realtime-2.1-mini', vendor: 'openai' },
  { id: 'gpt-realtime-1.5', vendor: 'openai' },
  { id: 'omni-moderation', vendor: 'openai' },
  { id: 'gpt-4o', vendor: 'openai' },
  { id: 'gpt-4o-mini', vendor: 'openai' },
  { id: 'gpt-4.1', vendor: 'openai' },
  { id: 'gpt-4.1-mini', vendor: 'openai' },
  { id: 'gpt-4o-mini-transcribe-2025-12-15', vendor: 'openai' },

  // Announced 2026-07-20: legacy audio, realtime, and transcription families.
  {
    id: 'gpt-realtime',
    vendor: 'openai',
    shutdownDate: '2027-01-20',
    replacement: 'gpt-realtime-2.1',
  },
  { id: 'gpt-audio', vendor: 'openai', shutdownDate: '2027-01-20', replacement: 'gpt-audio-1.5' },
  {
    id: 'gpt-4o-audio',
    vendor: 'openai',
    shutdownDate: '2027-01-20',
    replacement: 'gpt-audio-1.5',
  },
  {
    id: 'gpt-4o-realtime',
    vendor: 'openai',
    shutdownDate: '2027-01-20',
    replacement: 'gpt-realtime-2.1',
  },
  {
    id: 'gpt-realtime-mini',
    vendor: 'openai',
    shutdownDate: '2027-01-20',
    replacement: 'gpt-realtime-2.1-mini',
  },
  {
    id: 'gpt-audio-mini',
    vendor: 'openai',
    shutdownDate: '2027-01-20',
    replacement: 'gpt-audio-1.5',
  },
  {
    id: 'gpt-4o-mini-realtime',
    vendor: 'openai',
    shutdownDate: '2027-01-20',
    replacement: 'gpt-realtime-2.1-mini',
  },
  {
    id: 'gpt-4o-mini-audio',
    vendor: 'openai',
    shutdownDate: '2027-01-20',
    replacement: 'gpt-audio-1.5',
  },
  {
    id: 'gpt-4o-mini-transcribe-2025-03-20',
    vendor: 'openai',
    shutdownDate: '2027-01-20',
    replacement: 'gpt-4o-mini-transcribe-2025-12-15',
  },

  // Announced 2026-06-11: older GPT-5 and o3 snapshots.
  {
    id: 'gpt-5-2025-08-07',
    vendor: 'openai',
    shutdownDate: '2026-12-11',
    replacement: 'gpt-5.6-sol',
    aliases: ['gpt-5'],
  },
  {
    id: 'gpt-5-mini-2025-08-07',
    vendor: 'openai',
    shutdownDate: '2026-12-11',
    replacement: 'gpt-5.6-terra',
    aliases: ['gpt-5-mini'],
  },
  {
    id: 'gpt-5-nano-2025-08-07',
    vendor: 'openai',
    shutdownDate: '2026-12-11',
    replacement: 'gpt-5.6-luna',
    aliases: ['gpt-5-nano'],
  },
  {
    id: 'gpt-5-pro-2025-10-06',
    vendor: 'openai',
    shutdownDate: '2026-12-11',
    replacement: 'gpt-5.6-sol',
    aliases: ['gpt-5-pro'],
  },
  {
    id: 'o3-2025-04-16',
    vendor: 'openai',
    shutdownDate: '2026-12-11',
    replacement: 'gpt-5.6-sol',
    aliases: ['o3'],
  },
  {
    id: 'o3-pro-2025-06-10',
    vendor: 'openai',
    shutdownDate: '2026-12-11',
    replacement: 'gpt-5.6-sol',
    aliases: ['o3-pro'],
  },

  // Announced 2026-06-02: older GPT Image models.
  {
    id: 'gpt-image-1-mini',
    vendor: 'openai',
    shutdownDate: '2026-12-01',
    replacement: 'gpt-image-2',
  },
  { id: 'gpt-image-1.5', vendor: 'openai', shutdownDate: '2026-12-01', replacement: 'gpt-image-2' },
  {
    id: 'chatgpt-image-latest',
    vendor: 'openai',
    shutdownDate: '2026-12-01',
    replacement: 'gpt-image-2',
  },

  // Announced 2026-04-22: legacy GPT snapshots, October 2026 shutdown.
  {
    id: 'gpt-3.5-turbo-0125',
    vendor: 'openai',
    shutdownDate: '2026-10-23',
    replacement: 'gpt-5.6-terra',
    aliases: ['gpt-3.5-turbo', 'gpt-3.5-turbo-completions', 'gpt-35-turbo'],
  },
  {
    id: 'gpt-4-0613',
    vendor: 'openai',
    shutdownDate: '2026-10-23',
    replacement: 'gpt-5.6-sol',
    aliases: ['gpt-4', 'gpt-4-0613-completions', 'gpt-4-completions'],
  },
  {
    id: 'gpt-4-turbo',
    vendor: 'openai',
    shutdownDate: '2026-10-23',
    replacement: 'gpt-5.6-sol',
    aliases: ['gpt-4-turbo-2024-04-09', 'gpt-4-turbo-completions'],
  },
  {
    id: 'gpt-4.1-nano',
    vendor: 'openai',
    shutdownDate: '2026-10-23',
    replacement: 'gpt-5.6-luna',
    aliases: ['gpt-4.1-nano-2025-04-14'],
  },
  {
    id: 'gpt-4o-2024-05-13',
    vendor: 'openai',
    shutdownDate: '2026-10-23',
    replacement: 'gpt-5.6-sol',
  },
  { id: 'gpt-image-1', vendor: 'openai', shutdownDate: '2026-10-23', replacement: 'gpt-image-2' },
  {
    id: 'o1-2024-12-17',
    vendor: 'openai',
    shutdownDate: '2026-10-23',
    replacement: 'gpt-5.6-sol',
    aliases: ['o1'],
  },
  {
    id: 'o1-pro-2025-03-19',
    vendor: 'openai',
    shutdownDate: '2026-10-23',
    replacement: 'gpt-5.6-sol',
    aliases: ['o1-pro'],
  },
  {
    id: 'o3-mini-2025-01-31',
    vendor: 'openai',
    shutdownDate: '2026-10-23',
    replacement: 'gpt-5.6-sol',
    aliases: ['o3-mini'],
  },
  {
    id: 'o4-mini-2025-04-16',
    vendor: 'openai',
    shutdownDate: '2026-10-23',
    replacement: 'gpt-5.6-terra',
    aliases: ['o4-mini'],
  },

  // Announced 2025-09-26: September 2026 shutdown.
  {
    id: 'gpt-3.5-turbo-instruct',
    vendor: 'openai',
    shutdownDate: '2026-09-28',
    replacement: 'gpt-5.6-terra',
  },
  { id: 'babbage-002', vendor: 'openai', shutdownDate: '2026-09-28', replacement: 'gpt-5.6-terra' },
  { id: 'davinci-002', vendor: 'openai', shutdownDate: '2026-09-28', replacement: 'gpt-5.6-terra' },
  {
    id: 'gpt-3.5-turbo-1106',
    vendor: 'openai',
    shutdownDate: '2026-09-28',
    replacement: 'gpt-5.6-terra',
  },

  // Announced 2026-03-24: Sora 2 video models. No replacement offered.
  { id: 'sora-2', vendor: 'openai', shutdownDate: '2026-09-24' },
  { id: 'sora-2-pro', vendor: 'openai', shutdownDate: '2026-09-24' },
  { id: 'sora-2-2025-10-06', vendor: 'openai', shutdownDate: '2026-09-24' },
  { id: 'sora-2-2025-12-08', vendor: 'openai', shutdownDate: '2026-09-24' },
  { id: 'sora-2-pro-2025-10-06', vendor: 'openai', shutdownDate: '2026-09-24' },

  // Already shut down.
  {
    id: 'gpt-5.2-chat-latest',
    vendor: 'openai',
    shutdownDate: '2026-08-10',
    replacement: 'gpt-5.6-sol',
  },
  {
    id: 'gpt-5.3-chat-latest',
    vendor: 'openai',
    shutdownDate: '2026-08-10',
    replacement: 'gpt-5.6-sol',
  },
  {
    id: 'computer-use-preview',
    vendor: 'openai',
    shutdownDate: '2026-07-23',
    replacement: 'gpt-5.6-terra',
    aliases: ['computer-use-preview-2025-03-11'],
  },
  {
    id: 'gpt-4o-mini-search-preview-2025-03-11',
    vendor: 'openai',
    shutdownDate: '2026-07-23',
    replacement: 'gpt-5.6-terra',
  },
  {
    id: 'gpt-4o-search-preview-2025-03-11',
    vendor: 'openai',
    shutdownDate: '2026-07-23',
    replacement: 'gpt-5.6-terra',
  },
  {
    id: 'gpt-5-chat-latest',
    vendor: 'openai',
    shutdownDate: '2026-07-23',
    replacement: 'gpt-5.6-sol',
  },
  { id: 'gpt-5-codex', vendor: 'openai', shutdownDate: '2026-07-23', replacement: 'gpt-5.6-sol' },
  {
    id: 'gpt-5.1-chat-latest',
    vendor: 'openai',
    shutdownDate: '2026-07-23',
    replacement: 'gpt-5.6-sol',
  },
  { id: 'gpt-5.1-codex', vendor: 'openai', shutdownDate: '2026-07-23', replacement: 'gpt-5.6-sol' },
  {
    id: 'gpt-5.1-codex-max',
    vendor: 'openai',
    shutdownDate: '2026-07-23',
    replacement: 'gpt-5.6-sol',
  },
  {
    id: 'gpt-5.1-codex-mini',
    vendor: 'openai',
    shutdownDate: '2026-07-23',
    replacement: 'gpt-5.6-terra',
  },
  { id: 'gpt-5.2-codex', vendor: 'openai', shutdownDate: '2026-07-23', replacement: 'gpt-5.6-sol' },
  {
    id: 'gpt-audio-mini-2025-10-06',
    vendor: 'openai',
    shutdownDate: '2026-07-23',
    replacement: 'gpt-audio-1.5',
  },
  {
    id: 'gpt-realtime-mini-2025-10-06',
    vendor: 'openai',
    shutdownDate: '2026-07-23',
    replacement: 'gpt-realtime-2.1-mini',
  },
  {
    id: 'o3-deep-research',
    vendor: 'openai',
    shutdownDate: '2026-07-23',
    replacement: 'gpt-5.6-sol',
    aliases: ['o3-deep-research-2025-06-26'],
  },
  {
    id: 'o4-mini-deep-research',
    vendor: 'openai',
    shutdownDate: '2026-07-23',
    replacement: 'gpt-5.6-sol',
    aliases: ['o4-mini-deep-research-2025-06-26'],
  },
  { id: 'dall-e-2', vendor: 'openai', shutdownDate: '2026-05-12', replacement: 'gpt-image-2' },
  { id: 'dall-e-3', vendor: 'openai', shutdownDate: '2026-05-12', replacement: 'gpt-image-2' },
  {
    id: 'gpt-4o-realtime-preview',
    vendor: 'openai',
    shutdownDate: '2026-05-07',
    replacement: 'gpt-realtime-1.5',
    aliases: ['gpt-4o-realtime-preview-2025-06-03', 'gpt-4o-realtime-preview-2024-12-17'],
  },
  {
    id: 'gpt-4o-mini-realtime-preview',
    vendor: 'openai',
    shutdownDate: '2026-05-07',
    replacement: 'gpt-realtime-mini',
  },
  {
    id: 'gpt-4o-audio-preview',
    vendor: 'openai',
    shutdownDate: '2026-05-07',
    replacement: 'gpt-audio-1.5',
  },
  {
    id: 'gpt-4o-mini-audio-preview',
    vendor: 'openai',
    shutdownDate: '2026-05-07',
    replacement: 'gpt-audio-mini',
  },
  {
    id: 'gpt-4o-realtime-preview-2024-10-01',
    vendor: 'openai',
    shutdownDate: '2025-10-10',
    replacement: 'gpt-realtime-1.5',
  },
  {
    id: 'gpt-4o-audio-preview-2024-10-01',
    vendor: 'openai',
    shutdownDate: '2025-10-10',
    replacement: 'gpt-audio-1.5',
  },
  {
    id: 'chatgpt-4o-latest',
    vendor: 'openai',
    shutdownDate: '2026-02-17',
    replacement: 'gpt-5.1-chat-latest',
  },
  {
    id: 'codex-mini-latest',
    vendor: 'openai',
    shutdownDate: '2026-02-12',
    replacement: 'gpt-5.3-codex',
    note: 'OpenAI named gpt-5-codex-mini in the notice; that model has since been superseded, so the current Codex model is suggested instead.',
  },
  {
    id: 'gpt-4-0314',
    vendor: 'openai',
    shutdownDate: '2026-03-26',
    replacement: 'gpt-4.1',
    note: 'OpenAI recommended GPT-5 or, for latency-sensitive work that does not need reasoning, GPT-4.1.',
  },
  {
    id: 'gpt-4-1106-preview',
    vendor: 'openai',
    shutdownDate: '2026-03-26',
    replacement: 'gpt-4.1',
    note: 'Listed in both the March 2026 past deprecations and the October 2026 upcoming batch; the earlier shutdown is used here.',
  },
  {
    id: 'gpt-4-0125-preview',
    vendor: 'openai',
    shutdownDate: '2026-03-26',
    replacement: 'gpt-4.1',
    aliases: ['gpt-4-turbo-preview', 'gpt-4-turbo-preview-completions'],
  },
  {
    id: 'text-moderation-007',
    vendor: 'openai',
    shutdownDate: '2025-10-27',
    replacement: 'omni-moderation',
  },
  {
    id: 'text-moderation-stable',
    vendor: 'openai',
    shutdownDate: '2025-10-27',
    replacement: 'omni-moderation',
  },
  {
    id: 'text-moderation-latest',
    vendor: 'openai',
    shutdownDate: '2025-10-27',
    replacement: 'omni-moderation',
  },
  { id: 'o1-preview', vendor: 'openai', shutdownDate: '2025-07-28', replacement: 'o3' },
  { id: 'o1-mini', vendor: 'openai', shutdownDate: '2025-10-27', replacement: 'o4-mini' },
  { id: 'gpt-4.5-preview', vendor: 'openai', shutdownDate: '2025-07-14', replacement: 'gpt-4.1' },
  {
    id: 'gpt-4-32k',
    vendor: 'openai',
    shutdownDate: '2025-06-06',
    replacement: 'gpt-4o',
    aliases: ['gpt-4-32k-0613', 'gpt-4-32k-0314'],
  },
  {
    id: 'gpt-4-vision-preview',
    vendor: 'openai',
    shutdownDate: '2024-12-06',
    replacement: 'gpt-4o',
  },
];

const ANTHROPIC: readonly ModelRecord[] = [
  // Active.
  { id: 'claude-fable-5', vendor: 'anthropic' },
  { id: 'claude-opus-5', vendor: 'anthropic' },
  { id: 'claude-opus-4-8', vendor: 'anthropic' },
  { id: 'claude-opus-4-7', vendor: 'anthropic' },
  { id: 'claude-opus-4-6', vendor: 'anthropic' },
  { id: 'claude-opus-4-5-20251101', vendor: 'anthropic', aliases: ['claude-opus-4-5'] },
  { id: 'claude-sonnet-5', vendor: 'anthropic' },
  { id: 'claude-sonnet-4-6', vendor: 'anthropic' },
  { id: 'claude-sonnet-4-5-20250929', vendor: 'anthropic', aliases: ['claude-sonnet-4-5'] },
  { id: 'claude-haiku-4-5-20251001', vendor: 'anthropic', aliases: ['claude-haiku-4-5'] },
  { id: 'claude-mythos-5', vendor: 'anthropic' },

  // Deprecated without a published retirement date.
  {
    id: 'claude-mythos-preview',
    vendor: 'anthropic',
    deprecatedWithoutDate: true,
    replacement: 'claude-mythos-5',
  },

  // Retired.
  {
    id: 'claude-opus-4-1-20250805',
    vendor: 'anthropic',
    shutdownDate: '2026-08-05',
    replacement: 'claude-opus-4-8',
    aliases: ['claude-opus-4-1'],
  },
  {
    id: 'claude-opus-4-20250514',
    vendor: 'anthropic',
    shutdownDate: '2026-06-15',
    replacement: 'claude-opus-4-8',
    aliases: ['claude-opus-4-0'],
  },
  {
    id: 'claude-sonnet-4-20250514',
    vendor: 'anthropic',
    shutdownDate: '2026-06-15',
    replacement: 'claude-sonnet-4-6',
    aliases: ['claude-sonnet-4-0'],
  },
  {
    id: 'claude-3-7-sonnet-20250219',
    vendor: 'anthropic',
    shutdownDate: '2026-02-19',
    replacement: 'claude-sonnet-4-6',
    aliases: ['claude-3-7-sonnet-latest'],
  },
  {
    id: 'claude-3-5-haiku-20241022',
    vendor: 'anthropic',
    shutdownDate: '2026-02-19',
    replacement: 'claude-haiku-4-5-20251001',
    aliases: ['claude-3-5-haiku-latest'],
  },
  {
    id: 'claude-3-haiku-20240307',
    vendor: 'anthropic',
    shutdownDate: '2026-04-20',
    replacement: 'claude-haiku-4-5-20251001',
  },
  {
    id: 'claude-3-5-sonnet-20240620',
    vendor: 'anthropic',
    shutdownDate: '2025-10-28',
    replacement: 'claude-sonnet-4-6',
  },
  {
    id: 'claude-3-5-sonnet-20241022',
    vendor: 'anthropic',
    shutdownDate: '2025-10-28',
    replacement: 'claude-sonnet-4-6',
    aliases: ['claude-3-5-sonnet-latest'],
  },
  {
    id: 'claude-3-opus-20240229',
    vendor: 'anthropic',
    shutdownDate: '2026-01-05',
    replacement: 'claude-opus-4-8',
    aliases: ['claude-3-opus-latest'],
  },
  {
    id: 'claude-2.0',
    vendor: 'anthropic',
    shutdownDate: '2025-07-21',
    replacement: 'claude-opus-4-8',
  },
  {
    id: 'claude-2.1',
    vendor: 'anthropic',
    shutdownDate: '2025-07-21',
    replacement: 'claude-opus-4-8',
  },
  {
    id: 'claude-3-sonnet-20240229',
    vendor: 'anthropic',
    shutdownDate: '2025-07-21',
    replacement: 'claude-sonnet-4-6',
  },
  {
    id: 'claude-1.0',
    vendor: 'anthropic',
    shutdownDate: '2024-11-06',
    replacement: 'claude-haiku-4-5-20251001',
  },
  {
    id: 'claude-1.1',
    vendor: 'anthropic',
    shutdownDate: '2024-11-06',
    replacement: 'claude-haiku-4-5-20251001',
  },
  {
    id: 'claude-1.2',
    vendor: 'anthropic',
    shutdownDate: '2024-11-06',
    replacement: 'claude-haiku-4-5-20251001',
  },
  {
    id: 'claude-1.3',
    vendor: 'anthropic',
    shutdownDate: '2024-11-06',
    replacement: 'claude-haiku-4-5-20251001',
  },
  {
    id: 'claude-instant-1.0',
    vendor: 'anthropic',
    shutdownDate: '2024-11-06',
    replacement: 'claude-haiku-4-5-20251001',
  },
  {
    id: 'claude-instant-1.1',
    vendor: 'anthropic',
    shutdownDate: '2024-11-06',
    replacement: 'claude-haiku-4-5-20251001',
  },
  {
    id: 'claude-instant-1.2',
    vendor: 'anthropic',
    shutdownDate: '2024-11-06',
    replacement: 'claude-haiku-4-5-20251001',
  },
];

const GOOGLE: readonly ModelRecord[] = [
  // Active.
  { id: 'gemini-3.7-flash', vendor: 'google' },
  { id: 'gemini-3.6-flash', vendor: 'google' },
  { id: 'gemini-3.5-flash', vendor: 'google' },
  { id: 'gemini-3.5-flash-lite', vendor: 'google' },
  { id: 'gemini-3.1-flash-image', vendor: 'google' },
  { id: 'gemini-3-pro-image', vendor: 'google' },
  { id: 'gemini-3.1-pro-preview', vendor: 'google' },
  { id: 'gemini-3.1-flash-live-preview', vendor: 'google' },
  { id: 'gemini-3.1-flash-tts-preview', vendor: 'google' },
  { id: 'gemini-2.5-pro', vendor: 'google' },
  { id: 'gemini-2.5-flash', vendor: 'google' },
  { id: 'gemini-2.5-flash-lite', vendor: 'google' },
  { id: 'gemini-embedding-2', vendor: 'google' },

  // Deprecated with a future shutdown.
  {
    id: 'gemini-3.1-flash-lite',
    vendor: 'google',
    shutdownDate: '2027-05-07',
    replacement: 'gemini-3.5-flash-lite',
  },
  {
    id: 'gemini-2.5-flash-image',
    vendor: 'google',
    shutdownDate: '2026-10-02',
    replacement: 'gemini-3.1-flash-image-preview',
  },
  {
    id: 'gemini-embedding-001',
    vendor: 'google',
    shutdownDate: '2028-05-14',
    replacement: 'gemini-embedding-2',
  },
  {
    id: 'imagen-4.0-generate-001',
    vendor: 'google',
    shutdownDate: '2026-08-17',
    replacement: 'gemini-3.1-flash-image',
  },
  {
    id: 'imagen-4.0-ultra-generate-001',
    vendor: 'google',
    shutdownDate: '2026-08-17',
    replacement: 'gemini-3.1-flash-image',
  },
  {
    id: 'imagen-4.0-fast-generate-001',
    vendor: 'google',
    shutdownDate: '2026-08-17',
    replacement: 'gemini-3.1-flash-image',
  },

  // Deprecated without a published shutdown date.
  {
    id: 'gemini-3-flash-preview',
    vendor: 'google',
    deprecatedWithoutDate: true,
    replacement: 'gemini-3.6-flash',
  },
  {
    id: 'gemini-2.5-flash-native-audio-preview-12-2025',
    vendor: 'google',
    deprecatedWithoutDate: true,
    replacement: 'gemini-3.1-flash-live-preview',
  },
  {
    id: 'gemini-2.5-flash-preview-tts',
    vendor: 'google',
    deprecatedWithoutDate: true,
    replacement: 'gemini-3.1-flash-tts-preview',
  },
  {
    id: 'gemini-2.5-pro-preview-tts',
    vendor: 'google',
    deprecatedWithoutDate: true,
    replacement: 'gemini-3.1-flash-tts-preview',
  },

  // Shut down.
  {
    id: 'gemini-3.1-flash-image-preview',
    vendor: 'google',
    shutdownDate: '2026-06-25',
    replacement: 'gemini-3.1-flash-image',
  },
  {
    id: 'gemini-3-pro-image-preview',
    vendor: 'google',
    shutdownDate: '2026-06-25',
    replacement: 'gemini-3-pro-image',
  },
  {
    id: 'gemini-3-pro-preview',
    vendor: 'google',
    shutdownDate: '2026-03-09',
    replacement: 'gemini-3.1-pro-preview',
  },
  {
    id: 'gemini-3.1-flash-lite-preview',
    vendor: 'google',
    shutdownDate: '2026-05-25',
    replacement: 'gemini-3.1-flash-lite',
  },
  {
    id: 'gemini-2.5-pro-preview-03-25',
    vendor: 'google',
    shutdownDate: '2025-12-02',
    replacement: 'gemini-3.1-pro-preview',
  },
  {
    id: 'gemini-2.5-pro-preview-05-06',
    vendor: 'google',
    shutdownDate: '2025-12-02',
    replacement: 'gemini-3.1-pro-preview',
  },
  {
    id: 'gemini-2.5-pro-preview-06-05',
    vendor: 'google',
    shutdownDate: '2025-12-02',
    replacement: 'gemini-3.1-pro-preview',
  },
  {
    id: 'gemini-2.5-flash-lite-preview-09-2025',
    vendor: 'google',
    shutdownDate: '2026-03-31',
    replacement: 'gemini-3.1-flash-lite',
  },
  {
    id: 'gemini-2.5-flash-preview-05-20',
    vendor: 'google',
    shutdownDate: '2025-11-18',
    replacement: 'gemini-3.6-flash',
  },
  {
    id: 'gemini-2.5-flash-preview-09-25',
    vendor: 'google',
    shutdownDate: '2026-02-17',
    replacement: 'gemini-3.6-flash',
  },
  {
    id: 'gemini-2.5-flash-image-preview',
    vendor: 'google',
    shutdownDate: '2026-01-15',
    replacement: 'gemini-2.5-flash-image',
  },
  {
    id: 'gemini-2.0-flash',
    vendor: 'google',
    shutdownDate: '2026-06-01',
    replacement: 'gemini-3.6-flash',
    aliases: ['gemini-2.0-flash-001'],
  },
  {
    id: 'gemini-2.0-flash-lite',
    vendor: 'google',
    shutdownDate: '2026-06-01',
    replacement: 'gemini-3.1-flash-lite',
    aliases: ['gemini-2.0-flash-lite-001'],
  },
  {
    id: 'gemini-2.0-flash-preview-image-generation',
    vendor: 'google',
    shutdownDate: '2025-11-14',
    replacement: 'gemini-2.5-flash-image',
  },
  {
    id: 'gemini-2.0-flash-lite-preview',
    vendor: 'google',
    shutdownDate: '2025-12-09',
    replacement: 'gemini-2.5-flash-lite',
    aliases: ['gemini-2.0-flash-lite-preview-02-05'],
  },
  {
    id: 'gemini-2.0-flash-live-001',
    vendor: 'google',
    shutdownDate: '2025-12-09',
    replacement: 'gemini-3.1-flash-live-preview',
  },
  {
    id: 'gemini-live-2.5-flash-preview',
    vendor: 'google',
    shutdownDate: '2025-12-09',
    replacement: 'gemini-3.1-flash-live-preview',
  },
  {
    id: 'text-embedding-004',
    vendor: 'google',
    shutdownDate: '2026-01-14',
    replacement: 'gemini-embedding-2',
  },
  {
    id: 'embedding-2-preview',
    vendor: 'google',
    shutdownDate: '2026-08-10',
    replacement: 'gemini-embedding-2',
  },
  {
    id: 'embedding-001',
    vendor: 'google',
    shutdownDate: '2025-10-30',
    replacement: 'gemini-embedding-2',
  },
  {
    id: 'embedding-gecko-001',
    vendor: 'google',
    shutdownDate: '2025-10-30',
    replacement: 'gemini-embedding-2',
  },
  {
    id: 'gemini-embedding-exp',
    vendor: 'google',
    shutdownDate: '2025-10-30',
    replacement: 'gemini-embedding-2',
    aliases: ['gemini-embedding-exp-03-07'],
  },
  {
    id: 'imagen-3.0-generate-002',
    vendor: 'google',
    shutdownDate: '2025-11-10',
    replacement: 'imagen-4.0-generate-001',
  },
  {
    id: 'imagen-4.0-generate-preview-06-06',
    vendor: 'google',
    shutdownDate: '2026-02-17',
    replacement: 'imagen-4.0-generate-001',
  },
  {
    id: 'imagen-4.0-ultra-generate-preview-06-06',
    vendor: 'google',
    shutdownDate: '2026-02-17',
    replacement: 'imagen-4.0-ultra-generate-001',
  },

  // The Gemini 1.x family. These carry no shutdown date because Google no
  // longer publishes one: they have dropped off both the model list and the
  // deprecation schedule entirely, which is itself the evidence that they are
  // gone. Recorded without a date rather than with an invented one.
  {
    id: 'gemini-1.5-pro',
    vendor: 'google',
    replacement: 'gemini-2.5-pro',
    note: 'No longer listed in the Gemini API model or deprecation tables.',
    aliases: ['gemini-1.5-pro-latest', 'gemini-1.5-pro-001', 'gemini-1.5-pro-002'],
  },
  {
    id: 'gemini-1.5-flash',
    vendor: 'google',
    replacement: 'gemini-3.6-flash',
    note: 'No longer listed in the Gemini API model or deprecation tables.',
    aliases: [
      'gemini-1.5-flash-latest',
      'gemini-1.5-flash-001',
      'gemini-1.5-flash-002',
      'gemini-1.5-flash-8b',
    ],
  },
  {
    id: 'gemini-1.0-pro',
    vendor: 'google',
    replacement: 'gemini-2.5-pro',
    note: 'No longer listed in the Gemini API model or deprecation tables.',
    aliases: ['gemini-pro', 'gemini-pro-vision', 'gemini-1.0-pro-vision'],
  },
];

/** Every model this build knows about. */
export const MODEL_RECORDS: readonly ModelRecord[] = [...OPENAI, ...ANTHROPIC, ...GOOGLE];

/**
 * Records whose id carries no shutdown date but which are still gone.
 *
 * Kept as a set rather than a status field so the data rows stay purely
 * factual; see the Gemini 1.x note above for why these exist at all.
 */
const RETIRED_WITHOUT_DATE = new Set(['gemini-1.5-pro', 'gemini-1.5-flash', 'gemini-1.0-pro']);

/* ------------------------------------------------------------- Matching -- */

/**
 * Prefixes that name a routing provider rather than the model.
 *
 * Aider, Continue, OpenCode, and friends all address models as
 * `openai/gpt-4o` or `anthropic.claude-...`; the vendor tables use the bare id.
 */
const ROUTING_PREFIXES = [
  'openai/',
  'openai.',
  'anthropic/',
  'anthropic.',
  'google/',
  'google.',
  'gemini/',
  'vertex_ai/',
  'vertex/',
  'bedrock/',
  'azure/',
  'azure_ai/',
  'openrouter/',
  'github/',
  'github-copilot/',
  'copilot/',
  'litellm/',
  'models/',
];

/** Bedrock cross-region inference prefixes, which are not part of the id. */
const REGION_PREFIXES = ['us.', 'eu.', 'apac.', 'us-gov.'];

const RECORD_INDEX = buildIndex();

function buildIndex(): Map<string, ModelRecord> {
  const index = new Map<string, ModelRecord>();
  const add = (key: string, record: ModelRecord): void => {
    for (const variant of matchKeys(key)) {
      if (!index.has(variant)) index.set(variant, record);
    }
  };
  for (const record of MODEL_RECORDS) {
    add(record.id, record);
    for (const alias of record.aliases ?? []) add(alias, record);
  }
  return index;
}

/**
 * Every spelling a single id should answer to.
 *
 * Vendors write `claude-sonnet-4-6` while editors write `claude-sonnet-4.6`,
 * and both appear in real config files, so each key is registered in its dotted
 * and dashed forms.
 */
function matchKeys(id: string): string[] {
  const base = id.toLowerCase();
  const dashed = base.replace(/(\d)\.(\d)/g, '$1-$2');
  const dotted = base.replace(/(\d)-(\d)/g, '$1.$2');
  return [...new Set([base, dashed, dotted])];
}

/**
 * Reduces a model reference as written in a config file to a comparable id.
 *
 * Strips routing prefixes, Bedrock region prefixes and version suffixes, Vertex
 * `@date` separators, and any `:latest`-style tag.
 */
export function normalizeModelReference(reference: string): string {
  let value = reference.trim().toLowerCase();
  if (value.startsWith('"') || value.startsWith("'")) value = value.slice(1, -1).trim();

  let changed = true;
  while (changed) {
    changed = false;
    for (const prefix of [...ROUTING_PREFIXES, ...REGION_PREFIXES]) {
      if (value.startsWith(prefix)) {
        value = value.slice(prefix.length);
        changed = true;
      }
    }
  }

  // Bedrock appends a model version, Vertex separates the snapshot with `@`.
  value = value.replace(/-v\d+:\d+$/, '').replace('@', '-');
  // A trailing `:tag` is a routing detail, but `claude-3-5-sonnet:beta` still
  // names that model.
  value = value.replace(/:[a-z0-9_-]+$/, '');
  return value.trim();
}

/** What this build can say about one model reference. */
export interface ModelAssessment {
  /** The reference exactly as it appears in the file. */
  readonly reference: string;
  /** The reference reduced to a comparable id. */
  readonly normalized: string;
  readonly status: ModelStatus;
  readonly vendor?: ModelVendor;
  /** Canonical vendor id, when the reference matched a known record. */
  readonly canonicalId?: string;
  readonly shutdownDate?: string;
  /**
   * Negative once the date has passed, so a caller can say "retired 40 days
   * ago" as easily as "retires in 40 days".
   */
  readonly daysUntilShutdown?: number;
  /**
   * Recommended replacement, followed through the chain so a retired model is
   * never suggested as the fix for another retired model.
   */
  readonly replacement?: string;
  readonly note?: string;
  /** Vendor page the record came from. */
  readonly sourceUrl?: string;
}

/** Floating aliases that always name whatever the tool currently ships. */
const FLOATING_ALIASES = new Set([
  'default',
  'inherit',
  'auto',
  'sonnet',
  'opus',
  'haiku',
  'sonnet[1m]',
  'opusplan',
]);

const DAY_MS = 86_400_000;

/**
 * Judges one model reference.
 *
 * Returns `unknown` for anything not in the table, including floating aliases
 * such as `sonnet` or `auto`, which name whatever the tool currently ships and
 * so can never be stale.
 */
export function assessModel(reference: string, now: Date = new Date()): ModelAssessment {
  const normalized = normalizeModelReference(reference);
  if (normalized.length === 0 || FLOATING_ALIASES.has(normalized)) {
    return { reference, normalized, status: 'unknown' };
  }

  const record = RECORD_INDEX.get(normalized);
  if (!record) return { reference, normalized, status: 'unknown' };

  const status = statusOf(record, now);
  const replacement = record.replacement ? resolveReplacement(record.replacement, now) : undefined;
  const days =
    record.shutdownDate === undefined
      ? undefined
      : Math.round((Date.parse(`${record.shutdownDate}T00:00:00Z`) - now.getTime()) / DAY_MS);

  return {
    reference,
    normalized,
    status,
    vendor: record.vendor,
    canonicalId: record.id,
    ...(record.shutdownDate !== undefined ? { shutdownDate: record.shutdownDate } : {}),
    ...(days !== undefined ? { daysUntilShutdown: days } : {}),
    ...(replacement !== undefined ? { replacement } : {}),
    ...(record.note !== undefined ? { note: record.note } : {}),
    sourceUrl: MODEL_SOURCES[record.vendor],
  };
}

function statusOf(record: ModelRecord, now: Date): ModelStatus {
  if (RETIRED_WITHOUT_DATE.has(record.id)) return 'retired';
  if (record.shutdownDate !== undefined) {
    return Date.parse(`${record.shutdownDate}T00:00:00Z`) <= now.getTime()
      ? 'retired'
      : 'deprecated';
  }
  return record.deprecatedWithoutDate === true ? 'deprecated' : 'active';
}

/**
 * Follows a replacement chain to something still usable.
 *
 * Vendors recommend the successor that was current when the notice was
 * published, and those successors get retired in turn. Suggesting one of those
 * would be worse than saying nothing, so the chain is walked to the end.
 */
function resolveReplacement(start: string, now: Date, depth = 0): string {
  if (depth > 5) return start;
  const record = RECORD_INDEX.get(normalizeModelReference(start));
  if (!record) return start;
  if (statusOf(record, now) !== 'retired') return record.id;
  return record.replacement ? resolveReplacement(record.replacement, now, depth + 1) : record.id;
}

/** True when a reference is worth raising with the user. */
export function isModelOutdated(assessment: ModelAssessment): boolean {
  return assessment.status === 'retired' || assessment.status === 'deprecated';
}

/**
 * Keys whose value names a model.
 *
 * Deliberately a closed list. Matching any key containing "model" would pick up
 * `modelContextProtocol` and every unrelated setting that mentions the word.
 */
const MODEL_KEYS = new Set(
  [
    'model',
    'modelId',
    'model_id',
    'modelName',
    'model_name',
    'defaultModel',
    'default_model',
    'weakModel',
    'weak_model',
    'editorModel',
    'editor_model',
    'editFormatModel',
    'smallModel',
    'small_model',
    'largeModel',
    'large_model',
    'fastModel',
    'fast_model',
    'planModel',
    'plan_model',
    'summarizeModel',
    'chatModel',
    'chat_model',
    'embeddingModel',
    'embedding_model',
    'autocompleteModel',
    'reasoningModel',
    'subagentModel',
    'agentModel',
  ].map((key) => key.toLowerCase()),
);

/** One model reference found somewhere inside a parsed document. */
export interface ModelReferenceSite {
  /** Dotted path to the value, e.g. `models.0.model`. */
  readonly path: string;
  readonly reference: string;
}

/** Depth limit for the model walk; configuration is never deeper. */
const MAX_MODEL_DEPTH = 12;
const MAX_MODEL_HITS = 50;

/**
 * Collects every model reference in a parsed configuration document.
 *
 * Walks the whole tree because tools bury these at wildly different depths:
 * Aider at the root, Continue inside a `models` array, Zed under
 * `assistant.default_model.model`.
 */
export function collectModelReferences(value: unknown): ModelReferenceSite[] {
  const hits: ModelReferenceSite[] = [];
  walk(value, '', 0, hits);
  return hits;
}

function walk(value: unknown, path: string, depth: number, hits: ModelReferenceSite[]): void {
  if (depth > MAX_MODEL_DEPTH || hits.length >= MAX_MODEL_HITS) return;

  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      walk(item, path === '' ? String(index) : `${path}.${index}`, depth + 1, hits);
    }
    return;
  }

  if (value === null || typeof value !== 'object') return;

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const childPath = path === '' ? key : `${path}.${key}`;
    if (typeof child === 'string') {
      if (MODEL_KEYS.has(key.toLowerCase()) && child.trim().length > 0) {
        hits.push({ path: childPath, reference: child.trim() });
        if (hits.length >= MAX_MODEL_HITS) return;
      }
      continue;
    }
    walk(child, childPath, depth + 1, hits);
  }
}
