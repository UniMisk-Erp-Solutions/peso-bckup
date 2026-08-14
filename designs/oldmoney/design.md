# PesoWise — Old Money Theme Design Reference

**Theme name:** Old Money
**Status:** Optional (user-selectable in Settings → Appearance)
**Activated by:** `data-theme="old-money"` on `<html>` element
**Setting key:** `theme` = `"old-money"` in `org_settings`

---

## Design philosophy

Private-banking aesthetic. Warm ivory surfaces, deep emerald sidebar, brass-tinted accents.
Serif display headings (Fraunces) give large numbers a ledger-book gravitas.
Body copy stays in Inter — readable, modern. The contrast creates editorial tension:
serif for money figures, sans-serif for UI labels.

---

## Color tokens (HSL)

| Token | Value | Hex approx | Usage |
|-------|-------|------------|-------|
| `--background` | `40 27% 93%` | `#ede8df` | Ivory page background |
| `--foreground` | `40 12% 10%` | `#1c1a17` | Ink text |
| `--card` | `0 0% 100%` | `#ffffff` | Card surface (pure white on ivory) |
| `--primary` | `158 45% 20%` | `#1b5c3a` | Deep emerald — buttons, links |
| `--primary-foreground` | `0 0% 100%` | `#ffffff` | Text on primary |
| `--secondary` | `40 25% 90%` | `#e8e3d8` | Warm secondary bg |
| `--muted` | `40 25% 91%` | `#eae5da` | Muted backgrounds |
| `--muted-foreground` | `40 8% 44%` | `#736f68` | Warm gray captions |
| `--border` | `40 25% 87%` | `#e0dbd0` | Hairline dividers |
| `--ring` | `38 39% 50%` | `#af8a40` | Brass — focus ring, active accent |
| `--success` | `142 76% 36%` | `#16a34a` | (same as legacy) |
| `--destructive` | `0 36% 45%` | `#9b3535` | Muted rose |

### Sidebar tokens (Emerald Rail)

| Token | Value | Hex approx | Notes |
|-------|-------|------------|-------|
| `--sidebar-background` | `158 45% 16%` | `#164a2f` | Very dark emerald |
| `--sidebar-foreground` | `43 22% 86%` | `#dbd6c8` | Warm cream text |
| `--sidebar-primary` | `38 39% 55%` | `#c29b4f` | Brass — active/icon accent |
| `--sidebar-accent` | `158 38% 24%` | `#1f6340` | Hover state |
| `--sidebar-border` | `158 28% 26%` | `#2a5e42` | Rail border |

---

## Typography

| Element | Font | Weight | Size | Notes |
|---------|------|--------|------|-------|
| Body / UI | Inter | 400–500 | 14px | All labels, inputs, table cells |
| Nav labels | Inter | 500 | 13.5px | Sidebar items, uppercase group labels |
| Headings h1–h4, .text-2xl+ | Fraunces | 700 | 18–32px | Display serif — editorial look |
| Large stat numbers | Fraunces | 700 | 24–32px | Money figures, totals |
| Monospace (IDs, codes) | system-ui mono | 500 | 12px | Employee IDs, transaction numbers |

### Group label style (sidebar)
```css
text-transform: uppercase;
letter-spacing: 2.5px;
font-size: 10px;
color: #d8c39a;  /* gold-warm */
```

---

## Sidebar patterns

- Background: dark emerald `#164a2f`
- Default nav item: `color: #bcc7be`, no background
- Hover: `rgba(255,255,255,.06)` background, `color: #fff`
- Active item: `rgba(216,195,154,.15)` background (brass tint), left accent bar `background: #b08d4f; width: 3px`
- Icon color on active: `#d8c39a` (gold)
- Thin scrollbar: `rgba(216,195,154,.35)` thumb

---

## Component differences from Legacy

| Component | Legacy | Old Money |
|-----------|--------|-----------|
| Page bg | Blue-white gradient | Flat ivory `hsl(40 27% 93%)` |
| Sidebar | Dark navy | Dark emerald rail |
| Headings | Inter bold | Fraunces serif |
| Stat numbers | Inter 800 | Fraunces 700 |
| Primary | Blue `#4f8ef7` | Emerald `#1b5c3a` |
| Focus ring | Blue | Brass `#af8a40` |
| Active nav bar | None | Brass left bar (3px) |
| Card bg | White | White on ivory base |
| Destructive | Bright red `#ef4444` | Muted rose `#9b3535` |
| Table hover | `muted/50` transparent | Warm ivory tint |

---

## Key CSS overrides (from `src/index.css`)

```css
html[data-theme="old-money"] { /* all token overrides */ }

/* Flatten page gradient */
html[data-theme="old-money"] .min-h-app { background-image: none !important; background-color: hsl(40 27% 93%) !important; }

/* Display typography */
html[data-theme="old-money"] h1, h2, h3, h4, .text-2xl, .text-3xl, .text-4xl, .text-5xl {
  font-family: "Fraunces", Georgia, serif;
  letter-spacing: -0.01em;
}

/* Sidebar active accent bar */
html[data-theme="old-money"] [data-sidebar="menu-item"] > a[class*="bg-gray-200"]::before {
  content: ""; position: absolute; left: -2px; top: 50%; transform: translateY(-50%);
  height: 56%; width: 3px; border-radius: 0 3px 3px 0; background: #b08d4f;
}
```

---

## See also

- `design.html` — full interactive demo with all pages and demo data
- `src/index.css` — canonical token definitions (lines 146–280)
- `Documentations MD/old-money-theme.md` — DOC-008 implementation notes
