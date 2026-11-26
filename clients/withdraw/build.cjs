const { copyFileSync, mkdirSync } = require("node:fs");
const { join, resolve } = require("node:path");

const dependency = require.resolve("@solana/web3.js/lib/index.iife.min.js");
const output = resolve(__dirname, "../../target/withdraw-page");
const vendor = join(output, "vendor");
mkdirSync(vendor, { recursive: true });
for (const file of ["index.html", "styles.css", "withdraw.js", "protocol.mjs"]) {
  copyFileSync(join(__dirname, file), join(output, file));
}
copyFileSync(dependency, join(vendor, "solana-web3.min.js"));
console.log(output);
