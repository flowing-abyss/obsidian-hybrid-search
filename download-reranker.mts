import { AutoTokenizer, AutoModelForSequenceClassification } from '@huggingface/transformers';

const MODEL = 'onnx-community/bge-reranker-v2-m3-ONNX';
console.log(`Downloading ${MODEL} (int8 quantized, ~32MB)...`);

const [tokenizer, model] = await Promise.all([
  (AutoTokenizer as any).from_pretrained(MODEL),
  (AutoModelForSequenceClassification as any).from_pretrained(MODEL, { dtype: 'int8', device: 'cpu' }),
]);

// Quick smoke test
const query = 'what is obsidian?';
const doc = 'Obsidian is a note-taking app.';
const encoded = (tokenizer as any)([query], { text_pair: [doc], padding: true, truncation: true });
const { logits } = await (model as any)(encoded);
console.log('Smoke test logit:', logits.data[0]);
console.log('Done!');
