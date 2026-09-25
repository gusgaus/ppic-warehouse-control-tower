import React, { useState, useEffect, useCallback, useMemo } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
} from "recharts";

const CSV_URL =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vQdWS54Lq4N5gGZxO8IbZT4SjCd2oO-NO4PAUlCbmFecbiPRZcLeMaE-wAE--M88jTp83R7ssYuAKu2/pub?gid=1964749198&single=true&output=csv";

// Google's published-CSV endpoint doesn't send permissive CORS headers, so a
// direct browser fetch() is blocked by most sandboxes/browsers. These public
// read-only proxies fetch it server-side and re-serve it with CORS allowed.
// This is a stopgap for prototyping only -- see the roadmap step about
// building a proper backend proxy for production use.
const CORS_PROXIES = [
  (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  (url) => `https://corsproxy.io/?url=${encodeURIComponent(url)}`,
];

const REFRESH_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

const MONTH_NAMES = [
  "January","February","March","April","May","June",
  "July","August","September","October","November","December",
];

// Fixed column positions in the "Monitoring PO 2.0" sheet export.
// (Some header labels repeat, e.g. three "DATE" columns, so we address by
// position rather than by name.)
const COL = {
  area: 0,
  periode: 1,
  skuCategory: 2,
  itemCode: 3,
  productName: 4,
  supplier: 6,
  stockWH: 12,
  stockStatus: 13,
  daysBeforeSO: 14,
  prDate: 9,
  noPO: 19,
  poDate: 20,
  qtyPO: 21,
  receiveDate: 27,
  qtyReceived: 28,
  status: 31,
  remarks: 34,
  requestDate: 26,
};

function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\r") {
      // skip
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function normalizePeriode(raw) {
  if (!raw) return null;
  const m = raw.match(/([A-Za-z]+)\s+(\d{4})/);
  if (m && MONTH_NAMES.includes(m[1])) return `${m[1]} ${m[2]}`;
  const d = new Date(raw);
  if (!isNaN(d)) return `${MONTH_NAMES[d.getMonth()]} ${d.getFullYear()}`;
  return null;
}

function parseNum(raw) {
  if (raw === undefined || raw === null) return null;
  const cleaned = String(raw).replace(/,/g, "").trim();
  if (cleaned === "") return null;
  const n = parseFloat(cleaned);
  return isNaN(n) ? null : n;
}

function parseDateStr(raw) {
  if (!raw || !String(raw).trim()) return null;
  const d = new Date(String(raw).trim());
  if (isNaN(d)) return null;
  return d.toISOString().slice(0, 10);
}

function transformRows(csvRows) {
  // csvRows[0] is a junk merged-header row, csvRows[1] is the real header,
  // data starts at csvRows[2].
  const data = csvRows.slice(2);
  const out = [];
  for (const r of data) {
    const itemCode = (r[COL.itemCode] || "").trim();
    if (!itemCode) continue;
    out.push({
      area: (r[COL.area] || "").trim() || null,
      periode: normalizePeriode(r[COL.periode]),
      skuCategory: (r[COL.skuCategory] || "").trim() || null,
      itemCode,
      productName: (r[COL.productName] || "").trim() || null,
      supplier: (r[COL.supplier] || "").trim() || null,
      stockWH: parseNum(r[COL.stockWH]),
      stockStatus: (r[COL.stockStatus] || "").trim() || null,
      daysBeforeSO: parseNum(r[COL.daysBeforeSO]),
      prDate: parseDateStr(r[COL.prDate]),
      noPO: (r[COL.noPO] || "").trim() || null,
      poDate: parseDateStr(r[COL.poDate]),
      receiveDate: parseDateStr(r[COL.receiveDate]),
      qtyPO: parseNum(r[COL.qtyPO]),
      qtyReceived: parseNum(r[COL.qtyReceived]),
      status: (r[COL.status] || "").trim() || null,
      remarks: (r[COL.remarks] || "").trim() || null,
      requestDate: parseDateStr(r[COL.requestDate]),
    });
  }
  return out;
}

const MONTH_ORDER = MONTH_NAMES;

const STOCK_STATUS_COLORS = {
  "Safe": "#10B981",
  "High Stock": "#38BDF8",
  "Over Stock": "#A78BFA",
  "Need Refill": "#F97316",
  "No Movement": "#9CA3AF",
  "Need Penghabisan": "#EAB308",
  "Discontinue": "#64748B",
};
const STOCK_STATUS_ORDER = ["Safe","High Stock","Over Stock","Need Refill","No Movement","Need Penghabisan","Discontinue"];

const PO_STATUS_COLORS = {
  "Close": "#2DD4BF",
  "Open": "#3B82F6",
  "Not yet Opened": "#F59E0B",
  "Cancel": "#EF4444",
  "Close Partial": "#8B5CF6",
};

const ALERT_META = {
  critical: { label: "CRITICAL ITEMS", color: "#EF4444", glow: "rgba(239,68,68,0.18)", desc: "Stok gudang negatif atau sisa hari sebelum stockout \u2264 3 hari" },
  needRefill: { label: "NEED REFILL", color: "#F97316", glow: "rgba(249,115,22,0.18)", desc: "Status stok gudang: Need Refill" },
  replenishment: { label: "REPLENISHMENT REQUIRED", color: "#22D3EE", glow: "rgba(34,211,238,0.18)", desc: "Status stok gudang: Safe atau Need Refill \u2014 kandidat yang perlu direncanakan replenishment" },
  needPenghabisan: { label: "NEED PENGHABISAN", color: "#EAB308", glow: "rgba(234,179,8,0.18)", desc: "Status stok gudang: Need Penghabisan \u2014 SKU kategori Discontinue, stok harus dihabiskan" },
  overStock: { label: "OVER STOCK", color: "#A78BFA", glow: "rgba(167,139,250,0.18)", desc: "Status stok gudang: Over Stock \u2014 pertimbangkan redistribusi" },
  noMovement: { label: "NO MOVEMENT", color: "#9CA3AF", glow: "rgba(156,163,175,0.18)", desc: "Status stok gudang: No Movement \u2014 kandidat dead stock" },
  deadStock: { label: "DEAD STOCK", color: "#9CA3AF", glow: "rgba(156,163,175,0.18)", desc: "Status stok gudang: No Movement atau Discontinue \u2014 stok tidak lagi bergerak" },
  allFlagged: { label: "TOTAL PERLU AKSI", color: "#F87171", glow: "rgba(248,113,113,0.14)", desc: "Gabungan semua kategori: Critical, Need Refill, Replenishment Required, Need Penghabisan, Over Stock, dan Dead Stock" },
};
const ALERT_ORDER = ["critical", "needRefill", "replenishment", "needPenghabisan", "overStock"];

function isCritical(r) {
  return (r.stockWH !== null && r.stockWH < 0) || (r.daysBeforeSO !== null && r.daysBeforeSO <= 3);
}

// Each alert card has its own independent match rule -- "Replenishment
// Required" intentionally overlaps with "Need Refill" (it's the broader
// Safe + Need Refill watch-list), unlike the other cards which are mutually
// exclusive by stock status.
const ALERT_PREDICATES = {
  critical: (r) => isCritical(r),
  needRefill: (r) => !isCritical(r) && r.stockStatus === "Need Refill",
  replenishment: (r) => !isCritical(r) && (r.stockStatus === "Safe" || r.stockStatus === "Need Refill"),
  needPenghabisan: (r) => !isCritical(r) && r.stockStatus === "Need Penghabisan",
  overStock: (r) => !isCritical(r) && r.stockStatus === "Over Stock",
  noMovement: (r) => !isCritical(r) && r.stockStatus === "No Movement",
  deadStock: (r) => !isCritical(r) && (r.stockStatus === "No Movement" || r.stockStatus === "Discontinue"),
  // Union of every actionable category: Critical, Need Refill, Replenishment
  // Required, Need Penghabisan, Over Stock, Dead Stock. Written out
  // explicitly (rather than OR-ing the other predicates together) since this
  // object can't reference its own sibling keys while being built.
  allFlagged: (r) =>
    isCritical(r) ||
    r.stockStatus === "Safe" ||
    r.stockStatus === "Need Refill" ||
    r.stockStatus === "Need Penghabisan" ||
    r.stockStatus === "Over Stock" ||
    r.stockStatus === "No Movement" ||
    r.stockStatus === "Discontinue",
};

function fmtNum(n) {
  if (n === null || n === undefined || isNaN(n)) return "\u2014";
  return Number(n).toLocaleString("id-ID");
}
function fmtDateTime(d) {
  if (!d) return "\u2014";
  return d.toLocaleString("id-ID", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}
function daysBetween(a, b) {
  if (!a || !b) return null;
  const da = new Date(a);
  const db = new Date(b);
  if (isNaN(da) || isNaN(db)) return null;
  return Math.round((db - da) / 86400000);
}

// "Filter PR Status" -- derived label from Status PO (col AF).
const PR_STATUS_MAP = {
  "Close": "PO Received",
  "Open": "Menunggu Pengiriman",
  "Not yet Opened": "PO Not yet Opened",
  "Close Partial": "Outstanding PO",
  "Cancel": "PO Issue",
};
const PR_STATUS_OPTIONS = ["PO Received", "Menunggu Pengiriman", "PO Not yet Opened", "Outstanding PO", "PO Issue"];

function prStatusLabel(r) {
  return PR_STATUS_MAP[r.status] || r.status || "Unknown";
}

function downloadCSV(rows, columns, alertKey, period, area) {
  if (!rows.length) return;
  const escapeCell = (v) => {
    if (v === null || v === undefined) return "";
    const s = String(v).replace(/"/g, '""');
    return `"${s}"`;
  };
  const header = columns.map((c) => escapeCell(c.label)).join(",");
  const lines = rows.map((row) => columns.map((c) => escapeCell(c.compute ? c.compute(row) : row[c.key])).join(","));
  const csv = [header, ...lines].join("\r\n");
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const safe = (s) => String(s).replace(/[^a-zA-Z0-9]+/g, "_");
  const filename = `ppic_${safe(alertKey)}_${safe(period)}_${safe(area)}.csv`;
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

const selectStyle = {
  background: "#0B1220",
  border: "1px solid #2A3548",
  borderRadius: "6px",
  color: "#E8ECF1",
  fontSize: "12px",
  padding: "7px 10px",
};

export default function PPICControlTower() {
  const [allRows, setAllRows] = useState([]);
  const [status, setStatus] = useState("loading"); // loading | ready | error
  const [errorMsg, setErrorMsg] = useState("");
  const [lastUpdated, setLastUpdated] = useState(null);

  const loadData = useCallback(() => {
    setStatus((s) => (s === "ready" ? "refreshing" : "loading"));
    setErrorMsg("");

    const attempts = [CSV_URL, ...CORS_PROXIES.map((build) => build(CSV_URL))];

    async function tryFetch() {
      let lastErr = null;
      for (const url of attempts) {
        try {
          const res = await fetch(url);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const text = await res.text();
          if (!text || text.trim().length === 0) throw new Error("Response kosong");
          return text;
        } catch (err) {
          lastErr = err;
        }
      }
      throw lastErr || new Error("Semua percobaan fetch gagal");
    }

    tryFetch()
      .then((text) => {
        const parsed = parseCSV(text);
        const rows = transformRows(parsed);
        if (rows.length === 0) throw new Error("Data kosong setelah diparsing -- cek format sheet");
        setAllRows(rows);
        setLastUpdated(new Date());
        setStatus("ready");
      })
      .catch((err) => {
        setErrorMsg(String(err.message || err));
        setStatus("error");
      });
  }, []);

  useEffect(() => {
    loadData();
    const id = setInterval(loadData, REFRESH_INTERVAL_MS);
    return () => clearInterval(id);
  }, [loadData]);

  const periods = useMemo(() => {
    const set = new Set();
    allRows.forEach((r) => r.periode && set.add(r.periode));
    return Array.from(set).sort((a, b) => {
      const [ma, ya] = a.split(" ");
      const [mb, yb] = b.split(" ");
      return Number(ya) - Number(yb) || MONTH_ORDER.indexOf(ma) - MONTH_ORDER.indexOf(mb);
    });
  }, [allRows]);

  const areas = useMemo(() => {
    const set = new Set();
    allRows.forEach((r) => r.area && set.add(r.area));
    return Array.from(set).sort();
  }, [allRows]);

  const [period, setPeriod] = useState("Semua Periode");
  const [area, setArea] = useState("Semua Area");
  const [prStatusFilter, setPrStatusFilter] = useState("Semua PR Status");
  const [selectedAlert, setSelectedAlert] = useState("critical");
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState(null);
  const [sortDir, setSortDir] = useState("asc");

  const filteredRaw = useMemo(() => {
    return allRows.filter(
      (r) =>
        (period === "Semua Periode" || r.periode === period) &&
        (area === "Semua Area" || r.area === area) &&
        (prStatusFilter === "Semua PR Status" || prStatusLabel(r) === prStatusFilter)
    );
  }, [allRows, period, area, prStatusFilter]);

  const latestSnapshot = useMemo(() => {
    const map = new Map();
    filteredRaw.forEach((r) => {
      const key = r.area + "|" + r.itemCode;
      const existing = map.get(key);
      if (!existing || (r.prDate && (!existing.prDate || r.prDate > existing.prDate))) {
        map.set(key, r);
      }
    });
    return Array.from(map.values());
  }, [filteredRaw]);

  const withKnownStatus = useMemo(() => latestSnapshot.filter((r) => r.stockStatus), [latestSnapshot]);

  const healthKpi = useMemo(() => {
    const total = withKnownStatus.length;
    const safe = withKnownStatus.filter((r) => r.stockStatus === "Safe").length;
    const critical = withKnownStatus.filter((r) => isCritical(r)).length;
    const dead = withKnownStatus.filter((r) => r.stockStatus === "No Movement" || r.stockStatus === "Discontinue").length;
    const allFlagged = withKnownStatus.filter(ALERT_PREDICATES.allFlagged).length;
    return {
      totalSKU: latestSnapshot.length,
      healthyPct: total ? Math.round((safe / total) * 1000) / 10 : 0,
      critical,
      dead,
      allFlagged,
    };
  }, [withKnownStatus, latestSnapshot]);

  const alertCounts = useMemo(() => {
    const counts = {};
    Object.keys(ALERT_PREDICATES).forEach((key) => {
      counts[key] = withKnownStatus.filter(ALERT_PREDICATES[key]).length;
    });
    return counts;
  }, [withKnownStatus]);

  const stockDistribution = useMemo(() => {
    const counts = {};
    STOCK_STATUS_ORDER.forEach((s) => (counts[s] = 0));
    withKnownStatus.forEach((r) => {
      if (counts[r.stockStatus] !== undefined) counts[r.stockStatus] += 1;
    });
    return STOCK_STATUS_ORDER.map((s) => ({ name: s, value: counts[s] })).filter((d) => d.value > 0);
  }, [withKnownStatus]);

  const areaHealthChart = useMemo(() => {
    const byArea = {};
    withKnownStatus.forEach((r) => {
      if (!byArea[r.area]) {
        byArea[r.area] = { area: r.area };
        STOCK_STATUS_ORDER.forEach((s) => (byArea[r.area][s] = 0));
      }
      byArea[r.area][r.stockStatus] += 1;
    });
    return Object.values(byArea).sort((a, b) => {
      const totalA = STOCK_STATUS_ORDER.reduce((s, k) => s + a[k], 0);
      const totalB = STOCK_STATUS_ORDER.reduce((s, k) => s + b[k], 0);
      return totalB - totalA;
    });
  }, [withKnownStatus]);

  const poStatusCounts = useMemo(() => {
    const counts = {};
    filteredRaw.forEach((r) => {
      const s = r.status || "Unknown";
      counts[s] = (counts[s] || 0) + 1;
    });
    return counts;
  }, [filteredRaw]);

  const poDelayRows = useMemo(() => {
    const now = new Date();
    return filteredRaw.filter((r) => {
      if (r.status !== "Open" || !r.poDate) return false;
      const age = daysBetween(r.poDate, now.toISOString().slice(0, 10));
      return age !== null && age > 14;
    });
  }, [filteredRaw]);

  const processKpi = useMemo(() => {
    const withDates = filteredRaw.filter((r) => r.prDate && r.poDate);
    const leadPRPO = withDates.map((r) => daysBetween(r.prDate, r.poDate)).filter((v) => v !== null);
    const closedWithDates = filteredRaw.filter((r) => r.status === "Close" && r.poDate && r.receiveDate);
    const leadPOReceive = closedWithDates.map((r) => daysBetween(r.poDate, r.receiveDate)).filter((v) => v !== null);
    const qtyPO = filteredRaw.reduce((s, r) => s + (r.qtyPO || 0), 0);
    const qtyReceived = filteredRaw.reduce((s, r) => s + (r.qtyReceived || 0), 0);
    const avg = (arr) => (arr.length ? Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 10) / 10 : 0);
    return {
      avgLeadPRPO: avg(leadPRPO),
      avgLeadPOReceive: avg(leadPOReceive),
      fulfillment: qtyPO ? Math.round((qtyReceived / qtyPO) * 1000) / 10 : 0,
      poDelayCount: poDelayRows.length,
    };
  }, [filteredRaw, poDelayRows]);

  const tableRows = useMemo(() => {
    let r = withKnownStatus.filter(ALERT_PREDICATES[selectedAlert]);
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      r = r.filter(
        (row) =>
          (row.productName || "").toLowerCase().includes(q) ||
          (row.itemCode || "").toLowerCase().includes(q) ||
          (row.supplier || "").toLowerCase().includes(q)
      );
    }
    if (sortKey) {
      r = [...r].sort((a, b) => {
        const av = sortKey === "prStatus" ? prStatusLabel(a) : a[sortKey];
        const bv = sortKey === "prStatus" ? prStatusLabel(b) : b[sortKey];
        if (av === null || av === undefined) return 1;
        if (bv === null || bv === undefined) return -1;
        if (typeof av === "number" && typeof bv === "number") return sortDir === "asc" ? av - bv : bv - av;
        return sortDir === "asc" ? String(av).localeCompare(String(bv)) : String(bv).localeCompare(String(av));
      });
    }
    return r;
  }, [withKnownStatus, selectedAlert, search, sortKey, sortDir]);

  function handleSort(key) {
    if (sortKey === key) setSortDir(sortDir === "asc" ? "desc" : "asc");
    else {
      setSortKey(key);
      setSortDir("asc");
    }
  }

  const columns = [
    { key: "area", label: "Area" },
    { key: "itemCode", label: "Kode" },
    { key: "productName", label: "Produk" },
    { key: "supplier", label: "Supplier" },
    { key: "stockWH", label: "Stok WH", num: true },
    { key: "stockStatus", label: "Status Stok" },
    { key: "daysBeforeSO", label: "Hari s.d. SO", num: true },
    { key: "periode", label: "Periode" },
    { key: "status", label: "Status PO" },
    { key: "prStatus", label: "Filter PR Status", compute: (row) => prStatusLabel(row) },
  ];

  const totalPOStatus = Object.values(poStatusCounts).reduce((a, b) => a + b, 0) || 1;

  if (status === "loading") {
    return (
      <div style={{ background: "#0B1220", minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", color: "#8B96A8", fontFamily: "'Inter', 'Segoe UI', system-ui, sans-serif" }}>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: "13px", marginBottom: "10px" }}>Mengambil data live dari Google Sheets...</div>
          <div style={{ width: "28px", height: "28px", border: "3px solid #1F2937", borderTopColor: "#2DD4BF", borderRadius: "50%", margin: "0 auto", animation: "spin 0.8s linear infinite" }} />
          <style>{"@keyframes spin { to { transform: rotate(360deg); } }"}</style>
        </div>
      </div>
    );
  }

  if (status === "error") {
    return (
      <div style={{ background: "#0B1220", minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", color: "#E8ECF1", fontFamily: "'Inter', 'Segoe UI', system-ui, sans-serif", padding: "24px" }}>
        <div style={{ maxWidth: "480px", textAlign: "center", background: "#131C2E", border: "1px solid #1F2937", borderRadius: "10px", padding: "28px" }}>
          <div style={{ fontSize: "15px", fontWeight: 600, marginBottom: "10px", color: "#EF4444" }}>Gagal mengambil data live</div>
          <div style={{ fontSize: "12px", color: "#8B96A8", marginBottom: "16px" }}>{errorMsg}</div>
          <div style={{ fontSize: "11px", color: "#5B6579", marginBottom: "16px" }}>
            Kemungkinan penyebab: link publish-to-web berubah, koneksi terputus, atau browser memblokir permintaan lintas domain (CORS) ke Google Sheets. Kalau ini terus terjadi, pertimbangkan proxy backend kecil (lihat Langkah 2 di roadmap).
          </div>
          <button onClick={loadData} style={{ background: "#2DD4BF", color: "#0B1220", border: "none", borderRadius: "6px", padding: "8px 16px", fontSize: "12px", fontWeight: 600, cursor: "pointer" }}>
            Coba lagi
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ fontFamily: "'Inter', 'Segoe UI', system-ui, sans-serif", background: "#0B1220", minHeight: "100vh", color: "#E8ECF1", padding: "24px" }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "16px", marginBottom: "20px", paddingBottom: "20px", borderBottom: "1px solid #1F2937" }}>
        <div>
          <div style={{ fontSize: "12px", letterSpacing: "0.12em", color: "#2DD4BF", fontWeight: 600, marginBottom: "6px" }}>PPIC WAREHOUSE</div>
          <h1 style={{ fontSize: "28px", fontWeight: 700, margin: 0, letterSpacing: "-0.02em" }}>Control Tower</h1>
          <div style={{ fontSize: "13px", color: "#8B96A8", marginTop: "4px" }}>Acuan &amp; kontrol kesehatan inventory &middot; Monitoring PO 2.0</div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ display: "inline-flex", alignItems: "center", gap: "8px" }}>
            <div style={{ display: "inline-flex", alignItems: "center", gap: "6px", background: "#1A2436", border: "1px solid #2A3548", borderRadius: "999px", padding: "6px 14px", fontSize: "12px", color: "#2DD4BF" }}>
              <span style={{ width: "7px", height: "7px", borderRadius: "50%", background: "#2DD4BF" }} />
              Live &middot; Google Sheets
            </div>
            <button
              onClick={loadData}
              disabled={status === "refreshing"}
              style={{ background: "#1A2436", border: "1px solid #2A3548", borderRadius: "6px", color: "#8B96A8", fontSize: "11px", padding: "6px 10px", cursor: status === "refreshing" ? "wait" : "pointer" }}
            >
              {status === "refreshing" ? "Refreshing..." : "Refresh"}
            </button>
          </div>
          <div style={{ fontSize: "12px", color: "#5B6579", marginTop: "8px" }}>Update terakhir: {fmtDateTime(lastUpdated)}</div>
        </div>
      </div>

      {/* Filter bar */}
      <div style={{ display: "flex", gap: "10px", flexWrap: "wrap", alignItems: "center", marginBottom: "20px", background: "#131C2E", border: "1px solid #1F2937", borderRadius: "10px", padding: "12px 16px" }}>
        <span style={{ fontSize: "11px", color: "#8B96A8", fontWeight: 600, letterSpacing: "0.03em" }}>FILTER</span>
        <select value={period} onChange={(e) => setPeriod(e.target.value)} style={selectStyle}>
          <option>Semua Periode</option>
          {periods.map((p) => (
            <option key={p} value={p}>{p}</option>
          ))}
        </select>
        <select value={area} onChange={(e) => setArea(e.target.value)} style={selectStyle}>
          <option>Semua Area</option>
          {areas.map((a) => (
            <option key={a} value={a}>{a}</option>
          ))}
        </select>
        <select value={prStatusFilter} onChange={(e) => setPrStatusFilter(e.target.value)} style={selectStyle}>
          <option>Semua PR Status</option>
          {PR_STATUS_OPTIONS.map((p) => (
            <option key={p} value={p}>{p}</option>
          ))}
        </select>
        <input
          placeholder="Cari produk / kode / supplier..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ ...selectStyle, width: "240px", marginLeft: "auto" }}
        />
        {(period !== "Semua Periode" || area !== "Semua Area" || prStatusFilter !== "Semua PR Status" || search) && (
          <button
            onClick={() => {
              setPeriod("Semua Periode");
              setArea("Semua Area");
              setPrStatusFilter("Semua PR Status");
              setSearch("");
            }}
            style={{ background: "none", border: "1px solid #2A3548", borderRadius: "6px", color: "#8B96A8", fontSize: "12px", padding: "7px 12px", cursor: "pointer" }}
          >
            Reset
          </button>
        )}
      </div>

      {/* Inventory Health KPI row */}
      <div style={{ fontSize: "12px", fontWeight: 700, letterSpacing: "0.06em", color: "#8B96A8", marginBottom: "10px" }}>KESEHATAN INVENTORY</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: "12px", marginBottom: "16px" }}>
        {[
          { label: "SKU Dipantau", value: fmtNum(healthKpi.totalSKU), sub: `${period} \u00b7 ${area}` },
          { label: "Kondisi Sehat (Safe)", value: `${healthKpi.healthyPct}%`, sub: "dari SKU berstatus" },
          { label: "Total Perlu Aksi", value: fmtNum(healthKpi.allFlagged), sub: "Critical+Refill+Replenish+Penghabisan+OverStock+Dead", accent: "#F87171", alertKey: "allFlagged" },
          { label: "Dead Stock", value: fmtNum(healthKpi.dead), sub: "No Movement + Discontinue", accent: "#9CA3AF", alertKey: "deadStock" },
        ].map((c, i) => {
          const active = c.alertKey && selectedAlert === c.alertKey;
          const Tag = c.alertKey ? "button" : "div";
          const activeColor = c.accent || "#9CA3AF";
          return (
            <Tag
              key={i}
              onClick={c.alertKey ? () => setSelectedAlert(c.alertKey) : undefined}
              title={c.alertKey ? "Klik untuk lihat detail item" : undefined}
              style={{
                textAlign: "left",
                background: active ? `${activeColor}22` : "#131C2E",
                border: active ? `1px solid ${activeColor}` : "1px solid #1F2937",
                borderRadius: "10px",
                padding: "16px 18px",
                cursor: c.alertKey ? "pointer" : "default",
                fontFamily: "inherit",
                width: "100%",
              }}
            >
              <div style={{ fontSize: "11px", color: "#8B96A8", marginBottom: "8px" }}>{c.label}</div>
              <div style={{ fontSize: "26px", fontWeight: 700, fontVariantNumeric: "tabular-nums", fontFamily: "'JetBrains Mono', 'SFMono-Regular', Consolas, monospace", color: c.accent || "#E8ECF1" }}>
                {c.value}
              </div>
              <div style={{ fontSize: "11px", color: "#5B6579", marginTop: "4px" }}>{c.sub}</div>
            </Tag>
          );
        })}
      </div>

      {/* Alert strip */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: "12px", marginBottom: "24px" }}>
        {ALERT_ORDER.map((key) => {
          const meta = ALERT_META[key];
          const active = selectedAlert === key;
          return (
            <button
              key={key}
              onClick={() => setSelectedAlert(key)}
              title={meta.desc}
              style={{
                textAlign: "left",
                cursor: "pointer",
                background: active ? meta.glow : "#131C2E",
                border: active ? `1px solid ${meta.color}` : "1px solid #1F2937",
                borderRadius: "10px",
                padding: "16px 18px",
                fontFamily: "inherit",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "10px" }}>
                <span style={{ width: "9px", height: "9px", borderRadius: "50%", background: meta.color, flexShrink: 0 }} />
                <span style={{ fontSize: "11px", color: "#C7CFDB", letterSpacing: "0.04em", fontWeight: 600 }}>{meta.label}</span>
              </div>
              <div style={{ fontSize: "30px", fontWeight: 700, color: meta.color, fontVariantNumeric: "tabular-nums", fontFamily: "'JetBrains Mono', 'SFMono-Regular', Consolas, monospace" }}>
                {alertCounts[key]}
              </div>
            </button>
          );
        })}
      </div>

      {/* Distribution + Area health charts */}
      <div style={{ display: "grid", gridTemplateColumns: "minmax(260px, 340px) 1fr", gap: "16px", marginBottom: "16px" }}>
        <div style={{ background: "#131C2E", border: "1px solid #1F2937", borderRadius: "10px", padding: "18px" }}>
          <div style={{ fontSize: "13px", fontWeight: 600, marginBottom: "4px" }}>Distribusi Status Stok</div>
          <div style={{ fontSize: "11px", color: "#5B6579", marginBottom: "10px" }}>{withKnownStatus.length} SKU dalam cakupan filter</div>
          <ResponsiveContainer width="100%" height={280}>
            <PieChart>
              <Pie data={stockDistribution} dataKey="value" nameKey="name" innerRadius={55} outerRadius={95} paddingAngle={2}>
                {stockDistribution.map((entry) => (
                  <Cell key={entry.name} fill={STOCK_STATUS_COLORS[entry.name]} />
                ))}
              </Pie>
              <Tooltip contentStyle={{ background: "#1A2436", border: "1px solid #2A3548", borderRadius: "8px", fontSize: "12px" }} />
            </PieChart>
          </ResponsiveContainer>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "8px 14px", marginTop: "8px", justifyContent: "center" }}>
            {stockDistribution.map((d) => (
              <div key={d.name} style={{ display: "flex", alignItems: "center", gap: "5px", fontSize: "11px" }}>
                <span style={{ width: "7px", height: "7px", borderRadius: "50%", background: STOCK_STATUS_COLORS[d.name] }} />
                <span style={{ color: "#C7CFDB" }}>{d.name}</span>
                <span style={{ color: "#5B6579" }}>{d.value}</span>
              </div>
            ))}
          </div>
        </div>

        <div style={{ background: "#131C2E", border: "1px solid #1F2937", borderRadius: "10px", padding: "18px" }}>
          <div style={{ fontSize: "13px", fontWeight: 600, marginBottom: "4px" }}>Kesehatan Stok per Area</div>
          <div style={{ fontSize: "11px", color: "#5B6579", marginBottom: "10px" }}>Ditumpuk berdasarkan status stok gudang</div>
          <ResponsiveContainer width="100%" height={330}>
            <BarChart data={areaHealthChart} layout="vertical" margin={{ left: 8, right: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1F2937" horizontal={false} />
              <XAxis type="number" tick={{ fill: "#8B96A8", fontSize: 11 }} stroke="#1F2937" />
              <YAxis dataKey="area" type="category" tick={{ fill: "#C7CFDB", fontSize: 11 }} stroke="#1F2937" width={90} />
              <Tooltip contentStyle={{ background: "#1A2436", border: "1px solid #2A3548", borderRadius: "8px", fontSize: "12px" }} />
              <Legend wrapperStyle={{ fontSize: "11px", paddingTop: "6px" }} />
              {STOCK_STATUS_ORDER.map((s) => (
                <Bar key={s} dataKey={s} stackId="a" fill={STOCK_STATUS_COLORS[s]} />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Detail table */}
      <div style={{ background: "#131C2E", border: "1px solid #1F2937", borderRadius: "10px", padding: "18px", marginBottom: "16px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: "12px", marginBottom: "14px" }}>
          <div>
            <div style={{ fontSize: "13px", fontWeight: 600 }}>
              {ALERT_META[selectedAlert].label} <span style={{ color: "#5B6579", fontWeight: 400 }}>({tableRows.length})</span>
            </div>
            <div style={{ fontSize: "11px", color: "#5B6579", marginTop: "2px" }}>{ALERT_META[selectedAlert].desc}</div>
          </div>
          <button
            onClick={() => downloadCSV(tableRows, columns, selectedAlert, period, area)}
            disabled={tableRows.length === 0}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "6px",
              background: "#0B1220",
              border: "1px solid #2A3548",
              borderRadius: "6px",
              color: tableRows.length === 0 ? "#4B5563" : "#2DD4BF",
              fontSize: "12px",
              padding: "7px 12px",
              cursor: tableRows.length === 0 ? "not-allowed" : "pointer",
              whiteSpace: "nowrap",
              fontFamily: "inherit",
            }}
          >
            <span>{"\u2b07"}</span> Export ke Excel (CSV)
          </button>
        </div>
        <div style={{ overflowX: "auto", maxHeight: "460px", overflowY: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px" }}>
            <thead>
              <tr>
                {columns.map((col) => (
                  <th
                    key={col.key}
                    onClick={() => handleSort(col.key)}
                    style={{
                      textAlign: col.num ? "right" : "left",
                      padding: "8px 10px",
                      borderBottom: "1px solid #2A3548",
                      color: "#8B96A8",
                      fontWeight: 600,
                      fontSize: "11px",
                      cursor: "pointer",
                      whiteSpace: "nowrap",
                      position: "sticky",
                      top: 0,
                      background: "#131C2E",
                    }}
                  >
                    {col.label}
                    {sortKey === col.key ? (sortDir === "asc" ? " \u2191" : " \u2193") : ""}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {tableRows.length === 0 && (
                <tr>
                  <td colSpan={columns.length} style={{ padding: "24px 10px", textAlign: "center", color: "#5B6579" }}>
                    Tidak ada item pada kategori dan filter ini.
                  </td>
                </tr>
              )}
              {tableRows.map((row, i) => (
                <tr key={i} style={{ borderBottom: "1px solid #1B2436" }}>
                  {columns.map((col) => (
                    <td
                      key={col.key}
                      style={{
                        padding: "8px 10px",
                        textAlign: col.num ? "right" : "left",
                        color: col.key === "stockWH" && row[col.key] < 0 ? "#EF4444" : "#D6DCE6",
                        fontVariantNumeric: col.num ? "tabular-nums" : "normal",
                        whiteSpace: col.key === "productName" ? "normal" : "nowrap",
                        maxWidth: col.key === "productName" ? "220px" : "none",
                      }}
                    >
                      {col.compute ? col.compute(row) : col.num ? fmtNum(row[col.key]) : row[col.key] || "\u2014"}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* PO Process footer */}
      <div style={{ background: "#131C2E", border: "1px solid #1F2937", borderRadius: "10px", padding: "16px 18px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "12px", marginBottom: "12px" }}>
          <div style={{ fontSize: "13px", fontWeight: 600 }}>Proses PO (konteks pendukung)</div>
          <div style={{ display: "flex", gap: "18px", flexWrap: "wrap", fontSize: "12px" }}>
            <span style={{ color: "#8B96A8" }}>PO Delay (&gt;14 hari): <b style={{ color: "#3B82F6" }}>{processKpi.poDelayCount}</b></span>
            <span style={{ color: "#8B96A8" }}>Lead PR\u2192PO: <b style={{ color: "#E8ECF1" }}>{processKpi.avgLeadPRPO} hari</b></span>
            <span style={{ color: "#8B96A8" }}>Lead PO\u2192Terima: <b style={{ color: "#E8ECF1" }}>{processKpi.avgLeadPOReceive} hari</b></span>
            <span style={{ color: "#8B96A8" }}>Fulfillment: <b style={{ color: "#E8ECF1" }}>{processKpi.fulfillment}%</b></span>
          </div>
        </div>
        <div style={{ display: "flex", height: "10px", borderRadius: "999px", overflow: "hidden", marginBottom: "12px" }}>
          {Object.entries(poStatusCounts).map(([k, v]) => (
            <div key={k} style={{ width: `${(v / totalPOStatus) * 100}%`, background: PO_STATUS_COLORS[k] || "#6B7280" }} title={`${k}: ${v}`} />
          ))}
        </div>
        <div style={{ display: "flex", gap: "18px", flexWrap: "wrap" }}>
          {Object.entries(poStatusCounts).map(([k, v]) => (
            <div key={k} style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "12px" }}>
              <span style={{ width: "8px", height: "8px", borderRadius: "2px", background: PO_STATUS_COLORS[k] || "#6B7280" }} />
              <span style={{ color: "#C7CFDB" }}>{k}</span>
              <span style={{ color: "#5B6579" }}>{v} ({((v / totalPOStatus) * 100).toFixed(1)}%)</span>
            </div>
          ))}
        </div>
      </div>

      <div style={{ marginTop: "20px", fontSize: "11px", color: "#4B5563", textAlign: "center" }}>
        Sumber: Google Sheets "Copy of Monitoring PO Mart 2026" &middot; sheet Monitoring PO 2.0 (live via Publish to Web) &middot; auto-refresh tiap 10 menit
      </div>
    </div>
  );
}
