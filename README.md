# Copilotix

Copilotix is a Windows desktop workspace for importing research PDFs, tracking durable parsing and translation jobs, and reading synchronized PDF and Markdown artifacts.

## Desktop application

The Electron application lives in `desktop/` and uses four isolated bundles:

- React renderer for tasks, settings, and the reader;
- validated preload domain API exposed as `window.copilotix`;
- Electron main process for permissions, credentials, network access, and orchestration;
- supervised utility process for SQLite, artifact I/O, and compute work.

The renderer is sandboxed and has no direct access to Node.js, the file system, credentials, or arbitrary IPC channels.

## Development

Requirements: Windows x64, Node.js 24, and pnpm 11.19.0.

```powershell
pnpm install
pnpm desktop:typecheck
pnpm desktop:lint
pnpm desktop:test
pnpm desktop:build
```

Create a verified directory release with `pnpm desktop:release`. The pipeline audits all four bundles, the ASAR and runtime layout, hashes, and the packaged CLI smoke check before atomically publishing `release/Copilotix-<version>-win-x64/`.

## Python package

The Python document-processing package is exposed as `copilotix`, with the `copilotix`, `copilotix-api`, `copilotix-router`, and `copilotix-gradio` command entry points.

## Documentation

- [Desktop development guide](desktop/README_zh-CN.md)
- [Architecture baseline](ARCHITECTURE_ZH.md)
- [RAG development plan](RAG_DEVELOPMENT_PLAN_ZH.md)
- [Chinese README](README_zh-CN.md)

Project source and issue tracking: <https://github.com/Kumiko-kmk/Copilotix>

## License

See [LICENSE.md](LICENSE.md). The repository retains required third-party dependency names and legal attribution where changing them would misstate licensing or break interoperability.
