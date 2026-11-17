import { afterEach, expect, test } from "bun:test";
import {
  clearSyncToken,
  decodeBackup,
  editLocal,
  exportLocal,
  mergePersonal,
  parseCloudPersonal,
  readLocal,
  readSyncToken,
  rememberFeed,
  restoreLocal,
  saveSyncToken,
  type PersonalData,
} from "../client/src/local";

const data = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", { value: {
  getItem: (key: string) => data.get(key) ?? null,
  setItem: (key: string, value: string) => data.set(key, value),
  removeItem: (key: string) => data.delete(key),
}});
Object.defineProperty(globalThis, "window", { value: new EventTarget() });
afterEach(() => data.clear());

test("v1 backup restores like-only rows and explicit null analysis independently", async () => {
  const blank = { saleLow: null, saleHigh: null, sampleCount: null, soldSource: null, shippingSgd: null,
    repairSgd: null, feePercent: null, targetProfit: null };
  await restoreLocal(JSON.stringify({ version: 1, listings: [], deletedIds: ["sold"], rate: null,
    userData: [{listingId: "one", liked: 1, ...blank}, {listingId: "two", liked: 0, ...blank, sampleCount: 0, soldSource: "SG"}] }));
  expect(readLocal().likes.one).toBe(true);
  expect(readLocal().analysis.one).toBeUndefined();
  expect(readLocal().analysis.two).toEqual({saleLow:null,saleHigh:null,sampleCount:0,soldSource:"SG"});
  expect(decodeBackup(exportLocal()).deletions).toContain("sold");
});

test("incomplete backup fails without modifying local edits", async () => {
  await editLocal(s => { s.likes.item = true; });
  const before = exportLocal();
  await expect(restoreLocal('{"version":1,"listings":[]}')).rejects.toThrow();
  expect(exportLocal()).toBe(before);
});

test("a missing machine stays deleted if a later feed or older backup contains it", async () => {
  await rememberFeed(["a","b"]);
  const old = exportLocal();
  await rememberFeed(["a"]);
  await rememberFeed(["b","a"]);
  await restoreLocal(old);
  expect(readLocal().deletions).toContain("b");
  expect(readLocal().deletions).not.toContain("a");
});

/* ---------- mergePersonal: two-way cloud sync ---------------------------- */

const emptyCloud: PersonalData = { likes: {}, analysis: {}, deletions: [] };

test("mergePersonal unions deletions and never removes one", async () => {
  await editLocal(s => { s.deletions = ["local-only"]; });
  const merged = mergePersonal(readLocal(), { ...emptyCloud, deletions: ["cloud-only"] });
  expect(merged.deletions).toContain("local-only");
  expect(merged.deletions).toContain("cloud-only");
  expect(merged.deletions).toContain("xianyu-1100158609801"); // known seed
  // A deletion present locally but absent from the cloud survives the merge.
  const again = mergePersonal(
    { ...readLocal(), deletions: ["local-only"] },
    emptyCloud,
  );
  expect(again.deletions).toContain("local-only");
});

test("mergePersonal lets an explicit local like win, including false", async () => {
  await editLocal(s => { s.likes.a = false; s.likes.b = true; });
  const merged = mergePersonal(readLocal(), {
    ...emptyCloud,
    likes: { a: true, b: false, c: true },
  });
  expect(merged.likes.a).toBe(false); // explicit local unlike wins
  expect(merged.likes.b).toBe(true); // explicit local like wins
  expect(merged.likes.c).toBe(true); // cloud fills in when local has none
});

test("mergePersonal drops likes and analysis for deleted ids", async () => {
  await editLocal(s => {
    s.likes.gone = true;
    s.analysis.gone = { soldSource: "SG" };
    s.deletions = ["gone"];
  });
  const merged = mergePersonal(readLocal(), {
    ...emptyCloud,
    likes: { gone: true },
    analysis: { gone: { soldSource: "cloud" } },
  });
  expect(merged.likes.gone).toBeUndefined();
  expect(merged.analysis.gone).toBeUndefined();
});

test("mergePersonal merges analysis per field with local winning", async () => {
  await editLocal(s => { s.analysis.one = { saleLow: 100 }; });
  const merged = mergePersonal(readLocal(), {
    ...emptyCloud,
    analysis: { one: { saleLow: 50, soldSource: "SG" } },
  });
  expect(merged.analysis.one).toEqual({ saleLow: 100, soldSource: "SG" });
});

test("mergePersonal never carries seen", async () => {
  await editLocal(s => { s.seen = ["seen-one"]; });
  const merged = mergePersonal(readLocal(), emptyCloud);
  expect("seen" in merged).toBe(false);
  expect(Object.keys(merged).sort()).toEqual(["analysis", "deletions", "likes"]);
});

test("parseCloudPersonal strips format and rejects bad shapes", () => {
  expect(parseCloudPersonal({ format: "macbook-sift-local-v1", likes: {}, analysis: {}, deletions: [] }))
    .toEqual({ likes: {}, analysis: {}, deletions: [] });
  expect(() => parseCloudPersonal({ likes: {}, analysis: {} })).toThrow();
  expect(() => parseCloudPersonal("nope")).toThrow();
});

test("sync token round-trips in localStorage only", () => {
  expect(readSyncToken()).toBe("");
  saveSyncToken("ghp_test");
  expect(readSyncToken()).toBe("ghp_test");
  clearSyncToken();
  expect(readSyncToken()).toBe("");
});
