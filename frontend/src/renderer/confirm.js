"use strict";

// The confirmation window's page: one request, one answer. The safe answer has
// the focus, as in the system dialog this window replaces; Escape is "no".

(function confirmPage() {
  const $ = (id) => document.getElementById(id);
  document.documentElement.lang = currentLanguage();

  window.atlasConfirm.onRequest((request) => {
    $("title").textContent = request.title || tx("Confirmation");
    $("message").textContent = request.message || "";
    $("detail").textContent = request.detail || "";
    $("detail").hidden = !request.detail;
    $("accept").textContent = request.confirmLabel || tx("Confirm");
    $("cancel").textContent = request.cancelLabel || tx("Cancel");
    document.title = request.title || tx("Confirmation");
    // Window height = card height plus the window border (one pixel at the top and bottom).
    const needed = () => Math.ceil($("card").getBoundingClientRect().height) + 2;
    requestAnimationFrame(() => {
      let reported = needed();
      window.atlasConfirm.ready(reported);
      $("cancel").focus();
      // If the window came out at another width, the text wraps differently: the window
      // is fitted to the new height until that height stops changing.
      new ResizeObserver(() => {
        const height = needed();
        if (height !== reported) {
          reported = height;
          window.atlasConfirm.resize(height);
        }
      }).observe($("card"));
    });
  });

  $("accept").addEventListener("click", () => window.atlasConfirm.answer(true));
  $("cancel").addEventListener("click", () => window.atlasConfirm.answer(false));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") window.atlasConfirm.answer(false);
  });
}());
