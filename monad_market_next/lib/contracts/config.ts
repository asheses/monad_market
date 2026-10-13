import { isAddress, zeroAddress, type Address } from "viem";

// Use proxy addresses for Vault. Every date/target pair is a separate market.
export const contractConfig = {
  usdc: process.env.NEXT_PUBLIC_TEST_USDC_ADDRESS || "0x4694f654Fd991495C955b0B473A6f918CF394D63",
  vault: process.env.NEXT_PUBLIC_VAULT_ADDRESS || "0x5fE1b0b06c228252427B26087cCF2D573c5FF142",
};

export const marketAddresses: Record<string, string> = {
  // "bitcoin:2026-09-15:78000": "0x...",
  "monad:2026-09-15:1": "0x46042b770f4d2d32dc7f16f42d1e7ea3fe739dd1",
};

export function marketKey(id: string, day: number, target: number) {
  return `${id}:2026-09-${String(day).padStart(2, "0")}:${target}`;
}

export function configuredAddress(value: string | undefined): Address | undefined {
  return value && isAddress(value) && value.toLowerCase() !== zeroAddress
    ? value as Address
    : undefined;
}
