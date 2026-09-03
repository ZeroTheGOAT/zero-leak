// Role-based mapping. Backgrounds/borders map by depth rank, foregrounds by lightness.
// Layer order (darkest->lightest surface): sidebar-accent < accent/muted < background < card < popover
export const MAP = {
  // ---- deep app chrome / recessed wells (below background) ----
  '#0a0b0d':'var(--sidebar-accent)', '#0d0e12':'var(--sidebar-accent)',
  '#0e0f13':'var(--sidebar-accent)', '#0f1014':'var(--sidebar-accent)',
  '#101116':'var(--sidebar-accent)', '#111216':'var(--sidebar)',
  '#111218':'var(--sidebar)',        '#131418':'var(--sidebar)',
  '#14151a':'var(--sidebar)',        '#16171c':'var(--accent)',
  '#171820':'var(--accent)',         '#18191f':'var(--accent)',
  '#181a21':'var(--accent)',         '#1a1b21':'var(--muted)',
  '#1a1c23':'var(--muted)',
  // ---- background-level surfaces ----
  '#1c1d24':'var(--background)', '#1c1d27':'var(--popover)',  // popover: floating menu
  '#1c1e27':'var(--background)', '#1e2027':'var(--background)',
  '#1e2029':'var(--card)',       '#1f212a':'var(--card)',
  '#222530':'var(--card)',       '#22242c':'var(--border)',   // used as border 16x
  '#232631':'var(--card)',
  // ---- raised / hover surfaces ----
  '#252832':'var(--border)', '#252834':'var(--popover)',
  '#26282f':'var(--border)', '#262833':'var(--popover)',
  '#262936':'var(--border)', '#272a35':'var(--border)',
  '#282b37':'var(--popover)','#282b3a':'var(--popover)',
  '#282c3b':'var(--popover)','#282c3e':'var(--popover)',
  '#292c35':'var(--border)', '#292c38':'var(--border)',
  '#2a2c34':'var(--border)', '#2a2c35':'var(--popover)',
  '#2a2d38':'var(--border)', '#2e3244':'var(--border)',
  '#313545':'var(--border)',
  // ---- separators / input outlines ----
  '#3a3d47':'var(--border)', '#3d404b':'var(--input)',
  '#3f4147':'var(--input)',  '#4a4c53':'var(--input)',
  // ---- muted text (dim -> bright) ----
  '#50535e':'var(--muted-foreground)', '#555865':'var(--muted-foreground)',
  '#555965':'var(--muted-foreground)', '#565965':'var(--muted-foreground)',
  '#595c67':'var(--muted-foreground)', '#5f6169':'var(--muted-foreground)',
  '#666975':'var(--muted-foreground)', '#666a76':'var(--muted-foreground)',
  '#6b6d75':'var(--muted-foreground)', '#71717a':'var(--muted-foreground)',
  '#71747e':'var(--muted-foreground)', '#777a85':'var(--muted-foreground)',
  '#787b8d':'var(--muted-foreground)', '#7f828d':'var(--muted-foreground)',
  '#898c96':'var(--muted-foreground)', '#8e8e93':'var(--muted-foreground)',
  '#9da0a8':'var(--muted-foreground)', '#a1a1aa':'var(--muted-foreground)',
  '#a8aab2':'var(--muted-foreground)', '#aeb0b9':'var(--muted-foreground)',
  '#b0b3c2':'var(--muted-foreground)', '#b7b9c2':'var(--muted-foreground)',
  '#b8bac2':'var(--muted-foreground)',
  // ---- primary body text ----
  '#c4c4c8':'var(--foreground)', '#d2d3d8':'var(--foreground)',
  '#d4d4d8':'var(--foreground)', '#d7d8dd':'var(--foreground)',
  '#e4e4e7':'var(--foreground)', '#ededef':'var(--foreground)',
  // ---- semantic ----
  '#3f8f6f':'var(--success)', '#b8e6cd':'var(--success)', '#e8b4b4':'var(--destructive)',
};
