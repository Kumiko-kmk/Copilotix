# Third-party components and services

The MIT license in LICENSE.md applies to Copilotix's own code and documentation.
It does not replace licenses for third-party dependencies, fonts, images, or services.

Copilotix uses Electron (including Chromium and Node.js), React, Ant Design,
PDF.js, KaTeX, and other packages listed in desktop/package.json and pnpm-lock.yaml.
Their copyright and license notices remain applicable. Electron's LICENSE and
LICENSES.chromium.html must remain in the distributed runtime. Dependency license
files must not be removed from bundled packages. Inspect the locked dependency
versions when preparing a release; this list is an orientation, not an exhaustive
dependency license inventory.

PDF parsing calls the remote MinerU API (https://mineru.net/); no local MinerU
Python engine or model weights are included in the desktop runtime. Use of that
service is subject to its own terms. Translation services likewise retain their
own terms; Copilotix's MIT license does not grant rights to those services.

The repository historically originated as a MinerU fork. The unused Python
engine, model asset, Docker files and Python CI were removed from the current
master working tree on 2026-09-28. Historical commits retain their original
licenses and attribution; the current MIT declaration does not relicense them.
The application logo was supplied by the project maintainer.

The distribution also includes resources/licenses/THIRD_PARTY_LICENSES.txt, generated
from installed dependency roots at packaging time. It includes development tools as
well as runtime packages and explicitly lists packages without root license text.
This inventory supplements, and does not replace, embedded package notices.
