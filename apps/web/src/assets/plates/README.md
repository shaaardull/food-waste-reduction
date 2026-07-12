# Landing-page dish carousel

Drop dish photos here and they'll rotate through the hero carousel on
the diner landing screen (`src/screens/Landing.tsx`, `<PlateCarousel />`).

## File conventions

- **Format:** `.jpg` (photos) or `.png` (with transparency). WebP works
  too — Vite will inline it fine.
- **Aspect:** roughly square (1:1). The carousel masks each image
  with a lopsided blob border-radius, so anything close to square
  looks intentional; wide crops get chopped.
- **Size:** ~600×600 minimum for a crisp render on retina phones.
  Under 200 KB each — bigger files just slow the landing hero.
- **Naming:** kebab-case, descriptive — e.g. `butter-chicken.jpg`,
  `misal-pav.jpg`. The names are only used at import time; the diner
  never sees them.

## Wiring a new image into the carousel

1. Copy the file into this folder.
2. Open `src/screens/Landing.tsx`.
3. At the top of the `PLATES` array (near the bottom of the file),
   add or replace an entry:

   ```tsx
   import butterChicken from '../assets/plates/butter-chicken.jpg';

   const PLATES: PlateRecipe[] = [
     { imageUrl: butterChicken },
     // ...keep or delete the gradient-only entries as you go
   ];
   ```

4. Save. Vite HMR reloads the landing screen immediately.

You can have as many entries as you want — the carousel cycles
through all of them (3 visible at a time, one advances every 3.5s).
Aim for **5–8 plates** for a good rotation cadence.

## Gradient-only fallback

An entry without `imageUrl` renders a warm generated gradient
instead of a photo — matches the pilot cuisine palette (curry,
Konkan, greens, dessert, thali). Handy while you're waiting on real
photography. Delete these once you have all the shots you need.
