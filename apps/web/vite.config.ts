import { defineConfig, type Plugin } from "vite";

/** Dev-only: pages POST their render diagnostics here and they land in
 *  the dev server's stdout — the only window into browsers whose console
 *  isn't open (a blank canvas on someone else's Safari). */
const diagEndpoint = (): Plugin => ({
  name: "orim-diag",
  configureServer(server) {
    server.middlewares.use("/__diag", (req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        console.log(`[diag] ${body.slice(0, 2000)}`);
        res.statusCode = 204;
        res.end();
      });
    });
  },
});

export default defineConfig({
  // Bind IPv4 and IPv6: default binding was [::1] only, and browsers
  // that resolve localhost to 127.0.0.1 saw "server not up".
  server: { host: true },
  plugins: [diagEndpoint()],
});
