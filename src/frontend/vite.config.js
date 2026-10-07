import { defineConfig } from "vite";
import { execSync } from "node:child_process";
import { icpBindgen } from "@icp-sdk/bindgen/plugins/vite";

// `vite dev` only: simulate the ic_env cookie the asset canister sets in production.
function devServerConfig() {
  const env = process.env.ICP_ENVIRONMENT || "local";
  const net = JSON.parse(execSync(`icp network status -e ${env} --json`, { encoding: "utf-8" }));
  const id = execSync(`icp canister status service_proof -e ${env} -i`, { encoding: "utf-8" }).trim();
  return {
    headers: {
      "Set-Cookie": `ic_env=${encodeURIComponent(
        `PUBLIC_CANISTER_ID:service_proof=${id}&ic_root_key=${net.root_key}`,
      )}; SameSite=Lax;`,
    },
    proxy: { "/api": { target: net.api_url, changeOrigin: true } },
  };
}

export default defineConfig(({ command }) => ({
  plugins: [
    icpBindgen({
      didFile: "../backend/service_proof.did",
      outDir: "./src/bindings",
    }),
  ],
  build: { outDir: "dist", emptyOutDir: true, target: "es2022" },
  ...(command === "serve" ? { server: devServerConfig() } : {}),
}));
