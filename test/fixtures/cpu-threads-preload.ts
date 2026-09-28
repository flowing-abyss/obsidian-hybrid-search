import { register } from 'node:module';

register(new URL('./cpu-threads-loader.js', import.meta.url), import.meta.url);
