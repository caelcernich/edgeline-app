import React, { useState, useMemo, useEffect } from "react";
import { Search, ChevronDown, Zap, TrendingUp, Settings2, RefreshCw, AlertTriangle, WifiOff } from "lucide-react";

// Point this at your deployed proxy (see data-integration-guide.md / README).
// Falls back to bundled mock data automatically if this can't be reached —
// e.g. while previewing this artifact before the proxy is deployed.
const API_BASE = "https://edgeline-proxy.onrender.com"; // your live Render server

/* ---------------------------------------------------------------
   ODDS MATH
   ---------------------------------------------------------------
   1) De-vig each sportsbook's pair to get a consensus "fair"
      probability (this already nets out the book's built-in edge,
      so no separate book fee is applied on top of it).
   2) Prediction-market prices are the probability directly, but
      buying one costs more than the quoted mid once you factor in
      the platform's trading fee and expected slippage from moving
      a thin order book.
   3) Net edge / net arbitrage use the COST-ADJUSTED price, not the
      raw quote, so the numbers reflect what you'd actually clear
      after execution.
------------------------------------------------------------------*/

const americanToDecimal = (odds) => (odds > 0 ? 1 + odds / 100 : 1 + 100 / Math.abs(odds));
const americanToImplied = (odds) => (odds > 0 ? 100 / (odds + 100) : Math.abs(odds) / (Math.abs(odds) + 100));
const deVig = (probA, probB) => {
  const total = probA + probB;
  return { fairA: probA / total, fairB: probB / total };
};

// Kalshi's published taker-fee curve: fee ≈ 0.07 * price * (1 - price) per $1 contract.
// Expressed as a percentage of stake it's 0.07 * (1 - price).
const kalshiFeePct = (price) => 0.07 * (1 - price);

// Polymarket charges 0% trading fee today; its cost is almost entirely slippage
// on thin books, modeled via the shared slippage slider instead of a fee constant.
const platformFeePct = (platformKey, price) => (platformKey === "kalshi" ? kalshiFeePct(price) : 0);

// Effective cost to acquire $1 of exposure on a prediction-market leg, net of
// fee and assumed slippage (slippage pushes the price away from you as you buy).
function effectiveMarketCost(price, platformKey, slippagePct) {
  const fee = platformFeePct(platformKey, price);
  const slipAdjustedPrice = price * (1 + slippagePct);
  return slipAdjustedPrice * (1 + fee);
}

function analyzeGame(game, slippagePct) {
  const { books, markets } = game;

  const bookFairs = Object.entries(books).map(([key, o]) => {
    const pAway = americanToImplied(o.away);
    const pHome = americanToImplied(o.home);
    return { key, ...deVig(pAway, pHome) };
  });
  const fairAway = bookFairs.reduce((s, b) => s + b.fairA, 0) / bookFairs.length;
  const fairHome = bookFairs.reduce((s, b) => s + b.fairB, 0) / bookFairs.length;

  const bestBookAway = Object.entries(books).reduce(
    (best, [key, o]) => (americanToDecimal(o.away) > americanToDecimal(best.odds) ? { key, odds: o.away } : best),
    { key: null, odds: -Infinity }
  );
  const bestBookHome = Object.entries(books).reduce(
    (best, [key, o]) => (americanToDecimal(o.home) > americanToDecimal(best.odds) ? { key, odds: o.home } : best),
    { key: null, odds: -Infinity }
  );

  // Pick the market with the lowest EFFECTIVE cost, not just the lowest quoted price —
  // a cheaper quote on a fee-heavy platform can lose to a pricier no-fee one.
  const bestMarketAway = Object.entries(markets).reduce((best, [key, m]) => {
    const cost = effectiveMarketCost(m.away, key, slippagePct);
    return cost < best.cost ? { key, price: m.away, cost } : best;
  }, { key: null, price: null, cost: Infinity });
  const bestMarketHome = Object.entries(markets).reduce((best, [key, m]) => {
    const cost = effectiveMarketCost(m.home, key, slippagePct);
    return cost < best.cost ? { key, price: m.home, cost } : best;
  }, { key: null, price: null, cost: Infinity });

  // Net EV: fair probability vs effective cost, per $1 staked.
  const evAway = (fairAway - bestMarketAway.cost) / bestMarketAway.cost;
  const evHome = (fairHome - bestMarketHome.cost) / bestMarketHome.cost;

  // Net two-leg arbitrage in both directions, using effective market cost.
  const decAway = americanToDecimal(bestBookAway.odds);
  const decHome = americanToDecimal(bestBookHome.odds);
  const stakeSumA = 1 / decAway + bestMarketHome.cost;
  const stakeSumB = 1 / decHome + bestMarketAway.cost;
  const arbA = 1 - stakeSumA;
  const arbB = 1 - stakeSumB;

  let arb = null;
  if (arbA > 0 && arbA >= arbB) {
    arb = {
      roi: (1 / stakeSumA - 1) * 100,
      legs: [
        { side: game.away, platform: bestBookAway.key, type: "book", stakeShare: (1 / decAway) / stakeSumA, odds: bestBookAway.odds, cost: 1 / decAway, fee: 0 },
        { side: game.home, platform: bestMarketHome.key, type: "market", stakeShare: bestMarketHome.cost / stakeSumA, price: bestMarketHome.price, cost: bestMarketHome.cost, fee: platformFeePct(bestMarketHome.key, bestMarketHome.price) },
      ],
    };
  } else if (arbB > 0) {
    arb = {
      roi: (1 / stakeSumB - 1) * 100,
      legs: [
        { side: game.home, platform: bestBookHome.key, type: "book", stakeShare: (1 / decHome) / stakeSumB, odds: bestBookHome.odds, cost: 1 / decHome, fee: 0 },
        { side: game.away, platform: bestMarketAway.key, type: "market", stakeShare: bestMarketAway.cost / stakeSumB, price: bestMarketAway.price, cost: bestMarketAway.cost, fee: platformFeePct(bestMarketAway.key, bestMarketAway.price) },
      ],
    };
  }

  const bestEvSide =
    evAway >= evHome
      ? { side: game.away, ev: evAway, platform: bestMarketAway.key, price: bestMarketAway.price, cost: bestMarketAway.cost, fair: fairAway }
      : { side: game.home, ev: evHome, platform: bestMarketHome.key, price: bestMarketHome.price, cost: bestMarketHome.cost, fair: fairHome };

  // Staleness: flag when a game's book quotes and market quotes were captured
  // more than ~20s apart — that gap alone can manufacture a phantom edge.
  const quoteGapSec = Math.abs(game.bookQuoteAge - game.marketQuoteAge);
  const stale = quoteGapSec > 20;

  return { fairAway, fairHome, bestBookAway, bestBookHome, bestMarketAway, bestMarketHome, bestEvSide, arb, stale, quoteGapSec, topEdge: arb ? arb.roi : bestEvSide.ev * 100 };
}

/* ---------------------------------------------------------------
   MOCK DATA — stands in for The Odds API + Kalshi + Polymarket feeds.
   bookQuoteAge / marketQuoteAge (seconds) simulate feed staleness.
------------------------------------------------------------------*/

const GAMES = [
  { id: "g1", sport: "NFL", away: "Jets", home: "Bills", kickoff: "Sun 1:00 PM ET", bookQuoteAge: 4, marketQuoteAge: 6,
    books: { dk: { away: 210, home: -255 }, fd: { away: 195, home: -240 } },
    markets: { kalshi: { away: 0.34, home: 0.68 }, polymarket: { away: 0.29, home: 0.72 } } },
  { id: "g2", sport: "NFL", away: "Dolphins", home: "Patriots", kickoff: "Sun 1:00 PM ET", bookQuoteAge: 5, marketQuoteAge: 4,
    books: { dk: { away: -145, home: 125 }, fd: { away: -150, home: 130 } },
    markets: { kalshi: { away: 0.56, home: 0.45 }, polymarket: { away: 0.61, home: 0.41 } } },
  { id: "g3", sport: "NFL", away: "Cowboys", home: "Eagles", kickoff: "Sun 4:25 PM ET", bookQuoteAge: 3, marketQuoteAge: 41,
    books: { dk: { away: 165, home: -195 }, fd: { away: 170, home: -200 } },
    markets: { kalshi: { away: 0.42, home: 0.59 }, polymarket: { away: 0.44, home: 0.57 } } },
  { id: "g4", sport: "NFL", away: "49ers", home: "Seahawks", kickoff: "Sun 4:05 PM ET", bookQuoteAge: 6, marketQuoteAge: 8,
    books: { dk: { away: -120, home: 100 }, fd: { away: -115, home: -105 } },
    markets: { kalshi: { away: 0.58, home: 0.43 }, polymarket: { away: 0.53, home: 0.48 } } },
  { id: "g5", sport: "NFL", away: "Ravens", home: "Steelers", kickoff: "Sun 8:20 PM ET", bookQuoteAge: 5, marketQuoteAge: 5,
    books: { dk: { away: -180, home: 155 }, fd: { away: -175, home: 150 } },
    markets: { kalshi: { away: 0.60, home: 0.41 }, polymarket: { away: 0.63, home: 0.38 } } },
  { id: "g6", sport: "NFL", away: "Lions", home: "Packers", kickoff: "Mon 8:15 PM ET", bookQuoteAge: 7, marketQuoteAge: 9,
    books: { dk: { away: 105, home: -125 }, fd: { away: 110, home: -130 } },
    markets: { kalshi: { away: 0.47, home: 0.54 }, polymarket: { away: 0.51, home: 0.50 } } },
  { id: "g7", sport: "NFL", away: "Chiefs", home: "Chargers", kickoff: "Thu 8:15 PM ET", bookQuoteAge: 4, marketQuoteAge: 5,
    books: { dk: { away: -260, home: 220 }, fd: { away: -250, home: 210 } },
    markets: { kalshi: { away: 0.71, home: 0.30 }, polymarket: { away: 0.69, home: 0.32 } } },
  { id: "g8", sport: "NFL", away: "Bengals", home: "Browns", kickoff: "Sun 1:00 PM ET", bookQuoteAge: 5, marketQuoteAge: 6,
    books: { dk: { away: -130, home: 110 }, fd: { away: -135, home: 115 } },
    markets: { kalshi: { away: 0.53, home: 0.48 }, polymarket: { away: 0.50, home: 0.51 } } },
  { id: "g9", sport: "NBA", away: "Celtics", home: "Knicks", kickoff: "Fri 7:30 PM ET", bookQuoteAge: 3, marketQuoteAge: 5,
    books: { dk: { away: -165, home: 145 }, fd: { away: -170, home: 150 } },
    markets: { kalshi: { away: 0.66, home: 0.35 }, polymarket: { away: 0.71, home: 0.30 } } },
  { id: "g10", sport: "NBA", away: "Warriors", home: "Lakers", kickoff: "Fri 10:00 PM ET", bookQuoteAge: 4, marketQuoteAge: 4,
    books: { dk: { away: 120, home: -140 }, fd: { away: 115, home: -135 } },
    markets: { kalshi: { away: 0.46, home: 0.55 }, polymarket: { away: 0.44, home: 0.57 } } },
  { id: "g11", sport: "NBA", away: "Bucks", home: "Heat", kickoff: "Sat 8:00 PM ET", bookQuoteAge: 5, marketQuoteAge: 6,
    books: { dk: { away: -110, home: -110 }, fd: { away: -105, home: -115 } },
    markets: { kalshi: { away: 0.52, home: 0.49 }, polymarket: { away: 0.49, home: 0.52 } } },
];

const SPORTS = ["NFL", "NBA"];
const PLATFORM_LABEL = { dk: "DraftKings", fd: "FanDuel", kalshi: "Kalshi", polymarket: "Polymarket" };

const fmtOdds = (n) => (n > 0 ? `+${n}` : `${n}`);
const fmtPct = (n) => `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
const fmtPrice = (p) => `${Math.round(p * 100)}¢`;

export default function ArbScanner() {
  const [sport, setSport] = useState("NFL");
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState("edge");
  const [minEdge, setMinEdge] = useState(0);
  const [arbOnly, setArbOnly] = useState(false);
  const [openId, setOpenId] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  const [slippagePct, setSlippagePct] = useState(0.015);
  const [includeStale, setIncludeStale] = useState(false);
  const [liveGames, setLiveGames] = useState(null); // null until a fetch resolves
  const [connStatus, setConnStatus] = useState("checking"); // checking | live | proxy-mock | offline
  const [lastFetched, setLastFetched] = useState(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setConnStatus("checking");
      try {
        const res = await fetch(`${API_BASE}/api/scan?sport=${sport}`);
        if (!res.ok) throw new Error(`status ${res.status}`);
        const data = await res.json();
        if (cancelled) return;
        setLiveGames(data.games);
        setConnStatus(data.source === "live" ? "live" : "proxy-mock");
        setLastFetched(data.fetchedAt);
      } catch (err) {
        if (cancelled) return;
        setLiveGames(null); // fall back to bundled mock data below
        setConnStatus("offline");
      }
    }
    load();
    const interval = setInterval(load, 30000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [sport]);

  const sourceGames = liveGames || GAMES.filter((g) => g.sport === sport);

  const rows = useMemo(
    () => sourceGames.map((g) => ({ game: g, calc: analyzeGame(g, slippagePct) })),
    [sourceGames, slippagePct]
  );

  const filtered = useMemo(() => {
    let list = rows.filter(({ game, calc }) => {
      const matchesSearch = !search || game.away.toLowerCase().includes(search.toLowerCase()) || game.home.toLowerCase().includes(search.toLowerCase());
      const matchesArb = !arbOnly || calc.arb;
      const matchesEdge = calc.topEdge >= minEdge;
      const matchesStale = includeStale || !calc.stale;
      return matchesSearch && matchesArb && matchesEdge && matchesStale;
    });
    list.sort((a, b) => (sortBy === "edge" ? b.calc.topEdge - a.calc.topEdge : a.game.id.localeCompare(b.game.id)));
    return list;
  }, [rows, search, sortBy, minEdge, arbOnly, includeStale]);

  const arbCount = rows.filter((r) => r.calc.arb && !r.calc.stale).length;
  const bestEdge = rows.filter((r) => !r.calc.stale).reduce((m, r) => Math.max(m, r.calc.topEdge), 0);
  const avgEdge = rows.reduce((s, r) => s + Math.max(r.calc.topEdge, 0), 0) / (rows.length || 1);
  const staleCount = rows.filter((r) => r.calc.stale).length;

  return (
    <div style={{ background: "#0B0F14", color: "#E8ECEF", minHeight: "100vh", fontFamily: "'Inter', system-ui, sans-serif" }} className="w-full">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=IBM+Plex+Mono:wght@400;500;600&family=Inter:wght@400;500;600&display=swap');
        .mono { font-family: 'IBM Plex Mono', monospace; font-variant-numeric: tabular-nums; }
        .display { font-family: 'Space Grotesk', sans-serif; }
        .row-enter { transition: background 0.15s ease; }
        .row-enter:hover { background: #121820; }
        input[type=range] { -webkit-appearance: none; height: 3px; background: #23303B; border-radius: 2px; }
        input[type=range]::-webkit-slider-thumb { -webkit-appearance: none; width: 13px; height: 13px; border-radius: 50%; background: #D4A84B; cursor: pointer; }
      `}</style>

      {/* Header */}
      <div style={{ borderBottom: "1px solid #1C2530" }} className="px-6 py-5">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-baseline gap-3">
            <h1 className="display text-2xl font-semibold" style={{ letterSpacing: "-0.01em" }}>Edgeline</h1>
            <span className="mono text-xs" style={{ color: "#5E6B78" }}>sportsbook × prediction-market scanner</span>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={() => setShowSettings((v) => !v)}
              className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded"
              style={{ background: showSettings ? "#1C2530" : "transparent", border: "1px solid #23303B", color: "#8B98A5" }}
            >
              <Settings2 size={13} /> Cost model
            </button>
            <ConnBadge status={connStatus} lastFetched={lastFetched} />
          </div>
        </div>

        {showSettings && (
          <div className="mt-3 p-3 rounded flex flex-wrap items-center gap-5" style={{ background: "#151C24", border: "1px solid #23303B" }}>
            <div className="flex items-center gap-2">
              <span className="text-xs whitespace-nowrap" style={{ color: "#8B98A5" }}>Assumed market slippage {(slippagePct * 100).toFixed(1)}%</span>
              <input type="range" min={0} max={5} step={0.5} value={slippagePct * 100} onChange={(e) => setSlippagePct(Number(e.target.value) / 100)} style={{ width: "110px" }} />
            </div>
            <div className="text-xs" style={{ color: "#5E6B78", maxWidth: "480px" }}>
              Kalshi taker fee (~0.07 × P × (1−P), built in automatically) + this slippage assumption are applied
              to every market-side leg before an edge or arb is shown. Sportsbook legs use quoted odds as-is —
              their vig is already netted out in the fair-probability calc.
            </div>
            <label className="flex items-center gap-2 text-xs" style={{ color: "#8B98A5" }}>
              <input type="checkbox" checked={includeStale} onChange={(e) => setIncludeStale(e.target.checked)} />
              Show stale-quote games ({staleCount})
            </label>
          </div>
        )}

        <div className="mt-3 text-xs px-3 py-2 rounded" style={{ background: "#151C24", border: "1px solid #23303B", color: "#8B98A5", maxWidth: "760px" }}>
          Research tool, not a bet-placement system or financial advice. Kalshi's sports contracts sit in
          active, unsettled litigation and availability varies by state — confirm your jurisdiction before
          relying on any number here.
        </div>
      </div>

      {/* Stats strip */}
      <div className="px-6 py-4 grid grid-cols-2 sm:grid-cols-4 gap-4" style={{ borderBottom: "1px solid #1C2530" }}>
        <Stat label="Games scanned" value={rows.length} />
        <Stat label="Net arbitrage found" value={arbCount} accent={arbCount > 0 ? "#D4A84B" : undefined} />
        <Stat label="Best net edge" value={fmtPct(bestEdge)} accent="#4C9A8E" />
        <Stat label="Stale-quote games" value={staleCount} accent={staleCount > 0 ? "#C1553C" : undefined} />
      </div>

      {/* Toolbar */}
      <div className="px-6 py-4 flex flex-wrap items-center gap-3" style={{ borderBottom: "1px solid #1C2530" }}>
        <div className="flex gap-2">
          {["NFL", "NBA", "MLB", "NHL", "Soccer"].map((s) => {
            const enabled = SPORTS.includes(s);
            return (
              <button
                key={s}
                disabled={!enabled}
                onClick={() => enabled && setSport(s)}
                className="text-xs px-3 py-1.5 rounded display font-medium"
                style={
                  s === sport
                    ? { background: "#1C2530", color: "#E8ECEF", border: "1px solid #2C3A47" }
                    : enabled
                    ? { background: "transparent", color: "#8B98A5", border: "1px solid #1C2530" }
                    : { background: "transparent", color: "#3E4A56", border: "1px solid #1C2530", cursor: "not-allowed" }
                }
              >
                {s}
                {!enabled && <span className="ml-1" style={{ fontSize: "10px" }}>soon</span>}
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-2 px-3 py-1.5 rounded" style={{ background: "#151C24", border: "1px solid #23303B" }}>
          <Search size={14} style={{ color: "#5E6B78" }} />
          <input placeholder="Search team..." value={search} onChange={(e) => setSearch(e.target.value)} className="bg-transparent outline-none text-sm" style={{ color: "#E8ECEF", width: "130px" }} />
        </div>

        <div className="flex items-center gap-2">
          <span className="text-xs" style={{ color: "#5E6B78" }}>Sort</span>
          <select value={sortBy} onChange={(e) => setSortBy(e.target.value)} className="text-xs px-2 py-1.5 rounded outline-none" style={{ background: "#151C24", border: "1px solid #23303B", color: "#E8ECEF" }}>
            <option value="edge">Biggest net edge</option>
            <option value="kickoff">Kickoff time</option>
          </select>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-xs whitespace-nowrap" style={{ color: "#5E6B78" }}>Min net edge {minEdge}%</span>
          <input type="range" min={0} max={20} value={minEdge} onChange={(e) => setMinEdge(Number(e.target.value))} style={{ width: "90px" }} />
        </div>

        <button
          onClick={() => setArbOnly((v) => !v)}
          className="text-xs px-3 py-1.5 rounded flex items-center gap-1.5 display font-medium"
          style={arbOnly ? { background: "#3A2E12", color: "#D4A84B", border: "1px solid #5C4A1F" } : { background: "transparent", color: "#8B98A5", border: "1px solid #23303B" }}
        >
          <Zap size={12} /> Arbitrage only
        </button>
      </div>

      <div className="px-6 py-2 hidden md:grid text-xs mono" style={{ gridTemplateColumns: "1.5fr 1.2fr 1.4fr 1fr 0.4fr", color: "#5E6B78", borderBottom: "1px solid #1C2530" }}>
        <div>MATCHUP</div>
        <div>BEST SPORTSBOOK</div>
        <div>BEST MARKET (NET OF FEES)</div>
        <div>SIGNAL</div>
        <div></div>
      </div>

      <div>
        {filtered.length === 0 && (
          <div className="px-6 py-10 text-sm text-center" style={{ color: "#5E6B78" }}>
            No games clear that filter right now. Loosen the min edge, turn off arbitrage-only, or show stale-quote games.
          </div>
        )}
        {filtered.map(({ game, calc }) => (
          <GameRow key={game.id} game={game} calc={calc} open={openId === game.id} onToggle={() => setOpenId(openId === game.id ? null : game.id)} />
        ))}
      </div>

      <div className="px-6 py-6 text-xs" style={{ color: "#3E4A56" }}>
        Fair probability = average of de-vigged sportsbook prices across books. Net cost on a market leg =
        quoted price × (1 + slippage assumption) × (1 + platform fee %). Net edge / net arbitrage ROI use
        that cost, not the raw quote. A game is flagged stale when its book and market quotes were captured
        more than 20 seconds apart.
      </div>
    </div>
  );
}

function ConnBadge({ status, lastFetched }) {
  const map = {
    checking: { icon: <RefreshCw size={13} className="animate-spin" />, text: "connecting to proxy…", color: "#5E6B78" },
    live: { icon: <RefreshCw size={13} />, text: `live via proxy · ${lastFetched ? new Date(lastFetched).toLocaleTimeString() : ""}`, color: "#4C9A8E" },
    "proxy-mock": { icon: <RefreshCw size={13} />, text: "proxy connected · mock data (no API keys set)", color: "#D4A84B" },
    offline: { icon: <WifiOff size={13} />, text: "proxy unreachable — using bundled mock data", color: "#C1553C" },
  };
  const s = map[status] || map.offline;
  return (
    <div className="flex items-center gap-2 mono text-xs" style={{ color: s.color }}>
      {s.icon} {s.text}
    </div>
  );
}

function Stat({ label, value, accent }) {
  return (
    <div>
      <div className="text-xs mb-1" style={{ color: "#5E6B78" }}>{label}</div>
      <div className="display text-xl font-semibold mono" style={{ color: accent || "#E8ECEF" }}>{value}</div>
    </div>
  );
}

function GameRow({ game, calc, open, onToggle }) {
  const badge = calc.stale ? (
    <Badge color="#C1553C" bg="#2A1712" border="#4A2A20" icon={<AlertTriangle size={11} />}>stale quotes</Badge>
  ) : calc.arb ? (
    <Badge color="#D4A84B" bg="#3A2E12" border="#5C4A1F" icon={<Zap size={11} />}>ARB {calc.arb.roi.toFixed(1)}%</Badge>
  ) : calc.bestEvSide.ev > 0 ? (
    <Badge color="#4C9A8E" bg="#132420" border="#245149" icon={<TrendingUp size={11} />}>+EV {fmtPct(calc.bestEvSide.ev * 100)}</Badge>
  ) : (
    <Badge color="#5E6B78" bg="#151C24" border="#23303B">no edge</Badge>
  );

  return (
    <div className="row-enter" style={{ borderBottom: "1px solid #171E27" }}>
      <div onClick={onToggle} className="px-6 py-4 grid gap-3 md:gap-0 cursor-pointer items-center" style={{ gridTemplateColumns: "1.5fr 1.2fr 1.4fr 1fr 0.4fr" }}>
        <div>
          <div className="display text-sm font-medium">{game.away} <span style={{ color: "#5E6B78" }}>@</span> {game.home}</div>
          <div className="text-xs mono" style={{ color: "#5E6B78" }}>{game.kickoff}</div>
        </div>
        <div className="mono text-sm">
          <div>{game.away} <span style={{ color: "#8B98A5" }}>{fmtOdds(calc.bestBookAway.odds)}</span> <span style={{ color: "#3E4A56" }}>({PLATFORM_LABEL[calc.bestBookAway.key]})</span></div>
          <div>{game.home} <span style={{ color: "#8B98A5" }}>{fmtOdds(calc.bestBookHome.odds)}</span> <span style={{ color: "#3E4A56" }}>({PLATFORM_LABEL[calc.bestBookHome.key]})</span></div>
        </div>
        <div className="mono text-sm">
          <div>{game.away} <span style={{ color: "#8B98A5" }}>{fmtPrice(calc.bestMarketAway.cost)}</span> <span style={{ color: "#3E4A56" }}>({PLATFORM_LABEL[calc.bestMarketAway.key]}, quote {fmtPrice(calc.bestMarketAway.price)})</span></div>
          <div>{game.home} <span style={{ color: "#8B98A5" }}>{fmtPrice(calc.bestMarketHome.cost)}</span> <span style={{ color: "#3E4A56" }}>({PLATFORM_LABEL[calc.bestMarketHome.key]}, quote {fmtPrice(calc.bestMarketHome.price)})</span></div>
        </div>
        <div>{badge}</div>
        <div className="flex justify-end">
          <ChevronDown size={16} style={{ color: "#5E6B78", transform: open ? "rotate(180deg)" : "none", transition: "transform 0.15s" }} />
        </div>
      </div>

      {open && (
        <div className="px-6 pb-5 -mt-1">
          <div className="rounded p-4 text-sm" style={{ background: "#0F151C", border: "1px solid #1C2530" }}>
            {calc.stale && (
              <div className="flex items-center gap-2 mb-3 text-xs" style={{ color: "#C1553C" }}>
                <AlertTriangle size={13} />
                Book and market quotes are {calc.quoteGapSec}s apart for this game — treat any edge below as
                unconfirmed until both sides refresh closer together.
              </div>
            )}
            {calc.arb ? <ArbDetail arb={calc.arb} /> : <EvDetail calc={calc} />}
          </div>
        </div>
      )}
    </div>
  );
}

function ArbDetail({ arb }) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <Zap size={14} style={{ color: "#D4A84B" }} />
        <span className="display font-medium" style={{ color: "#D4A84B" }}>
          Net {arb.roi.toFixed(1)}% return after fees and slippage, regardless of who wins
        </span>
      </div>
      <div className="grid sm:grid-cols-2 gap-3 mb-3">
        {arb.legs.map((leg, i) => (
          <div key={i} className="rounded p-3" style={{ background: "#151C24", border: "1px solid #23303B" }}>
            <div className="text-xs mb-1" style={{ color: "#5E6B78" }}>Leg {i + 1} — {leg.type === "book" ? "sportsbook" : "prediction market"}</div>
            <div className="mono text-sm">{leg.side} on {PLATFORM_LABEL[leg.platform]}</div>
            <div className="mono text-xs mt-1" style={{ color: "#8B98A5" }}>
              {leg.type === "book" ? `${fmtOdds(leg.odds)} american, no added fee` : `${fmtPrice(leg.price)} quote + ${(leg.fee * 100).toFixed(2)}% fee → ${fmtPrice(leg.cost)} effective`}
            </div>
            <div className="mono text-xs mt-1" style={{ color: "#5E6B78" }}>stake {Math.round(leg.stakeShare * 100)}% of bankroll for this game</div>
          </div>
        ))}
      </div>
      <div className="text-xs" style={{ color: "#5E6B78" }}>
        Example on a $100 total stake: split it per the percentages above. Whichever side wins, one leg pays
        out enough to cover both stakes and lock in the {arb.roi.toFixed(1)}% net edge — this already nets out
        the modeled fee and slippage, but real execution risk (partial fills, odds moving between your two
        clicks, platform stake limits) can still erode it further.
      </div>
    </div>
  );
}

function EvDetail({ calc }) {
  const { bestEvSide } = calc;
  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <TrendingUp size={14} style={{ color: bestEvSide.ev > 0 ? "#4C9A8E" : "#5E6B78" }} />
        <span className="display font-medium" style={{ color: bestEvSide.ev > 0 ? "#4C9A8E" : "#8B98A5" }}>
          {bestEvSide.ev > 0
            ? `${fmtPct(bestEvSide.ev * 100)} net edge buying ${bestEvSide.side} on ${PLATFORM_LABEL[bestEvSide.platform]}`
            : "No positive net edge or arbitrage on this game right now"}
        </span>
      </div>
      <div className="mono text-xs" style={{ color: "#8B98A5" }}>
        Sportsbook-consensus fair probability: {(bestEvSide.fair * 100).toFixed(1)}% · {PLATFORM_LABEL[bestEvSide.platform]} quote {fmtPrice(bestEvSide.price)} → effective cost {fmtPrice(bestEvSide.cost)}
      </div>
      <div className="text-xs mt-2" style={{ color: "#5E6B78" }}>
        This is a one-sided bet, not a hedge — you're betting the sportsbook consensus is closer to true odds
        than the fee-and-slippage-adjusted market price, with no guaranteed floor if you're wrong.
      </div>
    </div>
  );
}

function Badge({ children, color, bg, border, icon }) {
  return (
    <span className="mono text-xs px-2 py-1 rounded inline-flex items-center gap-1 whitespace-nowrap" style={{ color, background: bg, border: `1px solid ${border}` }}>
      {icon}
      {children}
    </span>
  );
}
