import { afterEach, expect, test } from "bun:test";
import { decodeBackup, editLocal, exportLocal, readLocal, rememberFeed, restoreLocal } from "../client/src/local";

const data = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", { value: {
  getItem: (key: string) => data.get(key) ?? null,
  setItem: (key: string, value: string) => data.set(key, value),
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
