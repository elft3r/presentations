// Single source of truth for the deck list. Required by both
// scripts/build.js (which copies reveal.js + theme assets into each
// deck) and scripts/check-render.js (which iterates them at audit
// time). Add a new presentation here once and it's picked up
// everywhere.

const PRESENTATIONS = ['cloud-migrations', 'secure-landing-zones', 'docker-training'];

module.exports = { PRESENTATIONS };
