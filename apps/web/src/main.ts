/**
 * Bootstrap: a URL with ?b= is a board (the editor); without one it's
 * the start page (board gallery + templates).
 */
if (new URLSearchParams(location.search).get("b")) {
  void import("./board-app");
} else {
  void import("./start-page").then((m) => m.renderStartPage());
}
