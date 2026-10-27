// Terbilang (amount in words) for printed vouchers. Whole units only; cents are written as digits.

const ID_UNITS = ['', 'satu', 'dua', 'tiga', 'empat', 'lima', 'enam', 'tujuh', 'delapan', 'sembilan', 'sepuluh', 'sebelas'];

function idWords(n: number): string {
  if (n < 12) return ID_UNITS[n];
  if (n < 20) return `${ID_UNITS[n - 10]} belas`;
  if (n < 100) return `${ID_UNITS[Math.floor(n / 10)]} puluh ${idWords(n % 10)}`;
  if (n < 200) return `seratus ${idWords(n - 100)}`;
  if (n < 1000) return `${ID_UNITS[Math.floor(n / 100)]} ratus ${idWords(n % 100)}`;
  if (n < 2000) return `seribu ${idWords(n - 1000)}`;
  if (n < 1e6) return `${idWords(Math.floor(n / 1000))} ribu ${idWords(n % 1000)}`;
  if (n < 1e9) return `${idWords(Math.floor(n / 1e6))} juta ${idWords(n % 1e6)}`;
  if (n < 1e12) return `${idWords(Math.floor(n / 1e9))} miliar ${idWords(n % 1e9)}`;
  return `${idWords(Math.floor(n / 1e12))} triliun ${idWords(n % 1e12)}`;
}

const EN_UNITS = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const EN_TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

function enWords(n: number): string {
  if (n < 20) return EN_UNITS[n];
  if (n < 100) return `${EN_TENS[Math.floor(n / 10)]}${n % 10 ? `-${EN_UNITS[n % 10]}` : ''}`;
  if (n < 1000) return `${EN_UNITS[Math.floor(n / 100)]} hundred ${enWords(n % 100)}`;
  const scales: Array<[number, string]> = [[1e12, 'trillion'], [1e9, 'billion'], [1e6, 'million'], [1e3, 'thousand']];
  for (const [size, name] of scales) {
    if (n >= size) return `${enWords(Math.floor(n / size))} ${name} ${enWords(n % size)}`;
  }
  return '';
}

const tidy = (s: string) => s.replace(/\s+/g, ' ').trim();

/** "dua juta seratus lima puluh ribu rupiah" / "two million ... rupiah". Negative values use the absolute amount. */
export function amountInWords(value: number | string | null | undefined, lang: string): string {
  const n = Math.floor(Math.abs(Number(value ?? 0)) || 0);
  if (lang.startsWith('en')) return `${n === 0 ? 'zero' : tidy(enWords(n))} rupiah`;
  return `${n === 0 ? 'nol' : tidy(idWords(n))} rupiah`;
}
