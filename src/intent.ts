/**
 * Recognises a plain yes or no to a pending draft, in English, Hindi and
 * Hinglish (typed or transcribed).
 *
 * Only a short message that is *nothing but* a yes or a no counts. "Yes, but
 * mark Riya late" is neither: the model handles it and drafts again. Answering
 * a clear yes here keeps the confirmation deterministic — the model is never
 * the one that decides a change is approved — and saves a model call.
 */

const YES = new Set([
  'yes', 'y', 'yeah', 'yea', 'yep', 'yup', 'ya', 'ok', 'okay', 'k', 'sure',
  'confirm', 'confirmed', 'i confirm', 'please confirm', 'yes confirm',
  'confirm it', 'yes please', 'go ahead', 'go on', 'do it', 'yes do it',
  'proceed', 'correct', 'right', 'thats right', 'that is right', 'all good',
  'looks good', 'perfect', 'fine', 'save', 'save it', 'submit', 'submit it',
  'approve it', 'yes go ahead', 'ok go ahead', 'okay go ahead', 'ok do it',
  'okay do it', 'ok confirm', 'okay confirm', 'yes save', 'yes submit',
  'haan', 'haa', 'han', 'ha', 'haan ji', 'ji haan', 'ji', 'ji ha', 'hanji',
  'haanji', 'theek hai', 'thik hai', 'thik h', 'theek h', 'kar do', 'kardo',
  'haan kar do', 'haan kardo', 'bilkul', 'sahi hai', 'ho gaya', 'chalo',
  'हाँ', 'हां', 'हा', 'जी', 'जी हाँ', 'जी हां', 'ठीक है', 'कर दो', 'बिल्कुल',
  'सही है',
]);

const NO = new Set([
  'no', 'n', 'nope', 'nah', 'cancel', 'cancel it', 'discard', 'discard it',
  'dont', 'do not', "don't", 'stop', 'no thanks', 'no thank you', 'not now',
  'leave it', 'forget it', 'never mind', 'nevermind', 'no cancel',
  'nahi', 'nahin', 'nai', 'na', 'mat karo', 'rehne do', 'rahne do', 'mat',
  'nahi karna', 'cancel karo', 'cancel kar do',
  'नहीं', 'ना', 'मत करो', 'रहने दो', 'कैंसल',
]);

const FILLER = /\b(please|pls|plz|sir|madam|ma'?am|ji)\b/g;

export function normalise(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFC')
    .replace(/[’']/g, "'")
    .replace(/[.!?,;:।"“”()]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export type Answer = 'yes' | 'no' | null;

export function plainAnswer(text: string): Answer {
  const t = normalise(text);
  if (!t || t.split(' ').length > 5) return null;
  const variants = [t, t.replace(FILLER, ' ').replace(/\s+/g, ' ').trim()];
  for (const v of variants) {
    if (!v) continue;
    if (YES.has(v)) return 'yes';
    if (NO.has(v)) return 'no';
  }
  return null;
}
