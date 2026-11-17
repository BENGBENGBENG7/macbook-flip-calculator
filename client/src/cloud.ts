import { parseCloudPersonal, type PersonalData } from "./local";

/* Two-way sync transport for the static GitHub Pages tool. The page has
   no backend and must never embed a token, so the user pastes their own
   fine-grained token (Contents read+write on this repo only) into the
   settings section; it is sent only to api.github.com for this repo.
   The cloud state file user-data.json is public-readable, so downloads
   need no token at all. */

const USER_DATA_RAW_URL =
  "https://raw.githubusercontent.com/BENGBENGBENG7/macbook-flip-calculator/main/user-data.json";
const CONTENTS_URL =
  "https://api.github.com/repos/BENGBENGBENG7/macbook-flip-calculator/contents/user-data.json";
const SYNC_MESSAGE = "Sync personal state from Macbook Sift";

/* UTF-8 safe base64: plain btoa() on a raw string mangles non-ASCII
   (Chinese text in analysis / soldSource), so encode to bytes first.
   Chunked so a large state file cannot blow the argument stack. */
export function base64Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCodePoint(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/* Download the cloud state file. 404 means no cloud state yet — treated
   as empty, not an error. Any other failure throws so the caller can
   keep going with local state only and say so. */
export async function fetchCloudPersonal(signal?: AbortSignal): Promise<PersonalData | null> {
  const res = await fetch(USER_DATA_RAW_URL, {
    signal,
    cache: "no-cache",
    credentials: "omit",
    referrerPolicy: "no-referrer",
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error("云端读取失败");
  return parseCloudPersonal(await res.json());
}

async function getContentsSha(token: string): Promise<string | undefined> {
  const res = await fetch(CONTENTS_URL, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
  });
  if (res.status === 404) return undefined;
  if (res.status === 401 || res.status === 403) throw new Error("Token 无效或权限不足");
  if (!res.ok) throw new Error("云端上传失败");
  const json = await res.json();
  return typeof json?.sha === "string" ? json.sha : undefined;
}

/* Upload merged state to user-data.json. GETs the current blob SHA first
   (404 = create new). On a 409 conflict the SHA is re-fetched and the
   PUT retried once, then failure is reported. */
export async function uploadCloudPersonal(token: string, data: PersonalData): Promise<void> {
  const content = base64Utf8(
    JSON.stringify(
      { format: "macbook-sift-local-v1", likes: data.likes, analysis: data.analysis, deletions: data.deletions },
      null,
      2,
    ),
  );
  const put = async (sha?: string) =>
    fetch(CONTENTS_URL, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ message: SYNC_MESSAGE, content, ...(sha ? { sha } : {}) }),
    });
  let sha = await getContentsSha(token);
  let res = await put(sha);
  if (res.status === 409) {
    sha = await getContentsSha(token);
    res = await put(sha);
  }
  if (res.status === 401 || res.status === 403) throw new Error("Token 无效或权限不足");
  if (!res.ok) throw new Error("云端上传失败");
}
