import { build as esbuild } from "esbuild";
import { rm, readFile } from "fs/promises";

/**
 * Build script — produces dist/index.cjs for production.
 *
 * Strategy:
 *   - Bundle pure-JS deps from the allowlist for faster cold starts
 *   - Keep all native modules and ESM-only packages EXTERNAL
 *     so Node loads them directly from node_modules at runtime
 *   - pg-boss and other ESM packages are explicitly external to
 *     prevent esbuild from mangling their module format
 *
 * Rule of thumb: if a package uses dynamic imports, top-level await,
 * or ships only ESM, it goes in ESM_EXTERNAL, not the allowlist.
 */

// Packages to bundle (pure CJS, no native bindings, no dynamic imports)
const BUNDLE_ALLOWLIST = [
  "@google/generative-ai",
  "@neondatabase/serverless",
  "axios",
  "connect-pg-simple",
  "cors",
  "date-fns",
  "drizzle-orm",
  "drizzle-zod",
  "express",
  "express-rate-limit",
  "express-session",
  "helmet",
  "jsonwebtoken",
  "memorystore",
  "multer",
  "nanoid",
  "nodemailer",
  "openai",
  "passport",
  "passport-local",
  "stripe",
  "uuid",
  "ws",
  "xlsx",
  "zod",
  "zod-validation-error",
];

// Packages that MUST stay external — ESM-only or native bindings
// Adding a package here = Node loads it from node_modules at runtime
const FORCE_EXTERNAL = [
  "pg-boss",      // ESM — constructor breaks when bundled into CJS
  "puppeteer",    // Native bindings
  "bcrypt",       // Native bindings
  "pg",           // Native bindings (libpq)
];

async function buildServer() {
  await rm("dist", { recursive: true, force: true });

  console.log("building server...");
  const pkg = JSON.parse(await readFile("package.json", "utf-8"));
  const allDeps = [
    ...Object.keys(pkg.dependencies || {}),
    ...Object.keys(pkg.devDependencies || {}),
  ];

  // Everything not in the allowlist is external by default
  // FORCE_EXTERNAL adds explicit safety for problematic packages
  const externals = [
    ...allDeps.filter((dep) => !BUNDLE_ALLOWLIST.includes(dep)),
    ...FORCE_EXTERNAL,
  ].filter((v, i, a) => a.indexOf(v) === i); // dedupe

  await esbuild({
    entryPoints: ["server/index.ts"],
    platform: "node",
    bundle: true,
    format: "cjs",
    outfile: "dist/index.cjs",
    define: {
      "process.env.NODE_ENV": '"production"',
    },
    minify: true,
    external: externals,
    logLevel: "info",
  });
}

buildServer().catch((err) => {
  console.error(err);
  process.exit(1);
});
