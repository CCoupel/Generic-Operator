# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [v0.0.2] - 2026-07-18

### Changed

- Moved the VIP egress controller (`CODE/2_VIP-controller.yml`) from the `secure-namespace`
  implementation into `templates/core/` alongside the operator. Both run the same generic
  render/apply pipeline (load templates order → load templates → Jinja2 render → apply/delete),
  so `templates/core/` now holds all Python engine code, while
  `templates/implementations/secure-namespace/` holds only declarative content (CRD, RBAC,
  Kyverno policies, Jinja2 templates).
- Replaced `.gitlab-ci.yml` with `.github/workflows/release.yml` (GitHub Actions) — the repo is
  hosted on GitHub, and the GitLab pipeline had no effect there. Same lint → package → publish
  flow, using the native `secrets.GITHUB_TOKEN` instead of a manually configured PAT.

### Verified

- First real end-to-end release: tag push → CI run → `helm package` → `helm push` to
  `oci://ghcr.io/ccoupel/charts/secure-namespace-operator` → anonymous `helm pull` all confirmed
  working. The ghcr.io package is public by default when published via the native
  `GITHUB_TOKEN` (inherits the repo's visibility).

## [v0.0.1] - 2026-07-18

### Added

- Initial public release: reorganized the chart into a generic, CRD-agnostic operator engine
  (`templates/core/`) plus `secure-namespace`, a full reference implementation
  (`templates/implementations/secure-namespace/`) providing security-first Kubernetes namespace
  provisioning.
- `values.yaml::crd` (`group`/`version`/`kind`/`plural`) now drives the CRD the engine watches —
  parameterized out of Python code and Helm templates instead of hardcoded.
- Kyverno `ClusterPolicy` admission rules (auto-naming, required-field validation) replacing a
  previous internal mutating webhook.
- CI/CD: packages the Helm chart and publishes it as an OCI artifact on tag push.
- MIT license.
- Documentation: root `README.md`, `CHARTS/README.md`, `documentation/README.md` (CRD field
  reference), `documentation/MAINTENANCE.md` (internals/troubleshooting),
  `documentation/HOWTO-NEW-IMPLEMENTATION.md` (building a new implementation on the engine).

### Security

- Anonymized all internal/organization-specific references (domains, IP addresses, chart
  metadata) prior to publishing.
