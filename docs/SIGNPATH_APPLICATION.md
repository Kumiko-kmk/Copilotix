# SignPath application preparation

Status: prepared locally, not submitted. The configured GitHub repository returns
404 to anonymous access as checked on 2026-09-28. A public repository address,
public release and contact email still need confirmation.

## Project information

- Project: Copilotix
- Maintainer / GitHub handle: Kumiko-kmk
- Configured source URL: https://github.com/Kumiko-kmk/Copilotix
- License selected locally: MIT, copyright 2026 Kumiko-kmk
- Platform: Windows x64, Electron desktop application
- Application page: https://signpath.org/apply.html
- Code signing policy: docs/CODE_SIGNING_POLICY.md
- Desired publisher: SignPath Foundation (accepted by maintainer)

## Description for the application

Copilotix is a desktop application for reading and translating research papers.
It calls the MinerU online API to parse PDFs, displays local Markdown and PDF
artifacts, and translates content using providers selected by the user. It supports
local document-library backup, restore and migration. The desktop runtime contains
no local MinerU Python engine or model weights. The repository originated as a
MinerU fork; the unused Python implementation has been removed from the current
local master working tree. The project's own code is MIT licensed; third-party
components retain their original licenses.

## Build and verification

Windows CI uses pnpm, builds Main/Preload/Renderer/Utility bundles, applies Electron
fuses before signing, and packages the complete Windows runtime. The current local
checks passed type checking, lint (49 existing warnings), 75 test files and 389 tests
with 3 skipped tests. A public signing integration is not active yet.

The current production workflow accepts file-based signing credentials. SignPath
requires its own CI artifact submission and approval flow; do not claim that adding
a SignPath token alone enables this existing workflow. After onboarding, integrate
signing after fuses/resource changes and before final ZIP hashes, and verify the
returned executable's signature before publishing.

## Information still required

- Contact email and publicly accessible repository URL.
- Public source revision containing the MIT cleanup and signing policy.
- Existing public Windows release URL and verifiable build origin.
- Confirmed GitHub / SignPath MFA and approved signing roles.
- SignPath review of project eligibility, including project reputation.

Do not state the project already satisfies these requirements until verified.
No credentials, certificates, identity documents or private information belong here.
