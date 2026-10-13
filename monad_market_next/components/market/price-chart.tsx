"use client";
import { useId, useState } from "react";
import type { MarketPricePoint } from "@/lib/market-data";
import { money } from "@/lib/market-data";

export function PriceChart({
  data,
  mode,
  range,
  probability,
}: {
  data: MarketPricePoint[];
  mode: "price" | "probability";
  range: string;
  probability: number;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const gradient = useId();
  const width = 850,
    height = 260,
    right = 72,
    top = 20,
    bottom = 30;
  const values = data.map((point) =>
    mode === "price"
      ? point.price
      : Math.min(
          98,
          Math.max(
            2,
            probability + (point.price / data[data.length - 1].price - 1) * 500,
          ),
        ),
  );
  const span = Math.max(...values) - Math.min(...values) || 1;
  const min = Math.min(...values) - span * 0.15,
    max = Math.max(...values) + span * 0.2;
  const x = (index: number) => (index / (data.length - 1)) * (width - right);
  const y = (value: number) =>
    top + ((max - value) / (max - min)) * (height - top - bottom);
  const points = values
    .map((value, index) => `${x(index)},${y(value)}`)
    .join(" ");
  const last = values[values.length - 1];
  const format = (value: number) =>
    mode === "price"
      ? value < 10
        ? value.toFixed(2)
        : Math.round(value).toLocaleString("en-US")
      : `${Math.round(value)}%`;
  const dateFormat = (timestamp: number) =>
    new Date(timestamp).toLocaleString(
      "zh-CN",
      range === "ALL" || range === "1W"
        ? { month: "numeric", day: "numeric", timeZone: "UTC" }
        : {
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
            timeZone: "UTC",
          },
    );
  const active = hover === null ? null : Math.min(data.length - 1, hover);
  return (
    <div className="price-chart" onPointerLeave={() => setHover(null)}>
      {active !== null && (
        <div
          className="chart-tooltip"
          style={{
            left: `${Math.min(76, Math.max(2, (x(active) / width) * 100))}%`,
          }}
        >
          <small>
            {new Date(data[active].timestamp).toLocaleString("zh-CN", {
              timeZone: "UTC",
              month: "numeric",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
              hour12: false,
            })}{" "}
            UTC
          </small>
          <strong>
            {mode === "price"
              ? `$${money(values[active])}`
              : `${values[active].toFixed(1)}%`}
          </strong>
        </div>
      )}
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`${mode === "price" ? "价格" : "概率"}走势，周期 ${range}，演示数据`}
        onPointerMove={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          setHover(
            Math.max(
              0,
              Math.min(
                data.length - 1,
                Math.round(
                  ((((event.clientX - rect.left) / rect.width) * width) /
                    (width - right)) *
                    (data.length - 1),
                ),
              ),
            ),
          );
        }}
      >
        <defs>
          <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#8061ed" stopOpacity=".13" />
            <stop offset="100%" stopColor="#8061ed" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0, 1, 2, 3, 4].map((index) => {
          const value = min + ((max - min) * index) / 4;
          return (
            <g key={index}>
              <line
                x1="0"
                x2={width - right}
                y1={y(value)}
                y2={y(value)}
                className="chart-grid"
              />
              <text
                x={width - right + 14}
                y={y(value) + 4}
                className="chart-axis-label"
              >
                {format(value)}
              </text>
            </g>
          );
        })}
        <polygon
          points={`0,${height - bottom} ${points} ${width - right},${height - bottom}`}
          fill={`url(#${gradient})`}
        />
        <polyline points={points} className="chart-line" />
        <line
          x1="0"
          x2={width - right}
          y1={y(last)}
          y2={y(last)}
          className="chart-current-line"
        />
        <circle cx={width - right} cy={y(last)} r="4" fill="#8061ed" />
        {active !== null && (
          <g>
            <line
              x1={x(active)}
              x2={x(active)}
              y1={top}
              y2={height - bottom}
              className="chart-hover-line"
            />
            <circle
              cx={x(active)}
              cy={y(values[active])}
              r="5"
              fill="#8061ed"
              stroke="white"
              strokeWidth="2"
            />
          </g>
        )}
        {[0, 1, 2, 3, 4, 5].map((index) => {
          const i = Math.round((index / 5) * (data.length - 1));
          return (
            <text
              key={index}
              x={x(i)}
              y={height - 4}
              textAnchor={
                index === 0 ? "start" : index === 5 ? "end" : "middle"
              }
              className="chart-date-label"
            >
              {dateFormat(data[i].timestamp)}
            </text>
          );
        })}
      </svg>
      <span className="chart-watermark">
        monad<span>market</span>
      </span>
    </div>
  );
}
