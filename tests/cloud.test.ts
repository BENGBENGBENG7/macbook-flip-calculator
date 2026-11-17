import { expect, test } from "bun:test";
import { base64Utf8 } from "../client/src/cloud";

test("base64Utf8 round-trips Chinese text", () => {
  const s = JSON.stringify({ soldSource: "新加坡成交 S$1,599", note: "喜欢" });
  const bytes = Uint8Array.from(atob(base64Utf8(s)), (c) => c.charCodeAt(0));
  expect(new TextDecoder().decode(bytes)).toBe(s);
});

test("base64Utf8 matches btoa for plain ASCII", () => {
  expect(base64Utf8("hello")).toBe(btoa("hello"));
});
