import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Studio site for Hypergeometric Labs Pvt. Ltd. — the parent behind
// Plate-Clean. Deploys to s3://hypergeometriclabs.com via the same
// pattern as apps/marketing. Port 5176 slots after web (5173),
// dashboard (5174), and marketing (5175).
//
// Legacy bucket s3://superpositionlabs.co.in is kept behind a 301
// redirect at the Cloudflare edge so old links keep working — see the
// Redirect Rule on the superpositionlabs.co.in zone.
export default defineConfig({
  plugins: [react()],
  server: { port: 5176, host: true },
});
