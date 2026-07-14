import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Studio site for Superposition Labs — the parent behind Plate-Clean.
// Deploys to s3://superpositionlabs.co.in via the same pattern as
// apps/marketing. Port 5176 slots after web (5173), dashboard (5174),
// and marketing (5175).
export default defineConfig({
  plugins: [react()],
  server: { port: 5176, host: true },
});
