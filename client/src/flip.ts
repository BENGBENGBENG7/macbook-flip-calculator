// Pure calculation + formatting helpers for macbook flip (brief §3/§4).

import type { ApiResponse } from "./api";
import type { api } from "./api";

export type Listing = ApiResponse<typeof api, "getState">["listings"][number];

export type Analysis = Pick<
  Listing,
  | "saleLow"
  | "saleHigh"
  | "sampleCount"
  | "soldSource"
  | "shippingSgd"
  | "repairSgd"
  | "feePercent"
  | "targetProfit"
>;

export type Verdict = "red" | "yellow" | "green";

export interface Calc {
  feeSgd: number;
  buySgd: number;
  landedSgd: number;
  profitLow: number | null;
  profitHigh: number | null;
  suggestedBuySgd: number | null;
  verdict: Verdict | null;
}

/** feePercent arrives either as a fraction (0.05) or a percent (5). */
export function feeFraction(feePercent: number): number {
  return feePercent > 1 ? feePercent / 100 : feePercent;
}

export function calc(l: Listing, rate: number | null): Calc {
  const feeSgd =
    l.platform === "xianyu" ? (rate == null ? 0 : 204 * rate) : 0;
  const buySgd = rate == null ? 0 : l.priceCny * rate;
  const landedSgd = buySgd + feeSgd + l.shippingSgd + l.repairSgd;
  const frac = feeFraction(l.feePercent);
  const profitLow =
    rate != null && l.saleLow != null
      ? l.saleLow * (1 - frac) - landedSgd
      : null;
  const profitHigh =
    rate != null && l.saleHigh != null
      ? l.saleHigh * (1 - frac) - landedSgd
      : null;
  const maxBuy =
    l.saleLow != null
      ? l.saleLow * (1 - frac) - l.targetProfit - feeSgd - l.shippingSgd - l.repairSgd
      : null;
  const suggestedBuySgd =
    rate != null && maxBuy != null ? Math.min(maxBuy, buySgd) : null;
  let verdict: Verdict | null = null;
  if (profitLow != null && profitHigh != null) {
    if (profitHigh <= 0) verdict = "red";
    else if (profitLow > 0 && l.sampleCount >= 2) verdict = "green";
    else verdict = "yellow";
  }
  return { feeSgd, buySgd, landedSgd, profitLow, profitHigh, suggestedBuySgd, verdict };
}

export function title(l: Listing): string {
  const parts = [l.size, l.chip].filter(Boolean);
  const base = parts.length > 0 ? parts.join(" ") : "MacBook Pro";
  const spec = specLine(l);
  return spec ? `${base} · ${spec}` : base;
}

function specLine(l: Listing): string {
  return [l.memory, l.storage].filter(Boolean).join(" · ");
}

export function platformName(platform: string): string {
  if (platform === "xianyu") return "闲鱼";
  if (platform === "carousell") return "Carousell";
  if (platform === "facebook") return "Facebook";
  return platform;
}

export function fmtMoney(value: number, currency: "sgd" | "cny"): string {
  const rounded = Math.round(value);
  const sign = rounded < 0 ? "-" : "";
  const abs = Math.abs(rounded).toLocaleString("en-US");
  return currency === "sgd" ? `${sign}S$${abs}` : `${sign}¥${abs}`;
}
