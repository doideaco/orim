/**
 * Bootstrap: a URL with ?b= is a board (the editor); without one it's
 * the start page (board gallery + templates).
 */
// SSO callback lands with a token in the hash: store it and clean up.
const ssoMatch = /[#&]sso=([0-9a-f]+)&user=([^&]+)/.exec(location.hash);
if (ssoMatch) {
  try {
    localStorage.setItem("orim-token", ssoMatch[1]!);
    localStorage.setItem("orim-user", decodeURIComponent(ssoMatch[2]!));
  } catch { /* private mode */ }
  history.replaceState(null, "", location.pathname + location.search);
}

if (new URLSearchParams(location.search).get("b")) {
  void import("./board-app");
} else {
  void import("./start-page").then((m) => m.renderStartPage());
}
