import esbuild from "esbuild";

const watch = process.argv.includes("--watch");

/** @type {import("esbuild").BuildOptions} */
const opts = {
  entryPoints: ["src/main.ts"],
  bundle: false,
  platform: "neutral",
  target: ["es2019"],
  format: "esm",
  outfile: "../backend/modules/build/index.js",
  sourcemap: false,
  logLevel: "info",
};

if (!watch) {
  await esbuild.build(opts);
  process.exit(0);
}

const ctx = await esbuild.context(opts);
await ctx.watch();
console.log("Watching backend module build...");

