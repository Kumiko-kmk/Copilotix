# Model Source Documentation

Copilotix uses `HuggingFace` and `ModelScope` as model repositories. Users can switch model sources or use local models as needed.

- `auto` is the default model source policy. It first checks whether Hugging Face is accessible. If accessible, Copilotix uses `HuggingFace`, otherwise it automatically falls back to `ModelScope`.
- `HuggingFace` provides excellent loading speed and high stability globally.
- `ModelScope` is the best choice for users in mainland China, providing seamlessly compatible `hf` SDK modules, suitable for users who cannot access HuggingFace.

## Methods to Switch Model Sources

### Configure via Environment Variables
Copilotix configures model sources through the `COPILOTIX_MODEL_SOURCE` environment variable. This applies to all command line tools and API calls. Supported values are `huggingface`, `modelscope`, and `local`. The environment variable has higher priority than `model-source` in `copilotix.json`. Do not set this environment variable to `auto`; unset it if you want Copilotix to choose a source automatically.
```bash
export COPILOTIX_MODEL_SOURCE=modelscope
copilotix -p <input_path> -o <output_path>
```
or set it programmatically:
```python
import os
os.environ["COPILOTIX_MODEL_SOURCE"] = "modelscope"
```
>[!TIP]
> Copilotix no longer provides a CLI flag for model source selection. Model sources set through environment variables take effect in the current terminal session until the terminal is closed or the environment variable is modified.

### Configure via Configuration File
If `COPILOTIX_MODEL_SOURCE` is not set, Copilotix reads the `model-source` field from `copilotix.json` in the user directory. `model-source` supports fixed values `huggingface` and `modelscope`, and also supports the template's first-run placeholder value `auto`. When the value is `auto` or the field is missing, Copilotix probes the actual source first. After the first auto probe resolves an actual source, Copilotix writes `model-source` back as `huggingface` or `modelscope` to avoid switching sources on later startups due to network fluctuations.
```json
{
    "model-source": "auto"
}
```

## Using Local Models

### 1. Download Models to Local Storage
```bash
copilotix-models-download --help
```
or use the interactive command line tool to select model downloads:
```bash
copilotix-models-download
```
> [!NOTE]
>- After download completion, the model path will be output in the current terminal window and automatically written to `copilotix.json` in the user directory. The `model-source` field records the actual remote source used for this download, either `huggingface` or `modelscope`.
>- You can also create it by copying the [configuration template file](https://github.com/Kumiko-kmk/Copilotix/blob/master/copilotix.template.json) to your user directory and renaming it to `copilotix.json`. The template sets `model-source` to `auto`, so Copilotix auto-detects once and writes back the resolved source on first use.
>- After downloading models locally, you can freely move the model folder to other locations while updating the model path in `copilotix.json`.
>- If you deploy the model folder to another server, please ensure you move the `copilotix.json` file to the user directory of the new device and configure the model path correctly.
>- If you need to update model files, you can run the `copilotix-models-download` command again. Model updates do not support custom paths currently - if you haven't moved the local model folder, model files will be incrementally updated; if you have moved the model folder, model files will be re-downloaded to the default location and `copilotix.json` will be updated.
>- `copilotix-models-download` must use a remote model source to perform a real download. If your current shell already sets `COPILOTIX_MODEL_SOURCE=local`, this command will temporarily ignore that value for this invocation and use your selected `auto`, `huggingface`, or `modelscope` source instead.

### 2. Use Local Models for Parsing

Enable local models through environment variables:
```bash
export COPILOTIX_MODEL_SOURCE=local
copilotix -p <input_path> -o <output_path>
```
