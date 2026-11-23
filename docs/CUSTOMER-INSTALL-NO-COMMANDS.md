# PesoWise → Tally (customer PC)

## One file

1. **Download** [PesoWiseSync.exe](/downloads/PesoWiseSync.exe) on the PC where TallyPrime runs.
2. **Double-click** `PesoWiseSync.exe`.
   - First time: a browser page opens → in PesoWise (Admin → Tally integration) click **Prepare this PC** → paste the code → **Connect**.
   - Later: double-click only starts background sync (small message box).
3. **TallyPrime once**: F12 → load `PesoWise-Bootstrap.tdl` and `PesoWise-Load.tdl` from `C:\pesowise` → restart Tally → open company → F1 → HTTP port **9000**.
4. **PesoWise**: Reports → **Sync to Tally** → view in Tally **Gateway → PesoWise Reports**.

Rebuild the exe for the website: `npm run build:pesowise-sync` (requires `.env.local` with Supabase URL + anon key).
