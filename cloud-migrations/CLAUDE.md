# Cloud Migration - Best Practices & Learnings

## Presentation Overview

A presentation on cloud migration best practices and learnings, with a focus on migrating regulated companies to the cloud. Covers regulatory, sovereignty, security, and technical aspects.

## Slide Order

Sections are loaded in this order (see `index.html`):

1. `header.html` — title slide
2. `jochen.html` — speaker intro (symlink to shared file)
3. `disclaimer.html` — disclaimer
4. `why-migrate.html` — business and technology drivers for migration
5. `cloud.html` — cloud fundamentals, service models, infrastructure
6. `regulatory.html` — legal, regulations (nDSG, FINMA, GDPR), sovereignty
7. `regulatory-v2.html` — *temporary* draft rework of the regulatory section, loaded right after the original for side-by-side review. Will be removed once the user picks a winner; the chosen file then takes over `regulatory.html`.
8. `security.html` — shared responsibility, IAM, data center security
9. `migration-strategies.html` — the 7 Rs framework
10. `migrate-regulated-company.html` — FINMA-regulated company use case
11. `technical.html` — account vending, IaC, event-driven
12. `learnings.html` — organizational, technical, and FinOps learnings

## Local Development

```bash
npm run start:cloud-migrations
```
