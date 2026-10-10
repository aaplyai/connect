/**
 * Orders connector versions as semantic versions: `1.10.0` after `1.9.0`,
 * and a prerelease (`1.0.0-beta.1`) before its release. Build metadata
 * (`+…`) is ignored.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [main = "", pre] = v.split("+")[0]!.split(/-(.*)/s);
    return { main: main.split(".").map((n) => (/^\d+$/.test(n) ? Number(n) : Number.NaN)), pre: pre === undefined ? null : pre.split(".") };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.main.length, y.main.length); i++) {
    const d = (x.main[i] ?? 0) - (y.main[i] ?? 0);
    if (d !== 0 && !Number.isNaN(d)) return d;
  }
  if (x.pre === null || y.pre === null) return x.pre === y.pre ? 0 : x.pre === null ? 1 : -1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) return Number(p) - Number(q);
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}
