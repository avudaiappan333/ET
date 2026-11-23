/* Engada Pochu: local-only browser app. Amounts are integer paise; never sent to a server. */
(() => {
  'use strict';
  const KEY = 'engada-pochu.transactions.v1';
  const SETTINGS = 'engada-pochu.settings.v1';
  const $ = (id) => document.getElementById(id);
  const types = ['SENT', 'RECEIVED', 'EXPENSE', 'LENT', 'BORROWED', 'REFUND'];
  const labels = { SENT: 'Sent · அனுப்பியது', RECEIVED: 'Received · பெற்றது', EXPENSE: 'Expense · செலவு', LENT: 'Lent · கொடுத்தது', BORROWED: 'Borrowed · பெற்றது', REFUND: 'Refund · திரும்பப் பெற்றது' };
  let transactions = loadTransactions();
  let pending = null;
  let editId = null;
  let recognition = null;
  let undoTimer;
  let theme = localStorage.getItem(SETTINGS) || 'light';

  function loadTransactions() {
    try {
      const raw = JSON.parse(localStorage.getItem(KEY) || '[]');
      return Array.isArray(raw) ? raw.filter(isValidTx) : [];
    } catch (_) { return []; }
  }
  function persist() { localStorage.setItem(KEY, JSON.stringify(transactions)); }
  function isValidTx(t) {
    return t && typeof t.id === 'string' && types.includes(t.type) && Number.isSafeInteger(t.amountMinor) && t.amountMinor > 0 && typeof t.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(t.date) && typeof t.time === 'string' && /^\d{2}:\d{2}$/.test(t.time) && typeof t.person === 'string' && typeof t.category === 'string' && typeof t.note === 'string' && typeof t.deleted === 'boolean';
  }
  const active = () => transactions.filter(t => !t.deleted);
  function money(minor) { return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2 }).format(minor / 100); }
  function escapeText(s) { return String(s ?? ''); }
  function today() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
  function toast(text, undo) {
    const box = $('toast'); box.replaceChildren(); box.hidden = false;
    const span = document.createElement('span'); span.textContent = text; box.append(span);
    if (undo) { const b = document.createElement('button'); b.type = 'button'; b.textContent = 'Undo'; b.className = 'toast-undo'; b.onclick = undo; box.append(b); }
    clearTimeout(undoTimer); undoTimer = setTimeout(() => { box.hidden = true; }, undo ? 7000 : 3200);
  }
  function norm(s) { return s.toLowerCase().replace(/[’']/g, ' ').replace(/\s+/g, ' ').trim(); }
  function parseCommand(raw) {
    const s = norm(raw); if (!s) return { error: 'Enter a transaction to review.' };
    const amounts = [...s.matchAll(/(?:₹\s*)?(\d+(?:,\d{3})*(?:\.\d{1,2})?)/g)].map(m => ({ n: Number(m[1].replace(/,/g,'')), index: m.index, length: m[0].length }));
    if (amounts.length !== 1) return { error: amounts.length ? 'I found more than one amount. Please enter one transaction at a time.' : 'I could not find an amount. Add an amount before reviewing.' };
    const a = amounts[0]; if (!Number.isFinite(a.n) || a.n <= 0 || !Number.isSafeInteger(Math.round(a.n*100))) return { error: 'Amount must be greater than zero and within the supported range.' };
    const patterns = [
      ['RECEIVED', /\b(received|got|collected)\b|\b(kitta|kitta irundhu)\b.*\b(vanginen|vaanginen|vanginom)\b/],
      ['REFUND', /\b(refund|returned|return(ed)?|thiruppi)\b/],
      ['EXPENSE', /\b(paid|spent|spend|expense|bought)\b|\b(selavu|spend panninen)\b/],
      ['LENT', /\b(lent|loaned)\b|\b(kuduthen|koduthen)\b/],
      ['BORROWED', /\b(borrowed|borrow)\b|\b(kadan vaanginen)\b/],
      ['SENT', /\b(sent|send|transferred|gave)\b|\b(ku|kku)\b.*\b(anuppinen|anuppinom)\b|\b(anuppinen|koduthen|kuduthen)\b/]
    ];
    const found = patterns.filter(([, re]) => re.test(s)).map(([t]) => t);
    if (found.length !== 1) return { error: found.length ? 'This command could mean more than one transaction type. Please use the type selector.' : 'I could not identify the transaction type. Try “sent 500 to Ravi” or select a type manually.' };
    const type = found[0];
    let person = '';
    const englishPerson = s.match(/\b(?:to|from|for|by)\s+(.+?)\s*$/);
    if (englishPerson && type !== 'EXPENSE') person = englishPerson[1].replace(/[.!?]+$/,'').trim();
    if (!person && ['SENT','RECEIVED','LENT','BORROWED','REFUND'].includes(type)) {
      const parts = s.replace(a[0], ' ').replace(/\b(sent|send|transferred|gave|received|got|collected|lent|loaned|borrowed|borrow|returned|return|refund|to|from|for|ku|kku|kitta|irundhu|anuppinen|anuppinom|vanginen|vaanginen|vanginom|kuduthen|koduthen|thiruppi)\b/g,' ').replace(/\s+/g,' ').trim();
      person = parts;
    }
    person = person.replace(/\b\d+(?:\.\d+)?\b/g,'').replace(/\s+/g,' ').trim();
    if (type !== 'EXPENSE' && !person) return { error: 'I could not identify the person. Add a name in the Person field.' };
    if (type === 'EXPENSE' && !person) person = '';
    const categoryMatch = s.match(/\b(?:for|on|ku)\s+([a-z][a-z &-]{1,40})$/i);
    return { type, amountMinor: Math.round(a.n*100), person: person.replace(/\b\d+\b/g,'').trim(), category: type === 'EXPENSE' && categoryMatch ? categoryMatch[1].trim() : '', note: '', date: today(), time: new Date().toTimeString().slice(0,5), source: 'VOICE', originalText: raw };
  }
  function makeDraft() {
    const type = $('type').value;
    const amount = $('amount').value.trim();
    if (!/^(?:\d+)(?:\.\d{1,2})?$/.test(amount)) throw new Error('Enter a valid positive amount (up to two decimal places).');
    const amountNumber = Number(amount); const amountMinor = Math.round(amountNumber * 100);
    if (!(amountMinor > 0) || !Number.isSafeInteger(amountMinor)) throw new Error('Amount must be greater than zero and within the supported range.');
    if (type !== 'EXPENSE' && !$('person').value.trim()) throw new Error('Enter a person for this transaction type.');
    const date = $('date').value; const time = $('time').value;
    if (!date || Number.isNaN(Date.parse(`${date}T00:00:00`)) || new Date(`${date}T00:00:00`).toISOString().slice(0,10) !== date) throw new Error('Enter a valid transaction date.');
    if (!/^\d{2}:\d{2}$/.test(time)) throw new Error('Enter a valid transaction time.');
    return { type, amountMinor, person: $('person').value.trim(), category: $('category').value.trim(), note: $('note').value.trim(), date, time, source: 'MANUAL', originalText: null };
  }
  function fillForm(d) {
    $('type').value = d.type; $('amount').value = (d.amountMinor/100).toFixed(2); $('person').value = d.person || '';
    $('category').value = d.category || ''; $('note').value = d.note || ''; $('date').value = d.date; $('time').value = d.time;
  }
  function sentence(d) {
    const amount = money(d.amountMinor), person = d.person ? ` ${d.person}` : '';
    const phr = { SENT: `You are sending ${amount} to${person}.`, RECEIVED: `You received ${amount} from${person}.`, EXPENSE: `You are recording an expense of ${amount}${d.category ? ` for ${d.category}` : ''}.`, LENT: `You lent ${amount} to${person}.`, BORROWED: `You borrowed ${amount}${person ? ` from${person}` : ''}.`, REFUND: `You recorded a refund of ${amount}${person ? ` from${person}` : ''}.` };
    return `${phr[d.type]} Save this transaction?`;
  }
  function duplicates(d) {
    const stamp = new Date(`${d.date}T${d.time}:00`).getTime();
    return active().filter(t => t.id !== editId && t.type === d.type && t.amountMinor === d.amountMinor && t.person.toLowerCase() === d.person.toLowerCase() && Math.abs(new Date(`${t.date}T${t.time}:00`).getTime()-stamp) <= 5*60*1000);
  }
  function showReview(d) {
    pending = d;
    $('review-sentence').textContent = sentence(d);
    $('review-fields').replaceChildren();
    const fields = [['Type', labels[d.type]], ['Amount', money(d.amountMinor)], ['Person', d.person || '—'], ['Category', d.category || '—'], ['Date and time', `${d.date} · ${d.time}`], ['Note', d.note || '—'], ['Source', d.source === 'VOICE' ? 'Voice' : 'Manual']];
    fields.forEach(([k,v]) => { const row=document.createElement('div'); row.className='review-cell'; const b=document.createElement('b'); b.textContent=k; const span=document.createElement('span'); span.textContent=v; row.append(b,span); $('review-fields').append(row); });
    const dup = duplicates(d); $('duplicate-warning').hidden = !dup.length;
    if (dup.length) $('duplicate-warning').textContent = 'A similar transaction exists within five minutes. Confirm again only if this is a separate transaction.';
    $('review-section').hidden = false; $('review-section').scrollIntoView({behavior:'smooth',block:'center'});
  }
  function clearForm() { $('entry-form').reset(); $('date').value = today(); $('time').value = new Date().toTimeString().slice(0,5); editId = null; }
  function confirmSave() {
    if (!pending) return;
    const dup = duplicates(pending);
    if (dup.length && !$('duplicate-warning').dataset.confirmed) { $('duplicate-warning').dataset.confirmed='yes'; $('duplicate-warning').textContent += ' Press Confirm and save once more to proceed.'; return; }
    const now = Date.now();
    if (editId) {
      const old = transactions.find(t => t.id === editId); if (!old) return;
      Object.assign(old, pending, { updatedAt: now });
      toast('Transaction updated.');
    } else {
      transactions.unshift({ ...pending, id: crypto.randomUUID ? crypto.randomUUID() : `tx-${now}-${Math.random().toString(16).slice(2)}`, createdAt: now, updatedAt: now, deleted: false });
      toast('Transaction saved.');
      if ('speechSynthesis' in window) { const settings=JSON.parse(localStorage.getItem(SETTINGS+'-options')||'{}'); if(settings.tts) speechSynthesis.speak(new SpeechSynthesisUtterance('Transaction saved')); }
    }
    persist(); $('review-section').hidden = true; $('duplicate-warning').dataset.confirmed=''; pending=null; clearForm(); render();
  }
  function editTx(id) { const t=transactions.find(x=>x.id===id); if(!t)return; editId=id; fillForm(t); $('entry-form').scrollIntoView({behavior:'smooth'}); $('app-status').textContent='Editing transaction. Review changes before saving.'; }
  function deleteTx(id) {
    const tx=transactions.find(t=>t.id===id); if(!tx)return;
    tx.deleted=true; tx.updatedAt=Date.now(); persist(); render(); toast('Transaction moved to deleted. Undo available briefly.',()=>{tx.deleted=false;tx.updatedAt=Date.now();persist();render();toast('Deletion undone.');});
  }
  function row(t) {
    const article=document.createElement('article'); article.className=`tx-row ${t.type.toLowerCase()}`;
    const main=document.createElement('div'); main.className='tx-main'; const title=document.createElement('strong'); title.textContent=labels[t.type];
    const sub=document.createElement('p'); sub.textContent=[t.person,t.category,t.note].filter(Boolean).join(' · ') || 'No extra details';
    const dt=document.createElement('small'); dt.textContent=`${t.date} · ${t.time} · ${t.source==='VOICE'?'Voice':'Manual'}`;
    const amt=document.createElement('strong'); amt.className='tx-amount'; amt.textContent=money(t.amountMinor); main.append(title,sub,dt);
    const actions=document.createElement('div'); actions.className='tx-actions'; actions.append(amt);
    [['Edit',()=>editTx(t.id)],['Duplicate',()=>{fillForm({...t,id:undefined});editId=null;$('entry-form').scrollIntoView({behavior:'smooth'});toast('Copy ready for review.');}],['Delete',()=>deleteTx(t.id)]].forEach(([label,fn])=>{const b=document.createElement('button');b.type='button';b.className='small-button';b.textContent=label;b.onclick=fn;actions.append(b);});
    article.append(main,actions); return article;
  }
  function render() {
    const txs=active(); const sum=(type,list=txs)=>list.filter(t=>type.includes(t.type)).reduce((a,t)=>a+t.amountMinor,0);
    const sent=sum(['SENT','LENT']); const received=sum(['RECEIVED','REFUND']); const exp=sum(['EXPENSE']);
    $('sent-total').textContent=money(sent); $('received-total').textContent=money(received); $('expense-total').textContent=money(exp); $('balance-total').textContent=money(received-sent-exp);
    const month=today().slice(0,7), thisMonth=txs.filter(t=>t.date.startsWith(month)); $('period-summary').textContent=`This month: ${money(sum(['EXPENSE'],thisMonth))} expenses · ${thisMonth.length} transactions`;
    const q=$('search').value.trim().toLowerCase(), type=$('filter-type').value, from=$('filter-from').value, to=$('filter-to').value, sort=$('sort').value;
    let filtered=txs.filter(t=>(type==='ALL'||t.type===type)&&(!from||t.date>=from)&&(!to||t.date<=to)&&(!q||[t.person,t.note,t.category,t.type].some(x=>x.toLowerCase().includes(q))));
    filtered.sort((a,b)=>sort==='oldest'?a.date.localeCompare(b.date)||a.time.localeCompare(b.time):sort==='highest'?b.amountMinor-a.amountMinor:sort==='lowest'?a.amountMinor-b.amountMinor:sort==='person'?a.person.localeCompare(b.person):b.date.localeCompare(a.date)||b.time.localeCompare(a.time));
    const list=$('transaction-list'); list.replaceChildren(); filtered.forEach(t=>list.append(row(t))); $('empty-state').hidden=filtered.length!==0;
    const report=$('report-summary'); report.replaceChildren(); [['Sent',sum(['SENT'],thisMonth)],['Received',sum(['RECEIVED'],thisMonth)],['Expenses',sum(['EXPENSE'],thisMonth)],['Lent / borrowed',sum(['LENT'],thisMonth)-sum(['BORROWED'],thisMonth)]].forEach(([k,v])=>{const d=document.createElement('div');d.className='report-item';const b=document.createElement('b');b.textContent=k;const s=document.createElement('span');s.textContent=money(v);d.append(b,s);report.append(d);});
    const cats={}; thisMonth.filter(t=>t.type==='EXPENSE').forEach(t=>{const k=t.category||'Uncategorised';cats[k]=(cats[k]||0)+t.amountMinor;}); const c=$('category-report');c.replaceChildren(); Object.entries(cats).sort((a,b)=>b[1]-a[1]).forEach(([k,v])=>{const d=document.createElement('div');d.className='category-row';const name=document.createElement('span');name.textContent=k;const track=document.createElement('span');track.className='bar-track';const bar=document.createElement('i');bar.style.width=`${Math.round(v/Math.max(...Object.values(cats))*100)}%`;track.append(bar);const val=document.createElement('b');val.textContent=money(v);d.append(name,track,val);c.append(d);});
  }
  function beginManual() {
    try { $('form-error').textContent=''; const d=makeDraft(); showReview(d); }
    catch(e) { $('form-error').textContent=e.message; }
  }
  function download(name, type, text) { const a=document.createElement('a');const url=URL.createObjectURL(new Blob([text],{type}));a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000); }
  function csvCell(v) { return `"${String(v??'').replace(/"/g,'""')}"`; }
  $('entry-form').addEventListener('submit', e=>{e.preventDefault();beginManual();});
  $('confirm-save').onclick=confirmSave; $('review-cancel').onclick=()=>{$('review-section').hidden=true;pending=null;}; $('review-edit').onclick=()=>{$('review-section').hidden=true;pending=null;$('amount').focus();};
  $('mic-button').onclick=()=>{
    const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
    if(!SR){$('voice-status').textContent='Voice input is unavailable in this browser. Manual entry still works.';return;}
    try { if(recognition) recognition.abort(); recognition=new SR(); recognition.lang=$('voice-language').value; recognition.interimResults=false; recognition.maxAlternatives=1;
      $('voice-status').textContent='Listening…';$('mic-button').classList.add('listening');
      recognition.onresult=e=>{const raw=e.results?.[0]?.[0]?.transcript||'';$('voice-status').textContent=`Recognized: “${raw}”`;const d=parseCommand(raw);if(d.error){$('form-error').textContent=d.error;fillForm({type:'SENT',amountMinor:0,person:'',category:'',note:'',date:today(),time:new Date().toTimeString().slice(0,5)});$('review-section').hidden=true;}else{fillForm(d);$('type').value=d.type;$('amount').value=(d.amountMinor/100).toFixed(2);$('person').value=d.person;$('category').value=d.category;$('note').value=d.note;editId=null;showReview(d);}};
      recognition.onerror=e=>{$('voice-status').textContent=e.error==='not-allowed'?'Microphone permission denied. Use manual entry or allow microphone access.':`Voice recognition failed (${e.error}). Try again or use manual entry.`;};
      recognition.onend=()=>{$('mic-button').classList.remove('listening');}; recognition.start();
    } catch (_) {$('mic-button').classList.remove('listening');$('voice-status').textContent='Could not start voice recognition. Use manual entry.';}
  };
  $('voice-manual').onclick=()=>{$('manual-panel').scrollIntoView({behavior:'smooth'});$('amount').focus();};
  ['search','filter-type','filter-from','filter-to','sort'].forEach(id=>$(id).addEventListener(id==='search'?'input':'change',render));
  $('export-csv').onclick=()=>{const rows=[['ID','Type','Amount','Currency','Person','Category','Note','Date','Time','Source'],...active().map(t=>[t.id,t.type,(t.amountMinor/100).toFixed(2),'INR',t.person,t.category,t.note,t.date,t.time,t.source])];download('engada-pochu-transactions.csv','text/csv;charset=utf-8','\ufeff'+rows.map(r=>r.map(csvCell).join(',')).join('\r\n'));};
  $('export-json').onclick=()=>download('engada-pochu-backup.json','application/json',JSON.stringify({format:'engada-pochu-backup',version:1,exportedAt:new Date().toISOString(),transactions},null,2));
  $('import-json').onchange=async e=>{const file=e.target.files[0];if(!file)return;try{const obj=JSON.parse(await file.text());const incoming=Array.isArray(obj)?obj:obj.transactions;if(!Array.isArray(incoming)||!incoming.every(isValidTx))throw new Error('Backup file format is invalid; no data was changed.');const ids=new Set(transactions.map(t=>t.id));const additions=incoming.filter(t=>!ids.has(t.id));if(!additions.length){toast('No new records to import.');return;}if(await askConfirm(`Import ${additions.length} new records? Existing data will not be overwritten.`)){transactions=[...additions,...transactions];persist();render();toast(`${additions.length} records imported.`);}}catch(err){$('app-status').textContent=err.message||'Could not read backup file.';}finally{e.target.value='';}};
  function askConfirm(text) { $('dialog-message').textContent=text;const dlg=$('confirm-dialog');if(typeof dlg.showModal==='function'){dlg.showModal();return new Promise(resolve=>dlg.addEventListener('close',()=>resolve(dlg.returnValue==='yes'),{once:true}));}return Promise.resolve(window.confirm(text)); }
  $('clear-data').onclick=async()=>{if(await askConfirm('Permanently clear every transaction stored in this browser? Export a backup first. This cannot be undone.')){transactions=[];persist();render();toast('Local transaction data cleared.');}};
  $('theme-toggle').onclick=()=>{theme=theme==='dark'?'light':'dark';document.documentElement.dataset.theme=theme;$('theme-toggle').textContent=theme==='dark'?'Light mode':'Dark mode';$('theme-toggle').setAttribute('aria-pressed',String(theme==='dark'));localStorage.setItem(SETTINGS,theme);};
  $('date').value=today();$('time').value=new Date().toTimeString().slice(0,5);document.documentElement.dataset.theme=theme;$('theme-toggle').textContent=theme==='dark'?'Light mode':'Dark mode';$('theme-toggle').setAttribute('aria-pressed',String(theme==='dark'));render();
})();
