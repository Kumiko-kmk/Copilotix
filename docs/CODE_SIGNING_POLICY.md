# Code signing policy

Status: SignPath Foundation application submission attempted; receipt and approval not yet confirmed.
Copilotix has published unsigned releases under the exact-tag exceptions below. The locally generated
self-signed certificate is for testing only and is not used for public releases.

The SignPath application was attempted on 2026-09-28 without a confirmed receipt.
A public signing integration is not active; confirm the receipt, eligibility, MFA
and signing roles before onboarding. Adding a token alone does not enable signing.
The current file-certificate setup is documented in [signing configuration](LICENSE_AND_SIGNING_ZH.md).

## Proposed responsibilities

- Author, reviewer and signing approver: [Kumiko-kmk](https://github.com/Kumiko-kmk).
- External contributions require maintainer review before release.
- Production signing must use a verifiable CI build from the released source revision.
- Each signing request requires manual maintainer approval. SignPath and GitHub MFA
  must be enabled before onboarding; this document does not attest current MFA status.
- Only Copilotix application artifacts may be submitted for signing. Third-party
  executables retain their original signatures and license notices.

If accepted, the signing publisher will be SignPath Foundation. The required
provider attribution will be added when the service is approved and active.
No SignPath sponsorship or signed release is claimed at this stage.

On 2026-10-07 the maintainer explicitly authorized one additional unsigned
release, `desktop-v1.1.0`. The workflow requires that exact tag and the matching
repository variable `COPILOTIX_UNSIGNED_RELEASE_TAG=desktop-v1.1.0`; this is not a
blanket exemption for future releases. Release notes must clearly state that the
binaries are unsigned. All build, test, integrity and installation checks remain
required. Remove the variable after publication; other tags require trusted signing.

On 2026-10-18 the maintainer explicitly authorized one unsigned release,
`desktop-v1.2.0`. The workflow permits only that exact tag with
`COPILOTIX_UNSIGNED_RELEASE_TAG=desktop-v1.2.0`. This authorization does not
extend to later releases. The release notes disclose the unsigned binaries;
all build, test, integrity and installation checks remain required. Remove the
repository variable after publication to close this one-time exception.

## Network use and privacy

On 2026-10-27 the maintainer explicitly authorized one unsigned release,
`desktop-v1.3.0`. The workflow permits this exception only when the exact tag
matches `COPILOTIX_UNSIGNED_RELEASE_TAG=desktop-v1.3.0`. Release notes disclose
the unsigned installer; all regression, package, installation and remote asset
integrity checks remain required. Remove the variable after successful publication.
This authorization does not extend to subsequent versions. Recovery is to leave
the release unpublished on any failed gate and retry from the verified revision;
no library or installer format change is introduced by this exception.

When a user starts parsing, PDF content is uploaded to the configured parsing
service (MinerU). Translation requests transmit the relevant document text to
the translation provider enabled by the user. Service validation sends requests
to the relevant provider. These operations require user-supplied credentials.
Local backups exclude API credentials; Windows credential storage protects saved
keys. Users should review the terms and privacy policies of their chosen providers
before uploading documents. See the service links and data-flow description in
[the README](../README.md).

## Removal

The primary Windows distribution is a guided Setup installer for the current user;
older releases also offered a complete portable ZIP. Starting with 1.2.0, public
release downloads contain only Setup and the source archives. Production signing covers both
the application executable and Setup executable before final hashes and publication.
Exit Copilotix through the tray menu after tasks finish before upgrading or removing
the program. Uninstall through Windows installed applications; portable users may
delete the complete extracted runtime directory. Removal preserves the document
library, settings and stored credentials. See the [installation guide](WINDOWS_INSTALLATION_ZH.md).
Back up the library first if removing personal data separately; use the documented
[backup and migration controls](LIBRARY_MANAGEMENT_ZH.md). Stored provider keys can
be removed from the service settings before removing the application.
