// The app has one web view, and Android's web view does not open new tabs. Yardbell's pages fall
// back to the same tab when window.open gives them nothing, and links meant for a new tab open in
// place; the back gesture returns.
(function () {
  if (window.__yardbellSingleView) return;
  window.__yardbellSingleView = true;
  window.open = function (url) {
    if (url && url !== "about:blank") location.href = new URL(url, location.href).href;
    return null;
  };
  document.addEventListener("click", function (e) {
    var link = e.target.closest && e.target.closest('a[target="_blank"]');
    if (!link || !link.href) return;
    e.preventDefault();
    location.href = link.href;
  }, true);
})();
