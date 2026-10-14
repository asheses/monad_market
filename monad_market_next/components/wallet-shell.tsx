"use client";

import { UsdcControls } from "@/components/market/funds-controls";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useEffect, useRef, useState } from "react";
import { MarketDateTabs } from "@/components/market/market-date-tabs";
import { MarketHeader } from "@/components/market/market-header";
import { MarketOrderBook } from "@/components/market/order-book";
import { PriceChart } from "@/components/market/price-chart";
import { TradingPanel } from "@/components/market/trading-panel";
import { AssetSymbol, BrandMark, Icon } from "@/components/market/icons";
import { Dropdown, Modal } from "@/components/market/ui";
import {
  markets as staticMarkets,
  makePriceData,
  marketDateLabel,
  marketSettlementLabel,
  money,
  probabilityFor,
  targetLabel,
  type DemoMarket,
} from "@/lib/market-data";

type Comment = {
  id: number;
  marketId: string;
  author: string;
  text: string;
  time: string;
  likes: number;
};
const seedComments: Comment[] = [
  {
    id: 2,
    marketId: "bitcoin",
    author: "CryptoExplorer",
    text: "更关注接下来的成交量变化，先观察 78,000 附近的表现。",
    time: "12 分钟前",
    likes: 12,
  },
  {
    id: 1,
    marketId: "bitcoin",
    author: "monad.eth",
    text: "不同价位的概率放在一起对比，市场的预期就直观多了。",
    time: "28 分钟前",
    likes: 8,
  },
];

export function WalletShell() {
  const [allMarkets, setAllMarkets] = useState(staticMarkets);
  const [marketId, setMarketId] = useState("monad");
  const [day, setDay] = useState(15);
  const [targetIndex, setTargetIndex] = useState(2);
  const [outcome, setOutcome] = useState<"yes" | "no">("yes");
  const [orderType, setOrderType] = useState("market");
  const [price, setPrice] = useState(64);
  const [range, setRange] = useState("1D");
  const [chartMode, setChartMode] = useState<"price" | "probability">("price");
  const [saved, setSaved] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("加密货币");
  const [directory, setDirectory] = useState(false);
  const [sort, setSort] = useState("volume");
  const [activeTab, setActiveTab] = useState("comments");
  const [commentSort, setCommentSort] = useState("latest");
  const [comments, setComments] = useState(seedComments);
  const [comment, setComment] = useState("");
  const [liked, setLiked] = useState<number[]>([]);
  const [modal, setModal] = useState<"share" | "guide" | null>(null);
  const [notice, setNotice] = useState("");
  const [shareUrl, setShareUrl] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const market = allMarkets.find((item) => item.id === marketId) ?? allMarkets[0];
  const probability = probabilityFor(market, targetIndex, day);
  const target = market.targets[targetIndex] ?? market.targets[0] ?? 0;
  const chartData = makePriceData(market, day, range);
  const marketComments = comments
    .filter((item) => item.marketId === marketId)
    .sort((a, b) =>
      commentSort === "top"
        ? b.likes +
          Number(liked.includes(b.id)) -
          (a.likes + Number(liked.includes(a.id)))
        : b.id - a.id,
    );
  const filtered = allMarkets
    .filter(
      (item) =>
        (!query ||
          `${item.title} ${item.symbol}`
            .toLowerCase()
            .includes(query.toLowerCase())) &&
        (query ||
          category === "热门" ||
          category === "最新" ||
          (category === "自选市场"
            ? saved.includes(item.id)
            : category === item.category)),
    )
    .sort((a, b) =>
      sort === "newest"
        ? allMarkets.indexOf(b) - allMarkets.indexOf(a)
        : sort === "probability"
          ? b.probability - a.probability
          : sort === "name"
            ? a.title.localeCompare(b.title, "zh")
            : b.volume - a.volume,
    );

  useEffect(() => { fetch("/api/markets").then(r=>r.json()).then((items: Array<{marketAddress:string;product:string;productLabel:string;targetUsd:string;settleAt:string;status:string}>) => {
      const added = items.map(item => ({ id: `chain-${item.marketAddress}`, title: item.productLabel, category: ["bitcoin","ethereum","monad","solana"].includes(item.product) ? "加密货币" : "金融", symbol: item.product.toUpperCase(), icon: "◆", color: "#5b63d3", price: Number(item.targetUsd), change: 0, volume: 0, probability: 50, targets: [Number(item.targetUsd), Number(item.targetUsd), Number(item.targetUsd), Number(item.targetUsd), Number(item.targetUsd)], chainAddress: item.marketAddress, settleAt: item.settleAt, status: item.status }));
      setAllMarkets([...staticMarkets, ...added]);
    }).catch(() => {});
    const frame = requestAnimationFrame(() => {
      try {
        const value = JSON.parse(
          localStorage.getItem("monad-market-watchlist") ?? "[]",
        );
        if (Array.isArray(value))
          setSaved(value.filter((item) => typeof item === "string"));
      } catch {
        /* Storage is optional. */
      }
      const params = new URLSearchParams(window.location.search);
      const id = params.get("market");
      const initialMarket = allMarkets.find((item) => item.id === id);
      const initialDay = Number(params.get("day"));
      const initialTarget = Number(params.get("target") ?? 2);
      if (initialMarket) {
        setMarketId(initialMarket.id);
        setCategory(initialMarket.category);
      }
      if (initialDay >= 13 && initialDay <= 22 && Number.isInteger(initialDay))
        setDay(initialDay);
      if (
        initialTarget >= 0 &&
        initialTarget < 5 &&
        Number.isInteger(initialTarget)
      )
        setTargetIndex(initialTarget);
      setPrice(
        probabilityFor(
          initialMarket ?? allMarkets[0],
          Number.isInteger(initialTarget) &&
            initialTarget >= 0 &&
            initialTarget < 5
            ? initialTarget
            : 2,
          Number.isInteger(initialDay) && initialDay >= 13 && initialDay <= 22
            ? initialDay
            : 15,
        ),
      );
    });
    const shortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "k") {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    document.addEventListener("keydown", shortcut);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", shortcut);
    };
  }, []);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 5500);
    return () => clearTimeout(timer);
  }, [notice]);

  function toggleSave(id: string) {
    const next = saved.includes(id)
      ? saved.filter((item) => item !== id)
      : [...saved, id];
    setSaved(next);
    try {
      localStorage.setItem("monad-market-watchlist", JSON.stringify(next));
    } catch {
      setNotice("当前浏览器无法保存收藏，刷新后将重置。");
      return;
    }
    setNotice(next.includes(id) ? "已添加至自选市场" : "已从自选市场移除");
  }
  function selectMarket(item: DemoMarket) {
    setMarketId(item.id);
    setDay(15);
    setCategory(item.category);
    setTargetIndex(2);
    setOutcome("yes");
    setPrice(item.probability);
    setDirectory(false);
    setQuery("");
    setComment("");
    window.history.replaceState(null, "", window.location.pathname);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  function selectOutcome(index: number, next: "yes" | "no", focus = false) {
    setTargetIndex(index);
    setOutcome(next);
    const p = probabilityFor(market, index, day);
    setPrice(next === "yes" ? p : 100 - p);
    if (focus && window.innerWidth < 1000)
      document
        .getElementById("trade-panel")
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  function showDirectory(next: string) {
    setCategory(next);
    setDirectory(true);
    setQuery("");
    setSort(next === "最新" ? "newest" : "volume");
  }
  function share() {
    const url = new URL(window.location.href);
    url.search = "";
    url.searchParams.set("market", marketId);
    url.searchParams.set("day", String(day));
    url.searchParams.set("target", String(targetIndex));
    setShareUrl(url.toString());
    setModal("share");
  }

  return (
    <div className="market-shell">
      <header className="site-header">
        <div className="header-inner">
          <button
            className="brand"
            onClick={() => {
              selectMarket(allMarkets[2]);
            }}
            aria-label="Monad Market 首页"
          >
            <BrandMark />
            <span>
              market
            </span>
          </button>
          <div className="header-search">
            <Icon name="search" size={18} />
            <input
              ref={searchRef}
              aria-label="搜索市场"
              placeholder="搜索市场，发现下一个机会"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setDirectory(true);
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  setQuery("");
                  setDirectory(false);
                  event.currentTarget.blur();
                }
              }}
            />
            {query ? (
              <button
                className="search-clear"
                aria-label="清空搜索"
                onClick={() => setQuery("")}
              >
                <Icon name="close" size={14} />
              </button>
            ) : (
              <kbd>⌘ K</kbd>
            )}
          </div>
          <div className="header-right">
            <button className="header-help" onClick={() => setModal("guide")}>
              如何参与
            </button>
            <UsdcControls />
            <div className="wallet-connect">
              <ConnectButton
                label="连接钱包"
                chainStatus="icon"
                showBalance={false}
                accountStatus="avatar"
              />
            </div>
          </div>
        </div>
        <nav className="category-nav" aria-label="市场分类">
          <div className="category-inner">
            {["热门", "最新", "加密货币", "金融", "自选市场"].map(
              (item, index) => (
                <button
                  key={item}
                  className={category === item ? "active" : ""}
                  aria-pressed={category === item}
                  onClick={() => showDirectory(item)}
                >
                  {index === 0 && <Icon name="trend" size={17} />}
                  {index === 4 && <Icon name="bookmark" size={15} />}
                  {item}
                  {index === 4 && saved.length > 0 && (
                    <span className="nav-count">{saved.length}</span>
                  )}
                </button>
              ),
            )}
            <span className="network-label">
              <span className="live-dot" /> Monad Testnet{" "}
              <span className="demo-badge">DEMO</span>
            </span>
          </div>
        </nav>
      </header>
      <main className="page-container">
        {directory ? (
          <section className="directory">
            <div className="breadcrumb">
              <button
                onClick={() => {
                  setDirectory(false);
                  setQuery("");
                  setCategory(market.category);
                }}
              >
                <Icon name="arrowLeft" size={14} /> 返回市场详情
              </button>
            </div>
            <div className="directory-heading">
              <div>
                <div className="eyebrow">EXPLORE THE POSSIBILITIES</div>
                <h1>
                  {query
                    ? `“${query}”的搜索结果`
                    : category === "自选市场"
                      ? "你的关注，尽在这里。"
                      : "世界在变化，你怎么看？"}
                </h1>
                <p>
                  {category === "自选市场"
                    ? "收藏感兴趣的市场，随时追踪概率变化。"
                    : "发现市场、观察趋势，让每一个判断都有依据。"}
                </p>
              </div>
              <span className="directory-art" aria-hidden="true">
                ↗
              </span>
            </div>
            <div className="directory-toolbar">
              <h2>
                {query ? "搜索结果" : category}{" "}
                <span>{filtered.length} 个市场</span>
              </h2>
              <Dropdown
                label="市场排序"
                value={sort}
                options={[
                  { value: "volume", label: "交易量最高" },
                  { value: "newest", label: "最新发布" },
                  { value: "probability", label: "概率最高" },
                  { value: "name", label: "名称排序" },
                ]}
                onChange={setSort}
              />
            </div>
            <div className="market-cards">
              {filtered.map((item) => (
                <article className="market-card" key={item.id}>
                  <div className="card-title-row">
                    <button
                      className="card-market-title"
                      onClick={() => selectMarket(item)}
                    >
                      <span
                        className="mini-market-icon"
                        style={{ background: item.color }}
                      >
                        <AssetSymbol
                          symbol={item.symbol}
                          fallback={item.icon}
                        />
                      </span>
                      <strong>
                        {item.title}在{marketDateLabel(item)}高于 $
                        {targetLabel(item.targets[2])}？
                      </strong>
                    </button>
                    <button
                      className={`icon-button ${saved.includes(item.id) ? "saved" : ""}`}
                      aria-label={`${saved.includes(item.id) ? "取消收藏" : "收藏"}${item.title}`}
                      onClick={() => toggleSave(item.id)}
                    >
                      <Icon name="bookmark" size={16} />
                    </button>
                  </div>
                  <div className="card-probability">
                    <strong>
                      {item.probability}
                      <small>%</small>
                    </strong>
                    <span>概率</span>
                    <svg viewBox="0 0 120 35" aria-hidden="true">
                      <path
                        d={`M0 28 10 25 18 29 28 15 38 19 48 11 56 18 64 9 72 14 86 5 96 10 110 ${100 - item.probability > 40 ? 16 : 4} 120 5`}
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                      />
                    </svg>
                  </div>
                  <div className="card-outcomes">
                    <button
                      className="yes"
                      onClick={() => {
                        selectMarket(item);
                        setDay(15);
                      }}
                    >
                      买入 是 <span>{item.probability}¢</span>
                    </button>
                    <button
                      className="no"
                      onClick={() => {
                        selectMarket(item);
                        setDay(15);
                        setOutcome("no");
                        setPrice(100 - item.probability);
                      }}
                    >
                      买入 否 <span>{100 - item.probability}¢</span>
                    </button>
                  </div>
                  <div className="card-footer">
                    <span>${(item.volume / 1000).toFixed(1)}k 交易量</span>
                    <span>{item.category}</span>
                  </div>
                </article>
              ))}
            </div>
            {filtered.length === 0 && (
              <div className="empty-state">
                <Icon
                  name={category === "自选市场" ? "bookmark" : "search"}
                  size={32}
                />
                <h3>
                  {category === "自选市场" && !query
                    ? "还没有收藏的市场"
                    : "没有找到相关市场"}
                </h3>
                <p>
                  {category === "自选市场" && !query
                    ? "点击市场旁的收藏图标，即可添加到这里。"
                    : "试试搜索 BTC、ETH、Monad 或黄金。"}
                </p>
                <button
                  className="secondary-button"
                  onClick={() => showDirectory("热门")}
                >
                  浏览所有市场 <Icon name="arrow" size={15} />
                </button>
              </div>
            )}
            <p className="directory-note">
              所有市场价格、概率和交易量均为演示数据。
            </p>
          </section>
        ) : (
          <>
            <div className="breadcrumb">
              <button onClick={() => showDirectory("热门")}>所有市场</button>
              <Icon name="chevron" size={12} />
              <button onClick={() => showDirectory(market.category)}>
                {market.category}
              </button>
              <Icon name="chevron" size={12} />
              <span>{market.title}</span>
            </div>
            <div className="market-layout">
              <section className="market-main">
                <MarketHeader
                  market={market}
                  day={day}
                  saved={saved.includes(marketId)}
                  onSave={() => toggleSave(marketId)}
                  onShare={share}
                />
                <MarketDateTabs
                  day={day}
                  onChange={(next) => {
                    setDay(next);
                    const p = probabilityFor(market, targetIndex, next);
                    setPrice(outcome === "yes" ? p : 100 - p);
                  }}
                />
                <section className="chart-section">
                  <div className="quote-row">
                    <div>
                      <div className="quote-label">
                        {chartMode === "price"
                          ? `${market.symbol} 参考价格`
                          : `高于 $${targetLabel(target)} 的概率`}
                        <span className="data-label">模拟数据</span>
                      </div>
                      <div className="quote-price">
                        <strong>
                          {chartMode === "price"
                            ? `$${money(market.price)}`
                            : `${probability}%`}
                        </strong>
                        <span
                          className={
                            market.change >= 0 ? "text-green" : "text-red"
                          }
                        >
                          <Icon name="trend" size={14} />{" "}
                          {market.change >= 0 ? "+" : ""}
                          {market.change.toFixed(2)}% <small>演示涨跌</small>
                        </span>
                      </div>
                    </div>
                    <div className="chart-switch" aria-label="图表类型">
                      <button
                        className={chartMode === "price" ? "active" : ""}
                        aria-label="显示价格图"
                        aria-pressed={chartMode === "price"}
                        onClick={() => setChartMode("price")}
                      >
                        <Icon name="chart" size={17} />
                      </button>
                      <button
                        className={chartMode === "probability" ? "active" : ""}
                        aria-label="显示概率图"
                        aria-pressed={chartMode === "probability"}
                        onClick={() => setChartMode("probability")}
                      >
                        <span>%</span>
                      </button>
                    </div>
                  </div>
                  <PriceChart
                    data={chartData}
                    mode={chartMode}
                    range={range}
                    probability={probability}
                  />
                  <div className="chart-bottom">
                    <div className="chart-ranges" aria-label="图表周期">
                      {["1H", "6H", "1D", "1W", "ALL"].map((value) => (
                        <button
                          key={value}
                          aria-pressed={range === value}
                          className={range === value ? "active" : ""}
                          onClick={() => setRange(value)}
                        >
                          {value}
                        </button>
                      ))}
                    </div>
                    <span>
                      <span className="purple-dot" />{" "}
                      {chartMode === "price"
                        ? `${market.symbol} / USD`
                        : "是的概率"}
                    </span>
                  </div>
                </section>
                <section className="outcomes-section">
                  <div className="outcomes-heading">
                    <span>预测结果</span>
                    <span>概率</span>
                    <span>选择你的预测</span>
                  </div>
                  {(market.chainAddress ? market.targets.slice(0, 1) : market.targets).map((value, index) => {
                    const p = probabilityFor(market, index, day);
                    return (
                      <div
                        className={`outcome-row ${targetIndex === index ? "selected" : ""}`}
                        key={`${market.id}:${index}:${value}`}
                      >
                        <button
                          className="outcome-target"
                          onClick={() => selectOutcome(index, outcome)}
                          aria-pressed={targetIndex === index}
                        >
                          <span className="selection-indicator" />
                          <span>
                            <strong>${targetLabel(value)}</strong>
                            <small>
                              ${money(market.volume * (0.1 + index * 0.05))}{" "}
                              交易量
                            </small>
                          </span>
                        </button>
                        <div className="outcome-probability">
                          <strong>{p}%</strong>
                          <div>
                            <span style={{ width: `${p}%` }} />
                          </div>
                        </div>
                        <div className="outcome-actions">
                          <button
                            className={`yes ${targetIndex === index && outcome === "yes" ? "chosen" : ""}`}
                            onClick={() => selectOutcome(index, "yes", true)}
                          >
                            买入 是 <span>{p}¢</span>
                          </button>
                          <button
                            className={`no ${targetIndex === index && outcome === "no" ? "chosen" : ""}`}
                            onClick={() => selectOutcome(index, "no", true)}
                          >
                            买入 否 <span>{100 - p}¢</span>
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </section>
                <MarketOrderBook
                  probability={probability}
                  marketAddress={market.chainAddress as `0x${string}` | undefined}
                  outcome={outcome}
                  onOutcome={(next) => selectOutcome(targetIndex, next)}
                  onPrice={(next) => {
                    setOrderType("limit");
                    setPrice(next);
                    setNotice(`限价已设为 ${next}¢`);
                    if (window.innerWidth < 1000)
                      document
                        .getElementById("trade-panel")
                        ?.scrollIntoView({ behavior: "smooth" });
                  }}
                />
                <section className="discussion-section">
                  <div
                    className="discussion-tabs"
                    role="tablist"
                    aria-label="市场信息"
                  >
                    {[
                      {
                        value: "comments",
                        label: `评论 (${marketComments.length})`,
                      },
                      { value: "activity", label: "市场动态" },
                      { value: "rules", label: "市场规则" },
                    ].map((item, index) => (
                      <button
                        key={item.value}
                        id={`tab-${item.value}`}
                        role="tab"
                        aria-selected={activeTab === item.value}
                        aria-controls={`panel-${item.value}`}
                        tabIndex={activeTab === item.value ? 0 : -1}
                        className={activeTab === item.value ? "active" : ""}
                        onClick={() => setActiveTab(item.value)}
                        onKeyDown={(event) => {
                          if (
                            event.key === "ArrowRight" ||
                            event.key === "ArrowLeft"
                          ) {
                            event.preventDefault();
                            const next = ["comments", "activity", "rules"][
                              (index + (event.key === "ArrowRight" ? 1 : 2)) % 3
                            ];
                            setActiveTab(next);
                            document.getElementById(`tab-${next}`)?.focus();
                          }
                        }}
                      >
                        {item.label}
                      </button>
                    ))}
                  </div>
                  <div
                    role="tabpanel"
                    id={`panel-${activeTab}`}
                    aria-labelledby={`tab-${activeTab}`}
                  >
                    {activeTab === "comments" ? (
                      <>
                        <form
                          className="comment-form"
                          onSubmit={(event) => {
                            event.preventDefault();
                            if (!comment.trim()) return;
                            setComments([
                              ...comments,
                              {
                                id: Date.now(),
                                marketId,
                                author: "你 · 演示用户",
                                text: comment.trim(),
                                time: "刚刚",
                                likes: 0,
                              },
                            ]);
                            setComment("");
                            setNotice("评论已添加，仅在本次演示中显示。");
                          }}
                        >
                          <span className="avatar you">M</span>
                          <input
                            aria-label="评论内容"
                            placeholder="分享你的看法…"
                            maxLength={300}
                            value={comment}
                            onChange={(event) => setComment(event.target.value)}
                          />
                          <button type="submit" disabled={!comment.trim()}>
                            发布
                          </button>
                        </form>
                        <div className="comments-toolbar">
                          <span>理性讨论，发现更多观点</span>
                          <Dropdown
                            label="评论排序"
                            value={commentSort}
                            options={[
                              { value: "latest", label: "最新优先" },
                              { value: "top", label: "最受欢迎" },
                            ]}
                            onChange={setCommentSort}
                          />
                        </div>
                        {marketComments.length ? (
                          marketComments.map((item) => (
                            <article className="comment" key={item.id}>
                              <span
                                className={`avatar ${item.id === 2 ? "peach" : ""}`}
                              >
                                {item.author.slice(0, 1).toUpperCase()}
                              </span>
                              <div>
                                <div className="comment-author">
                                  <strong>{item.author}</strong>
                                  <span>{item.time}</span>
                                </div>
                                <p>{item.text}</p>
                                <button
                                  className={`like-button ${liked.includes(item.id) ? "liked" : ""}`}
                                  aria-label={`点赞 ${item.author} 的评论`}
                                  aria-pressed={liked.includes(item.id)}
                                  onClick={() =>
                                    setLiked(
                                      liked.includes(item.id)
                                        ? liked.filter((id) => id !== item.id)
                                        : [...liked, item.id],
                                    )
                                  }
                                >
                                  <Icon name="trend" size={13} />
                                  {item.likes + Number(liked.includes(item.id))}
                                </button>
                              </div>
                            </article>
                          ))
                        ) : (
                          <div className="small-empty">
                            还没有评论，来分享第一个观点吧。
                          </div>
                        )}
                      </>
                    ) : activeTab === "activity" ? (
                      <div className="activity-list">
                        {[0, 1, 2, 3].map((item) => (
                          <div key={item}>
                            <span
                              className={`activity-dot ${item % 2 ? "sell" : ""}`}
                            />
                            <span>
                              <strong>
                                {
                                  [
                                    "0x8f…4a2b",
                                    "0x3c…9d1e",
                                    "0xa1…7b8c",
                                    "0x6e…2f3a",
                                  ][item]
                                }
                              </strong>{" "}
                              {item % 2 ? "卖出" : "买入"}{" "}
                              <b
                                className={item % 2 ? "text-red" : "text-green"}
                              >
                                {item % 2 ? "否" : "是"}
                              </b>
                            </span>
                            <span>
                              {80 + item * 35} 份 ·{" "}
                              {item % 2 ? 100 - probability : probability}¢
                            </span>
                            <small>{2 + item * 4} 分钟前</small>
                          </div>
                        ))}
                        <p className="directory-note">
                          模拟成交记录，不代表真实交易。
                        </p>
                      </div>
                    ) : (
                      <div className="market-rules">
                        <h3>这个市场如何结算？</h3>
                        <p>
                          本市场以 {marketSettlementLabel(market, day)} 的{" "}
                          {market.title} / USD
                          参考价格为判定点。若参考价格严格高于所选价位，则该结果判定为「是」；低于或等于则判定为「否」。
                        </p>
                        <div>
                          <span>结算时间</span>
                          <strong>{marketSettlementLabel(market, day)}</strong>
                        </div>
                        <div>
                          <span>参考数据</span>
                          <strong>本地演示价格</strong>
                        </div>
                        <p className="rule-note">
                          价格、概率、成交记录与结算规则仅用于展示界面，未接入真实行情或结算服务。
                        </p>
                      </div>
                    )}
                  </div>
                </section>
              </section>
              <TradingPanel
                key={`${marketId}-${day}-${targetIndex}-${orderType}`}
                market={market}
                day={day}
                target={target}
                probability={probability}
                outcome={outcome}
                onOutcome={(next) => selectOutcome(targetIndex, next)}
                orderType={orderType}
                onOrderType={setOrderType}
                price={price}
                onPrice={setPrice}
                onNotice={setNotice}
              />
            </div>
            <section className="related-markets">
              <div className="section-title-row">
                <h2>发现更多市场</h2>
                <button
                  className="text-link"
                  onClick={() => showDirectory("热门")}
                >
                  查看全部 <Icon name="arrow" size={15} />
                </button>
              </div>
              <div className="related-grid">
                {allMarkets
                  .filter((item) => item.id !== marketId)
                  .slice(0, 3)
                  .map((item) => (
                    <button
                      className="related-card"
                      key={item.id}
                      onClick={() => selectMarket(item)}
                    >
                      <span
                        className="mini-market-icon"
                        style={{ background: item.color }}
                      >
                        <AssetSymbol
                          symbol={item.symbol}
                          fallback={item.icon}
                        />
                      </span>
                      <span>
                        <strong>{item.title}在{marketDateLabel(item)}高于多少？</strong>
                        <small>
                          ${(item.volume / 1000).toFixed(1)}k 交易量
                        </small>
                      </span>
                      <Icon name="arrow" size={16} />
                    </button>
                  ))}
              </div>
            </section>
          </>
        )}
      </main>
      <footer className="site-footer">
        <div>
          <BrandMark />
          <strong>monadmarket</strong>
          <span>未来，由每一个判断构成。</span>
        </div>
        <div>
          <span className="demo-badge">DEMO</span>
          <span>行情为演示数据 · 交易提交测试网</span>
          <button onClick={() => setModal("guide")}>
            使用指南 <Icon name="arrow" size={14} />
          </button>
        </div>
      </footer>
      {notice && (
        <div className="toast" role="status">
          <span className="toast-icon">
            <Icon name="check" size={16} />
          </span>
          <span>{notice}</span>
          <button
            className="icon-button"
            onClick={() => setNotice("")}
            aria-label="关闭提示"
          >
            <Icon name="close" size={15} />
          </button>
        </div>
      )}
      {modal === "share" && (
        <Modal title="分享这个市场" onClose={() => setModal(null)}>
          <div className="share-card">
            <div
              className="mini-market-icon"
              style={{ background: market.color }}
            >
              <AssetSymbol symbol={market.symbol} fallback={market.icon} />
            </div>
            <h3>
              {market.title}在{marketDateLabel(market, day)}高于 ${targetLabel(target)}？
            </h3>
            <div>
              <strong>{probability}%</strong>
              <span>演示概率</span>
            </div>
          </div>
          <label className="share-label" htmlFor="share-url">
            市场链接
          </label>
          <div className="share-input">
            <input
              id="share-url"
              readOnly
              value={shareUrl}
              onFocus={(event) => event.target.select()}
            />
            <button
              className="primary-button"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(shareUrl);
                  setNotice("市场链接已复制");
                } catch {
                  document.getElementById("share-url")?.focus();
                  setNotice("请选中链接后手动复制。");
                }
              }}
            >
              <Icon name="copy" size={16} />
              复制
            </button>
          </div>
        </Modal>
      )}
      {modal === "guide" && (
        <Modal title="用你的判断，探索未来" onClose={() => setModal(null)}>
          <p className="guide-intro">在 Monad Market，体验预测市场的每一步。</p>
          <div className="guide-steps">
            {[
              ["发现市场", "搜索感兴趣的资产，切换日期，观察价格和概率。"],
              ["选择你的预测", "选择一个目标价位，再选择「是」或「否」。"],
              [
                "连接钱包，提交测试网订单",
                "领取测试 USDC 并充值到 Vault，再选择订单类型、填写参数并签名。",
              ],
            ].map(([title, description], index) => (
              <div key={title}>
                <span>{index + 1}</span>
                <div>
                  <strong>{title}</strong>
                  <p>{description}</p>
                </div>
              </div>
            ))}
          </div>
          <p className="modal-note">
            图表行情与动态仍为演示数据。订单簿挂单份额、Vault 余额及持仓从 Monad Testnet 读取；交易需要连接钱包并持有 MON 支付 gas。
          </p>
          <button
            className="primary-button full-width"
            onClick={() => setModal(null)}
          >
            开始探索 <Icon name="arrow" size={16} />
          </button>
        </Modal>
      )}
    </div>
  );
}
