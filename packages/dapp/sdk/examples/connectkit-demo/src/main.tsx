import './verumTheme.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { WagmiProvider } from 'wagmi';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ConnectKitProvider } from 'connectkit';
import { config } from './wagmiConfig.js';
import { App } from './App.js';

const queryClient = new QueryClient();

createRoot(document.getElementById('app')!).render(
  <StrictMode>
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        {/* 'auto' follows the OS, which is what index.html does for the page. */}
        <ConnectKitProvider mode="auto">
          <App />
        </ConnectKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  </StrictMode>,
);
