import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Route, Routes } from 'react-router-dom';

import './index.css';
import './lib/i18n'; // initialises i18next before any screen renders
import { App } from './App';
import { AdminOnboard } from './screens/AdminOnboard';
import { DisputeDetail } from './screens/DisputeDetail';
import { Disputes } from './screens/Disputes';
import { Login } from './screens/Login';
import { Redeem } from './screens/Redeem';
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
            <Route path="validations" element={<ValidationQueue />} />
            <Route path="validations/:sessionId" element={<ValidationDetail />} />
            <Route path="redeem" element={<Redeem />} />
            <Route path="staff-metrics" element={<StaffMetrics />} />
            <Route path="disputes" element={<Disputes />} />
            <Route path="disputes/:id" element={<DisputeDetail />} />
            <Route path="admin/restaurants/new" element={<AdminOnboard />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
