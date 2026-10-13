"use client";
import { Dropdown } from "./ui";
export function MarketDateTabs({
  day,
  onChange,
}: {
  day: number;
  onChange: (day: number) => void;
}) {
  return (
    <nav className="market-date-tabs" aria-label="市场日期">
      <Dropdown
        label="过去的市场"
        value={day < 15 ? String(day) : "past"}
        options={[
          { value: "13", label: "9月13日 · 已结束" },
          { value: "14", label: "9月14日 · 已结束" },
        ]}
        onChange={(value) => onChange(Number(value))}
      />
      {[15, 16, 17, 18].map((date) => (
        <button
          key={date}
          className={day === date ? "date-tab active" : "date-tab"}
          aria-pressed={day === date}
          onClick={() => onChange(date)}
        >
          {date === 15 && <span className="live-dot" />}9月{date}日
        </button>
      ))}
      <Dropdown
        label="更多日期"
        value={day > 18 ? String(day) : "more"}
        options={[19, 20, 21, 22].map((date) => ({
          value: String(date),
          label: `9月${date}日`,
        }))}
        onChange={(value) => onChange(Number(value))}
      />
    </nav>
  );
}
