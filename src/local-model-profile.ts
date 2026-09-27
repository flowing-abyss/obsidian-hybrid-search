type LocalModelProfile = { pooling: 'mean' | 'cls'; dtype: 'q8' | 'fp32' };

const DEFAULT_PROFILE: LocalModelProfile = { pooling: 'mean', dtype: 'q8' };

const LOCAL_MODEL_PROFILES = new Map<string, LocalModelProfile>([
  ['hotchpotch/bekko-embedding-v1-a8m', { pooling: 'mean', dtype: 'fp32' }],
  ['hotchpotch/bekko-embedding-v1-a25m', { pooling: 'mean', dtype: 'fp32' }],
  ['onnx-community/granite-embedding-97m-multilingual-r2-ONNX', { pooling: 'cls', dtype: 'q8' }],
]);

export function getLocalModelProfile(model: string): LocalModelProfile {
  return LOCAL_MODEL_PROFILES.get(model) ?? DEFAULT_PROFILE;
}
