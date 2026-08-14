# Mobile / PWA phone UI improvements

**Doc ID:** DOC-007  
**Status:** in progress  
**Last updated:** 2026-06-25  
**Owner / area:** Mobile UX, PWA, Layout  

---

## 1) Summary

Improves the phone and installed-PWA experience: stops iOS zoom-on-focus in forms, uses a dedicated scroll panel for page changes, enlarges touch targets and type, and closes the mobile menu when navigating.

---

## 2) Problem / requirement

Users on phone/PWA reported:

- Text and UI felt too small
- Tapping form fields zoomed the page in; closing the keyboard zoomed back out (chaotic)
- Pages did not feel like they switched when using the menu (scroll position / overlay menu)

---

## 3) Solution

| Fix | Detail |
|-----|--------|
| **16px form controls** | Inputs, selects, textareas, comboboxes use `text-base` (16px) on compact layouts so iOS Safari does not auto-zoom on focus |
| **App shell scroll** | Layout uses `h-[100dvh]` + `#app-main-scroll` as the scroll container; `ScrollToTop` resets it on route change |
| **PWA document lock** | In standalone mode, `html.app-standalone-shell` prevents body bounce; main panel scrolls |
| **Larger mobile nav** | Sidebar links `text-base`, `min-h-[48px]`; wider mobile drawer |
| **Auto-close menu** | `AppSidebar` closes mobile sheet on `location.pathname` change |
| **Viewport** | `interactive-widget=resizes-content` for better virtual-keyboard behavior on Android |

---

## 4) Key files

```
src/index.css
src/components/Layout.tsx
src/components/AppSidebar.tsx
src/components/ScrollToTop.tsx
src/components/ui/input.tsx
src/components/ui/textarea.tsx
src/components/ui/select.tsx
src/components/ui/command.tsx
src/components/ui/sidebar.tsx
index.html
```

---

## 5) Database / migrations

None.

---

## 6) Test plan

- [ ] iPhone Safari + installed PWA: open expense form, tap title/amount — **no page zoom**
- [ ] Android Chrome PWA: same form fields — stable viewport
- [ ] Open menu → tap Dashboard → menu closes, content scrolls to top, new page visible
- [ ] Sidebar links are easy to tap (48px height)
- [ ] Body does not rubber-band behind header in standalone app

---

## Revision log

| Date | Revision | Author | Notes |
|------|----------|--------|-------|
| 2026-06-25 | 1.0 | Agent | Mobile shell, anti-zoom forms, scroll container |
