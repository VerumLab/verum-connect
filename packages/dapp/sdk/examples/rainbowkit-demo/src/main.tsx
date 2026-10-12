import '@rainbow-me/rainbowkit/styles.css';
import './verumTheme.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { WagmiProvider } from 'wagmi';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RainbowKitProvider, darkTheme, lightTheme } from '@rainbow-me/rainbowkit';
import { config } from './wagmiConfig.js';
import { App } from './App.js';

const queryClient = new QueryClient();

createRoot(document.getElementById('app')!).render(
  <StrictMode>
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        {/* Both modes rather than a toggle: given this shape RainbowKit emits
            its dark palette inside a prefers-color-scheme media query, so the
            modal follows the OS with no state to keep in step. index.html does
            the same for the page around it. */}
        <RainbowKitProvider theme={{ lightMode: lightTheme(), darkMode: darkTheme() }}>
          <App />
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  </StrictMode>,
);
