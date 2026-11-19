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
var plugins = [
  react(),
  tailwindcss(),
  jsxLocPlugin(),
  vitePluginManusRuntime(),
  vitePluginManusDebugCollector()
];
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
    // ===== PROXY – redireciona /api para o backend =====
    proxy: {
      "/api": {
        target: "http://localhost:3007",
        changeOrigin: true,
        secure: false,
        // ═══ NOVO ═══
        // Necessário para SSE (/api/notificacoes/stream) e WebSocket.
        // Sem `ws: true`, o EventSource conecta mas nunca recebe `data:`.
        ws: true,
        // Timeout generoso — SSE mantém a conexão aberta indefinidamente.
        // O default do http-proxy é 0 (infinito), mas explicitar deixa claro.
        timeout: 0,
        proxyTimeout: 0,
        // ═══ NOVO ═══
        // Suprime o spam de `ECONNREFUSED` durante o boot do backend.
        // Nenhum outro erro é silenciado.
        configure: (proxy) => {
          proxy.on("error", (err, _req, res) => {
            const code = err.code;
            if (code === "ECONNREFUSED") {
              if (res && "writeHead" in res && !res.headersSent) {
                res.writeHead(503, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ success: false, error: "Backend indispon\xEDvel" }));
              }
              return;
            }
            console.error("[vite-proxy]", err.message);
          });
          proxy.on("proxyRes", (proxyRes, req) => {
            const url = req.url || "";
            const isSSE = url.includes("/notificacoes/stream") || url.includes("/stream") || (proxyRes.headers["content-type"] || "").includes("text/event-stream");
            if (isSSE) {
              proxyRes.headers["cache-control"] = "no-cache, no-transform";
              proxyRes.headers["x-accel-buffering"] = "no";
              proxyRes.headers["connection"] = "keep-alive";
              delete proxyRes.headers["content-length"];
            }
          });
        }
        // ═══════════
      }
    }
  }
});
export {
  vite_config_default as default
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsidml0ZS5jb25maWcudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImNvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9kaXJuYW1lID0gXCJDOlxcXFxVc2Vyc1xcXFxmZWxpcGUub2xpdmVpcmFcXFxcRGVza3RvcFxcXFxQUkpcXFxcTUFETWNvbWlzc2lvbmFtZW50b1xcXFxmcm9udGVuZFwiO2NvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9maWxlbmFtZSA9IFwiQzpcXFxcVXNlcnNcXFxcZmVsaXBlLm9saXZlaXJhXFxcXERlc2t0b3BcXFxcUFJKXFxcXE1BRE1jb21pc3Npb25hbWVudG9cXFxcZnJvbnRlbmRcXFxcdml0ZS5jb25maWcudHNcIjtjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfaW1wb3J0X21ldGFfdXJsID0gXCJmaWxlOi8vL0M6L1VzZXJzL2ZlbGlwZS5vbGl2ZWlyYS9EZXNrdG9wL1BSSi9NQURNY29taXNzaW9uYW1lbnRvL2Zyb250ZW5kL3ZpdGUuY29uZmlnLnRzXCI7aW1wb3J0IHsganN4TG9jUGx1Z2luIH0gZnJvbSBcIkBidWlsZGVyLmlvL3ZpdGUtcGx1Z2luLWpzeC1sb2NcIjtcclxuaW1wb3J0IHRhaWx3aW5kY3NzIGZyb20gXCJAdGFpbHdpbmRjc3Mvdml0ZVwiO1xyXG5pbXBvcnQgcmVhY3QgZnJvbSBcIkB2aXRlanMvcGx1Z2luLXJlYWN0XCI7XHJcbmltcG9ydCBmcyBmcm9tIFwibm9kZTpmc1wiO1xyXG5pbXBvcnQgcGF0aCBmcm9tIFwibm9kZTpwYXRoXCI7XHJcbmltcG9ydCB7IGRlZmluZUNvbmZpZywgdHlwZSBQbHVnaW4sIHR5cGUgVml0ZURldlNlcnZlciB9IGZyb20gXCJ2aXRlXCI7XHJcbmltcG9ydCB7IHZpdGVQbHVnaW5NYW51c1J1bnRpbWUgfSBmcm9tIFwidml0ZS1wbHVnaW4tbWFudXMtcnVudGltZVwiO1xyXG5cclxuLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cclxuLy8gTWFudXMgRGVidWcgQ29sbGVjdG9yIC0gVml0ZSBQbHVnaW5cclxuLy8gV3JpdGVzIGJyb3dzZXIgbG9ncyBkaXJlY3RseSB0byBmaWxlcywgdHJpbW1lZCB3aGVuIGV4Y2VlZGluZyBzaXplIGxpbWl0XHJcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XHJcblxyXG5jb25zdCBQUk9KRUNUX1JPT1QgPSBpbXBvcnQubWV0YS5kaXJuYW1lO1xyXG5jb25zdCBMT0dfRElSID0gcGF0aC5qb2luKFBST0pFQ1RfUk9PVCwgXCIubWFudXMtbG9nc1wiKTtcclxuY29uc3QgTUFYX0xPR19TSVpFX0JZVEVTID0gMSAqIDEwMjQgKiAxMDI0OyAvLyAxTUIgcGVyIGxvZyBmaWxlXHJcbmNvbnN0IFRSSU1fVEFSR0VUX0JZVEVTID0gTWF0aC5mbG9vcihNQVhfTE9HX1NJWkVfQllURVMgKiAwLjYpOyAvLyBUcmltIHRvIDYwJSB0byBhdm9pZCBjb25zdGFudCByZS10cmltbWluZ1xyXG5cclxudHlwZSBMb2dTb3VyY2UgPSBcImJyb3dzZXJDb25zb2xlXCIgfCBcIm5ldHdvcmtSZXF1ZXN0c1wiIHwgXCJzZXNzaW9uUmVwbGF5XCI7XHJcblxyXG5mdW5jdGlvbiBlbnN1cmVMb2dEaXIoKSB7XHJcbiAgaWYgKCFmcy5leGlzdHNTeW5jKExPR19ESVIpKSB7XHJcbiAgICBmcy5ta2RpclN5bmMoTE9HX0RJUiwgeyByZWN1cnNpdmU6IHRydWUgfSk7XHJcbiAgfVxyXG59XHJcblxyXG5mdW5jdGlvbiB0cmltTG9nRmlsZShsb2dQYXRoOiBzdHJpbmcsIG1heFNpemU6IG51bWJlcikge1xyXG4gIHRyeSB7XHJcbiAgICBpZiAoIWZzLmV4aXN0c1N5bmMobG9nUGF0aCkgfHwgZnMuc3RhdFN5bmMobG9nUGF0aCkuc2l6ZSA8PSBtYXhTaXplKSB7XHJcbiAgICAgIHJldHVybjtcclxuICAgIH1cclxuXHJcbiAgICBjb25zdCBsaW5lcyA9IGZzLnJlYWRGaWxlU3luYyhsb2dQYXRoLCBcInV0Zi04XCIpLnNwbGl0KFwiXFxuXCIpO1xyXG4gICAgY29uc3Qga2VwdExpbmVzOiBzdHJpbmdbXSA9IFtdO1xyXG4gICAgbGV0IGtlcHRCeXRlcyA9IDA7XHJcblxyXG4gICAgY29uc3QgdGFyZ2V0U2l6ZSA9IFRSSU1fVEFSR0VUX0JZVEVTO1xyXG4gICAgZm9yIChsZXQgaSA9IGxpbmVzLmxlbmd0aCAtIDE7IGkgPj0gMDsgaS0tKSB7XHJcbiAgICAgIGNvbnN0IGxpbmVCeXRlcyA9IEJ1ZmZlci5ieXRlTGVuZ3RoKGAke2xpbmVzW2ldfVxcbmAsIFwidXRmLThcIik7XHJcbiAgICAgIGlmIChrZXB0Qnl0ZXMgKyBsaW5lQnl0ZXMgPiB0YXJnZXRTaXplKSBicmVhaztcclxuICAgICAga2VwdExpbmVzLnVuc2hpZnQobGluZXNbaV0pO1xyXG4gICAgICBrZXB0Qnl0ZXMgKz0gbGluZUJ5dGVzO1xyXG4gICAgfVxyXG5cclxuICAgIGZzLndyaXRlRmlsZVN5bmMobG9nUGF0aCwga2VwdExpbmVzLmpvaW4oXCJcXG5cIiksIFwidXRmLThcIik7XHJcbiAgfSBjYXRjaCB7XHJcbiAgICAvKiBpZ25vcmUgdHJpbSBlcnJvcnMgKi9cclxuICB9XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHdyaXRlVG9Mb2dGaWxlKHNvdXJjZTogTG9nU291cmNlLCBlbnRyaWVzOiB1bmtub3duW10pIHtcclxuICBpZiAoZW50cmllcy5sZW5ndGggPT09IDApIHJldHVybjtcclxuXHJcbiAgZW5zdXJlTG9nRGlyKCk7XHJcbiAgY29uc3QgbG9nUGF0aCA9IHBhdGguam9pbihMT0dfRElSLCBgJHtzb3VyY2V9LmxvZ2ApO1xyXG5cclxuICBjb25zdCBsaW5lcyA9IGVudHJpZXMubWFwKChlbnRyeSkgPT4ge1xyXG4gICAgY29uc3QgdHMgPSBuZXcgRGF0ZSgpLnRvSVNPU3RyaW5nKCk7XHJcbiAgICByZXR1cm4gYFske3RzfV0gJHtKU09OLnN0cmluZ2lmeShlbnRyeSl9YDtcclxuICB9KTtcclxuXHJcbiAgZnMuYXBwZW5kRmlsZVN5bmMobG9nUGF0aCwgYCR7bGluZXMuam9pbihcIlxcblwiKX1cXG5gLCBcInV0Zi04XCIpO1xyXG4gIHRyaW1Mb2dGaWxlKGxvZ1BhdGgsIE1BWF9MT0dfU0laRV9CWVRFUyk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHZpdGVQbHVnaW5NYW51c0RlYnVnQ29sbGVjdG9yKCk6IFBsdWdpbiB7XHJcbiAgcmV0dXJuIHtcclxuICAgIG5hbWU6IFwibWFudXMtZGVidWctY29sbGVjdG9yXCIsXHJcblxyXG4gICAgdHJhbnNmb3JtSW5kZXhIdG1sKGh0bWwpIHtcclxuICAgICAgaWYgKHByb2Nlc3MuZW52Lk5PREVfRU5WID09PSBcInByb2R1Y3Rpb25cIikge1xyXG4gICAgICAgIHJldHVybiBodG1sO1xyXG4gICAgICB9XHJcbiAgICAgIHJldHVybiB7XHJcbiAgICAgICAgaHRtbCxcclxuICAgICAgICB0YWdzOiBbXHJcbiAgICAgICAgICB7XHJcbiAgICAgICAgICAgIHRhZzogXCJzY3JpcHRcIixcclxuICAgICAgICAgICAgYXR0cnM6IHtcclxuICAgICAgICAgICAgICBzcmM6IFwiL19fbWFudXNfXy9kZWJ1Zy1jb2xsZWN0b3IuanNcIixcclxuICAgICAgICAgICAgICBkZWZlcjogdHJ1ZSxcclxuICAgICAgICAgICAgfSxcclxuICAgICAgICAgICAgaW5qZWN0VG86IFwiaGVhZFwiLFxyXG4gICAgICAgICAgfSxcclxuICAgICAgICBdLFxyXG4gICAgICB9O1xyXG4gICAgfSxcclxuXHJcbiAgICBjb25maWd1cmVTZXJ2ZXIoc2VydmVyOiBWaXRlRGV2U2VydmVyKSB7XHJcbiAgICAgIHNlcnZlci5taWRkbGV3YXJlcy51c2UoXCIvX19tYW51c19fL2xvZ3NcIiwgKHJlcSwgcmVzLCBuZXh0KSA9PiB7XHJcbiAgICAgICAgaWYgKHJlcS5tZXRob2QgIT09IFwiUE9TVFwiKSB7XHJcbiAgICAgICAgICByZXR1cm4gbmV4dCgpO1xyXG4gICAgICAgIH1cclxuXHJcbiAgICAgICAgY29uc3QgaGFuZGxlUGF5bG9hZCA9IChwYXlsb2FkOiBhbnkpID0+IHtcclxuICAgICAgICAgIGlmIChwYXlsb2FkLmNvbnNvbGVMb2dzPy5sZW5ndGggPiAwKSB7XHJcbiAgICAgICAgICAgIHdyaXRlVG9Mb2dGaWxlKFwiYnJvd3NlckNvbnNvbGVcIiwgcGF5bG9hZC5jb25zb2xlTG9ncyk7XHJcbiAgICAgICAgICB9XHJcbiAgICAgICAgICBpZiAocGF5bG9hZC5uZXR3b3JrUmVxdWVzdHM/Lmxlbmd0aCA+IDApIHtcclxuICAgICAgICAgICAgd3JpdGVUb0xvZ0ZpbGUoXCJuZXR3b3JrUmVxdWVzdHNcIiwgcGF5bG9hZC5uZXR3b3JrUmVxdWVzdHMpO1xyXG4gICAgICAgICAgfVxyXG4gICAgICAgICAgaWYgKHBheWxvYWQuc2Vzc2lvbkV2ZW50cz8ubGVuZ3RoID4gMCkge1xyXG4gICAgICAgICAgICB3cml0ZVRvTG9nRmlsZShcInNlc3Npb25SZXBsYXlcIiwgcGF5bG9hZC5zZXNzaW9uRXZlbnRzKTtcclxuICAgICAgICAgIH1cclxuXHJcbiAgICAgICAgICByZXMud3JpdGVIZWFkKDIwMCwgeyBcIkNvbnRlbnQtVHlwZVwiOiBcImFwcGxpY2F0aW9uL2pzb25cIiB9KTtcclxuICAgICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoeyBzdWNjZXNzOiB0cnVlIH0pKTtcclxuICAgICAgICB9O1xyXG5cclxuICAgICAgICBjb25zdCByZXFCb2R5ID0gKHJlcSBhcyB7IGJvZHk/OiB1bmtub3duIH0pLmJvZHk7XHJcbiAgICAgICAgaWYgKHJlcUJvZHkgJiYgdHlwZW9mIHJlcUJvZHkgPT09IFwib2JqZWN0XCIpIHtcclxuICAgICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgIGhhbmRsZVBheWxvYWQocmVxQm9keSk7XHJcbiAgICAgICAgICB9IGNhdGNoIChlKSB7XHJcbiAgICAgICAgICAgIHJlcy53cml0ZUhlYWQoNDAwLCB7IFwiQ29udGVudC1UeXBlXCI6IFwiYXBwbGljYXRpb24vanNvblwiIH0pO1xyXG4gICAgICAgICAgICByZXMuZW5kKEpTT04uc3RyaW5naWZ5KHsgc3VjY2VzczogZmFsc2UsIGVycm9yOiBTdHJpbmcoZSkgfSkpO1xyXG4gICAgICAgICAgfVxyXG4gICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuXHJcbiAgICAgICAgbGV0IGJvZHkgPSBcIlwiO1xyXG4gICAgICAgIHJlcS5vbihcImRhdGFcIiwgKGNodW5rKSA9PiB7XHJcbiAgICAgICAgICBib2R5ICs9IGNodW5rLnRvU3RyaW5nKCk7XHJcbiAgICAgICAgfSk7XHJcblxyXG4gICAgICAgIHJlcS5vbihcImVuZFwiLCAoKSA9PiB7XHJcbiAgICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICBjb25zdCBwYXlsb2FkID0gSlNPTi5wYXJzZShib2R5KTtcclxuICAgICAgICAgICAgaGFuZGxlUGF5bG9hZChwYXlsb2FkKTtcclxuICAgICAgICAgIH0gY2F0Y2ggKGUpIHtcclxuICAgICAgICAgICAgcmVzLndyaXRlSGVhZCg0MDAsIHsgXCJDb250ZW50LVR5cGVcIjogXCJhcHBsaWNhdGlvbi9qc29uXCIgfSk7XHJcbiAgICAgICAgICAgIHJlcy5lbmQoSlNPTi5zdHJpbmdpZnkoeyBzdWNjZXNzOiBmYWxzZSwgZXJyb3I6IFN0cmluZyhlKSB9KSk7XHJcbiAgICAgICAgICB9XHJcbiAgICAgICAgfSk7XHJcbiAgICAgIH0pO1xyXG4gICAgfSxcclxuICB9O1xyXG59XHJcblxyXG5jb25zdCBwbHVnaW5zID0gW1xyXG4gIHJlYWN0KCksXHJcbiAgdGFpbHdpbmRjc3MoKSxcclxuICBqc3hMb2NQbHVnaW4oKSxcclxuICB2aXRlUGx1Z2luTWFudXNSdW50aW1lKCksXHJcbiAgdml0ZVBsdWdpbk1hbnVzRGVidWdDb2xsZWN0b3IoKSxcclxuXTtcclxuXHJcbmV4cG9ydCBkZWZhdWx0IGRlZmluZUNvbmZpZyh7XHJcbiAgcGx1Z2lucyxcclxuICByZXNvbHZlOiB7XHJcbiAgICBhbGlhczoge1xyXG4gICAgICBcIkBcIjogcGF0aC5yZXNvbHZlKGltcG9ydC5tZXRhLmRpcm5hbWUsIFwiY2xpZW50XCIsIFwic3JjXCIpLFxyXG4gICAgICBcIkBzaGFyZWRcIjogcGF0aC5yZXNvbHZlKGltcG9ydC5tZXRhLmRpcm5hbWUsIFwic2hhcmVkXCIpLFxyXG4gICAgICBcIkBhc3NldHNcIjogcGF0aC5yZXNvbHZlKGltcG9ydC5tZXRhLmRpcm5hbWUsIFwiYXR0YWNoZWRfYXNzZXRzXCIpLFxyXG4gICAgfSxcclxuICB9LFxyXG4gIGVudkRpcjogcGF0aC5yZXNvbHZlKGltcG9ydC5tZXRhLmRpcm5hbWUpLFxyXG4gIHJvb3Q6IHBhdGgucmVzb2x2ZShpbXBvcnQubWV0YS5kaXJuYW1lLCBcImNsaWVudFwiKSxcclxuICBidWlsZDoge1xyXG4gICAgb3V0RGlyOiBwYXRoLnJlc29sdmUoaW1wb3J0Lm1ldGEuZGlybmFtZSwgXCJkaXN0L3B1YmxpY1wiKSxcclxuICAgIGVtcHR5T3V0RGlyOiB0cnVlLFxyXG4gIH0sXHJcbiAgc2VydmVyOiB7XHJcbiAgICBwb3J0OiAzMDA4LFxyXG5cclxuICAgIC8vID09PT09IFBST1hZIFx1MjAxMyByZWRpcmVjaW9uYSAvYXBpIHBhcmEgbyBiYWNrZW5kID09PT09XHJcbiAgICBwcm94eToge1xyXG4gICAgICBcIi9hcGlcIjoge1xyXG4gICAgICAgIHRhcmdldDogXCJodHRwOi8vbG9jYWxob3N0OjMwMDdcIixcclxuICAgICAgICBjaGFuZ2VPcmlnaW46IHRydWUsXHJcbiAgICAgICAgc2VjdXJlOiBmYWxzZSxcclxuXHJcbiAgICAgICAgLy8gXHUyNTUwXHUyNTUwXHUyNTUwIE5PVk8gXHUyNTUwXHUyNTUwXHUyNTUwXHJcbiAgICAgICAgLy8gTmVjZXNzXHUwMEUxcmlvIHBhcmEgU1NFICgvYXBpL25vdGlmaWNhY29lcy9zdHJlYW0pIGUgV2ViU29ja2V0LlxyXG4gICAgICAgIC8vIFNlbSBgd3M6IHRydWVgLCBvIEV2ZW50U291cmNlIGNvbmVjdGEgbWFzIG51bmNhIHJlY2ViZSBgZGF0YTpgLlxyXG4gICAgICAgIHdzOiB0cnVlLFxyXG5cclxuICAgICAgICAvLyBUaW1lb3V0IGdlbmVyb3NvIFx1MjAxNCBTU0UgbWFudFx1MDBFOW0gYSBjb25leFx1MDBFM28gYWJlcnRhIGluZGVmaW5pZGFtZW50ZS5cclxuICAgICAgICAvLyBPIGRlZmF1bHQgZG8gaHR0cC1wcm94eSBcdTAwRTkgMCAoaW5maW5pdG8pLCBtYXMgZXhwbGljaXRhciBkZWl4YSBjbGFyby5cclxuICAgICAgICB0aW1lb3V0OiAwLFxyXG4gICAgICAgIHByb3h5VGltZW91dDogMCxcclxuXHJcbiAgICAgICAgLy8gXHUyNTUwXHUyNTUwXHUyNTUwIE5PVk8gXHUyNTUwXHUyNTUwXHUyNTUwXHJcbiAgICAgICAgLy8gU3VwcmltZSBvIHNwYW0gZGUgYEVDT05OUkVGVVNFRGAgZHVyYW50ZSBvIGJvb3QgZG8gYmFja2VuZC5cclxuICAgICAgICAvLyBOZW5odW0gb3V0cm8gZXJybyBcdTAwRTkgc2lsZW5jaWFkby5cclxuICAgICAgICBjb25maWd1cmU6IChwcm94eSkgPT4ge1xyXG4gICAgICAgICAgcHJveHkub24oXCJlcnJvclwiLCAoZXJyLCBfcmVxLCByZXMpID0+IHtcclxuICAgICAgICAgICAgY29uc3QgY29kZSA9IChlcnIgYXMgTm9kZUpTLkVycm5vRXhjZXB0aW9uKS5jb2RlO1xyXG4gICAgICAgICAgICBpZiAoY29kZSA9PT0gXCJFQ09OTlJFRlVTRURcIikge1xyXG4gICAgICAgICAgICAgIC8vIEJhY2tlbmQgYWluZGEgc3ViaW5kbyBcdTIwMTQgc2lsZW5jaW9zby5cclxuICAgICAgICAgICAgICBpZiAocmVzICYmIFwid3JpdGVIZWFkXCIgaW4gcmVzICYmICFyZXMuaGVhZGVyc1NlbnQpIHtcclxuICAgICAgICAgICAgICAgIHJlcy53cml0ZUhlYWQoNTAzLCB7IFwiQ29udGVudC1UeXBlXCI6IFwiYXBwbGljYXRpb24vanNvblwiIH0pO1xyXG4gICAgICAgICAgICAgICAgcmVzLmVuZChKU09OLnN0cmluZ2lmeSh7IHN1Y2Nlc3M6IGZhbHNlLCBlcnJvcjogXCJCYWNrZW5kIGluZGlzcG9uXHUwMEVEdmVsXCIgfSkpO1xyXG4gICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgY29uc29sZS5lcnJvcihcIlt2aXRlLXByb3h5XVwiLCBlcnIubWVzc2FnZSk7XHJcbiAgICAgICAgICB9KTtcclxuXHJcbiAgICAgICAgICAvLyBcdTI1NTBcdTI1NTBcdTI1NTAgTk9WTyBcdTI1NTBcdTI1NTBcdTI1NTBcclxuICAgICAgICAgIC8vIERlc2FiaWxpdGEgbyBidWZmZXJpbmcgZG8gcHJveHkgQVBFTkFTIHBhcmEgU1NFLlxyXG4gICAgICAgICAgLy8gU2VtIGlzc28sIGEgcmVzcG9zdGEgZG8gYmFja2VuZCBmaWNhIHByZXNhIG5vIGJ1ZmZlciBkbyBWaXRlXHJcbiAgICAgICAgICAvLyBlIG8gYnJvd3NlciBudW5jYSB2XHUwMEVBIG9zIGV2ZW50b3MgY2hlZ2FuZG8uXHJcbiAgICAgICAgICBwcm94eS5vbihcInByb3h5UmVzXCIsIChwcm94eVJlcywgcmVxKSA9PiB7XHJcbiAgICAgICAgICAgIGNvbnN0IHVybCA9IChyZXEgYXMgYW55KS51cmwgfHwgXCJcIjtcclxuICAgICAgICAgICAgY29uc3QgaXNTU0UgPVxyXG4gICAgICAgICAgICAgIHVybC5pbmNsdWRlcyhcIi9ub3RpZmljYWNvZXMvc3RyZWFtXCIpIHx8XHJcbiAgICAgICAgICAgICAgdXJsLmluY2x1ZGVzKFwiL3N0cmVhbVwiKSB8fFxyXG4gICAgICAgICAgICAgIChwcm94eVJlcy5oZWFkZXJzW1wiY29udGVudC10eXBlXCJdIHx8IFwiXCIpLmluY2x1ZGVzKFwidGV4dC9ldmVudC1zdHJlYW1cIik7XHJcblxyXG4gICAgICAgICAgICBpZiAoaXNTU0UpIHtcclxuICAgICAgICAgICAgICAvLyBHYXJhbnRlIGhlYWRlcnMgY29ycmV0b3NcclxuICAgICAgICAgICAgICBwcm94eVJlcy5oZWFkZXJzW1wiY2FjaGUtY29udHJvbFwiXSA9IFwibm8tY2FjaGUsIG5vLXRyYW5zZm9ybVwiO1xyXG4gICAgICAgICAgICAgIHByb3h5UmVzLmhlYWRlcnNbXCJ4LWFjY2VsLWJ1ZmZlcmluZ1wiXSA9IFwibm9cIjtcclxuICAgICAgICAgICAgICBwcm94eVJlcy5oZWFkZXJzW1wiY29ubmVjdGlvblwiXSA9IFwia2VlcC1hbGl2ZVwiO1xyXG4gICAgICAgICAgICAgIC8vIFJlbW92ZSBjb250ZW50LWxlbmd0aCAoU1NFIFx1MDBFOSBjaHVua2VkL3N0cmVhbWluZylcclxuICAgICAgICAgICAgICBkZWxldGUgcHJveHlSZXMuaGVhZGVyc1tcImNvbnRlbnQtbGVuZ3RoXCJdO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICB9KTtcclxuICAgICAgICB9LFxyXG4gICAgICAgIC8vIFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFx1MjU1MFxyXG4gICAgICB9LFxyXG4gICAgfSxcclxuICB9LFxyXG59KTsiXSwKICAibWFwcGluZ3MiOiAiO0FBQW1ZLFNBQVMsb0JBQW9CO0FBQ2hhLE9BQU8saUJBQWlCO0FBQ3hCLE9BQU8sV0FBVztBQUNsQixPQUFPLFFBQVE7QUFDZixPQUFPLFVBQVU7QUFDakIsU0FBUyxvQkFBcUQ7QUFDOUQsU0FBUyw4QkFBOEI7QUFOdkMsSUFBTSxtQ0FBbUM7QUFhekMsSUFBTSxlQUFlO0FBQ3JCLElBQU0sVUFBVSxLQUFLLEtBQUssY0FBYyxhQUFhO0FBQ3JELElBQU0scUJBQXFCLElBQUksT0FBTztBQUN0QyxJQUFNLG9CQUFvQixLQUFLLE1BQU0scUJBQXFCLEdBQUc7QUFJN0Qs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
