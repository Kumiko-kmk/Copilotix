# Using Copilotix

## Quick Model Source Configuration
Copilotix uses `huggingface` as the default model source. If users cannot access `huggingface` due to network restrictions, they can conveniently switch the model source to `modelscope` through environment variables:
```bash
export COPILOTIX_MODEL_SOURCE=modelscope
```
For more information about model source configuration and custom local model paths, please refer to the [Model Source Documentation](./model_source.md) in the documentation.

## Quick Usage via Command Line
Copilotix has built-in command line tools that allow users to quickly use Copilotix for document parsing through the command line:
```bash
copilotix -p <input_path> -o <output_path>
```
> [!TIP]
>- `<input_path>`: Local `PDF` / image / `DOCX` / `PPTX` / `XLSX` file or directory
>- `<output_path>`: Output directory
>- Without `--api-url`, the CLI launches a temporary local `copilotix-api`
>- With `--api-url`, the CLI connects to an existing local or remote FastAPI service directly
>
> For more information about output files, please refer to [Output File Documentation](../reference/output_files.md).

> [!NOTE]
> The command line tool will automatically attempt cuda/mps acceleration on Linux and macOS systems.
> Windows users who need cuda acceleration should visit the [PyTorch official website](https://pytorch.org/get-started/locally/) to select the appropriate command for their cuda version to install acceleration-enabled `torch` and `torchvision`.

If you need to adjust parsing options through custom parameters, you can also check the more detailed [Command Line Tools Usage Instructions](./cli_tools.md) in the documentation.

## Advanced Usage via API, WebUI, http-client/server

- FastAPI calls:
  ```bash
  copilotix-api --host 0.0.0.0 --port 8000
  ```
  >[!TIP]
  >Access `http://127.0.0.1:8000/docs` in your browser to view the API documentation.
  >
  >- Health endpoint: `GET /health`
  >  Returns `protocol_version`, `processing_window_size`, `max_concurrent_requests`, and task stats
  >- Asynchronous task submission endpoint: `POST /tasks`
  >- Synchronous parsing endpoint: `POST /file_parse`
  >- Task query endpoints: `GET /tasks/{task_id}`, `GET /tasks/{task_id}/result`
  >- API outputs are controlled by the server and written to `./output` by default
  >- Uploads currently support `PDF`, image, `DOCX`, `PPTX`, and `XLSX` files
  >
  >- `POST /tasks` returns immediately with a `task_id`. `POST /file_parse` uses the same task manager internally, waits for the task to finish, and then returns the final result synchronously.
  >- When a task is waiting in the queue, both the submission response and task-status response may include `queued_ahead` to indicate how many tasks are ahead of it.
  >- Tasks are tracked only in-process for a single `copilotix-api` instance. Task status is not preserved across service restarts, `--reload`, or multi-process deployments.
  >- Completed or failed tasks are retained for 24 hours by default, then their task state and output directory are cleaned automatically. After cleanup, task status and result endpoints return `404`.
  >- Use `COPILOTIX_API_TASK_RETENTION_SECONDS` and `COPILOTIX_API_TASK_CLEANUP_INTERVAL_SECONDS` to adjust retention and cleanup polling intervals.
  >- Use `--enable-vlm-preload true` to warm up the local VLM model during service startup instead of waiting for the first VLM or hybrid request.
  >
  >Asynchronous task submission example:
  >```bash
  >curl -X POST http://127.0.0.1:8000/tasks \
  >  -F "files=@demo/pdfs/demo1.pdf" \
  >  -F "return_md=true"
  >```
  >
  >Synchronous parsing example:
  >```bash
  >curl -X POST http://127.0.0.1:8000/file_parse \
  >  -F "files=@demo/pdfs/demo1.pdf" \
  >  -F "return_md=true" \
  >  -F "response_format_zip=true" \
  >  -F "return_original_file=true"
  >```
  >
  >Poll task status and fetch results:
  >```bash
  >curl http://127.0.0.1:8000/tasks/<task_id>
  >curl http://127.0.0.1:8000/tasks/<task_id>/result
  >curl http://127.0.0.1:8000/health
  >```
  >
  >HTTP asynchronous call code example: [Python version](https://github.com/Kumiko-kmk/Copilotix/blob/master/demo/demo.py)

- Start Gradio WebUI visual frontend:
  ```bash
  copilotix-gradio --server-name 0.0.0.0 --server-port 7860
  ```
  >[!TIP]
  >
  >- Access `http://127.0.0.1:7860` in your browser to use the Gradio WebUI.
  >- Without `--api-url`, Gradio starts a reusable local `copilotix-api`; with `--api-url`, it reuses an existing local or remote service.
  >- `--enable-vlm-preload true` makes Gradio start its local `copilotix-api` during WebUI startup and wait for VLM preload to finish. It is ignored when `--api-url` points to an existing service.
  >- The WebUI currently accepts `PDF`, image, `DOCX`, `PPTX`, and `XLSX` uploads.

- Use `copilotix-router` for multi-service / multi-GPU orchestration:
  ```bash
  copilotix-router --host 0.0.0.0 --port 8002 --local-gpus auto
  ```
  >[!TIP]
  >
  >- `copilotix-router` exposes the same `/health`, `/tasks`, `/file_parse`, `/tasks/{task_id}`, and `/tasks/{task_id}/result` interface set as `copilotix-api`.
  >- Repeat `--upstream-url` to aggregate multiple existing `copilotix-api` services, or use `--local-gpus` to launch local workers automatically.
  >- `--enable-vlm-preload true` only applies to router-managed local workers. It does not preload remote services passed through `--upstream-url`.
  >- It is intended for advanced multi-service, multi-GPU, and unified-entry deployments.

- Using `http-client/server` method:
  ```bash
  # Start openai compatible server (requires vllm or lmdeploy environment)
  copilotix-openai-server --port 30000
  ```
  >[!TIP]
  >In another terminal, connect to openai server via http client
  > ```bash
  > copilotix -p <input_path> -o <output_path> -b hybrid-http-client -u http://127.0.0.1:30000
  > ```
  >`vlm-http-client` is the lightweight remote client option and does not require local `torch`.
  >`hybrid-http-client` requires local pipeline dependencies such as `copilotix[pipeline]` and `torch`.

> [!NOTE]
> All officially supported `vllm/lmdeploy` parameters can be passed to Copilotix through command line arguments, including the following commands: `copilotix`, `copilotix-openai-server`, `copilotix-gradio`, `copilotix-api`, `copilotix-router`.
> We have compiled some commonly used parameters and usage methods for `vllm/lmdeploy`, which can be found in the documentation [Advanced Command Line Parameters](./advanced_cli_parameters.md).

## Extending Copilotix Functionality with Configuration Files

Copilotix is now ready to use out of the box, but also supports extending functionality through configuration files. You can edit `copilotix.json` file in your user directory to add custom configurations.

>[!IMPORTANT]
>The `copilotix.json` file will be automatically generated when you use the built-in model download command `copilotix-models-download`, or you can create it by copying the [configuration template file](https://github.com/Kumiko-kmk/Copilotix/blob/master/copilotix.template.json) to your user directory and renaming it to `copilotix.json`.

Here are some available configuration options:

- `latex-delimiter-config`:
    * Used to configure LaTeX formula delimiters
    * Defaults to `$` symbol, can be modified to other symbols or strings as needed.

- `llm-aided-config`:
    * Used to configure parameters for LLM-assisted title hierarchy
    * Compatible with all LLM models supporting `openai protocol`, defaults to using Alibaba Cloud Bailian's `qwen3-next-80b-a3b-instruct` model.
    * You need to configure your own API key and set `enable` to `true` to enable this feature.
    * If your API provider does not support the `enable_thinking` parameter, please manually remove it.
        * For example, in your configuration file, the `llm-aided-config` section may look like:
          ```json
          "llm-aided-config": {
             "api_key": "your_api_key",
             "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
             "model": "qwen3-next-80b-a3b-instruct",
             "enable_thinking": false,
             "enable": false
          }
          ```
        * To remove the `enable_thinking` parameter, simply delete the line containing `"enable_thinking": false`, resulting in:
          ```json
          "llm-aided-config": {
             "api_key": "your_api_key",
             "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
             "model": "qwen3-next-80b-a3b-instruct",
             "enable": false
          }
          ```

- `models-dir`:
    * Used to specify local model storage directory
    * Please specify model directories for `pipeline` and `vlm` backends separately.
    * After specifying the directory, you can use local models by configuring the environment variable `export COPILOTIX_MODEL_SOURCE=local`.
