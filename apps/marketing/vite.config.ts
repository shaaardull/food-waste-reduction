import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Marketing "front door" — shared landing that routes into either
// the diner PWA (localhost:5173 in dev, plate-clean.app in prod) or
// the staff dashboard (localhost:5174 in dev, dashboard subdomain in
// prod). Port 5175 slots after both existing apps.
export default defineConfig({
  plugins: [react()],
  server: { port: 5175, host: true },
});
