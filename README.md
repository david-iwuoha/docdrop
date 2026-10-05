# DocDrop

Open, edit and present PDF and Office files right in Chrome. Word documents keep their real layout while you edit them, spreadsheets keep their formatting when you save, and PowerPoint decks play as a full-screen slideshow. Everything runs inside the extension: your files never leave your computer.

![DocDrop opening a Word document](Docs/screenshot.png)

## What it does

| File | Open | Edit and save | Extras |
|---|---|---|---|
| PDF (`.pdf`) | Yes, sharp and fast | Yes: change text, add text, highlight, draw, sign, fill forms, reorder pages | Search, zoom, print |
| Word (`.docx`) | Yes, with true page layout | Yes, as a real `.docx` | Search, print or save as PDF |
| Excel (`.xlsx`) | Yes, with cell colours, fonts, borders, merged cells | Yes, formatting kept | Formula bar, search across all sheets, zoom |
| Older spreadsheets (`.xls`, `.xlsm`, `.ods`) | Yes | Saved as a new `.xlsx` copy | Same as above |
| CSV (`.csv`) | Yes | Yes, as `.csv` | Same as above |
| PowerPoint (`.pptx`, `.ppt`, `.ppsx`, `.pptm`) | Yes | View only | Slideshow with transitions, print |

Also included: open downloads automatically, drag and drop from Chrome's downloads list, a recent files list, and light and dark appearance.

## Using DocDrop

1. Click the DocDrop icon in the toolbar.
2. Flip the switch on. From now on, supported files open in a tab as soon as they finish downloading.
3. Click **Open DocDrop** at any time to get the drop tab, then drag a file onto it or click **Open a file**.

To edit, click **Edit**, make your changes, then click **Save**. If DocDrop opened the file from your computer (through **Open** or drag and drop), Save writes straight back to that file after asking your permission once. Otherwise it asks where to save.

### Keyboard shortcuts

| Keys | Action |
|---|---|
| Ctrl+O | Open a file |
| Ctrl+S / Ctrl+Shift+S | Save / Save as (while editing) |
| Ctrl+F | Search in the file |
| Ctrl+P | Print |
| Ctrl+Z | Undo (spreadsheets, while editing) |
| Arrow keys, Tab, Enter | Move around a spreadsheet |
| Type or F2 | Edit the selected cell |
| Delete | Clear the selected cell |

On a Mac, use Cmd instead of Ctrl.

## Installing

### From a release (easiest)

1. Download the latest `docdrop-vX.Y.Z.zip` from the [Releases](../../releases) page and unzip it.
2. Go to `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and choose the unzipped folder (the one containing `manifest.json`).
4. Click **Details** on DocDrop and turn on **Allow access to file URLs**, so downloads can open automatically.

### Building it yourself

You need Node.js 20 or newer. GitHub Codespaces already has it.

```bash
npm install
npm run build
```

The finished extension is in the `dist` folder. Load that folder in Chrome as described above. `npm run package` builds it and also creates `docdrop-vX.Y.Z.zip`, ready for the Chrome Web Store.

### Releasing a new version

1. Update the version in both `package.json` and `public/manifest.json`, and add a note to `CHANGELOG.md`.
2. Commit, then tag and push:
   ```bash
   git tag v2.0.0
   git push origin main --tags
   ```
3. GitHub Actions builds the extension and publishes a Release with the zip attached.

## Limits worth knowing

- **Word:** the layout is very close to Word but not guaranteed identical for every file. Rare features (SmartArt, equations, embedded objects) may not edit well, and pages can shift slightly if your computer is missing a font the document uses.
- **Spreadsheets:** formulas are kept and recalculated when the file is next opened in Excel; DocDrop shows the last calculated result but does not calculate new formulas itself. Very large sheets show the first 10,000 rows. Inserting or deleting rows does not move merged cells.
- **Older formats:** `.xls`, `.xlsm` and `.ods` files are saved as a new `.xlsx` copy. Macros in `.xlsm` files are not kept.
- **PowerPoint:** view and present only. Unusual fonts fall back to similar ones.
- **Old Word files** (`.doc`, Word 97-2003) are not supported.

## Privacy

DocDrop has no servers, no accounts, no analytics and no ads. Files are opened and saved on your computer, and the recent files list is stored only inside the extension on your computer (clear it from the DocDrop tab at any time). See [PRIVACY.md](PRIVACY.md).

## Project structure

```
public/
  manifest.json       Extension settings and permissions (Manifest V3)
  icons/              Toolbar and store icons
src/
  background.js       On/off switch, drop tab, opening finished downloads
  viewer.html         The DocDrop tab
  popup.html          The panel shown when you click the toolbar icon
  viewer/
    main.js           Opens files, runs the toolbar, search, save and print
    docx.js           Word documents (SuperDoc)
    sheets.js         Spreadsheets (ExcelJS and SheetJS)
    slides.js         PowerPoint (pptx-vanilla-viewer)
    files.js          Reading from disk, drag and drop, saving
    styles.css        Look and feel, light and dark themes, print layout
  popup/              Popup script and styles
  shared/             File types, recent files, appearance
.github/workflows/    Automatic builds and releases
```

## Credits and licences

Created by Dave. DocDrop is free software, licensed under the GNU Affero General Public License v3.0 (see [LICENSE](LICENSE)). It is built on these open-source projects:

- [SuperDoc](https://github.com/superdoc-dev/superdoc) by Harbour, AGPL-3.0: Word viewing and editing
- [pptx-viewer](https://github.com/ChristopherVR/pptx-viewer) by ChristopherVR, Apache-2.0: PowerPoint viewing and slideshows
- [ExcelJS](https://github.com/exceljs/exceljs), MIT: reading and writing Excel files with formatting
- [SheetJS Community Edition](https://sheetjs.com/), Apache-2.0: older spreadsheet formats and number formatting
- [three.js](https://threejs.org/), MIT: optional 3D rendering used by the PowerPoint viewer

Each build copies these projects' licence and notice files into `dist/licenses`. See [NOTICE.md](NOTICE.md) for details.
