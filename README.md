# NodeGL Image Editor

A client-only React + TypeScript node-based image editor: React Flow graph, WebGL 2 shader nodes, media pool with folder batch processing, single/grid viewer, toolbox, settings, and JSON project save/load.

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

## Nodes

| Category | Node | Notes |
|---|---|---|
| Input / Output | Image Input, Folder Input, Output | Folder Input batch-processes a whole folder |
| Tone | Exposure | Stops (EV) |
| | Contrast | Log-space around a pivot; optional saturation-preserving mode |
| | Highlights & Shadows | Highlights, Shadows, Whites, Blacks |
| | Levels | Input/output black & white points, gamma; RGB or single channel |
| | Curves | RGB master + R, G, B curves (monotone cubic) |
| | Lift / Gamma / Gain | DaVinci-style colour wheels + Offset wheel, each with a master slider |
| | Printer Lights | R/G/B printer points (1 pt ≈ 1/12 stop) |
| | Tone Mapping | AgX, AgX Punchy, ACES (fitted), Filmic (Hable), Reinhard |
| | Auto Exposure | Per-image exposure to a target average (geometric mean) |
| | Auto Levels | Per-image black/white point stretch |
| Colour | White Balance | Temperature (K) + tint, Bradford adaptation. Set Temp to the light source (e.g. 3200 K for tungsten) |
| | Saturation / Vibrance | Vibrance protects already-saturated colours and skin tones |
| | HSL / Colour Mixer | Hue / Saturation / Luminance for 8 colour bands |
| | Hue Curves | Hue vs Hue, Hue vs Sat, Hue vs Lum, Lum vs Sat |
| | Colour Grading | Shadows / Midtones / Highlights / Global wheels, Blending, Balance (split toning) |
| | Channel Mixer | 3×3 RGB matrix, optional luminance preservation |
| | Black & White Mix | Monochrome with per-colour brightness (8 bands) |
| | 3D LUT | Loads `.cube` 3D LUTs (any size, DOMAIN_MIN/MAX). Input encoding: sRGB, Linear or ACEScct. Strength |
| | Colour Space Transform | Linear sRGB, sRGB, Rec.709 (2.4), ACEScg, ACEScct, Display P3, Linear P3, Linear Rec.2020 |
| | Gamut Warning | Paints colours outside sRGB / P3 / Rec.2020 (including values above 1.0) |
| Utility | Grayscale, Invert | |

**Controls:** double-click any slider or wheel to reset it. Curves: click to add a point, drag to move, double-click a point to delete, **Reset** restores the channel.

## Colour pipeline
- Source images are uploaded as `SRGB8_ALPHA8` textures, so the GPU decodes them to **linear light**.
- Nodes process linear RGB (sRGB/Rec.709 primaries) in **16-bit float** render targets (HDR headroom, no banding). GPUs without float render targets fall back to 8-bit sRGB targets (values clipped to 0–1, and log-encoded intermediates such as ACEScct lose precision). The status bar shows which mode is active.
- Perceptual nodes (Levels, Curves, Lift/Gamma/Gain, HSL, Hue Curves) work on sRGB-encoded values internally and convert back.
- A final pass encodes to sRGB for display.
- Auto Exposure / Auto Levels measure each image with a GPU reduction (block averages, then min/max) — no CPU pixel reads.
- Curve and 3D LUT data are small lookup textures; the curves themselves are sampled on the CPU from your control points, all image pixels are processed on the GPU.

## Batch / display
- **Import:** Media Pool “+ Images” or “+ Folder” (File menu too). Folder Input runs the same graph on every image; Auto nodes adapt per image.
- **Viewer:** Single (◀ ▶) or Grid; choose displayed images with the Media Pool checkboxes, ✕ on tiles, or Show all / Hide all.
- **Wires:** drag between sockets; click a socket or wire to disconnect, or drag a wire end into empty space.
- **Settings (⚙):** output display (panel / behind nodes / off), viewer layout, grid tile size, node previews, wire thickness.

## Projects
Save/open graphs as JSON. Parameters, curves and loaded `.cube` LUTs are stored in the project; images are not. Projects from earlier versions open with their Exposure values migrated.

## Notes
- Folder import uses the browser's directory picker (`webkitdirectory`).
- File formats are whatever the browser can decode (JPEG, PNG, WebP, GIF, AVIF, BMP; HEIC only in Safari).
- Graphs are linear single-input chains; cycles and self-links are blocked. Batch export is not implemented yet.
