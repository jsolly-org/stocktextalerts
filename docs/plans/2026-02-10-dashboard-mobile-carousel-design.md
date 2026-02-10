# Dashboard Mobile Carousel Design

**Date:** 2026-02-10
**Status:** Approved

## Problem

On mobile, the dashboard has 6 panels stacked vertically requiring excessive scrolling. Users must scroll through all panels to reach ones near the bottom (e.g., Notification Preview).

## Solution

Replace the stacked layout with a **horizontal swipeable card carousel** on mobile screens (<768px). Each panel becomes a full-width card. An **icon tab bar** provides direct navigation and visual orientation.

Desktop/tablet layout (>=768px) remains unchanged.

## Design Details

### Card Carousel
- Horizontal `overflow-x: auto` container with `scroll-snap-type: x mandatory`
- Each card: `scroll-snap-align: start`, `min-width: 100%`
- Fixed card height: `calc(100dvh - nav - tab bar - padding)` with internal overflow-y scroll
- Native swipe with CSS scroll-snap — no JS library needed

### Icon Tab Bar
Compact row of 6 icons pinned above the carousel:

| Panel | Icon | Label (sr-only) |
|---|---|---|
| Watchlist | presentation-chart-line | Watchlist |
| Channels | device-phone-mobile | Channels |
| Schedule | clock | Schedule |
| Daily | bell-alert | Daily |
| Weekly | calendar-days (new) | Weekly |
| Preview | eye (new) | Preview |

- Active icon highlighted with colored underline
- Tap to jump (smooth scrollIntoView)
- Scroll position synced via IntersectionObserver

### Responsive Behavior
- **Mobile (<768px):** Carousel with icon tab bar
- **Desktop (>=768px):** Current stacked `space-y-6` layout, unchanged

## Implementation

### New Files
- `src/components/dashboard/DashboardCarousel.vue` — carousel + tab bar
- `src/icons/calendar-days.svg` — Heroicons-style calendar icon
- `src/icons/eye.svg` — Heroicons-style eye icon

### Modified Files
- `src/components/dashboard/DashboardPanels.vue` — conditional mobile/desktop rendering

### Architecture
- `DashboardPanels.vue` still owns all state and form logic
- Panels passed to carousel via `<slot>` — carousel has no knowledge of panel internals
- `matchMedia('(max-width: 767px)')` reactive check toggles layout mode
- Existing auto-save, validation, and state management untouched
