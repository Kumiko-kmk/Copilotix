# Code signing policy

Production signing is not active. A SignPath Foundation submission was attempted on 2026-09-28 without a confirmed receipt or approval. No sponsorship or trusted signed release is claimed; local self-signed certificates are test-only.

## Responsibilities and approval

Maintainer [Kumiko-kmk](https://github.com/Kumiko-kmk) is the proposed author, reviewer and signing approver. External contributions require maintainer review. Production signing must correspond to a verifiable CI build from the released source revision; every signing request needs manual maintainer approval. Verify provider eligibility, MFA and signing roles before onboarding; this document does not attest current MFA status. Only Copilotix artifacts are submitted, preserving third-party signatures and notices. If approved, the publisher is SignPath Foundation and required attribution must be added.

## Exact-tag unsigned exceptions

Unsigned releases require explicit authorization **for each version**, a workflow allowlist for that exact tag and its matching repository variable; previous authorization never covers a new version.

| Authorized tag | Authorization | Required variable |
|---|---|---|
| desktop-v1.0.0 | Initial bootstrap exception | COPILOTIX_UNSIGNED_BOOTSTRAP_RELEASE=desktop-v1.0.0 |
| desktop-v1.1.0 | 2026-10-07 | COPILOTIX_UNSIGNED_RELEASE_TAG=desktop-v1.1.0 |
| desktop-v1.2.0 | 2026-10-18 | COPILOTIX_UNSIGNED_RELEASE_TAG=desktop-v1.2.0 |
| desktop-v1.3.0 | 2026-10-27, this version only | COPILOTIX_UNSIGNED_RELEASE_TAG=desktop-v1.3.0 |
| desktop-lite-v1.0.0 | 2026-11-08, maintainer explicitly authorized Lite 1.0 only | COPILOTIX_UNSIGNED_LITE_RELEASE_TAG=desktop-lite-v1.0.0 |

Release notes must clearly disclose unsigned binaries. All regression, packaging, installation and remote integrity gates still apply. Failed gates leave the release unpublished; retry from the verified revision. Remove the exception variable after successful publication. All other releases require trusted signing. Configuration is documented in [signing setup](LICENSE_AND_SIGNING_ZH.md); artifact validation and publication in [release contract](DESKTOP_RELEASE_ZH.md).

## Privacy and removal

Parsing sends PDFs to MinerU; translation, chat and insight send required content to enabled providers. Credentials remain in Windows credential storage and are excluded from library backups. Review the selected providers' terms before uploading. Signing never includes user documents or credentials.

Windows Setup installs for the current user. Exit after tasks finish before upgrade/removal. Uninstall preserves library, settings and credentials by default; personal-data removal needs explicit confirmation. See [installation](WINDOWS_INSTALLATION_ZH.md) and [backup/recovery](LIBRARY_MANAGEMENT_ZH.md).
