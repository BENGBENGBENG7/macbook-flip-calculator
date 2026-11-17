import { z } from "zod";

const key = "macbook-sift:local:v1";
/* A corrupt stored blob is stashed here (not deleted) so it can still be
   inspected or restored by hand after readLocal falls back to fresh. */
const corruptKey = `${key}:corrupt`;
const tokenKey = "macbook-sift:github-token:v1";
const changed = "macbook-sift-local-change";
const knownDeleted = [
  "xianyu-1100158609801", "xianyu-1100552885166", "xianyu-1101263928402",
  "xianyu-1100199777896", "xianyu-1100336693820",
];
const id = z.string().min(1).refine(s => !Object.hasOwn(Object.prototype, s) && s !== "prototype");
const analysis = z.object({
  saleLow: z.number().nullable(), saleHigh: z.number().nullable(), sampleCount: z.number().int().nonnegative(),
  soldSource: z.string(), shippingSgd: z.number(), repairSgd: z.number(), feePercent: z.number(), targetProfit: z.number(),
});
const personal = z.object({
  likes: z.record(id, z.boolean()), analysis: z.record(id, analysis.partial()), deletions: z.array(id),
});
const savedFile = personal.extend({ seen: z.array(id) });
type Saved = z.infer<typeof savedFile>;
const fresh = (): Saved => ({ likes: {}, analysis: {}, deletions: [...knownDeleted], seen: [] });

/* Resilient by design (audit 2026-11-17): a corrupt stored blob used to
   throw during the useState initializer and white-screen the whole app
   with no recovery except clearing site data. Now a bad blob is stashed
   under the corrupt key and a fresh state is returned instead, so the
   app always opens. */
export function readLocal(): Saved {
  const raw = localStorage.getItem(key);
  if (!raw) return fresh();
  try {
    return savedFile.parse(JSON.parse(raw));
  } catch {
    try { localStorage.setItem(corruptKey, raw); } catch { /* storage blocked/full */ }
    return fresh();
  }
}
export function subscribeLocal(listener: () => void) {
  const onStorage = (event: StorageEvent) => { if (!event.key || event.key === key) listener(); };
  window.addEventListener("storage", onStorage);
  window.addEventListener(changed, listener);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(changed, listener);
  };
}
export async function editLocal(edit: (state: Saved) => void) {
  const commit = () => {
    const state = readLocal();
    edit(state);
    const raw = JSON.stringify(state);
    if (raw === localStorage.getItem(key)) return;
    localStorage.setItem(key, raw);
    window.dispatchEvent(new Event(changed));
  };
  if (navigator.locks) await navigator.locks.request(key, commit);
  else commit();
}
export async function rememberFeed(ids: string[]) {
  const next = new Set(ids);
  await editLocal(s => {
    /* Never prune on an empty or implausibly shrunken feed: a valid-but-
       empty (or truncated) listings.json would otherwise tombstone every
       machine the user has ever seen, with no un-delete UI to bring them
       back. A feed under a tenth of the previous size is treated as a
       bad read, not a mass delisting. */
    if (next.size === 0 || next.size * 10 < s.seen.length) return;
    s.deletions = [...new Set([...knownDeleted, ...s.deletions, ...s.seen.filter(old => !next.has(old))])];
    s.seen = [...next];
  });
}
const legacyUser = z.object({
  listingId: id, liked: z.union([z.literal(1), z.literal(0)]),
  ...Object.fromEntries(Object.entries(analysis.shape).map(([k, v]) => [k, v.nullable()])),
}).passthrough();

export function decodeBackup(text: string): z.infer<typeof personal> {
  const raw = JSON.parse(text);
  if (raw?.format === "macbook-sift-local-v1") return personal.parse(raw);
  const old = z.object({
    version: z.literal(1), listings: z.array(z.object({ id })), userData: z.array(legacyUser), deletedIds: z.array(id),
  }).parse(raw);
  const result: z.infer<typeof personal> = { likes: {}, analysis: {}, deletions: old.deletedIds };
  for (const row of old.userData) {
    result.likes[row.listingId] = row.liked === 1;
    const fields = Object.fromEntries(Object.keys(analysis.shape).filter(k =>
      row[k] != null || ((k === "saleLow" || k === "saleHigh") && row.sampleCount != null)
    ).map(k => [k, row[k]]));
    const edited = analysis.partial().parse(fields);
    if (Object.keys(edited).length) result.analysis[row.listingId] = edited;
  }
  return result;
}

export async function restoreLocal(text: string) {
  const next = decodeBackup(text);
  await editLocal(s => {
    s.likes = next.likes;
    s.analysis = next.analysis;
    s.deletions = [...new Set([...knownDeleted, ...s.deletions, ...next.deletions])];
  });
}

export function exportLocal() {
  const { likes, analysis, deletions } = readLocal();
  return JSON.stringify({ format: "macbook-sift-local-v1", likes, analysis, deletions }, null, 2);
}

/* ---------- two-way cloud sync (user-data.json) ---------------------------
   The GitHub token is the user's own fine-grained token (Contents
   read+write on this repo only). It lives only in localStorage under
   its own key — never in code, never in any file, never in the repo —
   and is only ever sent to api.github.com for this repo. */
export function clearLocalData(): void {
  try {
    localStorage.removeItem(key);
    localStorage.removeItem(corruptKey);
  } catch { /* storage blocked */ }
}

export function readSyncToken(): string {
  return localStorage.getItem(tokenKey) ?? "";
}
export function saveSyncToken(token: string): void {
  localStorage.setItem(tokenKey, token);
}
export function clearSyncToken(): void {
  localStorage.removeItem(tokenKey);
}

export type PersonalData = z.infer<typeof personal>;

/* Validate downloaded cloud state with the same `personal` schema used
   for backups: unknown keys (e.g. `format`) are stripped, bad shapes
   throw instead of silently merging. */
export function parseCloudPersonal(raw: unknown): PersonalData {
  return personal.parse(raw);
}

/* Merge cloud personal state into local state. Pure: no storage access.
   - deletions: UNION of local + cloud (+ the known seeds). A deletion is
     never removed by a download — deleted content never comes back.
   - likes: an explicit local entry wins when present (including `false`,
     i.e. an explicit unlike); otherwise the cloud value applies.
   - analysis: per id per field, a local field wins when present;
     otherwise the cloud field applies.
   - likes/analysis for a deleted id are dropped.
   - `seen` is local-only and is never merged (not part of the result). */
export function mergePersonal(local: Saved, cloud: PersonalData): PersonalData {
  const deletions = [...new Set([...knownDeleted, ...local.deletions, ...cloud.deletions])];
  const deleted = new Set(deletions);
  const likes: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(cloud.likes)) if (!deleted.has(k)) likes[k] = v;
  for (const [k, v] of Object.entries(local.likes)) if (!deleted.has(k)) likes[k] = v;
  const mergedAnalysis: Record<string, Partial<z.infer<typeof analysis>>> = {};
  for (const [k, v] of Object.entries(cloud.analysis)) if (!deleted.has(k)) mergedAnalysis[k] = { ...v };
  for (const [k, v] of Object.entries(local.analysis)) {
    if (deleted.has(k)) continue;
    mergedAnalysis[k] = { ...(mergedAnalysis[k] ?? {}), ...v };
  }
  return { likes, analysis: mergedAnalysis, deletions };
}
