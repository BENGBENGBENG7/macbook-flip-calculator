import {
memo,
useCallback,
useEffect,
useLayoutEffect,
useMemo,
useRef,
useState,
type ChangeEvent,
type MouseEvent as ReactMouseEvent,
type ReactNode,
type RefObject,
type TouchEvent as ReactTouchEvent,
} from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import { fetchCloudPersonal, uploadCloudPersonal } from "./cloud";
import {
  clearSyncToken,
  editLocal,
  exportLocal,
  mergePersonal,
  readLocal,
  readSyncToken,
  restoreLocal,
  saveSyncToken,
  subscribeLocal,
  type PersonalData,
} from "./local";
import {
  clampSwipeOffset,
  isScrollIntent,
  isSwipeIntent,
  movedEnough,
  snapSwipeOffset,
} from "./gestures";
import TITLE_IMG_SRC from "./assets/title-art.webp";
import {
calc,
feeFraction,
fmtMoney,
platformName,
title,
type Analysis,
type Listing,
} from "./flip";

const SORT_KEY = "macbook-flip-sort";
const FILTER_KEY = "macbook-flip-filter";
const LAYOUT_KEY = "macbook-flip-layout";
const MODEL_KEY = "macbook-flip-model";
/* Shared lock (audit 2026-11-17): while any dropdown menu is open, list
   gestures (long-press to multi-select, swipe-to-delete) are suppressed
   — a touch elsewhere only closes the menu. MenuSelect sets it;
   SwipeableItem reads it. A plain counter, not React state: the menu
   and the rows are siblings and the check runs inside touch handlers. */
let menuOpenCount = 0;
// Session-scoped record of the detail currently open. The #item= hash
// is the primary marker, but a host-forced reload (e.g. a native
// pull-to-refresh that slips past the overscroll guard) restarts the
// page from its base URL without the hash; this fallback restores the
// detail the user was reading instead of dropping them on the list.
// sessionStorage (not localStorage) so a genuinely fresh open of the
// artifact still starts on the list.
const OPEN_KEY = "macbook-flip-open";

/* ---------- clipboard (seller name copy) --------------------------------- */

// The stored seller field is a composite: the display name followed by
// metadata in full-width parentheses (handle, rating, review count,
// tenure), sometimes a " / alternate name" and/or a "· meetup" suffix —
// e.g. "VM（@virginiam，5.0，62评价，11年）". Tapping the seller copies
// ONLY the name: the leading segment before the first such separator.
// The detail page still displays the full composite string.
function sellerName(seller: string): string {
  const cut = seller.search(/[（(·]| \/ /);
  const name = (cut === -1 ? seller : seller.slice(0, cut)).trim();
  return name || seller.trim();
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}

/* ---------- per-amount currency toggle ---------------------------------- */

function Money({
  sgd,
  cny,
  rate,
  label,
  className,
}: {
  sgd?: number;
  cny?: number;
  rate: number | null;
  label: string;
  className?: string;
}) {
  const [cur, setCur] = useState<"sgd" | "cny">("sgd");
  const sgdValue = sgd ?? (cny != null && rate != null ? cny * rate : null);
  const cnyValue = cny ?? (sgd != null && rate != null ? sgd / rate : null);
  if (sgdValue == null && cnyValue == null) {
    return <span className={className}>—</span>;
  }
  if (rate == null) {
    const text =
      sgdValue != null ? fmtMoney(sgdValue, "sgd") : fmtMoney(cnyValue ?? 0, "cny");
    return <span className={className}>{text}</span>;
  }
  /* Both values are derived above whenever either input exists, so by
     here at most one can be null — the ?? 0 fallbacks are only a
     type-level guard, never real math. */
  const text =
    cur === "sgd"
      ? fmtMoney(sgdValue ?? 0, "sgd")
      : fmtMoney(cnyValue ?? 0, "cny");
  return (
    <button
      type="button"
      aria-label={`${label}，点击切换币种`}
      className={className}
      onClick={(e) => {
        e.stopPropagation();
        setCur((c) => (c === "sgd" ? "cny" : "sgd"));
      }}
    >
      {text}
    </button>
  );
}

/** A price range is one connected amount: both ends convert together. */
function MoneyRange({
  low,
  high,
  rate,
  label,
  className,
}: {
  low: number | null;
  high: number | null;
  rate: number | null;
  label: string;
  className?: string;
}) {
  const [cur, setCur] = useState<"sgd" | "cny">("sgd");
  if (low == null || high == null) return <span className={className}>—</span>;
  if (rate == null) {
    return (
      <span className={className}>
        {fmtMoney(low, "sgd")} – {fmtMoney(high, "sgd")}
      </span>
    );
  }
  const conv = (v: number) => (cur === "sgd" ? v : v / rate);
  return (
    <button
      type="button"
      aria-label={`${label}，点击切换币种`}
      className={className}
      onClick={(e) => {
        e.stopPropagation();
        setCur((c) => (c === "sgd" ? "cny" : "sgd"));
      }}
    >
      {fmtMoney(conv(low), cur)} – {fmtMoney(conv(high), cur)}
    </button>
  );
}

/* ---------- small pieces ------------------------------------------------- */

/* Verdict colours follow the traffic-light family used across the app:
   green is the maximise green (.glass-green), red is the close-button
   red the like buttons use (--btn-red). Yellow keeps its own token.
   (The filter row used to share the green; since 2026-11-17 it is
   monochrome — dark halo, dark press flash.) */
const VERDICT_COLOR: Record<string, string> = {
  red: "var(--btn-red)",
  yellow: "var(--verdict-yellow)",
  green: "color-mix(in srgb, var(--btn-green) 82%, #046a1b)",
};

const PLATFORM_STYLE: Record<string, { color: string; border: string }> = {
  xianyu: { color: "#96660a", border: "#e0cd96" },
  carousell: { color: "#8c4a12", border: "#e3c3a5" },
  facebook: { color: "#3d5a80", border: "#b9c9dd" },
};

function PlatformTag({ platform }: { platform: string }) {
  const s = PLATFORM_STYLE[platform] ?? { color: "var(--dim)", border: "var(--border)" };
  return (
    <span
      className="inline-block rounded-full border px-2 py-0.5 text-xs"
      style={{ color: s.color, borderColor: s.border }}
    >
      {platformName(platform)}
    </span>
  );
}

function Heart({ filled }: { filled: boolean }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="1.8"
      aria-hidden="true"
    >
      <path d="M12 20.7C6.4 17 3 13.6 3 9.9 3 7.2 5 5 7.6 5c1.7 0 3.4.9 4.4 2.4C13 5.9 14.7 5 16.4 5 19 5 21 7.2 21 9.9c0 3.7-3.4 7.1-9 10.8z" />
    </svg>
  );
}

const VERDICT_TEXT: Record<string, string> = {
  green: "text-[color-mix(in_srgb,var(--btn-green)_82%,#046a1b)]",
  yellow: "text-[var(--verdict-yellow)]",
  red: "text-[var(--btn-red)]",
};

const VERDICT_WORD: Record<string, string> = {
  green: "可买",
  yellow: "观望",
  red: "不划算",
};

function VerdictBadge({ verdict }: { verdict: string }) {
  return (
    <span
      className="rounded-full border px-1.5 py-px text-[11px] font-medium leading-4"
      style={{
        color: VERDICT_COLOR[verdict],
        borderColor: VERDICT_COLOR[verdict],
      }}
    >
      {VERDICT_WORD[verdict]}
    </span>
  );
}

/* The like button, shared by the card, the multi-column row and the
   detail page: a fixed round glass button — traffic-red outline heart
   on plain glass when unliked, solid red glass with a white filled
   heart when liked. `className` carries only the call site's size and
   placement; `bordered` adds the detail page's hairline ring. */
function LikeButton({
  listing,
  onToggleLike,
  className,
  bordered,
  plainLabel,
}: {
  listing: Listing;
  onToggleLike: (l: Listing) => void;
  className: string;
  bordered?: boolean;
  /* The detail page's button sits alone in its header, so its label
     is just 喜欢/取消喜欢 without the listing title. */
  plainLabel?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={
        plainLabel
          ? listing.liked
            ? "取消喜欢"
            : "喜欢"
          : listing.liked
            ? `取消喜欢 ${title(listing)}`
            : `喜欢 ${title(listing)}`
      }
      aria-pressed={listing.liked}
      className={`flex items-center justify-center rounded-full ${className} ${
        listing.liked
          ? "glass-red text-white"
          : `glass text-[var(--btn-red)]${bordered ? " border border-[var(--border)]" : ""}`
      }`}
      onClick={() => onToggleLike(listing)}
    >
      <Heart filled={listing.liked} />
    </button>
  );
}

function batteryLine(l: Listing): string {
  const parts: string[] = [];
  if (l.battery) parts.push(`电池 ${l.battery}`);
  if (l.cycles != null) parts.push(`${l.cycles} 次`);
  return parts.length > 0 ? parts.join(" · ") : "电池 —";
}

/* ---------- card (single-column mode) --------------------------------------
   Only the photo and the title open the detail page; the rest of the card
   is static. Listing price and suggested buy share one row, split
   left/right so they are easy to compare. */

function Card({
  listing,
  rate,
  onOpen,
  onToggleLike,
  multiSelect,
  isSelected,
  onToggleSelect,
}: {
  listing: Listing;
  rate: number | null;
  onOpen: (l: Listing) => void;
  onToggleLike: (l: Listing) => void;
  multiSelect: boolean;
  isSelected: boolean;
  onToggleSelect: (id: string) => void;
}) {
  const c = calc(listing, rate);
  const img = listing.images[0];
  const profitColor = c.verdict
    ? (VERDICT_TEXT[c.verdict] ?? "text-[var(--text)]")
    : "text-[var(--text)]";
  return (
    <article className="cv-card relative flex h-full flex-col overflow-hidden rounded-[10px] border border-[var(--border)] bg-[var(--surface)]">
      <SelectCheckbox
        visible={multiSelect}
        selected={isSelected}
        label={isSelected ? `取消选择 ${title(listing)}` : `选择 ${title(listing)}`}
        onToggle={() => onToggleSelect(listing.id)}
        placement="photo"
      />
      <button
        type="button"
        aria-label={`查看 ${title(listing)} 详情`}
        className="block w-full shrink-0 text-left"
        onClick={() => onOpen(listing)}
      >
        <div className="relative aspect-[4/3] w-full bg-[var(--bg)]">
          {img ? (
            <img
              src={img}
              alt={title(listing)}
              className="h-full w-full object-cover"
              loading="lazy"
              decoding="async"
            />
          ) : null}
        </div>
      </button>
      <div className="relative flex w-full flex-1 flex-col pb-3 pl-5 pr-5 pt-4">
        <div className="flex items-start justify-between gap-2">
          <button
            type="button"
            aria-label={`查看 ${title(listing)} 详情`}
            className="min-w-0 flex-1 text-left"
            onClick={() => onOpen(listing)}
          >
            <h3 className="line-clamp-2 h-12 text-lg font-semibold leading-6 text-[var(--text)]">
              {title(listing)}
            </h3>
          </button>
          <span className="shrink-0 pt-0.5">
            <PlatformTag platform={listing.platform} />
          </span>
        </div>
        <p className="h-6 truncate text-base leading-6 text-[var(--dim)]">
          {batteryLine(listing)}
        </p>
        <div className="mt-2 flex items-end justify-between gap-2">
          <Money
            cny={listing.priceCny}
            rate={rate}
            label="挂牌价"
            className="text-xl font-semibold leading-8 text-[var(--text)]"
          />
          <span className="flex shrink-0 items-baseline gap-1.5 pb-1">
            <span className="text-sm text-[var(--faint)]">建议购入</span>
            <Money
              sgd={c.suggestedBuySgd ?? undefined}
              rate={rate}
              label="建议购入价"
              className="text-base font-medium text-[var(--text)]"
            />
          </span>
        </div>
        <div className="mt-auto pt-2">
          <div className="border-t border-[var(--border)] pt-2.5">
            <div className="flex min-h-7 flex-wrap items-center justify-between gap-x-2 gap-y-0.5">
              <span className="flex shrink-0 items-center gap-1.5">
                <span className="text-sm text-[var(--faint)]">利润</span>
                {c.verdict ? <VerdictBadge verdict={c.verdict} /> : null}
              </span>
              <MoneyRange
                low={c.profitLow}
                high={c.profitHigh}
                rate={rate}
                label="利润区间"
                className={`ml-auto min-w-0 text-right text-base font-semibold leading-snug ${profitColor}`}
              />
            </div>
          </div>
        </div>
      </div>
      <div className="flex shrink-0 justify-end px-2.5 pb-2.5">
        <LikeButton listing={listing} onToggleLike={onToggleLike} className="h-9 w-9" />
      </div>
    </article>
  );
}

/* Memoised: the list re-renders on every like tap / pending change, and
   without memo all ~71 cards repainted each time (each carries a glass
   backdrop-filter button) — a visible hitch on the phone. Listing object
   identities are stable across those renders (the listings memo only
   rebuilds rows that actually changed, and React Query's structural
   sharing keeps refetched rows identical), so memo skips untouched
   cards entirely. */
const MemoCard = memo(Card);

/* ---------- multi-column mode: horizontal info row (no image) ------------ */

function ListRow({
  listing,
  rate,
  onOpen,
  onToggleLike,
  multiSelect,
  isSelected,
  onToggleSelect,
}: {
  listing: Listing;
  rate: number | null;
  onOpen: (l: Listing) => void;
  onToggleLike: (l: Listing) => void;
  multiSelect: boolean;
  isSelected: boolean;
  onToggleSelect: (id: string) => void;
}) {
  const c = calc(listing, rate);
  const profitColor = c.verdict
    ? (VERDICT_TEXT[c.verdict] ?? "text-[var(--text)]")
    : "text-[var(--text)]";
  return (
    <article
      className="cv-row relative flex items-stretch gap-3 rounded-[10px] border border-[var(--border)] bg-[var(--surface)] py-3 pr-3 transition-[padding-left] duration-200 ease-out"
      style={{ paddingLeft: multiSelect ? 56 : 16 }}
    >
      <SelectCheckbox
        visible={multiSelect}
        selected={isSelected}
        label={isSelected ? `取消选择 ${title(listing)}` : `选择 ${title(listing)}`}
        onToggle={() => onToggleSelect(listing.id)}
      />
      <button
        type="button"
        aria-label={`查看 ${title(listing)} 详情`}
        className="pressable min-w-0 flex-1 text-left"
        onClick={() => onOpen(listing)}
      >
        <div className="flex items-start justify-between gap-2">
          {/* Row title stays one line: in multi-select the text area
             narrows for the checkbox, and a wrap to two lines would make
             the row taller and drag the centred like button down with
             it. Truncate instead; the detail page still shows the full
             title. (Single-column cards keep line-clamp-2.) */}
          <h3 className="min-w-0 flex-1 truncate text-base font-semibold leading-6 text-[var(--text)]">
            {title(listing)}
          </h3>
          <span className="shrink-0 pt-0.5">
            <PlatformTag platform={listing.platform} />
          </span>
        </div>
        <p className="mt-0.5 truncate text-sm leading-6 text-[var(--dim)]">
          {batteryLine(listing)}
        </p>
        <div className="mt-1.5 flex items-baseline justify-between gap-2">
          <Money
            cny={listing.priceCny}
            rate={rate}
            label="挂牌价"
            className="text-lg font-semibold leading-7 text-[var(--text)]"
          />
          <span className="flex shrink-0 items-baseline gap-1.5">
            <span className="text-xs text-[var(--faint)]">建议购入</span>
            <Money
              sgd={c.suggestedBuySgd ?? undefined}
              rate={rate}
              label="建议购入价"
              className="text-sm font-medium text-[var(--text)]"
            />
          </span>
        </div>
        <div className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="text-xs text-[var(--faint)]">利润</span>
          {c.verdict ? <VerdictBadge verdict={c.verdict} /> : null}
          <MoneyRange
            low={c.profitLow}
            high={c.profitHigh}
            rate={rate}
            label="利润区间"
            className={`text-sm font-semibold leading-snug ${profitColor}`}
          />
        </div>
      </button>
      <LikeButton
        listing={listing}
        onToggleLike={onToggleLike}
        className="ml-1 h-9 w-9 shrink-0 self-center"
      />
    </article>
  );
}

const MemoListRow = memo(ListRow);

/* ---------- multi-select checkbox ----------------------------------------
   Two placements, one component (fixed 22x22, flex:none, round — absolute
   positioning plus pinned size means flex can never stretch it into an
   oval, at any card height). The pin must include minHeight: 0 /
   minWidth: 0: theme.css sets a global `button { min-height: 2rem }`
   tap-target floor, and min-height beats height — without the override
   a 22px button renders 22 wide x 32 tall, i.e. a vertical oval, and
   shrinking width/height alone can never fix it (that exact bug
   survived rounds 2–5 until the override landed). Selected: green
   fill + white check;
   unselected: faint outline (on a photo: translucent white disc + shadow
   so it reads on any picture). Hidden (opacity 0, no pointer events)
   outside multi-select mode.
   - "photo": floats on the photo's top-left corner (single-column cards).
     Nothing in the card moves when multi-select opens — no padding shift,
     no text slide, no image reflow — so the photo can never be squeezed.
   - "text": vertically centred at the left of the text area (multi-column
     rows, which have no photo); the row's text padding makes room for it. */
function SelectCheckbox({
  visible,
  selected,
  label,
  onToggle,
  placement = "text",
}: {
  visible: boolean;
  selected: boolean;
  label: string;
  onToggle: () => void;
  placement?: "text" | "photo";
}) {
  return (
    <button
      type="button"
      data-ms-checkbox
      aria-label={label}
      aria-checked={selected}
      aria-hidden={!visible}
      tabIndex={visible ? 0 : -1}
      className={`absolute z-20 flex items-center justify-center rounded-full border-2 text-sm font-semibold leading-none transition-all duration-200 ease-out ${
        placement === "photo" ? "left-3 top-3" : "left-2 top-1/2 -translate-y-1/2"
      } ${visible ? "scale-100 opacity-100" : "scale-75 opacity-0"}`}
      style={{
        width: 22,
        height: 22,
        minWidth: 0,
        minHeight: 0,
        flex: "none",
        borderRadius: "50%",
        pointerEvents: visible ? "auto" : "none",
        boxShadow: "0 1px 6px rgba(0,0,0,0.28)",
        ...(selected
          ? { backgroundColor: "var(--btn-green)", borderColor: "var(--btn-green)", color: "#fff" }
          : placement === "photo"
            ? { borderColor: "rgba(255,255,255,0.95)", color: "transparent", backgroundColor: "rgba(255,255,255,0.75)" }
            : { borderColor: "var(--faint)", color: "transparent", backgroundColor: "transparent" }),
      }}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
    >
      ✓
    </button>
  );
}

/* ---------- centred delete confirm modal (home list only) ------------
   Replaces the old inline two-step confirm (which rewrote the Delete
   button's own label). Tapping Delete — swipe single or the multi-select
   toolbar — opens this modal. Both buttons are transparent frosted
   glass (.glass) with coloured text only — Confirm in --btn-red,
   Cancel in --btn-green — no solid fills, so the dialog stays light
   and calm. The mask is a very light dim (black 15%) with a 2px blur.
   Cancel or the mask closes without deleting. Deletion happens from
   the home list only (the detail page has no delete button). */
type DeleteConfirm =
  | { kind: "single"; listing: Listing }
  | { kind: "bulk"; count: number };

function DeleteConfirmModal({
  confirm,
  onConfirm,
  onCancel,
}: {
  confirm: DeleteConfirm;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  /* Same gentle 0.2s fade + scale as the notice popup (notice-in/out
     in theme.css): the card fades in on open and out on any exit —
     Confirm, Cancel, mask tap or Escape. The actual action runs after
     the 180ms exit animation, so the card never vanishes abruptly. */
  const [leaving, setLeaving] = useState(false);
  const dismiss = useCallback((fn: () => void) => {
    if (leaving) return;
    setLeaving(true);
    window.setTimeout(fn, 180);
  }, [leaving]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") dismiss(onCancel);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dismiss, onCancel]);
  const message =
    confirm.kind === "single"
      ? "确认删除这台机器？"
      : `确认删除已选的 ${confirm.count} 台机器？`;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-6"
      role="alertdialog"
      aria-modal="true"
      aria-label={message}
    >
      <div
        aria-hidden
        className={`absolute inset-0 bg-black/15 backdrop-blur-[2px] ${leaving ? "notice-backdrop-out" : "lightbox-enter"}`}
        onClick={() => dismiss(onCancel)}
      />
      <div className={`glass relative w-full max-w-xs rounded-2xl border border-[var(--border)] p-5 ${leaving ? "notice-out" : "notice-in"}`}>
        <p className="text-center text-base font-medium text-[var(--text)]">{message}</p>
        <div className="mt-5 flex items-center justify-center gap-4">
          <button
            type="button"
            aria-label="确认删除"
            className="glass rounded-full border px-6 py-3 text-sm font-medium text-[var(--btn-red)] transition-all duration-200 ease-out"
            style={{ borderColor: "color-mix(in srgb, var(--btn-red) 35%, transparent)" }}
            onClick={() => dismiss(onConfirm)}
          >
            确认
          </button>
          <button
            type="button"
            aria-label="取消删除"
            className="glass rounded-full border px-6 py-3 text-sm font-medium text-[var(--btn-green)] transition-all duration-200 ease-out"
            style={{ borderColor: "color-mix(in srgb, var(--btn-green) 35%, transparent)" }}
            onClick={() => dismiss(onCancel)}
          >
            取消
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------- GitHub token modal (footer button) ---------------------------
   Same centred-modal shell as the delete confirm (light dim backdrop,
   frosted glass, coloured text only — no solid fills). The token is
   pasted here and saved only to this browser's localStorage; it is
   never shown back (password field, placeholder only says whether one
   is already set). Saving an empty value leaves the modal open with a
   notice instead of closing it. */
function TokenModal({
  hasToken,
  onSave,
  onClear,
  onCancel,
}: {
  hasToken: boolean;
  onSave: (value: string) => boolean;
  onClear: () => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState("");
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-6"
      role="dialog"
      aria-modal="true"
      aria-label="GitHub 同步令牌"
    >
      <div
        aria-hidden
        className="absolute inset-0 bg-black/15 backdrop-blur-[2px]"
        onClick={onCancel}
      />
      <div className="glass relative w-full max-w-xs rounded-2xl border border-[var(--border)] p-5">
        <p className="text-center text-base font-medium text-[var(--text)]">GitHub Token</p>
        <p className="mt-1 text-center text-xs leading-5 text-[var(--dim)]">
          粘贴后点“同步”会把本机的喜欢上传到云端；不填只下载最新清单。令牌只保存在本浏览器。
        </p>
        <input
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={hasToken ? "已设置令牌" : "粘贴 GitHub 令牌"}
          aria-label="GitHub 同步令牌"
          autoComplete="off"
          autoFocus
          className="glass mt-4 w-full min-w-0 rounded-full border border-[var(--border)] px-4 py-2.5 text-sm text-[var(--text)]"
        />
        <div className="mt-5 flex items-center justify-center gap-4">
          <button
            type="button"
            aria-label="取消"
            className="glass rounded-full border px-6 py-3 text-sm font-medium text-[var(--text)] transition-all duration-200 ease-out"
            onClick={onCancel}
          >
            取消
          </button>
          <button
            type="button"
            aria-label="保存同步令牌"
            className="glass rounded-full border px-6 py-3 text-sm font-medium text-[var(--btn-green)] transition-all duration-200 ease-out"
            style={{ borderColor: "color-mix(in srgb, var(--btn-green) 35%, transparent)" }}
            onClick={() => { if (onSave(value)) onCancel(); }}
          >
            保存
          </button>
        </div>
        {hasToken ? (
          <button
            type="button"
            aria-label="清除同步令牌"
            className="mt-3 w-full text-center text-xs text-[var(--btn-red)]"
            onClick={() => { onClear(); onCancel(); }}
          >
            清除已保存的 Token
          </button>
        ) : null}
      </div>
    </div>
  );
}

/* ---------- centred notice popup (sync result, backup, token) ---------
   Replaces the old inline notice line under the filter bar. After a
   sync (or a backup/token action) the result appears as a frosted
   glass card in the centre of the screen. It closes by tapping
   anywhere outside the card (the dim backdrop) or Escape — there is
   no close button on the card itself (user decision 2026-11-17; the
   small red dot that was there first was removed). Both showing and
   dismissing fade + scale gently over ~0.2s (see .notice-in/out in
   theme.css); the close waits out the exit animation before clearing
   the notice. The popup stays until dismissed — no auto-dismiss. */
function NoticePopup({
  message,
  onClose,
}: {
  message: string;
  onClose: () => void;
}) {
  const [leaving, setLeaving] = useState(false);
  const close = useCallback(() => {
    if (leaving) return;
    setLeaving(true);
    window.setTimeout(onClose, 180);
  }, [leaving, onClose]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-6"
      role="status"
      aria-label={message}
    >
      <div
        aria-hidden
        className={`absolute inset-0 bg-black/15 backdrop-blur-[2px] ${leaving ? "notice-backdrop-out" : "lightbox-enter"}`}
        onClick={close}
      />
      <div
        className={`glass relative w-full max-w-xs rounded-2xl border border-[var(--border)] p-5 ${leaving ? "notice-out" : "notice-in"}`}
      >
        <p className="text-center text-sm leading-6 text-[var(--text)]">{message}</p>
      </div>
    </div>
  );
}

/* ---------- home list item: swipe-to-delete + long-press multi-select -----
   One wrapper around a list item (Card in single mode, ListRow in multi
   mode) that adds three gestures which must not interfere:
   - short tap: open detail (normal mode) / toggle selection (multi-select)
   - horizontal left swipe: reveal a small round red trash button (normal
     mode only); tapping it opens a centred confirm modal (see
     DeleteConfirmModal)
   - long-press 1s: enter multi-select, this item auto-selected
   Layout: the card frame never moves, and entering multi-select moves
   nothing inside it either. In single-column cards the checkbox floats
   on the photo's top-left corner (see SelectCheckbox "photo") — no
   padding shift, no text slide, no image reflow — so the photo can
   never be squeezed and the like button never moves. Multi-column rows
   have no photo: the checkbox sits at the left of the row's text area
   and the text's left padding grows 16px -> 56px on enter and back on
   exit, so only the text slides inside the frame — smooth both ways
   via a 200ms padding transition. The swipe area holds the delete
   action behind the item; the item translates left to reveal it.
   Delete only appends to localStorage deletions (via onDelete, which
   opens the confirm modal) — listings.json is never written.
   The row is a no-select surface (user-select/callout off, selectstart
   + contextmenu prevented) so a long-press never triggers the OS text
   selection handles. touch-action: pan-y lets vertical scrolls work
   natively; horizontal drags reach the JS handlers. No preventDefault:
   the browser never starts a horizontal scroll, so the swipe works
   without it. */

const SWIPE_DELETE_W = 88;
const LONG_PRESS_MS = 1000;

function SwipeableItem({
  listing,
  rate,
  layout,
  onOpen,
  onToggleLike,
  onDelete,
  isSwipedOpen,
  onSwipeOpen,
  onSwipeClose,
  multiSelect,
  isSelected,
  onToggleSelect,
  onEnterMultiSelect,
}: {
  listing: Listing;
  rate: number | null;
  layout: LayoutMode;
  onOpen: (l: Listing) => void;
  onToggleLike: (l: Listing) => void;
  onDelete: (l: Listing) => void;
  isSwipedOpen: boolean;
  onSwipeOpen: (id: string) => void;
  onSwipeClose: () => void;
  multiSelect: boolean;
  isSelected: boolean;
  onToggleSelect: (id: string) => void;
  onEnterMultiSelect: (id: string) => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const offsetRef = useRef(0);
  const dragging = useRef(false);
  const longPressTimer = useRef<number | null>(null);
  const suppressClick = useRef(false);

  const targetOffset = isSwipedOpen ? -SWIPE_DELETE_W : 0;

  const setOffset = useCallback((px: number, animate: boolean) => {
    const el = trackRef.current;
    if (!el) return;
    el.style.transition = animate ? "transform 200ms ease-out" : "none";
    el.style.transform = px === 0 ? "" : `translateX(${px}px)`;
    offsetRef.current = px;
  }, []);

  // Sync the row position when the parent opens/closes/confirms it
  // (another row opened, a tap elsewhere closed it, timeout, ...).
  useEffect(() => {
    if (!dragging.current) setOffset(targetOffset, true);
  }, [targetOffset, setOffset]);

  // Belt-and-braces for the no-select surface: even if a long-press
  // reaches the selection machinery, selectstart is cancelled here.
  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const stop = (e: Event) => e.preventDefault();
    el.addEventListener("selectstart", stop);
    return () => el.removeEventListener("selectstart", stop);
  }, []);

  const clearLongPress = useCallback(() => {
    if (longPressTimer.current !== null) {
      window.clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  }, []);

  const handleTouchStart = (e: ReactTouchEvent) => {
    // A menu is open: this touch only closes the menu (the MenuSelect
    // click guard swallows the click, the mousedown closes the menu) —
    // it must not start a long-press or a swipe on the row underneath.
    if (menuOpenCount > 0) {
      clearLongPress();
      start.current = null;
      return;
    }
    // A stale suppress flag (a long-press whose click never fired) must
    // not swallow the next real tap.
    suppressClick.current = false;
    const t = e.touches[0];
    if (!t) return;
    start.current = { x: t.clientX, y: t.clientY };
    dragging.current = false;
    if (!multiSelect) {
      clearLongPress();
      longPressTimer.current = window.setTimeout(() => {
        suppressClick.current = true;
        onEnterMultiSelect(listing.id);
      }, LONG_PRESS_MS);
    }
  };

  const handleTouchMove = (e: ReactTouchEvent) => {
    const s = start.current;
    const t = e.touches[0];
    if (!s || !t) return;
    const dx = t.clientX - s.x;
    const dy = t.clientY - s.y;
    // Any real movement cancels the long-press.
    if (movedEnough(dx, dy)) clearLongPress();
    if (multiSelect) return; // no swipe-to-delete while multi-selecting
    if (!dragging.current) {
      if (isSwipeIntent(dx, dy)) {
        dragging.current = true;
      } else if (isScrollIntent(dx, dy)) {
        // Vertical scroll: if this row was open, close it.
        if (isSwipedOpen) onSwipeClose();
        start.current = null;
        return;
      } else {
        return;
      }
    }
    // Horizontal drag: follow the finger, clamped to [-maxOpen, 0].
    const maxOpen = SWIPE_DELETE_W;
    setOffset(clampSwipeOffset(targetOffset, dx, maxOpen), false);
  };

  const handleTouchEnd = () => {
    clearLongPress();
    if (!dragging.current) {
      start.current = null;
      return; // a tap (or a long-press); the click handler decides
    }
    dragging.current = false;
    const maxOpen = SWIPE_DELETE_W;
    const snapped = snapSwipeOffset(offsetRef.current, maxOpen);
    setOffset(snapped, true);
    if (snapped === -maxOpen) {
      if (!isSwipedOpen) onSwipeOpen(listing.id);
    } else if (isSwipedOpen) {
      onSwipeClose();
    }
    start.current = null;
  };

  const handleTouchCancel = () => {
    clearLongPress();
    dragging.current = false;
    setOffset(targetOffset, true);
    start.current = null;
  };

  const handleClickCapture = (e: ReactMouseEvent) => {
    // The click that follows a long-press must not open the detail or
    // toggle anything — the long-press already entered multi-select.
    if (suppressClick.current) {
      suppressClick.current = false;
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    const target = e.target as HTMLElement;
    // Let the swipe-delete buttons handle their own clicks.
    if (target.closest("[data-swipe-delete]")) return;
    if (multiSelect) {
      // In multi-select, any tap on the item toggles its checkbox.
      e.preventDefault();
      e.stopPropagation();
      onToggleSelect(listing.id);
      return;
    }
    if (isSwipedOpen) {
      // Tapping an open row closes it instead of opening the detail.
      e.preventDefault();
      e.stopPropagation();
      onSwipeClose();
    }
    // Normal tap: let the inner buttons open the detail / toggle like.
  };

  return (
    <div className={`relative min-w-0 w-full overflow-hidden rounded-[10px] ${layout === "single" ? "h-full" : ""}`}>
      {/* Delete action behind the item: NOT a full-height slab — a small
          round red trash button (48px) floating mid-height in the reveal
          zone. A slab the height of a tall single-column card looked
          heavy and ugly, and its square corners could never follow the
          card's rounded border; a circle has no corners to mismatch.
          Tapping it opens the centred confirm modal. */}
      <div
        className="absolute inset-y-0 right-0 z-0 w-[88px]"
        aria-hidden={!isSwipedOpen}
      >
        <button
          type="button"
          data-swipe-delete
          aria-label="删除这台机器"
          tabIndex={isSwipedOpen ? 0 : -1}
          disabled={!isSwipedOpen}
          className="absolute right-5 top-1/2 flex h-12 w-12 -translate-y-1/2 items-center justify-center rounded-full text-white shadow-lg"
          style={{ backgroundColor: "var(--verdict-red)" }}
          onClick={() => onDelete(listing)}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className="h-6 w-6" aria-hidden="true">
            <path d="M14.74 9l-.35 9m-3.788 0L10.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
          </svg>
        </button>
      </div>
      <div
        ref={trackRef}
        className={`relative z-10 will-change-transform ${layout === "single" ? "h-full" : ""}`}
        style={{ touchAction: "pan-y", WebkitTouchCallout: "none", userSelect: "none", WebkitUserSelect: "none" }}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onTouchCancel={handleTouchCancel}
        onClickCapture={handleClickCapture}
        onContextMenu={(e) => e.preventDefault()}
      >
        {layout === "single" ? (
          <MemoCard
            listing={listing}
            rate={rate}
            onOpen={onOpen}
            onToggleLike={onToggleLike}
            multiSelect={multiSelect}
            isSelected={isSelected}
            onToggleSelect={onToggleSelect}
          />
        ) : (
          <MemoListRow
            listing={listing}
            rate={rate}
            onOpen={onOpen}
            onToggleLike={onToggleLike}
            multiSelect={multiSelect}
            isSelected={isSelected}
            onToggleSelect={onToggleSelect}
          />
        )}
      </div>
    </div>
  );
}

const MemoSwipeableItem = memo(SwipeableItem);

/* ---------- pinch-zoom photo (original-image viewer only) ------------------
   Two-finger pinch zooms the photo up to 4x around the point held
   between the fingers; while zoomed, one finger (or the mouse) drags
   to pan across the detail. At 1x the wrapper leaves touches alone so
   the carousel keeps its swipe-to-switch gesture untouched. When the
   slide stops being the current one — photo switched or viewer closed
   (unmount) — the zoom resets to normal size. Touch and wheel
   listeners are attached natively with passive:false so preventDefault
   can stop the carousel track scrolling mid-pinch or mid-pan; the
   parent carousel also locks its own scrolling while a zoom is live. */

const ZOOM_MAX = 4;

interface ZoomGesture {
  mode: "pinch" | "pan";
  startDist: number;
  startScale: number;
  /* Photo-space point held under the pinch midpoint. */
  px: number;
  py: number;
  /* Pan: touch start point and the translate at gesture start. */
  startX: number;
  startY: number;
  tx: number;
  ty: number;
}

/* Memoised: a swipe re-renders the carousel for every index change, and
   without memo every slide's zoom machinery re-rendered with it — one of
   the jank sources when switching photos in the viewer. Props are kept
   stable by the carousel (index + a stable onZoomChange), so only the
   slide whose `active`/`alt` actually changed re-renders. */
const ZoomableImage = memo(function ZoomableImage({
  src,
  alt,
  imgClassName,
  index,
  active,
  onZoomChange,
}: {
  src: string;
  alt: string;
  imgClassName?: string;
  index: number;
  active: boolean;
  onZoomChange: (index: number, zoomed: boolean) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  /* The zoom view lives in a ref, NOT in React state: a pinch or pan
     fires dozens of moves per second, and routing each one through
     setState re-rendered this component (and reconciled its subtree)
     per move — a steady source of viewer jank. apply() now writes the
     transform straight onto the <img> node; the only state left is
     the boolean that flips the wrapper's touch-action, which changes
     at most twice per gesture. */
  const viewRef = useRef({ s: 1, x: 0, y: 0 });
  const [zoomed, setZoomed] = useState(false);
  const zoomedRef = useRef(false);
  const onZoomRef = useRef(onZoomChange);
  onZoomRef.current = onZoomChange;
  const indexRef = useRef(index);
  indexRef.current = index;
  const gesture = useRef<ZoomGesture | null>(null);
  const mouse = useRef<{ startX: number; startY: number; tx: number; ty: number } | null>(
    null,
  );

  const apply = useCallback((s: number, x: number, y: number) => {
    const img = imgRef.current;
    let nx = x;
    let ny = y;
    if (s <= 1) {
      nx = 0;
      ny = 0;
    } else if (img) {
      const maxX = (img.offsetWidth * (s - 1)) / 2;
      const maxY = (img.offsetHeight * (s - 1)) / 2;
      nx = Math.max(-maxX, Math.min(maxX, nx));
      ny = Math.max(-maxY, Math.min(maxY, ny));
    }
    viewRef.current = { s, x: nx, y: ny };
    if (img) {
      img.style.transform = `translate3d(${nx}px, ${ny}px, 0) scale(${s})`;
    }
    const z = s > 1;
    if (z !== zoomedRef.current) {
      zoomedRef.current = z;
      setZoomed(z);
    }
    onZoomRef.current(indexRef.current, z);
  }, []);
  const applyRef = useRef(apply);
  applyRef.current = apply;

  // Switching to another photo resets this slide to normal size.
  useEffect(() => {
    if (!active) {
      gesture.current = null;
      mouse.current = null;
      const v = viewRef.current;
      if (v.s !== 1 || v.x !== 0 || v.y !== 0) applyRef.current(1, 0, 0);
    }
  }, [active]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el || !active) return;
    const center = () => {
      const r = el.getBoundingClientRect();
      return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
    };
    const distOf = (a: Touch, b: Touch) =>
      Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    const panFrom = (t: Touch): ZoomGesture => {
      const v = viewRef.current;
      return {
        mode: "pan",
        startDist: 0,
        startScale: v.s,
        px: 0,
        py: 0,
        startX: t.clientX,
        startY: t.clientY,
        tx: v.x,
        ty: v.y,
      };
    };
    const onStart = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        const a = e.touches[0];
        const b = e.touches[1];
        if (!a || !b) return;
        const { cx, cy } = center();
        const mx = (a.clientX + b.clientX) / 2 - cx;
        const my = (a.clientY + b.clientY) / 2 - cy;
        const v = viewRef.current;
        gesture.current = {
          mode: "pinch",
          startDist: distOf(a, b),
          startScale: v.s,
          px: (mx - v.x) / v.s,
          py: (my - v.y) / v.s,
          startX: 0,
          startY: 0,
          tx: v.x,
          ty: v.y,
        };
        el.addEventListener("touchmove", onMove, { passive: false });
        e.preventDefault();
      } else if (e.touches.length === 1 && viewRef.current.s > 1) {
        const t = e.touches[0];
        if (t) gesture.current = panFrom(t);
        el.addEventListener("touchmove", onMove, { passive: false });
      }
    };
    const onMove = (e: TouchEvent) => {
      const g = gesture.current;
      if (!g) return;
      if (g.mode === "pinch" && e.touches.length === 2) {
        const a = e.touches[0];
        const b = e.touches[1];
        if (!a || !b) return;
        e.preventDefault();
        const { cx, cy } = center();
        const mx = (a.clientX + b.clientX) / 2 - cx;
        const my = (a.clientY + b.clientY) / 2 - cy;
        const s = Math.max(
          1,
          Math.min(
            ZOOM_MAX,
            g.startDist > 0
              ? (g.startScale * distOf(a, b)) / g.startDist
              : g.startScale,
          ),
        );
        applyRef.current(s, mx - g.px * s, my - g.py * s);
      } else if (g.mode === "pan" && e.touches.length >= 1) {
        const t = e.touches[0];
        if (!t) return;
        e.preventDefault();
        applyRef.current(
          viewRef.current.s,
          g.tx + (t.clientX - g.startX),
          g.ty + (t.clientY - g.startY),
        );
      }
    };
    const onEnd = (e: TouchEvent) => {
      const g = gesture.current;
      if (e.touches.length === 1 && g?.mode === "pinch" && viewRef.current.s > 1) {
        // One finger lifted mid-pinch: keep going as a one-finger pan.
        const t = e.touches[0];
        if (t) gesture.current = panFrom(t);
      } else if (e.touches.length === 0) {
        el.removeEventListener("touchmove", onMove);
        gesture.current = null;
        if (viewRef.current.s <= 1.02) applyRef.current(1, 0, 0);
      }
    };
    const onWheel = (e: WheelEvent) => {
      // Trackpad pinch arrives as a ctrl+wheel event on desktop.
      if (!e.ctrlKey) return;
      e.preventDefault();
      const v = viewRef.current;
      const { cx, cy } = center();
      const mx = e.clientX - cx;
      const my = e.clientY - cy;
      const px = (mx - v.x) / v.s;
      const py = (my - v.y) / v.s;
      const s = Math.max(
        1,
        Math.min(ZOOM_MAX, v.s * (e.deltaY < 0 ? 1.12 : 0.89)),
      );
      applyRef.current(s, mx - px * s, my - py * s);
    };
    el.addEventListener("touchstart", onStart, { passive: false });
    el.addEventListener("touchend", onEnd);
    el.addEventListener("touchcancel", onEnd);
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", onEnd);
      el.removeEventListener("wheel", onWheel);
    };
  }, [active]);

  const onMouseDown = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (viewRef.current.s <= 1) return;
    const v = viewRef.current;
    mouse.current = { startX: e.clientX, startY: e.clientY, tx: v.x, ty: v.y };
    const move = (ev: MouseEvent) => {
      const m = mouse.current;
      if (!m) return;
      applyRef.current(
        viewRef.current.s,
        m.tx + (ev.clientX - m.startX),
        m.ty + (ev.clientY - m.startY),
      );
    };
    const up = () => {
      mouse.current = null;
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  return (
    <div
      ref={wrapRef}
      className="flex h-full w-full items-center justify-center overflow-hidden"
      style={{ touchAction: zoomed ? "none" : "pan-x pan-y" }}
      onMouseDown={onMouseDown}
    >
      <img
        ref={imgRef}
        src={src}
        alt={alt}
        draggable={false}
        decoding="async"
        className={imgClassName}
        style={{ willChange: "transform" }}
      />
    </div>
  );
});

/* ---------- Carousell-style photo carousel ---------------------------------
   A horizontal scroll-snap strip, like Carousell's photo viewer:
   swiping (or scrolling) snaps to the nearest photo, and a thumbnail
   strip underneath highlights the current photo; tapping a thumbnail
   jumps straight to it. Used by both the detail gallery and the
   original-image viewer, replacing the old crossfade switching.
   The stage height is FIXED by the caller (trackClassName): every slide
   fills that height and flex-centres its photo, and the photo itself is
   sized only by max-h/max-w + object-contain — never by a percentage
   height or an aspect-ratio box — so landscape and portrait photos alike
   sit dead centre and the strip never jumps up or down when swiping.
   Slides span the whole track width with no side padding, so at rest
   only the current photo is on screen — the neighbours sit fully
   off-screen and are pulled in by the finger only while dragging, then
   snap into place on release. (The detail gallery used to peek its
   neighbours at rest with 86% slides; the user asked for the same
   full-width rest state as the viewer, with the swipe itself — drag,
   follow-the-finger, snap on release — completely unchanged.)
   Smoothness, after a stutter report in the viewer: three causes were
   found and fixed. (1) Neighbour photos were only decoded when they
   slid on screen, so a big JPEG decoded mid-snap and hitched — the
   current photo and both neighbours are now fetched and decode()d
   ahead of time whenever the index changes. (2) Every scroll event ran
   setState + layout reads, and each scroll-driven index change also
   re-triggered the follow-external-index effect, which fired a
   programmatic smooth scrollTo that fought the browser's own snap
   animation — scroll handling is now coalesced to one run per frame
   and scroll-driven index changes are flagged so the effect stays out
   of the gesture. (3) Every slide re-rendered on each index change —
   slides are memoised now (see ZoomableImage). */

function Carousel({
  images,
  idx,
  onIdx,
  alt,
  onTapImage,
  trackClassName,
  slideClassName,
  imgClassName,
  zoomable,
}: {
  images: string[];
  idx: number;
  onIdx: (i: number) => void;
  alt: string;
  onTapImage?: (i: number) => void;
  trackClassName?: string;
  slideClassName?: string;
  imgClassName?: string;
  /* Original-image viewer only: slides render a pinch-zoom photo, and
     the track locks its scrolling while the current photo is zoomed so
     panning the detail never swipes to another photo. */
  zoomable?: boolean;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const idxRef = useRef(idx);
  idxRef.current = idx;
  const progRef = useRef<number | null>(null);
  const touchX = useRef<number | null>(null);
  const moved = useRef(false);
  /* Set when the latest index change came from the track's own scroll
     handler (a swipe): the follow effect below must not answer it with
     a programmatic smooth scroll — the browser's snap is already
     animating the strip, and a second animation on top is what made
     switching hitch. */
  const scrollDrivenRef = useRef(false);
  const scrollRafRef = useRef<number | null>(null);
  const [zoomLocked, setZoomLocked] = useState(false);

  const handleZoom = useCallback((i: number, zoomed: boolean) => {
    if (i === idxRef.current) setZoomLocked(zoomed);
  }, []);

  // A different photo always starts unzoomed (the old slide resets too).
  useEffect(() => {
    setZoomLocked(false);
  }, [idx]);

  // Fetch and fully decode the current photo and its two neighbours
  // ahead of time, so a swipe never waits on the network or on a JPEG
  // decode in the middle of the snap animation.
  useEffect(() => {
    for (const j of [idx - 1, idx, idx + 1]) {
      const src = images[j];
      if (!src) continue;
      const pre = new Image();
      pre.decoding = "async";
      pre.src = src;
      pre.decode().catch(() => {
        /* best effort: the slide's own <img> still loads it normally */
      });
    }
  }, [idx, images]);

  const stepOf = useCallback(() => {
    const track = trackRef.current;
    if (!track) return 0;
    const a = track.children[0] as HTMLElement | undefined;
    const b = track.children[1] as HTMLElement | undefined;
    if (!a) return 0;
    return b ? b.offsetLeft - a.offsetLeft : a.offsetWidth;
  }, []);

  // Jump straight to the starting photo on mount.
  useLayoutEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    const step = stepOf();
    if (step > 0 && idxRef.current > 0) {
      track.scrollLeft = idxRef.current * step;
    }
  }, []);

  // Follow external index changes (thumbnail taps): smooth-scroll the
  // strip so that photo snaps to the centre. Index changes that came
  // from the strip's own scrolling are skipped: the strip is already
  // there (or snapping there under the user's finger), and answering
  // with a programmatic smooth scroll made the two animations fight.
  useEffect(() => {
    if (scrollDrivenRef.current) {
      scrollDrivenRef.current = false;
      return;
    }
    const track = trackRef.current;
    if (!track) return;
    const step = stepOf();
    if (step === 0) return;
    const target = idx * step;
    if (Math.abs(track.scrollLeft - target) <= 4) return;
    progRef.current = target;
    track.scrollTo({ left: target, behavior: "smooth" });
    const t = window.setTimeout(() => {
      if (progRef.current === target) progRef.current = null;
    }, 700);
    return () => window.clearTimeout(t);
  }, [idx, images, stepOf]);

  // Rotation / window resize: slide widths follow the track, so the old
  // pixel offset no longer lands on a photo boundary. Re-align the strip
  // to the current photo at the new step; the photo itself re-fits the
  // new screen size through its max-w/max-h sizing. Height-only changes
  // (mobile URL bar showing/hiding) leave the step unchanged and no-op.
  useEffect(() => {
    const onResize = () => {
      const track = trackRef.current;
      if (!track) return;
      const step = stepOf();
      if (step === 0) return;
      const target = idxRef.current * step;
      if (Math.abs(track.scrollLeft - target) <= 4) return;
      progRef.current = target;
      track.scrollLeft = target;
      window.setTimeout(() => {
        if (progRef.current === target) progRef.current = null;
      }, 300);
    };
    window.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("orientationchange", onResize);
    };
  }, [stepOf]);

  // Scroll events fire far more often than frames render; coalesce
  // them to one index computation per animation frame so a swipe never
  // queues a backlog of setState + layout reads behind the gesture.
  const handleScroll = () => {
    if (scrollRafRef.current != null) return;
    scrollRafRef.current = window.requestAnimationFrame(() => {
      scrollRafRef.current = null;
      const track = trackRef.current;
      if (!track) return;
      if (progRef.current != null) {
        if (Math.abs(track.scrollLeft - progRef.current) <= 4) {
          progRef.current = null;
        } else {
          return;
        }
      }
      const step = stepOf();
      if (step === 0) return;
      const i = Math.max(
        0,
        Math.min(images.length - 1, Math.round(track.scrollLeft / step)),
      );
      if (i !== idxRef.current) {
        scrollDrivenRef.current = true;
        onIdx(i);
      }
    });
  };

  useEffect(
    () => () => {
      if (scrollRafRef.current != null) {
        window.cancelAnimationFrame(scrollRafRef.current);
        scrollRafRef.current = null;
      }
    },
    [],
  );

  return (
    <div
      ref={trackRef}
      data-hscroll="true"
      className={`gallery-track no-scrollbar flex snap-x snap-mandatory ${zoomLocked ? "overflow-x-hidden" : "overflow-x-auto"} overflow-y-hidden px-0 ${trackClassName ?? ""}`}
      onScroll={handleScroll}
      onTouchStart={(e) => {
        touchX.current = e.touches[0]?.clientX ?? null;
        moved.current = false;
      }}
      onTouchMove={(e) => {
        if (touchX.current == null) return;
        const x = e.touches[0]?.clientX ?? touchX.current;
        if (Math.abs(x - touchX.current) > 8) moved.current = true;
      }}
    >
      {images.map((src, i) => (
        <div
          key={`${i}-${src.slice(0, 48)}`}
          className={`flex h-full w-full shrink-0 select-none items-center justify-center snap-center ${slideClassName ?? ""}`}
        >
          {onTapImage ? (
            <button
              type="button"
              aria-label={`查看原图：${alt}`}
              className="flex h-full w-full items-center justify-center"
              onClick={() => {
                if (!moved.current) onTapImage(i);
              }}
            >
              <img
                src={src}
                alt={i === idx ? alt : ""}
                draggable={false}
                decoding="async"
                className={imgClassName}
              />
            </button>
          ) : zoomable ? (
            <ZoomableImage
              src={src}
              alt={i === idx ? alt : ""}
              imgClassName={imgClassName}
              index={i}
              active={i === idx}
              onZoomChange={handleZoom}
            />
          ) : (
            <img
              src={src}
              alt={i === idx ? alt : ""}
              draggable={false}
              decoding="async"
              className={imgClassName}
            />
          )}
        </div>
      ))}
    </div>
  );
}

function ThumbStrip({
  images,
  idx,
  onIdx,
}: {
  images: string[];
  idx: number;
  onIdx: (i: number) => void;
}) {
  const outerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const outer = outerRef.current;
    const active = outer?.querySelector<HTMLElement>(
      `[data-thumb="${idx}"]`,
    );
    if (outer && active) {
      outer.scrollTo({
        left:
          active.offsetLeft - outer.clientWidth / 2 + active.clientWidth / 2,
        behavior: "smooth",
      });
    }
  }, [idx]);

  return (
    <div ref={outerRef} data-hscroll="true" className="no-scrollbar overflow-x-auto">
      <div className="relative flex w-max min-w-full justify-center gap-2 px-4">
        {images.map((src, i) => (
          <button
            key={`${i}-${src.slice(0, 48)}`}
            type="button"
            data-thumb={i}
            aria-label={`查看第 ${i + 1} 张照片`}
            aria-current={i === idx}
            className={`h-14 w-14 shrink-0 overflow-hidden rounded-lg border-2 transition-opacity ${
              i === idx
                ? "border-[var(--carousel)] opacity-100"
                : "border-transparent opacity-50"
            }`}
            onClick={() => onIdx(i)}
          >
            <img
              src={src}
              alt=""
              loading="lazy"
              decoding="async"
              draggable={false}
              className="h-full w-full object-cover"
            />
          </button>
        ))}
      </div>
    </div>
  );
}

/* ---------- original-image viewer (Carousell-style carousel) --------------
   The carousel fills the WHOLE screen (absolute inset-0) and the close
   button + thumbnail strip float over it, so each photo fits the screen
   itself — scaled proportionally to the screen's own width and height,
   landscape or portrait, never cropped, with no black bars beyond what
   the photo's own aspect ratio requires. Rotating the device or
   resizing the window re-fits automatically: the track follows the
   screen and the carousel re-snaps to the current photo (see the resize
   handler in Carousel). Pinch zoom and swipe switching are unaffected:
   the overlays let touches pass through except on the controls
   themselves. */

function Lightbox({
  images,
  idx,
  onIdx,
  alt,
  onClose,
}: {
  images: string[];
  idx: number;
  onIdx: (i: number) => void;
  alt: string;
  onClose: () => void;
}) {
  const safeIdx = Math.min(idx, Math.max(0, images.length - 1));
  return (
    <div className="lightbox-enter fixed inset-0 z-50 bg-[#1c1c1e]">
      <div className="absolute inset-0">
        <Carousel
          images={images}
          idx={safeIdx}
          onIdx={onIdx}
          alt={alt}
          zoomable
          trackClassName="h-full w-full"
          imgClassName="max-h-full max-w-full object-contain"
        />
      </div>
      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-center px-3 py-2 pt-safe">
        <button
          type="button"
          aria-label="关闭原图"
          className="pointer-events-auto flex h-11 w-11 items-center justify-center rounded-full text-white"
          onClick={onClose}
        >
          <svg
            width="26"
            height="26"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="M5 5l14 14M19 5L5 19" />
          </svg>
        </button>
      </div>
      {images.length > 1 ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 pb-5 pt-3 pb-safe">
          <div className="pointer-events-auto mx-auto w-fit max-w-full">
            <ThumbStrip images={images} idx={safeIdx} onIdx={onIdx} />
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* ---------- detail -------------------------------------------------------- */

function Row({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-2.5">
      <span className="text-sm text-[var(--dim)]">{k}</span>
      <span className="text-right text-base text-[var(--text)]">{children}</span>
    </div>
  );
}

function Detail({
  listing,
  rate,
  onClose,
  onToggleLike,
  onSaveAnalysis,
  homeRef,
}: {
  listing: Listing;
  rate: number | null;
  onClose: () => void;
  onToggleLike: (l: Listing) => void;
  onSaveAnalysis: (id: string, a: Analysis) => void;
  /* The home (list) layer underneath this overlay. The swipe-back
     gesture writes its parallax pull straight onto this element and
     animates the blur radius of a static snapshot of it above it, so
     a drag never re-renders the list per frame. */
  homeRef: RefObject<HTMLElement | null>;
}) {
  // getState now carries only the cover photo per listing (the full
  // payload was several MB of inline base64 and made every load and
  // refetch hitch); the rest of this listing's gallery is fetched here,
  // once, when the detail page opens. Until it lands, the gallery shows
  // the cover photo alone — the same first slide it will keep.
  const images = api.imagesFor(listing.id) ?? listing.images;
  const [idx, setIdx] = useState(0);
  const [lightbox, setLightbox] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  /* The editor's draft is reset from the listing every time it opens
     and on cancel (audit 2026-11-17): cancelled edits used to reappear
     the next time the editor opened, because the draft was only ever
     initialised once. */
  const resetDraft = useCallback(() => {
    setDraft({
      saleLow: listing.saleLow,
      saleHigh: listing.saleHigh,
      sampleCount: listing.sampleCount,
      soldSource: listing.soldSource,
      shippingSgd: listing.shippingSgd,
      repairSgd: listing.repairSgd,
      feePercent: listing.feePercent,
      targetProfit: listing.targetProfit,
    });
  }, [listing]);
  const [draft, setDraft] = useState<Analysis>(() => ({
    saleLow: listing.saleLow,
    saleHigh: listing.saleHigh,
    sampleCount: listing.sampleCount,
    soldSource: listing.soldSource,
    shippingSgd: listing.shippingSgd,
    repairSgd: listing.repairSgd,
    feePercent: listing.feePercent,
    targetProfit: listing.targetProfit,
  }));
  const c = calc(listing, rate);
  const safeIdx = Math.min(idx, Math.max(0, images.length - 1));

  const handleClose = useCallback(() => {
    if (leaving) return;
    setLeaving(true);
    // Matches .detail-leave in theme.css: the sheet is gently
    // pulled back out to the right, then unmounts.
    window.setTimeout(onClose, 340);
  }, [leaving, onClose]);

  const copySeller = useCallback(async () => {
    if (!listing.seller) return;
    const ok = await copyText(sellerName(listing.seller));
    if (ok) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    }
  }, [listing.seller]);

  /* ---------- swipe-right-to-go-back -------------------------------------
     A rightward drag on the detail page pulls the page along with the
     finger while the home list underneath is revealed: at the start of
     the pull the home sits shifted left and heavily gaussian-blurred,
     and both ease to zero as the drag progresses, so the revealed home
     sharpens to fully clear exactly when the return completes. The
     detail page itself carries NO gaussian blur at all (user
     decision): the live page stays fully sharp for the whole push
     and simply slides with the finger — the home snapshot's radius
     is the only blur in the entire gesture.

     ONE IMAGE FOR THE HOME — the anti-ghosting rule this
     implementation is built on. Every earlier version cross-faded a
     blurred copy against the sharp original, and at every
     intermediate progress BOTH images were on screen at once: sharp
     glyphs plus their own blurred twins read as doubled edges — the
     残影 in the user's recordings, worst exactly where a slow drag
     lingers (mid-fade). No alignment fix can cure that; it is what a
     crossfade IS. So there are no crossfades anymore. When the
     gesture engages, the live home is made transparent (opacity 0 —
     its layout and scroll offset are preserved, unlike
     visibility:hidden) and a static, sanitised snapshot of it
     becomes the home's ONLY image; the blur is that snapshot's own
     filter radius, animated with the drag progress — one image, one
     radius, nothing superimposed, so doubled edges are impossible
     by construction. The detail page needs no snapshot: unblurred,
     the live overlay itself is what slides. The snapshot is a DOM
     clone stripped by the .blur-snap rules (no backdrop-filters, no
     animations, no content-visibility), so a per-frame radius change
     re-renders one static screenful, not the live 79-card list —
     that live-list re-raster was the hitch of the very first
     live-filter version. Radius writes are quantised to 0.25px
     steps so frames whose radius barely moved write nothing.
     Releasing past ~35% of the width — or with a fast flick —
     completes the return; anything else settles back onto the
     detail page. The release itself is not a fixed-duration
     transition: a spring is integrated frame by frame, seeded with
     the finger's own release velocity, so a flick keeps its
     momentum and a gentle let-go eases out softly, and both
     outcomes (slide-off and bounce-back) ride the same spring. Every
     frame writes the detail offset, the home pull and the home blur
     radius from that one spring position, so all of them stay in
     lockstep with no jump or hitch at the hand-off.
     Conflict rules (all deliberate): the gesture only ever engages on
     a clearly horizontal, rightward, single-finger drag; a vertical-
     dominant move kills it for that touch so page scrolling is
     untouched. Touches that start inside a [data-hscroll] region (the
     photo carousel track and the thumbnail strips) never engage, so
     swipe-to-switch-photo keeps working there, and the gesture is
     fully disabled while the original-image viewer is open, leaving
     its swipe switching and pinch zoom exactly as they were. All
     styles are written directly to the DOM nodes (this overlay and
     the home layer) — no React state changes during a drag. */
  const rootRef = useRef<HTMLDivElement>(null);
  const lightboxRef = useRef(lightbox);
  lightboxRef.current = lightbox;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  /* The gesture's home snapshot is cached between touches (rebuilding
     it per touch was the press hitch). Anything that changes how the
     home looks — a like tapped on this page, an analysis edit — must
     therefore mark the cache dirty, or the next drag would reveal a
     stale copy of the home and snap to the real one at settle (a
     small ghost of exactly the kind the single-image rule exists to
     prevent). The listing object changes identity on precisely those
     edits, so watching it covers both. */
  const homeDirtyRef = useRef(false);
  useEffect(() => {
    homeDirtyRef.current = true;
  }, [listing]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const BLUR_MAX = 16;
    const PULL_MAX = 56;
    interface Drag {
      startX: number;
      startY: number;
      dx: number;
      engaged: boolean;
      dead: boolean;
      samples: Array<{ x: number; t: number }>;
    }
    let drag: Drag | null = null;
    let animating = false;
    let raf: number | null = null;
    let lastDx = 0;
    /* Drag frames are coalesced onto requestAnimationFrame:
       touchmove can fire several times per frame, and writing the
       three transforms + opacity for each one queues style work the
       compositor then has to chew through — a subtle judder on top
       of the finger. One write per frame, latest position wins. */
    let moveRaf: number | null = null;
    let pendingDx: number | null = null;
    const flushDrag = () => {
      moveRaf = null;
      if (pendingDx != null) {
        const dx = pendingDx;
        pendingDx = null;
        applyDrag(dx);
      }
    };
    const scheduleDrag = (dx: number) => {
      pendingDx = dx;
      if (moveRaf == null) moveRaf = requestAnimationFrame(flushDrag);
    };
    const cancelMoveRaf = () => {
      if (moveRaf != null) {
        cancelAnimationFrame(moveRaf);
        moveRaf = null;
      }
      pendingDx = null;
    };

    /* The blurred home the reveal starts from is a STATIC snapshot
       of the home node, cloned once into a fixed, viewport-clipped
       layer. While the gesture runs, this snapshot is the home's
       ONLY image (the live <main> is transparent — see the engage
       block in onMove) and its filter radius is animated
       16px → 0 with the drag progress: the home sharpens in place,
       one image at every instant, so no sharp/blurred pair ever
       overlaps into doubled edges. Animating the radius on the
       LIVE <main> was the first version's hitch — it re-rasterised
       all 71 live cards (photos, glass buttons, backdrop-filters)
       every frame; the clone is sanitised by the .blur-snap rules
       in theme.css (no backdrop-filter, no animations, no
       content-visibility), so a radius change re-renders one
       static screenful instead. The layer is padded past the
       viewport on every side so the blur's edge falloff happens
       off-screen, and the clone's filter bar is displaced by a
       measured transform to exactly where the real one is visibly
       stuck, without leaving the clone's flow (see makeBlurLayer).
       The layer's HOST matters as much as its z-index: it used to
       be appended to <body> at z-index 35, but the detail overlay's
       z-40 is scoped inside the shell scroll container's stacking
       context, so the body-level layer painted over the WHOLE app —
       the blurred home smeared across the detail page itself (the
       穿模 in the user's recording). It is now inserted into the
       app root, directly before this overlay, at z-index 39: same
       stacking context as both pages, above the home, below the
       detail, guaranteed. And the snapshot is built at touchstart —
       before the drag engages — so its one-off clone + first blur
       raster lands while the finger is still deciding direction,
       not on the first drag frame. PRIMING (the press flash in the
       user's latest recording): the layer is built at opacity 0,
       never visibility:hidden. A hidden subtree is never painted,
       so its <img> tiles do not exist yet; when the old build
       flipped it visible in the engage block, the first composite
       drew the borders and text but not the photos — one frame of
       missing/darkened images exactly at the press. Opacity 0
       keeps the layer fully painted (the standard pre-render), so
       by engage time every tile is rasterised and the swap to
       opacity 1 is free. It sits under the opaque detail overlay
       (z-40) the whole time, so the priming is never visible. */
    let blurLayer: HTMLDivElement | null = null;
    let blurBuiltW = 0;
    let blurBuiltH = 0;

    const dropBlurLayer = () => {
      if (blurLayer) {
        blurLayer.remove();
        blurLayer = null;
      }
    };
    const makeBlurLayer = () => {
      dropBlurLayer();
      const home = homeRef.current;
      if (!home) return;
      const rect = home.getBoundingClientRect();
      const PAD = 48;
      const layer = document.createElement("div");
      layer.setAttribute("aria-hidden", "true");
      layer.className = "blur-snap";
      layer.style.cssText =
        `position:fixed;top:${-PAD}px;left:${-PAD}px;right:${-PAD}px;bottom:${-PAD}px;` +
        "overflow:hidden;pointer-events:none;z-index:39;opacity:0;" +
        `filter:blur(${BLUR_MAX}px);will-change:transform,filter;`;
      const snap = home.cloneNode(true) as HTMLElement;
      snap.removeAttribute("id");
      snap
        .querySelectorAll("[id]")
        .forEach((el) => el.removeAttribute("id"));
      snap.style.margin = "0";
      snap.style.position = "absolute";
      snap.style.top = `${Math.round(rect.top + PAD)}px`;
      snap.style.left = `${Math.round(rect.left + PAD)}px`;
      snap.style.width = `${Math.round(rect.width)}px`;
      /* VIEWPORT PRUNING + PHOTO HAND-OVER — the change that ends
         the ghosting / flash / hitch family at its root. The old
         snapshot cloned the home WHOLE: all ~83 rows (≈12,000px of
         content) and every photo, then asked the compositor to blur
         that entire surface on every drag frame and swap it against
         the live home at settle. A surface that tall blows the
         compositor's tile budget on the phone, so tiles painted
         late, smeared or not at all (the dark/missing photos of the
         press flash, the doubled edges at settle), and the clone +
         forced full-list layout at touchstart was the hitch at the
         start of every drag. But the layer is viewport-clipped:
         only one screenful of the clone can ever be seen. So before
         the clone is inserted it is cut down to that screenful:
           – every photo is first pointed at the live image's
             already-decoded bitmap (currentSrc) and made eager, so
             no clone photo waits on a lazy load or a fresh decode
             (this pass runs while both trees are still structurally
             identical, so index pairing is exact);
           – every list item fully BELOW the viewport is removed
             outright (it sits after the visible items in flow, so
             removing it moves nothing that can be seen);
           – every list item fully ABOVE the viewport is hollowed
             out — contents stripped, border-box height kept — so
             the visible items keep their exact layout positions
             while the hollow shells cost no paint.
         What remains is one screenful: a small surface the
         compositor can hold whole and fully rasterised, which is
         what makes the settle swap pixel-exact. */
      const liveImgs = home.querySelectorAll("img");
      const snapImgs = snap.querySelectorAll("img");
      const imgCount = Math.min(liveImgs.length, snapImgs.length);
      for (let i = 0; i < imgCount; i++) {
        const liveImg = liveImgs[i] as HTMLImageElement | undefined;
        const snapImg = snapImgs[i] as HTMLImageElement | undefined;
        if (!liveImg || !snapImg) continue;
        const src = liveImg.currentSrc || liveImg.src;
        if (src && snapImg.src !== src) snapImg.src = src;
        snapImg.loading = "eager";
        snapImg.removeAttribute("srcset");
      }
      const vh = window.innerHeight;
      const liveItems = home.querySelectorAll("article");
      const snapItems = snap.querySelectorAll("article");
      const pairCount = Math.min(liveItems.length, snapItems.length);
      for (let i = 0; i < pairCount; i++) {
        const liveItem = liveItems[i];
        const snapItem = snapItems[i] as HTMLElement | undefined;
        if (!liveItem || !snapItem) continue;
        const r = liveItem.getBoundingClientRect();
        if (r.top >= vh + 96) {
          snapItem.remove();
        } else if (r.bottom <= -96) {
          snapItem.style.boxSizing = "border-box";
          snapItem.style.height = `${Math.round(r.height)}px`;
          snapItem.style.minHeight = "0";
          snapItem.style.visibility = "hidden";
          snapItem.replaceChildren();
        }
      }
      const realBar = home.querySelector(".control-bar");
      const snapBar = snap.querySelector(".control-bar") as
        | HTMLElement
        | null;
      if (snapBar) {
        /* The clone's bar stays IN FLOW, with only its stickiness
           switched off (relative instead of sticky, so it cannot try
           to stick inside the static clone). An earlier build took
           the bar OUT of flow (position:absolute) and pinned it at
           the stuck position — but that collapsed the bar's height
           out of the clone's layout, so every card below it sat one
           bar-height (~110px) higher in the snapshot than in the
           live home, and the misaligned rows doubled against the
           live list (残影 in the user's recording). In flow, the
           clone's layout is the live layout, pixel for pixel; the
           bar's own displacement is applied after insertion as a
           measured transform, which moves nothing else. */
        snapBar.style.position = "relative";
        /* NO SEE-THROUGH (the bleed-through in the user's latest
           recording): the live bar can afford a 52%-opaque
           background because its backdrop-filter frosts whatever
           scrolls beneath it into illegibility. The .blur-snap
           rules strip backdrop-filter from the whole clone, so in
           the snapshot that same 52% wash is all the bar has — and
           the displacement below paints the bar directly over the
           clone's first visible card, whose title, battery, price
           and profit lines then show through both fixed rows at
           half strength, sharpening to fully legible as the
           layer's own radius eases to 0 over the return. The bar
           therefore gets an opaque ground in the page's own
           background colour — the same fix .glass-menu carries:
           where the frosting cannot run, the base colour does its
           job. The bar's buttons and pills paint above the bar's
           background, so the one opaque ground backs the whole
           strip; and over this mostly-white list the solid strip
           reads the same as the live bar's frosted wash, so the
           settle swap stays invisible. The live bar is untouched
           and keeps its real frosted glass in normal scrolling. */
        snapBar.style.background = "var(--bg)";
      }
      layer.appendChild(snap);
      const host = home.parentElement;
      if (host) host.insertBefore(layer, root);
      else document.body.appendChild(layer);
      if (realBar && snapBar) {
        // The live bar is displaced from its flow position by the
        // sticky stick; displace the clone's bar by exactly the
        // measured difference so the two bars coincide.
        const dy =
          realBar.getBoundingClientRect().top -
          snapBar.getBoundingClientRect().top;
        if (dy !== 0) {
          snapBar.style.transform = `translateY(${dy.toFixed(1)}px)`;
        }
      }
      blurLayer = layer;
      blurBuiltW = window.innerWidth;
      blurBuiltH = window.innerHeight;
    };
    /* Build (or rebuild, after a viewport resize) the snapshot
       ahead of the drag: called at touchstart for every touch that
       could become a back-drag, and again at engage as a fallback
       for touches that started on a control. Dropped at settle, so
       it never goes stale across drags. Returns true when it
       (re)built: a fresh clone's photos have not rasterised yet,
       so the engage swap must give it a priming frame first (see
       the deferred swap in onMove). */
    const ensureBlurLayer = () => {
      if (
        blurLayer &&
        !homeDirtyRef.current &&
        blurBuiltW === window.innerWidth &&
        blurBuiltH === window.innerHeight
      ) {
        return false;
      }
      homeDirtyRef.current = false;
      makeBlurLayer();
      return true;
    };

    /* The engage swap (home snapshot to opacity 1, live home to
       opacity 0) normally lands synchronously in onMove. When the
       snapshot was rebuilt in that same block, the swap is
       deferred by one rAF so the fresh clone paints one priming
       frame at opacity 0 first; the generation counter lets
       clearHome / a newer engage invalidate a pending swap so it
       can never land after the gesture has settled. */
    let swapRaf: number | null = null;
    let swapGen = 0;

    const clearHome = () => {
      swapGen += 1;
      if (swapRaf != null) {
        cancelAnimationFrame(swapRaf);
        swapRaf = null;
      }
      const home = homeRef.current;
      if (home) {
        home.style.transform = "";
        home.style.willChange = "";
        home.style.opacity = "";
      }
      lastHomeR = -1;
      dropBlurLayer();
    };
    /* The blur radius is written only when it moves by at least a
       quarter pixel: during a slow drag many frames share nearly
       the same radius, and a redundant filter write would queue a
       re-render of the snapshot for nothing. */
    let lastHomeR = -1;
    const applyDrag = (dx: number) => {
      lastDx = dx;
      const w = window.innerWidth || root.clientWidth || 1;
      const p = Math.max(0, Math.min(1, dx / w));
      root.style.transform = `translate3d(${dx}px, 0, 0)`;
      /* The home's parallax pull ramps in over the first 72px of
         the drag: the raw (1 − p) curve already sits at ≈ −54px on
         the very first engaged frame (dx ≈ 10), so the home used to
         JUMP left in one frame the moment the gesture took over —
         a visible hitch at the start of every pull. The ramp keeps
         the curve continuous from the home's resting position. */
      const ramp = Math.min(1, dx / 72);
      const pull = `translate3d(${(-(1 - p) * PULL_MAX * ramp).toFixed(1)}px, 0, 0)`;
      const home = homeRef.current;
      if (home) home.style.transform = pull;
      if (blurLayer) {
        blurLayer.style.transform = pull;
        // The home snapshot's radius IS the sharpening: fully
        // blurred as the reveal begins, easing to zero exactly as
        // the detail page leaves — a single image at every instant.
        const r = Math.round(BLUR_MAX * (1 - p) * 4) / 4;
        if (Math.abs(r - lastHomeR) >= 0.25) {
          lastHomeR = r;
          blurLayer.style.filter = `blur(${r}px)`;
        }
      }
    };
    const cancelSpring = () => {
      if (raf != null) {
        cancelAnimationFrame(raf);
        raf = null;
      }
    };
    /* Release animation: a spring integrated frame by frame, seeded
       with the finger's release velocity (px/ms → px/s, clamped), so
       a flick keeps its momentum and a soft release eases out gently
       instead of both riding one fixed-duration curve. Completing
       runs a slightly underdamped spring to the screen edge; the
       bounce-back runs a critically damped one to zero, landing
       without a jolt or an overshoot wobble. Every frame feeds the
       same spring position through applyDrag, so the detail slide,
       the home pull and the home blur radius stay in lockstep. */
    const finish = (complete: boolean, releaseV = 0) => {
      animating = true;
      cancelMoveRaf();
      cancelSpring();
      const w = window.innerWidth || root.clientWidth || 1;
      const target = complete ? w : 0;
      let x = lastDx;
      let v = Math.max(-2600, Math.min(2600, releaseV * 1000));
      if (complete && v < 0) v = 0;
      const stiffness = complete ? 170 : 320;
      const damping = 2 * (complete ? 0.9 : 1) * Math.sqrt(stiffness);
      const startedAt = performance.now();
      let prev = startedAt;
      const settle = () => {
        cancelSpring();
        clearHome();
        if (complete) {
          onCloseRef.current();
        } else {
          root.style.transform = "";
          root.style.willChange = "";
          animating = false;
        }
      };
      const step = (now: number) => {
        const dt = Math.min(0.05, Math.max(0.001, (now - prev) / 1000));
        prev = now;
        const sub = Math.max(1, Math.ceil(dt / (1 / 240)));
        const h = dt / sub;
        for (let i = 0; i < sub; i++) {
          const a = -stiffness * (x - target) - damping * v;
          v += a * h;
          x += v * h;
        }
        applyDrag(x);
        const crossed = complete && x >= target - 0.5 && v >= 0;
        const rested = Math.abs(x - target) < 0.6 && Math.abs(v) < 25;
        if (crossed || rested || now - startedAt > 1600) {
          settle();
          return;
        }
        raf = requestAnimationFrame(step);
      };
      raf = requestAnimationFrame(step);
    };
    const onStart = (e: TouchEvent) => {
      if (animating) return;
      if (e.touches.length !== 1) {
        // A second finger (pinch) cancels any drag in progress.
        if (drag?.engaged) finish(false);
        drag = null;
        return;
      }
      if (lightboxRef.current) {
        drag = null;
        return;
      }
      const t = e.touches[0];
      if (!t) return;
      const target = e.target as Element | null;
      if (
        target &&
        typeof target.closest === "function" &&
        target.closest("[data-hscroll], input, textarea, select")
      ) {
        drag = null;
        return;
      }
      // Pre-build the blurred home snapshot now, while the finger
      // has barely moved: its clone + one-off blur raster then
      // happens before the drag engages instead of hitching the
      // first drag frame. Touches that turn out to be scrolls or
      // taps simply leave it cached for the next touch; it is
      // dropped at settle and on unmount. Touches starting on a
      // button or link skip the pre-build so a tap's own response
      // never waits on the clone — a drag starting there builds at
      // engage instead.
      const tgt = e.target as Element | null;
      if (
        !tgt ||
        typeof tgt.closest !== "function" ||
        !tgt.closest("button, a, [role='button']")
      ) {
        ensureBlurLayer();
      }
      drag = {
        startX: t.clientX,
        startY: t.clientY,
        dx: 0,
        engaged: false,
        dead: false,
        samples: [{ x: t.clientX, t: performance.now() }],
      };
    };
    const onMove = (e: TouchEvent) => {
      const d = drag;
      if (!d || d.dead) return;
      const t = e.touches[0];
      if (!t) return;
      const dx = t.clientX - d.startX;
      const dy = t.clientY - d.startY;
      if (!d.engaged) {
        if (dx >= 10 && dx > Math.abs(dy) * 1.35) {
          d.engaged = true;
          // The enter animation's fill would override an inline
          // transform, so it has to go before the first drag frame.
          root.style.animation = "none";
          root.style.willChange = "transform";
          const homeRebuilt = ensureBlurLayer();
          // THE SWAP: the home snapshot comes up to full opacity
          // and the live home goes transparent, leaving the
          // snapshot as the home's only image for the rest of the
          // gesture. opacity (not visibility) keeps both pages'
          // layouts — and the home's scroll offset — exactly where
          // they were. The detail page is NOT swapped: it has no
          // blur anymore (user decision), so the live page itself
          // stays on screen and slides with the finger — there is
          // nothing to swap it for. When the snapshot was already
          // built (the normal touchstart pre-build) it has been
          // painting at opacity 0 since the finger landed, every
          // photo tile is rasterised, and the swap lands in this
          // same synchronous block: no frame can show a
          // half-swapped state. A snapshot rebuilt in THIS block
          // has never painted, though — swapping onto it in the
          // same frame is the press flash (its photos composite a
          // frame late, darkened/missing). That case defers the
          // swap by one rAF: the fresh layer paints one priming
          // frame at opacity 0 while the live pages — already
          // tracking the finger via applyDrag below — stay on
          // screen, then the swap lands on an identical, fully
          // rasterised picture.
          const doSwap = () => {
            if (blurLayer) blurLayer.style.opacity = "1";
            const home = homeRef.current;
            if (home) {
              home.style.willChange = "transform";
              home.style.opacity = "0";
            }
          };
          if (homeRebuilt) {
            const gen = ++swapGen;
            swapRaf = requestAnimationFrame(() => {
              swapRaf = null;
              if (gen === swapGen) doSwap();
            });
          } else {
            doSwap();
          }
          // Land the radius for this position before the first
          // drag frame: the home snapshot starts at nearly full
          // blur, so the swap itself is invisible.
          lastHomeR = -1;
          applyDrag(Math.max(0, dx));
        } else if (Math.abs(dy) >= 10 && Math.abs(dy) >= Math.abs(dx)) {
          d.dead = true;
          return;
        } else {
          return;
        }
      }
      e.preventDefault();
      d.dx = Math.max(0, dx);
      d.samples.push({ x: t.clientX, t: performance.now() });
      if (d.samples.length > 10) d.samples.shift();
      scheduleDrag(d.dx);
    };
    const onEnd = (cancelled: boolean) => {
      const d = drag;
      drag = null;
      if (!d || !d.engaged || animating) return;
      // Land the final drag position synchronously: the spring
      // starts from lastDx, and a coalesced frame may still be
      // holding the finger's last move.
      if (pendingDx != null) {
        cancelMoveRaf();
        applyDrag(d.dx);
      }
      let complete = false;
      let v = 0;
      if (!cancelled) {
        const w = window.innerWidth || root.clientWidth || 1;
        // Release velocity from the last ~100ms of the drag only, so
        // a pause before letting go doesn't inherit stale speed; the
        // value both decides the flick and seeds the spring's start.
        const last = d.samples[d.samples.length - 1];
        if (last) {
          let first = d.samples[0];
          for (const s of d.samples) {
            if (last.t - s.t <= 100) {
              first = s;
              break;
            }
          }
          if (first && last.t - first.t >= 16) {
            v = (last.x - first.x) / (last.t - first.t);
          }
        }
        complete = d.dx > w * 0.35 || (v > 0.45 && d.dx > 48);
      }
      finish(complete, v);
    };
    const onTouchEnd = () => onEnd(false);
    const onTouchCancel = () => onEnd(true);
    root.addEventListener("touchstart", onStart, { passive: true });
    root.addEventListener("touchmove", onMove, { passive: false });
    root.addEventListener("touchend", onTouchEnd);
    root.addEventListener("touchcancel", onTouchCancel);
    return () => {
      root.removeEventListener("touchstart", onStart);
      root.removeEventListener("touchmove", onMove);
      root.removeEventListener("touchend", onTouchEnd);
      root.removeEventListener("touchcancel", onTouchCancel);
      cancelMoveRaf();
      cancelSpring();
      clearHome();
    };
  }, [homeRef]);

  const numField = (
    label: string,
    key: keyof Analysis,
    step = "1",
  ) => (
    <label className="block">
      <span className="text-sm text-[var(--dim)]">{label}</span>
      <input
        aria-label={label}
        type="number"
        inputMode="decimal"
        step={step}
        className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-base text-[var(--text)]"
        value={
          draft[key] == null ? "" : String(draft[key] as number)
        }
        onChange={(e) => {
          const v = e.target.value;
          /* Typing ".", "-" or "e" alone is not a number yet — Number()
             would store NaN, which serialises to JSON null and fails the
             zod schema on the next read, bricking the app. Ignore the
             keystroke instead; the field keeps its last good value. */
          if (v !== "" && !Number.isFinite(Number(v))) return;
          setDraft((d) => ({
            ...d,
            [key]: v === "" ? null : Number(v),
          }));
        }}
      />
    </label>
  );

  return (
    <div
      ref={rootRef}
      style={{ touchAction: "pan-y" }}
      className={`fixed inset-0 z-40 overflow-y-auto overscroll-none bg-[var(--bg)] ${
        leaving ? "detail-leave" : "detail-enter"
      }`}
    >
      <div className="mx-auto max-w-2xl px-4 pb-12 pt-safe">
        <div className="flex items-center justify-between py-4">
          <button
            type="button"
            aria-label="返回列表"
            className="glass rounded-full border border-[var(--border)] px-4 py-1.5 text-sm text-[var(--text)]"
            onClick={handleClose}
          >
            ← 返回
          </button>
          <LikeButton
            listing={listing}
            onToggleLike={onToggleLike}
            className="h-10 w-10"
            bordered
            plainLabel
          />
        </div>

        {images.length > 0 ? (
          <div className="overflow-hidden rounded-[10px] border border-[var(--border)] bg-[#141414] py-3">
            <Carousel
              images={images}
              idx={safeIdx}
              onIdx={setIdx}
              alt={title(listing)}
              onTapImage={(i) => {
                setIdx(i);
                setLightbox(true);
              }}
              trackClassName="h-[300px] sm:h-[400px]"
              slideClassName="cursor-pointer"
              imgClassName="max-h-full max-w-full object-contain"
            />
            {images.length > 1 ? (
              <div className="mt-3">
                <ThumbStrip images={images} idx={safeIdx} onIdx={setIdx} />
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="mt-5 flex items-start justify-between gap-2">
          <h2 className="text-xl font-semibold text-[var(--text)]">
            {title(listing)}
          </h2>
          <PlatformTag platform={listing.platform} />
        </div>
        {c.verdict ? (
          <div className="mt-2.5 flex items-center gap-2">
            <span className="text-sm text-[var(--dim)]">判定</span>
            <span
              aria-hidden="true"
              className="inline-block h-2.5 w-2.5 rounded-full"
              style={{ backgroundColor: VERDICT_COLOR[c.verdict] }}
            />
            <span
              className="text-base font-medium"
              style={{ color: VERDICT_COLOR[c.verdict] }}
            >
              {VERDICT_WORD[c.verdict]}
            </span>
          </div>
        ) : null}

        <div className="mt-5 rounded-[10px] border border-[var(--border)] bg-[var(--surface)] px-4 py-3">
          <Row k="挂牌价">
            <Money cny={listing.priceCny} rate={rate} label="挂牌价" className="font-semibold" />
          </Row>
          <Row k="买入价">
            <Money sgd={rate != null ? c.buySgd : undefined} cny={listing.priceCny} rate={rate} label="买入价" />
          </Row>
          {listing.platform === "xianyu" ? (
            <Row k="验货宝 + 运费（¥204）">
              <Money sgd={c.feeSgd} rate={rate} label="验货宝和运费" />
            </Row>
          ) : null}
          <Row k="额外运费">
            <Money sgd={listing.shippingSgd} rate={rate} label="额外运费" />
          </Row>
          <Row k="维修费">
            <Money sgd={listing.repairSgd} rate={rate} label="维修费" />
          </Row>
          <Row k="到手成本">
            <Money sgd={rate != null ? c.landedSgd : undefined} rate={rate} label="到手成本" />
          </Row>
          <Row k="成交价区间">
            <MoneyRange low={listing.saleLow} high={listing.saleHigh} rate={rate} label="成交价区间" />
          </Row>
          <Row k="成交证据">
            {listing.sampleCount} 笔{listing.soldSource ? ` · ${listing.soldSource}` : ""}
          </Row>
          <Row k="手续费">
            {(feeFraction(listing.feePercent) * 100).toFixed(2).replace(/\.?0+$/, "")}%
          </Row>
          <Row k="利润区间">
            <MoneyRange low={c.profitLow} high={c.profitHigh} rate={rate} label="利润区间" className="font-medium" />
          </Row>
          <Row k="目标利润">
            <Money sgd={listing.targetProfit} rate={rate} label="目标利润" />
          </Row>
          <Row k="建议购入价">
            <Money sgd={c.suggestedBuySgd ?? undefined} rate={rate} label="建议购入价" className="font-semibold" />
          </Row>
        </div>

        <div className="mt-5 rounded-[10px] border border-[var(--border)] bg-[var(--surface)] px-4 py-3">
          {listing.battery ? <Row k="电池健康">{listing.battery}</Row> : null}
          {listing.cycles != null ? <Row k="循环次数">{listing.cycles}</Row> : null}
          {listing.condition ? <Row k="成色">{listing.condition}</Row> : null}
          {listing.warranty ? <Row k="保修">{listing.warranty}</Row> : null}
          {listing.seller ? (
            <div className="flex items-baseline justify-between gap-3 py-2.5">
              <span className="text-sm text-[var(--dim)]">卖家</span>
              <button
                type="button"
                aria-label={`复制卖家名字：${sellerName(listing.seller)}`}
                className="text-right text-base text-[var(--text)]"
                onClick={() => void copySeller()}
              >
                {listing.seller}
                {copied ? (
                  <span className="ml-2 text-sm text-[var(--verdict-green)]">已复制</span>
                ) : null}
              </button>
            </div>
          ) : null}
        </div>

        {listing.url ? (
          <a
            href={listing.url}
            target="_blank"
            rel="noreferrer"
            aria-label="打开原贴链接"
            className="glass-link mt-4 flex w-full items-center justify-center gap-1.5 rounded-[10px] border px-4 py-3.5 text-base font-semibold"
          >
            Original link
          </a>
        ) : null}

        {listing.description ? (
          <div className="mt-5 rounded-[10px] border border-[var(--border)] bg-[var(--surface)] px-4 py-3">
            <h3 className="text-sm font-medium text-[var(--dim)]">详细内容</h3>
            <p className="mt-2 whitespace-pre-wrap text-base leading-relaxed text-[var(--text)]">
              {listing.description}
            </p>
          </div>
        ) : null}

        <div className="mt-7">
          {editing ? (
            <div className="rounded-[10px] border border-[var(--border)] bg-[var(--surface)] p-5">
              <div className="grid grid-cols-2 gap-4">
                {numField("成交价低（S$）", "saleLow", "0.01")}
                {numField("成交价高（S$）", "saleHigh", "0.01")}
                {numField("成交笔数", "sampleCount")}
                {numField("额外运费（S$）", "shippingSgd", "0.01")}
                {numField("维修费（S$）", "repairSgd", "0.01")}
                {numField("手续费（%）", "feePercent", "0.01")}
                {numField("目标利润（S$）", "targetProfit", "0.01")}
                <label className="block">
                  <span className="text-sm text-[var(--dim)]">成交来源</span>
                  <input
                    aria-label="成交来源"
                    type="text"
                    className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-base text-[var(--text)]"
                    value={draft.soldSource}
                    onChange={(e) =>
                      setDraft((d) => ({ ...d, soldSource: e.target.value }))
                    }
                  />
                </label>
              </div>
              <div className="mt-4 flex gap-2">
                <button
                  type="button"
                  aria-label="保存分析"
                  className="glass-green rounded-full px-5 py-2 text-sm font-medium text-white"
                  onClick={() => {
                    onSaveAnalysis(listing.id, {
                      ...draft,
                      saleLow: draft.saleLow ?? null,
                      saleHigh: draft.saleHigh ?? null,
                      sampleCount: draft.sampleCount ?? 0,
                    });
                    setEditing(false);
                  }}
                >
                  保存
                </button>
                <button
                  type="button"
                  aria-label="取消编辑分析"
                  className="glass rounded-full border border-[var(--border)] px-5 py-2 text-sm text-[var(--text)]"
                  onClick={() => {
                    resetDraft();
                    setEditing(false);
                  }}
                >
                  取消
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              aria-label="编辑分析"
              className="glass rounded-full border border-[var(--border)] px-5 py-2 text-sm text-[var(--text)]"
              onClick={() => {
                resetDraft();
                setEditing(true);
              }}
            >
              编辑分析
            </button>
          )}
        </div>

      </div>

      {lightbox && images.length > 0 ? (
        <Lightbox
          images={images}
          idx={safeIdx}
          onIdx={setIdx}
          alt={title(listing)}
          onClose={() => setLightbox(false)}
        />
      ) : null}
    </div>
  );
}

/* Memoised: with the detail open, unrelated App re-renders (a sync
   finishing, the rate landing, a background state refetch) used to
   re-render the whole detail page too — and every Detail render marks
   the swipe-back gesture's snapshot stale, so the next touch paid a
   full clone rebuild before the drag could engage. The callbacks are
   all stable, so memo
   lets the page sit untouched until its own listing actually changes. */
const MemoDetail = memo(Detail);

/* ---------- custom dropdown menu -------------------------------------------
   Replaces the native <select> (whose OS popup was far wider than the
   text and kept a tinted background long after it closed). The panel
   is narrower than its trigger button (button width − 32px,
   so it tucks in on both sides) and is centred on
   the button's centre — never flush left or right — spreading out
   from that centre when it opens and retracting back into the button
   when it closes or an option is picked. Option text stays centred.
   The trigger itself is plain glass at all times, so nothing stays
   coloured once the menu is gone. */

function MenuSelect({
  ariaLabel,
  value,
  options,
  onChange,
}: {
  ariaLabel: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<number | null>(null);

  /* While this menu is open, list gestures are locked (see the
     menuOpenCount flag at the top of the file). */
  useEffect(() => {
    if (!open) return;
    menuOpenCount += 1;
    return () => {
      menuOpenCount -= 1;
    };
  }, [open ]);

  const close = useCallback(() => {
    setClosing(true);
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      setOpen(false);
      setClosing(false);
    }, 150);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        close();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, close ]);

  /* While the menu is open the rest of the page is locked: a tap
     anywhere outside the menu only closes it — it must never reach
     the listing underneath, which would open its detail page. The
     mousedown closer above fires first, but the same tap's click
     would still land on the card, so this capture-phase guard
     swallows outside clicks before the card's own onClick sees them.
     Clicks inside the menu (options, trigger) pass through untouched.
     Animations (menu-in/out) are not touched. */
  useEffect(() => {
    if (!open) return;
    const onClickCapture = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        e.stopPropagation();
        e.preventDefault();
      }
    };
    document.addEventListener("click", onClickCapture, true);
    return () => document.removeEventListener("click", onClickCapture, true);
  }, [open]);

  useEffect(
    () => () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
    },
    [],
  );

  const current = options.find((o) => o.value === value);

  return (
    <div ref={rootRef} className="relative min-w-0 flex-1">
      <button
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="glass w-full rounded-full border border-[var(--border)] px-3 py-2.5 text-center text-sm text-[var(--dim)]"
        onClick={() => {
          if (open) {
            close();
          } else {
            setClosing(false);
            setOpen(true);
          }
        }}
      >
        <span className="flex items-center justify-center gap-1.5">
          <span>{current?.label ?? ""}</span>
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            className="shrink-0 opacity-60"
          >
            <path d="M6 9l6 6 6-6" />
          </svg>
        </span>
      </button>
      {open ? (
        <div className="absolute left-1/2 top-[calc(100%+6px)] z-50 w-[calc(100%-2rem)] max-w-[calc(100vw-2rem)] -translate-x-1/2">
          <div
            role="listbox"
            aria-label={ariaLabel}
            className={`glass-menu w-full rounded-2xl border border-[var(--border)] p-1.5 ${
              closing ? "menu-panel-out" : "menu-panel-in"
            }`}
            style={{ transformOrigin: "top center" }}
          >
            {options.map((o) => (
              <button
                key={o.value}
                type="button"
                role="option"
                aria-selected={o.value === value}
                aria-label={o.label}
                className="block w-full whitespace-nowrap rounded-xl px-2.5 py-2 text-center text-sm text-[var(--text)] active:bg-black/5"
                onClick={() => {
                  onChange(o.value);
                  close();
                }}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* ---------- app ------------------------------------------------------------ */

type SortMode = "recommend" | "buyable" | "profit" | "priceAsc" | "newest";
type FilterMode = "all" | "xianyu" | "carousell" | "liked";
type LayoutMode = "single" | "multi";
/* Model filter: exact chip match. Only the five Pro chips are offered;
   Max / M6 / base-M4 listings show only under 全部型号. */
type ModelFilter = "all" | "M1 Pro" | "M2 Pro" | "M3 Pro" | "M4 Pro" | "M5 Pro";

const LISTINGS_REFRESH_MS = 60 * 60 * 1000;

export function App() {
  const [personal, setPersonal] = useState(readLocal);
  const [notice, setNotice] = useState("");
  /* Two-way cloud sync: the GitHub token lives only in this browser
     (see local.ts). It is set through the token button in the footer,
     which opens a small modal for pasting it. */
  const [token, setToken] = useState(() => readSyncToken());
  const [tokenModalOpen, setTokenModalOpen] = useState(false);
  const [syncing, setSyncing] = useState(false);
  useEffect(() => subscribeLocal(() => setPersonal(readLocal())), []);
  /* Auto-upload of personal state — the main screen syncs itself:
     a like, unlike, delete or analysis edit on the list uploads to
     user-data.json a few seconds later (debounced, so several quick
     taps become one upload), so the user never has to tap 同步 just
     to back up a like. Silent: no notice on success, and a failure is
     simply retried on the next change or the next manual sync. Only
     runs when a token is set; without one, likes stay on this device
     only. The manual 同步 button is still the way to pull the newest
     listings + rate. */
  /* Uploads run through one chain: auto-upload and manual sync both do
     fetch → merge → upload, and two overlapping runs can merge from the
     same stale cloud snapshot, so a like saved in between goes missing
     from the cloud until the next upload. Chaining them makes the later
     run merge from the earlier run's freshly uploaded state. */
  const uploadQueue = useRef<Promise<void>>(Promise.resolve());
  const queueUpload = useCallback(<T,>(job: () => Promise<T>): Promise<T> => {
    const run = uploadQueue.current.then(job, job);
    uploadQueue.current = run.then(
      () => {},
      () => {},
    );
    return run;
  }, []);
  const autoUploadTimer = useRef<number | null>(null);
  const autoUpload = useCallback(() => {
    void queueUpload(async () => {
      const tok = readSyncToken();
      if (!tok) return;
      try {
        /* A failed cloud read is NOT the same as "no cloud file": the
           upload below must be skipped, or a local-only merge would
           overwrite (and permanently delete) the cloud-only likes and
           deletions on a flaky connection. */
        const cloud = await fetchCloudPersonal();
        const merged = mergePersonal(readLocal(), cloud ?? { likes: {}, analysis: {}, deletions: [] });
        await editLocal(s => { s.likes = merged.likes; s.analysis = merged.analysis; s.deletions = merged.deletions; });
        await uploadCloudPersonal(tok, merged);
      } catch {
        // Silent — the next change or manual sync retries.
      }
    });
  }, [queueUpload]);
  const scheduleAutoUpload = useCallback(() => {
    if (autoUploadTimer.current) window.clearTimeout(autoUploadTimer.current);
    autoUploadTimer.current = window.setTimeout(() => { void autoUpload(); }, 3000);
  }, [autoUpload]);
  useEffect(
    () => () => {
      if (autoUploadTimer.current) window.clearTimeout(autoUploadTimer.current);
    },
    [],
  );
  const save = useCallback((edit: Parameters<typeof editLocal>[0]) => {
    void editLocal(edit)
      .then(() => scheduleAutoUpload())
      .catch(() => setNotice("浏览器未能保存改动，请检查此网站的本地存储权限。"));
  }, [scheduleAutoUpload]);
  const [sort, setSort] = useState<SortMode>(() => {
    const s = localStorage.getItem(SORT_KEY);
    // "profit" is its own ranking (pure profit-high, no verdict
    // grouping), distinct from "recommend"; keep saved values as-is.
    return s === "buyable" || s === "profit" || s === "priceAsc" || s === "newest"
      ? s
      : "recommend";
  });
  const [filter, setFilter] = useState<FilterMode>(() => {
    const f = localStorage.getItem(FILTER_KEY);
    return f === "xianyu" || f === "carousell" || f === "liked" ? f : "all";
  });
  const [model, setModel] = useState<ModelFilter>(() => {
    const m = localStorage.getItem(MODEL_KEY);
    return m === "M1 Pro" || m === "M2 Pro" || m === "M3 Pro" || m === "M4 Pro" || m === "M5 Pro"
      ? m
      : "all";
  });
  /* Filter-row press flash: which pill (filter key, or "sync") the
     finger is holding down. While held it turns dark; on release it
     fades back to frosted glass + the faint dark halo over 0.4s (see
     .filter-pill in theme.css). Cleared on pointer-up/leave/cancel so
     a press can never stick. */
  const [pressedKey, setPressedKey] = useState<string | null>(null);
  const clearPressed = useCallback(() => setPressedKey(null), []);
  const [layout, setLayout] = useState<LayoutMode>(() => {
    // Older saved value "double" now means the multi-column row list.
    return localStorage.getItem(LAYOUT_KEY) === "single" ? "single" : "multi";
  });
  /* Home list swipe-to-delete + long-press multi-select. Only one row is
     ever swiped open; multi-select holds the checked ids. Both delete
     paths only append to localStorage deletions — listings.json is never
     written. */
  const [swipedId, setSwipedId] = useState<string | null>(null);
  const [multiSelect, setMultiSelect] = useState(false);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  /* Pending delete awaiting the centred confirm modal: a single listing
     from swipe-to-delete, or the bulk count from multi-select. */
  const [deleteConfirm, setDeleteConfirm] = useState<DeleteConfirm | null>(null);
  const [openId, setOpenId] = useState<string | null>(() => {
    const m = window.location.hash.match(/#item=([^&]+)/);
    /* A malformed hash (e.g. #item=%) used to throw URIError here and
       white-screen the app on load; fall back to the raw value. */
    if (m) {
      try { return decodeURIComponent(m[1] ?? ""); } catch { return m[1] ?? ""; }
    }
    // No hash: a fresh open — or a host reload that dropped the hash.
    // Restore the detail recorded for this session, if any.
    return sessionStorage.getItem(OPEN_KEY);
  });
  const fileRef = useRef<HTMLInputElement>(null);
  /* The home (list) layer: the detail page's swipe-back gesture pulls
     this element with a parallax transform while a static snapshot of
     it above it sharpens from full blur as the detail overlay slides
     away. */
  const homeRef = useRef<HTMLElement>(null);

  const state = useQuery({
    queryKey: ["state"],
    queryFn: ({ signal }) => api.getState(signal),
    staleTime: LISTINGS_REFRESH_MS,
    refetchInterval: LISTINGS_REFRESH_MS,
    refetchIntervalInBackground: true,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
  });
  const rateQuery = useQuery({
    queryKey: ["rate"],
    queryFn: api.getRate,
    staleTime: 60 * 60 * 1000,
  });

  const rate: number | null =
    rateQuery.data?.rate ?? null;

  /* Home-screen web apps (iOS "Add to Home Screen") resume from a
     suspended snapshot instead of reloading: the page comes back with
     the old list, and the focus refetch above does not reliably fire
     on that resume. So refetch the listings whenever the page is
     shown again — pageshow covers back-forward-cache restores
     (event.persisted) and plain resumes, visibilitychange covers tab
     switches. Silent: the list just updates, no notice. */
  const stateRef = useRef(state);
  stateRef.current = state;
  const rateQueryRef = useRef(rateQuery);
  rateQueryRef.current = rateQuery;
  useEffect(() => {
    const refetch = () => {
      void stateRef.current.refetch();
      void rateQueryRef.current.refetch();
    };
    const onPageShow = () => refetch();
    const onVisible = () => {
      if (!document.hidden) refetch();
    };
    window.addEventListener("pageshow", onPageShow);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("pageshow", onPageShow);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  useEffect(() => {
    localStorage.setItem(SORT_KEY, sort);
  }, [sort]);
  useEffect(() => {
    localStorage.setItem(FILTER_KEY, filter);
  }, [filter]);
  useEffect(() => {
    localStorage.setItem(MODEL_KEY, model);
  }, [model]);
  useEffect(() => {
    localStorage.setItem(LAYOUT_KEY, layout);
  }, [layout]);

  const listings = useMemo<Listing[]>(() => {
    const rows = state.data?.listings ?? [];
    const deleted = new Set(personal.deletions);
    return rows
      .filter((l) => !deleted.has(l.id))
      .map((l) => {
        let out = l;
        const liked = personal.likes[l.id];
        if (liked !== undefined) out = { ...out, liked };
        const a = personal.analysis[l.id];
        if (a) out = { ...out, ...a };
        return out;
      });
  }, [state.data, personal]);

  const visible = useMemo(() => {
    let rows = listings;
    if (filter === "liked") rows = rows.filter((l) => l.liked);
    // Facebook has no filter of its own: its listings show under Carousell,
    // still carrying their Facebook platform tag.
    else if (filter === "carousell")
      rows = rows.filter(
        (l) => l.platform === "carousell" || l.platform === "facebook",
      );
    else if (filter !== "all") rows = rows.filter((l) => l.platform === filter);
    if (model !== "all") rows = rows.filter((l) => l.chip === model);
    let withCalc = rows.map((l) => ({ l, c: calc(l, rate) }));
    // 可买订单 lives in the sort dropdown, not the filter row: selecting
    // it filters the list (on top of the platform filter above) down to
    // the listings judged 可买 (verdict green), keeping 推荐优先 order.
    if (sort === "buyable")
      withCalc = withCalc.filter((x) => x.c.verdict === "green");
    const verdictRank = (v: string | null) =>
      v === "green" ? 0 : v === "yellow" ? 1 : v === "red" ? 2 : 3;
    withCalc.sort((a, b) => {
      if (sort === "priceAsc") return a.l.priceCny - b.l.priceCny;
      if (sort === "newest")
        return b.l.createdAt.localeCompare(a.l.createdAt);
      // 利润优先: pure profit-high order across the whole list, no
      // verdict grouping — a high-profit 观望 row outranks a low-profit
      // 可买 row here.
      if (sort === "profit")
        return (b.c.profitHigh ?? -Infinity) - (a.c.profitHigh ?? -Infinity);
      // 推荐优先 (and 可买订单, whose rows are all green): group by
      // verdict first, then by profit high within each group.
      const r = verdictRank(a.c.verdict) - verdictRank(b.c.verdict);
      if (r !== 0) return r;
      return (b.c.profitHigh ?? -Infinity) - (a.c.profitHigh ?? -Infinity);
    });
    return withCalc.map((x) => x.l);
  }, [listings, filter, model, sort, rate]);

  const openListing = openId ? listings.find((l) => l.id === openId) : undefined;

  const openDetail = useCallback(
    (l: Listing) => {
      setOpenId(l.id);
      sessionStorage.setItem(OPEN_KEY, l.id);
      window.history.replaceState(null, "", `#item=${encodeURIComponent(l.id)}`);
    },
    [],
  );
  const closeDetail = useCallback(() => {
    setOpenId(null);
    sessionStorage.removeItem(OPEN_KEY);
    window.history.replaceState(null, "", window.location.pathname);
  }, []);

  useEffect(() => {
    const onHash = () => {
      const m = window.location.hash.match(/#item=([^&]+)/);
      let id: string | null = null;
      if (m) {
        try { id = decodeURIComponent(m[1] ?? ""); } catch { id = m[1] ?? ""; }
      }
      setOpenId(id);
      // Keep the session fallback in step with hash navigation.
      if (id) sessionStorage.setItem(OPEN_KEY, id);
      else sessionStorage.removeItem(OPEN_KEY);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const toggleLike = useCallback((l: Listing) => save(s => {
    s.likes[l.id] = !(s.likes[l.id] ?? false);
  }), [save]);

  // List swipe-to-delete + multi-select. Deleting only appends ids to
  // localStorage deletions (the list filters them out on the next read).
  // The detail page has no delete button (user decision 2026-11-17) —
  // deletion happens from the home list only.
  const closeSwipe = useCallback(() => {
    setSwipedId(null);
  }, []);
  const enterMultiSelect = useCallback((id: string) => {
    closeSwipe();
    setMultiSelect(true);
    setSelectedIds(new Set([id]));
  }, [closeSwipe]);
  const toggleSelect = useCallback((id: string) => {
    // The bulk-delete count is captured when the confirm modal opens,
    // and the modal's mask blocks the list meanwhile, so the confirm
    // can never delete a different set than the one shown.
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const exitMultiSelect = useCallback(() => {
    setMultiSelect(false);
    setSelectedIds(new Set());
    closeSwipe();
  }, [closeSwipe]);
  const deleteFromList = useCallback((ids: readonly string[]) => {
    save((s) => {
      for (const id of ids) if (!s.deletions.includes(id)) s.deletions.push(id);
    });
  }, [save]);
  const deleteOneFromList = useCallback((l: Listing) => {
    deleteFromList([l.id]);
    closeSwipe();
  }, [deleteFromList, closeSwipe]);
  const deleteSelected = useCallback(() => {
    deleteFromList([...selectedIds]);
    exitMultiSelect();
  }, [deleteFromList, exitMultiSelect, selectedIds]);

  /* Delete confirm modal (home list only — the detail page has no
     delete button). Tapping Delete — swipe single or the
     multi-select toolbar — opens the modal; Confirm deletes, Cancel or
     the mask closes without deleting. */
  const requestSingleDelete = useCallback((l: Listing) => {
    closeSwipe();
    setDeleteConfirm({ kind: "single", listing: l });
  }, [closeSwipe]);
  const confirmDelete = useCallback(() => {
    if (!deleteConfirm) return;
    if (deleteConfirm.kind === "single") deleteOneFromList(deleteConfirm.listing);
    else deleteSelected();
    setDeleteConfirm(null);
  }, [deleteConfirm, deleteOneFromList, deleteSelected]);
  const cancelDelete = useCallback(() => setDeleteConfirm(null), []);
  /* Defensive coercion (audit 2026-11-17): a hand-edited number field
     must never store NaN — Number(".") is NaN, NaN ?? 0 is still NaN,
     and NaN serialises to JSON null, which fails the zod schema on the
     next read and bricks the app. The input itself already ignores
     non-finite keystrokes; this is the backstop. */
  const saveAnalysis = useCallback((id: string, a: Analysis) => save(s => {
    const num = (n: number | null | undefined, fallback: number) =>
      typeof n === "number" && Number.isFinite(n) ? n : fallback;
    s.analysis[id] = {
      ...a,
      saleLow: a.saleLow == null || !Number.isFinite(a.saleLow) ? null : a.saleLow,
      saleHigh: a.saleHigh == null || !Number.isFinite(a.saleHigh) ? null : a.saleHigh,
      sampleCount: Math.max(0, Math.trunc(num(a.sampleCount, 0))),
      shippingSgd: num(a.shippingSgd, 0),
      repairSgd: num(a.repairSgd, 0),
      feePercent: num(a.feePercent, 0),
      targetProfit: num(a.targetProfit, 0),
    };
  }), [save]);

  const exportBackup = useCallback(() => {
    const blob = new Blob([exportLocal()], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "macbook-sift-local-backup.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, []);
  const importBackup = useCallback(async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      await restoreLocal(await file.text());
      setNotice("已在此浏览器恢复喜欢、分析和删除记录。");
    } catch { setNotice("导入失败，请选择完整的 Macbook Sift 备份并检查本地存储权限。"); }
  }, []);
  const onSaveToken = useCallback((value: string) => {
    const t = value.trim();
    if (!t) { setNotice("请先粘贴令牌。"); return false; }
    /* A mistyped token otherwise surfaces only later as "Token 无效或
       权限不足" at sync time. Fine-grained tokens start with
       github_pat_, classic ones with ghp_ — anything else is almost
       certainly a paste mistake, so warn but still save it (a future
       token format should not be hard-blocked). */
    if (!t.startsWith("github_pat_") && !t.startsWith("ghp_")) {
      setNotice("这个令牌看起来不太像 GitHub 令牌（应以 github_pat_ 或 ghp_ 开头），请检查是否粘贴错了。");
      return false;
    }
    saveSyncToken(t);
    setToken(t);
    setNotice("同步令牌已保存在此浏览器。");
    return true;
  }, []);
  const onClearToken = useCallback(() => {
    clearSyncToken();
    setToken("");
    setNotice("同步令牌已清除。");
  }, []);
  /* Two-way sync: the manual 同步 button, and the auto-upload that
     also pushes personal state after a like/delete/edit (see
     queueUpload above). The hourly auto-refresh still downloads
     listings only and never uploads or merges cloud state:
     1. download the latest listings + rate, as before;
     2. download the cloud personal state (404 = none yet);
     3. merge cloud into local (deletions union — deleted never comes
        back; explicit local likes/analysis fields win);
     4. write the merge back locally;
     5. if a token is set, upload the merged state to user-data.json. */
  const syncAll = useCallback(async () => {
    if (syncing) return;
    setSyncing(true);
    const beforeCount = state.data?.listings.length ?? 0;
    try {
      const [feedResult] = await Promise.allSettled([state.refetch(), rateQuery.refetch()]);
      const afterCount =
        feedResult.status === "fulfilled" ? (feedResult.value.data?.listings.length ?? beforeCount) : beforeCount;
      const newCount = Math.max(0, afterCount - beforeCount);
      /* The cloud section runs through the same upload queue as
         auto-upload (see queueUpload above), so the two can never
         merge from the same stale snapshot. A failed cloud read is
         NOT "no cloud file": the merge still applies locally, but the
         upload is skipped — uploading a local-only merge here would
         overwrite the cloud-only likes and deletions. */
      const { merged, uploadNote, cloudNote } = await queueUpload(async () => {
        let cloudNote = "";
        let cloud: PersonalData | null = null;
        let cloudReadFailed = false;
        try {
          cloud = await fetchCloudPersonal();
        } catch {
          cloudNote = "云端数据读取失败，仅使用本机数据；";
          cloudReadFailed = true;
        }
        const merged = mergePersonal(readLocal(), cloud ?? { likes: {}, analysis: {}, deletions: [] });
        await editLocal(s => { s.likes = merged.likes; s.analysis = merged.analysis; s.deletions = merged.deletions; });
        let uploadNote: string;
        const tok = readSyncToken();
        if (!tok) {
          uploadNote = "未设置同步 Token，喜欢只存在本机";
        } else if (cloudReadFailed) {
          uploadNote = "云端读取失败，本次未上传";
        } else {
          try {
            await uploadCloudPersonal(tok, merged);
            uploadNote = "云端已更新";
          } catch (e) {
            uploadNote = e instanceof Error ? e.message : "云端上传失败";
          }
        }
        return { merged, uploadNote, cloudNote };
      });
      const likeCount = Object.values(merged.likes).filter(Boolean).length;
      setNotice(`同步完成：新增 ${newCount} 台 · 喜欢 ${likeCount} 个 · 已删 ${merged.deletions.length} 台 · ${cloudNote}${uploadNote}`);
    } catch {
      setNotice("同步失败，请检查网络后重试。");
    } finally {
      setSyncing(false);
    }
  }, [state, rateQuery, syncing, queueUpload]);
  const filters: Array<{ key: FilterMode; label: string }> = [
    { key: "all", label: "全部" },
    { key: "xianyu", label: "闲鱼" },
    { key: "carousell", label: "Carousell" },
    { key: "liked", label: "喜欢" },
  ];

  // Fast rewind to the first row after a sort / layout / filter switch.
  // Which element actually scrolls depends on the shell hosting the
  // page: the old version named two candidates ([data-generated-
  // space-root] and the document scroller), and on the user's phone
  // neither of them is the scroller — both read scrollTop 0 forever,
  // so the rewind silently did nothing there even though the same
  // code worked in a desktop browser. So the scroller is now
  // DISCOVERED, not named: walk up from the home <main> through its
  // ancestors and keep every element whose content overflows it (the
  // real scroller is one of them in any shell), add the known shell
  // candidates and the document scroller, and animate all of them
  // plus the window. Elements that don't scroll read 0 and drop out;
  // the one that does is rewound to 0 over ~200ms with an ease-out
  // cubic — a quick rewind that lands on the first item, not a slow
  // smooth glide.
  const rewindRaf = useRef<number | null>(null);
  const scrollTop = useCallback(() => {
    if (rewindRaf.current !== null) {
      cancelAnimationFrame(rewindRaf.current);
      rewindRaf.current = null;
    }
    const targets = new Set<HTMLElement>();
    let ancestor: HTMLElement | null = homeRef.current;
    while (ancestor) {
      if (ancestor.scrollHeight > ancestor.clientHeight) {
        targets.add(ancestor);
      }
      ancestor = ancestor.parentElement;
    }
    for (const sel of ["[data-generated-space-root]", ".hatch-space-root"]) {
      const candidate = document.querySelector<HTMLElement>(sel);
      if (candidate) targets.add(candidate);
    }
    const docScroller = document.scrollingElement as HTMLElement | null;
    if (docScroller) targets.add(docScroller);
    const starts = [...targets]
      .map((el) => ({ el, from: el.scrollTop }))
      .filter((t) => t.from > 0);
    const winFrom = window.scrollY;
    if (starts.length === 0 && winFrom <= 0) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      for (const t of starts) t.el.scrollTop = 0;
      if (winFrom > 0) window.scrollTo(0, 0);
      return;
    }
    const duration = 200;
    const t0 = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - t0) / duration);
      const remaining = Math.pow(1 - t, 3);
      for (const s of starts) s.el.scrollTop = Math.round(s.from * remaining);
      if (winFrom > 0) window.scrollTo(0, Math.round(winFrom * remaining));
      if (t < 1) {
        rewindRaf.current = requestAnimationFrame(step);
      } else {
        for (const s of starts) s.el.scrollTop = 0;
        if (winFrom > 0) window.scrollTo(0, 0);
        rewindRaf.current = null;
      }
    };
    rewindRaf.current = requestAnimationFrame(step);
  }, []);

  useEffect(
    () => () => {
      if (rewindRaf.current !== null) cancelAnimationFrame(rewindRaf.current);
    },
    [],
  );

  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--text)]">
      <main ref={homeRef} className={`mx-auto max-w-5xl px-4 transition-[padding-bottom] duration-200 ease-out ${multiSelect ? "pb-44" : "pb-12"}`}>
        <header className="pb-2 pt-4 sm:pb-3 sm:pt-5">
          {/* Title artwork: the user's supplied MACBOOK SVG,
              pre-rasterised at build time to a WebP bitmap
              (client/src/assets/title-art.webp, 2197x533 — over 2x
              the widest it ever displays). This artwork carries its
              own rainbow palette — solid fills and gradient strokes
              — so nothing is recoloured; it reads on both the light
              and dark grounds and its own ground stays transparent.
              It fills the full content width, centred, with the
              height following the artwork's own 3295:800 aspect
              ratio, and the header's vertical padding is kept small
              so the title takes as little of the homepage as
              possible. */}
          <h1 className="sr-only">macbook sift</h1>
          {/* The artwork renders as ONE <img> of a fixed bitmap —
              never as vector. As live SVG markup its thousands of
              traced path nodes taxed every list layout and gesture
              snapshot clone; as an <img> fed by a blob URL of the
              SVG it still re-rasterised the vector paths whenever
              the list repainted with the title on screen, which is
              exactly when scrolling hitched. A decoded bitmap is
              composited, not re-drawn: the compositor just moves
              the finished texture, so the title costs nothing per
              scroll frame. The picture is pixel-identical. */}
          <img
            src={TITLE_IMG_SRC}
            alt=""
            aria-hidden="true"
            draggable={false}
            decoding="async"
            className="title-art mx-auto block h-auto w-full select-none"
          />
        </header>

        <div className="control-bar sticky top-0 z-30 -mx-4 px-4 pb-0 pt-2">
          <div className="glass-panel px-3 py-3">
          <div className="flex items-stretch gap-2.5">
            <MenuSelect
              ariaLabel="排序方式"
              value={sort}
              options={[
                { value: "recommend", label: "推荐优先" },
                { value: "buyable", label: "可买订单" },
                { value: "profit", label: "利润优先" },
                { value: "priceAsc", label: "价格优先" },
                { value: "newest", label: "时间优先" },
              ]}
              onChange={(v) => {
                setSort(v as SortMode);
                scrollTop();
              }}
            />
            <MenuSelect
              ariaLabel="型号筛选"
              value={model}
              options={[
                { value: "all", label: "全部型号" },
                { value: "M1 Pro", label: "M1 Pro" },
                { value: "M2 Pro", label: "M2 Pro" },
                { value: "M3 Pro", label: "M3 Pro" },
                { value: "M4 Pro", label: "M4 Pro" },
                { value: "M5 Pro", label: "M5 Pro" },
              ]}
              onChange={(v) => {
                setModel(v as ModelFilter);
                scrollTop();
              }}
            />
            <MenuSelect
              ariaLabel="列数模式"
              value={layout}
              options={[
                { value: "single", label: "单列模式" },
                { value: "multi", label: "多列模式" },
              ]}
              onChange={(v) => {
                setLayout(v as LayoutMode);
                scrollTop();
              }}
            />
          </div>
          <div className="mt-2.5 flex items-stretch gap-2">
            <div
              className="flex min-w-0 flex-[4] gap-2"
              role="group"
              aria-label="平台筛选"
            >
              {filters.map((f) => (
                <button
                  key={f.key}
                  type="button"
                  aria-label={`筛选：${f.label}`}
                  aria-pressed={filter === f.key}
                  className={`filter-pill min-w-0 flex-1 overflow-hidden rounded-full border px-0.5 py-2.5 text-center text-[10px] tracking-tight sm:px-2 sm:text-sm sm:tracking-normal ${
                    pressedKey === f.key
                      ? "glass-dark border-[var(--text)] text-white"
                      : filter === f.key
                        ? "glass filter-pill-active text-[var(--text)]"
                        : "glass border-[var(--border)] text-[var(--dim)]"
                  }`}
                  style={pressedKey === f.key ? { transitionDuration: "90ms" } : undefined}
                  onPointerDown={() => setPressedKey(f.key)}
                  onPointerUp={clearPressed}
                  onPointerLeave={clearPressed}
                  onPointerCancel={clearPressed}
                  onClick={() => {
                    setFilter(f.key);
                    scrollTop();
                  }}
                >
                  <span className="block truncate">{f.label}</span>
                </button>
              ))}
            </div>
            <button
              type="button"
              aria-label="同步最新清单，并将本机喜欢上传到云端"
              title="同步最新清单，并将本机喜欢上传到云端"
              disabled={syncing}
              className={`filter-pill min-w-0 flex-1 rounded-full border px-0.5 py-2.5 text-center text-[10px] font-medium tracking-tight sm:px-2 sm:text-sm sm:tracking-normal ${
                pressedKey === "sync"
                  ? "glass-dark border-[var(--text)] text-white"
                  : "glass border-[var(--border)] text-[var(--dim)]"
              }`}
              style={pressedKey === "sync" ? { transitionDuration: "90ms" } : undefined}
              onPointerDown={() => setPressedKey("sync")}
              onPointerUp={clearPressed}
              onPointerLeave={clearPressed}
              onPointerCancel={clearPressed}
              onClick={() => void syncAll()}
            >
              {syncing || state.isFetching || rateQuery.isFetching ? "同步中" : "同步"}
            </button>
          </div>
          </div>
        </div>

        {state.isRefetchError && <p role="status" className="mt-2 text-sm">清单更新失败，当前显示上次读取的结果。</p>}
        {state.data && state.data.skipped > 0 && <p role="status" className="mt-2 text-sm">清单里有 {state.data.skipped} 条异常记录，已跳过。</p>}
        <div className="no-select pt-5">
          {state.isPending ? (
            <p className="py-16 text-center text-base text-[var(--faint)]">加载中</p>
          ) : state.isLoadingError ? (
            <div className="py-16 text-center">
              <p className="text-base text-[var(--dim)]">加载失败</p>
              <button
                type="button"
                aria-label="重试加载"
                className="glass mt-3 rounded-full border border-[var(--border)] px-5 py-2 text-sm text-[var(--text)]"
                onClick={() => void state.refetch()}
              >
                重试
              </button>
            </div>
          ) : visible.length === 0 ? (
            <p className="py-20 text-center text-base text-[var(--faint)]">暂无机器</p>
          ) : layout === "single" ? (
            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
              {visible.map((l) => (
                <MemoSwipeableItem
                  key={l.id}
                  listing={l}
                  rate={rate}
                  layout={layout}
                  onOpen={openDetail}
                  onToggleLike={toggleLike}
                  onDelete={requestSingleDelete}
                  isSwipedOpen={swipedId === l.id}
                  onSwipeOpen={setSwipedId}
                  onSwipeClose={closeSwipe}
                  multiSelect={multiSelect}
                  isSelected={selectedIds.has(l.id)}
                  onToggleSelect={toggleSelect}
                  onEnterMultiSelect={enterMultiSelect}
                />
              ))}
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {visible.map((l) => (
                <MemoSwipeableItem
                  key={l.id}
                  listing={l}
                  rate={rate}
                  layout={layout}
                  onOpen={openDetail}
                  onToggleLike={toggleLike}
                  onDelete={requestSingleDelete}
                  isSwipedOpen={swipedId === l.id}
                  onSwipeOpen={setSwipedId}
                  onSwipeClose={closeSwipe}
                  multiSelect={multiSelect}
                  isSelected={selectedIds.has(l.id)}
                  onToggleSelect={toggleSelect}
                  onEnterMultiSelect={enterMultiSelect}
                />
              ))}
            </div>
          )}
        </div>

        <footer className="mt-12 border-t border-[var(--border)] pt-5">
          {/* Backup row: three buttons evenly spread (flex-1), same frosted
              pill effect as each other — export, import, and the GitHub
              token, which opens a small modal for pasting it. */}
          <div className="flex gap-2">
            <button
              type="button"
              aria-label="导出备份"
              className="glass min-w-0 flex-1 truncate rounded-full border border-[var(--border)] px-4 py-1.5 text-sm text-[var(--dim)]"
              onClick={() => void exportBackup()}
            >
              导出备份
            </button>
            <button
              type="button"
              aria-label="导入备份"
              className="glass min-w-0 flex-1 truncate rounded-full border border-[var(--border)] px-4 py-1.5 text-sm text-[var(--dim)]"
              onClick={() => fileRef.current?.click()}
            >
              导入备份
            </button>
            <button
              type="button"
              aria-label="GitHub 同步令牌"
              className="glass min-w-0 flex-1 truncate rounded-full border border-[var(--border)] px-4 py-1.5 text-sm text-[var(--dim)]"
              onClick={() => setTokenModalOpen(true)}
            >
              {token ? "Token 已设置" : "GitHub Token"}
            </button>
          </div>
          <p className="mt-2 text-xs text-[var(--dim)]">喜欢和分析保存在此浏览器。换设备前请导出备份。</p>
          <input
            ref={fileRef}
            type="file"
            accept="application/json"
            aria-label="选择备份文件"
            className="hidden"
            onChange={(e) => void importBackup(e)}
          />
        </footer>
      </main>

      {/* Multi-select bottom actions: two separate frosted-glass buttons
          (Cancel left, Delete right), centred as a group at the bottom,
          with the selected count above them. Delete is --btn-red text
          (the like-heart red) on glass; tapping it opens the centred
          confirm modal instead of changing its own label. */}
      {multiSelect ? (
        <div className="ms-bar-in pointer-events-none fixed inset-x-0 bottom-0 z-40 flex flex-col items-center gap-2 pb-[calc(env(safe-area-inset-bottom)+14px)]">
          <span className="glass pointer-events-none rounded-full px-3 py-1 text-xs text-[var(--dim)]">
            已选 {selectedIds.size} 台
          </span>
          <div className="pointer-events-auto flex items-center justify-center gap-4">
            <button
              type="button"
              aria-label="取消多选"
              className="glass rounded-full border border-[var(--border)] px-6 py-3 text-sm font-medium text-[var(--text)] transition-all duration-200 ease-out"
              onClick={exitMultiSelect}
            >
              取消
            </button>
            <button
              type="button"
              aria-label="删除已选机器"
              disabled={selectedIds.size === 0}
              className="glass whitespace-nowrap rounded-full border border-[var(--border)] px-6 py-3 text-sm font-medium transition-all duration-200 ease-out disabled:opacity-40"
              style={{ color: "var(--btn-red)" }}
              onClick={() => setDeleteConfirm({ kind: "bulk", count: selectedIds.size })}
            >
              删除
            </button>
          </div>
        </div>
      ) : null}

      {deleteConfirm ? (
        <DeleteConfirmModal
          confirm={deleteConfirm}
          onConfirm={confirmDelete}
          onCancel={cancelDelete}
        />
      ) : null}

      {tokenModalOpen ? (
        <TokenModal
          hasToken={!!token}
          onSave={onSaveToken}
          onClear={onClearToken}
          onCancel={() => setTokenModalOpen(false)}
        />
      ) : null}

      {notice ? (
        <NoticePopup message={notice} onClose={() => setNotice("")} />
      ) : null}

      {openListing ? (
        <MemoDetail
          listing={openListing}
          rate={rate}
          onClose={closeDetail}
          onToggleLike={toggleLike}
          onSaveAnalysis={saveAnalysis}
          homeRef={homeRef}
        />
      ) : null}
    </div>
  );
}
