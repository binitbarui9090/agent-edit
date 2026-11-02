// Crockford lowercase. 32 symbols so `byte & 31` is unbiased; 22 symbols carry 110 bits.
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
const RANDOM_LENGTH = 22;

export const ID_PREFIXES = {
  user: 'usr',
  session: 'ses',
  project: 'prj',
  media: 'med',
  timeline: 'tln',
  track: 'trk',
  clip: 'clip',
  transaction: 'txn',
  version: 'ver',
  agentRun: 'run',
  renderJob: 'rnd',
  analysisJob: 'anl',
} as const;

export type IdPrefix = (typeof ID_PREFIXES)[keyof typeof ID_PREFIXES];

export function newId(prefix: IdPrefix): string {
  const bytes = crypto.getRandomValues(new Uint8Array(RANDOM_LENGTH));
  let out = `${prefix}_`;
  for (const byte of bytes) out += ALPHABET[byte & 31];
  return out;
}

export function idPattern(prefix: IdPrefix): RegExp {
  return new RegExp(`^${prefix}_[${ALPHABET}]{${RANDOM_LENGTH}}$`);
}
