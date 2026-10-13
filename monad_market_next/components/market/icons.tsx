import type { CSSProperties } from "react";

export function AssetSymbol({
  symbol,
  fallback,
}: {
  symbol: string;
  fallback: string;
}) {
  if (symbol === "MON") return <img src="/monad.jpeg" alt="Monad" className="asset-symbol-image" />;
  if (symbol === "BTC")
    return (
      <svg
        className="asset-symbol"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <g transform="rotate(12 12 12)">
          <path d="M7 5h7a3.5 3.5 0 0 1 0 7H9m0 0h6a3.5 3.5 0 0 1 0 7H7M9 5v14M10 2v3m4-3v3M10 19v3m4-3v3" />
        </g>
      </svg>
    );
  if (symbol === "ETH")
    return (
      <svg
        className="asset-symbol"
        viewBox="0 0 24 24"
        fill="currentColor"
        aria-hidden="true"
      >
        <path d="m12 1 7 11-7 4-7-4z" />
        <path d="m5 14 7 4 7-4-7 9z" opacity=".75" />
      </svg>
    );
  if (symbol === "SOL")
    return (
      <svg
        className="asset-symbol"
        viewBox="0 0 24 24"
        fill="currentColor"
        aria-hidden="true"
      >
        <path d="M6 4h15l-3 4H3zm-3 6h15l3 4H6zm3 6h15l-3 4H3z" />
      </svg>
    );
  return <>{fallback}</>;
}

export type IconName =
  | "search"
  | "chevron"
  | "arrow"
  | "trend"
  | "bookmark"
  | "share"
  | "clock"
  | "close"
  | "check"
  | "chart"
  | "bars"
  | "globe"
  | "bolt"
  | "wallet"
  | "info"
  | "filter"
  | "message"
  | "arrowLeft"
  | "copy";
const paths: Record<IconName, React.ReactNode> = {
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m16 16 4 4" />
    </>
  ),
  chevron: <path d="m6 9 6 6 6-6" />,
  arrow: (
    <>
      <path d="M5 12h14M13 6l6 6-6 6" />
    </>
  ),
  trend: (
    <>
      <path d="m3 17 6-6 4 4 8-10M15 5h6v6" />
    </>
  ),
  bookmark: <path d="M6 4h12v17l-6-4-6 4z" />,
  share: (
    <>
      <path d="M12 15V3m-4 4 4-4 4 4M5 12v8h14v-8" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </>
  ),
  close: <path d="m6 6 12 12M6 18 18 6" />,
  check: <path d="m5 12 4 4L19 6" />,
  chart: <path d="M3 3v18h18M6 15l4-5 4 3 6-8" />,
  bars: (
    <path d="M6 4v16m-2-5h4V8H4zm8-13v16m-2-4h4V6h-4zm8 0v16m-2-5h4v-7h-4z" />
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="9" />
      <ellipse cx="12" cy="12" rx="4" ry="9" />
      <path d="M3 12h18" />
    </>
  ),
  bolt: <path d="m13 2-9 12h7l-1 8 10-13h-7z" />,
  wallet: (
    <>
      <path d="M20 8V5H4v15h16v-5M4 8h17v7h-7V8" />
      <path d="M17 11.5h.01" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v6M12 7h.01" />
    </>
  ),
  filter: (
    <>
      <path d="M4 7h16M4 17h16" />
      <circle cx="8" cy="7" r="2" />
      <circle cx="16" cy="17" r="2" />
    </>
  ),
  message: <path d="M4 4h16v12H9l-5 4z" />,
  arrowLeft: <path d="M19 12H5m6-6-6 6 6 6" />,
  copy: (
    <>
      <rect x="8" y="8" width="12" height="12" rx="2" />
      <path d="M15 8V4H4v11h4" />
    </>
  ),
};
export function Icon({
  name,
  size = 18,
  style,
  className = "",
}: {
  name: IconName;
  size?: number;
  style?: CSSProperties;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
      style={style}
    >
      {paths[name]}
    </svg>
  );
}
export function BrandMark() {
  return <img src="/monad.jpeg" alt="Monad Market" className="brand-mark-image" />;
}
