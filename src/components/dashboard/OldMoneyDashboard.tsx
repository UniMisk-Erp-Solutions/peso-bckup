import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { format } from "date-fns";
import { useTranslation } from "@/i18n";
import { useAuth } from "@/contexts/AuthContext";
import { formatINR } from "@/lib/format";
import { getDateFnsLocale, getDateLocale } from "@/lib/formatLocale";
import { useOldMoneyDashboardData } from "@/hooks/useOldMoneyDashboardData";
import { ORGANIZATION_FEATURE_KEYS } from "@/lib/organizationFeatureKeys";

/** Donut segment palette — emerald / brass / rose family only. */
const DONUT_COLORS = ["#1c4a3a", "#b08d4f", "#2c6b53", "#d8c39a", "#9e4a4a", "#8a8478"];
const SETTLED = ["approved", "paid", "verified", "level_1_verified", "level_2_verified"];

/** Time-of-day greeting as a translation key, so the copy stays localizable. */
function greetingKey(): string {
  const h = new Date().getHours();
  if (h < 12) return "oldMoney.greetingMorning";
  if (h < 18) return "oldMoney.greetingAfternoon";
  return "oldMoney.greetingEvening";
}

/** Stable 4-digit pseudo-number derived from a seed (same user → same digits, always). */
function consistentDigits(seed: string, len = 4): string {
  let h = 0;
  for (let i = 0; i < seed.length; i += 1) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return String(h % 10 ** len).padStart(len, "0");
}

/**
 * "Old Money" dashboard content. Renders inside the app's (re-skinned) shell, so it does
 * not draw its own sidebar — the global theme turns the real sidebar emerald.
 */
export function OldMoneyDashboard({ currentBalance }: { currentBalance: number }) {
  const { t, i18n } = useTranslation("dashboard");
  const { user, userProfile, userRole, organizationId, hasOrganizationFeature } = useAuth();
  const navigate = useNavigate();
  // Admins / team leads see the whole org's activity so the dashboard is populated;
  // everyone else sees their own money.
  const orgWide = userRole === "admin" || userRole === "team_leader";
  const data = useOldMoneyDashboardData(user?.id, organizationId, orgWide);

  // Dates and currency follow the app language, not just the copy.
  const dateLocale = getDateFnsLocale(i18n.language);
  const moneyLocale = getDateLocale(i18n.language);
  const money = (amount: number) => formatINR(amount, moneyLocale);
  const day = (date: Date, pattern: string) => format(date, pattern, { locale: dateLocale });

  const name =
    userProfile?.name || user?.email?.split("@")[0] || t("oldMoney.memberFallback");
  const firstName = name.split(/\s+/)[0];
  const monthLabel = day(new Date(), "MMMM yyyy");

  const donut = useMemo(() => {
    const total = data.categories.reduce((s, c) => s + c.amount, 0);
    let offset = 0;
    const segments = data.categories.map((c, i) => {
      const pct = total > 0 ? (c.amount / total) * 100 : 0;
      const seg = { color: DONUT_COLORS[i % DONUT_COLORS.length], len: pct, offset: -offset };
      offset += pct;
      return seg;
    });
    return { total, segments };
  }, [data.categories]);

  const maxBar = useMemo(() => Math.max(1, ...data.months.map((m) => m.submitted)), [data.months]);

  const budgetPct = useMemo(() => {
    const denom = data.monthSpent + Math.max(0, currentBalance);
    return denom > 0 ? Math.min(100, Math.round((data.monthSpent / denom) * 100)) : 0;
  }, [data.monthSpent, currentBalance]);

  // Card number: employee ID where the org has it enabled, otherwise a stable per-user number.
  const employeeIdEnabled = hasOrganizationFeature(ORGANIZATION_FEATURE_KEYS.employee_id_login);
  const cardNumber =
    employeeIdEnabled && data.employeeId ? data.employeeId : consistentDigits(user?.id || "pesowise");
  const lastDebitLabel = data.lastDebitAt
    ? day(new Date(data.lastDebitAt), "dd MMM yy")
    : "—";

  // DOC-087 — Balance History stays reachable under this theme too, using the
  // panel-header link treatment the Recent activity panel already uses.
  const balanceHistoryEnabled =
    userRole === "employee" &&
    hasOrganizationFeature(ORGANIZATION_FEATURE_KEYS.employee_transfer_history);

  return (
    <div className="om-root">
      <style>{OM_CSS}</style>

      <div className="om-top">
        <div>
          <div className="om-eyebrow">{monthLabel} · {t("oldMoney.overview")}</div>
          <h1 className="om-serif">
            {t(greetingKey())}, <em>{firstName}</em>
          </h1>
          <p>{t("oldMoney.subtitle")}</p>
        </div>
        <div className="om-top-r">
          <span className="om-opt">{day(new Date(), "MMM yyyy")}</span>
          <button type="button" className="om-cta" onClick={() => navigate("/expenses/new")}>
            <svg fill="none" stroke="currentColor" strokeWidth={2.2} viewBox="0 0 24 24" width="15" height="15"><path d="M12 5v14M5 12h14" /></svg>
            {t("oldMoney.record")}
          </button>
        </div>
      </div>

      <div className="om-stats">
        <div className="om-stat">
          <div className="om-k">{t("oldMoney.transactions")} · {day(new Date(), "MMM")}</div>
          <div className="om-stat-v om-serif">{data.monthCount}</div>
        </div>
        <div className="om-stat">
          <div className="om-k">{t("oldMoney.avgExpense")}</div>
          <div className="om-stat-v om-serif">
            {money(data.monthCount > 0 ? Math.round(data.monthSpent / data.monthCount) : 0)}
          </div>
        </div>
        <div className="om-stat">
          <div className="om-k">{t("oldMoney.approvedRate")}</div>
          <div className="om-stat-v om-serif">
            {data.monthSpent > 0 ? Math.round((data.monthApproved / data.monthSpent) * 100) : 0}%
          </div>
        </div>
        <div className="om-stat">
          <div className="om-k">{t("oldMoney.largest")} · {day(new Date(), "MMM")}</div>
          <div className="om-stat-v om-serif">{money(data.monthLargest)}</div>
        </div>
      </div>

      <div className="om-grid">
        {/* LEFT — Net Position */}
        <section className="om-panel om-nw">
          <div className="om-ph">
            <h3>{t("oldMoney.netPosition")}</h3>
            {balanceHistoryEnabled && (
              <a className="om-lnk" onClick={() => navigate("/balance-history")}>
                {t("oldMoney.balanceHistory")}
              </a>
            )}
          </div>
          <div className="om-label">{t("oldMoney.availableBalance")}</div>
          <div className="om-big om-serif">{money(currentBalance)}</div>
          {data.deltaPct !== 0 && (
            <div className={`om-delta ${data.deltaPct <= 0 ? "down" : "up"}`}>
              {data.deltaPct > 0 ? "▲" : "▼"}{" "}
              {t("oldMoney.spendVsLastMonth", { pct: Math.abs(data.deltaPct).toFixed(1) })}
            </div>
          )}
          <div className="om-ei">
            <div>
              <div className="om-k">{t("oldMoney.spent")} · {day(new Date(), "MMM")}</div>
              <div className="om-v out om-serif">{money(data.monthSpent)}</div>
            </div>
            <div>
              <div className="om-k">{t("oldMoney.approved")}</div>
              <div className="om-v in om-serif">{money(data.monthApproved)}</div>
            </div>
          </div>
          <div className="om-bars" role="img" aria-label={t("oldMoney.barsAriaLabel")}>
            {data.months.map((m) => (
              <div className="om-bc" key={m.label}>
                <div className="om-bs">
                  <div className="om-bar a" style={{ height: `${Math.round((m.submitted / maxBar) * 100)}%` }} />
                  <div className="om-bar b" style={{ height: `${Math.round((m.approved / maxBar) * 100)}%` }} />
                </div>
                <span>{m.label}</span>
              </div>
            ))}
          </div>
          <div className="om-lg">
            <span><i style={{ background: "var(--om-emerald)" }} />{t("oldMoney.submitted")}</span>
            <span><i style={{ background: "var(--om-brass-soft)" }} />{t("oldMoney.approved")}</span>
          </div>
        </section>

        {/* MIDDLE */}
        <div className="om-midcol">
          <section className="om-panel om-bud">
            <div className="om-ph"><h3>{t("oldMoney.monthlySpend")}</h3></div>
            <div className="om-line">
              <div>
                <div className="om-k">{t("oldMoney.spent")}</div>
                <div className="om-v om-serif">{money(data.monthSpent)}</div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div className="om-k">{t("oldMoney.available")}</div>
                <div className="om-v av om-serif">{money(Math.max(0, currentBalance))}</div>
              </div>
            </div>
            <div className="om-track"><i style={{ width: `${budgetPct}%` }} /></div>
            <div className="om-split-bar">
              <i className="ap" style={{ width: `${data.monthSpent > 0 ? (data.monthApproved / data.monthSpent) * 100 : 0}%` }} />
              <i className="pe" style={{ width: `${data.monthSpent > 0 ? (data.monthPending / data.monthSpent) * 100 : 0}%` }} />
            </div>
            <div className="om-lg" style={{ marginTop: 12 }}>
              <span>
                <i style={{ background: "var(--om-emerald)" }} />
                {t("oldMoney.approvedWithAmount", { amount: money(data.monthApproved) })}
              </span>
              <span>
                <i style={{ background: "var(--om-brass-soft)" }} />
                {t("oldMoney.pendingWithAmount", { amount: money(data.monthPending) })}
              </span>
            </div>
          </section>

          <section className="om-panel">
            <div className="om-ph"><h3>{t("oldMoney.whereItWent")} · {day(new Date(), "MMM")}</h3></div>
            {donut.total > 0 ? (
              <div className="om-donut-wrap">
                <div className="om-donut">
                  <svg viewBox="0 0 36 36" width="148" height="148">
                    <circle cx="18" cy="18" r="15.9155" fill="none" stroke="#eee9df" strokeWidth="3.4" />
                    {donut.segments.map((s, i) => (
                      <circle
                        key={i}
                        cx="18" cy="18" r="15.9155" fill="none"
                        stroke={s.color} strokeWidth="3.4"
                        strokeDasharray={`${s.len} ${100 - s.len}`}
                        strokeDashoffset={s.offset}
                        transform="rotate(-90 18 18)"
                      />
                    ))}
                  </svg>
                  <div className="om-c"><div><small>{t("oldMoney.total")}</small><b className="om-serif">{money(donut.total)}</b></div></div>
                </div>
                <div className="om-cats">
                  {data.categories.map((c, i) => (
                    <div key={c.name}>
                      <i style={{ background: DONUT_COLORS[i % DONUT_COLORS.length] }} />
                      <span style={{ textTransform: "capitalize" }}>{c.name}</span>
                      <span className="om-amt">{money(c.amount)}</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <p className="om-empty">{t("oldMoney.noSpending")}</p>
            )}
          </section>
        </div>

        {/* CARD (own grid cell so it can sit top-right on desktop, first on mobile) */}
        <div className="om-card">
          <div className="om-card-row">
            <span className="om-card-k">{t("oldMoney.wallet")}</span>
            {/* Card-face brand mark — intentionally not translated. */}
            <span className="om-seal om-serif">VISA</span>
          </div>
          <div>
            <div className="om-card-k">{t("oldMoney.availableBalance")}</div>
            <div className="om-card-amt om-serif">{money(Math.max(0, currentBalance))}</div>
          </div>
          <div className="om-card-row">
            <span className="om-num">•••• {cardNumber}</span>
            <span className="om-card-meta">
              <span className="om-card-meta-k">{t("oldMoney.lastDebit")}</span>
              <span className="om-num">{lastDebitLabel}</span>
            </span>
          </div>
        </div>

        {/* RIGHT — recent activity */}
        <div className="om-rightcol">
          <section className="om-panel">
            <div className="om-ph">
              <h3>{t("oldMoney.recentActivity")}</h3>
              <a className="om-lnk" onClick={() => navigate("/expenses")}>
                {t("oldMoney.history")}
              </a>
            </div>
            {data.recent.length > 0 ? (
              // Named `tx`, not `t` — `t` is the translation function in this scope.
              data.recent.map((tx) => {
                const settled = SETTLED.includes(tx.status || "");
                return (
                  <div className="om-tx" key={tx.id} role="button" tabIndex={0}
                    onClick={() => navigate(`/expenses/${tx.id}`)}
                    onKeyDown={(e) => { if (e.key === "Enter") navigate(`/expenses/${tx.id}`); }}>
                    <div className="om-ic">{(tx.title || "?").charAt(0).toUpperCase()}</div>
                    <div className="om-m">
                      <b>{tx.title || t("oldMoney.expenseFallback")}</b>
                      <small style={{ textTransform: "capitalize" }}>{(tx.category || "expense")} · {(tx.status || "").replace(/_/g, " ")}</small>
                    </div>
                    <div className={`om-tx-amt ${settled ? "pos" : "neg"}`}>
                      {settled ? "" : "−"}{money(tx.amount)}
                    </div>
                  </div>
                );
              })
            ) : (
              <p className="om-empty">{t("oldMoney.noRecentActivity")}</p>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

const OM_CSS = `
.om-root{
  --om-emerald:#1c4a3a; --om-emerald-2:#2c6b53; --om-brass:#b08d4f;
  --om-brass-soft:#d8c39a; --om-rose:#9e4a4a; --om-muted:#8a8478; --om-line:#e7e2d8; --om-ink:#1c1a16;
  font-family:"Inter",system-ui,sans-serif; color:var(--om-ink);
}
.om-root *{box-sizing:border-box}
.om-serif{font-family:"Fraunces",Georgia,serif}
.om-top{display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:28px;gap:18px;flex-wrap:wrap}
.om-eyebrow{font-size:11px;letter-spacing:3px;text-transform:uppercase;color:var(--om-brass);font-weight:600}
.om-top h1{font-size:34px;font-weight:500;letter-spacing:-.5px;margin-top:7px;line-height:1;color:var(--om-ink)}
.om-top h1 em{font-style:italic;color:var(--om-emerald)}
.om-top p{color:var(--om-muted);font-size:14px;margin-top:10px}
.om-top-r{display:flex;align-items:center;gap:10px}
.om-opt{display:flex;align-items:center;gap:9px;background:#fff;border:1px solid var(--om-line);border-radius:12px;padding:11px 15px;font-size:13px;font-weight:500;color:var(--om-ink)}
.om-cta{background:var(--om-emerald);color:#fff;border:none;border-radius:12px;padding:12px 19px;font:inherit;font-size:13px;font-weight:600;cursor:pointer;display:flex;align-items:center;gap:8px}
.om-stats{display:grid;grid-template-columns:repeat(4,1fr);gap:24px;margin-bottom:24px}
.om-stat{background:#fff;border:1px solid var(--om-line);border-radius:18px;padding:18px 20px}
.om-stat-v{font-size:24px;font-weight:500;margin-top:6px;color:var(--om-ink);font-variant-numeric:tabular-nums;letter-spacing:-.5px}
.om-split-bar{display:flex;gap:3px;height:7px;margin-top:10px}
.om-split-bar i{display:block;height:100%;border-radius:4px;min-width:2px}
.om-split-bar i.ap{background:var(--om-emerald)} .om-split-bar i.pe{background:var(--om-brass-soft)}
@media(max-width:1100px){.om-stats{grid-template-columns:repeat(2,1fr)}}
.om-grid{display:grid;grid-template-columns:1.15fr 1fr .92fr;gap:24px;align-items:start;
  grid-template-areas:"net mid card" "net mid recent";}
.om-nw{grid-area:net} .om-midcol{grid-area:mid} .om-card{grid-area:card} .om-rightcol{grid-area:recent}
.om-panel{background:#fff;border:1px solid var(--om-line);border-radius:18px;padding:24px}
.om-ph{display:flex;align-items:center;justify-content:space-between;margin-bottom:20px}
.om-ph h3{font-size:13px;letter-spacing:.4px;text-transform:uppercase;color:var(--om-muted);font-weight:600}
.om-lnk{font-size:12.5px;color:var(--om-brass);font-weight:600;cursor:pointer}
.om-label{font-size:12.5px;color:var(--om-muted)}
.om-big{font-size:40px;font-weight:500;letter-spacing:-1.5px;margin:6px 0 4px;line-height:1.05;font-variant-numeric:tabular-nums;color:var(--om-ink)}
.om-delta{font-size:13px;font-weight:600;margin-bottom:2px}
.om-delta.up{color:var(--om-rose)} .om-delta.down{color:var(--om-emerald-2)}
.om-ei{display:flex;gap:34px;margin:22px 0;padding:18px 0;border-top:1px solid var(--om-line);border-bottom:1px solid var(--om-line)}
.om-k{font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:var(--om-muted)}
.om-v{font-size:20px;font-weight:500;margin-top:5px;font-variant-numeric:tabular-nums;color:var(--om-ink)}
.om-v.out{color:var(--om-rose)} .om-v.in{color:var(--om-emerald-2)} .om-v.av{color:var(--om-emerald-2)}
.om-bars{display:flex;align-items:flex-end;gap:18px;height:110px}
.om-bc{flex:1;display:flex;flex-direction:column;align-items:center;gap:9px}
.om-bs{display:flex;align-items:flex-end;gap:5px;height:100%}
.om-bar{width:8px;border-radius:3px;min-height:2px}
.om-bar.a{background:var(--om-emerald)} .om-bar.b{background:var(--om-brass-soft)}
.om-bc span{font-size:11px;color:var(--om-muted);letter-spacing:.5px}
.om-lg{display:flex;gap:20px;margin-top:16px;font-size:12px;color:var(--om-muted)}
.om-lg i{width:8px;height:8px;border-radius:2px;display:inline-block;margin-right:7px;vertical-align:middle}
.om-midcol,.om-rightcol{display:flex;flex-direction:column;gap:24px}
.om-line{display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:14px}
.om-track{height:7px;border-radius:5px;background:#eee9df;overflow:hidden}
.om-track > i{display:block;height:100%;border-radius:5px;background:linear-gradient(90deg,var(--om-emerald),var(--om-brass))}
.om-donut-wrap{display:flex;align-items:center;gap:22px;flex-wrap:wrap}
.om-donut{position:relative;width:148px;height:148px;flex-shrink:0}
.om-donut .om-c{position:absolute;inset:0;display:grid;place-items:center;text-align:center}
.om-donut .om-c small{font-size:10px;letter-spacing:2px;text-transform:uppercase;color:var(--om-muted);display:block;margin-bottom:3px}
.om-donut .om-c b{font-size:20px;font-weight:500;font-variant-numeric:tabular-nums;color:var(--om-ink)}
.om-cats{display:flex;flex-direction:column;gap:11px;flex:1;min-width:140px;font-size:13px}
.om-cats div{display:flex;align-items:center;gap:10px}
.om-cats i{width:8px;height:8px;border-radius:2px;flex-shrink:0}
.om-cats .om-amt{margin-left:auto;color:var(--om-muted);font-variant-numeric:tabular-nums}
.om-card{border-radius:18px;padding:24px;color:#efe9da;position:relative;overflow:hidden;background:linear-gradient(150deg,#20322b 0%,#1c4a3a 60%,#14352a 100%);min-height:186px;display:flex;flex-direction:column;justify-content:space-between;border:1px solid rgba(216,195,154,.18)}
.om-card::before{content:"";position:absolute;inset:0;background:repeating-linear-gradient(115deg,transparent 0 9px,rgba(216,195,154,.05) 9px 10px)}
.om-card-row{display:flex;justify-content:space-between;align-items:center;position:relative;z-index:1}
.om-seal{font-style:italic;font-size:19px;color:var(--om-brass-soft)}
.om-card-k{font-size:10px;letter-spacing:2px;text-transform:uppercase;color:var(--om-brass-soft);position:relative;z-index:1}
.om-card-amt{font-size:30px;font-weight:500;position:relative;z-index:1;margin-top:4px;font-variant-numeric:tabular-nums}
.om-num{font-size:13px;letter-spacing:2px;position:relative;z-index:1;font-variant-numeric:tabular-nums}
.om-card-meta{display:flex;flex-direction:column;align-items:flex-end;gap:1px;position:relative;z-index:1}
.om-card-meta-k{font-size:8px;letter-spacing:2px;text-transform:uppercase;color:var(--om-brass-soft);opacity:.85}
.om-tx{display:flex;align-items:center;gap:13px;padding:13px 0;border-top:1px solid var(--om-line);cursor:pointer}
.om-tx:first-of-type{border-top:none;padding-top:2px}
.om-ic{width:38px;height:38px;border-radius:10px;display:grid;place-items:center;font-weight:700;font-size:13px;flex-shrink:0;border:1px solid var(--om-line);color:var(--om-ink)}
.om-m b{font-size:13.5px;display:block;color:var(--om-ink)}
.om-m small{font-size:11.5px;color:var(--om-muted)}
.om-tx-amt{margin-left:auto;font-weight:600;font-size:13.5px;font-variant-numeric:tabular-nums}
.om-tx-amt.neg{color:var(--om-rose)} .om-tx-amt.pos{color:var(--om-emerald-2)}
.om-empty{font-size:13px;color:var(--om-muted);padding:8px 0}
.om-root a:focus-visible,.om-root button:focus-visible,.om-tx:focus-visible{outline:2px solid var(--om-brass);outline-offset:2px;border-radius:8px}
@media(max-width:1100px){
  .om-grid{grid-template-columns:1fr;grid-template-areas:"card" "net" "mid" "recent";}
}
@media(max-width:767px){
  .om-stats{grid-template-columns:repeat(2,1fr);gap:12px}
  .om-stat{padding:14px 16px}
  .om-stat-v{font-size:18px}
  .om-top h1{font-size:22px}
  .om-top p{font-size:13px;margin-top:8px}
  .om-big{font-size:28px;letter-spacing:-0.5px}
  .om-panel{padding:16px}
  .om-grid{gap:14px}
  .om-card{min-height:160px;padding:18px}
  .om-card-amt{font-size:24px}
  .om-donut-wrap{flex-direction:column}
  .om-donut{width:120px;height:120px}
  .om-bars{height:80px;gap:10px}
  .om-bc{gap:6px}
  .om-bar{width:6px}
  .om-ei{gap:16px;margin:16px 0;padding:14px 0}
  .om-v{font-size:16px}
}
@media(prefers-reduced-motion:reduce){.om-root *{transition:none!important}}
`;
