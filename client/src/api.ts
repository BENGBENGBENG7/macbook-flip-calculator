import { z } from "zod";
import { rememberFeed } from "./local";

const numLike = z.union([z.number(), z.string()]);

const listingInput = z.object({
  id: z.string().min(1).refine(s => !Object.hasOwn(Object.prototype, s) && s !== "prototype"),
  platform: z.string(),
  url: z.string().default(""),
  description: z.string().default(""),
  seller: z.string().default(""),
  priceCny: numLike,
  size: z.string().default(""),
  chip: z.string().default(""),
  memory: z.string().default(""),
  storage: z.string().default(""),
  battery: z.union([z.string(), z.number()]).nullable().optional(),
  cycles: numLike.nullable().optional(),
  condition: z.string().default(""),
  warranty: z.string().default(""),
  image: z.string().nullable().optional(),
  images: z.array(z.string()).max(10).default([]),
  saleLow: numLike.nullable().optional(),
  saleHigh: numLike.nullable().optional(),
  sampleCount: numLike.default(0),
  soldSource: z.string().default(""),
  shippingSgd: numLike.default(0),
  repairSgd: numLike.default(0),
  feePercent: numLike.default(0),
  targetProfit: numLike.default(0),
  // The data file carries createdAt either as an ISO string or as a numeric
  // millisecond timestamp; both are accepted as-is (the file format is not
  // changed) and numbers are converted to a Date internally.
  createdAt: z.union([z.string(), z.number()]).optional(),
});

type ListingInput = z.infer<typeof listingInput>;

// Normalisers for the loosely-typed import values. A numeric string keeps
// its digits ("6,438" → 6438); anything with no usable number becomes the
// fallback / null instead of failing the import.
function toNumOrNull(v: number | string | null | undefined): number | null {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const cleaned = v.replace(/[^0-9.\-]/g, "");
  if (cleaned === "" || cleaned === "-" || cleaned === ".") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function toNum(v: number | string | null | undefined, fallback: number): number {
  return toNumOrNull(v) ?? fallback;
}

// Cycles: a number stays, a numeric string ("253", "253次") parses to its
// integer, and a non-numeric marker such as "未注明" means the count was
// never stated — stored as null, which the UI already renders as unstated.
function toCycles(v: number | string | null | undefined): number | null {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? Math.trunc(v) : null;
  const m = v.match(/-?\d+/);
  return m ? parseInt(m[0], 10) : null;
}

function normalize(l: ListingInput) {
  const created = new Date(l.createdAt ?? Date.now());
  const cover = l.image ?? l.images[0] ?? null;
  return {
    ...l, image: cover, images: cover ? [cover] : [], battery: l.battery == null ? null : String(l.battery),
    cycles: toCycles(l.cycles), priceCny: toNum(l.priceCny, 0), saleLow: toNumOrNull(l.saleLow),
    saleHigh: toNumOrNull(l.saleHigh), sampleCount: Math.max(0, Math.trunc(toNum(l.sampleCount, 0))),
    shippingSgd: toNum(l.shippingSgd, 0), repairSgd: toNum(l.repairSgd, 0),
    feePercent: toNum(l.feePercent, 0), targetProfit: toNum(l.targetProfit, 0),
    createdAt: (Number.isFinite(created.getTime()) ? created : new Date()).toISOString(), liked: false,
  };
}
const feedUrl = "https://raw.githubusercontent.com/BENGBENGBENG7/macbook-flip-calculator/main/listings.json";
let galleries = new Map<string, string[]>();
const rateKey = "macbook-sift:rate:v1";
const cachedRate = z.object({ rate: z.number().positive(), date: z.iso.date(), checked: z.string() });

async function getState(signal?: AbortSignal) {
  const response = await fetch(feedUrl, { signal, cache: "no-cache", credentials: "omit", referrerPolicy: "no-referrer" });
  if (!response.ok) throw new Error("机器清单读取失败");
  const json = await response.json();
  const parsed = z.array(listingInput).parse(Array.isArray(json) ? json : json?.listings);
  const rows = new Map(parsed.map(row => [row.id, row]));
  if (signal?.aborted) throw signal.reason;
  await rememberFeed([...rows.keys()]);
  galleries = new Map([...rows.values()].map(row => [row.id, row.images.length ? row.images : row.image ? [row.image] : []]));
  return { listings: [...rows.values()].map(normalize) };
}
async function getRate() {
  const raw = localStorage.getItem(rateKey);
  let cached;
  try { cached = cachedRate.safeParse(JSON.parse(raw ?? "null")).data; } catch { /* refresh */ }
  const today = new Date().toISOString().slice(0, 10);
  if (cached?.checked === today) return cached;
  try {
    const res = await fetch("https://api.frankfurter.dev/v1/latest?base=CNY&symbols=SGD", { signal: AbortSignal.timeout(12000), credentials: "omit", referrerPolicy: "no-referrer" });
    if (!res.ok) throw new Error("汇率读取失败");
    const json = await res.json();
    const rate = cachedRate.parse({ rate: json?.rates?.SGD, date: json?.date, checked: today });
    localStorage.setItem(rateKey, JSON.stringify(rate));
    return rate;
  } catch { return cached ?? { rate: null, date: null }; }
}
export const api = { getState, getRate, imagesFor: (id: string) => galleries.get(id) };
export type ApiResponse<A, K extends keyof A> = A[K] extends (...args: never[]) => Promise<infer R> ? R : never;
