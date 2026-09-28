# Code signing policy

Status: SignPath Foundation application preparation; not yet submitted or approved.
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

The Windows distribution is a portable directory. Exit Copilotix before deleting
its extracted runtime directory. This does not delete the document library or user
settings. Back up the library first if removing those separately; use the documented
[backup and migration controls](LIBRARY_MANAGEMENT_ZH.md). Stored provider keys can
be removed from the service settings before removing the application.
