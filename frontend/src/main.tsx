import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import '@fontsource/figtree/400.css';
import '@fontsource/figtree/500.css';
import '@fontsource/figtree/700.css';
import '@fontsource/bricolage-grotesque/700.css';
import '@fontsource/bricolage-grotesque/800.css';
import '@fontsource/geist-mono/500.css';
import '@fontsource/graduate/400.css';
import './styles/main.scss';
import { App } from './App';
import { ToastProvider } from './components/ui';
import { AccountProvider } from './state/AccountContext';
import { makeQueryClient } from './state/query';
import { applyAppearance } from './state/theme';

applyAppearance();
const queryClient = makeQueryClient();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AccountProvider>
          <ToastProvider>
            <App />
          </ToastProvider>
        </AccountProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>
);
