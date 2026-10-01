import { defineConfig } from '@flue/runtime/config';

export default defineConfig({
	target: 'cloudflare',
	app: './src/app.ts',
	cloudflare: './src/cloudflare.ts',
	agents: 'agent/project.ts',
	providers: ['zai', 'openrouter'],
});
