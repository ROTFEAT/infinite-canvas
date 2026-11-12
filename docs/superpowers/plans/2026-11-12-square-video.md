# Square Video Implementation Plan

> For agentic workers: use superpowers:subagent-driven-development for the isolated UI/model change and independent spec/quality reviews.

**Goal:** Make 1:1 selectable and executable in both deployed H3 modes.
**Architecture:** Extend existing profile sizes and the shared video settings panel; native Comfy width/height inputs stay unchanged.
**Tech Stack:** React/TypeScript/Vitest, ComfyUI, Docker.

- [x] Baseline: run video-settings-panel, model registry, canvas generation helpers and reference submission targeted tests in the new worktree.
- [x] RED: tests for 768/1024 square normalization, parse labels, profile validation, aspect switching UI and exact submitted square dimensions.
- [x] GREEN: modify web/src/components/video-settings-panel.tsx and web/src/services/api/models/video-minimax-h3-omni.ts; adjust directly affected helpers/tests only. Keep old defaults and filter square vs rectangular tiers.
- [x] Independent spec review then quality review; fix blockers and rerun affected tests.
- [ ] Native tests: FL2VA768-square and REF2VA1024-square, 124frames/20steps, inspect dimensions and decode.
- [ ] Update AGENTS ratio exception, pending-test, TODO check and changelog; commit/tag/push feature branch only.
- [ ] Build tagged frontend on108, preserve config/queue volumes and workers, verify live browser UI and square dimensions in submitted jobs. Save screenshot and private runtime evidence, restore global parameters.
