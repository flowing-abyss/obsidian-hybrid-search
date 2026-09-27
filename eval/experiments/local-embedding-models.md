# Local embedding model experiment

Keep `multilingual-e5-small` as the default. None of the candidates improves size, speed and search quality together. This draft preserves the experiment for reference; no merge is planned.

Pairs below are **Obsidian Help / Andy Matuschak's notes**. Hybrid search without reranking, Apple M4 CPU.

Symbols compare with E5: `+` better, `-` worse, `≈` within 1%. They show direction, not statistical significance.

| Model               | Size, MB ↓ |    Quality (nDCG@5) ↑ |        Indexing, s ↓ |     Search p50, ms ↓ |
| ------------------- | ---------: | --------------------: | -------------------: | -------------------: |
| E5 small (baseline) |      135.4 |         0.743 / 0.721 |         20.3 / 134.9 |         8.77 / 17.63 |
| Bekko a8m           |  164.5 (-) | 0.748 (≈) / 0.703 (-) |   8.1 (+) / 57.6 (+) | 7.65 (+) / 16.28 (+) |
| Granite 97M R2 q8   |  123.2 (+) | 0.774 (+) / 0.695 (-) | 23.4 (-) / 134.7 (≈) | 8.54 (+) / 18.09 (-) |
| Bekko a25m          |  233.7 (-) | 0.763 (+) / 0.733 (+) | 22.3 (-) / 142.0 (-) | 9.41 (-) / 18.35 (-) |

Bekko a8m indexes much faster but loses quality on Andy's notes. Granite is smaller, with mixed results. Bekko a25m scores slightly higher on both datasets but is 73% larger and slower.

Size includes weights, tokenizer and configs. Quality uses 58 / 78 queries. Indexing is one full run per model and dataset; search timings use 360 uncached queries each. Quality differences remain uncertain.

OHS-198. The default stays unchanged. Reranker evaluation remains a separate task (OHS-199).
