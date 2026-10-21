import { readFileSync } from "node:fs";

const asset = (name) => new URL(`./assets/${name}`, import.meta.url);
const readSvg = (name) => readFileSync(asset(name), "utf8").trim();

function inlineSvg(name, className, width, height) {
  return readSvg(name)
    .replace(/ width="[^"]*" height="[^"]*"/, ` width="${width}" height="${height}"`)
    .replace('<svg ', `<svg class="${className}" aria-hidden="true" focusable="false" `)
    .replace('fill="#191919"', 'fill="currentColor"');
}

export const MARK_SVG = inlineSvg("tracequest-mark.svg", "app-mark", 28, 28);
export const WORDMARK_SVG = inlineSvg("tracequest-wordmark.svg", "app-logotype", 140, 26);
export const FAVICON_LINKS = '<link rel="icon" href="/favicon.ico" sizes="16x16 24x24 32x32 48x48 64x64 128x128 256x256">\n<link rel="icon" type="image/svg+xml" href="/favicon.svg">';
export const STANDALONE_FAVICON_LINK = `<link rel="icon" type="image/svg+xml" href="data:image/svg+xml;base64,${Buffer.from(readSvg("favicon.svg")).toString("base64")}">`;

const files = [
  "tracequest-mark.svg", "tracequest-mark-light.svg",
  "tracequest-mark.png", "tracequest-mark-light.png",
  "tracequest-wordmark.svg", "tracequest-wordmark-light.svg",
  "tracequest-wordmark.png", "tracequest-wordmark-light.png",
  "favicon.svg", "favicon.png", "favicon.ico",
];
const types = { svg: "image/svg+xml", png: "image/png", ico: "image/x-icon" };

/** Fixed public assets only; request paths never become filesystem paths. */
export const BRAND_ASSETS = new Map(files.map((name) => [
  `/assets/brand/${name}`,
  { url: asset(name), type: types[name.split(".").pop()] },
]));
for (const name of ["favicon.svg", "favicon.png", "favicon.ico"]) {
  BRAND_ASSETS.set(`/${name}`, BRAND_ASSETS.get(`/assets/brand/${name}`));
}
