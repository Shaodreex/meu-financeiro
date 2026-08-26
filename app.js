(() => {
  'use strict';

  const STORAGE_KEY = 'meuFinanceiroStateV1';
  const uid = () => (crypto?.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const money = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
  const shortDate = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit' });

  const DEFAULT_STATE = {
    version: 1,
    categories: ['Moradia','Alimentação','Transporte','Saúde','Educação','Lazer','Assinaturas','Compras','Impostos e taxas','Dívidas','Investimentos','Outros'],
    accounts: [],
    transactions: [],
    recurring: []
  };

  let state = loadState();
  let deferredInstallPrompt = null;

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  const els = {
    sidebar: $('#sidebar'), pageTitle: $('#pageTitle'), monthFilter: $('#monthFilter'),
    availableBalance: $('#availableBalance'), monthIncome: $('#monthIncome'), monthExpense: $('#monthExpense'),
    monthPending: $('#monthPending'), monthBalance: $('#monthBalance'), incomeCount: $('#incomeCount'),
    expenseCount: $('#expenseCount'), pendingCount: $('#pendingCount'), pendingList: $('#pendingList'),
    recentTransactions: $('#recentTransactions'), categoryChart: $('#categoryChart'), emptyChart: $('#emptyChart'),
    transactionsTable: $('#transactionsTable'), transactionsEmpty: $('#transactionsEmpty'),
    transactionSearch: $('#transactionSearch'), typeFilter: $('#typeFilter'), statusFilter: $('#statusFilter'),
    recurringGrid: $('#recurringGrid'), recurringEmpty: $('#recurringEmpty'),
    accountsGrid: $('#accountsGrid'), accountsTotal: $('#accountsTotal'), categoryTags: $('#categoryTags'),
    transactionModal: $('#transactionModal'), recurringModal: $('#recurringModal'), accountModal: $('#accountModal'),
    iosInstallModal: $('#iosInstallModal'),
    modalBackdrop: $('#modalBackdrop'), toast: $('#toast')
  };

  init();

  function init() {
    els.monthFilter.value = currentMonth();
    bindNavigation();
    bindModals();
    bindActions();
    renderAll();
    registerPwa();
  }

  function clone(obj) { return JSON.parse(JSON.stringify(obj)); }
  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return clone(DEFAULT_STATE);
      const parsed = JSON.parse(raw);
      if (!parsed || parsed.version !== 1) return clone(DEFAULT_STATE);
      return parsed;
    } catch { return clone(DEFAULT_STATE); }
  }
  function saveState() { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }

  function currentMonth() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
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
  function escapeHtml(s='') { return String(s).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }

  function bindNavigation() {
    $$('.nav-item').forEach(btn => btn.addEventListener('click', () => showView(btn.dataset.view)));
    $$('[data-go]').forEach(btn => btn.addEventListener('click', () => showView(btn.dataset.go)));
    $('#menuBtn').addEventListener('click', () => els.sidebar.classList.toggle('open'));
    document.addEventListener('click', e => {
      if (window.innerWidth <= 760 && els.sidebar.classList.contains('open') && !els.sidebar.contains(e.target) && e.target.id !== 'menuBtn') els.sidebar.classList.remove('open');
    });
    els.monthFilter.addEventListener('change', renderAll);
  }
  function showView(view) {
    const titles = { dashboard:'Visão geral', transactions:'Lançamentos', recurring:'Recorrentes', accounts:'Recursos', settings:'Configurações' };
    $$('.view').forEach(v => v.classList.toggle('active', v.id === view));
    $$('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.view === view));
    els.pageTitle.textContent = titles[view] || 'Meu Financeiro';
    els.sidebar.classList.remove('open');
    if (view === 'transactions') renderTransactions();
    if (view === 'recurring') renderRecurring();
    if (view === 'accounts') renderAccounts();
    if (view === 'settings') renderSettings();
  }

  function bindActions() {
    $('#quickAddBtn').addEventListener('click', () => openTransaction());
    $('#transactionSearch').addEventListener('input', renderTransactions);
    $('#typeFilter').addEventListener('change', renderTransactions);
    $('#statusFilter').addEventListener('change', renderTransactions);
    $('#exportCsvBtn').addEventListener('click', exportCsv);
    $('#addRecurringBtn').addEventListener('click', () => openRecurring());
    $('#generateRecurringBtn').addEventListener('click', generateRecurringForMonth);
    $('#addAccountBtn').addEventListener('click', () => openAccount());
    $('#categoryForm').addEventListener('submit', addCategory);
    $('#backupBtn').addEventListener('click', downloadBackup);
    $('#restoreInput').addEventListener('change', restoreBackup);
    $('#resetBtn').addEventListener('click', resetData);

    $('#transactionForm').addEventListener('submit', saveTransaction);
    $('#recurringForm').addEventListener('submit', saveRecurring);
    $('#accountForm').addEventListener('submit', saveAccount);
  }

  function bindModals() {
    $$('.close-modal').forEach(b => b.addEventListener('click', () => closeDialog(els.transactionModal)));
    $$('.close-recurring').forEach(b => b.addEventListener('click', () => closeDialog(els.recurringModal)));
    $$('.close-account').forEach(b => b.addEventListener('click', () => closeDialog(els.accountModal)));
    els.modalBackdrop.addEventListener('click', closeAllDialogs);
    [els.transactionModal, els.recurringModal, els.accountModal, els.iosInstallModal].forEach(d => d.addEventListener('close', updateBackdrop));
    $$('.close-ios-install').forEach(b => b.addEventListener('click', () => closeDialog(els.iosInstallModal)));
  }
  function showDialog(d) { els.modalBackdrop.classList.remove('hidden'); if (!d.open) d.showModal(); }
  function closeDialog(d) { if (d.open) d.close(); updateBackdrop(); }
  function closeAllDialogs() { [els.transactionModal, els.recurringModal, els.accountModal, els.iosInstallModal].forEach(d => { if (d.open) d.close(); }); updateBackdrop(); }
  function updateBackdrop() { if (![els.transactionModal,els.recurringModal,els.accountModal,els.iosInstallModal].some(d => d.open)) els.modalBackdrop.classList.add('hidden'); }

  function renderAll() {
    renderDashboard(); renderTransactions(); renderRecurring(); renderAccounts(); renderSettings(); populateCategorySelects();
  }

  function dashboardTransactions() { return state.transactions.filter(t => monthOf(t.date) === selectedMonth()); }
  function renderDashboard() {
    const tx = dashboardTransactions();
    const paid = tx.filter(t => t.status === 'paid');
    const income = paid.filter(t => t.type === 'income');
    const expense = paid.filter(t => t.type === 'expense');
    const pending = tx.filter(t => t.status === 'pending');
    const incomeTotal = sum(income.map(t=>t.amount));
    const expenseTotal = sum(expense.map(t=>t.amount));
    const pendingTotal = sum(pending.map(t=>t.amount));
    const available = sum(state.accounts.map(a=>a.balance));
    els.availableBalance.textContent = money.format(available);
    els.monthIncome.textContent = money.format(incomeTotal);
    els.monthExpense.textContent = money.format(expenseTotal);
    els.monthPending.textContent = money.format(pendingTotal);
    els.monthBalance.textContent = `Saldo do mês ${money.format(incomeTotal - expenseTotal)}`;
    els.incomeCount.textContent = `${income.length} ${income.length === 1 ? 'recebimento' : 'recebimentos'}`;
    els.expenseCount.textContent = `${expense.length} ${expense.length === 1 ? 'pagamento' : 'pagamentos'}`;
    els.pendingCount.textContent = `${pending.length} ${pending.length === 1 ? 'conta' : 'contas'}`;
    renderPending(pending);
    renderRecent();
    drawCategoryChart(expense);
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
    els.recentTransactions.innerHTML = list.map(t => `<div class="transaction-row"><div class="tx-icon ${t.type}">${t.type === 'expense' ? '−' : '+'}</div><div class="tx-main"><strong>${escapeHtml(t.description)}</strong><span>${formatDate(t.date)} • ${escapeHtml(t.category)} • ${t.status === 'paid' ? 'Pago/Recebido' : 'Pendente'}</span></div><div class="tx-value"><strong>${t.type === 'expense' ? '− ' : '+ '}${money.format(t.amount)}</strong><span>${escapeHtml(t.payment || 'Outro')}</span></div></div>`).join('');
  }

  function drawCategoryChart(expenses) {
    const totals = {};
    expenses.forEach(t => totals[t.category] = (totals[t.category] || 0) + t.amount);
    const data = Object.entries(totals).sort((a,b)=>b[1]-a[1]).slice(0,7);
    const canvas = els.categoryChart;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const cssWidth = canvas.clientWidth || 760, cssHeight = 290;
    canvas.width = Math.floor(cssWidth*dpr); canvas.height = Math.floor(cssHeight*dpr); ctx.scale(dpr,dpr);
    ctx.clearRect(0,0,cssWidth,cssHeight);
    els.emptyChart.classList.toggle('hidden', data.length > 0);
    if (!data.length) return;
    const max = Math.max(...data.map(d=>d[1]));
    const left = Math.min(150, cssWidth * .28), right=92, top=16, rowH=38, barH=13;
    ctx.font='12px system-ui'; ctx.textBaseline='middle';
    data.forEach(([label,value],i)=>{
      const y = top + i*rowH + 15;
      ctx.fillStyle='#64748b';
      let shown=label; while(ctx.measureText(shown).width>left-16 && shown.length>4) shown=shown.slice(0,-2); if(shown!==label) shown+='…';
      ctx.fillText(shown,0,y);
      const x=left, w=Math.max(3,(cssWidth-left-right)*(value/max));
      ctx.fillStyle='#e8edf3'; roundRect(ctx,x,y-barH/2,cssWidth-left-right,barH,7); ctx.fill();
      ctx.fillStyle='#334155'; roundRect(ctx,x,y-barH/2,w,barH,7); ctx.fill();
      ctx.fillStyle='#111827'; ctx.textAlign='right'; ctx.font='600 11px system-ui'; ctx.fillText(money.format(value),cssWidth-2,y); ctx.textAlign='left'; ctx.font='12px system-ui';
    });
  }
  function roundRect(ctx,x,y,w,h,r){const rr=Math.min(r,w/2,h/2);ctx.beginPath();ctx.moveTo(x+rr,y);ctx.arcTo(x+w,y,x+w,y+h,rr);ctx.arcTo(x+w,y+h,x,y+h,rr);ctx.arcTo(x,y+h,x,y,rr);ctx.arcTo(x,y,x+w,y,rr);ctx.closePath();}

  function filteredTransactions() {
    const q = els.transactionSearch.value.trim().toLowerCase();
    return state.transactions.filter(t => monthOf(t.date) === selectedMonth())
      .filter(t => !els.typeFilter.value || t.type === els.typeFilter.value)
      .filter(t => !els.statusFilter.value || t.status === els.statusFilter.value)
      .filter(t => !q || `${t.description} ${t.category} ${t.payment}`.toLowerCase().includes(q))
      .sort((a,b)=>b.date.localeCompare(a.date));
  }
  function renderTransactions() {
    const list = filteredTransactions();
    els.transactionsEmpty.classList.toggle('hidden', list.length > 0);
    els.transactionsTable.innerHTML = list.map(t => `<tr><td>${formatDate(t.date)}</td><td><strong>${escapeHtml(t.description)}</strong></td><td>${escapeHtml(t.category)}</td><td>${escapeHtml(t.payment || '—')}</td><td><span class="status ${t.status}">${t.status === 'paid' ? 'Pago / Recebido' : 'Pendente'}</span></td><td class="right"><strong>${t.type === 'expense' ? '− ' : '+ '}${money.format(t.amount)}</strong></td><td><div class="row-actions"><button class="mini-btn" data-action="toggle-paid" data-id="${t.id}" title="Alterar status">✓</button><button class="mini-btn" data-action="edit-tx" data-id="${t.id}" title="Editar">✎</button><button class="mini-btn" data-action="delete-tx" data-id="${t.id}" title="Excluir">×</button></div></td></tr>`).join('');
    $$('[data-action="edit-tx"]').forEach(b=>b.addEventListener('click',()=>openTransaction(b.dataset.id)));
    $$('[data-action="delete-tx"]').forEach(b=>b.addEventListener('click',()=>deleteTransaction(b.dataset.id)));
    $$('[data-action="toggle-paid"]').forEach(b=>b.addEventListener('click',()=>toggleTransactionStatus(b.dataset.id)));
  }

  function populateCategorySelects() {
    ['#txCategory','#recCategory'].forEach(sel => {
      const node=$(sel); const current=node.value;
      node.innerHTML=state.categories.map(c=>`<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
      if (state.categories.includes(current)) node.value=current;
    });
  }
  function openTransaction(id=null) {
    populateCategorySelects();
    $('#transactionForm').reset(); $('#transactionId').value=''; $('#txDate').value = new Date().toISOString().slice(0,10); $('#txStatus').value='paid';
    $('#transactionModalTitle').textContent = id ? 'Editar lançamento' : 'Novo lançamento';
    if (id) {
      const t=state.transactions.find(x=>x.id===id); if(!t)return;
      $('#transactionId').value=t.id; $(`input[name="txType"][value="${t.type}"]`).checked=true; $('#txDate').value=t.date; $('#txAmount').value=formatInputAmount(t.amount); $('#txDescription').value=t.description; $('#txCategory').value=t.category; $('#txPayment').value=t.payment || 'Outro'; $('#txStatus').value=t.status; $('#txDueDate').value=t.dueDate||''; $('#txNotes').value=t.notes||'';
    }
    showDialog(els.transactionModal); setTimeout(()=>$('#txAmount').focus(),80);
  }
  function saveTransaction(e) {
    e.preventDefault();
    const amount=parseAmount($('#txAmount').value); if(!(amount>0)){toast('Informe um valor válido.');return;}
    const id=$('#transactionId').value || uid();
    const existing=state.transactions.find(t=>t.id===id);
    const tx={ id, date:$('#txDate').value, type:$('input[name="txType"]:checked').value, description:$('#txDescription').value.trim(), category:$('#txCategory').value, amount, status:$('#txStatus').value, payment:$('#txPayment').value, dueDate:$('#txDueDate').value, notes:$('#txNotes').value.trim(), recurringId: existing?.recurringId || null };
    const idx=state.transactions.findIndex(t=>t.id===id); if(idx>=0)state.transactions[idx]=tx;else state.transactions.push(tx);
    saveState(); closeDialog(els.transactionModal); renderAll(); toast(idx>=0?'Lançamento atualizado.':'Lançamento salvo.');
  }
  function deleteTransaction(id){const t=state.transactions.find(x=>x.id===id);if(!t)return;if(!confirm(`Excluir “${t.description}”?`))return;state.transactions=state.transactions.filter(x=>x.id!==id);saveState();renderAll();toast('Lançamento excluído.');}
  function toggleTransactionStatus(id){const t=state.transactions.find(x=>x.id===id);if(!t)return;t.status=t.status==='paid'?'pending':'paid';saveState();renderAll();toast(t.status==='paid'?'Marcado como pago/recebido.':'Marcado como pendente.');}

  function renderRecurring() {
    els.recurringEmpty.classList.toggle('hidden', state.recurring.length > 0);
    els.recurringGrid.innerHTML = state.recurring.map(r=>`<article class="card data-card"><div class="data-card-head"><div><strong>${escapeHtml(r.description)}</strong><span>${r.type==='expense'?'Despesa':'Receita'} • dia ${r.day}</span></div><span class="status ${r.active?'paid':'pending'}">${r.active?'Ativa':'Pausada'}</span></div><div class="data-card-value">${money.format(r.amount)}</div><div class="data-card-foot"><span>${escapeHtml(r.category)} • ${escapeHtml(r.payment)}</span><div class="row-actions"><button class="mini-btn" data-rec-edit="${r.id}">✎</button><button class="mini-btn" data-rec-delete="${r.id}">×</button></div></div></article>`).join('');
    $$('[data-rec-edit]').forEach(b=>b.addEventListener('click',()=>openRecurring(b.dataset.recEdit)));
    $$('[data-rec-delete]').forEach(b=>b.addEventListener('click',()=>deleteRecurring(b.dataset.recDelete)));
  }
  function openRecurring(id=null){populateCategorySelects();$('#recurringForm').reset();$('#recurringId').value='';$('#recActive').checked=true;$('#recurringModalTitle').textContent=id?'Editar recorrência':'Nova recorrência';if(id){const r=state.recurring.find(x=>x.id===id);if(!r)return;$('#recurringId').value=r.id;$('#recType').value=r.type;$('#recDay').value=r.day;$('#recDescription').value=r.description;$('#recCategory').value=r.category;$('#recAmount').value=formatInputAmount(r.amount);$('#recPayment').value=r.payment;$('#recActive').checked=r.active;}showDialog(els.recurringModal);}
  function saveRecurring(e){e.preventDefault();const amount=parseAmount($('#recAmount').value);const day=Number($('#recDay').value);if(!(amount>0)||day<1||day>31){toast('Confira o valor e o dia do mês.');return;}const id=$('#recurringId').value||uid();const r={id,type:$('#recType').value,day,description:$('#recDescription').value.trim(),category:$('#recCategory').value,amount,payment:$('#recPayment').value,active:$('#recActive').checked};const idx=state.recurring.findIndex(x=>x.id===id);if(idx>=0)state.recurring[idx]=r;else state.recurring.push(r);saveState();closeDialog(els.recurringModal);renderAll();toast(idx>=0?'Recorrência atualizada.':'Recorrência cadastrada.');}
  function deleteRecurring(id){const r=state.recurring.find(x=>x.id===id);if(!r||!confirm(`Excluir a recorrência “${r.description}”?`))return;state.recurring=state.recurring.filter(x=>x.id!==id);saveState();renderAll();toast('Recorrência excluída.');}
  function generateRecurringForMonth(){const month=selectedMonth();const [year,mo]=month.split('-').map(Number);let created=0;state.recurring.filter(r=>r.active).forEach(r=>{if(state.transactions.some(t=>t.recurringId===r.id&&monthOf(t.date)===month))return;const lastDay=new Date(year,mo,0).getDate();const day=Math.min(r.day,lastDay);state.transactions.push({id:uid(),date:`${month}-${String(day).padStart(2,'0')}`,type:r.type,category:r.category,description:r.description,amount:r.amount,status:'pending',payment:r.payment,dueDate:`${month}-${String(day).padStart(2,'0')}`,notes:'Gerado a partir de recorrência',recurringId:r.id});created++;});saveState();renderAll();toast(created?`${created} lançamento(s) gerado(s) para ${monthLabel(month)}.`:'Nada novo para gerar neste mês.');}

  function renderAccounts(){const total=sum(state.accounts.map(a=>a.balance));els.accountsTotal.textContent=money.format(total);els.accountsGrid.innerHTML=state.accounts.map(a=>`<article class="card data-card"><div class="data-card-head"><div><strong>${escapeHtml(a.name)}</strong><span>Recurso disponível</span></div><div class="row-actions"><button class="mini-btn" data-acc-edit="${a.id}">✎</button><button class="mini-btn" data-acc-delete="${a.id}">×</button></div></div><div class="data-card-value">${money.format(a.balance)}</div><div class="data-card-foot"><span>Atualize quando necessário</span><span>posição manual</span></div></article>`).join('');$$('[data-acc-edit]').forEach(b=>b.addEventListener('click',()=>openAccount(b.dataset.accEdit)));$$('[data-acc-delete]').forEach(b=>b.addEventListener('click',()=>deleteAccount(b.dataset.accDelete)));}
  function openAccount(id=null){$('#accountForm').reset();$('#accountId').value='';$('#accountModalTitle').textContent=id?'Editar recurso':'Novo recurso';if(id){const a=state.accounts.find(x=>x.id===id);if(!a)return;$('#accountId').value=a.id;$('#accountName').value=a.name;$('#accountBalance').value=formatInputAmount(a.balance);}showDialog(els.accountModal);}
  function saveAccount(e){e.preventDefault();const balance=parseAmount($('#accountBalance').value);if(!Number.isFinite(balance)){toast('Informe um valor válido.');return;}const id=$('#accountId').value||uid();const item={id,name:$('#accountName').value.trim(),balance};const idx=state.accounts.findIndex(x=>x.id===id);if(idx>=0)state.accounts[idx]=item;else state.accounts.push(item);saveState();closeDialog(els.accountModal);renderAll();toast(idx>=0?'Recurso atualizado.':'Recurso adicionado.');}
  function deleteAccount(id){const a=state.accounts.find(x=>x.id===id);if(!a||!confirm(`Excluir o recurso “${a.name}”?`))return;state.accounts=state.accounts.filter(x=>x.id!==id);saveState();renderAll();toast('Recurso excluído.');}

  function renderSettings(){els.categoryTags.innerHTML=state.categories.map(c=>`<span class="tag">${escapeHtml(c)}<button data-cat-delete="${escapeHtml(c)}" title="Excluir">×</button></span>`).join('');$$('[data-cat-delete]').forEach(b=>b.addEventListener('click',()=>deleteCategory(b.dataset.catDelete)));}
  function addCategory(e){e.preventDefault();const input=$('#newCategory');const name=input.value.trim();if(!name)return;if(state.categories.some(c=>c.toLowerCase()===name.toLowerCase())){toast('Essa categoria já existe.');return;}state.categories.push(name);state.categories.sort((a,b)=>a.localeCompare(b,'pt-BR'));input.value='';saveState();renderAll();toast('Categoria adicionada.');}
  function deleteCategory(name){if(state.categories.length<=1){toast('Mantenha pelo menos uma categoria.');return;}if(!confirm(`Remover a categoria “${name}”? Lançamentos antigos continuarão com esse nome.`))return;state.categories=state.categories.filter(c=>c!==name);saveState();renderAll();toast('Categoria removida.');}

  function exportCsv(){const list=filteredTransactions();const rows=[['Data','Tipo','Categoria','Descrição','Valor','Status','Forma de pagamento','Vencimento','Observação'],...list.map(t=>[t.date,t.type==='expense'?'Despesa':'Receita',t.category,t.description,t.amount.toFixed(2).replace('.',','),t.status==='paid'?'Pago/Recebido':'Pendente',t.payment,t.dueDate||'',t.notes||''])];const csv='\ufeff'+rows.map(r=>r.map(v=>`"${String(v??'').replace(/"/g,'""')}"`).join(';')).join('\r\n');downloadBlob(new Blob([csv],{type:'text/csv;charset=utf-8'}),`lancamentos-${selectedMonth()}.csv`);toast('CSV exportado.');}
  function downloadBackup(){const payload={app:'Meu Financeiro',exportedAt:new Date().toISOString(),state};downloadBlob(new Blob([JSON.stringify(payload,null,2)],{type:'application/json'}),`meu-financeiro-backup-${new Date().toISOString().slice(0,10)}.json`);toast('Backup baixado.');}
  function restoreBackup(e){const file=e.target.files?.[0];if(!file)return;const reader=new FileReader();reader.onload=()=>{try{const parsed=JSON.parse(reader.result);const candidate=parsed.state||parsed;if(!candidate||candidate.version!==1||!Array.isArray(candidate.transactions)||!Array.isArray(candidate.accounts))throw new Error('Formato inválido');if(!confirm('Restaurar este backup substituirá os dados atuais. Continuar?'))return;state=candidate;saveState();renderAll();toast('Backup restaurado.');}catch{alert('Não foi possível restaurar este arquivo de backup.');}finally{e.target.value='';}};reader.readAsText(file);}
  function resetData(){if(!confirm('Isso substituirá seus dados atuais pela posição inicial importada da planilha. Deseja continuar?'))return;state=clone(DEFAULT_STATE);saveState();renderAll();toast('Sistema reiniciado.');}
  function downloadBlob(blob,filename){const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=filename;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  function toast(message){els.toast.textContent=message;els.toast.classList.remove('hidden');clearTimeout(toast.timer);toast.timer=setTimeout(()=>els.toast.classList.add('hidden'),2600);}

  function registerPwa(){
    const installBtn = $('#installBtn');
    const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
    const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
    const servedOverWeb = location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';

    if ('serviceWorker' in navigator && servedOverWeb) navigator.serviceWorker.register('./sw.js').catch(()=>{});

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
