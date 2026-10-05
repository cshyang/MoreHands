import { cloudflare } from '@cloudflare/vite-plugin';
import { flue, flueWorkerConfig } from '@flue/vite';
import { defineConfig } from 'vite';

export default defineConfig(() => {
  const fluePlugin = flue();
  const customize = flueWorkerConfig();
  return { plugins: [fluePlugin, cloudflare({ config(config) {
    customize(config);
    if (process.env.MOREHANDS_BUILD_CUTOVER === 'fenced') {
      config.vars = { ...config.vars, CUTOVER_CONTROL: 'd1',
        CUTOVER_NAMESPACE_ID: '1d642bbe6aff4936be41d7cccac2dd5c' };
    } else if (process.env.MOREHANDS_BUILD_CUTOVER) {
      throw new Error('Invalid cutover build mode');
    }
  } })] };
});
