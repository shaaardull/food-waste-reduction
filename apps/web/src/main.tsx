import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Route, Routes } from 'react-router-dom';

import './index.css';
import './lib/i18n'; // initialises i18next before any screen renders
import { App } from './App';
import { Landing } from './screens/Landing';
import { Login } from './screens/Login';
import { ScanTable } from './screens/ScanTable';
import { Order } from './screens/Order';
import { BeforeCapture } from './screens/BeforeCapture';
import { AfterCapture } from './screens/AfterCapture';
import { SessionStatus } from './screens/SessionStatus';
import { Rewards } from './screens/Rewards';
import { Profile } from './screens/Profile';
import { QuickStart } from './screens/QuickStart';
import { Stats } from './screens/Stats';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 5_000, refetchOnWindowFocus: false },
  },
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<App />}>
            <Route index element={<Landing />} />
            <Route path="login" element={<Login />} />
            <Route path="quick-start" element={<QuickStart />} />
            <Route path="scan" element={<ScanTable />} />
            <Route path="sessions/:id/order" element={<Order />} />
            <Route path="sessions/:id/before" element={<BeforeCapture />} />
            <Route path="sessions/:id/after" element={<AfterCapture />} />
            <Route path="sessions/:id" element={<SessionStatus />} />
            <Route path="rewards" element={<Rewards />} />
            <Route path="profile" element={<Profile />} />
            <Route path="stats" element={<Stats />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
