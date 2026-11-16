# Manual TDL install — PesoWise Reports v2

1. Copy from repo to `C:\pesowise\`:
   - `tally-extension/PesoWise-Bootstrap.tdl`
   - `tally-extension/PesoWise-Reports.tdl`
   - entire folder `tally-extension/tdl/` → `C:\pesowise\tdl\`
2. **F12 → Manage Local TDLs** — load **Bootstrap** and **Reports** with **Load = Yes** (do not also `[Include]` Reports from Bootstrap).
3. Confirm **2 loaded, 0 errors**.
4. **Ctrl+Alt+R**.
5. **Gateway → PesoWise Reports (O)** → **V / A / E / D**.

Files in this folder mirror `tally-extension/tdl/` for review; prefer the repo `tally-extension` tree as source of truth.
