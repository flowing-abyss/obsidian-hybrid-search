import { writeSync } from 'node:fs';
import { createRequire } from 'node:module';
import {
  defaultNativePreflightDeps,
  loadNativeModuleWithRequire,
  runNativeModulePreflight,
} from './native-preflight.js';

const require_ = createRequire(import.meta.url);

runNativeModulePreflight(
  defaultNativePreflightDeps(
    (moduleName) => {
      loadNativeModuleWithRequire(moduleName, require_);
    },
    (message) => {
      writeSync(2, message);
    },
    (code) => {
      process.exit(code);
    },
  ),
);
