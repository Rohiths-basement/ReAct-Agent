export function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i=0;i<Math.min(a.length,b.length);i++) { dot += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; }
  return dot / ((Math.sqrt(na)||1)*(Math.sqrt(nb)||1));
}

export function truncateMiddle(s: string, max = 300): string {
  if (s.length <= max) return s;
  const half = Math.floor((max - 3)/2);
  return s.slice(0, half) + '...' + s.slice(-half);
}

