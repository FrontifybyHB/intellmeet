import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const dist = resolve("dist");
const origin = (process.env.VITE_PUBLIC_ORIGIN || "").trim().replace(/\/$/, "");
mkdirSync(dist, { recursive: true });

writeFileSync(
  resolve(dist, "robots.txt"),
  origin
    ? `User-agent: *\nAllow: /\nDisallow: /login\nDisallow: /register\nDisallow: /join/\nDisallow: /home\nDisallow: /meetings\nDisallow: /account\nSitemap: ${origin}/sitemap.xml\n`
    : "User-agent: *\nAllow: /\nDisallow: /login\nDisallow: /register\nDisallow: /join/\nDisallow: /home\nDisallow: /meetings\nDisallow: /account\n",
);

if (origin) {
  writeFileSync(
    resolve(dist, "sitemap.xml"),
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${origin}/</loc></url></urlset>\n`,
  );
} else {
  console.warn("VITE_PUBLIC_ORIGIN is unset; sitemap.xml was not generated for this build.");
}

// Keep the source HTML readable in static-host previews and fail loudly if Vite did not emit it.
readFileSync(resolve(dist, "index.html"), "utf8");
