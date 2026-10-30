import { useEffect, type ReactNode } from "react";
import { useCurrentAccount, useIotaClientContext, useSignPersonalMessage } from "@iota/dapp-kit";
import { registerWalletSigner } from "../lib/walletSession";

export function WalletAuthentication({ children }: { children: ReactNode }) {
  const account = useCurrentAccount();
  const { network } = useIotaClientContext();
  const { mutateAsync: signPersonalMessage } = useSignPersonalMessage();
  useEffect(() => {
    registerWalletSigner(account ? { address: account.address,
      sign: message => signPersonalMessage({ message, account }) } : undefined);
    return () => registerWalletSigner();
  }, [account?.address, network, signPersonalMessage]);
  return <>{children}</>;
}
