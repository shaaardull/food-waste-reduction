import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { GoogleOAuthProvider } from '@react-oauth/google';

import './index.css';
import './lib/i18n'; // initialises i18next before any screen renders
import { App } from './App';
import { ForgotPassword } from './screens/ForgotPassword';
import { Landing } from './screens/Landing';
import { Login } from './screens/Login';
import { OnboardChoice } from './screens/OnboardChoice';
import { ScanTable } from './screens/ScanTable';
import { Order } from './screens/Order';
import { BeforeCapture } from './screens/BeforeCapture';
import { AfterCapture } from './screens/AfterCapture';
import { SessionStatus } from './screens/SessionStatus';
import { MySessions } from './screens/MySessions';
import { Rewards } from './screens/Rewards';
import { Profile } from './screens/Profile';
import { QrResolve } from './screens/QrResolve';
import { QuickStart } from './screens/QuickStart';
import { Stats } from './screens/Stats';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 5_000, refetchOnWindowFocus: false },
  },
});

// Google Identity Services client ID. When empty the GoogleOAuthProvider
// still mounts and renders its children — the sign-in buttons just no-op
// and the backend returns 503 GOOGLE_NOT_CONFIGURED, which the UI handles
// with a "not set up yet" toast. Configure in .env → VITE_GOOGLE_CLIENT_ID.
const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID ?? '';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <GoogleOAuthProvider clientId={GOOGLE_CLIENT_ID}>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<App />}>
            <Route index element={<Landing />} />
            <Route path="login" element={<Login />} />
            <Route path="forgot-password" element={<ForgotPassword />} />
            <Route path="onboard-choice" element={<OnboardChoice />} />
            <Route path="quick-start" element={<QuickStart />} />
            <Route path="qr/:token" element={<QrResolve />} />
            <Route path="scan" element={<ScanTable />} />
            <Route path="sessions/:id/order" element={<Order />} />
            <Route path="sessions/:id/before" element={<BeforeCapture />} />
            <Route path="sessions/:id/after" element={<AfterCapture />} />
            <Route path="sessions" element={<MySessions />} />
            <Route path="sessions/:id" element={<SessionStatus />} />
            <Route path="rewards" element={<Rewards />} />
            <Route path="profile" element={<Profile />} />
            <Route path="stats" element={<Stats />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
    </GoogleOAuthProvider>
  </React.StrictMode>,
);
