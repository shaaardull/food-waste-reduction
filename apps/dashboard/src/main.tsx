import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Route, Routes } from 'react-router-dom';

import './index.css';
import './lib/i18n'; // initialises i18next before any screen renders
import { App } from './App';
import { AdminOnboard } from './screens/AdminOnboard';
import { Analytics } from './screens/Analytics';
import { DisputeDetail } from './screens/DisputeDetail';
import { Disputes } from './screens/Disputes';
import { BugReport } from './screens/BugReport';
import { ForgotPassword } from './screens/ForgotPassword';
import { Login } from './screens/Login';
import { PlatformCommandCenter } from './screens/PlatformCommandCenter';
import { PlatformQrTokens } from './screens/PlatformQrTokens';
import { QrPrintSheet } from './screens/QrPrintSheet';
import { Menu } from './screens/Menu';
import { Onboard } from './screens/Onboard';
import { Orders } from './screens/Orders';
import { NewWalkinOrder } from './screens/NewWalkinOrder';
import { PastOrders } from './screens/PastOrders';
import { Redeem } from './screens/Redeem';
import { Settings } from './screens/Settings';
import { StaffMetrics } from './screens/StaffMetrics';
import { Summary } from './screens/Summary';
import { ValidationDetail } from './screens/ValidationDetail';
import { ValidationQueue } from './screens/ValidationQueue';

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 2_000, refetchOnWindowFocus: false } },
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<App />}>
            <Route index element={<Summary />} />
            <Route path="login" element={<Login />} />
            <Route path="forgot-password" element={<ForgotPassword />} />
            <Route path="orders" element={<Orders />} />
            <Route path="orders/new-walkin" element={<NewWalkinOrder />} />
            <Route path="orders/past" element={<PastOrders />} />
            <Route path="validations" element={<ValidationQueue />} />
            <Route path="validations/:sessionId" element={<ValidationDetail />} />
            <Route path="menu" element={<Menu />} />
            <Route path="redeem" element={<Redeem />} />
            <Route path="staff-metrics" element={<StaffMetrics />} />
            <Route path="analytics" element={<Analytics />} />
            <Route path="disputes" element={<Disputes />} />
            <Route path="disputes/:id" element={<DisputeDetail />} />
            <Route path="settings" element={<Settings />} />
            <Route path="report-bug" element={<BugReport />} />
            {/* Backdoor: no left-rail item, the URL prefix `/-/` is
                the "hidden" surface. Backend also 404s non-admin JWTs
                so a stray curl by staff can't confirm it exists. */}
            <Route path="-/platform" element={<PlatformCommandCenter />} />
            <Route path="-/platform/qr-stickers" element={<PlatformQrTokens />} />
            <Route path="-/platform/qr-print" element={<QrPrintSheet />} />
            <Route path="admin/restaurants/new" element={<AdminOnboard />} />
            <Route path="onboard" element={<Onboard />} />
            <Route
              path="onboard/:restaurantId/setup"
              element={<AdminOnboard />}
            />
          </Route>
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
