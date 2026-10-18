/**
 * Normalise an Indonesian-style phone number to international digits without "+" (62xxx),
 * the form wa.me links need. Accepts "0812-3456-7890", "+62 812 3456 7890", "812...".
 * Returns null when the input has too few or too many digits to be a phone number.
 */
export function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  if (!digits) return null;
  let normalized: string;
  if (digits.startsWith('62')) normalized = digits;
  else if (digits.startsWith('0')) normalized = `62${digits.slice(1)}`;
  else if (digits.startsWith('8')) normalized = `62${digits}`;
  else normalized = digits;
  return normalized.length >= 9 && normalized.length <= 15 ? normalized : null;
}

/** wa.me link for a normalised number. */
export function whatsappLink(phone: string): string {
  return `https://wa.me/${phone}`;
}
