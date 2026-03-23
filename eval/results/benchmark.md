# Embedding Model Benchmark

**Vault:** `fixtures/obsidian-help/en` (171 notes)
**Golden set:** `eval/golden-sets/obsidian-help.json` (58 queries)
**Reranker:** `onnx-community/bge-reranker-v2-m3-ONNX`
**Date:** 2026-03-24

Query categories: keyword (28), conceptual (14), multilingual/Russian (6), syntax (6).

---

## Overall ranking (sorted by nDCG@5 no-rerank)

| # | Model | Provider | ctx | dim | size | nDCG@5 | +rerank | MRR | Hit@1 | Hit@5 | Recall@10 |
|---|-------|----------|-----|-----|------|--------|---------|-----|-------|-------|-----------|
| 1 | **snowflake-arctic-embed2** | Ollama | 8192 | 1024 | 1.2 GB | **0.767** | **0.784** | 0.801 | 0.707 | 0.897 | 0.931 |
| 2 | **bge-m3** | Ollama | 8192 | 1024 | 1.2 GB | **0.755** | **0.768** | 0.791 | 0.690 | 0.914 | 0.931 |
| 3 | embeddinggemma | Ollama | 2048 | 768 | 621 MB | 0.747 | 0.767 | 0.774 | 0.690 | 0.897 | 0.931 |
| 4 | paraphrase-multilingual | Ollama | 512 | 768 | 562 MB | 0.738 | 0.739 | 0.768 | 0.690 | 0.862 | 0.897 |
| 5 | e5-small *(baseline, local)* | Local | 512 | 384 | ~30 MB | 0.736 | 0.737 | 0.771 | 0.690 | 0.879 | 0.897 |
| 6 | nomic-embed-text-v2-moe | Ollama | 512 | 768 | 957 MB | 0.720 | 0.745 | 0.760 | 0.672 | 0.862 | 0.914 |
| 7 | all-minilm | Ollama | 512 | 384 | 45 MB | 0.699 | 0.694 | 0.749 | 0.707 | 0.810 | 0.828 |
| 8 | granite-embedding | Ollama | 512 | 384 | 62 MB | 0.696 | 0.691 | 0.731 | 0.672 | 0.793 | 0.810 |
| 9 | mxbai-embed-large | Ollama | 512 | 1024 | 669 MB | 0.687 | 0.683 | 0.720 | 0.655 | 0.793 | 0.828 |
| 10 | nomic-embed-text | Ollama | 8192 | 768 | 274 MB | 0.622 | 0.662 | 0.663 | 0.603 | 0.707 | 0.845 |
| 11 | snowflake-arctic-embed | Ollama | 512 | 1024 | 669 MB | 0.445 | 0.553 | 0.451 | 0.345 | 0.655 | 0.810 |

---

## By category — nDCG@5 (no-rerank)

| Model | keyword | conceptual | multilingual | syntax |
|-------|---------|------------|--------------|--------|
| snowflake-arctic-embed2 | 0.882 | 0.491 | **0.667** | 0.643 |
| bge-m3 | 0.865 | 0.481 | 0.541 | 0.770 |
| embeddinggemma | 0.871 | 0.438 | 0.497 | 0.770 |
| paraphrase-multilingual | **0.874** | 0.476 | 0.334 | **0.762** |
| e5-small *(baseline)* | 0.870 | 0.420 | 0.421 | 0.770 |
| nomic-embed-text-v2-moe | 0.858 | 0.451 | 0.300 | 0.762 |
| all-minilm | 0.866 | **0.482** | 0.000 | 0.762 |
| granite-embedding | 0.877 | 0.424 | 0.000 | 0.762 |
| mxbai-embed-large | 0.861 | 0.424 | 0.000 | 0.770 |
| nomic-embed-text | 0.779 | 0.466 | 0.000 | 0.563 |
| snowflake-arctic-embed | 0.542 | 0.242 | 0.000 | 0.650 |

---

## Rerank impact (nDCG@5 delta)

| Model | no-rerank | rerank | delta | best category gain |
|-------|-----------|--------|-------|--------------------|
| snowflake-arctic-embed | 0.445 | 0.553 | **+0.108** | biggest rescue |
| nomic-embed-text | 0.622 | 0.662 | +0.040 | |
| nomic-embed-text-v2-moe | 0.720 | 0.745 | +0.025 | multilingual +0.141 |
| snowflake-arctic-embed2 | 0.767 | 0.784 | +0.017 | |
| embeddinggemma | 0.747 | 0.767 | +0.020 | |
| bge-m3 | 0.755 | 0.768 | +0.013 | |
| e5-small | 0.736 | 0.737 | +0.001 | |
| paraphrase-multilingual | 0.738 | 0.739 | +0.001 | |
| all-minilm | 0.699 | 0.694 | −0.005 | |
| granite-embedding | 0.696 | 0.691 | −0.005 | |
| mxbai-embed-large | 0.687 | 0.683 | −0.004 | |

---

## Observations

**Top picks for a personal vault:**

- **snowflake-arctic-embed2** — лучший результат по nDCG@5 (0.767) и лидер по multilingual (0.667). 8192 токенов, 1024d, 1.2 GB. С rerank достигает 0.784.
- **bge-m3** — второй по nDCG@5 (0.755), лучший MRR с rerank (0.810), хорошее multilingual (0.541). 8192 токенов, 1.2 GB.
- **embeddinggemma** — третье место (0.747), меньший размер (621 MB), 2048 токенов. С rerank 0.767.

**Неожиданные выводы:**

- `e5-small` (30 MB, без сети) бьёт `mxbai-embed-large` (669 MB), `all-minilm`, `granite-embedding` и `nomic-embed-text` — маленькие модели, специализированные на retrieval, выигрывают у больших универсальных.
- `snowflake-arctic-embed` v1 катастрофически слаб (0.445) без rerank, но rerank поднимает его до 0.553 — самый большой прирост (+0.108). Значит retrieval находит правильные документы, но ранжирует плохо.
- `nomic-embed-text` v1 показывает 0.000 по multilingual — несмотря на заявленную мультиязычность, в Ollama-версии русские запросы не работают.
- Rerank **вредит** all-minilm, granite, mxbai (−0.004 / −0.005) — для слабых embeddings reranker не может вытащить нужный документ из топ-10, если его там нет.
- **conceptual queries** — самая сложная категория для всех моделей (0.24–0.49). Это потенциальная точка роста.

**Для русскоязычного хранилища** обязательно нужна модель с multilingual > 0:
snowflake-arctic-embed2 (0.667) > bge-m3 (0.541) > embeddinggemma (0.497) > e5-small (0.421).
