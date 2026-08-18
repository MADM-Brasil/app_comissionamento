// vite.config.ts
import { jsxLocPlugin } from "file:///C:/Users/felipe.oliveira/Desktop/PRJ/MADMcomissionamento/frontend/node_modules/@builder.io/vite-plugin-jsx-loc/dist/index.js";
import tailwindcss from "file:///C:/Users/felipe.oliveira/Desktop/PRJ/MADMcomissionamento/frontend/node_modules/@tailwindcss/vite/dist/index.mjs";
import react from "file:///C:/Users/felipe.oliveira/Desktop/PRJ/MADMcomissionamento/frontend/node_modules/@vitejs/plugin-react/dist/index.js";
import fs from "node:fs";
import path from "node:path";
import { defineConfig } from "file:///C:/Users/felipe.oliveira/Desktop/PRJ/MADMcomissionamento/frontend/node_modules/vite/dist/node/index.js";
import { vitePluginManusRuntime } from "file:///C:/Users/felipe.oliveira/Desktop/PRJ/MADMcomissionamento/frontend/node_modules/vite-plugin-manus-runtime/dist/index.js";
var __vite_injected_original_dirname = "C:\\Users\\felipe.oliveira\\Desktop\\PRJ\\MADMcomissionamento\\frontend";
var PROJECT_ROOT = __vite_injected_original_dirname;
var LOG_DIR = path.join(PROJECT_ROOT, ".manus-logs");
var MAX_LOG_SIZE_BYTES = 1 * 1024 * 1024;
var TRIM_TARGET_BYTES = Math.floor(MAX_LOG_SIZE_BYTES * 0.6);
function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}
function trimLogFile(logPath, maxSize) {
  try {
    if (!fs.existsSync(logPath) || fs.statSync(logPath).size <= maxSize) {
      return;
    }
    const lines = fs.readFileSync(logPath, "utf-8").split("\n");
    const keptLines = [];
    let keptBytes = 0;
    const targetSize = TRIM_TARGET_BYTES;
    for (let i = lines.length - 1; i >= 0; i--) {
      const lineBytes = Buffer.byteLength(`${lines[i]}
`, "utf-8");
      if (keptBytes + lineBytes > targetSize) break;
      keptLines.unshift(lines[i]);
      keptBytes += lineBytes;
    }
    fs.writeFileSync(logPath, keptLines.join("\n"), "utf-8");
  } catch {
  }
}
function writeToLogFile(source, entries) {
  if (entries.length === 0) return;
  ensureLogDir();
  const logPath = path.join(LOG_DIR, `${source}.log`);
  const lines = entries.map((entry) => {
    const ts = (/* @__PURE__ */ new Date()).toISOString();
    return `[${ts}] ${JSON.stringify(entry)}`;
  });
  fs.appendFileSync(logPath, `${lines.join("\n")}
`, "utf-8");
  trimLogFile(logPath, MAX_LOG_SIZE_BYTES);
}
function vitePluginManusDebugCollector() {
  return {
    name: "manus-debug-collector",
    transformIndexHtml(html) {
      if (process.env.NODE_ENV === "production") {
        return html;
      }
      return {
        html,
        tags: [
          {
            tag: "script",
            attrs: {
              src: "/__manus__/debug-collector.js",
              defer: true
            },
            injectTo: "head"
          }
        ]
      };
    },
    configureServer(server) {
      server.middlewares.use("/__manus__/logs", (req, res, next) => {
        if (req.method !== "POST") {
          return next();
        }
        const handlePayload = (payload) => {
          if (payload.consoleLogs?.length > 0) {
            writeToLogFile("browserConsole", payload.consoleLogs);
          }
          if (payload.networkRequests?.length > 0) {
            writeToLogFile("networkRequests", payload.networkRequests);
          }
          if (payload.sessionEvents?.length > 0) {
            writeToLogFile("sessionReplay", payload.sessionEvents);
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true }));
        };
        const reqBody = req.body;
        if (reqBody && typeof reqBody === "object") {
          try {
            handlePayload(reqBody);
          } catch (e) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: false, error: String(e) }));
          }
          return;
        }
        let body = "";
        req.on("data", (chunk) => {
          body += chunk.toString();
        });
        req.on("end", () => {
          try {
            const payload = JSON.parse(body);
            handlePayload(payload);
          } catch (e) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: false, error: String(e) }));
          }
        });
      });
    }
  };
}
var plugins = [react(), tailwindcss(), jsxLocPlugin(), vitePluginManusRuntime(), vitePluginManusDebugCollector()];
var vite_config_default = defineConfig({
  plugins,
  resolve: {
    alias: {
      "@": path.resolve(__vite_injected_original_dirname, "client", "src"),
      "@shared": path.resolve(__vite_injected_original_dirname, "shared"),
      "@assets": path.resolve(__vite_injected_original_dirname, "attached_assets")
    }
  },
  envDir: path.resolve(__vite_injected_original_dirname),
  root: path.resolve(__vite_injected_original_dirname, "client"),
  build: {
    outDir: path.resolve(__vite_injected_original_dirname, "dist/public"),
    emptyOutDir: true
  },
  server: {
    port: 3008,
    strictPort: false,
    // Will find next available port if 3008 is busy
    host: true,
    allowedHosts: [
      ".manuspre.computer",
      ".manus.computer",
      ".manus-asia.computer",
      ".manuscomputer.ai",
      ".manusvm.computer",
      "localhost",
      "127.0.0.1"
    ],
    fs: {
      strict: true,
      deny: ["**/.*"]
    }
  }
});
export {
  vite_config_default as default
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsidml0ZS5jb25maWcudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImNvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9kaXJuYW1lID0gXCJDOlxcXFxVc2Vyc1xcXFxmZWxpcGUub2xpdmVpcmFcXFxcRGVza3RvcFxcXFxQUkpcXFxcTUFETWNvbWlzc2lvbmFtZW50b1xcXFxmcm9udGVuZFwiO2NvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9maWxlbmFtZSA9IFwiQzpcXFxcVXNlcnNcXFxcZmVsaXBlLm9saXZlaXJhXFxcXERlc2t0b3BcXFxcUFJKXFxcXE1BRE1jb21pc3Npb25hbWVudG9cXFxcZnJvbnRlbmRcXFxcdml0ZS5jb25maWcudHNcIjtjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfaW1wb3J0X21ldGFfdXJsID0gXCJmaWxlOi8vL0M6L1VzZXJzL2ZlbGlwZS5vbGl2ZWlyYS9EZXNrdG9wL1BSSi9NQURNY29taXNzaW9uYW1lbnRvL2Zyb250ZW5kL3ZpdGUuY29uZmlnLnRzXCI7aW1wb3J0IHsganN4TG9jUGx1Z2luIH0gZnJvbSBcIkBidWlsZGVyLmlvL3ZpdGUtcGx1Z2luLWpzeC1sb2NcIjtcclxuaW1wb3J0IHRhaWx3aW5kY3NzIGZyb20gXCJAdGFpbHdpbmRjc3Mvdml0ZVwiO1xyXG5pbXBvcnQgcmVhY3QgZnJvbSBcIkB2aXRlanMvcGx1Z2luLXJlYWN0XCI7XHJcbmltcG9ydCBmcyBmcm9tIFwibm9kZTpmc1wiO1xyXG5pbXBvcnQgcGF0aCBmcm9tIFwibm9kZTpwYXRoXCI7XHJcbmltcG9ydCB7IGRlZmluZUNvbmZpZywgdHlwZSBQbHVnaW4sIHR5cGUgVml0ZURldlNlcnZlciB9IGZyb20gXCJ2aXRlXCI7XHJcbmltcG9ydCB7IHZpdGVQbHVnaW5NYW51c1J1bnRpbWUgfSBmcm9tIFwidml0ZS1wbHVnaW4tbWFudXMtcnVudGltZVwiO1xyXG5cclxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cclxuLy8gTWFudXMgRGVidWcgQ29sbGVjdG9yIC0gVml0ZSBQbHVnaW5cclxuLy8gV3JpdGVzIGJyb3dzZXIgbG9ncyBkaXJlY3RseSB0byBmaWxlcywgdHJpbW1lZCB3aGVuIGV4Y2VlZGluZyBzaXplIGxpbWl0XHJcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XHJcblxyXG5jb25zdCBQUk9KRUNUX1JPT1QgPSBpbXBvcnQubWV0YS5kaXJuYW1lO1xyXG5jb25zdCBMT0dfRElSID0gcGF0aC5qb2luKFBST0pFQ1RfUk9PVCwgXCIubWFudXMtbG9nc1wiKTtcclxuY29uc3QgTUFYX0xPR19TSVpFX0JZVEVTID0gMSAqIDEwMjQgKiAxMDI0OyAvLyAxTUIgcGVyIGxvZyBmaWxlXHJcbmNvbnN0IFRSSU1fVEFSR0VUX0JZVEVTID0gTWF0aC5mbG9vcihNQVhfTE9HX1NJWkVfQllURVMgKiAwLjYpOyAvLyBUcmltIHRvIDYwJSB0byBhdm9pZCBjb25zdGFudCByZS10cmltbWluZ1xyXG5cclxudHlwZSBMb2dTb3VyY2UgPSBcImJyb3dzZXJDb25zb2xlXCIgfCBcIm5ldHdvcmtSZXF1ZXN0c1wiIHwgXCJzZXNzaW9uUmVwbGF5XCI7XHJcbiBcclxuZnVuY3Rpb24gZW5zdXJlTG9nRGlyKCkge1xyXG4gIGlmICghZnMuZXhpc3RzU3luYyhMT0dfRElSKSkge1xyXG4gICAgZnMubWtkaXJTeW5jKExPR19ESVIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xyXG4gIH1cclxufVxyXG5cclxuZnVuY3Rpb24gdHJpbUxvZ0ZpbGUobG9nUGF0aDogc3RyaW5nLCBtYXhTaXplOiBudW1iZXIpIHtcclxuICB0cnkge1xyXG4gICAgaWYgKCFmcy5leGlzdHNTeW5jKGxvZ1BhdGgpIHx8IGZzLnN0YXRTeW5jKGxvZ1BhdGgpLnNpemUgPD0gbWF4U2l6ZSkge1xyXG4gICAgICByZXR1cm47XHJcbiAgICB9XHJcblxyXG4gICAgY29uc3QgbGluZXMgPSBmcy5yZWFkRmlsZVN5bmMobG9nUGF0aCwgXCJ1dGYtOFwiKS5zcGxpdChcIlxcblwiKTtcclxuICAgIGNvbnN0IGtlcHRMaW5lczogc3RyaW5nW10gPSBbXTtcclxuICAgIGxldCBrZXB0Qnl0ZXMgPSAwO1xyXG5cclxuICAgIC8vIEtlZXAgbmV3ZXN0IGxpbmVzIChmcm9tIGVuZCkgdGhhdCBmaXQgd2l0aGluIDYwJSBvZiBtYXhTaXplXHJcbiAgICBjb25zdCB0YXJnZXRTaXplID0gVFJJTV9UQVJHRVRfQllURVM7XHJcbiAgICBmb3IgKGxldCBpID0gbGluZXMubGVuZ3RoIC0gMTsgaSA+PSAwOyBpLS0pIHtcclxuICAgICAgY29uc3QgbGluZUJ5dGVzID0gQnVmZmVyLmJ5dGVMZW5ndGgoYCR7bGluZXNbaV19XFxuYCwgXCJ1dGYtOFwiKTtcclxuICAgICAgaWYgKGtlcHRCeXRlcyArIGxpbmVCeXRlcyA+IHRhcmdldFNpemUpIGJyZWFrO1xyXG4gICAgICBrZXB0TGluZXMudW5zaGlmdChsaW5lc1tpXSk7XHJcbiAgICAgIGtlcHRCeXRlcyArPSBsaW5lQnl0ZXM7XHJcbiAgICB9XHJcblxyXG4gICAgZnMud3JpdGVGaWxlU3luYyhsb2dQYXRoLCBrZXB0TGluZXMuam9pbihcIlxcblwiKSwgXCJ1dGYtOFwiKTtcclxuICB9IGNhdGNoIHtcclxuICAgIC8qIGlnbm9yZSB0cmltIGVycm9ycyAqL1xyXG4gIH1cclxufVxyXG5cclxuZnVuY3Rpb24gd3JpdGVUb0xvZ0ZpbGUoc291cmNlOiBMb2dTb3VyY2UsIGVudHJpZXM6IHVua25vd25bXSkge1xyXG4gIGlmIChlbnRyaWVzLmxlbmd0aCA9PT0gMCkgcmV0dXJuO1xyXG5cclxuICBlbnN1cmVMb2dEaXIoKTtcclxuICBjb25zdCBsb2dQYXRoID0gcGF0aC5qb2luKExPR19ESVIsIGAke3NvdXJjZX0ubG9nYCk7XHJcblxyXG4gIC8vIEZvcm1hdCBlbnRyaWVzIHdpdGggdGltZXN0YW1wc1xyXG4gIGNvbnN0IGxpbmVzID0gZW50cmllcy5tYXAoKGVudHJ5KSA9PiB7XHJcbiAgICBjb25zdCB0cyA9IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKTtcclxuICAgIHJldHVybiBgWyR7dHN9XSAke0pTT04uc3RyaW5naWZ5KGVudHJ5KX1gO1xyXG4gIH0pO1xyXG5cclxuICAvLyBBcHBlbmQgdG8gbG9nIGZpbGVcclxuICBmcy5hcHBlbmRGaWxlU3luYyhsb2dQYXRoLCBgJHtsaW5lcy5qb2luKFwiXFxuXCIpfVxcbmAsIFwidXRmLThcIik7XHJcblxyXG4gIC8vIFRyaW0gaWYgZXhjZWVkcyBtYXggc2l6ZVxyXG4gIHRyaW1Mb2dGaWxlKGxvZ1BhdGgsIE1BWF9MT0dfU0laRV9CWVRFUyk7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBWaXRlIHBsdWdpbiB0byBjb2xsZWN0IGJyb3dzZXIgZGVidWcgbG9nc1xyXG4gKiAtIFBPU1QgL19fbWFudXNfXy9sb2dzOiBCcm93c2VyIHNlbmRzIGxvZ3MsIHdyaXR0ZW4gZGlyZWN0bHkgdG8gZmlsZXNcclxuICogLSBGaWxlczogYnJvd3NlckNvbnNvbGUubG9nLCBuZXR3b3JrUmVxdWVzdHMubG9nLCBzZXNzaW9uUmVwbGF5LmxvZ1xyXG4gKiAtIEF1dG8tdHJpbW1lZCB3aGVuIGV4Y2VlZGluZyAxTUIgKGtlZXBzIG5ld2VzdCBlbnRyaWVzKVxyXG4gKi9cclxuZnVuY3Rpb24gdml0ZVBsdWdpbk1hbnVzRGVidWdDb2xsZWN0b3IoKTogUGx1Z2luIHtcclxuICByZXR1cm4ge1xyXG4gICAgbmFtZTogXCJtYW51cy1kZWJ1Zy1jb2xsZWN0b3JcIixcclxuXHJcbiAgICB0cmFuc2Zvcm1JbmRleEh0bWwoaHRtbCkge1xyXG4gICAgICBpZiAocHJvY2Vzcy5lbnYuTk9ERV9FTlYgPT09IFwicHJvZHVjdGlvblwiKSB7XHJcbiAgICAgICAgcmV0dXJuIGh0bWw7XHJcbiAgICAgIH1cclxuICAgICAgcmV0dXJuIHtcclxuICAgICAgICBodG1sLFxyXG4gICAgICAgIHRhZ3M6IFtcclxuICAgICAgICAgIHtcclxuICAgICAgICAgICAgdGFnOiBcInNjcmlwdFwiLFxyXG4gICAgICAgICAgICBhdHRyczoge1xyXG4gICAgICAgICAgICAgIHNyYzogXCIvX19tYW51c19fL2RlYnVnLWNvbGxlY3Rvci5qc1wiLFxyXG4gICAgICAgICAgICAgIGRlZmVyOiB0cnVlLFxyXG4gICAgICAgICAgICB9LFxyXG4gICAgICAgICAgICBpbmplY3RUbzogXCJoZWFkXCIsXHJcbiAgICAgICAgICB9LFxyXG4gICAgICAgIF0sXHJcbiAgICAgIH07XHJcbiAgICB9LFxyXG5cclxuICAgIGNvbmZpZ3VyZVNlcnZlcihzZXJ2ZXI6IFZpdGVEZXZTZXJ2ZXIpIHtcclxuICAgICAgLy8gUE9TVCAvX19tYW51c19fL2xvZ3M6IEJyb3dzZXIgc2VuZHMgbG9ncyAod3JpdHRlbiBkaXJlY3RseSB0byBmaWxlcylcclxuICAgICAgc2VydmVyLm1pZGRsZXdhcmVzLnVzZShcIi9fX21hbnVzX18vbG9nc1wiLCAocmVxLCByZXMsIG5leHQpID0+IHtcclxuICAgICAgICBpZiAocmVxLm1ldGhvZCAhPT0gXCJQT1NUXCIpIHtcclxuICAgICAgICAgIHJldHVybiBuZXh0KCk7XHJcbiAgICAgICAgfVxyXG5cclxuICAgICAgICBjb25zdCBoYW5kbGVQYXlsb2FkID0gKHBheWxvYWQ6IGFueSkgPT4ge1xyXG4gICAgICAgICAgLy8gV3JpdGUgbG9ncyBkaXJlY3RseSB0byBmaWxlc1xyXG4gICAgICAgICAgaWYgKHBheWxvYWQuY29uc29sZUxvZ3M/Lmxlbmd0aCA+IDApIHtcclxuICAgICAgICAgICAgd3JpdGVUb0xvZ0ZpbGUoXCJicm93c2VyQ29uc29sZVwiLCBwYXlsb2FkLmNvbnNvbGVMb2dzKTtcclxuICAgICAgICAgIH1cclxuICAgICAgICAgIGlmIChwYXlsb2FkLm5ldHdvcmtSZXF1ZXN0cz8ubGVuZ3RoID4gMCkge1xyXG4gICAgICAgICAgICB3cml0ZVRvTG9nRmlsZShcIm5ldHdvcmtSZXF1ZXN0c1wiLCBwYXlsb2FkLm5ldHdvcmtSZXF1ZXN0cyk7XHJcbiAgICAgICAgICB9XHJcbiAgICAgICAgICBpZiAocGF5bG9hZC5zZXNzaW9uRXZlbnRzPy5sZW5ndGggPiAwKSB7XHJcbiAgICAgICAgICAgIHdyaXRlVG9Mb2dGaWxlKFwic2Vzc2lvblJlcGxheVwiLCBwYXlsb2FkLnNlc3Npb25FdmVudHMpO1xyXG4gICAgICAgICAgfVxyXG5cclxuICAgICAgICAgIHJlcy53cml0ZUhlYWQoMjAwLCB7IFwiQ29udGVudC1UeXBlXCI6IFwiYXBwbGljYXRpb24vanNvblwiIH0pO1xyXG4gICAgICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7IHN1Y2Nlc3M6IHRydWUgfSkpO1xyXG4gICAgICAgIH07XHJcblxyXG4gICAgICAgIGNvbnN0IHJlcUJvZHkgPSAocmVxIGFzIHsgYm9keT86IHVua25vd24gfSkuYm9keTtcclxuICAgICAgICBpZiAocmVxQm9keSAmJiB0eXBlb2YgcmVxQm9keSA9PT0gXCJvYmplY3RcIikge1xyXG4gICAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgaGFuZGxlUGF5bG9hZChyZXFCb2R5KTtcclxuICAgICAgICAgIH0gY2F0Y2ggKGUpIHtcclxuICAgICAgICAgICAgcmVzLndyaXRlSGVhZCg0MDAsIHsgXCJDb250ZW50LVR5cGVcIjogXCJhcHBsaWNhdGlvbi9qc29uXCIgfSk7XHJcbiAgICAgICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoeyBzdWNjZXNzOiBmYWxzZSwgZXJyb3I6IFN0cmluZyhlKSB9KSk7XHJcbiAgICAgICAgICB9XHJcbiAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG5cclxuICAgICAgICBsZXQgYm9keSA9IFwiXCI7XHJcbiAgICAgICAgcmVxLm9uKFwiZGF0YVwiLCAoY2h1bmspID0+IHtcclxuICAgICAgICAgIGJvZHkgKz0gY2h1bmsudG9TdHJpbmcoKTtcclxuICAgICAgICB9KTtcclxuXHJcbiAgICAgICAgcmVxLm9uKFwiZW5kXCIsICgpID0+IHtcclxuICAgICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgIGNvbnN0IHBheWxvYWQgPSBKU09OLnBhcnNlKGJvZHkpO1xyXG4gICAgICAgICAgICBoYW5kbGVQYXlsb2FkKHBheWxvYWQpO1xyXG4gICAgICAgICAgfSBjYXRjaCAoZSkge1xyXG4gICAgICAgICAgICByZXMud3JpdGVIZWFkKDQwMCwgeyBcIkNvbnRlbnQtVHlwZVwiOiBcImFwcGxpY2F0aW9uL2pzb25cIiB9KTtcclxuICAgICAgICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7IHN1Y2Nlc3M6IGZhbHNlLCBlcnJvcjogU3RyaW5nKGUpIH0pKTtcclxuICAgICAgICAgIH1cclxuICAgICAgICB9KTtcclxuICAgICAgfSk7XHJcbiAgICB9LFxyXG4gIH07XHJcbn1cclxuXHJcbmNvbnN0IHBsdWdpbnMgPSBbcmVhY3QoKSwgdGFpbHdpbmRjc3MoKSwganN4TG9jUGx1Z2luKCksIHZpdGVQbHVnaW5NYW51c1J1bnRpbWUoKSwgdml0ZVBsdWdpbk1hbnVzRGVidWdDb2xsZWN0b3IoKV07XHJcblxyXG5leHBvcnQgZGVmYXVsdCBkZWZpbmVDb25maWcoe1xyXG4gIHBsdWdpbnMsXHJcbiAgcmVzb2x2ZToge1xyXG4gICAgYWxpYXM6IHtcclxuICAgICAgXCJAXCI6IHBhdGgucmVzb2x2ZShpbXBvcnQubWV0YS5kaXJuYW1lLCBcImNsaWVudFwiLCBcInNyY1wiKSxcclxuICAgICAgXCJAc2hhcmVkXCI6IHBhdGgucmVzb2x2ZShpbXBvcnQubWV0YS5kaXJuYW1lLCBcInNoYXJlZFwiKSxcclxuICAgICAgXCJAYXNzZXRzXCI6IHBhdGgucmVzb2x2ZShpbXBvcnQubWV0YS5kaXJuYW1lLCBcImF0dGFjaGVkX2Fzc2V0c1wiKSxcclxuICAgIH0sXHJcbiAgfSxcclxuICBlbnZEaXI6IHBhdGgucmVzb2x2ZShpbXBvcnQubWV0YS5kaXJuYW1lKSxcclxuICByb290OiBwYXRoLnJlc29sdmUoaW1wb3J0Lm1ldGEuZGlybmFtZSwgXCJjbGllbnRcIiksXHJcbiAgYnVpbGQ6IHtcclxuICAgIG91dERpcjogcGF0aC5yZXNvbHZlKGltcG9ydC5tZXRhLmRpcm5hbWUsIFwiZGlzdC9wdWJsaWNcIiksXHJcbiAgICBlbXB0eU91dERpcjogdHJ1ZSxcclxuICB9LFxyXG4gIHNlcnZlcjoge1xyXG4gICAgcG9ydDogMzAwOCxcclxuICAgIHN0cmljdFBvcnQ6IGZhbHNlLCAvLyBXaWxsIGZpbmQgbmV4dCBhdmFpbGFibGUgcG9ydCBpZiAzMDA4IGlzIGJ1c3lcclxuICAgIGhvc3Q6IHRydWUsXHJcbiAgICBhbGxvd2VkSG9zdHM6IFtcclxuICAgICAgXCIubWFudXNwcmUuY29tcHV0ZXJcIixcclxuICAgICAgXCIubWFudXMuY29tcHV0ZXJcIixcclxuICAgICAgXCIubWFudXMtYXNpYS5jb21wdXRlclwiLFxyXG4gICAgICBcIi5tYW51c2NvbXB1dGVyLmFpXCIsXHJcbiAgICAgIFwiLm1hbnVzdm0uY29tcHV0ZXJcIixcclxuICAgICAgXCJsb2NhbGhvc3RcIixcclxuICAgICAgXCIxMjcuMC4wLjFcIixcclxuICAgIF0sXHJcbiAgICBmczoge1xyXG4gICAgICBzdHJpY3Q6IHRydWUsXHJcbiAgICAgIGRlbnk6IFtcIioqLy4qXCJdLFxyXG4gICAgfSxcclxuICB9LFxyXG59KTtcclxuIl0sCiAgIm1hcHBpbmdzIjogIjtBQUFtWSxTQUFTLG9CQUFvQjtBQUNoYSxPQUFPLGlCQUFpQjtBQUN4QixPQUFPLFdBQVc7QUFDbEIsT0FBTyxRQUFRO0FBQ2YsT0FBTyxVQUFVO0FBQ2pCLFNBQVMsb0JBQXFEO0FBQzlELFNBQVMsOEJBQThCO0FBTnZDLElBQU0sbUNBQW1DO0FBYXpDLElBQU0sZUFBZTtBQUNyQixJQUFNLFVBQVUsS0FBSyxLQUFLLGNBQWMsYUFBYTtBQUNyRCxJQUFNLHFCQUFxQixJQUFJLE9BQU87QUFDdEMs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
