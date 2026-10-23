import { DeviceStateStore, getDeviceSignature } from './reranker-device-state.js';
import { RerankerGpu } from './reranker-gpu.js';
import type { RerankCandidate } from './reranker.js';

interface GpuBackend {
  probe(): Promise<boolean>;
  load(): Promise<void>;
  scoreAll(query: string, candidates: RerankCandidate[]): Promise<number[]>;
  close(): Promise<void>;
}

export class RerankerDevice {
  private readonly state: DeviceStateStore;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    modelName: string,
    maxLength: number,
    private readonly gpu: GpuBackend = new RerankerGpu(modelName, maxLength),
  ) {
    this.state = new DeviceStateStore(getDeviceSignature(modelName, maxLength));
  }

  scoreAll(
    query: string,
    candidates: RerankCandidate[],
    cpu: () => Promise<number[]>,
  ): Promise<number[]> {
    const result = this.queue.then(() => this.score(query, candidates, cpu));
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async score(
    query: string,
    candidates: RerankCandidate[],
    cpu: () => Promise<number[]>,
  ): Promise<number[]> {
    const attempt = this.state.reserve();
    if (!attempt) {
      await this.gpu.close();
      return cpu();
    }
    try {
      if (attempt.probeRequired && !(await this.gpu.probe())) throw new Error('GPU unavailable');
      await this.gpu.load();
      const scores = await this.gpu.scoreAll(query, candidates);
      if (scores.length !== candidates.length || !scores.every(Number.isFinite))
        throw new Error('Invalid GPU scores');
      this.state.succeed(attempt);
      return scores;
    } catch {
      this.state.fail(attempt, 'gpu-failed');
      await this.gpu.close();
    }
    // Redo the complete request so scores from different precisions are never mixed.
    return cpu();
  }
}
