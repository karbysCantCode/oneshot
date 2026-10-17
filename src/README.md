# OneShot

**OneShot** is a client-only React + TypeScript node-based photo editor: React Flow graph, WebGL 2 shader nodes with typed sockets, compound (group) nodes, a library of saved graphs that can be applied per image, media pool with folder batch processing, single/grid viewer, toolbox, settings, and JSON project save/load.

## Requirements
- Node.js 20.19+ or 22.12+
- npm (included with Node.js)
- A current desktop browser with WebGL 2 and hardware acceleration (Chrome, Edge, Firefox, Safari)

## Run locally
```bash
npm install
npm run dev
```
Open the URL printed by Vite (normally http://localhost:5173).

## Production build / static hosting
```bash
npm run build
npm run preview
```
Deploy `dist/` to any static host. No server-side processing is used.

## Platform setup
- **macOS:** install Node.js LTS from nodejs.org or `brew install node`, then run the commands above in Terminal.
- **Windows 10/11:** install Node.js LTS, then run the commands in PowerShell. If `npm.ps1` is blocked, use Command Prompt or `npm.cmd install` / `npm.cmd run dev`.
- **Linux:** install a supported Node.js release (package manager or nvm). GPU drivers and browser hardware acceleration must work.

## Graph basics
- **Sockets are typed:** yellow = colour (float3/RGBA), grey = value (float). Conversions are implicit: value → colour gives (v, v, v); colour → value uses luminance. Wires are coloured by the type they carry.
- **Unconnected inputs** (e.g. Math A/B, Mix factor, Noise scale) are edited directly on the node.
- **Graphs are DAGs:** a node output can feed many inputs; each input takes one wire. Cycles are blocked.
- **Wires:** drag between sockets. Click a socket or wire for a disconnect menu, or drag a wire end into empty space.
- **Bypass:** the bypass button in a node's title bar (or **M**) passes its input straight through (first connected input of the matching type). Works on groups too.
- **Rename:** double-click a node title (or right-click → Rename).
- **Right-click a node** for bypass, rename, group/ungroup and delete.

## Selecting & deleting nodes
- **Select:** click; Ctrl/⌘-click to add or remove; **Shift-drag** a box (or turn on **Box select** at the top right of the workspace, or press **B**, so a plain drag draws the box – middle/right-drag then pans); **Ctrl/⌘+A** selects all (click in the workspace first); **Esc** clears.
- **Smart selections** (Edit menu / workspace toolbar): *Unused* selects every node that doesn't feed the Output; *Select bypassed*; *Invert selection*.
- **Delete:** Delete / Backspace, the **Delete** button on the selection bar, right-click → Delete, or **Edit → Delete all nodes…** (keeps Output). Mass deletes always keep the Output node and a group's Input/Output.
- **Undo:** Ctrl/⌘+Z (or *Undo delete*) restores the last delete, including wires and loaded LUTs.
- The selection bar also offers Bypass, Reset and Group for everything selected.

## Compound nodes (groups)
- Select nodes and press **Ctrl/⌘+G** (or Edit → Group selected). Wires crossing the selection become the group's input/output sockets.
- **Tab** (or the edit button on the group) opens the group; **Tab** again (or the breadcrumb) exits. Groups can be nested.
- **Ctrl/⌘+Shift+G** ungroups.
- Group sockets are fixed when the group is created (re-group to change them).

## Library: saved graphs per image
- Toolbox → **Library** → **Save current graph** (also File → Save graph to Library…). Saved graphs live in the browser (localStorage); use ⤓ / **Import graph / pack files…** to move them between machines. Several files, or pack files containing many graphs, can be imported at once.
- **Apply** assigns a graph to the images shown in the viewer and switches to **Library** view (viewer bar: Workspace | Library).
- In Library view each image is rendered with its own graph. Under the image, the graph's **Value**, **RGB Colour** and **Image Input** nodes appear as per-image parameters (named by their node labels), so the same look can be varied per photo. **Apply to all shown** copies the graph and parameters; **Reset** restores the graph's values.
- **Insert** adds a saved graph's nodes to the workspace so you can see and tweak them: the look is appended after your current graph (whatever fed Output feeds the look, and the look feeds Output). The inserted nodes arrive selected – press Ctrl/⌘+G to collapse them into a compound node.
- **Edit** replaces the workspace with a saved graph; saving again creates an updated copy.

## Nodes
| Category | Nodes |
|---|---|
| Input / Output | Image Input (current image or any Media Pool image), Folder Input, Output, Value, RGB Colour, Texture Coordinate |
| Tone | Exposure, Contrast, Highlights & Shadows, Levels, Curves, Lift/Gamma/Gain, Printer Lights, Tone Mapping, Auto Exposure, Auto Levels |
| Colour | White Balance, Saturation/Vibrance, HSL/Colour Mixer, Hue Curves, Colour Grading, Channel Mixer, Black & White Mix, 3D LUT, Colour Space Transform, Gamut Warning |
| Filter | Gaussian Blur, Directional Blur, Zoom/Spin Blur, Sharpen (unsharp mask), Bloom/Glow, Edge Detect (Sobel/Prewitt/Laplacian), Comic, Pixelate, Posterize, Threshold, Emboss, Kuwahara (painterly), Halftone |
| Mask | Circle Mask, Ellipse Mask, Rectangle Mask, Polygon Mask |
| Texture | Noise (fractal Perlin: scale, detail, roughness, lacunarity, distortion, W), Voronoi (F1/F2/edge, 3 metrics), White Noise, Gradient (7 types), Wave (bands/rings, 3 profiles), Checker |
| Converter | Math (41 Blender operations: add … power, log, sqrt, min/max, compare, smooth min/max, round/floor/ceil, modulo, wrap, snap, ping-pong, trig, hyperbolic, radians/degrees; clamp), Vector Math (per component + dot, cross, length, distance, normalise, scale, reflect), Mix (19 blend modes, factor), Colour Ramp (16 stops, linear/ease/constant), Map Range (linear/stepped/smooth/smoother), Clamp, Separate/Combine RGB, Separate/Combine HSV, RGB to BW |
| Utility | Grayscale, Invert |

Filter radii are in **full-resolution pixels**, so previews, grid tiles and the full-size viewer look the same.

## Masks (primitive shapes)
Circle, Ellipse, Rectangle (rounded corners) and Polygon (3–32 sides) Mask nodes output a per-pixel **Mask** value: 1 inside the shape, fading to 0 across the **Feather** distance outside the edge (Invert flips it). Connect the mask to **Mix → Factor** to blend two images/colours through the shape, or to any other value input (Math, Map Range, Colour Ramp …).

- **X / Y**: centre as a fraction of the image width / height (0,0 = top-left, 0.5,0.5 = centre).
- **Radius, width, height, corner and feather**: fractions of the image **height**, so shapes stay round on any aspect ratio and match between previews, grid tiles and full size.
- **Rotation**: degrees. Every parameter is a socket, so it can be driven by a Value node (per-image in Library view) or by another node per pixel.
- Combine masks with Math (Maximum = union, Minimum = intersection, Subtract = cut-out).

## Session retention
Imported images (IndexedDB), their Media Pool folders / display ticks / Library assignments, the Library, the workspace graph (including loaded LUTs) and settings are kept in this browser and restored after a refresh or restart. Nothing leaves the computer. Storage is per browser profile and per site address (e.g. `localhost:5173` and a LAN IP are separate). The app asks the browser to keep the data persistent; private/incognito windows discard it when closed.

## Removing images
- Hover an image → ✕, or the bin on a folder header to remove the whole folder.
- Select several: click, **Ctrl/⌘-click** to add/remove, **Shift-click** for a range, **Select all** (or Ctrl/⌘+A in the Media Pool), then the bin button or **Delete / Backspace**. Removing several asks for confirmation. Removed images are also deleted from the stored session; the original files on disk are never touched.

## Importing
- Drag images **or whole folders** onto the Media Pool (sub-folders included), or use “+ Images” / “+ Folder”. Each dropped folder becomes a Media Pool folder; dropped loose images go to “Loose images”.

## Resetting values
- The reset button in a node's title bar restores that node's defaults: parameters, inline input values, curves and colour ramp. Name, wires, bypass, loaded LUT file and folder are kept.
- Also: right-click a node → Reset values to defaults; Edit → Reset selected nodes / Reset all nodes (current graph level).

## Exporting
- **Export…** in the viewer bar, File → Export images…, or **Ctrl/⌘+E**.
- Exports what the viewer shows: Workspace view uses the graph being edited; Library view uses each image's own saved graph and parameters.
- Images: current image, images shown in the viewer, or every image in the batch.
- Formats: JPEG / WebP (quality 1–100) or lossless PNG, 8 bits per channel, sRGB. WebP is disabled in browsers that can't encode it (Safari).
- Size: full resolution or a maximum long edge. Filter radii scale with the size, so results match the full-size look.
- Names: original name + suffix (default `_edit`). Several images download as one ZIP (or separate downloads).
- Rendering is on the GPU; only file encoding and ZIP packaging use the CPU.

## Viewer (single image)
- Opens **fitted** to the panel and re-fits when you switch images or resize the panel (while in Fit).
- **Wheel** or **pinch**: zoom around the cursor. **Drag** (left or middle button): pan. Trackpad two-finger scroll pans.
- **Double-click**: 100% at the cursor ↔ Fit. Bottom-right controls: Fit, 100%, −, zoom %, +.
- Keys (click the image first): **F** / **0** fit, **1** actual pixels, **+** / **−** zoom, **arrows** pan.
- Above 200% (manual zoom) pixels are shown sharp for pixel-peeping. The viewer renders at full resolution, so 100% is true pixels.

## Ready-made looks & demos
31 graphs ship with the app (`src/looks/builtin-looks.json`) and are unpacked into the Library, grouped by collection and tagged BUILT-IN:

- **Film Looks** (12): Teal & Orange, Vintage Film, Noir, Comic Pop, Dreamy Glow, Cyberpunk Neon, Bleach Bypass, Cross Process, Tilt-Shift Miniature, Pencil Sketch, Golden Hour, Faux Infrared
- **Movie Looks** (4): Matrix Code (green cast, cel-shaded ink, falling code rain), Dune Desert, Barbie Dreamhouse, Cyberpunk Night City
- **Advanced Demos** (7): procedural Plasma / Stained Glass / Synthwave Sunset (no image – pure maths & textures), Spotlight / Colour Pop / Hexagon Frame (shape & maths masks), Duotone Map
- **Photographer Batch** (8): Auto Enhance, Bright & Airy (Wedding), Real Estate Interior, Landscape + Grad ND, Portrait Soft Skin, Classic B&W Portrait, Product on White, Low-Light Rescue

Newly shipped graphs are added to an existing Library automatically; graphs you delete stay deleted (**Restore built-in looks** brings them back). `looks/` holds the same graphs as files plus a preview – see `looks/README.md`.

## Layout
Drag the dividers between the Media Pool, centre and Toolbox, and between the viewer and node workspace, to resize them. Double-click a divider to reset it; Window → Reset panel sizes resets all. Sizes are remembered in the browser.

## Procedural images
Texture and maths nodes work without any image. If the Output doesn't depend on an image, the viewer renders a procedural canvas (size in Settings, default 1920×1080).

## Colour pipeline
- Source images are uploaded as `SRGB8_ALPHA8` textures, so the GPU decodes them to **linear light**.
- Every node output is a full-size **16-bit float** texture (HDR headroom, negative values, no banding). GPUs without float render targets fall back to 8-bit sRGB targets (values clipped to 0–1); the status bar shows which mode is active.
- Intermediate textures are pooled and released as soon as their last consumer has run. Multi-pass filters (blur, sharpen, bloom) use separable passes.
- A final pass encodes to sRGB for display.
- Auto Exposure / Auto Levels measure each image with a GPU reduction. Curves, colour ramps and 3D LUTs are small lookup data; all image pixels are processed on the GPU.

## Batch / display
- **Import:** Media Pool “+ Images” or “+ Folder”. A Folder Input runs the graph on every image; Auto nodes adapt per image.
- **Viewer:** Workspace or Library; Single (◀ ▶) or Grid; choose displayed images with the Media Pool checkboxes, ✕ on tiles, or Show all / Hide all.
- **Settings (⚙):** output display (panel / behind nodes / off), viewer layout, grid tile size, procedural canvas size, node previews, wire thickness.

## Projects
File → Save project stores the workspace graph (including groups, parameters, curves, ramps, bypass states and loaded `.cube` LUTs) as JSON; images are not embedded. Projects from earlier versions open with Exposure values and wires migrated.

## Notes
- Folder import uses the browser's directory picker (`webkitdirectory`).
- File formats are whatever the browser can decode (JPEG, PNG, WebP, GIF, AVIF, BMP; HEIC only in Safari).
- Image Inputs pointing at a different Media Pool image are stretched to the output size.
- Exports are 8-bit; 16-bit/float (TIFF/EXR) export is not implemented. ZIPs are limited to 4 GB (larger exports fall back to separate downloads).

## Branding
The app is called **OneShot** (page title, header, favicon `public/favicon.svg`, logo `public/logo.svg`). Browser-storage keys keep their original `nodegl.` prefix so existing sessions, libraries and images survive the rename.
