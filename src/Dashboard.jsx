import { useState, useEffect, useCallback, useMemo } from "react";

const MORPHO_API = "https://api.morpho.org/graphql";
const DEFILLAMA_PRICES = "https://coins.llama.fi/prices/current";

const CHAIN_MAP = {
  1: { name: "Ethereum", short: "ETH", color: "#627EEA" },
  8453: { name: "Base", short: "BASE", color: "#0052FF" },
  42161: { name: "Arbitrum", short: "ARB", color: "#28A0F0" },
};

const CHAIN_LLAMA_PREFIX = { 1: "ethereum", 8453: "base", 42161: "arbitrum" };

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
      state { supplyAssetsUsd borrowAssetsUsd utilization }
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
    return { type: "unknown", hardcoded: true, feeds: [], label: "Unknown" };
  }
  if ((oracleType === "ChainlinkOracle" || oracleType === "ChainlinkOracleV2") && feeds.length === 0) {
    return { type: "hardcoded", hardcoded: true, feeds: [], label: "Hardcoded" };
  }
  return { type: "dynamic", hardcoded: false, feeds, label: oracleType.replace("Chainlink", "CL") };
}

function fmt(v) {
  if (!v && v !== 0) return "—";
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
  return `$${v.toFixed(0)}`;
}

function pct(v) {
  if (!v && v !== 0) return "—";
  return `${(v * 100).toFixed(1)}%`;
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

const RISK_STYLE = {
  critical: { bg: "#fef2f2", color: "#dc2626", border: "#fecaca" },
  high: { bg: "#fff7ed", color: "#ea580c", border: "#fed7aa" },
  medium: { bg: "#fefce8", color: "#ca8a04", border: "#fef08a" },
  low: { bg: "#f0fdf4", color: "#16a34a", border: "#bbf7d0" },
};

export default function HardcodedOracleMonitor() {
  const [markets, setMarkets] = useState([]);
  const [dexPrices, setDexPrices] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [lastUpdate, setLastUpdate] = useState(null);
  const [filter, setFilter] = useState("hardcoded");
  const [chainFilter, setChainFilter] = useState("all");
  const [sortBy, setSortBy] = useState("supply");
  const [sortDir, setSortDir] = useState("desc");
  const [minTvl, setMinTvl] = useState(1_000_000);
  const [search, setSearch] = useState("");

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

      const tokenAddrs = new Set();
      items.forEach((m) => {
        const pfx = CHAIN_LLAMA_PREFIX[m.chainId] || "ethereum";
        if (m.collateralAsset?.address) tokenAddrs.add(`${pfx}:${m.collateralAsset.address}`);
        if (m.loanAsset?.address) tokenAddrs.add(`${pfx}:${m.loanAsset.address}`);
      });
      const addrArr = [...tokenAddrs];
      const prices = {};
      for (let i = 0; i < addrArr.length; i += 50) {
        try {
          const pRes = await fetch(`${DEFILLAMA_PRICES}/${addrArr.slice(i, i + 50).join(",")}`);
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
    const iv = setInterval(fetchMarkets, 120_000);
    return () => clearInterval(iv);
  }, [fetchMarkets]);

  const processed = useMemo(() => {
    return markets
      .map((m) => {
        const pfx = CHAIN_LLAMA_PREFIX[m.chainId] || "ethereum";
        let colDex = m.collateralAsset?.address ? dexPrices[`${pfx}:${m.collateralAsset.address}`]?.price : null;
        let loanDex = m.loanAsset?.address ? dexPrices[`${pfx}:${m.loanAsset.address}`]?.price : null;
        let deviation = null;
        const oCol = m.collateralAsset?.priceUsd;
        const oLoan = m.loanAsset?.priceUsd;
        if (colDex && loanDex && oCol && oLoan) {
          const oR = oCol / oLoan;
          const dR = colDex / loanDex;
          if (dR > 0) deviation = ((oR - dR) / dR) * 100;
        }
        const risk = assessRisk(m, m.oracleInfo, deviation);
        return { ...m, colDex, loanDex, deviation, risk };
      })
      .filter((m) => {
        const s = m.state?.supplyAssetsUsd || 0;
        if (s < minTvl) return false;
        if (filter === "hardcoded" && !m.oracleInfo.hardcoded) return false;
        if (chainFilter !== "all" && m.chainId !== parseInt(chainFilter)) return false;
        if (search) {
          const q = search.toLowerCase();
          const c = (m.collateralAsset?.symbol || "").toLowerCase();
          const l = (m.loanAsset?.symbol || "").toLowerCase();
          if (!c.includes(q) && !l.includes(q)) return false;
        }
        return true;
      })
      .sort((a, b) => {
        let av, bv;
        if (sortBy === "supply") { av = a.state?.supplyAssetsUsd || 0; bv = b.state?.supplyAssetsUsd || 0; }
        else if (sortBy === "borrow") { av = a.state?.borrowAssetsUsd || 0; bv = b.state?.borrowAssetsUsd || 0; }
        else if (sortBy === "deviation") { av = Math.abs(a.deviation || 0); bv = Math.abs(b.deviation || 0); }
        else if (sortBy === "risk") { const ro = { critical: 4, high: 3, medium: 2, low: 1 }; av = ro[a.risk] || 0; bv = ro[b.risk] || 0; }
        else { av = a.state?.supplyAssetsUsd || 0; bv = b.state?.supplyAssetsUsd || 0; }
        return sortDir === "desc" ? bv - av : av - bv;
      });
  }, [markets, dexPrices, filter, chainFilter, sortBy, sortDir, minTvl, search]);

  const stats = useMemo(() => {
    const hc = markets.filter((m) => m.oracleInfo.hardcoded && (m.state?.supplyAssetsUsd || 0) >= minTvl);
    const all = markets.filter((m) => (m.state?.supplyAssetsUsd || 0) >= minTvl);
    const hcTvl = hc.reduce((s, m) => s + (m.state?.supplyAssetsUsd || 0), 0);
    const totalTvl = all.reduce((s, m) => s + (m.state?.supplyAssetsUsd || 0), 0);
    return { hcCount: hc.length, allCount: all.length, hcTvl, totalTvl };
  }, [markets, minTvl]);

  const doSort = (col) => {
    if (sortBy === col) setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    else { setSortBy(col); setSortDir("desc"); }
  };

  const S = {
    page: { fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif", background: "#fff", color: "#111", minHeight: "100vh", padding: "20px 24px", fontSize: 13 },
    header: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16, flexWrap: "wrap", gap: 8 },
    title: { fontSize: 15, fontWeight: 700, color: "#111", letterSpacing: "-0.3px" },
    subtitle: { fontSize: 11, color: "#999", marginTop: 2 },
    statsRow: { display: "flex", gap: 10, marginBottom: 14, flexWrap: "wrap" },
    stat: { padding: "8px 14px", background: "#fafafa", border: "1px solid #eee", borderRadius: 6, minWidth: 140 },
    statLabel: { fontSize: 10, color: "#999", textTransform: "uppercase", letterSpacing: "0.3px", marginBottom: 2 },
    statVal: { fontSize: 18, fontWeight: 700 },
    statSub: { fontSize: 10, color: "#bbb" },
    filters: { display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap", alignItems: "center" },
    sel: { padding: "4px 8px", background: "#fff", border: "1px solid #ddd", borderRadius: 4, fontSize: 11, color: "#333" },
    input: { padding: "4px 8px", background: "#fff", border: "1px solid #ddd", borderRadius: 4, fontSize: 11, color: "#333", width: 120, outline: "none" },
    table: { width: "100%", borderCollapse: "collapse", fontSize: 12 },
    th: { padding: "6px 8px", textAlign: "left", color: "#999", fontWeight: 500, fontSize: 10, textTransform: "uppercase", letterSpacing: "0.3px", borderBottom: "2px solid #eee", whiteSpace: "nowrap", userSelect: "none" },
    td: { padding: "6px 8px", borderBottom: "1px solid #f3f3f3" },
    link: { color: "#111", textDecoration: "none", fontWeight: 600 },
    badge: (r) => ({ display: "inline-block", padding: "1px 6px", borderRadius: 3, fontSize: 10, fontWeight: 600, background: RISK_STYLE[r]?.bg, color: RISK_STYLE[r]?.color, border: `1px solid ${RISK_STYLE[r]?.border}`, textTransform: "uppercase" }),
    chainBadge: (c) => ({ fontSize: 9, padding: "1px 5px", borderRadius: 3, background: `${c}11`, color: c, fontWeight: 600, border: `1px solid ${c}33` }),
    warn: (color) => ({ fontSize: 9, padding: "0px 4px", borderRadius: 2, background: color === "red" ? "#fef2f2" : "#fefce8", color: color === "red" ? "#dc2626" : "#ca8a04", border: `1px solid ${color === "red" ? "#fecaca" : "#fef08a"}`, marginRight: 3 }),
    muted: { color: "#bbb" },
    refreshBtn: { padding: "4px 10px", background: "#fafafa", border: "1px solid #ddd", borderRadius: 4, fontSize: 11, cursor: "pointer", color: "#666" },
    error: { padding: 8, background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 4, marginBottom: 12, fontSize: 11, color: "#dc2626" },
    footer: { marginTop: 16, padding: 12, background: "#fafafa", border: "1px solid #eee", borderRadius: 6, fontSize: 10, color: "#999", lineHeight: 1.5 },
  };

  return (
    <div style={S.page}>
      <div style={S.header}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{ width: 6, height: 6, borderRadius: "50%", background: loading ? "#f59e0b" : "#22c55e" }} />
            <span style={S.title}>Hardcoded Oracle Monitor</span>
            <span style={{ fontSize: 9, padding: "1px 5px", background: "#f5f5f5", border: "1px solid #e5e5e5", borderRadius: 3, color: "#999", fontWeight: 600 }}>MORPHO</span>
          </div>
          <div style={S.subtitle}>
            Fixed-price oracle markets — no liquidation on depeg
            {lastUpdate && <span> · {lastUpdate.toLocaleTimeString()}</span>}
          </div>
        </div>
        <button onClick={fetchMarkets} disabled={loading} style={S.refreshBtn}>
          {loading ? "..." : "↻ Refresh"}
        </button>
      </div>

      {error && <div style={S.error}>Error: {error}</div>}

      <div style={S.statsRow}>
        {[
          { label: "Hardcoded", value: stats.hcCount, sub: `/ ${stats.allCount} markets`, color: "#ea580c" },
          { label: "HC TVL", value: fmt(stats.hcTvl), sub: `${stats.totalTvl > 0 ? ((stats.hcTvl / stats.totalTvl) * 100).toFixed(1) : 0}%`, color: "#dc2626" },
          { label: "Total TVL", value: fmt(stats.totalTvl), sub: `≥ ${fmt(minTvl)}`, color: "#111" },
          { label: "Showing", value: processed.length, sub: filter === "hardcoded" ? "hardcoded" : "all", color: "#6366f1" },
        ].map((s, i) => (
          <div key={i} style={S.stat}>
            <div style={S.statLabel}>{s.label}</div>
            <div style={{ ...S.statVal, color: s.color }}>{s.value}</div>
            <div style={S.statSub}>{s.sub}</div>
          </div>
        ))}
      </div>

      <div style={S.filters}>
        {[{ k: "hardcoded", l: "Hardcoded" }, { k: "all", l: "All" }].map((f) => (
          <button key={f.k} onClick={() => setFilter(f.k)}
            style={{ padding: "4px 10px", background: filter === f.k ? "#111" : "#fff", color: filter === f.k ? "#fff" : "#666", border: "1px solid #ddd", borderRadius: 4, fontSize: 11, cursor: "pointer", fontWeight: filter === f.k ? 600 : 400 }}>
            {f.l}
          </button>
        ))}
        <select value={chainFilter} onChange={(e) => setChainFilter(e.target.value)} style={S.sel}>
          <option value="all">All Chains</option>
          {Object.entries(CHAIN_MAP).map(([id, c]) => <option key={id} value={id}>{c.name}</option>)}
        </select>
        <select value={minTvl} onChange={(e) => setMinTvl(Number(e.target.value))} style={S.sel}>
          <option value={100000}>≥ $100K</option>
          <option value={1000000}>≥ $1M</option>
          <option value={5000000}>≥ $5M</option>
          <option value={10000000}>≥ $10M</option>
          <option value={50000000}>≥ $50M</option>
        </select>
        <input type="text" placeholder="Search..." value={search} onChange={(e) => setSearch(e.target.value)} style={S.input} />
      </div>

      {loading && markets.length === 0 ? (
        <div style={{ padding: 30, textAlign: "center", color: "#ccc" }}>Loading...</div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={S.table}>
            <thead>
              <tr>
                {[
                  { k: "risk", l: "Risk", w: 60, sort: true },
                  { k: "chain", l: "Chain", w: 50 },
                  { k: "pair", l: "Market", w: 160 },
                  { k: "oracle", l: "Oracle", w: 130 },
                  { k: "supply", l: "Supply", w: 90, sort: true },
                  { k: "borrow", l: "Borrow", w: 90, sort: true },
                  { k: "util", l: "Util", w: 50 },
                  { k: "lltv", l: "LLTV", w: 50 },
                  { k: "deviation", l: "Dev.", w: 70, sort: true },
                  { k: "warnings", l: "Warnings", w: 100 },
                ].map((c) => (
                  <th key={c.k} onClick={() => c.sort && doSort(c.k)}
                    style={{ ...S.th, width: c.w, cursor: c.sort ? "pointer" : "default" }}>
                    {c.l} {c.sort && (sortBy === c.k ? (sortDir === "desc" ? "↓" : "↑") : "")}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {processed.map((m) => {
                const ch = CHAIN_MAP[m.chainId] || CHAIN_MAP[1];
                const col = m.collateralAsset?.symbol || "—";
                const loan = m.loanAsset?.symbol || "—";
                const supply = m.state?.supplyAssetsUsd || 0;
                const borrow = m.state?.borrowAssetsUsd || 0;
                const util = m.state?.utilization;
                const lltv = m.lltv ? parseInt(m.lltv) / 1e18 : null;
                const dev = m.deviation;
                const warns = m.warnings || [];

                return (
                  <tr key={m.uniqueKey} style={{ transition: "background 0.1s" }}
                    onMouseEnter={(e) => e.currentTarget.style.background = "#fafafa"}
                    onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}>
                    <td style={S.td}><span style={S.badge(m.risk)}>{m.risk}</span></td>
                    <td style={S.td}><span style={S.chainBadge(ch.color)}>{ch.short}</span></td>
                    <td style={S.td}>
                      <a href={`https://app.morpho.org/market?id=${m.uniqueKey}&network=${m.chainId}`}
                        target="_blank" rel="noopener noreferrer" style={S.link}>
                        {col}<span style={{ color: "#ccc", fontWeight: 400 }}>/</span>{loan}
                      </a>
                    </td>
                    <td style={S.td}>
                      <span style={{ color: m.oracleInfo.hardcoded ? "#ea580c" : "#999", fontWeight: m.oracleInfo.hardcoded ? 600 : 400, fontSize: 11 }}>
                        {m.oracleInfo.label}
                      </span>
                      {m.oracleInfo.feeds.length > 0 && (
                        <div style={{ fontSize: 9, color: "#ccc", marginTop: 1, maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {m.oracleInfo.feeds.map((f) => f.description).join(" · ")}
                        </div>
                      )}
                    </td>
                    <td style={{ ...S.td, fontWeight: 600 }}>{fmt(supply)}</td>
                    <td style={{ ...S.td, color: "#999" }}>{fmt(borrow)}</td>
                    <td style={{ ...S.td, color: "#999" }}>{util != null ? pct(util) : "—"}</td>
                    <td style={{ ...S.td, color: "#999" }}>{lltv != null ? pct(lltv) : "—"}</td>
                    <td style={S.td}>
                      {dev != null ? (
                        <span style={{
                          fontWeight: 600,
                          color: Math.abs(dev) > 5 ? "#dc2626" : Math.abs(dev) > 2 ? "#ea580c" : Math.abs(dev) > 0.5 ? "#ca8a04" : "#16a34a"
                        }}>
                          {dev > 0 ? "+" : ""}{dev.toFixed(2)}%
                        </span>
                      ) : <span style={S.muted}>—</span>}
                    </td>
                    <td style={S.td}>
                      {warns.filter((w) => w.level === "RED").map((w, i) => (
                        <span key={i} style={S.warn("red")} title={w.type}>
                          {w.type.replace(/_/g, " ").replace("bad debt ", "BD:")}
                        </span>
                      ))}
                      {warns.filter((w) => w.level === "YELLOW").slice(0, 2).map((w, i) => (
                        <span key={`y${i}`} style={S.warn("yellow")} title={w.type}>
                          {w.type.replace(/_/g, " ")}
                        </span>
                      ))}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {processed.length === 0 && !loading && (
            <div style={{ padding: 30, textAlign: "center", color: "#ccc", fontSize: 12 }}>No markets found</div>
          )}
        </div>
      )}

      <div style={S.footer}>
        <strong>Detection:</strong> Hardcoded = oracle.type "Unknown" OR ChainlinkOracle/V2 with zero feeds.
        <strong> Dev.</strong> = (oracle ratio − DEX ratio) / DEX ratio × 100.
        <strong> Risk:</strong> Critical (&gt;5%), High (&gt;2% or &gt;$50M), Medium (hardcoded), Low (dynamic). Refreshes every 2min.
      </div>
    </div>
  );
}
