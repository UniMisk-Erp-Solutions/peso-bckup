# PesoWise — Legacy Theme Design Reference

**Theme name:** Legacy (Default)
**Status:** Active default
**Activated by:** No `data-theme` attribute on `<html>` (base styles)

---

## Color tokens (HSL)

| Token | Value | Hex approx | Usage |
|-------|-------|------------|-------|
| `--background` | `0 0% 100%` | `#ffffff` | Page background |
| `--foreground` | `222 47% 11%` | `#0f172a` | Default text |
| `--card` | `0 0% 100%` | `#ffffff` | Card surface |
| `--primary` | `217 91% 60%` | `#4f8ef7` | Buttons, links, active states |
| `--primary-foreground` | `0 0% 100%` | `#ffffff` | Text on primary |
| `--secondary` | `214 32% 91%` | `#dde6f0` | Secondary buttons |
| `--muted` | `210 40% 96%` | `#f1f5f9` | Muted backgrounds |
| `--muted-foreground` | `215 16% 47%` | `#64748b` | Placeholder, captions |
| `--border` | `214 32% 91%` | `#dde6f0` | Dividers, input borders |
| `--success` | `142 76% 36%` | `#16a34a` | Approved badge, positive values |
| `--destructive` | `0 84% 60%` | `#f43f5e` | Error, rejected, delete |
| `--warning` | `38 92% 50%` | `#f59e0b` | Warning, pending |
| `--info` | `199 89% 48%` | `#0ea5e9` | Info states |

### Sidebar tokens

| Token | Value | Hex approx |
|-------|-------|------------|
| `--sidebar-background` | `222 47% 11%` | `#1e2a45` |
| `--sidebar-foreground` | `210 40% 98%` | `#f8fafc` |
| `--sidebar-primary` | `217 91% 60%` | `#4f8ef7` |
| `--sidebar-accent` | `215 28% 17%` | `#1e293b` |

---

## Typography

| Element | Font | Weight | Size |
|---------|------|--------|------|
| Body | Inter, system-ui | 400 | 14px |
| Labels | Inter | 500 | 12–14px |
| Table headers | Inter | 500–600 | 12px |
| Large numbers | Inter | 700 | 24–32px |
| Headings | Inter | 700 | 18–24px |

---

## Page background

The authenticated shell uses a CSS gradient:
```css
background: linear-gradient(to bottom right, #f8fafc, #eff6ff, #eef2ff);
/* from-slate-50 via-blue-50 to-indigo-100 */
```

The sidebar is a flat dark navy (`hsl(222 47% 11%)`).
The header is `bg-white/80` with `backdrop-blur-md`.

---

## Component patterns

### Stat card
- White card, light shadow, blue icon, large number in dark
- Subtext in `--muted-foreground`

### Status badges
| Status | Color |
|--------|-------|
| pending | amber bg, amber text |
| approved | green bg, green text |
| rejected | red bg, red text |
| flagged | orange bg, orange text |

### Table
- Sticky header with `bg-muted` background
- Row hover: `hover:bg-muted/50`
- Sticky last column (Actions) with `border-l`, `bg-background`
- Alternating: none (clean white rows)

### Buttons
- Primary: `bg-primary text-white rounded-md`
- Secondary: `border bg-background rounded-md`
- Destructive: `bg-destructive text-white`
- Ghost: `bg-transparent hover:bg-muted`

---

## Key spacing

| Usage | Value |
|-------|-------|
| Sidebar width | 256px (16rem) |
| Header height | 52px (3.25rem) |
| Content padding | 16–24px |
| Card padding | 16–24px |
| Border radius | 8px (0.5rem) |
| Table cell padding | 12px 16px |

---

## See also

- `design.html` — full interactive demo with all pages and demo data
- `src/index.css` — canonical CSS token definitions
- `Documentations MD/old-money-theme.md` — DOC-008 on optional Old Money theme
