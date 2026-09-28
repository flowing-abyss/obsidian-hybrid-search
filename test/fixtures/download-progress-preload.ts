import { register } from 'node:module';

process.stdout.isTTY = process.env.OHS_TEST_PIPE !== '1';
process.stderr.isTTY = true;
register(new URL('./download-progress-loader.js', import.meta.url), import.meta.url);
