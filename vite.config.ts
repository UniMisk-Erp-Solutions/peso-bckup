import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { execSync } from "child_process";
import { componentTagger } from "lovable-tagger";

/**
 * DOC-090 — non-secret build constants for GlitchTip.
 *
 * Only a commit SHA and an environment name are injected. Never a token:
 * anything reachable from browser code is public, so the source-map upload
 * credential stays a build-only SENTRY_* variable and is never VITE_-prefixed.
 */
function resolveRelease(): string {
  // Vercel exposes the commit SHA to the build, not to the browser.
  const fromVercel = process.env.VERCEL_GIT_COMMIT_SHA;
  if (fromVercel) return fromVercel;
  const explicit = process.env.APP_RELEASE;
  if (explicit) return explicit;
  try {
    return execSync("git rev-parse HEAD", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    // No git (e.g. a source tarball build) — never fail the build for this.
    return "unknown";
  }
}

/**
 * production | preview | development.
 *
 * import.meta.env.MODE alone cannot tell a Vercel preview from Production —
 * both build in production mode — so DEV-preview noise and real Production
 * incidents would land in the same GlitchTip environment.
 */
function resolveDeployEnv(mode: string): string {
  const vercelEnv = process.env.VERCEL_ENV; // "production" | "preview" | "development"
  if (vercelEnv) return vercelEnv;
  return mode === "production" ? "production" : "development";
}

// https://vitejs.dev/config/
// cacheDir outside node_modules avoids Windows EPERM (OneDrive/antivirus locks on node_modules\.vite)
export default defineConfig(({ mode }) => ({
  cacheDir: path.resolve(__dirname, ".vite"),
  server: {
    host: "localhost",
    port: 3000,
    strictPort: true,
    hmr: {
      protocol: "ws",
      host: "localhost",
      port: 3000,
    },
  },
  plugins: [react(), mode === "development" && componentTagger()].filter(Boolean),
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  define: {
    __APP_RELEASE__: JSON.stringify(resolveRelease()),
    __APP_DEPLOY_ENV__: JSON.stringify(resolveDeployEnv(mode)),
  },
  build: {
    outDir: "dist",
    assetsDir: "assets",
    cssCodeSplit: true,
    // "hidden" emits full .map files for upload but omits the
    // //# sourceMappingURL comment from the bundles, so browsers never fetch
    // them and DevTools will not de-minify the app for casual visitors.
    // GlitchTip matches them by debug ID instead, injected by
    // `npm run sourcemaps:inject` before upload.
    //
    // The .map files still land in dist/, so the upload script deletes them
    // after a successful upload — see scripts/glitchtip-sourcemaps.mjs.
    sourcemap: "hidden",
    rollupOptions: {
      output: {
        manualChunks: {
          react: ["react", "react-dom", "react-router-dom"],
          supabase: ["@supabase/supabase-js", "@tanstack/react-query"],
          ui: ["lucide-react", "sonner"],
          reporting: ["jspdf", "jspdf-autotable", "xlsx"],
        },
      },
    },
  },
}));
