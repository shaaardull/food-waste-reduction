import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Studio site for Hypergeometric Labs Pvt. Ltd. — the parent behind
// Plate-Clean. Deploys to s3://superpositionlabs.co.in via the same
// pattern as apps/marketing. Port 5176 slots after web (5173),
// dashboard (5174), and marketing (5175).
// TODO(rebrand-domain): the S3 bucket + Cloudflare DNS are still on
// superpositionlabs.co.in. Once hypergeometriclabs.co.in is registered
// and DNS-routed, migrate the deploy target and update this comment.
export default defineConfig({
  plugins: [react()],
  server: { port: 5176, host: true },
});
