# Code signing policy

Status: SignPath Foundation application submission attempted; receipt and approval not yet confirmed.
Copilotix currently provides local unsigned development builds. The locally generated
self-signed certificate is for testing only and is not used for public releases.

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

## Network use and privacy

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
the complete portable ZIP remains an alternative. Production signing covers both
the application executable and Setup executable before final hashes and publication.
Exit Copilotix through the tray menu after tasks finish before upgrading or removing
the program. Uninstall through Windows installed applications; portable users may
delete the complete extracted runtime directory. Removal preserves the document
library, settings and stored credentials. See the [installation guide](WINDOWS_INSTALLATION_ZH.md).
Back up the library first if removing personal data separately; use the documented
[backup and migration controls](LIBRARY_MANAGEMENT_ZH.md). Stored provider keys can
be removed from the service settings before removing the application.
