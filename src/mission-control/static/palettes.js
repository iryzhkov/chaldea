// Palette tokens. A direction is a style; a palette is colour only. Any direction takes any palette.
// Status colours (ok/warn/fail) in every palette clear the dataviz validator's CVD separation check
// against each other (worst pair >= 7.9 OKLab dE deutan; green-phosphor warn/ok sits in the 6-8 band
// and relies on the glyph + label that every status mark always carries).
const PALETTES = {
  'green-phosphor': { label:'Green phosphor', bg:'#020804', primary:'#4dff7c', secondary:'#2bb857', accent:'#d6ffb0', ok:'#2ee57a', warn:'#ffb01f', fail:'#ff5c8a', stale:'#6f7f55', dim:'#163a22', glow:1 },
  'amber-phosphor': { label:'Amber phosphor', bg:'#0a0500', primary:'#ffb000', secondary:'#b36f00', accent:'#ffe16a', ok:'#ffd56a', warn:'#ff8c1a', fail:'#ff3b5c', stale:'#7a5a2a', dim:'#2a1800', glow:1 },
  'hud-cool':       { label:'White / cool HUD', bg:'#050a12', primary:'#d8f3ff', secondary:'#6fb7d9', accent:'#39d6ff', ok:'#4ad9b0', warn:'#ffc24d', fail:'#ff6b7a', stale:'#6b7c8c', dim:'#122233', glow:0.5 },
  'nasa':           { label:'NASA amber / white', bg:'#000000', primary:'#f2efe6', secondary:'#a9a59a', accent:'#ffb347', ok:'#5fd0c0', warn:'#ffb347', fail:'#ff5a5a', stale:'#7c7870', dim:'#2a2824', glow:0 },
  'cyberpunk':      { label:'Cyberpunk neon', bg:'#070708', primary:'#fcee0a', secondary:'#c8c0a0', accent:'#00f0ff', ok:'#00f0ff', warn:'#ff9f1c', fail:'#ff2a6d', stale:'#6a6a5a', dim:'#1c1c10', glow:0.6 },
  'blade-runner':   { label:'Blade Runner neon', bg:'#06040c', primary:'#ffd6e8', secondary:'#9a7fb0', accent:'#ff3ca6', ok:'#35d0e0', warn:'#ffa54f', fail:'#ff3c6e', stale:'#5f556b', dim:'#1b1230', glow:0.7 },
  // Round 2: refined palettes for the Flight (mission control) direction. Status triples validated against their own bg.
  'mocr-1969':      { label:'MOCR 1969 · warm grey, CRT white, sparing amber', bg:'#0e0d0b', primary:'#e9e4d6', secondary:'#8f8a7c', accent:'#e0a24a', ok:'#7cc4ad', warn:'#e0a24a', fail:'#e85d6a', stale:'#6e6a60', dim:'#1f1d19', glow:0 },
  'shuttle-glass':  { label:'Shuttle glass cockpit · MEDS green, cyan, yellow', bg:'#050607', primary:'#eef2f0', secondary:'#7c8f96', accent:'#39c0c8', ok:'#4fd3a6', warn:'#f2c832', fail:'#e23b4a', stale:'#5f6b70', dim:'#141a1d', glow:0 },
  'ops-muted':      { label:'Modern ops centre · slate, desaturated blue', bg:'#0f1216', primary:'#dfe5ea', secondary:'#7d8893', accent:'#6ea8dc', ok:'#5bb89c', warn:'#d9a441', fail:'#d9635e', stale:'#5c6670', dim:'#1b2129', glow:0 },
  'mono-accent':    { label:'Monochrome + one amber accent', bg:'#0a0a0a', primary:'#e6e6e6', secondary:'#8c8c8c', accent:'#ffb14d', ok:'#a8a8a8', warn:'#ffb14d', fail:'#ff4d6a', stale:'#5e5e5e', dim:'#1c1c1c', glow:0 },
  'mocr-shuttle':   { label:'MOCR 1981–2011 · blue-grey consoles, amber call-ups', bg:'#0b0f14', primary:'#e8eef2', secondary:'#93a3b1', accent:'#f2b544', ok:'#6cc7b4', warn:'#f2b544', fail:'#ef6a6a', stale:'#5f6c78', dim:'#171f28', glow:0 },
  'cvd-contrast':   { label:'High-contrast CVD-safe', bg:'#000000', primary:'#ffffff', secondary:'#bdbdbd', accent:'#56b4e9', ok:'#56b4e9', warn:'#f0e442', fail:'#d55e00', stale:'#8a8a8a', dim:'#2b2b2b', glow:0 },
};
const PALETTE_KEYS = Object.keys(PALETTES);
