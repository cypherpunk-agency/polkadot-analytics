// The only script the knowledge base loads.
//
// These pages are static HTML emitted at build time by scripts/knowledge-plugin.mjs: the
// header, nav, table of contents and prose are all in the document before this runs, and the
// page reads correctly with scripting off. The one thing that cannot be baked in is the
// reader's theme choice, which lives in localStorage — so this applies it and wires the toggle
// that is already in the markup, and does nothing else.
//
// It also carries the stylesheet import, which is how the emitted pages get a real hashed CSS
// filename to point at: the plugin reads it back off this entry's chunk rather than guessing.

import '../../design/app.css'
import { mountShellBehaviour } from '../../design/shell.js'

mountShellBehaviour()
