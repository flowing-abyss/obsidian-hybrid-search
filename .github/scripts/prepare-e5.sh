#!/usr/bin/env bash
set -euo pipefail

# Populate the same file cache Transformers uses for the CI embedding model.
# Retry transfers here so a dropped connection never reruns a test or evaluation.
model=Xenova/multilingual-e5-small
cache="$HOME/.cache/huggingface/$model"
mkdir -p "$cache/onnx"
for file in config.json tokenizer_config.json tokenizer.json onnx/model_quantized.onnx; do
  target="$cache/$file"
  if [[ -s "$target" ]]; then continue; fi
  partial=$(mktemp "$target.XXXXXX")
  trap 'rm -f "$partial"' EXIT
  curl --fail --location --silent --show-error --retry 3 --retry-all-errors \
    --connect-timeout 30 --max-time 300 --output "$partial" \
    "https://huggingface.co/$model/resolve/main/$file"
  mv "$partial" "$target"
  trap - EXIT
done
