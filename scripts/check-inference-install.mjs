#!/usr/bin/env node

try {
  // Resolution alone misses broken transitive native dependencies. Importing
  // Transformers loads them without creating a session or downloading a model.
  await import('@huggingface/transformers');
  console.log('[inference-install] Local inference dependencies loaded successfully.');
} catch (error) {
  console.error(
    '[inference-install] Cannot load @huggingface/transformers. npm can omit this optional ' +
      'dependency after an installation failure, but building and verifying this repository ' +
      'require it. Run npm ci --foreground-scripts and inspect the installer output. ' +
      'For CPU-only CI, set ONNXRUNTIME_NODE_INSTALL=skip to avoid extra CUDA downloads.',
  );
  console.error(error);
  process.exitCode = 1;
}
