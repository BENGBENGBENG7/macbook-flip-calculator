import { expect, test } from "bun:test";
import {
  clampSwipeOffset,
  isScrollIntent,
  isSwipeIntent,
  movedEnough,
  snapSwipeOffset,
} from "../client/src/gestures";

test("swipe intent needs a clear horizontal drag", () => {
  expect(isSwipeIntent(-20, 5)).toBe(true);
  expect(isSwipeIntent(-5, 2)).toBe(false); // too short
  expect(isSwipeIntent(-20, 20)).toBe(false); // diagonal, not clearly horizontal
  expect(isSwipeIntent(20, 5)).toBe(true); // rightward also counts (closes an open row)
});

test("scroll intent needs a clear vertical drag", () => {
  expect(isScrollIntent(5, 20)).toBe(true);
  expect(isScrollIntent(20, 5)).toBe(false);
  expect(isScrollIntent(2, 5)).toBe(false);
});

test("long-press cancels on small movement", () => {
  expect(movedEnough(11, 0)).toBe(true);
  expect(movedEnough(0, 11)).toBe(true);
  expect(movedEnough(5, 5)).toBe(false);
});

test("swipe offset clamps to the action width and zero", () => {
  expect(clampSwipeOffset(0, -50, 88)).toBe(-50);
  expect(clampSwipeOffset(0, -200, 88)).toBe(-88);
  expect(clampSwipeOffset(-88, 30, 88)).toBe(-58);
  expect(clampSwipeOffset(-88, 200, 88)).toBe(0);
});

test("release snaps open past half, else shut", () => {
  expect(snapSwipeOffset(-50, 88)).toBe(-88);
  expect(snapSwipeOffset(-43, 88)).toBe(0);
  expect(snapSwipeOffset(-100, 168)).toBe(-168);
  expect(snapSwipeOffset(-80, 168)).toBe(0);
});
