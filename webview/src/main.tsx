// Copyright (c) 2026 Stefano Della Valle
// SPDX-License-Identifier: LicenseRef-Proprietary

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createNetworkConfig, IotaClientProvider, WalletProvider } from "@iota/dapp-kit";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@iota/dapp-kit/dist/index.css";
import App from "./App";
import { WalletAuthentication } from "./components/WalletAuthentication";
import "./styles.css";

const mainnetRpcUrl = import.meta.env.VITE_IOTA_MAINNET_RPC_URL?.trim() || "https://api.mainnet.iota.cafe";
const testnetRpcUrl = import.meta.env.VITE_IOTA_TESTNET_RPC_URL?.trim() || "https://api.testnet.iota.cafe";
const devnetRpcUrl =
  import.meta.env.VITE_IOTA_DEVNET_RPC_URL?.trim() ||
  import.meta.env.VITE_IOTA_RPC_URL?.trim() ||
  "https://api.devnet.iota.cafe";

const { networkConfig } = createNetworkConfig({
  mainnet: { url: mainnetRpcUrl },
  testnet: { url: testnetRpcUrl },
  devnet: { url: devnetRpcUrl },
});

const queryClient = new QueryClient();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <IotaClientProvider networks={networkConfig} defaultNetwork="devnet">
        <WalletProvider>
          <WalletAuthentication><App /></WalletAuthentication>
        </WalletProvider>
      </IotaClientProvider>
    </QueryClientProvider>
  </StrictMode>,
);
