(() => {
  "use strict";
  const $ = (s, r = document) => r.querySelector(s);
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const norm = s => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
  const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const parseIso = s => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
  const longDate = s => parseIso(s).toLocaleDateString("fr-BE", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const shortDate = s => parseIso(s).toLocaleDateString("fr-BE", { day: "2-digit", month: "2-digit", year: "2-digit" });
  const store = {
    get(k) { try { return localStorage.getItem("pres." + k); } catch { return null; } },
    set(k, v) { try { v == null ? localStorage.removeItem("pres." + k) : localStorage.setItem("pres." + k, v); } catch {} },
  };

  // Le dimanche on ouvre la liste du jour, les autres jours celle du dimanche passé.
  const defaultDate = () => { const d = new Date(); d.setDate(d.getDate() - d.getDay()); return iso(d); };

  const NO_COMM = "Sans commission";
  const PALETTE = ["--c1", "--c2", "--c3", "--c4", "--c5", "--c6"];
  const KNOWN = { FGI: "--c1", HED: "--c2", Johanna: "--c3", Joseph: "--c4" };
  const ORDER = ["FGI", "HED", "Johanna", "Joseph"];
  const commColor = c => {
    if (!c || c === NO_COMM) return "var(--muted)";
    if (KNOWN[c]) return `var(${KNOWN[c]})`;
    let h = 0; for (const ch of c) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return `var(${PALETTE[h % PALETTE.length]})`;
  };
  const PEER_COLORS = ["#c2410c", "#0f766e", "#be185d", "#4338ca", "#4d7c0f", "#7e22ce", "#b45309", "#0369a1"];
  const peerColor = s => { let h = 0; for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return PEER_COLORS[h % PEER_COLORS.length]; };

  const cfg = window.PRESENCES_CONFIG;
  const sb = window.supabase.createClient(cfg.url, cfg.cle, { auth: { persistSession: false, autoRefreshToken: false } });
  const clientId = Math.random().toString(36).slice(2, 10);

  const state = {
    code: store.get("code"), nom: store.get("nom") || "",
    members: new Map(), seances: new Map(), messages: [],
    date: defaultDate(), tab: store.get("tab") || "appel",
    filter: "", q: "", hideMarked: false, suiviFilter: "", showOff: false,
    cursor: null, order: [], peers: [], online: true,
  };

  // ---------- Accès à la base ----------
  class ApiError extends Error { constructor(code) { super(code); this.code = code; } }
  async function rpc(name, args = {}) {
    const { data, error } = await sb.rpc(name, args);
    if (error) throw new ApiError("RESEAU");
    if (data && data.erreur) {
      if ((data.erreur === "MAUVAIS_CODE" || data.erreur === "PAS_DE_CODE") && !$("#app").hidden) { lock("Le code a changé. Entre le nouveau code."); }
      throw new ApiError(data.erreur);
    }
    return data;
  }
  const withCode = args => ({ p_code: state.code, ...args });

  function applyLoad(data) {
    state.members = new Map(data.membres.map(m => [m.id, m]));
    state.seances = new Map(data.seances.map(s => [s.date, { titre: s.titre || "", presences: s.presences || {} }]));
    state.messages = data.messages || [];
  }
  async function reload() {
    const data = await rpc("charger", withCode());
    applyLoad(data);
    render(); renderChatBadge(); if (!$("#chat").hidden) renderChat();
  }

  // ---------- Entrée ----------
  let codeDefined = true;
  async function showGate(message) {
    $("#app").hidden = true; $("#chatBtn").hidden = true; $("#chat").hidden = true; $("#gate").hidden = false;
    $("#gNom").value = state.nom;
    try { codeDefined = (await rpc("etat")).code_defini; } catch { codeDefined = true; }
    $("#gCode2Wrap").hidden = codeDefined;
    $("#gCode2").required = !codeDefined;
    $("#gCode").autocomplete = codeDefined ? "current-password" : "new-password";
    $("#gateText").textContent = codeDefined
      ? "Entre le code de l'église pour ouvrir la liste."
      : "Première ouverture : choisis le code de l'église (6 caractères minimum). Donne-le ensuite aux personnes qui font l'appel.";
    $("#gBtn").textContent = codeDefined ? "Ouvrir" : "Créer le code et ouvrir";
    const err = $("#gErr"); err.hidden = !message; err.textContent = message || "";
    $("#gCode").focus();
  }
  function lock(message) {
    state.code = null; store.set("code", null);
    leaveRealtime();
    showGate(message);
  }
  $("#gateForm").onsubmit = async e => {
    e.preventDefault();
    const code = $("#gCode").value.trim(), nom = $("#gNom").value.trim();
    const err = $("#gErr"); err.hidden = true;
    const fail = m => { err.textContent = m; err.hidden = false; };
    if (code.length < 6) return fail("Le code doit faire au moins 6 caractères.");
    if (!nom) return fail("Indique ton prénom.");
    $("#gBtn").disabled = true;
    try {
      if (!codeDefined) {
        if (code !== $("#gCode2").value.trim()) { $("#gBtn").disabled = false; return fail("Les deux codes ne sont pas identiques."); }
        await rpc("definir_code", { p_nouveau: code, p_ancien: null });
      }
      const data = await rpc("charger", { p_code: code });
      state.code = code; state.nom = nom;
      store.set("code", code); store.set("nom", nom);
      applyLoad(data);
      start();
    } catch (ex) {
      fail({ MAUVAIS_CODE: "Code incorrect.", BLOQUE: "Trop d'essais. Réessaie dans 15 minutes.", RESEAU: "Pas de connexion. Vérifie internet et réessaie." }[ex.code] || "Impossible d'ouvrir. Réessaie.");
    }
    $("#gBtn").disabled = false;
  };

  function start() {
    $("#gate").hidden = true; $("#app").hidden = false; $("#chatBtn").hidden = false;
    $("#gCode").value = ""; $("#gCode2").value = "";
    render(); renderChatBadge();
    joinRealtime();
  }

  // ---------- Temps réel : présences cochées, messages, qui est en ligne ----------
  let channel = null;
  async function joinRealtime() {
    leaveRealtime();
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("presences:" + state.code));
    const room = "eglise-" + [...new Uint8Array(digest)].slice(0, 10).map(b => b.toString(16).padStart(2, "0")).join("");
    channel = sb.channel(room, { config: { broadcast: { self: false }, presence: { key: clientId } } });
    channel
      .on("broadcast", { event: "mark" }, ({ payload: p }) => {
        if (!p || !p.date || !p.id) return;
        const s = seance(p.date);
        if (p.val) s.presences[p.id] = p.val; else delete s.presences[p.id];
        if (p.date === state.date || state.tab !== "appel") render();
      })
      .on("broadcast", { event: "reload" }, () => { reload().catch(() => {}); })
      .on("broadcast", { event: "msg" }, ({ payload: m }) => {
        if (!m || !m.texte) return;
        state.messages.push(m); state.messages = state.messages.slice(-40);
        if (!$("#chat").hidden) renderChat(); else renderChatBadge();
      })
      .on("presence", { event: "sync" }, () => {
        state.peers = Object.entries(channel.presenceState()).map(([key, metas]) => ({ key, ...(metas[metas.length - 1] || {}) }));
        renderPeers(); paintPeerTags();
      })
      .subscribe(status => {
        const ok = status === "SUBSCRIBED";
        setOnline(ok);
        if (ok) { lastPres = ""; pushPresence(); }
      });
  }
  function leaveRealtime() { if (channel) { sb.removeChannel(channel); channel = null; } }
  function broadcast(event, payload) { channel?.send({ type: "broadcast", event, payload }).catch(() => {}); }
  function setOnline(ok) { state.online = ok; $("#net").classList.toggle("off", !ok); $("#net").title = ok ? "Connecté en direct" : "Hors ligne : les changements des autres n'arrivent pas"; }

  let presTimer, lastPres = "";
  function pushPresence() {
    if (!channel) return;
    clearTimeout(presTimer);
    presTimer = setTimeout(() => {
      const p = { nom: state.nom, tab: state.tab, date: state.date, cursor: state.tab === "appel" ? (state.cursor || null) : null };
      const s = JSON.stringify(p);
      if (s === lastPres) return;
      lastPres = s;
      channel.track(p).catch(() => {});
    }, 300);
  }
  const PLACE = { appel: "Appel", cultes: "Cultes", suivi: "Suivi", membres: "Membres" };
  const others = () => state.peers.filter(p => p.key !== clientId && p.nom);
  function whereText(p) {
    let s = PLACE[p.tab] || "";
    if (p.tab === "appel" && p.date) s += " " + shortDate(p.date);
    if (p.tab === "appel" && p.cursor && state.members.has(p.cursor)) s += " · " + state.members.get(p.cursor).nom;
    return s;
  }
  function renderPeers() {
    const o = others();
    $("#people").innerHTML = o.length ? `<span class="person"><span class="av" style="--pc:var(--present)">${o.length + 1}</span>en ligne</span>` +
      o.map(p => `<span class="person"><span class="av" style="--pc:${peerColor(p.nom)}">${esc(p.nom.charAt(0).toUpperCase())}</span>${esc(p.nom)} <span class="where">${esc(whereText(p))}</span></span>`).join("") : "";
  }
  function paintPeerTags() {
    document.querySelectorAll(".peer-tag").forEach(n => n.remove());
    if (state.tab !== "appel") return;
    for (const p of others()) {
      if (p.tab !== "appel" || p.date !== state.date || !p.cursor) continue;
      const meta = document.querySelector(`[data-tap="${CSS.escape(p.cursor)}"] .meta`);
      if (meta) meta.insertAdjacentHTML("beforeend", `<span class="peer-tag" style="--pc:${peerColor(p.nom)}">${esc(p.nom)} est ici</span>`);
    }
  }

  // ---------- Données dérivées ----------
  const seance = date => { if (!state.seances.has(date)) state.seances.set(date, { titre: "", presences: {} }); return state.seances.get(date); };
  const presOf = date => state.seances.get(date)?.presences || {};
  const commOf = m => m.commission || NO_COMM;
  const activeMembers = () => [...state.members.values()].filter(m => m.actif !== false);
  const byName = (a, b) => (a.nom || "").localeCompare(b.nom || "", "fr");
  const commissions = () => {
    const set = new Set(activeMembers().map(commOf));
    return [...set].sort((a, b) => {
      if (a === NO_COMM) return 1; if (b === NO_COMM) return -1;
      const ia = ORDER.indexOf(a), ib = ORDER.indexOf(b);
      if (ia >= 0 || ib >= 0) return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
      return a.localeCompare(b, "fr");
    });
  };
  const datesWithMarks = () => [...state.seances.keys()].filter(d => Object.keys(presOf(d)).length).sort();

  // ---------- Écritures ----------
  const queue = new Map();
  const enqueue = (key, fn) => { const p = (queue.get(key) || Promise.resolve()).then(fn, fn); queue.set(key, p.catch(() => {})); return p; };
  function writeError(e) {
    if (e?.code === "MAUVAIS_CODE" || e?.code === "PAS_DE_CODE") return;
    toast(e?.code === "BLOQUE" ? "Trop d'essais de code. Réessaie dans 15 minutes." : "Pas enregistré. Vérifie internet : je recharge la liste.");
    reload().catch(() => {});
  }
  function setPresence(id, val) {
    const s = seance(state.date);
    if (val) s.presences[id] = val; else delete s.presences[id];
    render();
    const date = state.date;
    enqueue("m:" + date + id, () => rpc("marquer", withCode({ p_date: date, p_membre: id, p_valeur: val })))
      .then(() => broadcast("mark", { date, id, val }))
      .catch(writeError);
  }

  // ---------- Rendu ----------
  function render() {
    document.querySelectorAll(".tabs button").forEach(b => b.setAttribute("aria-selected", String(b.dataset.tab === state.tab)));
    $("#datebar").hidden = state.tab !== "appel";
    $("#dayLabel").textContent = longDate(state.date);
    $("#datePick").value = state.date;
    const v = $("#view");
    if (state.tab === "appel") { renderAppel(v); paintPeerTags(); }
    else if (state.tab === "cultes") renderCultes(v);
    else if (state.tab === "suivi") renderSuivi(v);
    else renderMembres(v);
    pushPresence();
  }

  function renderAppel(v) {
    const pres = presOf(state.date);
    const members = activeMembers();
    const titre = state.seances.get(state.date)?.titre || "";
    const isIn = m => pres[m.id] === "p" || pres[m.id] === "z";
    const total = members.filter(isIn).length;
    const zoom = members.filter(m => pres[m.id] === "z").length;
    const comms = commissions();
    const countIn = c => members.filter(m => commOf(m) === c && isIn(m)).length;
    const countAll = c => members.filter(m => commOf(m) === c).length;
    const q = norm(state.q);
    const shown = members.filter(m => (!state.filter || commOf(m) === state.filter) && (!q || norm(m.nom).includes(q)) && (!state.hideMarked || !isIn(m) || m.id === state.cursor));
    const groups = comms.filter(c => !state.filter || c === state.filter)
      .map(c => ({ c, list: shown.filter(m => commOf(m) === c).sort(byName) })).filter(g => g.list.length);
    state.order = groups.flatMap(g => g.list.map(m => m.id));
    if (!state.order.includes(state.cursor)) state.cursor = state.order[0] || null;
    const exact = q && members.some(m => norm(m.nom) === q);

    v.innerHTML = `
      <input class="titre" id="titre" value="${esc(titre)}" placeholder="Nom du culte (facultatif), ex. Culte du dimanche" maxlength="80" autocomplete="off">
      <div class="summary">
        <div class="big">${total}<small> / ${members.length} présents${zoom ? ` · dont ${zoom} sur Zoom` : ""}</small></div>
        <button class="btn" id="copy" style="margin-left:auto">Copier le résumé</button>
      </div>
      <div class="bar" aria-hidden="true"><i style="width:${members.length ? Math.round(total / members.length * 100) : 0}%"></i></div>
      <div class="chips" style="margin-top:12px">
        <button class="chip" data-filter="" aria-pressed="${!state.filter}">Tous <span class="n">${total}/${members.length}</span></button>
        ${comms.map(c => `<button class="chip" data-filter="${esc(c)}" aria-pressed="${state.filter === c}"><span class="dot" style="--cc:${commColor(c)}"></span>${esc(c)} <span class="n">${countIn(c)}/${countAll(c)}</span></button>`).join("")}
      </div>
      <div class="searchrow">
        <input class="search" id="q" type="search" placeholder="Chercher un nom…" value="${esc(state.q)}" autocomplete="off" enterkeyhint="done">
        <button class="toggle" id="hide" aria-pressed="${state.hideMarked}">Cacher les présents</button>
      </div>
      <div class="keys">Clavier : <span><kbd>B</kbd> présent</span><span><kbd>H</kbd> Zoom</span><span><kbd>N</kbd> passer</span><span><kbd>↑</kbd> revenir</span><span><kbd>Suppr</kbd> effacer</span><span><kbd>/</kbd> chercher</span></div>
      ${groups.length ? groups.map(g => `
        <div class="group-title"><span class="dot" style="--cc:${commColor(g.c)}"></span>${esc(g.c)} · ${g.list.filter(isIn).length}/${countAll(g.c)}</div>
        <div class="list">${g.list.map(m => rowHtml(m, pres[m.id])).join("")}</div>`).join("")
        : `<div class="empty"><strong>${state.hideMarked && !q ? "Tout le monde est marqué" : "Personne ne correspond"}</strong>${state.hideMarked ? "Désactive « Cacher les présents » pour revoir toute la liste." : "Essaie un autre nom ou enlève le filtre."}</div>`}
      ${q && !exact ? `<button class="quickadd" id="quickadd">+ Ajouter « ${esc(state.q.trim())} » comme nouveau membre et le marquer présent</button>` : ""}
      <p class="hint">Touche un nom pour le marquer présent, touche encore pour annuler. « Zoom » marque une présence en ligne.</p>`;

    v.querySelectorAll("[data-filter]").forEach(b => b.onclick = () => { state.filter = b.dataset.filter; render(); });
    $("#hide", v).onclick = () => { state.hideMarked = !state.hideMarked; render(); };
    $("#copy", v).onclick = copySummary;
    const ti = $("#titre", v);
    ti.onchange = () => {
      const t = ti.value.trim(); seance(state.date).titre = t;
      const date = state.date;
      rpc("titrer_seance", withCode({ p_date: date, p_titre: t })).then(() => broadcast("reload", {})).catch(writeError);
    };
    const qi = $("#q", v);
    qi.oninput = () => { state.q = qi.value; const pos = qi.selectionStart; render(); const n = $("#q"); n.focus(); n.setSelectionRange(pos, pos); };
    qi.onkeydown = e => {
      if (e.key === "Enter") {
        e.preventDefault();
        if (state.order.length === 1) { const id = state.order[0]; state.q = ""; setPresence(id, "p"); toast(`${state.members.get(id).nom} : présent`); const n = $("#q"); n.focus(); }
        else qi.blur();
      } else if (e.key === "Escape") { state.q = ""; render(); }
    };
    const qa = $("#quickadd", v);
    if (qa) qa.onclick = async () => {
      const nom = state.q.trim().replace(/\s+/g, " ");
      qa.disabled = true;
      try {
        const r = await rpc("enregistrer_membre", withCode({ p_id: null, p_nom: nom, p_commission: state.filter && state.filter !== NO_COMM ? state.filter : "", p_statut: "", p_actif: true }));
        state.members.set(r.id, { id: r.id, nom, commission: state.filter && state.filter !== NO_COMM ? state.filter : "", statut: "", actif: true });
        state.q = ""; state.cursor = r.id;
        setPresence(r.id, "p");
        broadcast("reload", {});
        toast(`${nom} ajouté et marqué présent`);
      } catch (e) { writeError(e); }
    };
    v.querySelectorAll("[data-tap]").forEach(b => b.onclick = () => {
      const id = b.dataset.tap; const cur = presOf(state.date)[id];
      state.cursor = id;
      setPresence(id, cur ? null : "p");
    });
    v.querySelectorAll("[data-zoom]").forEach(b => b.onclick = () => {
      const id = b.dataset.zoom; const cur = presOf(state.date)[id];
      state.cursor = id;
      setPresence(id, cur === "z" ? "p" : "z");
    });
    if (state.scrollToCursor) { state.scrollToCursor = false; v.querySelector(".row.cur")?.scrollIntoView({ block: "nearest" }); }
  }

  function rowHtml(m, val) {
    const cls = val === "p" ? "p" : val === "z" ? "z" : "";
    const mark = val === "p" ? "✓" : val === "z" ? "Z" : "";
    const status = val === "p" ? "présent" : val === "z" ? "présent sur Zoom" : "absent";
    return `<div class="row ${cls}${m.id === state.cursor ? " cur" : ""}">
      <button class="main" data-tap="${esc(m.id)}" aria-label="${esc(m.nom)}, ${status}">
        <span class="check" aria-hidden="true">${mark}</span>
        <span class="who"><span class="name">${esc(m.nom)}</span><span class="meta">${m.statut ? `<span class="badge">${esc(m.statut)}</span>` : ""}${val === "z" ? "sur Zoom" : ""}</span></span>
      </button>
      <button class="zoombtn" data-zoom="${esc(m.id)}" aria-label="Marquer ${esc(m.nom)} présent sur Zoom">Zoom</button>
    </div>`;
  }

  function summaryText(date) {
    const p = presOf(date); const all = activeMembers();
    const inC = c => all.filter(m => commOf(m) === c && p[m.id]).length;
    const total = all.filter(m => p[m.id]).length;
    const zoom = all.filter(m => p[m.id] === "z").length;
    const titre = state.seances.get(date)?.titre;
    return `${titre ? titre + " – " : ""}${longDate(date)}\n${total} présents${zoom ? ` (dont ${zoom} sur Zoom)` : ""}\n` +
      commissions().map(c => `${c} : ${inC(c)}`).join(" · ");
  }
  async function copySummary() {
    const text = summaryText(state.date);
    try { await navigator.clipboard.writeText(text); toast("Résumé copié, colle-le dans WhatsApp"); }
    catch {
      const ta = document.createElement("textarea"); ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); toast("Résumé copié"); } catch { toast("Copie impossible sur cet appareil"); }
      ta.remove();
    }
  }

  function renderCultes(v) {
    const dates = datesWithMarks().reverse();
    const comms = commissions();
    const all = activeMembers();
    const today = iso(new Date());
    v.innerHTML = `
      <div class="toolbar">
        <button class="btn primary" id="newToday">Faire l'appel d'aujourd'hui</button>
        <button class="btn" id="export">Télécharger pour Excel (.csv)</button>
      </div>
      <h2>${dates.length} culte${dates.length > 1 ? "s" : ""} enregistré${dates.length > 1 ? "s" : ""}</h2>
      ${dates.length ? `<div class="card scroll"><table>
        <thead><tr><th>Date</th><th>Nom</th><th class="num">Total</th>${comms.map(c => `<th class="num">${esc(c)}</th>`).join("")}</tr></thead>
        <tbody>${dates.map(d => {
          const p = presOf(d);
          const inC = c => all.filter(m => commOf(m) === c && p[m.id]).length;
          return `<tr class="click" data-go="${d}"><td><strong>${shortDate(d)}</strong></td><td>${esc(state.seances.get(d)?.titre || "")}</td><td class="num"><strong>${all.filter(m => p[m.id]).length}</strong></td>${comms.map(c => `<td class="num">${inC(c)}</td>`).join("")}</tr>`;
        }).join("")}</tbody></table></div>
        <p class="hint">Touche une ligne pour ouvrir ce culte et corriger l'appel.</p>`
        : `<div class="empty"><strong>Aucun culte enregistré</strong>Fais l'appel d'aujourd'hui pour commencer.</div>`}`;
    $("#newToday", v).onclick = () => { state.date = today; setTab("appel"); };
    $("#export", v).onclick = exportCsv;
    v.querySelectorAll("[data-go]").forEach(r => r.onclick = () => { state.date = r.dataset.go; setTab("appel"); });
  }

  function renderSuivi(v) {
    const dates = datesWithMarks().reverse();
    if (!dates.length) { v.innerHTML = `<div class="empty"><strong>Pas encore d'historique</strong>Fais l'appel d'un culte pour voir le suivi.</div>`; return; }
    const last = dates.slice(0, 8);
    const members = activeMembers().filter(m => !state.suiviFilter || commOf(m) === state.suiviFilter);
    const rows = members.map(m => {
      const track = last.map(d => presOf(d)[m.id] || "");
      const present = track.filter(Boolean).length;
      let streak = 0; for (const t of track) { if (t) break; streak++; }
      return { m, track, present, streak };
    }).sort((a, b) => b.streak - a.streak || a.present - b.present || byName(a.m, b.m));
    const toCall = rows.filter(r => r.streak >= 3).length;
    v.innerHTML = `
      <h2>Qui vient, qui manque</h2>
      <div class="chips" style="margin:0 0 10px">
        <button class="chip" data-sf="" aria-pressed="${!state.suiviFilter}">Tous</button>
        ${commissions().map(c => `<button class="chip" data-sf="${esc(c)}" aria-pressed="${state.suiviFilter === c}"><span class="dot" style="--cc:${commColor(c)}"></span>${esc(c)}</button>`).join("")}
      </div>
      <div class="legend"><span><i style="background:var(--present)"></i>présent</span><span><i style="background:var(--zoom)"></i>sur Zoom</span><span><i style="background:var(--line)"></i>absent</span><span>${last.length} derniers cultes, le plus récent à gauche</span></div>
      ${toCall ? `<p class="hint" style="margin:0 4px 10px"><strong>${toCall}</strong> personne${toCall > 1 ? "s" : ""} absente${toCall > 1 ? "s" : ""} depuis 3 cultes ou plus.</p>` : ""}
      <div class="card scroll"><table>
        <thead><tr><th>Nom</th><th>Derniers cultes</th><th class="num">Présence</th><th></th></tr></thead>
        <tbody>${rows.map(r => `<tr>
          <td><span style="display:inline-flex;gap:6px;align-items:center"><span class="dot" style="--cc:${commColor(commOf(r.m))}"></span>${esc(r.m.nom)}</span></td>
          <td><span class="track">${r.track.map(t => `<i class="${t}"></i>`).join("")}</span></td>
          <td class="num">${r.present}/${last.length}</td>
          <td>${r.streak >= 3 ? `<span class="pill">absent ×${r.streak}</span>` : r.present === last.length ? `<span class="pill ok">toujours là</span>` : ""}</td>
        </tr>`).join("")}</tbody></table></div>`;
    v.querySelectorAll("[data-sf]").forEach(b => b.onclick = () => { state.suiviFilter = b.dataset.sf; render(); });
  }

  function renderMembres(v) {
    const all = [...state.members.values()].sort(byName);
    const list = all.filter(m => state.showOff || m.actif !== false);
    const off = all.length - activeMembers().length;
    v.innerHTML = `
      <div class="toolbar">
        <button class="btn primary" id="add">Ajouter un membre</button>
        <button class="btn" id="imp">Coller depuis Excel</button>
        <button class="btn" id="settings">Réglages</button>
      </div>
      <div id="impPanel"></div>
      <h2>${activeMembers().length} membres</h2>
      ${list.length ? `<div class="card">${list.map(m => `
        <div class="mrow ${m.actif === false ? "off" : ""}">
          <span class="dot" style="--cc:${commColor(commOf(m))}"></span>
          <span class="who"><span class="name">${esc(m.nom)}</span><span class="meta">${esc(commOf(m))}${m.statut ? ` · <span class="badge">${esc(m.statut)}</span>` : ""}</span></span>
          <button class="linkbtn" data-edit="${esc(m.id)}">Modifier</button>
        </div>`).join("")}</div>` : `<div class="empty"><strong>Liste vide</strong>Ajoute un membre ou colle ta liste depuis Excel.</div>`}
      ${off ? `<div class="toolbar"><button class="btn" id="toggleOff">${state.showOff ? "Cacher" : "Afficher"} les ${off} membre${off > 1 ? "s" : ""} retiré${off > 1 ? "s" : ""}</button></div>` : ""}`;
    $("#add", v).onclick = () => openEditor(null);
    $("#imp", v).onclick = openImport;
    $("#settings", v).onclick = openSettings;
    v.querySelectorAll("[data-edit]").forEach(b => b.onclick = () => openEditor(b.dataset.edit));
    const t = $("#toggleOff", v); if (t) t.onclick = () => { state.showOff = !state.showOff; render(); };
  }

  // ---------- Fenêtres ----------
  function sheet(html) {
    const host = document.createElement("div");
    host.className = "sheet-bg";
    host.innerHTML = `<form class="sheet">${html}</form>`;
    document.body.appendChild(host);
    host.addEventListener("click", e => { if (e.target === host) host.remove(); });
    return host;
  }

  function openEditor(id) {
    const m = id ? state.members.get(id) : { nom: "", commission: state.filter && state.filter !== NO_COMM ? state.filter : "", statut: "", actif: true };
    const host = sheet(`
      <h3 style="margin:0;font-family:var(--font-display)">${id ? "Modifier le membre" : "Nouveau membre"}</h3>
      <label class="f">Prénom et nom<input id="edNom" required value="${esc(m.nom)}" autocomplete="off"></label>
      <div class="row2">
        <label class="f">Commission<input id="edComm" list="commList" value="${esc(m.commission)}" placeholder="FGI, HED, Johanna…"></label>
        <label class="f">Colonne « abc »<input id="edStatut" value="${esc(m.statut)}" placeholder="ex. C" maxlength="10"></label>
      </div>
      <datalist id="commList">${commissions().filter(c => c !== NO_COMM).map(c => `<option value="${esc(c)}">`).join("")}</datalist>
      ${id ? `<label class="checkline"><input type="checkbox" id="edActif" ${m.actif !== false ? "checked" : ""}> Toujours dans la liste d'appel</label>` : ""}
      <div class="toolbar" style="margin:0">
        <button class="btn primary" type="submit">Enregistrer</button>
        <button class="btn" type="button" id="edCancel">Annuler</button>
        ${id ? `<button class="btn danger" type="button" id="edDel" style="margin-left:auto">Supprimer</button>` : ""}
      </div>`);
    const close = () => host.remove();
    $("#edCancel", host).onclick = close;
    $("#edNom", host).focus();
    const del = $("#edDel", host);
    if (del) del.onclick = async () => {
      if (!del.dataset.armed) { del.dataset.armed = "1"; del.textContent = "Confirmer : supprimer aussi son historique"; return; }
      close();
      try { await rpc("supprimer_membre", withCode({ p_id: id })); state.members.delete(id); render(); broadcast("reload", {}); toast("Membre supprimé"); } catch (e) { writeError(e); }
    };
    $("form", host).onsubmit = async e => {
      e.preventDefault();
      const data = { nom: $("#edNom", host).value.trim().replace(/\s+/g, " "), commission: $("#edComm", host).value.trim(), statut: $("#edStatut", host).value.trim(), actif: id ? $("#edActif", host).checked : true };
      if (!data.nom) return;
      close();
      try {
        const r = await rpc("enregistrer_membre", withCode({ p_id: id, p_nom: data.nom, p_commission: data.commission, p_statut: data.statut, p_actif: data.actif }));
        state.members.set(r.id, { id: r.id, ...data });
        render(); broadcast("reload", {});
        toast(id ? "Modifications enregistrées" : `${data.nom} ajouté`);
      } catch (err) { writeError(err); }
    };
  }

  function openSettings() {
    const host = sheet(`
      <h3 style="margin:0;font-family:var(--font-display)">Réglages</h3>
      <label class="f">Ton prénom (visible par les autres)<input id="sNom" value="${esc(state.nom)}" maxlength="40"></label>
      <p class="hint" style="margin:0">Changer le code de l'église : tout le monde devra entrer le nouveau code.</p>
      <label class="f">Code actuel<input id="sOld" type="password" autocomplete="current-password"></label>
      <label class="f">Nouveau code (6 caractères minimum)<input id="sNew" type="password" autocomplete="new-password"></label>
      <p class="err" id="sErr" hidden></p>
      <div class="toolbar" style="margin:0">
        <button class="btn primary" type="submit">Enregistrer</button>
        <button class="btn" type="button" id="sCancel">Fermer</button>
        <button class="btn danger" type="button" id="sOut" style="margin-left:auto">Se déconnecter</button>
      </div>`);
    $("#sCancel", host).onclick = () => host.remove();
    $("#sOut", host).onclick = () => { host.remove(); lock(""); };
    $("form", host).onsubmit = async e => {
      e.preventDefault();
      const err = $("#sErr", host); err.hidden = true;
      const nom = $("#sNom", host).value.trim();
      if (nom && nom !== state.nom) { state.nom = nom; store.set("nom", nom); lastPres = ""; pushPresence(); }
      const oldC = $("#sOld", host).value.trim(), newC = $("#sNew", host).value.trim();
      if (newC || oldC) {
        if (newC.length < 6) { err.textContent = "Le nouveau code doit faire au moins 6 caractères."; err.hidden = false; return; }
        try {
          const { data } = await sb.rpc("definir_code", { p_nouveau: newC, p_ancien: oldC });
          if (!data || data.erreur) { err.textContent = data?.erreur === "BLOQUE" ? "Trop d'essais. Réessaie dans 15 minutes." : "Code actuel incorrect."; err.hidden = false; return; }
          state.code = newC; store.set("code", newC);
          joinRealtime();
          toast("Nouveau code enregistré. Donne-le aux autres.");
        } catch { err.textContent = "Pas de connexion."; err.hidden = false; return; }
      } else toast("Enregistré");
      host.remove();
    };
  }

  function openImport() {
    const p = $("#impPanel");
    if (p.innerHTML) { p.innerHTML = ""; return; }
    p.innerHTML = `<div class="card panel">
      <h3>Coller une feuille Excel</h3>
      <p>Dans Excel, sélectionne les colonnes <strong>nom, abc, comm</strong> et, pour reprendre les présences, la colonne des <strong>p</strong>. Copie, puis colle ici. Les noms déjà connus ne sont pas recréés.</p>
      <label class="f">Date de cette feuille<input type="date" id="impDate" value="${state.date}"></label>
      <label class="checkline"><input type="checkbox" id="impPres" checked> Reprendre les présences (colonne des p)</label>
      <label class="f">Contenu collé<textarea id="impText" placeholder="Prénom Nom&#9;C&#9;Johanna&#9;p"></textarea></label>
      <p id="impPreview"></p>
      <div class="toolbar" style="margin:0"><button class="btn primary" id="impGo" disabled>Importer</button></div>
    </div>`;
    const ta = $("#impText"), prev = $("#impPreview"), go = $("#impGo");
    const idx = () => { const m = new Map(); for (const x of state.members.values()) m.set(norm(x.nom), x.id); return m; };
    const parse = () => ta.value.split(/\r?\n/).map(l => l.split("\t").map(s => s.trim())).filter(c => c[0] && norm(c[0]) !== "nom");
    ta.oninput = () => {
      const rows = parse(), ix = idx();
      const neu = rows.filter(r => !ix.has(norm(r[0]))).length;
      const pres = rows.filter(r => /^p/i.test(r[3] || "")).length;
      prev.textContent = rows.length ? `${rows.length} lignes : ${neu} nouveaux membres, ${pres} présences.` : "";
      go.disabled = !rows.length;
    };
    go.onclick = async () => {
      go.disabled = true; go.textContent = "Import en cours…";
      const ix = idx(); const withPres = $("#impPres").checked;
      const seen = new Set();
      const lignes = parse().filter(r => { const k = norm(r[0]); if (seen.has(k)) return false; seen.add(k); return true; }).map(r => ({
        id: ix.get(norm(r[0])) || null, nom: r[0].replace(/\s+/g, " "), statut: r[1] || "", commission: r[2] || "",
        pres: withPres && /^p/i.test(r[3] || "") ? (/zoom|ligne/i.test(r[3]) ? "z" : "p") : null,
      }));
      try {
        const r = await rpc("importer", withCode({ p_date: $("#impDate").value || null, p_lignes: lignes }));
        await reload(); broadcast("reload", {});
        toast(`Import terminé : ${lignes.length} lignes, ${r.crees} nouveaux membres`);
      } catch (e) { writeError(e); go.disabled = false; go.textContent = "Importer"; }
    };
  }

  function exportCsv() {
    const dates = datesWithMarks();
    const members = [...state.members.values()].sort((a, b) => (a.commission || "").localeCompare(b.commission || "", "fr") || byName(a, b));
    const cell = s => `"${String(s ?? "").replace(/"/g, '""')}"`;
    const lines = [["Nom", "abc", "Commission", ...dates.map(shortDate)].map(cell).join(";")];
    for (const m of members) lines.push([m.nom, m.statut, m.commission, ...dates.map(d => ({ p: "p", z: "p(zoom)" }[presOf(d)[m.id]] || ""))].map(cell).join(";"));
    lines.push(["Total", "", "", ...dates.map(d => Object.keys(presOf(d)).length)].map(cell).join(";"));
    const url = URL.createObjectURL(new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a"); a.href = url; a.download = `presences-${iso(new Date())}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  // ---------- Discussion ----------
  let lastSeen = Number(store.get("chatSeen")) || 0;
  const tsOf = m => new Date(m.envoye).getTime();
  function renderChatBadge() {
    const unread = state.messages.filter(m => tsOf(m) > lastSeen && m.auteur !== state.nom).length;
    const c = $("#chatCount"); c.hidden = !unread || !$("#chat").hidden; c.textContent = unread;
  }
  function renderChat() {
    const box = $("#msgs");
    box.innerHTML = state.messages.length ? state.messages.map(m => `<div class="msg ${m.auteur === state.nom ? "me" : ""}"><b>${esc(m.auteur)} · ${new Date(m.envoye).toLocaleString("fr-BE", { weekday: "short", hour: "2-digit", minute: "2-digit" })}</b>${esc(m.texte)}</div>`).join("")
      : `<p class="hint" style="margin:auto;text-align:center">Pas encore de message. Écris ici pour te coordonner pendant l'appel.</p>`;
    box.scrollTop = box.scrollHeight;
    const latest = state.messages.length ? tsOf(state.messages[state.messages.length - 1]) : 0;
    if (latest > lastSeen) { lastSeen = latest; store.set("chatSeen", String(latest)); }
    renderChatBadge();
  }
  $("#chatBtn").onclick = () => { $("#chat").hidden = false; $("#chatBtn").hidden = true; renderChat(); $("#chatInput").focus(); };
  $("#chatClose").onclick = () => { $("#chat").hidden = true; $("#chatBtn").hidden = false; renderChatBadge(); };
  $("#chatForm").onsubmit = async e => {
    e.preventDefault();
    const input = $("#chatInput"); const texte = input.value.trim().slice(0, 500);
    if (!texte) return;
    input.value = "";
    try {
      await rpc("envoyer_message", withCode({ p_auteur: state.nom, p_texte: texte }));
      const m = { auteur: state.nom, texte, envoye: new Date().toISOString() };
      state.messages.push(m); renderChat();
      broadcast("msg", m);
    } catch (err) { input.value = texte; if (err?.code !== "MAUVAIS_CODE") toast("Message non envoyé. Réessaie."); }
  };

  // ---------- Navigation et clavier ----------
  let toastTimer;
  function toast(msg) {
    const h = $("#toastHost"); h.innerHTML = `<div class="toast" role="status">${esc(msg)}</div>`;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => h.innerHTML = "", 2600);
  }
  function setTab(t) { state.tab = t; store.set("tab", t); render(); window.scrollTo(0, 0); }
  document.querySelectorAll(".tabs button").forEach(b => b.onclick = () => setTab(b.dataset.tab));
  const shift = n => { const d = parseIso(state.date); d.setDate(d.getDate() + n); state.date = iso(d); render(); };
  $("#prev").onclick = () => shift(-7);
  $("#next").onclick = () => shift(7);
  $("#datePick").onchange = e => { if (e.target.value) { state.date = e.target.value; render(); } };

  function moveCursor(step) {
    const i = state.order.indexOf(state.cursor);
    const j = i + step;
    if (j >= state.order.length) { toast("Fin de la liste"); return; }
    if (j < 0) return;
    state.cursor = state.order[j];
  }
  document.addEventListener("keydown", e => {
    if ($("#app").hidden || state.tab !== "appel" || !state.order.length) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (document.querySelector(".sheet-bg") || !$("#chat").hidden) return;
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT")) return;
    const k = e.key.toLowerCase();
    const id = state.cursor;
    if (k === "b" || k === "h") {
      e.preventDefault();
      // Avec « Cacher les présents », la personne disparaît : le cadre passe au suivant d'abord.
      moveCursor(1); state.scrollToCursor = true;
      setPresence(id, k === "b" ? "p" : "z");
    } else if (k === "n" || e.key === "ArrowDown") { e.preventDefault(); moveCursor(1); state.scrollToCursor = true; render(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); moveCursor(-1); state.scrollToCursor = true; render(); }
    else if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); state.scrollToCursor = true; setPresence(id, null); }
    else if (e.key === "/") { e.preventDefault(); $("#q")?.focus(); }
  });

  // Quand on revient sur l'onglet après un moment, on recharge pour rattraper ce qu'on aurait manqué.
  let hiddenAt = 0;
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { hiddenAt = Date.now(); return; }
    if (state.code && Date.now() - hiddenAt > 30000) reload().catch(() => {});
  });

  // ---------- Démarrage ----------
  if (!state.code || !state.nom) showGate("");
  else {
    rpc("charger", withCode()).then(data => { applyLoad(data); start(); })
      .catch(e => {
        if (e.code === "RESEAU") showGate("Pas de connexion. Vérifie internet et réessaie.");
        else if (e.code === "BLOQUE") showGate("Trop d'essais. Réessaie dans 15 minutes.");
        else { state.code = null; store.set("code", null); showGate("Le code a changé. Entre le nouveau code."); }
      });
  }
})();
