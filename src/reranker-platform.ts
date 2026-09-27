import fs from 'node:fs';
import path from 'node:path';

function read(filename: string): string {
  try {
    return fs.readFileSync(filename, 'utf8').trim();
  } catch {
    return '';
  }
}

/** Conservative Linux precheck: a software Vulkan adapter alone is not a GPU. */
export function inspectLinuxGpu(directory = '/sys/class/drm'): {
  physical: boolean;
  fingerprint: string;
} {
  const devices: string[] = [];
  let physical = false;
  try {
    for (const name of fs.readdirSync(directory).filter((name) => /^renderD\d+$/.test(name))) {
      const device = path.join(directory, name, 'device');
      const vendor = read(path.join(device, 'vendor')).toLowerCase();
      let driver = '';
      try {
        driver = path.basename(fs.realpathSync(path.join(device, 'driver')));
      } catch {
        /* Unbound device. */
      }
      const knownVendor = ['0x1002', '0x10de', '0x8086', '0x106b', '0x17cb'].includes(vendor);
      const knownDriver = [
        'amdgpu',
        'nvidia',
        'nouveau',
        'i915',
        'xe',
        'asahi',
        'msm',
        'panfrost',
        'lima',
      ].includes(driver);
      physical ||= knownVendor || knownDriver;
      devices.push(
        [
          vendor,
          read(path.join(device, 'device')),
          driver,
          read(path.join(device, 'driver/module/version')),
        ].join(':'),
      );
    }
  } catch {
    /* Missing/inaccessible inventory uses CPU. */
  }
  return { physical, fingerprint: devices.sort((a, b) => a.localeCompare(b, 'en')).join('|') };
}

function modified(filename: string): string {
  try {
    return String(fs.statSync(filename).mtimeMs);
  } catch {
    return '';
  }
}

/** Cheap OS metadata only; never initializes a graphics API for a saved CPU choice. */
export function gpuEnvironmentFingerprint(): string {
  if (process.platform === 'linux') {
    return [
      inspectLinuxGpu().fingerprint,
      read('/proc/driver/nvidia/version'),
      modified('/usr/share/vulkan/icd.d'),
      modified('/etc/vulkan/icd.d'),
      process.env.VK_DRIVER_FILES,
      process.env.VK_ICD_FILENAMES,
    ].join('|');
  }
  if (process.platform === 'win32') {
    return modified(
      path.join(
        process.env.SystemRoot || 'C:\\Windows',
        'System32',
        'DriverStore',
        'FileRepository',
      ),
    );
  }
  // macOS graphics drivers are part of the OS build already included in the key.
  return '';
}
