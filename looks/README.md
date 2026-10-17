# OneShot Looks

These graphs ship with OneShot and appear automatically in **Toolbox → Library**, grouped by collection (tagged BUILT-IN). The files here are copies for sharing or importing into another browser:

- `oneshot-all-looks.oneshot-pack.json` – everything
- one pack per collection (`film-looks…`, `movie-looks…`, `advanced-demos…`, `photographer-batch…`)
- `individual/` – one file per graph

Import with **Toolbox → Library → Import graph / pack files…** (several files at once are fine). `preview.png` shows every graph on a test scene.


## Film Looks

| Graph | Per-image parameters | What it does |
|---|---|---|
| Teal & Orange | Strength, Vignette | Cinematic blockbuster grade: teal shadows, warm skin and highlights, punchy contrast. |
| Vintage Film | Strength, Grain, Vignette | Faded 70s print: warm cast, lifted blacks, soft highlights, muted colour, grain and vignette. |
| Noir | Strength, Grain, Vignette | High-contrast black & white with bright skin, dark skies, grain and a heavy vignette. |
| Comic Pop | Strength | Pop-art comic: boosted colour, flat cel shading, ink outlines and halftone dots. |
| Dreamy Glow | Strength | Soft, airy and bright: glowing highlights, lifted shadows, gentle warmth and pastel colour. |
| Cyberpunk Neon | Strength | Night-city neon: cold blue shadows, magenta highlights, pink-shifted warm tones and glow. |
| Bleach Bypass | Strength | Gritty silver-retained film look: desaturated, metallic, high contrast. |
| Cross Process | Strength | Slide film in the wrong chemicals: yellow-green highlights, blue shadows, saturated and contrasty. |
| Tilt-Shift Miniature | Strength, Focus Y, Focus band | Makes real scenes look like tiny models: sharp focus band, blurred top and bottom, toy-like colour. Move “Focus Y” per photo. |
| Pencil Sketch | Strength, Line weight, Shading, Paper colour | Graphite drawing on warm paper: traced edges with soft shading. |
| Golden Hour | Strength, Vignette | Late-afternoon sun: warm light, glowing highlights, opened shadows and rich colour. |
| Faux Infrared | Strength, Grain | Black & white infrared: glowing white foliage, near-black skies, dreamy halation. |

## Movie Looks

| Graph | Per-image parameters | What it does |
|---|---|---|
| Matrix Code | Strength, Cartoon, Code rain, Vignette, Rain colour | The green-tinted world of the 1999 film: green cast, crushed cool shadows, cel-shaded ink edges and optional falling code rain. |
| Dune Desert | Strength, Haze, Grain, Vignette | Arrakis: burnt-orange monochrome palette, bleached skies, matte lifted blacks, heat-haze glow and grain. |
| Barbie Dreamhouse | Strength, Pink wash, Glow, Pink | Candy-coloured plastic fantastic: pink-shifted reds, magenta highlights, pastel brights, soft glow and a pink wash. |
| Cyberpunk Night City | Strength, Scanlines, Vignette | Neon dystopia: acid-yellow highlights, cyan shadows, crushed greens, hard contrast, neon bloom and CRT scanlines. |

## Advanced Demos

| Graph | Per-image parameters | What it does |
|---|---|---|
| Procedural · Plasma | Time, Scale | No image needed: four sine waves summed over pixel position, mapped through a Colour Ramp. Change “Time” to animate, “Scale” to zoom. Open with Edit to see it on the procedural canvas. |
| Procedural · Stained Glass | Cells | No image needed: Voronoi cells give each pane a random colour, Voronoi “distance to edge” draws the lead lines, noise adds glass texture and a radial gradient adds back-light. |
| Procedural · Synthwave Sunset | Sun height, Mountain colour, Floor colour, Grid colour | No image needed: sky from a Colour Ramp on Y, a circle-mask sun cut by stripes, fractal-noise mountains, and a perspective grid floor built from maths. |
| Mask · Spotlight | Strength, Spot X, Spot Y, Radius | Shape masking: a feathered Circle Mask keeps the subject bright and warm while the rest falls into dark, desaturated shadow. Move X / Y / Radius per photo. |
| Mask · Colour Pop | Strength, Hue, Range | A mask built from maths instead of shapes: Separate HSV → hue distance → Map Range gives a per-pixel mask that keeps one colour and turns the rest black & white. Hue: 0 red, 0.08 orange, 0.16 yellow, 0.33 green, 0.55 cyan, 0.66 blue, 0.83 magenta. |
| Mask · Hexagon Frame | Strength, Size, Sides, Frame colour | Polygon Mask framing: the photo inside a regular polygon on a coloured card. Sides, size and frame colour are per-image parameters (RGB Colour nodes are exposed too). |
| Converter · Duotone Map | Strength | Image → RGB to BW → Colour Ramp: brightness re-mapped through a gradient (Spotify-style duotone). Swap the ramp colours to taste. |

## Photographer Batch

| Graph | Per-image parameters | What it does |
|---|---|---|
| Batch · Auto Enhance | Strength | One-click fix for a whole shoot: per-image auto levels and auto exposure (each photo measured on the GPU), recovered highlights, opened shadows, vibrance and capture sharpening. |
| Batch · Bright & Airy (Wedding) | Strength | Light and romantic: brighter exposure, soft highlights, open shadows, warm skin, pastel greens and a light matte. |
| Batch · Real Estate Interior | Strength | Bright, even interiors: auto exposure per room, strong shadow lift and highlight recovery (windows), neutral-cool white balance, clean vibrance and crisp detail. |
| Batch · Landscape + Grad ND | Strength, Sky darken, Horizon | Punchy landscapes with a virtual graduated ND filter: deeper blue skies, richer foliage, local contrast, and a feathered Rectangle Mask darkening the sky down to the “Horizon”. |
| Batch · Portrait Soft Skin | Strength, Smoothing, Skin hue, Skin range | Flattering portraits: a hue mask finds skin tones and blends in a soft blur only there (“Smoothing”), then warmth, gentle shadow lift and sharpening for the eyes. |
| Batch · Classic B&W Portrait | Strength, Grain, Vignette | Timeless monochrome: skin-friendly black & white mix, rich contrast, deep blacks, fine grain and a subtle vignette. |
| Batch · Product on White | Strength | E-commerce catalogue: auto levels, a bright exposure that pushes the background to clean white, neutral colour and crisp detail – consistent across a whole product shoot. |
| Batch · Low-Light Rescue | Strength, Denoise | Dim events and indoor shots: strong per-image auto exposure, lifted shadows, edge-preserving noise reduction (“Denoise”) and light sharpening. |

## Using them

1. Tick the photos to process in the Media Pool (or drop a whole folder).
2. Library → **Apply** on a graph: every shown image gets it (Library view).
3. Fine-tune each photo under the image; **Apply to all shown** copies settings.
4. **Export…** (Ctrl/⌘+E) → *Every image in the batch* → one ZIP.

**Insert** puts a graph's nodes into the workspace after your own graph so you can study or tweak it; **Edit** opens it on its own. Procedural demos ignore the photo – open them with **Edit** to render on the procedural canvas (size in Settings).

Every graph that takes a photo ends with a **Strength** mix (0 = original, 1 = full effect).

## File format

Graph: `{ "oneshot": "graph", "name", "description", "collection", "nodes", "edges", "luts" }` · Pack: `{ "oneshot": "graph-pack", "graphs": [ … ] }`. Older `nodegl` files import the same way.
