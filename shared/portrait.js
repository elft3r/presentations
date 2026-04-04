/**
 * Portrait / mobile mode support for Reveal.js presentations.
 *
 * Toggles a `.portrait` CSS class on `.reveal` and configures the
 * Reveal.js canvas to 540×960 (portrait) or 960×700 (landscape).
 *
 * Activate explicitly via ?mobile query parameter or automatically
 * when the device orientation is portrait.
 */

/* exported portraitSetup */
// eslint-disable-next-line no-unused-vars
function portraitSetup() {
  var portraitQuery = window.matchMedia("(orientation: portrait)");
  var forcePortrait =
    new URLSearchParams(window.location.search).has("mobile");

  function isPortrait() {
    return forcePortrait || portraitQuery.matches;
  }

  var revealEl = document.querySelector(".reveal");
  var portrait = isPortrait();
  if (portrait) revealEl.classList.add("portrait");

  portraitQuery.addEventListener("change", function () {
    portrait = isPortrait();
    revealEl.classList.toggle("portrait", portrait);
    Reveal.configure({
      width: portrait ? 540 : 960,
      height: portrait ? 960 : 700,
    });
    Reveal.layout();
  });

  return { width: portrait ? 540 : 960, height: portrait ? 960 : 700 };
}
