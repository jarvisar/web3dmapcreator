---
description: Verify the checkout with type checks, unit tests, a real generation and a browser run
---

Read [shared project context](../../CLAUDE.md). Run from the repository root.
There is no fixed expected test count or mesh count.

1. Type check and run the unit tests (no network):

   ```powershell
   npx tsc --noEmit
   npm test
   ```

2. For data layer changes, run the live tests too:

   ```powershell
   $env:NETWORK = '1'; npx vitest run src/core/data; Remove-Item Env:NETWORK
   ```

3. Generate real areas end to end and check every part reports `open 0 repeated 0`:

   ```powershell
   npx tsx scripts/generate.ts --preset "Chicago - The Loop (small)" --out out/loop.3mf
   npx tsx scripts/generate.ts --preset "Clearwater - Beach and Downtown"
   npx tsx scripts/generate.ts --preset "Rome - Historic Centre" --bridges
   ```

   For geometry changes also look at the result, not only the counts.

4. For export changes, round-trip the sample projects through the installed
   Bambu Studio (it gets its own data folder):

   ```powershell
   npx tsx scripts/check-bambu.ts
   ```

5. For interface changes, build and run the site in the installed Edge:

   ```powershell
   npm run build
   npx vite preview --port 4173 --strictPort   # in the background
   node scripts/e2e.mjs http://localhost:4173/ out/e2e
   ```

   Look at the screenshots in `out/e2e` and report console errors. Stop the
   preview server afterwards.

Report failures with their output. Say which steps were skipped and why.
