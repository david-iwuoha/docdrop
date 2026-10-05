# Notices

DocDrop
Copyright (C) 2026 Dave

This program is free software: you can redistribute it and/or modify it under the terms of the GNU Affero General Public License as published by the Free Software Foundation, version 3. It is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the LICENSE file for details.

Source code: this repository.

## Third-party software

DocDrop bundles the following software. Their licence and notice files are copied into `dist/licenses` on every build.

| Project | Licence | Use in DocDrop |
|---|---|---|
| SuperDoc (Harbour and contributors) | AGPL-3.0 | Word viewing and editing |
| pptx-viewer / pptx-vanilla-viewer (ChristopherVR and contributors) | Apache-2.0 (some bundled parts carry their own licences, listed in its NOTICE file) | PowerPoint viewing and slideshows |
| ExcelJS | MIT | Excel reading and writing |
| SheetJS Community Edition | Apache-2.0 | Older spreadsheet formats, number formatting |
| three.js | MIT | Optional 3D rendering inside the PowerPoint viewer |
| PDF.js (Mozilla) | Apache-2.0 | PDF viewing |
| pdf-lib | MIT | Saving PDF edits |
| MuPDF.js (Artifex) | AGPL-3.0 | Removing old text when existing PDF text is changed |

These projects have not been modified; DocDrop uses them as published on npm (SheetJS from its official CDN).
