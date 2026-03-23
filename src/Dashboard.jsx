import { useState, useEffect, useCallback, useMemo } from "react";

const MORPHO_API = "https://api.morpho.org/graphql";
const DEFILLAMA_PRICES = "https://coins.llama.fi/prices/current";

const CHAIN_MAP = {
  1: { name: "Ethereum", short: "ETH", color: "#627EEA", explorer: "https://etherscan.io" },
  8453: { name: "Base", short: "BASE", color: "#0052FF", explorer: "https://basescan.org" },
  42161: { name: "Arbitrum", short: "ARB", color: "#28A0F0", explorer: "https://arbiscan.io" },
};

const CHAIN_LLAMA_PREFIX = {
  1: "ethereum",
  8453: "base",
  42161: "arbitrum",
};

const MORPHO_QUERY = `{
  markets(
    first: 500
    orderBy: SupplyAssetsUsd
    orderDirection: Desc
    where: { chainId_in: [1, 8453, 42161] }
  ) {
    items {
      uniqueKey
      lltv
      oracleAddress
      morphoBlue { chain { id network } }
      oracle {
        address
        type
        data {
          ... on MorphoChainlinkOracleData {
            baseFeedOne { address description }
            baseFeedTwo { address description }
            quoteFeedOne { address description }
            quoteFeedTwo { address description }
          }
          ... on MorphoChainlinkOracleV2Data {
            baseFeedOne { address description }
            baseFeedTwo { address description }
            quoteFeedOne { address description }
            quoteFeedTwo { address description }
          }
        }
      }
      loanAsset { address symbol decimals priceUsd }
      collateralAsset { address symbol decimals priceUsd }
      state {
        supplyAssetsUsd
        borrowAssetsUsd
        utilization
      }
      warnings { type level }
    }
  }
}`;

function classifyOracle(market) {
  const oracle = market.oracle;
  if (!oracle) return { type: "no_oracle", hardcoded: false, feeds: [], label: "No Oracle (Idle)" };

  const oracleType = oracle.type;
  const data = oracle.data || {};
  const feeds = [];

  for (const key of ["baseFeedOne", "baseFeedTwo", "quoteFeedOne", "quoteFeedTwo"]) {
    if (data[key]) feeds.push({ slot: key, ...data[key] });
  }

  if (oracleType === "Unknown" || oracleType === null) {
    return { type: "unknown", hardcoded: true, feeds: [], label: "Unknown Oracle" };
  }

  if (
    (oracleType === "ChainlinkOracle" || oracleType === "ChainlinkOracleV2") &&
    feeds.length === 0
  ) {
    return { type: "hardcoded", hardcoded: true, feeds: [], label: "Hardcoded (No Feeds)" };
  }

  return { type: "dynamic", hardcoded: false, feeds, label: oracleType };
}

function formatUsd(value) {
  if (!value && value !== 0) return "—";
  if (value >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `$${(value / 1e6).toFixed(2)}M`;
  if (value >= 1e3) return `$${(value / 1e3).toFixed(1)}K`;
  return `$${value.toFixed(0)}`;
}

function formatPct(value) {
  if (!value && value !== 0) return "—";
  return `${(value * 100).toFixed(1)}%`;
}

function RiskBadge({ level }) {
  const colors = {
    critical: { bg: "rgba(239,68,68,0.15)", border: "#ef4444", text: "#fca5a5" },
    high: { bg: "rgba(249,115,22,0.15)", border: "#f97316", text: "#fdba74" },
    medium: { bg: "rgba(234,179,8,0.15)", border: "#eab308", text: "#fde047" },
    low: { bg: "rgba(34,197,94,0.15)", border: "#22c55e", text: "#86efac" },
  };
  const c = colors[level] || colors.low;
  return (
    <span
      style={{
        padding: "2px 8px",
        borderRadius: "4px",
        fontSize: "11px",
        fontWeight: 600,
        background: c.bg,
        border: `1px solid ${c.border}`,
        color: c.text,
        textTransform: "uppercase",
        letterSpacing: "0.5px",
      }}
    >
      {level}
    </span>
  );
}

function assessRisk(market, oracleInfo, deviation) {
  const supply = market.state?.supplyAssetsUsd || 0;
  const absDev = Math.abs(deviation || 0);

  if (!oracleInfo.hardcoded) return "low";
  if (absDev > 5) return "critical";
  if (absDev > 2) return "high";
  if (supply > 50_000_000) return "high";
  if (supply > 10_000_000) return "medium";
  return "medium";
}

function Spinner() {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <div
        style={{
          width: 16,
          height: 16,
          border: "2px solid rgba(255,255,255,0.1)",
          borderTop: "2px solid #f97316",
          borderRadius: "50%",
          animation: "spin 1s linear infinite",
        }}
      />
      <span style={{ color: "rgba(255,255,255,0.5)", fontSize: 13 }}>Loading...</span>
    </div>
  );
}

export default function HardcodedOracleMonitor() {
  const [markets, setMarkets] = useState([]);
  const [dexPrices, setDexPrices] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [lastUpdate, setLastUpdate] = useState(null);
  const [filter, setFilter] = useState("hardcoded"); // hardcoded | all | chain
  const [chainFilter, setChainFilter] = useState("all");
  const [sortBy, setSortBy] = useState("supply");
  const [sortDir, setSortDir] = useState("desc");
  const [minTvl, setMinTvl] = useState(1_000_000);
  const [searchQuery, setSearchQuery] = useState("");

  const fetchMarkets = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(MORPHO_API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: MORPHO_QUERY }),
      });
      const json = await res.json();
      if (json.errors) throw new Error(json.errors[0].message);

      const items = json.data.markets.items.map((m) => {
        const oracleInfo = classifyOracle(m);
        const chainId = m.morphoBlue?.chain?.id || 1;
        return { ...m, oracleInfo, chainId };
      });

      setMarkets(items);
      setLastUpdate(new Date());

      // Fetch DEX prices for collateral/loan assets
      const tokenAddrs = new Set();
      items.forEach((m) => {
        const prefix = CHAIN_LLAMA_PREFIX[m.chainId] || "ethereum";
        if (m.collateralAsset?.address)
          tokenAddrs.add(`${prefix}:${m.collateralAsset.address}`);
        if (m.loanAsset?.address)
          tokenAddrs.add(`${prefix}:${m.loanAsset.address}`);
      });

      // Batch in chunks of 50
      const addrArr = [...tokenAddrs];
      const prices = {};
      for (let i = 0; i < addrArr.length; i += 50) {
        const chunk = addrArr.slice(i, i + 50);
        try {
          const pRes = await fetch(`${DEFILLAMA_PRICES}/${chunk.join(",")}`);
          const pJson = await pRes.json();
          Object.assign(prices, pJson.coins || {});
        } catch {}
      }
      setDexPrices(prices);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchMarkets();
    const interval = setInterval(fetchMarkets, 120_000); // 2min refresh
    return () => clearInterval(interval);
  }, [fetchMarkets]);

  const processedMarkets = useMemo(() => {
    return markets
      .map((m) => {
        const chainId = m.chainId;
        const prefix = CHAIN_LLAMA_PREFIX[chainId] || "ethereum";

        let colDexPrice = null;
        let loanDexPrice = null;
        let deviation = null;

        if (m.collateralAsset?.address) {
          const key = `${prefix}:${m.collateralAsset.address}`;
          colDexPrice = dexPrices[key]?.price || null;
        }
        if (m.loanAsset?.address) {
          const key = `${prefix}:${m.loanAsset.address}`;
          loanDexPrice = dexPrices[key]?.price || null;
        }

        // Calculate deviation: oracle implied ratio vs DEX ratio
        const oracleColPrice = m.collateralAsset?.priceUsd;
        const oracleLoanPrice = m.loanAsset?.priceUsd;

        if (colDexPrice && loanDexPrice && oracleColPrice && oracleLoanPrice) {
          const oracleRatio = oracleColPrice / oracleLoanPrice;
          const dexRatio = colDexPrice / loanDexPrice;
          if (dexRatio > 0) {
            deviation = ((oracleRatio - dexRatio) / dexRatio) * 100;
          }
        }

        const risk = assessRisk(m, m.oracleInfo, deviation);

        return { ...m, colDexPrice, loanDexPrice, deviation, risk };
      })
      .filter((m) => {
        const supply = m.state?.supplyAssetsUsd || 0;
        if (supply < minTvl) return false;
        if (filter === "hardcoded" && !m.oracleInfo.hardcoded) return false;
        if (chainFilter !== "all" && m.chainId !== parseInt(chainFilter)) return false;
        if (searchQuery) {
          const q = searchQuery.toLowerCase();
          const col = (m.collateralAsset?.symbol || "").toLowerCase();
          const loan = (m.loanAsset?.symbol || "").toLowerCase();
          if (!col.includes(q) && !loan.includes(q)) return false;
        }
        return true;
      })
      .sort((a, b) => {
        let aVal, bVal;
        switch (sortBy) {
          case "supply":
            aVal = a.state?.supplyAssetsUsd || 0;
            bVal = b.state?.supplyAssetsUsd || 0;
            break;
          case "borrow":
            aVal = a.state?.borrowAssetsUsd || 0;
            bVal = b.state?.borrowAssetsUsd || 0;
            break;
          case "deviation":
            aVal = Math.abs(a.deviation || 0);
            bVal = Math.abs(b.deviation || 0);
            break;
          case "risk":
            const riskOrder = { critical: 4, high: 3, medium: 2, low: 1 };
            aVal = riskOrder[a.risk] || 0;
            bVal = riskOrder[b.risk] || 0;
            break;
          default:
            aVal = a.state?.supplyAssetsUsd || 0;
            bVal = b.state?.supplyAssetsUsd || 0;
        }
        return sortDir === "desc" ? bVal - aVal : aVal - bVal;
      });
  }, [markets, dexPrices, filter, chainFilter, sortBy, sortDir, minTvl, searchQuery]);

  const stats = useMemo(() => {
    const hardcoded = markets.filter((m) => m.oracleInfo.hardcoded);
    const totalHcTvl = hardcoded.reduce(
      (s, m) => s + (m.state?.supplyAssetsUsd || 0),
      0
    );
    const totalTvl = markets
      .filter((m) => (m.state?.supplyAssetsUsd || 0) >= minTvl)
      .reduce((s, m) => s + (m.state?.supplyAssetsUsd || 0), 0);
    return {
      totalMarkets: markets.filter((m) => (m.state?.supplyAssetsUsd || 0) >= minTvl).length,
      hardcodedCount: hardcoded.filter((m) => (m.state?.supplyAssetsUsd || 0) >= minTvl).length,
      totalHcTvl,
      totalTvl,
    };
  }, [markets, minTvl]);

  const handleSort = (col) => {
    if (sortBy === col) {
      setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    } else {
      setSortBy(col);
      setSortDir("desc");
    }
  };

  const SortArrow = ({ col }) => {
    if (sortBy !== col) return <span style={{ opacity: 0.3 }}>↕</span>;
    return <span>{sortDir === "desc" ? "↓" : "↑"}</span>;
  };

  return (
    <div
      style={{
        fontFamily: "'JetBrains Mono', 'SF Mono', 'Fira Code', monospace",
        background: "#0a0a0f",
        color: "#e2e2e8",
        minHeight: "100vh",
        padding: "24px",
      }}
    >
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;600;700&display=swap');
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        ::-webkit-scrollbar { width: 6px; height: 6px; }
        ::-webkit-scrollbar-track { background: #111118; }
        ::-webkit-scrollbar-thumb { background: #333; border-radius: 3px; }
        input, select { font-family: inherit; }
      `}</style>

      {/* Header */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          marginBottom: 24,
          flexWrap: "wrap",
          gap: 16,
        }}
      >
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
            <div
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: loading ? "#f97316" : "#22c55e",
                animation: loading ? "pulse 1.5s infinite" : "none",
              }}
            />
            <h1
              style={{
                fontSize: 18,
                fontWeight: 700,
                color: "#fff",
                letterSpacing: "-0.3px",
              }}
            >
              Hardcoded Oracle Monitor
            </h1>
            <span
              style={{
                fontSize: 10,
                padding: "2px 6px",
                background: "rgba(249,115,22,0.15)",
                border: "1px solid rgba(249,115,22,0.3)",
                borderRadius: 3,
                color: "#f97316",
                fontWeight: 600,
              }}
            >
              MORPHO BLUE
            </span>
          </div>
          <div style={{ fontSize: 11, color: "rgba(255,255,255,0.35)" }}>
            Monitoring markets with fixed-price oracles that don't liquidate on depeg
            {lastUpdate && (
              <span> · Updated {lastUpdate.toLocaleTimeString()}</span>
            )}
          </div>
        </div>
        <button
          onClick={fetchMarkets}
          disabled={loading}
          style={{
            padding: "6px 14px",
            background: "rgba(255,255,255,0.05)",
            border: "1px solid rgba(255,255,255,0.1)",
            borderRadius: 4,
            color: "#e2e2e8",
            fontSize: 12,
            cursor: "pointer",
            fontFamily: "inherit",
          }}
        >
          {loading ? "Refreshing..." : "↻ Refresh"}
        </button>
      </div>

      {error && (
        <div
          style={{
            padding: 12,
            background: "rgba(239,68,68,0.1)",
            border: "1px solid rgba(239,68,68,0.3)",
            borderRadius: 6,
            marginBottom: 16,
            fontSize: 12,
            color: "#fca5a5",
          }}
        >
          Error: {error}
        </div>
      )}

      {/* Stats */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
          gap: 12,
          marginBottom: 20,
        }}
      >
        {[
          {
            label: "Hardcoded Markets",
            value: stats.hardcodedCount,
            sub: `of ${stats.totalMarkets} total`,
            color: "#f97316",
          },
          {
            label: "Hardcoded TVL",
            value: formatUsd(stats.totalHcTvl),
            sub: `${stats.totalTvl > 0 ? ((stats.totalHcTvl / stats.totalTvl) * 100).toFixed(1) : 0}% of total`,
            color: "#ef4444",
          },
          {
            label: "Total Monitored TVL",
            value: formatUsd(stats.totalTvl),
            sub: `Min ${formatUsd(minTvl)} filter`,
            color: "#3b82f6",
          },
          {
            label: "Showing",
            value: processedMarkets.length,
            sub: filter === "hardcoded" ? "hardcoded only" : "all markets",
            color: "#8b5cf6",
          },
        ].map((s, i) => (
          <div
            key={i}
            style={{
              padding: "14px 16px",
              background: "rgba(255,255,255,0.02)",
              border: "1px solid rgba(255,255,255,0.06)",
              borderRadius: 6,
            }}
          >
            <div style={{ fontSize: 10, color: "rgba(255,255,255,0.4)", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.5px" }}>
              {s.label}
            </div>
            <div style={{ fontSize: 22, fontWeight: 700, color: s.color }}>{s.value}</div>
            <div style={{ fontSize: 10, color: "rgba(255,255,255,0.3)", marginTop: 2 }}>{s.sub}</div>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div
        style={{
          display: "flex",
          gap: 8,
          marginBottom: 16,
          flexWrap: "wrap",
          alignItems: "center",
        }}
      >
        <div style={{ display: "flex", gap: 2, background: "rgba(255,255,255,0.03)", borderRadius: 4, border: "1px solid rgba(255,255,255,0.06)", overflow: "hidden" }}>
          {[
            { key: "hardcoded", label: "Hardcoded Only" },
            { key: "all", label: "All Markets" },
          ].map((f) => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              style={{
                padding: "6px 12px",
                background: filter === f.key ? "rgba(249,115,22,0.2)" : "transparent",
                border: "none",
                color: filter === f.key ? "#f97316" : "rgba(255,255,255,0.4)",
                fontSize: 11,
                cursor: "pointer",
                fontFamily: "inherit",
                fontWeight: filter === f.key ? 600 : 400,
              }}
            >
              {f.label}
            </button>
          ))}
        </div>

        <select
          value={chainFilter}
          onChange={(e) => setChainFilter(e.target.value)}
          style={{
            padding: "6px 10px",
            background: "rgba(255,255,255,0.03)",
            border: "1px solid rgba(255,255,255,0.06)",
            borderRadius: 4,
            color: "#e2e2e8",
            fontSize: 11,
          }}
        >
          <option value="all">All Chains</option>
          {Object.entries(CHAIN_MAP).map(([id, c]) => (
            <option key={id} value={id}>{c.name}</option>
          ))}
        </select>

        <select
          value={minTvl}
          onChange={(e) => setMinTvl(Number(e.target.value))}
          style={{
            padding: "6px 10px",
            background: "rgba(255,255,255,0.03)",
            border: "1px solid rgba(255,255,255,0.06)",
            borderRadius: 4,
            color: "#e2e2e8",
            fontSize: 11,
          }}
        >
          <option value={100000}>Min $100K</option>
          <option value={1000000}>Min $1M</option>
          <option value={5000000}>Min $5M</option>
          <option value={10000000}>Min $10M</option>
          <option value={50000000}>Min $50M</option>
        </select>

        <input
          type="text"
          placeholder="Search token..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          style={{
            padding: "6px 10px",
            background: "rgba(255,255,255,0.03)",
            border: "1px solid rgba(255,255,255,0.06)",
            borderRadius: 4,
            color: "#e2e2e8",
            fontSize: 11,
            width: 140,
            outline: "none",
          }}
        />
      </div>

      {loading && markets.length === 0 ? (
        <div style={{ padding: 40, textAlign: "center" }}>
          <Spinner />
        </div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              fontSize: 12,
            }}
          >
            <thead>
              <tr
                style={{
                  borderBottom: "1px solid rgba(255,255,255,0.08)",
                }}
              >
                {[
                  { key: "risk", label: "Risk", width: 70 },
                  { key: "chain", label: "Chain", width: 60 },
                  { key: "pair", label: "Market", width: 180 },
                  { key: "oracle", label: "Oracle Type", width: 160 },
                  { key: "supply", label: "Supply TVL", width: 100 },
                  { key: "borrow", label: "Borrow", width: 100 },
                  { key: "util", label: "Util", width: 60 },
                  { key: "lltv", label: "LLTV", width: 60 },
                  { key: "deviation", label: "Price Dev.", width: 90 },
                  { key: "warnings", label: "Warnings", width: 120 },
                ].map((col) => (
                  <th
                    key={col.key}
                    onClick={() => ["supply", "borrow", "deviation", "risk"].includes(col.key) && handleSort(col.key)}
                    style={{
                      padding: "10px 8px",
                      textAlign: "left",
                      color: "rgba(255,255,255,0.4)",
                      fontWeight: 500,
                      fontSize: 10,
                      textTransform: "uppercase",
                      letterSpacing: "0.5px",
                      width: col.width,
                      cursor: ["supply", "borrow", "deviation", "risk"].includes(col.key) ? "pointer" : "default",
                      whiteSpace: "nowrap",
                      userSelect: "none",
                    }}
                  >
                    {col.label}{" "}
                    {["supply", "borrow", "deviation", "risk"].includes(col.key) && (
                      <SortArrow col={col.key} />
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {processedMarkets.map((m, idx) => {
                const chain = CHAIN_MAP[m.chainId] || CHAIN_MAP[1];
                const col = m.collateralAsset?.symbol || "—";
                const loan = m.loanAsset?.symbol || "—";
                const supply = m.state?.supplyAssetsUsd || 0;
                const borrow = m.state?.borrowAssetsUsd || 0;
                const util = m.state?.utilization;
                const lltv = m.lltv ? parseInt(m.lltv) / 1e18 : null;
                const dev = m.deviation;
                const warnings = m.warnings || [];
                const redWarnings = warnings.filter((w) => w.level === "RED");

                return (
                  <tr
                    key={m.uniqueKey}
                    style={{
                      borderBottom: "1px solid rgba(255,255,255,0.03)",
                      background: idx % 2 === 0 ? "transparent" : "rgba(255,255,255,0.01)",
                      transition: "background 0.15s",
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(255,255,255,0.04)")}
                    onMouseLeave={(e) => (e.currentTarget.style.background = idx % 2 === 0 ? "transparent" : "rgba(255,255,255,0.01)")}
                  >
                    <td style={{ padding: "10px 8px" }}>
                      <RiskBadge level={m.risk} />
                    </td>
                    <td style={{ padding: "10px 8px" }}>
                      <span
                        style={{
                          fontSize: 10,
                          padding: "2px 6px",
                          borderRadius: 3,
                          background: `${chain.color}22`,
                          color: chain.color,
                          fontWeight: 600,
                        }}
                      >
                        {chain.short}
                      </span>
                    </td>
                    <td style={{ padding: "10px 8px" }}>
                      <a
                        href={`https://app.morpho.org/market?id=${m.uniqueKey}&network=${m.chainId}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{
                          color: "#e2e2e8",
                          textDecoration: "none",
                          fontWeight: 600,
                        }}
                      >
                        {col}
                        <span style={{ color: "rgba(255,255,255,0.3)", fontWeight: 400 }}>/</span>
                        {loan}
                      </a>
                      {m.oracleInfo.hardcoded && (
                        <span style={{ marginLeft: 6, fontSize: 9, color: "#f97316" }}>⚠ HARDCODED</span>
                      )}
                    </td>
                    <td style={{ padding: "10px 8px" }}>
                      <div style={{ fontSize: 11, color: m.oracleInfo.hardcoded ? "#f97316" : "rgba(255,255,255,0.5)" }}>
                        {m.oracleInfo.label}
                      </div>
                      {m.oracleInfo.feeds.length > 0 && (
                        <div style={{ fontSize: 9, color: "rgba(255,255,255,0.25)", marginTop: 2, maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {m.oracleInfo.feeds.map((f) => f.description).join(" · ")}
                        </div>
                      )}
                    </td>
                    <td style={{ padding: "10px 8px", fontWeight: 600 }}>
                      {formatUsd(supply)}
                    </td>
                    <td style={{ padding: "10px 8px", color: "rgba(255,255,255,0.5)" }}>
                      {formatUsd(borrow)}
                    </td>
                    <td style={{ padding: "10px 8px", color: "rgba(255,255,255,0.5)" }}>
                      {util != null ? formatPct(util) : "—"}
                    </td>
                    <td style={{ padding: "10px 8px", color: "rgba(255,255,255,0.5)" }}>
                      {lltv != null ? formatPct(lltv) : "—"}
                    </td>
                    <td style={{ padding: "10px 8px" }}>
                      {dev != null ? (
                        <span
                          style={{
                            color:
                              Math.abs(dev) > 5
                                ? "#ef4444"
                                : Math.abs(dev) > 2
                                ? "#f97316"
                                : Math.abs(dev) > 0.5
                                ? "#eab308"
                                : "#22c55e",
                            fontWeight: 600,
                          }}
                        >
                          {dev > 0 ? "+" : ""}
                          {dev.toFixed(2)}%
                        </span>
                      ) : (
                        <span style={{ color: "rgba(255,255,255,0.2)" }}>—</span>
                      )}
                    </td>
                    <td style={{ padding: "10px 8px" }}>
                      <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                        {redWarnings.map((w, wi) => (
                          <span
                            key={wi}
                            style={{
                              fontSize: 9,
                              padding: "1px 5px",
                              borderRadius: 3,
                              background: "rgba(239,68,68,0.1)",
                              color: "#fca5a5",
                              border: "1px solid rgba(239,68,68,0.2)",
                            }}
                            title={w.type}
                          >
                            {w.type.replace(/_/g, " ").replace("bad debt ", "BD:")}
                          </span>
                        ))}
                        {warnings.filter((w) => w.level === "YELLOW").slice(0, 2).map((w, wi) => (
                          <span
                            key={`y-${wi}`}
                            style={{
                              fontSize: 9,
                              padding: "1px 5px",
                              borderRadius: 3,
                              background: "rgba(234,179,8,0.1)",
                              color: "#fde047",
                              border: "1px solid rgba(234,179,8,0.15)",
                            }}
                            title={w.type}
                          >
                            {w.type.replace(/_/g, " ")}
                          </span>
                        ))}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {processedMarkets.length === 0 && !loading && (
            <div
              style={{
                padding: 40,
                textAlign: "center",
                color: "rgba(255,255,255,0.3)",
                fontSize: 13,
              }}
            >
              No markets found with current filters
            </div>
          )}
        </div>
      )}

      {/* Methodology */}
      <div
        style={{
          marginTop: 24,
          padding: "16px",
          background: "rgba(255,255,255,0.02)",
          border: "1px solid rgba(255,255,255,0.05)",
          borderRadius: 6,
          fontSize: 10,
          color: "rgba(255,255,255,0.3)",
          lineHeight: 1.6,
        }}
      >
        <div style={{ fontWeight: 600, color: "rgba(255,255,255,0.5)", marginBottom: 6 }}>
          Detection Methodology
        </div>
        <strong>Hardcoded Oracle</strong> = oracle.type is "Unknown" OR ChainlinkOracle/V2 with zero price feeds.
        These markets use a fixed exchange rate (typically 1:1) and <strong>will not trigger liquidations</strong> when the collateral depegs.{" "}
        <strong>Price Deviation</strong> = (Morpho oracle price ratio - DefiLlama DEX price ratio) / DEX ratio × 100.{" "}
        <strong>Risk Levels</strong>: Critical (&gt;5% dev), High (&gt;2% dev or &gt;$50M TVL hardcoded), Medium (hardcoded), Low (dynamic oracle).{" "}
        Data refreshes every 2 minutes.
      </div>
    </div>
  );
}
