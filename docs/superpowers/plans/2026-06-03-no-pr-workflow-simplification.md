# No-PR Workflow Simplification Implementation Plan

**Goal:** Direct-to-main only — local pre-commit equals the deploy/main GitHub guard; remove PR workflows and duplicate CI.

**Status:** Implemented 2026-06-03 across `~/code` fleet repos.

## Summary

- Removed `noDeploy.yml`, PR triggers, Dependabot auto-merge, and duplicate markdown CI from stocktextalerts; deploy is the sole push guard.
- Updated dotagents fleet template: fleet-lock on `push` to `main` when `.agents/**` changes.
- Merged `ci.yml` into `deploy.yml` for family-memory and alert-hub.
- Removed branch/PR CI from GeoRoids, awesome-django-blog, checkboxes, jsolly-website, misc-notifications, todoist-backlog-scheduler.
- Tightened pre-commit hooks where deploy still runs extra checks.
