import { cp, mkdir, writeFile, readFile } from "node:fs/promises";

await mkdir("docs", { recursive: true });
const result = await Bun.build({
  entrypoints: ["client/src/main.tsx"], outdir: "docs", target: "browser",
  minify: true, define: { "process.env.NODE_ENV": '"production"' },
  loader: { ".webp": "file" },
});
if (!result.success) throw new AggregateError(result.logs, "Frontend build failed");
const css = Bun.spawn([process.execPath, "node_modules/@tailwindcss/cli/dist/index.mjs", "-i", "client/src/theme.css", "-o", "docs/style.css", "--minify"], { stdout: "inherit", stderr: "inherit" });
if (await css.exited !== 0) throw new Error("CSS build failed");
const html = (await readFile("client/index.html", "utf8")).replace("./src/main.tsx", "./main.js")
  .replace("</head>", '<link rel="stylesheet" href="./style.css"></head>');
await writeFile("docs/index.html", html);
await writeFile("docs/.nojekyll", "");
await cp("icons", "docs/icons", { recursive: true });
await cp("manifest.webmanifest", "docs/manifest.webmanifest");
