import { cp, mkdir, writeFile, readFile, rename } from "node:fs/promises";
import { createHash } from "node:crypto";

await mkdir("docs", { recursive: true });
const result = await Bun.build({
  entrypoints: ["client/src/main.tsx"], outdir: "docs", target: "browser",
  minify: true, define: { "process.env.NODE_ENV": '"production"' },
  loader: { ".webp": "file" },
  // Cache-busting (user decision 2026-11-17): every build emits a new
  // content-hashed JS name, and the stylesheet gets a hash of its own
  // contents, so a phone that cached the old bundle can never keep
  // serving it once the new index.html lands — no more "close the tab
  // and reopen" to see a fix. Old hashed files are deliberately left
  // in place: a tab still holding the old HTML loads its old bundle
  // fine instead of breaking on a 404.
  naming: { entry: "[name]-[hash].[ext]", chunk: "[name]-[hash].[ext]", asset: "[name]-[hash].[ext]" },
});
if (!result.success) throw new AggregateError(result.logs, "Frontend build failed");
const jsOut = result.outputs.find((o) => o.kind === "entry-point");
if (!jsOut) throw new Error("Build produced no entry-point output");
const jsName = jsOut.path.split("/").pop();
const css = Bun.spawn([process.execPath, "node_modules/@tailwindcss/cli/dist/index.mjs", "-i", "client/src/theme.css", "-o", "docs/style.css", "--minify"], { stdout: "inherit", stderr: "inherit" });
if (await css.exited !== 0) throw new Error("CSS build failed");
const cssBytes = await readFile("docs/style.css");
const cssHash = createHash("sha256").update(cssBytes).digest("hex").slice(0, 10);
const cssName = `style-${cssHash}.css`;
await rename("docs/style.css", `docs/${cssName}`);
const html = (await readFile("client/index.html", "utf8")).replace("./src/main.tsx", `./${jsName}`)
  .replace("</head>", `<link rel="stylesheet" href="./${cssName}"></head>`);
await writeFile("docs/index.html", html);
await writeFile("docs/.nojekyll", "");
await cp("icons", "docs/icons", { recursive: true });
await cp("manifest.webmanifest", "docs/manifest.webmanifest");
