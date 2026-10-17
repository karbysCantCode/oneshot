# NodeGL Looks

Ready-made graphs for the Library. Import them in the app:
**Toolbox → Library → Import graph / pack files…** and pick `nodegl-looks-pack.json` (all looks) or any file in `individual/`.

Then select images (Media Pool checkboxes), click **Apply** on a look, and fine-tune each photo in **Library** view – the parameters appear under the image.

| Look | Per-image parameters | Description |
|---|---|---|
| Teal & Orange | Strength, Vignette | Cinematic blockbuster grade: teal shadows, warm skin and highlights, punchy contrast. |
| Vintage Film | Strength, Grain, Vignette | Faded 70s print: warm cast, lifted blacks, soft highlights, muted colour, grain. |
| Noir | Strength, Grain, Vignette | High-contrast black & white with bright skin, dark skies, grain and heavy vignette. |
| Comic Pop | Strength | Pop-art comic: boosted colour, cel shading, ink outlines, halftone dots. |
| Dreamy Glow | Strength | Soft, airy, glowing highlights, lifted shadows, pastel colour. |
| Cyberpunk Neon | Strength | Cold blue shadows, magenta highlights, pink-shifted warm tones, glow. |
| Bleach Bypass | Strength | Gritty silver-retained film look: desaturated, metallic, high contrast. |
| Cross Process | Strength | Yellow-green highlights, blue shadows, saturated and contrasty. |
| Tilt-Shift Miniature | Strength, Focus Y, Focus band | Makes scenes look like tiny models. Move Focus Y (0 = top, 1 = bottom) per photo. |
| Pencil Sketch | Strength, Line weight, Shading | Graphite drawing on warm paper. |
| Golden Hour | Strength, Vignette | Warm late-afternoon light, glowing highlights, rich colour. |
| Faux Infrared | Strength, Grain | Black & white infrared: white foliage, dark skies, halation. |

Every look ends with a **Strength** mix between the original and the look (0 = original, 1 = full look; values above 1 exaggerate it).
Use **Edit** on a look to open it in the node workspace and change anything – it's built only from standard nodes.

File format: a graph file is `{ "nodegl": "graph", "name", "description", "nodes", "edges", "luts" }`; a pack is `{ "nodegl": "graph-pack", "graphs": [ … ] }`.
