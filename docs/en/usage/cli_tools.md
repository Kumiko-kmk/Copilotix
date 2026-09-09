# Command Line Tools Usage Instructions

## View Help Information
To view help information for Copilotix command line tools, you can use the `--help` parameter. Here are help information examples for various command line tools:
```bash
copilotix --help
Usage: copilotix [OPTIONS]

Options:
  -v, --version                   Show version and exit
  -p, --path PATH                 Input file path or directory (required)
  -o, --output PATH               Output directory (required)
  --api-url TEXT                  Copilotix FastAPI base URL; if omitted, `copilotix` starts a temporary local `copilotix-api`
  -m, --method [auto|txt|ocr]     Parsing method: auto (default), txt, ocr (pipeline and hybrid* backend only)
  -b, --backend [pipeline|vlm-engine|hybrid-engine|vlm-http-client|hybrid-http-client]
                                  Parsing backend (default: hybrid-engine)
  --effort [medium|high]          Hybrid parsing effort (default: medium)
  -l, --lang [ch|ch_server|korean|ta|te|ka|th|el|arabic|east_slavic|cyrillic|devanagari]
                                  Specify document language (improves OCR accuracy, pipeline backend only)
  -u, --url TEXT                  OpenAI-compatible backend URL passed through to the server when using http-client
  -s, --start INTEGER             Starting page number for parsing (0-based)
  -e, --end INTEGER               Ending page number for parsing (0-based)
  -f, --formula BOOLEAN           Enable formula parsing (default: enabled)
  -t, --table BOOLEAN             Enable table parsing (default: enabled)
  --image-analysis BOOLEAN        Enable image/chart analysis for VLM and hybrid
                                  backends. Hybrid medium effort automatically
                                  disables image/chart analysis (default: enabled)
  --client-side-output-generation BOOLEAN
                                  Generate Markdown and content lists locally
                                  from server-returned middle JSON, images, and
                                  original files (default: disabled)
  --help                          Show help information
```
> [!TIP]
> `copilotix` currently supports local `PDF`, image, `DOCX`, `PPTX`, and `XLSX` file or directory inputs.

```bash
copilotix-api --help
Usage: copilotix-api [OPTIONS]

Options:
  --host TEXT     Server host (default: 127.0.0.1)
  --port INTEGER  Server port (default: 8000)
  --reload        Enable auto-reload (development mode)
  --enable-vlm-preload BOOLEAN
                  Preload the local VLM model during copilotix-api startup.
  --help          Show this message and exit.
```
```bash
copilotix-gradio --help
Usage: copilotix-gradio [OPTIONS]

Options:
  --enable-example BOOLEAN        Enable example files for input. The example
                                  files to be input need to be placed in the
                                  `examples` folder within the directory where
                                  the command is currently executed.
  --enable-http-client BOOLEAN    Enable http-client backend to link openai-
                                  compatible servers.
  --enable-api BOOLEAN            Enable gradio API for serving the
                                  application.
  --max-convert-pages INTEGER     Set the maximum number of pages to convert
                                  from PDF to Markdown.
  --server-name TEXT              Set the server name for the Gradio app.
  --server-port INTEGER           Set the server port for the Gradio app.
  --api-url TEXT                  Copilotix FastAPI base URL. If omitted, gradio
                                  starts a reusable local copilotix-api service.
  --enable-vlm-preload BOOLEAN    Preload the local VLM model when gradio
                                  starts a local copilotix-api service.
  --client-side-output-generation BOOLEAN
                                  Generate Markdown and content lists locally
                                  from server-returned middle JSON.
  --latex-delimiters-type [a|b|all]
                                  Set the type of LaTeX delimiters to use in
                                  Markdown rendering: 'a' for type '$', 'b' for
                                  type '()[]', 'all' for both types.
  --help                          Show this message and exit.
```
```bash
copilotix-router --help
Usage: copilotix-router [OPTIONS]

Options:
  --host TEXT             Server host (default: 127.0.0.1)
  --port INTEGER          Server port (default: 8002)
  --reload                Enable auto-reload (development mode)
  --upstream-url TEXT     Existing Copilotix FastAPI base URL; repeat to add more
  --local-gpus TEXT       Local GPU workers to launch: auto, none, or CSV such
                          as 0,1,2
  --worker-host TEXT      Host for router-managed workers (default: 127.0.0.1)
  --enable-vlm-preload BOOLEAN
                          Preload the local VLM model in router-managed
                          copilotix-api workers.
  --help                  Show this message and exit.
```

## Environment Variables Description

> [!NOTE]
> Starting from this version, `copilotix` is an orchestration client built on top of `copilotix-api`:
>
>- Without `--api-url`, the CLI launches a temporary local `copilotix-api`
>- With `--api-url`, the CLI connects to that FastAPI service directly
>- `--url` is no longer the Parser API address; it is the OpenAI-compatible backend URL used by server-side `vlm/hybrid-http-client`

Some parameters of Copilotix command line tools have equivalent environment variable configurations. Generally, environment variable configurations have higher priority than command line parameters and take effect across all command line tools.
Here are the environment variables and their descriptions:

- `COPILOTIX_TOOLS_CONFIG_JSON`:
    * Used to specify configuration file path
    * defaults to `copilotix.json` in user directory, can specify other configuration file paths through environment variables.

- `COPILOTIX_FORMULA_ENABLE`:
    * Used to enable formula parsing
    * defaults to `true`, can be set to `false` through environment variables to disable formula parsing.

- `COPILOTIX_FORMULA_CH_SUPPORT`:
    * Used to enable Chinese formula parsing optimization (experimental feature)
    * Default is `false`, can be set to `true` via environment variable to enable Chinese formula parsing optimization.
    * Only effective for `pipeline` backend.

- `COPILOTIX_TABLE_ENABLE`:
    * Used to enable table parsing
    * Default is `true`, can be set to `false` via environment variable to disable table parsing.

- `COPILOTIX_TABLE_MERGE_ENABLE`:
    * Used to enable table merging functionality
    * Default is `true`, can be set to `false` via environment variable to disable table merging functionality.

- `COPILOTIX_PDF_RENDER_TIMEOUT`:
    * Used to set the timeout (in seconds) for rendering PDFs to images.
    * Default is `300` seconds; you can set a different value via an environment variable to adjust the rendering timeout.
    * Effective on Linux, macOS, and Windows.

- `COPILOTIX_PDF_RENDER_THREADS`:
    * Used to set the render worker concurrency used when rendering PDFs to images.
    * Default is `4`; you can set a different value via an environment variable to adjust render worker concurrency.
    * Effective on Linux, macOS, and Windows.

- `COPILOTIX_PROCESSING_WINDOW_SIZE`:
    * Used to control the processing window size, which affects memory use and throughput on large-document workloads.
    * Default is `64`; set it to another positive integer when needed.

- `COPILOTIX_API_MAX_CONCURRENT_REQUESTS`:
    * Used to control the maximum concurrent requests handled by `copilotix-api` or router-managed workers.
    * Default is `3`, and it must be a positive integer.

- `COPILOTIX_API_ENABLE_FASTAPI_DOCS`:
    * Used to control whether FastAPI documentation endpoints such as `/docs`, `/openapi.json`, and `/redoc` are enabled.
    * Default is `true`.

- `COPILOTIX_API_OUTPUT_ROOT`:
    * Used to configure the root output directory for `copilotix-api`.
    * Default is `./output` under the current working directory.

- `COPILOTIX_LOCAL_API_STARTUP_TIMEOUT_SECONDS`:
    * Used to control how long CLI tools wait for a locally started `copilotix-api` to become healthy.
    * Default is `300` seconds.
    * Applies to temporary local API startup in `copilotix`, preload startup in `copilotix-gradio`, and router-managed local workers.

- `COPILOTIX_TASK_RESULT_TIMEOUT_SECONDS`:
    * Used to control how long clients wait for a task to complete and reach a terminal state.
    * Default is `3600` seconds, and the value must be greater than or equal to `1`.
    * Applies to task-status polling in `copilotix`, `copilotix-gradio`, `copilotix-router`, and other API-client scenarios.

- `COPILOTIX_TASK_RESULT_DOWNLOAD_TIMEOUT_SECONDS`:
    * Used to control the read timeout when retrieving completed task results, including waiting for server-side ZIP generation and downloading the result ZIP.
    * Default is `600` seconds, and the value must be greater than or equal to `1`.
    * This is not a hard limit for total download duration; if the server keeps returning data, the total download time may exceed this value.

- `COPILOTIX_API_TASK_RETENTION_SECONDS`:
    * Used to set how long completed or failed tasks are retained, in seconds.
    * Default is `86400` seconds (24 hours).

- `COPILOTIX_API_TASK_CLEANUP_INTERVAL_SECONDS`:
    * Used to set the cleanup polling interval for expired tasks, in seconds.
    * Default is `300` seconds (5 minutes).

- `COPILOTIX_INTRA_OP_NUM_THREADS`:
    * Used to set the intra_op thread count for ONNX models, affects the computation speed of individual operators
    * Default is `-1` (auto-select), can be set to other values via environment variable to adjust the thread count.

- `COPILOTIX_INTER_OP_NUM_THREADS`:
    * Used to set the inter_op thread count for ONNX models, affects the parallel execution of multiple operators
    * Default is `-1` (auto-select), can be set to other values via environment variable to adjust the thread count.

- `COPILOTIX_HYBRID_BATCH_RATIO`:
    * Used to set the batch ratio for small model processing in `hybrid-*` backends.
    * Commonly used in `hybrid-http-client`, it allows adjusting the VRAM usage of a single client by controlling the batch ratio of small models.
    * Single Client VRAM Size | COPILOTIX_HYBRID_BATCH_RATIO
      ------------------------|--------------------------
      <= 6   GB               | 8
      <= 4   GB               | 4
      <= 3   GB               | 2
      <= 2   GB               | 1

- `COPILOTIX_VL_MODEL_NAME`:
    * Used to specify the model name for the vlm/hybrid backend, allowing you to designate the model required for Copilotix to run when multiple models exist on a remote openai-server.

- `COPILOTIX_VL_API_KEY`:
    * Used to specify the API Key for the vlm/hybrid backend, enabling authentication on the remote openai-server.
