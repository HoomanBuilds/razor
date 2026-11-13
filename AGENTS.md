# Project workflow

- Build Razor's company payments, payroll and treasury workflows first. Marketing pages and visual polish come last.
- Use at most three feature worktrees in `.worktrees/`. Review and merge finished work, then remove its worktree before starting another slice.
- Do not commit `research/`, `inspiration/`, local credentials, databases or compiled contract artifacts.
- Reuse reviewed libraries and compatible source with required license notices. Legacy source is reference material, not runtime truth.
- Keep builds serialized across agents. Run one heavy build at a time, use one Rust build job and the repository's capped Next.js build settings. Check available memory before a build. Do not run production builds alongside a development server.
- Favor implementation and focused verification. Run the appropriate checks once after a meaningful change; repeat only for new failures or changes.
- Update `docs/build-checklist.md` only for demonstrated behavior. Keep credential-dependent, simulated and live settlement evidence distinct.
- Use conventional one-line commits without AI attribution. Do not use em dash or Unicode arrow characters in authored files.
