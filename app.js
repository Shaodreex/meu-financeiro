(() => {
  'use strict';

  const STORAGE_KEY = 'meuFinanceiroStateV1';
  const DIRTY_KEY = 'meuFinanceiroCloudDirtyV1';
  const THEME_KEY = 'meuFinanceiroThemeV1';
  const uid = () => (crypto?.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const money = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
  const shortDate = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit' });

  const DEFAULT_BENEFITS = {
    food: { id: 'food', label: 'Vale Alimentação', payment: 'Vale Alimentação', monthlyCredit: 1086.40, baseBalance: 3.02, baseMonth: '2026-08', nextCreditMonth: '2026-09', creditDay: 1, _updatedAt: 0 },
    fuel: { id: 'fuel', label: 'Vale Combustível', payment: 'Vale Combustível', monthlyCredit: 300.00, baseBalance: 8.88, baseMonth: '2026-08', nextCreditMonth: '2026-09', creditDay: 1, _updatedAt: 0 }
  };

  const DEFAULT_STATE = {
    version: 1,
    categories: ['Moradia','Alimentação','Transporte','Saúde','Educação','Lazer','Assinaturas','Compras','Impostos e taxas','Dívidas','Investimentos','Outros'],
    accounts: [],
    transactions: [],
    recurring: [],
    cards: [],
    cardPayments: [],
    benefits: {
      food: { ...DEFAULT_BENEFITS.food },
      fuel: { ...DEFAULT_BENEFITS.fuel }
    },
    syncMeta: { tombstones: { accounts: [], transactions: [], recurring: [], cards: [], cardPayments: [] } }
  };

  let state = loadState();
  let deferredInstallPrompt = null;
  let cloudClient = null;
  let cloudUser = null;
  let cloudDirty = localStorage.getItem(DIRTY_KEY) === '1';
  let cloudPushTimer = null;
  let cloudSyncing = false;
  let syncRequested = false;
  const CLOUD_TIMEOUT_MS = 12000;
  let lastCloudUpdatedAt = null;
  let cloudRevision = null;
  let lastSyncError = '';
  let cloudPollTimer = null;
  let localRevision = 0;
  let pendingPaymentAction = null;
  const systemThemeQuery = window.matchMedia('(prefers-color-scheme: dark)');
  let themeMode = loadThemeMode();

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  const els = {
    sidebar: $('#sidebar'), pageTitle: $('#pageTitle'), monthFilter: $('#monthFilter'),
    availableBalance: $('#availableBalance'), monthIncome: $('#monthIncome'), monthExpense: $('#monthExpense'),
    monthPending: $('#monthPending'), monthBalance: $('#monthBalance'), incomeCount: $('#incomeCount'),
    plannedExpenseTotal: $('#plannedExpenseTotal'), paidExpenseTotal: $('#paidExpenseTotal'), pendingExpenseDash: $('#pendingExpenseDash'),
    expenseCommitment: $('#expenseCommitment'), expenseProgressBar: $('#expenseProgressBar'),
    expenseCount: $('#expenseCount'), pendingCount: $('#pendingCount'), pendingList: $('#pendingList'),
    recentTransactions: $('#recentTransactions'), categoryChart: $('#categoryChart'), emptyChart: $('#emptyChart'),
    transactionsTable: $('#transactionsTable'), transactionsEmpty: $('#transactionsEmpty'),
    transactionSearch: $('#transactionSearch'), typeFilter: $('#typeFilter'), statusFilter: $('#statusFilter'),
    recurringGrid: $('#recurringGrid'), recurringEmpty: $('#recurringEmpty'),
    cardsGrid: $('#cardsGrid'), cardsEmpty: $('#cardsEmpty'), invoiceList: $('#invoiceList'),
    accountsGrid: $('#accountsGrid'), accountsTotal: $('#accountsTotal'),
    foodVoucherBalance: $('#foodVoucherBalance'), foodVoucherMonthly: $('#foodVoucherMonthly'), foodVoucherSpent: $('#foodVoucherSpent'), foodVoucherCount: $('#foodVoucherCount'), foodVoucherNext: $('#foodVoucherNext'),
    fuelVoucherBalance: $('#fuelVoucherBalance'), fuelVoucherMonthly: $('#fuelVoucherMonthly'), fuelVoucherSpent: $('#fuelVoucherSpent'), fuelVoucherCount: $('#fuelVoucherCount'), fuelVoucherNext: $('#fuelVoucherNext'),
    categoryTags: $('#categoryTags'),
    transactionModal: $('#transactionModal'), quickExpenseModal: $('#quickExpenseModal'), recurringModal: $('#recurringModal'), cardModal: $('#cardModal'), accountModal: $('#accountModal'),
    paymentSourceModal: $('#paymentSourceModal'), iosInstallModal: $('#iosInstallModal'),
    modalBackdrop: $('#modalBackdrop'), toast: $('#toast'),
    authGate: $('#authGate'), authMessage: $('#authMessage'), syncStatusText: $('#syncStatusText'),
    cloudUser: $('#cloudUser'), cloudUserEmail: $('#cloudUserEmail'), cloudAccountText: $('#cloudAccountText')
  };

  applyTheme(themeMode, false, false);
  init();
  document.documentElement.setAttribute('data-mf-boot', 'ok');

  function init() {
    els.monthFilter.value = currentMonth();
    bindNavigation();
    bindModals();
    bindActions();
    bindThemeUi();
    repairFarFutureRecurringTransactions(false);
    // Quando há Supabase configurado, espere a carga inicial da nuvem antes de
    // normalizar faturas ou gerar recorrências. Isso evita alterar estado local
    // enquanto o bootstrap ainda está trazendo a versão remota.
    if (!isCloudConfigured()) {
      repairCreditInvoiceCompetence(false);
      ensureRecurringForMonth(currentMonth(), true);
    }
    renderAll();
    registerPwa();
    bindCloudUi();
    initCloud();
  }

  function clone(obj) { return JSON.parse(JSON.stringify(obj)); }
  const SYNC_COLLECTIONS = ['accounts','transactions','recurring','cards','cardPayments'];
  function nowStamp() { return Date.now(); }
  function normalizeTombstones(base) {
    const src = base?.syncMeta?.tombstones || {};
    const out = {};
    SYNC_COLLECTIONS.forEach(kind => {
      out[kind] = Array.isArray(src[kind])
        ? src[kind].filter(x => x && x.id).map(x => ({ id: String(x.id), deletedAt: Number(x.deletedAt || 0) }))
        : [];
    });
    return out;
  }
  function normalizeState(candidate) {
    const base = (!candidate || candidate.version !== 1) ? clone(DEFAULT_STATE) : candidate;
    const withMeta = item => ({ ...item, _updatedAt: Number(item?._updatedAt || 0) });
    const normalizedRecurring = Array.isArray(base.recurring) ? base.recurring.map(r => withMeta({
      ...r,
      kind: r.kind || (r.type === 'income' ? 'income' : (r.category === 'Assinaturas' ? 'subscription' : 'fixed')),
      provider: r.provider || '',
      cardId: r.cardId || null,
      autoGenerate: r.autoGenerate !== false
    })) : [];
    const normalizedTransactions = Array.isArray(base.transactions) ? base.transactions.map(t => withMeta({
      ...t,
      cardId: t.cardId || null,
      invoiceMonth: t.invoiceMonth || null,
      purchaseDate: t.purchaseDate || null,
      installmentGroupId: t.installmentGroupId || null,
      installmentNumber: Number(t.installmentNumber || 0),
      installmentTotal: Number(t.installmentTotal || 0)
    })) : [];
    const normalizedPayments = Array.isArray(base.cardPayments) ? base.cardPayments.map(p => withMeta({
      ...p,
      id: p.id || `${p.cardId}:${p.month}`,
      paid: Boolean(p.paid)
    })) : [];
    const benefitSource = base.benefits || {};
    const normalizedBenefits = {};
    ['food','fuel'].forEach(key => {
      const def = DEFAULT_BENEFITS[key];
      const src = benefitSource[key] || {};
      normalizedBenefits[key] = {
        ...def,
        ...src,
        id: key,
        label: def.label,
        payment: def.payment,
        monthlyCredit: Number(src.monthlyCredit ?? def.monthlyCredit),
        baseBalance: Number(src.baseBalance ?? def.baseBalance),
        baseMonth: src.baseMonth || def.baseMonth,
        nextCreditMonth: src.nextCreditMonth || def.nextCreditMonth,
        creditDay: Math.min(28, Math.max(1, Number(src.creditDay || def.creditDay || 1))),
        _updatedAt: Number(src._updatedAt || 0)
      };
    });
    return {
      version: 1,
      categories: Array.isArray(base.categories) && base.categories.length ? base.categories : clone(DEFAULT_STATE.categories),
      accounts: Array.isArray(base.accounts) ? base.accounts.map(withMeta) : [],
      transactions: normalizedTransactions,
      recurring: normalizedRecurring,
      cards: Array.isArray(base.cards) ? base.cards.map(withMeta) : [],
      cardPayments: normalizedPayments,
      benefits: normalizedBenefits,
      syncMeta: { tombstones: normalizeTombstones(base) }
    };
  }
  function entityId(kind, item) {
    if (!item) return '';
    return String(item.id || (kind === 'cardPayments' ? `${item.cardId}:${item.month}` : ''));
  }
  function touchEntity(item) {
    return { ...item, _updatedAt: nowStamp() };
  }
  function markDeleted(kind, id) {
    if (!id || !SYNC_COLLECTIONS.includes(kind)) return;
    const list = state.syncMeta?.tombstones?.[kind] || (state.syncMeta.tombstones[kind] = []);
    const stamp = nowStamp();
    const existing = list.find(x => x.id === String(id));
    if (existing) existing.deletedAt = Math.max(existing.deletedAt || 0, stamp);
    else list.push({ id: String(id), deletedAt: stamp });
  }
  function mergedTombstones(localList=[], remoteList=[]) {
    const map = new Map();
    [...remoteList, ...localList].forEach(x => {
      if (!x?.id) return;
      const id = String(x.id), ts = Number(x.deletedAt || 0);
      if (!map.has(id) || ts > map.get(id).deletedAt) map.set(id, { id, deletedAt: ts });
    });
    // Keep tombstones for 180 days; this is enough to prevent stale devices from resurrecting deletions.
    const cutoff = Date.now() - 180 * 24 * 60 * 60 * 1000;
    return [...map.values()].filter(x => x.deletedAt >= cutoff || x.deletedAt === 0);
  }
  function mergeEntityCollection(kind, localArr, remoteArr, tombstones, prefer='remote') {
    const localMap = new Map((localArr || []).map(x => [entityId(kind,x), x]).filter(([id]) => id));
    const remoteMap = new Map((remoteArr || []).map(x => [entityId(kind,x), x]).filter(([id]) => id));
    const tombMap = new Map((tombstones || []).map(x => [String(x.id), Number(x.deletedAt || 0)]));
    const ids = new Set([...localMap.keys(), ...remoteMap.keys()]);
    const out = [];
    ids.forEach(id => {
      const l = localMap.get(id), r = remoteMap.get(id);
      let chosen;
      if (!l) chosen = r;
      else if (!r) chosen = l;
      else {
        const lt = Number(l._updatedAt || 0), rt = Number(r._updatedAt || 0);
        if (lt > rt) chosen = l;
        else if (rt > lt) chosen = r;
        else chosen = prefer === 'local' ? l : r;
      }
      if (!chosen) return;
      const deletedAt = tombMap.get(id) || 0;
      if (deletedAt >= Number(chosen._updatedAt || 0) && deletedAt > 0) return;
      out.push(chosen);
    });
    return out;
  }
  function mergeStates(localCandidate, remoteCandidate, prefer='remote') {
    const local = normalizeState(localCandidate);
    const remote = normalizeState(remoteCandidate);
    const tombstones = {};
    SYNC_COLLECTIONS.forEach(kind => {
      tombstones[kind] = mergedTombstones(local.syncMeta.tombstones[kind], remote.syncMeta.tombstones[kind]);
    });
    const merged = {
      version: 1,
      categories: [...new Set([...(remote.categories || []), ...(local.categories || [])])].sort((a,b)=>a.localeCompare(b,'pt-BR')),
      syncMeta: { tombstones }
    };
    SYNC_COLLECTIONS.forEach(kind => {
      merged[kind] = mergeEntityCollection(kind, local[kind], remote[kind], tombstones[kind], prefer);
    });
    merged.benefits = {};
    ['food','fuel'].forEach(key => {
      const l = local.benefits?.[key] || DEFAULT_BENEFITS[key];
      const r = remote.benefits?.[key] || DEFAULT_BENEFITS[key];
      const lt = Number(l._updatedAt || 0), rt = Number(r._updatedAt || 0);
      merged.benefits[key] = lt > rt ? l : (rt > lt ? r : (prefer === 'local' ? l : r));
    });
    return normalizeState(merged);
  }
  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return clone(DEFAULT_STATE);
      return normalizeState(JSON.parse(raw));
    } catch { return clone(DEFAULT_STATE); }
  }
  function saveLocalState() { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
  function setCloudDirty(value) {
    cloudDirty = Boolean(value);
    if (cloudDirty) localStorage.setItem(DIRTY_KEY, '1');
    else localStorage.removeItem(DIRTY_KEY);
  }
  function saveState() {
    localRevision += 1;
    saveLocalState();
    setCloudDirty(true);
    scheduleCloudPush();
  }

  function loadThemeMode() {
    try {
      const stored = localStorage.getItem(THEME_KEY);
      return ['light','dark','system'].includes(stored) ? stored : 'system';
    } catch { return 'system'; }
  }
  function effectiveTheme(mode = themeMode) {
    return mode === 'system' ? (systemThemeQuery.matches ? 'dark' : 'light') : mode;
  }
  function applyTheme(mode, persist = true, redrawChart = true) {
    themeMode = ['light','dark','system'].includes(mode) ? mode : 'system';
    const effective = effectiveTheme(themeMode);
    document.documentElement.dataset.theme = effective;
    document.documentElement.dataset.themeMode = themeMode;
    document.documentElement.style.colorScheme = effective;
    const metaTheme = document.querySelector('meta[name="theme-color"]');
    if (metaTheme) metaTheme.setAttribute('content', effective === 'dark' ? '#0b1220' : '#f3f5f8');
    if (persist) {
      try { localStorage.setItem(THEME_KEY, themeMode); } catch {}
    }
    renderThemeControls();
    if (redrawChart && els.monthFilter?.value && $('#dashboard')?.classList.contains('active')) {
      requestAnimationFrame(() => drawCategoryChart(dashboardTransactions().filter(t => t.type === 'expense')));
    }
  }
  function renderThemeControls() {
    $$('[data-theme-mode]').forEach(button => {
      const active = button.dataset.themeMode === themeMode;
      button.dataset.active = active ? 'true' : 'false';
      button.setAttribute('aria-checked', active ? 'true' : 'false');
    });
  }
  function bindThemeUi() {
    // Restrinja os listeners de tema exclusivamente ao card de Aparência.
    // Isso evita que botões dinâmicos de outras telas possam ser interpretados
    // como seletores de tema em navegadores móveis.
    $$('.appearance-card [data-theme-mode]').forEach(button => button.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      applyTheme(button.dataset.themeMode);
      const labels = { light:'Modo claro ativado.', dark:'Modo escuro ativado.', system:'Tema automático ativado.' };
      toast(labels[button.dataset.themeMode] || 'Tema atualizado.');
    }));
    const onSystemThemeChange = () => { if (themeMode === 'system') applyTheme('system', false); };
    if (systemThemeQuery.addEventListener) systemThemeQuery.addEventListener('change', onSystemThemeChange);
    else if (systemThemeQuery.addListener) systemThemeQuery.addListener(onSystemThemeChange);
  }

  function currentMonth() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
  }
  function todayDateStr() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  }
  function monthOf(dateStr) { return (dateStr || '').slice(0,7); }
  function parseAmount(value) {
    if (typeof value === 'number') return value;
    let s = String(value || '').trim().replace(/R\$\s?/g,'').replace(/\s/g,'');
    if (s.includes(',') && s.includes('.')) s = s.replace(/\./g,'').replace(',','.');
    else if (s.includes(',')) s = s.replace(',','.');
    const n = Number(s);
    return Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN;
  }
  function formatInputAmount(n) { return Number(n || 0).toFixed(2).replace('.',','); }
  function formatDate(dateStr) {
    if (!dateStr) return '—';
    const [y,m,d] = dateStr.split('-').map(Number);
    return shortDate.format(new Date(y,m-1,d));
  }
  function selectedMonth() { return els.monthFilter.value || currentMonth(); }
  function monthLabel(m) {
    const [y,mo] = m.split('-').map(Number);
    return new Intl.DateTimeFormat('pt-BR',{month:'long',year:'numeric'}).format(new Date(y,mo-1,1));
  }
  function shiftMonth(month, offset) {
    const [y,m] = month.split('-').map(Number);
    const d = new Date(y, m - 1 + offset, 1);
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
  }
  function addMonthsToDate(dateStr, offset) {
    if (!dateStr) return '';
    const [y,m,d] = dateStr.split('-').map(Number);
    const target = new Date(y, m - 1 + offset, 1);
    const last = new Date(target.getFullYear(), target.getMonth()+1, 0).getDate();
    return `${target.getFullYear()}-${String(target.getMonth()+1).padStart(2,'0')}-${String(Math.min(d,last)).padStart(2,'0')}`;
  }
  function monthIndex(month) {
    if (!month) return 0;
    const [y,m] = month.split('-').map(Number);
    return y * 12 + (m - 1);
  }
  function isBenefitPayment(payment) { return payment === 'Vale Alimentação' || payment === 'Vale Combustível'; }
  function benefitKeyFromPayment(payment) { return payment === 'Vale Alimentação' ? 'food' : (payment === 'Vale Combustível' ? 'fuel' : null); }
  function benefitByKey(key) { return state.benefits?.[key] || DEFAULT_BENEFITS[key] || null; }
  function benefitCreditCountUntil(key, dateStr = todayDateStr()) {
    const benefit = benefitByKey(key);
    if (!benefit || !dateStr) return 0;
    const targetMonth = monthOf(dateStr);
    const start = benefit.nextCreditMonth || shiftMonth(benefit.baseMonth || currentMonth(), 1);
    let count = monthIndex(targetMonth) - monthIndex(start) + 1;
    if (count <= 0) return 0;
    const day = Number(dateStr.slice(8,10) || 1);
    if (day < Number(benefit.creditDay || 1)) count -= 1;
    return Math.max(0, count);
  }
  function benefitTrackedSpend(key, dateLimit = todayDateStr()) {
    const benefit = benefitByKey(key);
    if (!benefit) return 0;
    return sum(state.transactions
      .filter(t => t.type === 'expense' && t.payment === benefit.payment && t.benefitTracked === true && (!dateLimit || t.date <= dateLimit))
      .map(t => t.amount));
  }
  function benefitCurrentBalance(key, dateStr = todayDateStr()) {
    const benefit = benefitByKey(key);
    if (!benefit) return 0;
    const credits = benefitCreditCountUntil(key, dateStr) * Number(benefit.monthlyCredit || 0);
    return Math.round((Number(benefit.baseBalance || 0) + credits - benefitTrackedSpend(key, dateStr)) * 100) / 100;
  }
  function benefitNextCreditDate(key, dateStr = todayDateStr()) {
    const benefit = benefitByKey(key);
    if (!benefit) return '';
    const todayMonth = monthOf(dateStr);
    const todayDay = Number(dateStr.slice(8,10) || 1);
    let targetMonth = benefit.nextCreditMonth || shiftMonth(benefit.baseMonth || currentMonth(), 1);
    if (monthIndex(todayMonth) > monthIndex(targetMonth)) targetMonth = todayMonth;
    if (monthIndex(todayMonth) === monthIndex(targetMonth) && todayDay >= Number(benefit.creditDay || 1)) targetMonth = shiftMonth(todayMonth, 1);
    const [y,m] = targetMonth.split('-').map(Number);
    const last = new Date(y,m,0).getDate();
    const day = Math.min(Number(benefit.creditDay || 1), last);
    return `${targetMonth}-${String(day).padStart(2,'0')}`;
  }
  function cardById(id) { return state.cards.find(c => c.id === id) || null; }
  function invoiceMonthFor(card, dateStr, preferredDueDate = '') {
    // No Meu Financeiro, a fatura é identificada pela COMPETÊNCIA da compra,
    // e não pelo mês em que ela será paga. Ex.: compra em 27/08 pertence à
    // fatura agosto, ainda que o vencimento automático seja 10/09.
    return monthOf(dateStr);
  }
  function transactionInvoiceMonth(t) {
    if (!t) return '';
    // A data do lançamento/parcela define a competência. Isso também corrige
    // registros criados por versões antigas que gravavam o mês do vencimento.
    if (t.cardId && t.date) return monthOf(t.date);
    return t.invoiceMonth || monthOf(t.date);
  }
  function invoiceDueDate(card, invoiceMonth) {
    if (!card || !invoiceMonth) return '';
    // A fatura da competência selecionada é paga no mês seguinte, no dia de
    // vencimento configurado no cartão. Ex.: fatura agosto -> vence em setembro.
    const paymentMonth = shiftMonth(invoiceMonth, 1);
    const [y,m] = paymentMonth.split('-').map(Number);
    const last = new Date(y,m,0).getDate();
    return `${paymentMonth}-${String(Math.min(Number(card.dueDay || 1), last)).padStart(2,'0')}`;
  }
  function repairCreditInvoiceCompetence(persist=true) {
    let changed = 0;
    state.transactions.forEach(t => {
      if (t?.type !== 'expense' || !t.cardId || !t.date) return;
      const card = cardById(t.cardId);
      if (!card) return;
      const oldMonth = t.invoiceMonth || monthOf(t.date);
      const correctMonth = monthOf(t.date);
      // Histórico já quitado não é alterado automaticamente.
      if (invoicePaid(t.cardId, oldMonth) || invoicePaid(t.cardId, correctMonth)) return;
      const correctDue = invoiceDueDate(card, correctMonth);
      const dueDay = t.dueDate ? Number(String(t.dueDate).slice(8,10)) : 0;
      const looksAutoDue = !t.dueDate || Boolean(t.recurringId) || dueDay === Number(card.dueDay || 1);
      let itemChanged = false;
      if (t.invoiceMonth !== correctMonth) { t.invoiceMonth = correctMonth; itemChanged = true; }
      if (looksAutoDue && t.dueDate !== correctDue) { t.dueDate = correctDue; itemChanged = true; }
      if (itemChanged) { t._updatedAt = nowStamp(); changed++; }
    });
    if (changed && persist) saveState();
    return changed;
  }
  function invoiceTransactions(cardId, month) {
    return state.transactions.filter(t => t.type === 'expense' && t.cardId === cardId && transactionInvoiceMonth(t) === month);
  }
  function invoicePaid(cardId, month) {
    return state.cardPayments.some(p => p.cardId === cardId && p.month === month && p.paid);
  }
  function effectiveTransactionStatus(t) {
    if (t?.type === 'expense' && t.cardId) {
      // Compras no crédito são quitadas financeiramente quando a fatura é paga.
      // Isso evita baixar o mesmo valor duas vezes dos Recursos.
      const inv = transactionInvoiceMonth(t);
      return invoicePaid(t.cardId, inv) ? 'paid' : 'pending';
    }
    return t?.status || 'pending';
  }
  function cardUsedLimit(cardId) {
    const today = todayDateStr();
    return sum(state.transactions
      .filter(t => t.type === 'expense' && t.cardId === cardId)
      // Parcelas futuras comprometem o limite desde a data da compra; cobranças
      // recorrentes futuras só passam a comprometer quando a data chegar.
      .filter(t => (t.purchaseDate || t.date || today) <= today)
      .filter(t => !invoicePaid(cardId, transactionInvoiceMonth(t)))
      .map(t => t.amount));
  }
  function cardAvailableLimit(cardId) {
    const card = cardById(cardId);
    if (!card) return 0;
    return Math.max(0, Number(card.limit || 0) - cardUsedLimit(cardId));
  }
  function splitAmount(total, count) {
    const cents = Math.round(Number(total) * 100);
    const base = Math.floor(cents / count);
    let remainder = cents - base * count;
    return Array.from({length:count}, () => {
      const value = base + (remainder-- > 0 ? 1 : 0);
      return value / 100;
    });
  }
  function escapeHtml(s='') { return String(s).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }

  function bindNavigation() {
    $$('.nav-item').forEach(btn => btn.addEventListener('click', () => showView(btn.dataset.view)));
    $$('[data-go]').forEach(btn => btn.addEventListener('click', () => showView(btn.dataset.go)));
    $('#menuBtn').addEventListener('click', () => els.sidebar.classList.toggle('open'));
    document.addEventListener('click', e => {
      if (window.innerWidth <= 760 && els.sidebar.classList.contains('open') && !els.sidebar.contains(e.target) && e.target.id !== 'menuBtn') els.sidebar.classList.remove('open');
    });
    els.monthFilter.addEventListener('change', () => {
      // Trocar o mês do filtro deve apenas navegar. A versão anterior gerava
      // recorrências ao navegar e podia criar lançamentos em anos futuros.
      if (selectedMonth() === currentMonth()) ensureRecurringForMonth(currentMonth(), true);
      renderAll();
    });
  }
  function showView(view) {
    const titles = { dashboard:'Visão geral', transactions:'Lançamentos', recurring:'Fixos e assinaturas', cards:'Cartões e faturas', accounts:'Recursos', settings:'Configurações' };
    $$('.view').forEach(v => v.classList.toggle('active', v.id === view));
    $$('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.view === view));
    els.pageTitle.textContent = titles[view] || 'Meu Financeiro';
    els.sidebar.classList.remove('open');
    if (view === 'transactions') renderTransactions();
    if (view === 'recurring') renderRecurring();
    if (view === 'cards') renderCards();
    if (view === 'accounts') renderAccounts();
    if (view === 'settings') renderSettings();
  }

  function bindActions() {
    $('#quickAddBtn').addEventListener('click', () => openTransaction());
    $('#mobileQuickExpenseBtn')?.addEventListener('click', openQuickExpense);
    $('#quickExpenseForm')?.addEventListener('submit', saveQuickExpense);
    $('#quickExpensePayment')?.addEventListener('change', updateQuickExpenseFields);
    $('#quickExpenseCard')?.addEventListener('change', updateQuickExpenseFields);
    $('#transactionSearch').addEventListener('input', renderTransactions);
    $('#typeFilter').addEventListener('change', renderTransactions);
    $('#statusFilter').addEventListener('change', renderTransactions);
    $('#exportCsvBtn').addEventListener('click', exportCsv);
    $('#addRecurringBtn').addEventListener('click', () => openRecurring());
    $('#generateRecurringBtn').addEventListener('click', generateRecurringForMonth);
    $('#addCardBtn').addEventListener('click', () => openCard());
    $('#addAccountBtn').addEventListener('click', () => openAccount());
    $('#categoryForm').addEventListener('submit', addCategory);
    $('#backupBtn').addEventListener('click', downloadBackup);
    $('#restoreInput').addEventListener('change', restoreBackup);
    $('#resetBtn').addEventListener('click', resetData);

    $('#transactionForm').addEventListener('submit', saveTransaction);
    $('#recurringForm').addEventListener('submit', saveRecurring);
    $('#cardForm').addEventListener('submit', saveCard);
    $('#accountForm').addEventListener('submit', saveAccount);
    $('#paymentSourceForm').addEventListener('submit', confirmPaymentSource);
    $('#paymentSourceAccount').addEventListener('change', updatePaymentSourceBalance);
    $('#txPayment').addEventListener('change', updateTransactionCreditFields);
    $('#txCard').addEventListener('change', () => updateTransactionCreditDueDate(true));
    $('#txDate').addEventListener('change', () => updateTransactionCreditDueDate(true));
    $('#txDueDate').addEventListener('input', () => { delete $('#txDueDate').dataset.creditAuto; });
    $('#txStatus').addEventListener('change', updateTransactionResourceFields);
    $$('input[name="txType"]').forEach(node => node.addEventListener('change', updateTransactionCreditFields));
    $('#recPayment').addEventListener('change', updateRecurringCreditFields);
    $('#recKind').addEventListener('change', () => {
      if ($('#recKind').value === 'income') $('#recType').value = 'income';
      else if ($('#recType').value === 'income') $('#recType').value = 'expense';
    });
  }

  function bindModals() {
    $$('.close-modal').forEach(b => b.addEventListener('click', () => closeDialog(els.transactionModal)));
    $$('.close-quick-expense').forEach(b => b.addEventListener('click', () => closeDialog(els.quickExpenseModal)));
    $$('.close-recurring').forEach(b => b.addEventListener('click', () => closeDialog(els.recurringModal)));
    $$('.close-account').forEach(b => b.addEventListener('click', () => closeDialog(els.accountModal)));
    $$('.close-card').forEach(b => b.addEventListener('click', () => closeDialog(els.cardModal)));
    $$('.close-payment-source').forEach(b => b.addEventListener('click', () => { pendingPaymentAction = null; closeDialog(els.paymentSourceModal); }));
    els.modalBackdrop.addEventListener('click', closeAllDialogs);
    [els.transactionModal, els.quickExpenseModal, els.recurringModal, els.cardModal, els.accountModal, els.paymentSourceModal, els.iosInstallModal].filter(Boolean).forEach(d => d.addEventListener('close', updateBackdrop));
    $$('.close-ios-install').forEach(b => b.addEventListener('click', () => closeDialog(els.iosInstallModal)));
  }
  function showDialog(d) { els.modalBackdrop.classList.remove('hidden'); if (!d.open) d.showModal(); }
  function closeDialog(d) { if (d.open) d.close(); updateBackdrop(); }
  function closeAllDialogs() { pendingPaymentAction = null; [els.transactionModal, els.quickExpenseModal, els.recurringModal, els.cardModal, els.accountModal, els.paymentSourceModal, els.iosInstallModal].filter(Boolean).forEach(d => { if (d.open) d.close(); }); updateBackdrop(); }
  function updateBackdrop() { if (![els.transactionModal,els.quickExpenseModal,els.recurringModal,els.cardModal,els.accountModal,els.paymentSourceModal,els.iosInstallModal].filter(Boolean).some(d => d.open)) els.modalBackdrop.classList.add('hidden'); }

  function renderAll() {
    renderDashboard(); renderTransactions(); renderRecurring(); renderCards(); renderAccounts(); renderSettings(); populateCategorySelects(); populateCardSelects(); updateTransactionResourceFields();
  }

  function dashboardTransactions() { return state.transactions.filter(t => monthOf(t.date) === selectedMonth()); }
  function renderDashboard() {
    const tx = dashboardTransactions();
    const incomes = tx.filter(t => t.type === 'income');
    const receivedIncome = incomes.filter(t => effectiveTransactionStatus(t) === 'paid');
    const expenses = tx.filter(t => t.type === 'expense');
    const paidExpenses = expenses.filter(t => effectiveTransactionStatus(t) === 'paid');
    const pendingExpenses = expenses.filter(t => effectiveTransactionStatus(t) === 'pending');
    const pendingCashExpenses = pendingExpenses.filter(t => !isBenefitPayment(t.payment));

    const incomeTotal = sum(receivedIncome.map(t=>t.amount));
    const expenseTotal = sum(expenses.map(t=>t.amount));
    const paidExpenseTotal = sum(paidExpenses.map(t=>t.amount));
    const pendingExpenseTotal = sum(pendingCashExpenses.map(t=>t.amount));
    const resourcesTotal = sum(state.accounts.map(a => a.balance));

    // Planejamento financeiro baseado na posição real informada em Recursos.
    // O saldo disponível representa quanto ainda pode ser comprometido:
    // recursos atuais - despesas que ainda estão pendentes no mês selecionado.
    // Despesas já pagas não são subtraídas novamente, pois a posição de Recursos
    // deve refletir o saldo atual informado pelo usuário.
    const available = resourcesTotal - pendingExpenseTotal;
    const plannedResult = available;
    const commitment = resourcesTotal > 0
      ? Math.max(0, (pendingExpenseTotal / resourcesTotal) * 100)
      : (pendingExpenseTotal > 0 ? 100 : 0);

    els.availableBalance.textContent = money.format(available);
    els.monthIncome.textContent = money.format(resourcesTotal);
    els.monthExpense.textContent = money.format(expenseTotal);
    els.monthPending.textContent = money.format(pendingExpenseTotal);
    els.monthBalance.textContent = `Saldo após pendências ${money.format(plannedResult)}`;
    els.incomeCount.textContent = `${state.accounts.length} ${state.accounts.length === 1 ? 'recurso cadastrado' : 'recursos cadastrados'}`;
    els.expenseCount.textContent = `${expenses.length} ${expenses.length === 1 ? 'despesa' : 'despesas'} no mês`;
    els.pendingCount.textContent = `${pendingCashExpenses.length} ${pendingCashExpenses.length === 1 ? 'conta pendente' : 'contas pendentes'}`;

    if (els.plannedExpenseTotal) els.plannedExpenseTotal.textContent = money.format(expenseTotal);
    if (els.paidExpenseTotal) els.paidExpenseTotal.textContent = money.format(paidExpenseTotal);
    if (els.pendingExpenseDash) els.pendingExpenseDash.textContent = money.format(pendingExpenseTotal);
    if (els.expenseCommitment) els.expenseCommitment.textContent = `${commitment.toFixed(0)}% dos recursos`;
    if (els.expenseProgressBar) els.expenseProgressBar.style.width = `${Math.min(commitment,100)}%`;

    renderPending(pendingCashExpenses);
    renderRecent();
    drawCategoryChart(expenses);
  }
  function sum(values) { return values.reduce((a,b)=>a+Number(b||0),0); }

  function renderPending(pending) {
    const sorted = [...pending].sort((a,b) => (a.dueDate || '9999').localeCompare(b.dueDate || '9999')).slice(0,5);
    if (!sorted.length) { els.pendingList.innerHTML = '<div class="empty-state"><strong>Nenhuma pendência neste mês.</strong><span>Ótimo: tudo em dia por aqui.</span></div>'; return; }
    els.pendingList.innerHTML = sorted.map(t => `<div class="compact-item"><div><strong>${escapeHtml(t.description)}</strong><span>${escapeHtml(t.category)}${t.dueDate ? ` • vence ${formatDate(t.dueDate)}` : ''}</span></div><strong>${money.format(t.amount)}</strong></div>`).join('');
  }
  function renderRecent() {
    const list = [...state.transactions].sort((a,b) => b.date.localeCompare(a.date)).slice(0,6);
    if (!list.length) { els.recentTransactions.innerHTML = '<div class="empty-state"><strong>Nenhuma movimentação.</strong><span>Seus lançamentos mais recentes aparecerão aqui.</span></div>'; return; }
    els.recentTransactions.innerHTML = list.map(t => {
      const card=cardById(t.cardId);
      const resource=accountById(t.resourceAccountId);
      const paymentLabel=`${t.payment || 'Outro'}${card?` • ${card.name}`:''}${resource?` • ${resource.name}`:''}`;
      return `<div class="transaction-row"><div class="tx-icon ${t.type}">${t.type === 'expense' ? '−' : '+'}</div><div class="tx-main"><strong>${escapeHtml(t.description)}</strong><span>${formatDate(t.date)} • ${escapeHtml(t.category)} • ${effectiveTransactionStatus(t) === 'paid' ? 'Pago/Recebido' : 'Pendente'}${t.cardId?` • fatura ${monthLabel(transactionInvoiceMonth(t))}`:''}</span></div><div class="tx-value"><strong>${t.type === 'expense' ? '− ' : '+ '}${money.format(t.amount)}</strong><span>${escapeHtml(paymentLabel)}</span></div></div>`;
    }).join('');
  }

  function drawCategoryChart(expenses) {
    const totals = {};
    expenses.forEach(t => totals[t.category] = (totals[t.category] || 0) + t.amount);
    const data = Object.entries(totals).sort((a,b)=>b[1]-a[1]).slice(0,7);
    const canvas = els.categoryChart;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const cssWidth = canvas.clientWidth || 760, cssHeight = canvas.clientHeight || 290;
    canvas.width = Math.floor(cssWidth*dpr); canvas.height = Math.floor(cssHeight*dpr); ctx.scale(dpr,dpr);
    ctx.clearRect(0,0,cssWidth,cssHeight);
    els.emptyChart.classList.toggle('hidden', data.length > 0);
    if (!data.length) return;
    const max = Math.max(...data.map(d=>d[1]));
    const left = Math.min(150, cssWidth * .28), right=92, top=16, rowH=38, barH=13;
    const themeStyles = getComputedStyle(document.documentElement);
    const chartMuted = themeStyles.getPropertyValue('--muted').trim() || '#64748b';
    const chartTrack = themeStyles.getPropertyValue('--chart-track').trim() || '#e8edf3';
    const chartBar = themeStyles.getPropertyValue('--chart-bar').trim() || '#334155';
    const chartText = themeStyles.getPropertyValue('--text').trim() || '#111827';
    ctx.font='12px system-ui'; ctx.textBaseline='middle';
    data.forEach(([label,value],i)=>{
      const y = top + i*rowH + 15;
      ctx.fillStyle=chartMuted;
      let shown=label; while(ctx.measureText(shown).width>left-16 && shown.length>4) shown=shown.slice(0,-2); if(shown!==label) shown+='…';
      ctx.fillText(shown,0,y);
      const x=left, w=Math.max(3,(cssWidth-left-right)*(value/max));
      ctx.fillStyle=chartTrack; roundRect(ctx,x,y-barH/2,cssWidth-left-right,barH,7); ctx.fill();
      ctx.fillStyle=chartBar; roundRect(ctx,x,y-barH/2,w,barH,7); ctx.fill();
      ctx.fillStyle=chartText; ctx.textAlign='right'; ctx.font='600 11px system-ui'; ctx.fillText(money.format(value),cssWidth-2,y); ctx.textAlign='left'; ctx.font='12px system-ui';
    });
  }
  function roundRect(ctx,x,y,w,h,r){const rr=Math.min(r,w/2,h/2);ctx.beginPath();ctx.moveTo(x+rr,y);ctx.arcTo(x+w,y,x+w,y+h,rr);ctx.arcTo(x+w,y+h,x,y+h,rr);ctx.arcTo(x,y+h,x,y,rr);ctx.arcTo(x,y,x+w,y,rr);ctx.closePath();}

  function filteredTransactions() {
    const q = els.transactionSearch.value.trim().toLowerCase();
    return state.transactions.filter(t => monthOf(t.date) === selectedMonth())
      .filter(t => !els.typeFilter.value || t.type === els.typeFilter.value)
      .filter(t => !els.statusFilter.value || effectiveTransactionStatus(t) === els.statusFilter.value)
      .filter(t => !q || `${t.description} ${t.category} ${t.payment} ${cardById(t.cardId)?.name||''}`.toLowerCase().includes(q))
      .sort((a,b)=>b.date.localeCompare(a.date));
  }
  function renderTransactions() {
    const list = filteredTransactions();
    els.transactionsEmpty.classList.toggle('hidden', list.length > 0);
    els.transactionsTable.innerHTML = list.map(t => {
      const card=cardById(t.cardId);
      const resource=accountById(t.resourceAccountId);
      const payment=`${t.payment || '—'}${card?` • ${card.name}`:''}${t.cardId?`<div class="installment-note">Fatura ${escapeHtml(monthLabel(transactionInvoiceMonth(t)))}</div>`:''}${resource?`<div class="installment-note">Pago com ${escapeHtml(resource.name)}</div>`:''}`;
      return `<tr><td>${formatDate(t.date)}</td><td><strong>${escapeHtml(t.description)}</strong>${t.purchaseDate&&t.purchaseDate!==t.date?`<div class="installment-note">Compra em ${formatDate(t.purchaseDate)}</div>`:''}</td><td>${escapeHtml(t.category)}</td><td>${payment}</td><td><span class="status ${effectiveTransactionStatus(t)}">${effectiveTransactionStatus(t) === 'paid' ? 'Pago / Recebido' : 'Pendente'}</span></td><td class="right"><strong>${t.type === 'expense' ? '− ' : '+ '}${money.format(t.amount)}</strong></td><td><div class="row-actions"><button class="mini-btn" data-action="toggle-paid" data-id="${t.id}" title="Alterar status">✓</button><button class="mini-btn" data-action="edit-tx" data-id="${t.id}" title="Editar">✎</button><button class="mini-btn" data-action="delete-tx" data-id="${t.id}" title="Excluir">×</button></div></td></tr>`;
    }).join('');
    $$('[data-action="edit-tx"]').forEach(b=>b.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();openTransaction(b.dataset.id);}));
    $$('[data-action="delete-tx"]').forEach(b=>b.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();deleteTransaction(b.dataset.id);}));
    $$('[data-action="toggle-paid"]').forEach(b=>b.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();toggleTransactionStatus(b.dataset.id);}));
  }

  function accountById(id) { return state.accounts.find(a => a.id === id) || null; }
  function roundMoney(v) { return Math.round((Number(v) + Number.EPSILON) * 100) / 100; }
  function populateAccountSelect(node, preferredId='') {
    if (!node) return;
    const current = preferredId || node.value || '';
    node.innerHTML = state.accounts.length
      ? '<option value="">Selecione um recurso</option>' + state.accounts.map(a => `<option value="${a.id}">${escapeHtml(a.name)} • ${money.format(a.balance)}</option>`).join('')
      : '<option value="">Cadastre um recurso primeiro</option>';
    node.value = state.accounts.some(a => a.id === current) ? current : '';
  }
  function adjustAccountBalance(accountId, delta) {
    const account = accountById(accountId);
    if (!account) return false;
    account.balance = roundMoney(Number(account.balance || 0) + Number(delta || 0));
    account._updatedAt = nowStamp();
    return true;
  }
  function transactionHasResourceSettlement(t) {
    return Boolean(t?.resourceAccountId && Number(t?.resourceAmount || 0) > 0);
  }
  function reverseTransactionSettlement(t) {
    if (!transactionHasResourceSettlement(t)) return false;
    const restored = adjustAccountBalance(t.resourceAccountId, Number(t.resourceAmount || 0));
    if (restored) {
      t.resourceAccountId = null;
      t.resourceAmount = 0;
      t.resourceSettledAt = null;
      t._updatedAt = nowStamp();
    }
    return restored;
  }
  function applyTransactionSettlement(t, accountId, amount=t.amount) {
    const account = accountById(accountId);
    const value = roundMoney(Number(amount || 0));
    if (!account || !(value > 0)) return { ok:false, message:'Selecione um recurso válido.' };
    if (Number(account.balance || 0) + 0.0001 < value) return { ok:false, message:`Saldo insuficiente em ${account.name}. Disponível: ${money.format(account.balance)}.` };
    adjustAccountBalance(accountId, -value);
    t.status = 'paid';
    t.resourceAccountId = accountId;
    t.resourceAmount = value;
    t.resourceSettledAt = new Date().toISOString();
    t._updatedAt = nowStamp();
    return { ok:true, account };
  }
  function updateTransactionResourceFields() {
    const type = $('input[name="txType"]:checked')?.value;
    const payment = $('#txPayment').value;
    const paid = $('#txStatus').value === 'paid';
    const directExpense = type === 'expense' && paid && payment !== 'Crédito' && !isBenefitPayment(payment);
    const field = $('#txAccountField');
    if (!field) return;
    field.classList.toggle('hidden', !directExpense);
    if (directExpense) {
      const existing = state.transactions.find(t => t.id === $('#transactionId').value);
      populateAccountSelect($('#txAccount'), existing?.resourceAccountId || '');
    }
  }
  function openPaymentSource(action) {
    if (!state.accounts.length) {
      toast('Cadastre um recurso antes de registrar o pagamento.');
      showView('accounts');
      return;
    }
    pendingPaymentAction = action;
    $('#paymentSourceTitle').textContent = action.kind === 'invoice' ? 'Pagar fatura' : 'Registrar pagamento';
    $('#paymentSourceDescription').textContent = action.description || 'Selecione de onde saiu o dinheiro deste pagamento.';
    $('#paymentSourceAmount').textContent = money.format(action.amount || 0);
    populateAccountSelect($('#paymentSourceAccount'), action.preferredAccountId || '');
    updatePaymentSourceBalance();
    showDialog(els.paymentSourceModal);
  }
  function updatePaymentSourceBalance() {
    const account = accountById($('#paymentSourceAccount')?.value);
    const amount = Number(pendingPaymentAction?.amount || 0);
    const node = $('#paymentSourceBalance');
    if (!node) return;
    if (!account) { node.textContent = 'Selecione um recurso válido.'; return; }
    const after = roundMoney(Number(account.balance || 0) - amount);
    node.textContent = `Saldo atual: ${money.format(account.balance)} • após pagamento: ${money.format(after)}`;
    node.classList.toggle('danger-text', after < -0.001);
  }
  function confirmPaymentSource(e) {
    e.preventDefault();
    if (!pendingPaymentAction) return;
    const accountId = $('#paymentSourceAccount').value;
    const account = accountById(accountId);
    const amount = roundMoney(Number(pendingPaymentAction.amount || 0));
    if (!account) { toast('Selecione um recurso válido.'); return; }
    if (Number(account.balance || 0) + 0.0001 < amount) { toast(`Saldo insuficiente em ${account.name}.`); updatePaymentSourceBalance(); return; }

    if (pendingPaymentAction.kind === 'transaction') {
      const t = state.transactions.find(x => x.id === pendingPaymentAction.transactionId);
      if (!t) { toast('Lançamento não encontrado.'); return; }
      const result = applyTransactionSettlement(t, accountId, amount);
      if (!result.ok) { toast(result.message); return; }
      saveState();
      pendingPaymentAction = null;
      closeDialog(els.paymentSourceModal);
      renderAll();
      toast(`Pago com ${result.account.name}. Saldo do recurso: ${money.format(result.account.balance)}.`);
      return;
    }

    if (pendingPaymentAction.kind === 'invoice') {
      const { cardId, month } = pendingPaymentAction;
      const txs = invoiceTransactions(cardId, month);
      if (!txs.length) { toast('Essa fatura não possui compras.'); return; }
      const currentTotal = roundMoney(sum(txs.map(t => t.amount)));
      if (Math.abs(currentTotal - amount) > 0.01) { toast('A fatura mudou. Abra novamente e tente pagar.'); pendingPaymentAction = null; closeDialog(els.paymentSourceModal); renderAll(); return; }
      adjustAccountBalance(accountId, -currentTotal);
      const id = `${cardId}:${month}`;
      const existing = state.cardPayments.find(p => entityId('cardPayments', p) === id);
      const item = touchEntity({ id, cardId, month, paid:true, paidAt:new Date().toISOString(), resourceAccountId:accountId, resourceAmount:currentTotal });
      if (existing) state.cardPayments[state.cardPayments.indexOf(existing)] = item;
      else state.cardPayments.push(item);
      saveState();
      pendingPaymentAction = null;
      closeDialog(els.paymentSourceModal);
      renderAll();
      toast(`Fatura paga com ${account.name}. Saldo do recurso: ${money.format(account.balance)}.`);
    }
  }

  function populateCategorySelects() {
    ['#txCategory','#recCategory','#quickExpenseCategory'].forEach(sel => {
      const node=$(sel); const current=node.value;
      node.innerHTML=state.categories.map(c=>`<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
      if (state.categories.includes(current)) node.value=current;
    });
  }
  function populateCardSelects() {
    ['#txCard','#recCard','#quickExpenseCard'].forEach(sel => {
      const node = $(sel);
      if (!node) return;
      const current = node.value;
      const active = state.cards.filter(c => c.active !== false);
      node.innerHTML = active.length
        ? active.map(c => `<option value="${c.id}">${escapeHtml(c.name)}${c.last4 ? ` • ${escapeHtml(c.last4)}` : ''}</option>`).join('')
        : '<option value="">Cadastre um cartão primeiro</option>';
      if (active.some(c => c.id === current)) node.value = current;
    });
  }
  function transactionIsCreditExpense() {
    return $('#txPayment').value === 'Crédito' && $('input[name="txType"]:checked')?.value === 'expense';
  }
  function updateTransactionCreditDueDate(force = false) {
    if (!transactionIsCreditExpense()) return;
    const card = cardById($('#txCard').value);
    const date = $('#txDate').value;
    const dueNode = $('#txDueDate');
    if (!card || !date || !dueNode) return;
    // Ao apenas abrir um lançamento existente, preserve um vencimento que já
    // estava salvo. Trocar cartão/data força um novo cálculo automático.
    if (!force && $('#transactionId').value && dueNode.value) return;
    const invoiceMonth = invoiceMonthFor(card, date, '');
    dueNode.value = invoiceDueDate(card, invoiceMonth);
    dueNode.dataset.creditAuto = '1';
  }
  function updateTransactionCreditFields() {
    const credit = transactionIsCreditExpense();
    const benefit = $('input[name="txType"]:checked')?.value === 'expense' && isBenefitPayment($('#txPayment').value);
    const dueNode = $('#txDueDate');
    $('#txCardField').classList.toggle('hidden', !credit);
    $('#txInstallmentsField').classList.toggle('hidden', !credit || Boolean($('#transactionId').value));
    $('#txCreditHint').classList.toggle('hidden', !credit);
    $('#txBenefitHint')?.classList.toggle('hidden', !benefit);
    if (credit) {
      if (!$('#transactionId').value) $('#txStatus').value = 'pending';
      populateCardSelects();
      updateTransactionCreditDueDate(false);
    } else if (dueNode?.dataset.creditAuto === '1') {
      // Se o vencimento foi criado pelo cartão e a forma de pagamento mudou,
      // remova apenas o valor automático. Datas informadas manualmente permanecem.
      dueNode.value = '';
      delete dueNode.dataset.creditAuto;
    }
    if (benefit) {
      $('#txStatus').value = 'paid';
      dueNode.value = '';
      delete dueNode.dataset.creditAuto;
      const key = benefitKeyFromPayment($('#txPayment').value);
      const hint = $('#txBenefitHint');
      if (hint) hint.textContent = `Débito direto do ${$('#txPayment').value}. Saldo atual: ${money.format(benefitCurrentBalance(key))}. Esse gasto não reduz seu saldo disponível em dinheiro.`;
    }
    updateTransactionResourceFields();
  }
  function openQuickExpense() {
    populateCategorySelects();
    populateCardSelects();
    const form = $('#quickExpenseForm');
    if (!form || !els.quickExpenseModal) return;
    form.reset();
    $('#quickExpensePayment').value = 'Pix';
    populateAccountSelect($('#quickExpenseAccount'));
    updateQuickExpenseFields();
    showDialog(els.quickExpenseModal);
    setTimeout(() => $('#quickExpenseAmount')?.focus(), 90);
  }

  function updateQuickExpenseFields() {
    const payment = $('#quickExpensePayment')?.value || 'Pix';
    const credit = payment === 'Crédito';
    const benefit = isBenefitPayment(payment);
    const cardField = $('#quickExpenseCardField');
    const accountField = $('#quickExpenseAccountField');
    const hint = $('#quickExpenseHint');
    if (cardField) cardField.classList.toggle('hidden', !credit);
    if (accountField) accountField.classList.toggle('hidden', credit || benefit);

    if (credit) {
      populateCardSelects();
      const card = cardById($('#quickExpenseCard')?.value);
      if (hint) {
        hint.textContent = card
          ? `Compra na fatura ${monthLabel(currentMonth())} • vencimento ${formatDate(invoiceDueDate(card, currentMonth()))}. Para parcelar, use “Novo lançamento”.`
          : 'Selecione um cartão. Para parcelar, use “Novo lançamento”.';
      }
      return;
    }

    if (benefit) {
      const key = benefitKeyFromPayment(payment);
      if (hint) hint.textContent = `${payment} • saldo disponível ${money.format(benefitCurrentBalance(key))}. O valor será baixado do benefício.`;
      return;
    }

    populateAccountSelect($('#quickExpenseAccount'));
    if (hint) hint.textContent = 'O gasto será marcado como pago e baixado imediatamente do recurso selecionado.';
  }

  function saveQuickExpense(e) {
    e.preventDefault();
    const amount = parseAmount($('#quickExpenseAmount')?.value || '');
    if (!(amount > 0)) { toast('Informe um valor válido.'); return; }

    const category = $('#quickExpenseCategory')?.value || state.categories[0] || 'Outros';
    const payment = $('#quickExpensePayment')?.value || 'Pix';
    const description = ($('#quickExpenseDescription')?.value || '').trim() || category;
    const date = todayDateStr();
    const benefitExpense = isBenefitPayment(payment);
    const cardId = payment === 'Crédito' ? ($('#quickExpenseCard')?.value || '') : '';
    const card = cardById(cardId);

    if (payment === 'Crédito' && !card) {
      toast('Cadastre e selecione um cartão para usar Crédito.');
      return;
    }

    const tx = touchEntity({
      id: uid(),
      date,
      type: 'expense',
      description,
      category,
      amount,
      status: payment === 'Crédito' ? 'pending' : 'paid',
      payment,
      dueDate: '',
      notes: '',
      recurringId: null,
      cardId: null,
      invoiceMonth: null,
      purchaseDate: null,
      installmentGroupId: null,
      installmentNumber: 0,
      installmentTotal: 0,
      benefitTracked: benefitExpense
    });

    if (payment === 'Crédito') {
      tx.cardId = card.id;
      tx.purchaseDate = date;
      tx.invoiceMonth = invoiceMonthFor(card, date);
      tx.dueDate = invoiceDueDate(card, tx.invoiceMonth);
    } else if (!benefitExpense) {
      const accountId = $('#quickExpenseAccount')?.value || '';
      const result = applyTransactionSettlement(tx, accountId, amount);
      if (!result.ok) { toast(result.message); return; }
    }

    state.transactions.push(tx);
    saveState();
    closeDialog(els.quickExpenseModal);
    renderAll();

    if (payment === 'Crédito') {
      toast(`Gasto salvo • ${card.name} • fatura ${monthLabel(tx.invoiceMonth)}.`);
    } else if (benefitExpense) {
      const key = benefitKeyFromPayment(payment);
      toast(`${payment} • saldo restante ${money.format(benefitCurrentBalance(key))}.`);
    } else {
      const account = accountById(tx.resourceAccountId);
      toast(`Gasto salvo • ${account?.name || 'recurso'} • saldo ${money.format(account?.balance || 0)}.`);
    }
  }

  function openTransaction(id=null) {
    populateCategorySelects();
    populateCardSelects();
    $('#transactionForm').reset();
    $('#transactionId').value='';
    delete $('#txDueDate').dataset.creditAuto;
    $('#txDate').value = new Date().toISOString().slice(0,10);
    $('#txStatus').value='paid';
    $('#txInstallments').value='1';
    populateAccountSelect($('#txAccount'));
    $('#transactionModalTitle').textContent = id ? 'Editar lançamento' : 'Novo lançamento';
    if (id) {
      const t=state.transactions.find(x=>x.id===id); if(!t)return;
      $('#transactionId').value=t.id;
      $(`input[name="txType"][value="${t.type}"]`).checked=true;
      $('#txDate').value=t.date;
      $('#txAmount').value=formatInputAmount(t.amount);
      $('#txDescription').value=t.description;
      $('#txCategory').value=t.category;
      $('#txPayment').value=t.payment || 'Outro';
      $('#txStatus').value=t.status;
      $('#txDueDate').value=t.dueDate||'';
      $('#txNotes').value=t.notes||'';
      if (t.cardId) $('#txCard').value=t.cardId;
      if (t.resourceAccountId) $('#txAccount').value=t.resourceAccountId;
      if (t.installmentTotal > 1) $('#transactionModalTitle').textContent = `Editar parcela ${t.installmentNumber}/${t.installmentTotal}`;
    }
    updateTransactionCreditFields();
    showDialog(els.transactionModal);
    setTimeout(()=>$('#txAmount').focus(),80);
  }
  function saveTransaction(e) {
    e.preventDefault();
    const amount=parseAmount($('#txAmount').value);
    if(!(amount>0)){toast('Informe um valor válido.');return;}
    const payment=$('#txPayment').value;
    const type=$('input[name="txType"]:checked').value;
    const date=$('#txDate').value;
    const existingId=$('#transactionId').value;
    const existing=state.transactions.find(t=>t.id===existingId);
    const cardId=payment==='Crédito' ? ($('#txCard').value || null) : null;
    const card=cardById(cardId);
    const benefitExpense = type === 'expense' && isBenefitPayment(payment);
    const directPaidExpense = type === 'expense' && payment !== 'Crédito' && !benefitExpense && $('#txStatus').value === 'paid';
    const selectedAccountId = directPaidExpense ? ($('#txAccount').value || '') : '';
    if (payment==='Crédito' && type==='expense' && !card) { toast('Cadastre e selecione um cartão para compras no crédito.'); return; }
    if (directPaidExpense && !selectedAccountId && !(existing && existing.status === 'paid' && !transactionHasResourceSettlement(existing))) { toast('Selecione de qual recurso saiu este pagamento.'); return; }

    const baseDescription=$('#txDescription').value.trim();
    const requestedDueDate=$('#txDueDate').value;
    const base={date,type,description:baseDescription,category:$('#txCategory').value,amount,status:benefitExpense?'paid':$('#txStatus').value,payment,dueDate:benefitExpense?'':requestedDueDate,notes:$('#txNotes').value.trim(),recurringId:existing?.recurringId||null};

    if (existing) {
      // Evita alterar compras de uma fatura já quitada: primeiro reabra a fatura.
      if (existing.cardId && invoicePaid(existing.cardId, transactionInvoiceMonth(existing))) {
        toast('Esta compra pertence a uma fatura paga. Reabra a fatura antes de editar.');
        return;
      }
      const accountsSnapshot = clone(state.accounts);
      const updated=touchEntity({...existing,...base,cardId});
      const existingWasBenefit = existing.type === 'expense' && isBenefitPayment(existing.payment);
      updated.benefitTracked = benefitExpense ? (existingWasBenefit ? existing.benefitTracked === true : true) : false;

      // Se o lançamento já havia baixado um recurso, devolva primeiro o valor antigo.
      if (transactionHasResourceSettlement(existing)) {
        const oldAccount = accountById(existing.resourceAccountId);
        if (!oldAccount) { toast('O recurso usado no pagamento anterior não existe mais.'); return; }
        adjustAccountBalance(existing.resourceAccountId, Number(existing.resourceAmount || existing.amount || 0));
        updated.resourceAccountId = null;
        updated.resourceAmount = 0;
        updated.resourceSettledAt = null;
      }

      if (payment==='Crédito' && type==='expense') {
        updated.purchaseDate=existing.purchaseDate || date;
        updated.invoiceMonth=existing.installmentTotal>1 ? existing.invoiceMonth : invoiceMonthFor(card,date,requestedDueDate);
        updated.dueDate=requestedDueDate || invoiceDueDate(card,updated.invoiceMonth);
        updated.status='pending';
        updated.resourceAccountId=null; updated.resourceAmount=0; updated.resourceSettledAt=null;
      } else {
        updated.cardId=null; updated.invoiceMonth=null; updated.purchaseDate=null;
      }

      // Novo pagamento direto: baixe do recurso selecionado. Para registros antigos
      // já pagos e sem vínculo de recurso, preserve o legado até o usuário reabrir/pagar.
      if (directPaidExpense) {
        const legacyPaidWithoutResource = existing.status === 'paid' && !transactionHasResourceSettlement(existing) && !selectedAccountId;
        if (!legacyPaidWithoutResource) {
          const result = applyTransactionSettlement(updated, selectedAccountId, amount);
          if (!result.ok) { state.accounts = accountsSnapshot; toast(result.message); return; }
        }
      } else {
        updated.resourceAccountId=null; updated.resourceAmount=0; updated.resourceSettledAt=null;
      }

      const idx=state.transactions.findIndex(t=>t.id===existing.id);
      state.transactions[idx]=updated;
      saveState(); closeDialog(els.transactionModal); renderAll();
      if (benefitExpense) {
        const key = benefitKeyFromPayment(payment);
        toast(`${payment} • saldo ${money.format(benefitCurrentBalance(key))}`);
      } else if (updated.resourceAccountId) {
        const acc = accountById(updated.resourceAccountId);
        toast(`Lançamento atualizado • pago com ${acc?.name || 'recurso'}.`);
      } else {
        toast(updated.cardId ? `Lançamento atualizado • ${card.name} • limite livre ${money.format(cardAvailableLimit(card.id))}` : 'Lançamento atualizado.');
      }
      return;
    }

    const installments=(payment==='Crédito' && type==='expense') ? Number($('#txInstallments').value||1) : 1;
    if (installments > 1) {
      const pieces=splitAmount(amount,installments);
      const groupId=uid();
      const firstInvoice=invoiceMonthFor(card,date,requestedDueDate);
      pieces.forEach((piece,i)=>{
        const installmentDate=addMonthsToDate(date,i);
        const invoiceMonth=shiftMonth(firstInvoice,i);
        state.transactions.push(touchEntity({
          id:uid(),
          ...base,
          date:installmentDate,
          purchaseDate:date,
          description:`${baseDescription} (${i+1}/${installments})`,
          amount:piece,
          status:'pending',
          cardId,
          invoiceMonth,
          dueDate:requestedDueDate ? addMonthsToDate(requestedDueDate,i) : invoiceDueDate(card,invoiceMonth),
          installmentGroupId:groupId,
          installmentNumber:i+1,
          installmentTotal:installments
        }));
      });
      saveState(); closeDialog(els.transactionModal); renderAll(); toast(`Compra em ${installments}x vinculada ao ${card.name} • limite livre ${money.format(cardAvailableLimit(card.id))}`);
      return;
    }

    const tx=touchEntity({id:uid(),...base,cardId:null,invoiceMonth:null,purchaseDate:null,installmentGroupId:null,installmentNumber:0,installmentTotal:0,benefitTracked:benefitExpense});
    if (payment==='Crédito' && type==='expense') {
      tx.cardId=cardId;
      tx.purchaseDate=date;
      tx.invoiceMonth=invoiceMonthFor(card,date,requestedDueDate);
      tx.dueDate=requestedDueDate || invoiceDueDate(card,tx.invoiceMonth);
      tx.status='pending';
    } else if (directPaidExpense) {
      const result = applyTransactionSettlement(tx, selectedAccountId, amount);
      if (!result.ok) { toast(result.message); return; }
    }
    state.transactions.push(tx);
    saveState(); closeDialog(els.transactionModal); renderAll();
    if (benefitExpense) {
      const key = benefitKeyFromPayment(payment);
      toast(`${payment} • saldo restante ${money.format(benefitCurrentBalance(key))}`);
    } else if (tx.resourceAccountId) {
      const acc = accountById(tx.resourceAccountId);
      toast(`Lançamento salvo • pago com ${acc?.name || 'recurso'} • saldo ${money.format(acc?.balance || 0)}.`);
    } else {
      toast(tx.cardId ? `Compra vinculada ao ${card.name} • fatura ${monthLabel(tx.invoiceMonth)} • limite livre ${money.format(cardAvailableLimit(card.id))}` : 'Lançamento salvo.');
    }
  }
  function deleteTransaction(id){
    const t=state.transactions.find(x=>x.id===id);if(!t)return;
    if (t.cardId && invoicePaid(t.cardId, transactionInvoiceMonth(t))) { toast('Reabra a fatura antes de excluir uma compra já quitada.'); return; }
    if(!confirm(`Excluir “${t.description}”?`))return;
    if (transactionHasResourceSettlement(t)) reverseTransactionSettlement(t);
    state.transactions=state.transactions.filter(x=>x.id!==id);markDeleted('transactions',id);saveState();renderAll();toast('Lançamento excluído.');
  }
  function toggleTransactionStatus(id){
    const t=state.transactions.find(x=>x.id===id);if(!t)return;
    if(t.type==='expense'&&isBenefitPayment(t.payment)){toast('Gastos com vale são debitados diretamente do saldo do benefício.');return;}
    if(t.type==='expense'&&t.cardId){toast('Compras no crédito são quitadas pela fatura. Abra “Cartões e faturas” e pague a fatura escolhendo o recurso.');return;}
    const current=effectiveTransactionStatus(t);
    if (t.type === 'expense') {
      if (current === 'paid') {
        const hadSettlement = transactionHasResourceSettlement(t);
        if (hadSettlement && !reverseTransactionSettlement(t)) { toast('Não foi possível devolver o valor ao recurso original.'); return; }
        t.status='pending';t._updatedAt=nowStamp();saveState();renderAll();
        toast(hadSettlement?'Pagamento desfeito e valor devolvido ao recurso.':'Marcado como pendente.');
      } else {
        openPaymentSource({kind:'transaction',transactionId:t.id,amount:t.amount,description:`${t.description} • ${money.format(t.amount)}`});
      }
      return;
    }
    // Receitas continuam sendo controladas por status; Recursos representam a
    // posição financeira manual e não recebem crédito automático nesta versão.
    t.status=current==='paid'?'pending':'paid';t._updatedAt=nowStamp();saveState();renderAll();toast(t.status==='paid'?'Marcado como recebido.':'Marcado como pendente.');
  }

  function recurringKindLabel(kind) {
    return ({fixed:'Conta fixa',subscription:'Assinatura',internet:'Chip / internet',income:'Receita recorrente',other:'Recorrente'})[kind] || 'Recorrente';
  }
  function renderRecurring() {
    const active=state.recurring.filter(r=>r.active);
    const fixedTotal=sum(active.filter(r=>r.type==='expense').map(r=>r.amount));
    const subscriptionTotal=sum(active.filter(r=>r.type==='expense' && ['subscription','internet'].includes(r.kind)).map(r=>r.amount));
    const incomeTotal=sum(active.filter(r=>r.type==='income').map(r=>r.amount));
    $('#fixedExpenseTotal').textContent=money.format(fixedTotal);
    $('#subscriptionTotal').textContent=money.format(subscriptionTotal);
    $('#fixedIncomeTotal').textContent=money.format(incomeTotal);
    els.recurringEmpty.classList.toggle('hidden', state.recurring.length > 0);
    els.recurringGrid.innerHTML = state.recurring.map(r=>{
      const card=cardById(r.cardId);
      return `<article class="card data-card">
        <div class="data-card-head">
          <div><strong>${escapeHtml(r.description)}</strong><span>${escapeHtml(r.provider||'')}${r.provider?' • ':''}vence dia ${r.day}</span></div>
          <span class="status ${r.active?'paid':'pending'}">${r.active?'Ativa':'Pausada'}</span>
        </div>
        <div class="recurring-meta"><span class="recurring-kind ${escapeHtml(r.kind||'fixed')}">${escapeHtml(recurringKindLabel(r.kind))}</span>${r.autoGenerate!==false?'<span class="soft-chip">Automática</span>':'<span class="soft-chip">Manual</span>'}</div>
        <div class="data-card-value">${money.format(r.amount)}</div>
        <div class="data-card-foot">
          <span>${escapeHtml(r.category)} • ${escapeHtml(r.payment)}${card?` • ${escapeHtml(card.name)}`:''}</span>
          <div class="row-actions"><button class="mini-btn" data-rec-edit="${r.id}">✎</button><button class="mini-btn" data-rec-delete="${r.id}">×</button></div>
        </div>
      </article>`;
    }).join('');
    $$('[data-rec-edit]').forEach(b=>b.addEventListener('click',()=>openRecurring(b.dataset.recEdit)));
    $$('[data-rec-delete]').forEach(b=>b.addEventListener('click',()=>deleteRecurring(b.dataset.recDelete)));
  }
  function updateRecurringCreditFields() {
    const credit=$('#recPayment').value==='Crédito';
    $('#recCardField').classList.toggle('hidden',!credit);
    if(credit) populateCardSelects();
  }
  function openRecurring(id=null){
    populateCategorySelects(); populateCardSelects();
    $('#recurringForm').reset();
    $('#recurringId').value='';
    $('#recActive').checked=true;
    $('#recAutoGenerate').checked=true;
    $('#recKind').value='fixed';
    $('#recType').value='expense';
    $('#recurringModalTitle').textContent=id?'Editar fixo / assinatura':'Novo fixo / assinatura';
    if(id){
      const r=state.recurring.find(x=>x.id===id);if(!r)return;
      $('#recurringId').value=r.id;
      $('#recKind').value=r.kind || (r.type==='income'?'income':'fixed');
      $('#recType').value=r.type;
      $('#recDay').value=r.day;
      $('#recDescription').value=r.description;
      $('#recProvider').value=r.provider||'';
      $('#recCategory').value=r.category;
      $('#recAmount').value=formatInputAmount(r.amount);
      $('#recPayment').value=r.payment;
      $('#recActive').checked=r.active;
      $('#recAutoGenerate').checked=r.autoGenerate!==false;
      if(r.cardId) $('#recCard').value=r.cardId;
    }
    updateRecurringCreditFields();
    showDialog(els.recurringModal);
  }
  function saveRecurring(e){
    e.preventDefault();
    const amount=parseAmount($('#recAmount').value);
    const day=Number($('#recDay').value);
    if(!(amount>0)||day<1||day>31){toast('Confira o valor e o dia do mês.');return;}
    const payment=$('#recPayment').value;
    const cardId=payment==='Crédito'?($('#recCard').value||null):null;
    if(payment==='Crédito' && !cardById(cardId)){toast('Selecione um cartão válido para esta cobrança recorrente.');return;}
    const id=$('#recurringId').value||uid();
    const r=touchEntity({
      id,
      kind:$('#recKind').value,
      type:$('#recType').value,
      day,
      description:$('#recDescription').value.trim(),
      provider:$('#recProvider').value.trim(),
      category:$('#recCategory').value,
      amount,
      payment,
      cardId,
      active:$('#recActive').checked,
      autoGenerate:$('#recAutoGenerate').checked
    });
    const idx=state.recurring.findIndex(x=>x.id===id);
    if(idx>=0)state.recurring[idx]=r;else state.recurring.push(r);

    // A recorrência e o lançamento automático do mês precisam formar uma única
    // alteração lógica. Monte tudo no estado primeiro e sincronize apenas uma vez.
    // Cadastrar/editar um fixo gera somente a competência atual. O mês apenas
    // visualizado no filtro não deve criar lançamentos retroativos ou futuros.
    ensureRecurringForMonth(currentMonth(), true, false, false);
    saveState();

    closeDialog(els.recurringModal);renderAll();
    toast(idx>=0?'Fixo/assinatura atualizado.':'Fixo/assinatura cadastrado.');
  }
  function deleteRecurring(id){const r=state.recurring.find(x=>x.id===id);if(!r||!confirm(`Excluir “${r.description}”? Os lançamentos já gerados serão mantidos.`))return;state.recurring=state.recurring.filter(x=>x.id!==id);markDeleted('recurring',id);saveState();renderAll();toast('Recorrência excluída.');}
  function repairFarFutureRecurringTransactions(persist=true) {
    // Remove somente recorrências automáticas que a versão anterior criou muito
    // à frente ao navegar no seletor de mês. Lançamentos manuais não são tocados.
    const maxMonth = shiftMonth(currentMonth(), 24);
    const removed = [];
    state.transactions = state.transactions.filter(t => {
      const generatedRecurring = Boolean(t?.recurringId) && String(t?.id || '').startsWith('rec-');
      const future = generatedRecurring && monthIndex(monthOf(t.date)) > monthIndex(maxMonth);
      if (future) removed.push(t.id);
      return !future;
    });
    if (!removed.length) return 0;
    removed.forEach(id => markDeleted('transactions', id));
    if (persist) saveState();
    return removed.length;
  }

  function ensureRecurringForMonth(month,silent=false,includeManual=false,persist=true){
    if(!month)return 0;
    const [year,mo]=month.split('-').map(Number);
    let created=0;
    state.recurring.filter(r=>r.active && (includeManual || r.autoGenerate!==false)).forEach(r=>{
      if(state.transactions.some(t=>t.recurringId===r.id&&monthOf(t.date)===month))return;
      const lastDay=new Date(year,mo,0).getDate();
      const day=Math.min(Number(r.day||1),lastDay);
      const baseDate=`${month}-${String(day).padStart(2,'0')}`;
      const card=r.payment==='Crédito'?cardById(r.cardId):null;
      const benefitExpense = r.type === 'expense' && isBenefitPayment(r.payment);
      let invoiceMonth=null, dueDate=benefitExpense?'':baseDate, status=benefitExpense?'paid':'pending';
      if(card && r.type==='expense'){
        invoiceMonth=month;
        dueDate=invoiceDueDate(card,invoiceMonth);
      }
      state.transactions.push(touchEntity({
        id:`rec-${r.id}-${month}`,date:baseDate,type:r.type,category:r.category,description:r.description,amount:Number(r.amount),
        status,payment:r.payment,dueDate,notes:r.provider?`Cobrança recorrente • ${r.provider}`:'Gerado a partir de recorrência',
        recurringId:r.id,cardId:card?.id||null,invoiceMonth,purchaseDate:card?baseDate:null,
        installmentGroupId:null,installmentNumber:0,installmentTotal:0,benefitTracked:benefitExpense
      }));
      created++;
    });
    if(created){
      if(persist) saveState();
      if(!silent)toast(`${created} lançamento(s) gerado(s) para ${monthLabel(month)}.`);
    }
    return created;
  }
  function generateRecurringForMonth(){
    const created=ensureRecurringForMonth(selectedMonth(),true,true);
    renderAll();
    toast(created?`${created} lançamento(s) gerado(s) para ${monthLabel(selectedMonth())}.`:'Nada novo para gerar neste mês.');
  }

  function renderCards(){
    const month=selectedMonth();
    const activeCards=state.cards.filter(c=>c.active!==false);
    const invoiceTotals=activeCards.map(c=>({card:c,total:sum(invoiceTransactions(c.id,month).map(t=>t.amount))}));
    const total=sum(invoiceTotals.map(x=>x.total));
    const openTotal=sum(invoiceTotals.filter(x=>x.total>0 && !invoicePaid(x.card.id,month)).map(x=>x.total));
    const limitTotal=sum(activeCards.map(c=>c.limit));
    const limitUsed=sum(activeCards.map(c=>cardUsedLimit(c.id)));
    const limitAvailable=Math.max(0,limitTotal-limitUsed);
    $('#cardsInvoiceTotal').textContent=money.format(total);
    $('#cardsOpenTotal').textContent=money.format(openTotal);
    const limitNode=$('#cardsLimitAvailable')||$('#cardsLimitTotal');
    if(limitNode)limitNode.textContent=money.format(limitAvailable);
    const usageNode=$('#cardsLimitUsage');
    if(usageNode)usageNode.textContent=`${money.format(limitUsed)} usados de ${money.format(limitTotal)}`;
    $('#cardsInvoiceCount').textContent=`${invoiceTotals.filter(x=>x.total>0).length} ${invoiceTotals.filter(x=>x.total>0).length===1?'cartão com movimento':'cartões com movimento'}`;
    $('#invoicePanelTitle').textContent=`Faturas de ${monthLabel(month)}`;
    els.cardsEmpty.classList.toggle('hidden',state.cards.length>0);

    els.cardsGrid.innerHTML=state.cards.map(c=>{
      const invoice=invoiceTransactions(c.id,month);
      const invoiceTotal=sum(invoice.map(t=>t.amount));
      const paid=invoicePaid(c.id,month);
      const committed=cardUsedLimit(c.id);
      const limitAvailable=Math.max(0,Number(c.limit||0)-committed);
      return `<article class="card data-card card-visual">
        <div class="data-card-head">
          <div><strong>${escapeHtml(c.name)}</strong><span>${escapeHtml(c.issuer||'Cartão')}${c.last4?` • final ${escapeHtml(c.last4)}`:''}</span></div>
          <div class="row-actions"><button class="mini-btn" data-card-edit="${c.id}" title="Editar">✎</button><button class="mini-btn" data-card-delete="${c.id}" title="Excluir">×</button></div>
        </div>
        <div class="card-meta"><span class="soft-chip">Fecha dia ${c.closingDay}</span><span class="soft-chip">Vence dia ${c.dueDay}</span>${c.active===false?'<span class="soft-chip">Inativo</span>':''}</div>
        <div class="data-card-value">${money.format(invoiceTotal)}</div>
        <div class="data-card-foot"><span>Fatura ${monthLabel(month)} • vence ${formatDate(invoiceDueDate(c,month))} • ${paid?'paga':'em aberto'}</span><span>usado ${money.format(committed)} • livre ${money.format(limitAvailable)}</span></div>
      </article>`;
    }).join('');

    els.invoiceList.innerHTML=invoiceTotals.filter(x=>x.total>0).length
      ? invoiceTotals.filter(x=>x.total>0).map(({card,total})=>{
          const txs=invoiceTransactions(card.id,month);
          const paid=invoicePaid(card.id,month);
          const due=invoiceDueDate(card,month);
          return `<div class="invoice-row">
            <div class="invoice-row-main"><strong>${escapeHtml(card.name)}</strong><span>${txs.length} ${txs.length===1?'compra':'compras'} • vence ${formatDate(due)}</span></div>
            <div class="invoice-row-value"><strong>${money.format(total)}</strong><span>${paid ? `Fatura paga${state.cardPayments.find(p=>p.cardId===card.id&&p.month===month&&p.paid)?.resourceAccountId ? ` • ${escapeHtml(accountById(state.cardPayments.find(p=>p.cardId===card.id&&p.month===month&&p.paid)?.resourceAccountId)?.name || 'recurso')}` : ''}` : 'Fatura em aberto'}</span></div>
            <div class="row-actions"><button class="btn ${paid?'btn-secondary':'btn-primary'}" data-invoice-toggle="${card.id}">${paid?'Reabrir fatura':'Marcar como paga'}</button></div>
          </div>`;
        }).join('')
      : '<div class="empty-state"><strong>Nenhuma fatura neste mês.</strong><span>Compras feitas no crédito aparecerão aqui automaticamente.</span></div>';

    $$('[data-card-edit]').forEach(b=>b.addEventListener('click',()=>openCard(b.dataset.cardEdit)));
    $$('[data-card-delete]').forEach(b=>b.addEventListener('click',()=>deleteCard(b.dataset.cardDelete)));
    $$('[data-invoice-toggle]').forEach(b=>b.addEventListener('click',()=>toggleInvoiceStatus(b.dataset.invoiceToggle,month)));
  }
  function openCard(id=null){
    $('#cardForm').reset();
    $('#cardId').value='';
    $('#cardActive').checked=true;
    $('#cardClosingDay').value=20;
    $('#cardDueDay').value=10;
    $('#cardModalTitle').textContent=id?'Editar cartão':'Novo cartão';
    if(id){
      const c=cardById(id);if(!c)return;
      $('#cardId').value=c.id;
      $('#cardName').value=c.name;
      $('#cardIssuer').value=c.issuer||'';
      $('#cardLast4').value=c.last4||'';
      $('#cardLimit').value=formatInputAmount(c.limit);
      $('#cardClosingDay').value=c.closingDay;
      $('#cardDueDay').value=c.dueDay;
      $('#cardActive').checked=c.active!==false;
    }
    showDialog(els.cardModal);
  }
  function saveCard(e){
    e.preventDefault();
    const limit=parseAmount($('#cardLimit').value);
    const closingDay=Number($('#cardClosingDay').value);
    const dueDay=Number($('#cardDueDay').value);
    const last4=$('#cardLast4').value.trim();
    if(!(limit>=0)||closingDay<1||closingDay>31||dueDay<1||dueDay>31){toast('Confira limite, fechamento e vencimento.');return;}
    if(last4 && !/^\d{4}$/.test(last4)){toast('O final do cartão deve ter exatamente 4 dígitos.');return;}
    const id=$('#cardId').value||uid();
    const item=touchEntity({id,name:$('#cardName').value.trim(),issuer:$('#cardIssuer').value.trim(),last4,limit,closingDay,dueDay,active:$('#cardActive').checked});
    const idx=state.cards.findIndex(c=>c.id===id);
    if(idx>=0)state.cards[idx]=item;else state.cards.push(item);
    saveState();closeDialog(els.cardModal);renderAll();toast(idx>=0?'Cartão atualizado.':'Cartão cadastrado.');
  }
  function deleteCard(id){
    const c=cardById(id);if(!c)return;
    const linkedTx=state.transactions.some(t=>t.cardId===id);
    const linkedRecurring=state.recurring.some(r=>r.cardId===id);
    if(linkedTx||linkedRecurring){toast('Esse cartão possui compras ou cobranças vinculadas. Desative-o em vez de excluir.');return;}
    if(!confirm(`Excluir o cartão “${c.name}”?`))return;
    state.cards=state.cards.filter(x=>x.id!==id);
    markDeleted('cards',id);
    state.cardPayments.filter(p=>p.cardId===id).forEach(p=>markDeleted('cardPayments',entityId('cardPayments',p)));
    state.cardPayments=state.cardPayments.filter(p=>p.cardId!==id);
    saveState();renderAll();toast('Cartão excluído.');
  }
  function toggleInvoiceStatus(cardId,month){
    const txs=invoiceTransactions(cardId,month);
    if(!txs.length){toast('Essa fatura ainda não possui compras.');return;}
    const isPaid=invoicePaid(cardId,month);
    const id=`${cardId}:${month}`;
    const existing=state.cardPayments.find(p=>entityId('cardPayments',p)===id);
    const total=roundMoney(sum(txs.map(t=>t.amount)));
    const card=cardById(cardId);

    if (!isPaid) {
      openPaymentSource({kind:'invoice',cardId,month,amount:total,description:`Fatura ${card?.name || ''} • ${monthLabel(month)}`});
      return;
    }

    // Ao reabrir uma fatura, devolva ao recurso o valor que havia sido baixado.
    let restored=false;
    if (existing?.resourceAccountId && Number(existing.resourceAmount || 0) > 0) {
      const account=accountById(existing.resourceAccountId);
      if(!account){toast('O recurso usado para pagar esta fatura não existe mais.');return;}
      adjustAccountBalance(existing.resourceAccountId, Number(existing.resourceAmount));
      restored=true;
    }
    const item=touchEntity({id,cardId,month,paid:false,paidAt:null,resourceAccountId:null,resourceAmount:0});
    if(existing){state.cardPayments[state.cardPayments.indexOf(existing)]=item;}else state.cardPayments.push(item);
    saveState();renderAll();toast(restored?'Fatura reaberta. O valor foi devolvido ao recurso utilizado no pagamento.':'Fatura reaberta.');
  }



  function renderAccounts(){
    const total=sum(state.accounts.map(a=>a.balance));
    els.accountsTotal.textContent=money.format(total);

    const month=selectedMonth();
    const monthExpenses=state.transactions.filter(t=>t.type==='expense' && monthOf(t.date)===month);
    const foodVoucher=monthExpenses.filter(t=>t.payment==='Vale Alimentação');
    const fuelVoucher=monthExpenses.filter(t=>t.payment==='Vale Combustível');
    const foodTotal=sum(foodVoucher.map(t=>t.amount));
    const fuelTotal=sum(fuelVoucher.map(t=>t.amount));
    const foodBenefit=benefitByKey('food');
    const fuelBenefit=benefitByKey('fuel');
    const foodBalance=benefitCurrentBalance('food');
    const fuelBalance=benefitCurrentBalance('fuel');

    if(els.foodVoucherBalance) els.foodVoucherBalance.textContent=money.format(foodBalance);
    if(els.fuelVoucherBalance) els.fuelVoucherBalance.textContent=money.format(fuelBalance);
    if(els.foodVoucherMonthly) els.foodVoucherMonthly.textContent=money.format(foodBenefit.monthlyCredit);
    if(els.fuelVoucherMonthly) els.fuelVoucherMonthly.textContent=money.format(fuelBenefit.monthlyCredit);
    if(els.foodVoucherSpent) els.foodVoucherSpent.textContent=money.format(foodTotal);
    if(els.fuelVoucherSpent) els.fuelVoucherSpent.textContent=money.format(fuelTotal);
    if(els.foodVoucherCount) els.foodVoucherCount.textContent=`${foodVoucher.length} ${foodVoucher.length===1?'gasto registrado':'gastos registrados'}`;
    if(els.fuelVoucherCount) els.fuelVoucherCount.textContent=`${fuelVoucher.length} ${fuelVoucher.length===1?'gasto registrado':'gastos registrados'}`;
    if(els.foodVoucherNext) els.foodVoucherNext.textContent=`próximo crédito ${formatDate(benefitNextCreditDate('food'))}`;
    if(els.fuelVoucherNext) els.fuelVoucherNext.textContent=`próximo crédito ${formatDate(benefitNextCreditDate('fuel'))}`;

    els.accountsGrid.innerHTML=state.accounts.map(a=>`<article class="card data-card"><div class="data-card-head"><div><strong>${escapeHtml(a.name)}</strong><span>Recurso disponível</span></div><div class="row-actions"><button class="mini-btn" data-acc-edit="${a.id}">✎</button><button class="mini-btn" data-acc-delete="${a.id}">×</button></div></div><div class="data-card-value">${money.format(a.balance)}</div><div class="data-card-foot"><span>Pagamentos baixam automaticamente</span><span>saldo atual</span></div></article>`).join('');
    $$('[data-acc-edit]').forEach(b=>b.addEventListener('click',()=>openAccount(b.dataset.accEdit)));
    $$('[data-acc-delete]').forEach(b=>b.addEventListener('click',()=>deleteAccount(b.dataset.accDelete)));
  }
  function openAccount(id=null){$('#accountForm').reset();$('#accountId').value='';$('#accountModalTitle').textContent=id?'Editar recurso':'Novo recurso';if(id){const a=state.accounts.find(x=>x.id===id);if(!a)return;$('#accountId').value=a.id;$('#accountName').value=a.name;$('#accountBalance').value=formatInputAmount(a.balance);}showDialog(els.accountModal);}
  function saveAccount(e){e.preventDefault();const balance=parseAmount($('#accountBalance').value);if(!Number.isFinite(balance)){toast('Informe um valor válido.');return;}const id=$('#accountId').value||uid();const item=touchEntity({id,name:$('#accountName').value.trim(),balance});const idx=state.accounts.findIndex(x=>x.id===id);if(idx>=0)state.accounts[idx]=item;else state.accounts.push(item);saveState();closeDialog(els.accountModal);renderAll();toast(idx>=0?'Recurso atualizado.':'Recurso adicionado.');}
  function deleteAccount(id){const a=state.accounts.find(x=>x.id===id);if(!a)return;const linkedTx=state.transactions.some(t=>t.resourceAccountId===id&&Number(t.resourceAmount||0)>0);const linkedInvoice=state.cardPayments.some(p=>p.paid&&p.resourceAccountId===id&&Number(p.resourceAmount||0)>0);if(linkedTx||linkedInvoice){toast('Esse recurso possui pagamentos vinculados. Reabra ou ajuste esses pagamentos antes de excluir.');return;}if(!confirm(`Excluir o recurso “${a.name}”?`))return;state.accounts=state.accounts.filter(x=>x.id!==id);markDeleted('accounts',id);saveState();renderAll();toast('Recurso excluído.');}

  function renderSettings(){els.categoryTags.innerHTML=state.categories.map(c=>`<span class="tag">${escapeHtml(c)}<button data-cat-delete="${escapeHtml(c)}" title="Excluir">×</button></span>`).join('');$$('[data-cat-delete]').forEach(b=>b.addEventListener('click',()=>deleteCategory(b.dataset.catDelete)));renderThemeControls();}
  function addCategory(e){e.preventDefault();const input=$('#newCategory');const name=input.value.trim();if(!name)return;if(state.categories.some(c=>c.toLowerCase()===name.toLowerCase())){toast('Essa categoria já existe.');return;}state.categories.push(name);state.categories.sort((a,b)=>a.localeCompare(b,'pt-BR'));input.value='';saveState();renderAll();toast('Categoria adicionada.');}
  function deleteCategory(name){if(state.categories.length<=1){toast('Mantenha pelo menos uma categoria.');return;}if(!confirm(`Remover a categoria “${name}”? Lançamentos antigos continuarão com esse nome.`))return;state.categories=state.categories.filter(c=>c!==name);saveState();renderAll();toast('Categoria removida.');}

  function exportCsv(){const list=filteredTransactions();const rows=[['Data','Tipo','Categoria','Descrição','Valor','Status','Forma de pagamento','Cartão','Fatura','Parcela','Vencimento','Observação'],...list.map(t=>[t.date,t.type==='expense'?'Despesa':'Receita',t.category,t.description,t.amount.toFixed(2).replace('.',','),effectiveTransactionStatus(t)==='paid'?'Pago/Recebido':'Pendente',t.payment,cardById(t.cardId)?.name||'',t.cardId?transactionInvoiceMonth(t):'',t.installmentTotal>1?`${t.installmentNumber}/${t.installmentTotal}`:'',t.dueDate||'',t.notes||''])];const csv='\ufeff'+rows.map(r=>r.map(v=>`"${String(v??'').replace(/"/g,'""')}"`).join(';')).join('\r\n');downloadBlob(new Blob([csv],{type:'text/csv;charset=utf-8'}),`lancamentos-${selectedMonth()}.csv`);toast('CSV exportado.');}
  function downloadBackup(){const payload={app:'Meu Financeiro',exportedAt:new Date().toISOString(),state};downloadBlob(new Blob([JSON.stringify(payload,null,2)],{type:'application/json'}),`meu-financeiro-backup-${new Date().toISOString().slice(0,10)}.json`);toast('Backup baixado.');}
  function restoreBackup(e){
    const file=e.target.files?.[0];if(!file)return;const reader=new FileReader();
    reader.onload=()=>{try{
      const parsed=JSON.parse(reader.result);const candidate=parsed.state||parsed;
      if(!candidate||candidate.version!==1||!Array.isArray(candidate.transactions)||!Array.isArray(candidate.accounts))throw new Error('Formato inválido');
      if(!confirm('Restaurar este backup substituirá os dados atuais. Continuar?'))return;
      const previous=state;
      state=normalizeState(candidate);
      const stamp=nowStamp();
      SYNC_COLLECTIONS.forEach(kind=>{
        const restoredIds=new Set(state[kind].map(x=>entityId(kind,x)));
        previous[kind].forEach(x=>{const id=entityId(kind,x);if(id&&!restoredIds.has(id))markDeleted(kind,id);});
        state[kind]=state[kind].map(x=>({...x,_updatedAt:stamp}));
      });
      saveState();ensureRecurringForMonth(currentMonth(),true);renderAll();toast('Backup restaurado.');
    }catch{alert('Não foi possível restaurar este arquivo de backup.');}finally{e.target.value='';}};
    reader.readAsText(file);
  }

  function resetData(){
    if(!confirm('Isso apagará os dados atuais deste perfil e sincronizará o estado vazio com a nuvem. Deseja continuar?'))return;
    const tombstones=normalizeTombstones(state);
    const stamp=nowStamp();
    SYNC_COLLECTIONS.forEach(kind=>state[kind].forEach(x=>{
      const id=entityId(kind,x);if(!id)return;
      const list=tombstones[kind];const existing=list.find(t=>t.id===id);
      if(existing)existing.deletedAt=Math.max(existing.deletedAt||0,stamp);else list.push({id,deletedAt:stamp});
    }));
    state=clone(DEFAULT_STATE);state.syncMeta={tombstones};saveState();renderAll();toast('Sistema reiniciado.');
  }
  function downloadBlob(blob,filename){const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=filename;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  function toast(message){els.toast.textContent=message;els.toast.classList.remove('hidden');clearTimeout(toast.timer);toast.timer=setTimeout(()=>els.toast.classList.add('hidden'),2600);}

  function isCloudConfigured() {
    const cfg = window.MF_SUPABASE || {};
    return Boolean(window.supabase?.createClient && cfg.url && cfg.publishableKey && !cfg.url.includes('COLE_AQUI') && !cfg.publishableKey.includes('COLE_AQUI'));
  }

  function bindCloudUi() {
    $('#loginForm').addEventListener('submit', loginWithPassword);
    $('#signupForm').addEventListener('submit', createAccount);
    $('#showSignupBtn').addEventListener('click', () => toggleAuthPanel('signup'));
    $('#showLoginBtn').addEventListener('click', () => toggleAuthPanel('login'));
    $('#logoutBtn').addEventListener('click', signOutCloud);
    $('#settingsLogoutBtn').addEventListener('click', signOutCloud);
    $('#syncNowBtn').addEventListener('click', syncNow);
    $('#localModeBtn').addEventListener('click', () => { els.authGate.classList.add('hidden'); setCloudStatus('Modo local', 'offline'); });
    window.addEventListener('online', () => { setCloudStatus('Reconectando...', 'syncing'); syncNow(); });
    window.addEventListener('offline', () => setCloudStatus('Sem internet • dados salvos localmente', 'offline'));
    document.addEventListener('visibilitychange', () => { if (!document.hidden && cloudUser) syncNow(); });
  }

  function toggleAuthPanel(mode) {
    $('#authLoginPanel').classList.toggle('hidden', mode !== 'login');
    $('#authSignupPanel').classList.toggle('hidden', mode !== 'signup');
    hideAuthMessage();
  }

  function showAuthMessage(message, isError=false) {
    els.authMessage.textContent = message;
    els.authMessage.classList.remove('hidden');
    els.authMessage.style.background = isError ? 'var(--red-bg)' : 'var(--amber-bg)';
    els.authMessage.style.color = isError ? 'var(--red)' : 'var(--amber)';
  }
  function hideAuthMessage() { els.authMessage.classList.add('hidden'); }

  async function initCloud() {
    if (!isCloudConfigured()) {
      els.authGate.classList.remove('hidden');
      $('#localModeBtn').classList.remove('hidden');
      showAuthMessage('A sincronização ainda não foi configurada. Preencha o arquivo supabase-config.js com o Project URL e a Publishable Key.');
      setCloudStatus('Supabase não configurado', 'offline');
      return;
    }
    const cfg = window.MF_SUPABASE;
    cloudClient = window.supabase.createClient(cfg.url, cfg.publishableKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    });
    setCloudStatus('Conectando...', 'syncing');

    let session = null;
    try {
      const sessionResult = await withCloudTimeout(cloudClient.auth.getSession(), 'recuperar a sessão', 9000);
      session = sessionResult?.data?.session || null;
      if (sessionResult?.error) console.warn('Falha ao recuperar sessão:', sessionResult.error.message);
    } catch (err) {
      console.warn('Sessão não recuperada no bootstrap:', err?.message || err);
      lastSyncError = err?.message || 'Não foi possível recuperar a sessão.';
    }

    // Registre o listener somente depois da recuperação inicial. Isso reduz
    // corridas/locks de autenticação em PWAs no iOS.
    cloudClient.auth.onAuthStateChange((_event, nextSession) => {
      if (nextSession?.user && nextSession.user.id !== cloudUser?.id) handleLoggedIn(nextSession.user);
      if (!nextSession) handleLoggedOut();
    });

    if (session?.user) {
      await handleLoggedIn(session.user);
    } else {
      handleLoggedOut();
      const standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
      if (standalone) {
        showAuthMessage('Primeiro acesso pelo aplicativo do iPhone: entre novamente uma vez. O iOS mantém o armazenamento do app separado do Safari; depois do login, seus dados serão carregados do Supabase.');
      }
    }
  }

  async function loginWithPassword(e) {
    e.preventDefault();
    if (!cloudClient) return;
    hideAuthMessage();
    const email = $('#loginEmail').value.trim();
    const password = $('#loginPassword').value;
    const btn = e.submitter; if (btn) btn.disabled = true;
    try {
      const { error } = await withCloudTimeout(cloudClient.auth.signInWithPassword({ email, password }), 'entrar na conta', 15000);
      if (error) showAuthMessage('Não foi possível entrar. Confira e-mail, senha e confirmação da conta.', true);
    } catch (err) {
      showAuthMessage(err?.message || 'A autenticação demorou demais. Feche e abra o aplicativo e tente novamente.', true);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function createAccount(e) {
    e.preventDefault();
    if (!cloudClient) return;
    hideAuthMessage();
    const email = $('#signupEmail').value.trim();
    const password = $('#signupPassword').value;
    const btn = e.submitter; if (btn) btn.disabled = true;
    try {
      const { data, error } = await withCloudTimeout(cloudClient.auth.signUp({ email, password }), 'criar a conta', 15000);
      if (error) { showAuthMessage(error.message || 'Não foi possível criar a conta.', true); return; }
      if (!data.session) {
        toggleAuthPanel('login');
        showAuthMessage('Conta criada. Verifique seu e-mail para confirmar o cadastro e depois entre aqui.');
      }
    } catch (err) {
      showAuthMessage(err?.message || 'A autenticação demorou demais. Tente novamente.', true);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function handleLoggedIn(user) {
    if (cloudUser?.id === user.id && els.authGate.classList.contains('hidden')) return;
    cloudUser = user;
    els.cloudUserEmail.textContent = user.email || 'Conta conectada';
    els.cloudUser.classList.remove('hidden');
    els.cloudAccountText.textContent = `Conectado como ${user.email || 'usuário'}. Alterações são salvas localmente e sincronizadas com a nuvem.`;
    els.authGate.classList.add('hidden');
    setCloudStatus('Sincronizando...', 'syncing');
    try {
      await bootstrapCloudState();
      repairFarFutureRecurringTransactions(true);
      repairCreditInvoiceCompetence(true);
      ensureRecurringForMonth(currentMonth(), true);
      setCloudStatus('Sincronizado', 'ok');
      startCloudPolling();
    } catch (err) {
      console.error(err);
      setCloudStatus('Erro de sincronização', 'error');
      toast('Login realizado, mas a nuvem ainda não está pronta. Confira o setup do Supabase.');
    }
  }

  function handleLoggedOut() {
    cloudUser = null;
    lastCloudUpdatedAt = null;
    cloudRevision = null;
    lastSyncError = '';
    clearInterval(cloudPollTimer); cloudPollTimer = null;
    els.cloudUser.classList.add('hidden');
    els.cloudAccountText.textContent = 'Conecte sua conta para usar os mesmos dados no iPhone e no computador.';
    setCloudStatus('Aguardando login', 'offline');
    if (isCloudConfigured()) els.authGate.classList.remove('hidden');
  }

  async function signOutCloud() {
    if (!cloudClient) return;
    try {
      if (cloudDirty) await pushCloudState();
      await withCloudTimeout(cloudClient.auth.signOut(), 'sair da conta', 10000);
      toast('Você saiu da conta.');
    } catch (err) {
      toast(err?.message || 'Não foi possível sair da conta agora.');
    }
  }

  async function bootstrapCloudState() {
    if (!cloudClient || !cloudUser) return;

    const revisionAtStart = localRevision;
    const dirtyAtStart = cloudDirty;
    const stateSnapshot = clone(state);
    cloudSyncing = true;

    try {
      const { data, error } = await withCloudTimeout(
        cloudClient
          .from('finance_states')
          .select('state,updated_at,revision')
          .eq('user_id', cloudUser.id)
          .maybeSingle(),
        'carregar seus dados'
      );
      if (error) throw error;

      if (!data) {
        const { data: inserted, error: insertError } = await withCloudTimeout(
          cloudClient
            .from('finance_states')
            .insert({ user_id: cloudUser.id, state: stateSnapshot })
            .select('state,updated_at,revision')
            .single(),
          'criar seu estado financeiro na nuvem'
        );
        if (insertError) throw insertError;
        lastCloudUpdatedAt = inserted.updated_at;
        cloudRevision = Number(inserted.revision || 0);
        if (localRevision === revisionAtStart) setCloudDirty(false);
        lastSyncError = '';
        return;
      }

      lastCloudUpdatedAt = data.updated_at;
      cloudRevision = Number(data.revision || 0);

      // Se havia alteração local pendente antes da carga, ou o usuário alterou
      // algo enquanto a consulta estava em andamento, nunca sobrescreva o local.
      if (dirtyAtStart || cloudDirty || localRevision !== revisionAtStart) {
        setCloudDirty(true);
        return;
      }

      state = normalizeCloudState(data.state);
      saveLocalState();
      setCloudDirty(false);
      lastSyncError = '';
      renderAll();
    } finally {
      cloudSyncing = false;
      if (cloudDirty) scheduleCloudPush();
    }
  }

  function normalizeCloudState(candidate) {
    return normalizeState(candidate);
  }

  function stateSignature(candidate) {
    try { return JSON.stringify(normalizeState(candidate)); }
    catch { return ''; }
  }

  function scheduleCloudPush(delay = 500) {
    if (!cloudClient || !cloudUser) return;
    clearTimeout(cloudPushTimer);
    // Sempre passe pelo coordenador syncNow. Assim, se uma sincronização já
    // estiver em andamento, a nova tentativa fica enfileirada em vez de sumir.
    cloudPushTimer = setTimeout(() => syncNow(), delay);
  }

  function withCloudTimeout(promiseLike, label = 'sincronização', timeoutMs = CLOUD_TIMEOUT_MS) {
    let timer;
    const source = Promise.resolve(promiseLike);
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Tempo limite excedido ao ${label}. Verifique a conexão e tente novamente.`)), timeoutMs);
    });
    return Promise.race([source, timeout]).finally(() => clearTimeout(timer));
  }

  async function readCloudEnvelope() {
    const { data, error } = await withCloudTimeout(
      cloudClient
        .from('finance_states')
        .select('state,updated_at,revision')
        .eq('user_id', cloudUser.id)
        .maybeSingle(),
      'consultar a nuvem'
    );
    if (error) throw error;
    return data;
  }

  async function pushCloudState() {
    if (!cloudClient || !cloudUser || !cloudDirty || !navigator.onLine || cloudSyncing) return;

    const revisionAtStart = localRevision;
    let workingState = clone(state);
    cloudSyncing = true;
    setCloudStatus('Sincronizando...', 'syncing');

    try {
      // A revisão numérica evita usar timestamp como trava de concorrência.
      // O RPC faz a comparação e o update dentro de uma transação no Postgres.
      let remote = await readCloudEnvelope();
      if (!remote) {
        const { data: inserted, error: insertError } = await withCloudTimeout(
          cloudClient
            .from('finance_states')
            .insert({ user_id: cloudUser.id, state: workingState })
            .select('state,updated_at,revision')
            .single(),
          'inicializar a sincronização'
        );
        if (insertError && insertError.code !== '23505') throw insertError;
        remote = insertError ? await readCloudEnvelope() : inserted;
      }
      if (!remote) throw new Error('Não foi possível localizar o estado financeiro na nuvem.');

      let syncedState = null;
      let syncedUpdatedAt = remote.updated_at;
      let expectedRevision = Number(remote.revision || 0);

      for (let attempt = 0; attempt < 6; attempt++) {
        workingState = mergeStates(workingState, remote.state, 'local');

        const { data: result, error: rpcError } = await withCloudTimeout(
          cloudClient
            .rpc('mf_sync_finance_state', {
              p_state: workingState,
              p_expected_revision: expectedRevision
            })
            .single(),
          'enviar alterações'
        );
        if (rpcError) throw rpcError;
        if (!result) throw new Error('O servidor não retornou confirmação da sincronização.');

        const returnedState = normalizeState(result.state || workingState);
        const returnedRevision = Number(result.revision || expectedRevision);
        syncedUpdatedAt = result.updated_at || syncedUpdatedAt;

        if (result.applied) {
          syncedState = returnedState;
          cloudRevision = returnedRevision;
          break;
        }

        // Outro dispositivo gravou primeiro. Use o estado devolvido pelo servidor,
        // faça o merge e tente novamente com a nova revisão, sem perder o local.
        remote = {
          state: returnedState,
          updated_at: result.updated_at,
          revision: returnedRevision
        };
        expectedRevision = returnedRevision;
      }

      if (!syncedState) throw new Error('Houve muitas alterações simultâneas. Tente sincronizar novamente.');

      lastCloudUpdatedAt = syncedUpdatedAt;
      lastSyncError = '';

      if (localRevision === revisionAtStart) {
        state = syncedState;
        saveLocalState();
        setCloudDirty(false);
        renderAll();
        setCloudStatus('Sincronizado', 'ok');
      } else {
        // Houve edição enquanto o request estava em andamento. Preserve e envie em seguida.
        state = mergeStates(state, syncedState, 'local');
        saveLocalState();
        setCloudDirty(true);
        setCloudStatus('Sincronizando alterações recentes...', 'syncing');
      }
    } catch (err) {
      console.error('Erro ao enviar para nuvem:', err);
      lastSyncError = String(err?.message || err || 'Erro desconhecido');
      setCloudDirty(true);
      if (/mf_sync_finance_state|revision/i.test(lastSyncError)) {
        setCloudStatus('Atualização do banco necessária', 'error');
      } else {
        setCloudStatus('Pendente de sincronização', navigator.onLine ? 'error' : 'offline');
      }
    } finally {
      cloudSyncing = false;
      // Qualquer pedido feito enquanto o request estava em andamento é processado
      // logo depois. Isso é importante no iPhone quando o app volta do background.
      const queued = syncRequested;
      syncRequested = false;
      if (navigator.onLine && (queued || cloudDirty)) {
        scheduleCloudPush(lastSyncError ? 2500 : 250);
      }
    }
  }

  async function pullCloudState() {
    if (!cloudClient || !cloudUser || cloudDirty || !navigator.onLine || cloudSyncing) return;

    const revisionAtStart = localRevision;
    cloudSyncing = true;
    try {
      const data = await readCloudEnvelope();

      if (cloudDirty || localRevision !== revisionAtStart) {
        setCloudStatus('Sincronizando alterações locais...', 'syncing');
        return;
      }

      if (!data) return;
      const remoteRevision = Number(data.revision || 0);
      if (cloudRevision !== null && remoteRevision === cloudRevision) return;

      const remoteState = normalizeState(data.state);
      const merged = mergeStates(state, remoteState, 'remote');
      const remoteSig = stateSignature(remoteState);
      const mergedSig = stateSignature(merged);

      state = merged;
      saveLocalState();
      lastCloudUpdatedAt = data.updated_at;
      cloudRevision = remoteRevision;
      lastSyncError = '';

      // Se o merge preservou algo que só existia localmente, envie esse resultado
      // consolidado de volta à nuvem em vez de considerar a sincronização concluída.
      if (mergedSig !== remoteSig) {
        setCloudDirty(true);
        setCloudStatus('Consolidando dados...', 'syncing');
      } else {
        setCloudDirty(false);
      }

      repairFarFutureRecurringTransactions(true);
      repairCreditInvoiceCompetence(true);
      ensureRecurringForMonth(currentMonth(), true);
      renderAll();
      if (!cloudDirty) setCloudStatus('Atualizado da nuvem', 'ok');
    } catch (err) {
      lastSyncError = String(err?.message || err || 'Erro desconhecido');
      console.warn('Falha ao buscar alterações:', lastSyncError);
      setCloudStatus('Falha ao consultar nuvem', navigator.onLine ? 'error' : 'offline');
    } finally {
      cloudSyncing = false;
      const queued = syncRequested;
      syncRequested = false;
      if (navigator.onLine && (queued || cloudDirty || localRevision !== revisionAtStart)) {
        scheduleCloudPush(lastSyncError ? 2500 : 250);
      }
    }
  }

  async function syncNow() {
    if (!cloudClient || !cloudUser) { toast('Entre na sua conta para sincronizar.'); return; }
    if (!navigator.onLine) { setCloudStatus('Sem internet • dados salvos localmente', 'offline'); return; }
    if (cloudSyncing) {
      syncRequested = true;
      setCloudStatus('Sincronização na fila...', 'syncing');
      return;
    }
    syncRequested = false;
    if (cloudDirty) await pushCloudState();
    else await pullCloudState();
    if (!cloudDirty && !cloudSyncing) {
      lastSyncError = '';
      setCloudStatus('Sincronizado', 'ok');
    } else if (cloudDirty && lastSyncError) {
      toast(`Sincronização pendente: ${lastSyncError.slice(0,120)}`);
    }
  }

  function startCloudPolling() {
    clearInterval(cloudPollTimer);
    cloudPollTimer = setInterval(() => { if (!document.hidden) syncNow(); }, 15000);
  }

  function setCloudStatus(text, mode='ok') {
    if (els.syncStatusText) {
      els.syncStatusText.textContent = text;
      els.syncStatusText.title = lastSyncError || '';
    }
    document.body.classList.toggle('syncing', mode === 'syncing');
    document.body.classList.toggle('sync-error', mode === 'error');
    document.body.classList.toggle('sync-offline', mode === 'offline');
  }

  function registerPwa(){
    const installBtn = $('#installBtn');
    const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
    const servedOverWeb = location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';

    // v2.8.4: Safari/iOS — não registre Service Worker.
    // O app depende do Supabase e prioriza estabilidade online. Remova qualquer
    // worker antigo que ainda possa estar controlando esta origem.
    if ('serviceWorker' in navigator && servedOverWeb) {
      navigator.serviceWorker.getRegistrations().then(regs => {
        regs.forEach(reg => reg.unregister().catch(()=>{}));
      }).catch(()=>{});
    }

    if (isStandalone) {
      installBtn.classList.add('hidden');
      return;
    }

    if (isIos) {
      installBtn.textContent = 'Instalar no iPhone';
      installBtn.classList.remove('hidden');
      installBtn.addEventListener('click', () => {
        if (!servedOverWeb) {
          alert('No iPhone, este aplicativo precisa ser aberto por um endereço HTTPS. Publique a pasta em uma hospedagem gratuita e abra o link no Safari.');
          return;
        }
        showDialog(els.iosInstallModal);
      });
      return;
    }

    window.addEventListener('beforeinstallprompt', e => {
      e.preventDefault();
      deferredInstallPrompt=e;
      installBtn.classList.remove('hidden');
    });
    installBtn.addEventListener('click', async()=>{
      if(!deferredInstallPrompt)return;
      deferredInstallPrompt.prompt();
      await deferredInstallPrompt.userChoice;
      deferredInstallPrompt=null;
      installBtn.classList.add('hidden');
    });
  }

  window.addEventListener('resize', ()=> { if ($('#dashboard').classList.contains('active')) renderDashboard(); });
})();
