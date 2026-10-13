import { type DemoMarket, money } from "@/lib/market-data";
import { AssetSymbol, Icon } from "./icons";

export function MarketHeader({
  market,
  day,
  saved,
  onSave,
  onShare,
}: {
  market: DemoMarket;
  day: number;
  saved: boolean;
  onSave: () => void;
  onShare: () => void;
}) {
  return (
    <>
      <div className="market-header">
        <div className="market-icon" style={{ background: market.color }}>
          <AssetSymbol symbol={market.symbol} fallback={market.icon} />
        </div>
        <div className="market-heading">
          <div className="market-subtitle">
            {market.category} <span>/</span> {market.symbol}{" "}
            <span className="event-badge">每日市场</span>
          </div>
          <h1>
            {market.title}在9月{day}日高于多少？
          </h1>
        </div>
        <div className="header-actions">
          <button
            className={`icon-button ${saved ? "saved" : ""}`}
            onClick={onSave}
            aria-label={saved ? "取消收藏" : "收藏市场"}
            aria-pressed={saved}
          >
            <Icon name="bookmark" />
          </button>
          <button
            className="icon-button"
            aria-label="分享市场"
            onClick={onShare}
          >
            <Icon name="share" />
          </button>
        </div>
      </div>
      <div className="market-meta">
        <span>
          <Icon name="chart" size={14} /> ${money(market.volume)} 交易量
        </span>
        <span>
          <Icon name="clock" size={14} /> 2026年9月{day}日
        </span>
        <span className={day < 15 ? "closed-label" : "live-label"}>
          <span className="live-dot" />
          {day < 15 ? "已结束" : "交易中"}
        </span>
      </div>
    </>
  );
}
