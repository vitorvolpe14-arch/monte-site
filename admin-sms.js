/* =====================================================
   SMS — campanhas pela Mobizon
   Quem recebe (compradoras, quem não pagou, números colados), o texto com a
   contagem de SMS, o teste para o próprio celular, a prévia da lista e o envio
   em lotes (o servidor manda 20 por vez; o painel pede o próximo até acabar).
   Depois, a entrega de cada número e a lista de quem não quer receber.
   A conta de caracteres é a de sms-text.js, a mesma do servidor.
===================================================== */
(function(){
  const T=window.SmsText;
  const DEFAULT_TEXT="MONTE: Oi! Chegaram pecas novas na loja. Confira: oficialmontee.com.br - Para nao receber mais, fale no WhatsApp (85) 99216-3305";
  const SOURCE_LABELS={compradora:"Comprou no site",nao_pagou:"Não pagou",lista:"Lista colada"};
  const STATUS_LABELS={queued:["NA FILA","pending"],sending:["SEM CONFIRMAÇÃO","pending"],sent:["ENVIADO","processing"],delivered:["ENTREGUE","delivered"],failed:["FALHOU","cancelled"],skipped:["FORA (SAIU DA LISTA)","expired"]};
  let data=null,preview=null,sending=false,bound=false,openCampaign=null;

  function fmt(n){return new Intl.NumberFormat("pt-BR").format(Number(n||0))}
  function plural(n,one,many){return fmt(n)+" "+(Number(n)===1?one:many)}
  function msg(id,text,isError){const el=$(id);if(!el)return;el.textContent=text||"";el.classList.toggle("error",!!isError)}

  async function loadSms(){
    bind();
    try{
      msg("smsFormError","");
      data=await api("/api/admin/sms");
      renderStatus();renderCounts();renderCampaigns();renderOptouts();
    }catch(e){setHTML($("smsStatus"),'<p class="error">'+esc(e.message)+'</p>')}
  }

  function renderStatus(){
    const box=$("smsStatus");if(!box||!data)return;
    if(!data.configured){
      setHTML(box,'<div class="sms-status-row"><strong>A Mobizon ainda não está ligada ao site.</strong></div>'+
        '<ol class="sms-steps"><li>Na Mobizon, abra <strong>API → Configurações da API</strong> e copie a chave.</li>'+
        '<li>No Cloudflare, abra <strong>Workers &amp; Pages → monte-site → Settings → Variables and secrets</strong>, clique em <strong>Add</strong>, escolha o tipo <strong>Secret</strong>, coloque o nome <code>MOBIZON_API_KEY</code> e cole a chave.</li>'+
        '<li>Volte aqui e clique em <strong>ATUALIZAR</strong>.</li></ol>'+
        '<p class="field-help">Enquanto isso, já dá para montar a mensagem e ver quem vai receber.</p>');
      return;
    }
    if(data.balance_error){setHTML(box,'<div class="sms-status-row"><strong>Saldo na Mobizon</strong><span class="error">'+esc(data.balance_error)+'</span></div>');return}
    const amount=Number(data.balance?.amount||0),price=Number(data.price_per_sms||0);
    const fits=price>0?Math.floor(amount/price):0;
    setHTML(box,'<div class="sms-status-row"><div><span class="sms-status-label">Saldo na Mobizon</span><strong class="sms-balance">'+money(amount)+'</strong></div>'+
      '<p class="field-help">Cerca de '+money(price)+' por SMS: dá para uns '+plural(fits,"SMS","SMS")+'.'+(amount<price?' Recarregue a conta na Mobizon (Pix, cartão ou boleto) antes de enviar.':'')+'</p>'+
      '<a class="secondary-link" href="https://mobizon.com.br/" target="_blank" rel="noopener">ABRIR A MOBIZON</a></div>');
  }

  function renderCounts(){
    if(!data)return;
    $("smsCountBuyers").textContent="("+plural(data.audiences?.compradora,"pessoa","pessoas")+")";
    $("smsCountUnpaid").textContent="("+plural(data.audiences?.nao_pagou,"pessoa","pessoas")+")";
  }

  function chosenAudience(){return [["smsAudienceBuyers","compradora"],["smsAudienceUnpaid","nao_pagou"]].filter(([id])=>$(id).checked).map(([,v])=>v)}

  function renderNumbersInfo(){
    const r=T.extractPhones($("smsNumbers").value);
    const parts=[];
    if(r.phones.length)parts.push(plural(r.phones.length,"celular encontrado","celulares encontrados"));
    if(r.invalid)parts.push(plural(r.invalid,"número não é celular válido e fica de fora","números não são celular válido e ficam de fora")+" (fixo ou sem DDD)");
    msg("smsNumbersInfo",parts.join(" · "));
  }

  function renderCounter(){
    const text=$("smsText").value,info=T.smsSegments(text.trim());
    const counter=$("smsCounter");
    const accents=T.nonGsmCharacters(text);
    let line=fmt(info.length)+" caracteres · ";
    line+=info.segments?(info.segments===1?"1 SMS por pessoa":info.segments+" SMS por pessoa (cobrados como "+info.segments+")"):"0 SMS";
    if(info.segments)line+=" · cabem mais "+fmt(info.remaining)+" nesta parte";
    counter.textContent=line;
    counter.classList.toggle("is-over",info.segments>T.MAX_SEGMENTS);
    $("smsStripAccents").hidden=!accents.length;
    const link=(text.match(/\b(?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/\S*)?/gi)||[]);
    const foreign=link.filter(u=>!/(^|\/\/|\.)oficialmontee\.com\.br/i.test(u));
    const checks=[
      [/^\s*MONT[EÊ]\b/i.test(text),"Começa com o nome da loja (MONTE)","Comece com MONTE: a cliente sabe na hora de quem é."],
      [/\b(sair|parar de receber|n[aã]o receber|descadastr)/i.test(text),"Diz como parar de receber","Diga como parar de receber (por exemplo: Para nao receber mais, fale no WhatsApp)."],
      [!accents.length,"Sem acento nem emoji: 160 caracteres por SMS","Com "+accents.map(c=>c==="\n"?"quebra de linha":c).slice(0,6).join(" ")+" cada SMS cabe só 70 caracteres. Use TIRAR ACENTOS."],
      [!foreign.length,"Links só do site da loja","Links de outros sites ou de encurtadores (bit.ly) costumam ser bloqueados pelas operadoras."]
    ];
    if(info.segments>T.MAX_SEGMENTS)checks.unshift([false,"","Mensagem longa demais: no máximo "+T.MAX_SEGMENTS+" SMS por pessoa."]);
    setHTML($("smsChecklist"),checks.map(([ok,good,bad])=>'<li class="'+(ok?"is-ok":"is-warn")+'">'+esc(ok?good:bad)+'</li>').join(""));
  }

  function clearPreview(){preview=null;const box=$("smsPreview");if(box&&!sending){box.hidden=true;setHTML(box,"")}}

  function requestBody(){return {audience:chosenAudience(),numbers:$("smsNumbers").value,text:$("smsText").value}}

  async function showPreview(e){
    if(e)e.preventDefault();
    if(sending)return;
    msg("smsFormError","");
    const body=requestBody();
    if(!body.audience.length&&!T.extractPhones(body.numbers).phones.length){msg("smsFormError","Escolha quem recebe: marque um público ou cole números.",true);return}
    const button=$("smsPreviewButton");button.disabled=true;
    try{preview=await api("/api/admin/sms/preview",{method:"POST",body:JSON.stringify(body)});preview.body=body;renderPreview()}
    catch(err){msg("smsFormError",err.message,true)}
    finally{button.disabled=false}
  }

  function renderPreview(note){
    const box=$("smsPreview");if(!box||!preview)return;
    const p=preview,by=p.by_source||{};
    const parts=[["compradora","comprou no site","compraram no site"],["nao_pagou","não pagou","não pagaram"],["lista","da lista colada","da lista colada"]].filter(([k])=>by[k]).map(([k,one,many])=>plural(by[k],one,many));
    const extra=[];
    if(p.skipped_optout)extra.push(plural(p.skipped_optout,"pessoa ficou de fora porque pediu para não receber","pessoas ficaram de fora porque pediram para não receber"));
    if(p.invalid_numbers)extra.push(plural(p.invalid_numbers,"número colado não é celular válido","números colados não são celular válido"));
    const balance=data?.balance?Number(data.balance.amount||0):null;
    const short=balance!==null&&balance<p.estimated_cost;
    const rows=(p.people||[]).map(x=>'<tr><td data-label="Nome">'+esc(x.name||"—")+'</td><td data-label="Celular">'+esc(T.formatPhone(x.phone))+'</td><td data-label="Origem">'+esc(SOURCE_LABELS[x.source]||x.source)+'</td></tr>').join("");
    const canSend=p.recipients>0&&data?.configured&&!short;
    setHTML(box,(note?'<p class="error">'+esc(note)+'</p>':'')+
      '<div class="sms-preview-head"><strong class="sms-preview-total">'+plural(p.recipients,"pessoa vai receber","pessoas vão receber")+'</strong>'+
      (parts.length?'<span class="field-help">'+esc(parts.join(" · "))+'</span>':'')+'</div>'+
      (extra.length?'<p class="field-help">'+esc(extra.join(" · "))+'.</p>':'')+
      '<div class="mini-stats sms-preview-stats"><div><span>SMS por pessoa</span><strong>'+fmt(p.segments)+'</strong></div><div><span>Total de SMS</span><strong>'+fmt(p.recipients*p.segments)+'</strong></div><div><span>Custo estimado</span><strong>'+money(p.estimated_cost)+'</strong></div></div>'+
      (short?'<p class="error">O saldo da Mobizon ('+esc(money(balance))+') não cobre a campanha. Recarregue na Mobizon e clique em ATUALIZAR.</p>':'')+
      (!data?.configured?'<p class="error">Para enviar, ligue a Mobizon (passo a passo no topo da página).</p>':'')+
      (rows?'<details class="help-more"><summary>Ver a lista'+(p.recipients>(p.people||[]).length?' (primeiros '+fmt((p.people||[]).length)+')':'')+'</summary><div class="table-wrap"><table class="table sms-cards"><thead><tr><th>NOME</th><th>CELULAR</th><th>ORIGEM</th></tr></thead><tbody>'+rows+'</tbody></table></div></details>':'')+
      '<div id="smsSendProgress" class="sms-progress" hidden><div class="sms-progress-bar"><span id="smsSendBar"></span></div><span id="smsSendText" class="field-help"></span></div>'+
      '<div class="modal-actions"><button type="button" id="smsSendButton" data-click="smsStartCampaign"'+(canSend?'':' disabled')+'>ENVIAR PARA '+esc(plural(p.recipients,"PESSOA","PESSOAS"))+'</button></div>');
    box.hidden=false;
  }

  async function startCampaign(){
    if(!preview||sending)return;
    const p=preview;
    if(!window.confirm("Enviar o SMS para "+plural(p.recipients,"pessoa","pessoas")+"?\n\n"+p.body.text.trim()+"\n\n"+plural(p.recipients*p.segments,"SMS","SMS")+" · custo estimado "+money(p.estimated_cost)+".\nDepois de enviado, não dá para cancelar."))return;
    sending=true;$("smsSendButton").disabled=true;$("smsPreviewButton").disabled=true;
    let created;
    try{created=await api("/api/admin/sms/campaigns",{method:"POST",body:JSON.stringify({...p.body,expected_recipients:p.recipients})})}
    catch(err){
      sending=false;$("smsPreviewButton").disabled=false;
      if(err.status===409){showPreview();msg("smsFormError",err.message,true)}else{$("smsSendButton").disabled=false;msg("smsFormError",err.message,true)}
      return;
    }
    await runCampaign(created.campaign_id,created.recipients,0);
  }

  // Manda os lotes até acabar a fila. done: quantos já tinham saído (para continuar um envio).
  async function runCampaign(id,total,done){
    sending=true;
    const bar=$("smsSendBar"),text=$("smsSendText"),box=$("smsSendProgress");
    const show=(n,label)=>{if(box)box.hidden=false;if(bar)bar.style.width=Math.min(100,total?Math.round(n/total*100):100)+"%";if(text)text.textContent=label};
    let sent=0,failed=0,error="";
    show(done,"Enviando… "+fmt(done)+" de "+fmt(total));
    try{
      for(;;){
        const r=await api("/api/admin/sms/campaigns/"+encodeURIComponent(id)+"/send",{method:"POST",body:"{}"});
        sent+=r.sent||0;failed+=r.failed||0;
        show(done+sent+failed,"Enviando… "+fmt(done+sent+failed)+" de "+fmt(total));
        if(r.stopped){error=r.message||"a Mobizon recusou o envio.";break}
        if(!r.more)break;
        await sleep(600);
      }
    }catch(err){error=err.message}
    sending=false;
    const summary=plural(sent,"SMS enviado","SMS enviados")+(failed?" · "+plural(failed,"número recusado","números recusados"):"");
    if(error)show(done+sent+failed,"Envio parado: "+error+" ("+summary+"). Depois de resolver, use CONTINUAR ENVIO em Campanhas enviadas.");
    else show(total,"Pronto: "+summary+". A confirmação de entrega chega em alguns minutos (ATUALIZAR ENTREGA).");
    if(text)text.classList.toggle("error",!!error);
    const previewButton=$("smsPreviewButton");if(previewButton)previewButton.disabled=false;
    preview=null;
    await loadSms();
  }

  async function continueCampaign(id){
    if(sending)return;
    const c=(data?.campaigns||[]).find(x=>String(x.id)===String(id));if(!c)return;
    if(!window.confirm("Continuar o envio? Faltam "+plural(c.queued,"número","números")+"."))return;
    // A barra de progresso fica na prévia: mostra uma prévia só com ela.
    const box=$("smsPreview");
    setHTML(box,'<div class="sms-preview-head"><strong class="sms-preview-total">Continuando a campanha de '+esc(date(c.created_at))+'</strong></div><div id="smsSendProgress" class="sms-progress"><div class="sms-progress-bar"><span id="smsSendBar"></span></div><span id="smsSendText" class="field-help"></span></div>');
    box.hidden=false;box.scrollIntoView({behavior:"smooth",block:"center"});
    const total=Number(c.recipients||0),done=total-Number(c.queued||0);
    await runCampaign(c.id,total,done);
  }

  async function refreshCampaign(id,button){
    if(button)button.disabled=true;
    try{const r=await api("/api/admin/sms/campaigns/"+encodeURIComponent(id)+"/refresh",{method:"POST",body:"{}"});await loadSms();if(openCampaign===id)await showMessages(id);msg("smsCampaignsInfo",r.updated?plural(r.updated,"número atualizado","números atualizados")+".":"Nenhuma novidade ainda: a operadora pode levar alguns minutos.")}
    catch(err){msg("smsCampaignsInfo",err.message,true)}
    finally{if(button)button.disabled=false}
  }

  function campaignAudience(c){const labels={compradora:"Compraram",nao_pagou:"Não pagaram",lista:"Lista colada"};return (c.audience||[]).map(a=>labels[a]||a).join(", ")||"—"}

  function renderCampaigns(){
    const box=$("smsCampaigns");if(!box||!data)return;
    const list=data.campaigns||[];
    if(!list.length){setHTML(box,'<p class="field-help">Nenhuma campanha enviada ainda.</p>');return}
    setHTML(box,'<table class="table sms-campaigns-table sms-cards"><thead><tr><th>DATA</th><th>MENSAGEM</th><th>PÚBLICO</th><th>ENVIADOS</th><th>ENTREGUES</th><th>FALHARAM</th><th></th></tr></thead><tbody>'+list.map(c=>{
      const accepted=Number(c.sent||0)+Number(c.delivered||0);
      const notes=[];
      if(c.queued)notes.push(fmt(c.queued)+" na fila");
      if(c.sending)notes.push(fmt(c.sending)+" sem confirmação");
      if(c.skipped)notes.push(fmt(c.skipped)+" saíram da lista");
      const actions=[];
      if(c.queued)actions.push('<button type="button" data-click="smsContinueCampaign" data-args="'+esc(JSON.stringify([c.id]))+'">CONTINUAR ENVIO</button>');
      if(Number(c.sent||0)&&data.configured)actions.push('<button type="button" class="secondary" data-click="smsRefreshCampaign" data-args="'+esc(JSON.stringify([c.id]))+'" data-event>ATUALIZAR ENTREGA</button>');
      actions.push('<button type="button" class="link-button sms-link" data-click="smsShowMessages" data-args="'+esc(JSON.stringify([c.id]))+'">Ver números</button>');
      return '<tr><td data-label="Data">'+esc(date(c.created_at))+'</td><td class="sms-campaign-text" data-label="Mensagem" title="'+esc(c.text)+'">'+esc(c.text)+'<span class="field-help">'+esc(c.segments+" SMS por pessoa · "+plural(c.recipients,"número","números"))+'</span></td><td data-label="Público">'+esc(campaignAudience(c))+'</td><td data-label="Enviados">'+fmt(accepted)+(notes.length?'<span class="field-help">'+esc(notes.join(" · "))+'</span>':'')+'</td><td data-label="Entregues">'+fmt(c.delivered)+'</td><td data-label="Falharam">'+fmt(c.failed)+'</td><td class="sms-actions">'+actions.join("")+'</td></tr>';
    }).join("")+'</tbody></table>');
  }

  async function showMessages(id){
    openCampaign=id;
    const box=$("smsMessages");if(!box)return;
    setHTML(box,'<p class="field-help">Carregando os números…</p>');
    try{
      const r=await api("/api/admin/sms/campaigns/"+encodeURIComponent(id)+"/messages");
      const c=(data?.campaigns||[]).find(x=>String(x.id)===String(id));
      const rows=(r.messages||[]).map(m=>{const [label,cls]=STATUS_LABELS[m.status]||[m.status,"pending"];return '<tr><td data-label="Nome">'+esc(m.name||"—")+'</td><td data-label="Celular">'+esc(T.formatPhone(m.phone))+'</td><td data-label="Origem">'+esc(SOURCE_LABELS[m.source]||m.source)+'</td><td data-label="Situação"><span class="badge '+cls+'">'+esc(label)+'</span></td><td data-label="Detalhe">'+esc(m.error||"")+'</td></tr>'}).join("");
      setHTML(box,'<div class="sms-messages-head"><h3>Números da campanha'+(c?' de '+esc(date(c.created_at)):'')+'</h3><button type="button" class="link-button sms-link" data-click="smsHideMessages">Fechar</button></div><div class="table-wrap"><table class="table sms-cards"><thead><tr><th>NOME</th><th>CELULAR</th><th>ORIGEM</th><th>SITUAÇÃO</th><th>DETALHE</th></tr></thead><tbody>'+(rows||'<tr><td colspan="5">Nenhum número.</td></tr>')+'</tbody></table></div>');
      box.scrollIntoView({behavior:"smooth",block:"nearest"});
    }catch(err){setHTML(box,'<p class="error">'+esc(err.message)+'</p>')}
  }
  function hideMessages(){openCampaign=null;setHTML($("smsMessages"),"")}

  function renderOptouts(){
    const box=$("smsOptouts");if(!box||!data)return;
    const list=data.optouts||[];
    if(!list.length){setHTML(box,'<p class="field-help">Ninguém pediu para sair até agora.</p>');return}
    setHTML(box,'<table class="table sms-cards"><thead><tr><th>CELULAR</th><th>OBSERVAÇÃO</th><th>DESDE</th><th></th></tr></thead><tbody>'+list.map(o=>'<tr><td data-label="Celular">'+esc(T.formatPhone(o.phone))+'</td><td data-label="Observação">'+esc(o.note||"—")+'</td><td data-label="Desde">'+esc(date(o.created_at))+'</td><td><button type="button" class="link-button sms-link" data-click="smsRemoveOptout" data-args="'+esc(JSON.stringify([o.phone]))+'">Voltar a receber</button></td></tr>').join("")+'</tbody></table>');
  }

  async function addOptout(e){
    e.preventDefault();msg("smsOptoutError","");
    try{
      const r=await api("/api/admin/sms/optouts",{method:"POST",body:JSON.stringify({numbers:$("smsOptoutNumbers").value,note:$("smsOptoutNote").value})});
      $("smsOptoutNumbers").value="";$("smsOptoutNote").value="";
      msg("smsOptoutError",plural(r.added,"número saiu","números saíram")+" da lista.");
      clearPreview();await loadSms();
    }catch(err){msg("smsOptoutError",err.message,true)}
  }

  async function removeOptout(phone){
    if(!window.confirm(T.formatPhone(phone)+" volta a receber os SMS da loja?\n\nFaça isso só se a pessoa pediu."))return;
    try{await api("/api/admin/sms/optouts/"+encodeURIComponent(phone),{method:"DELETE"});clearPreview();await loadSms()}
    catch(err){msg("smsOptoutError",err.message,true)}
  }

  async function sendTest(){
    msg("smsTestMessage","");
    const button=$("smsTestButton");button.disabled=true;
    try{
      const r=await api("/api/admin/sms/test",{method:"POST",body:JSON.stringify({phone:$("smsTestPhone").value,text:$("smsText").value})});
      msg("smsTestMessage","Teste enviado para "+T.formatPhone(r.phone)+". Deve chegar em até alguns minutos.");
      try{localStorage.setItem("monte_sms_test_phone",$("smsTestPhone").value)}catch{}
      loadSms();
    }catch(err){msg("smsTestMessage",err.message,true)}
    finally{button.disabled=false}
  }

  async function readFile(){
    const input=$("smsFile"),file=input.files&&input.files[0];if(!file)return;
    if(file.size>5*1024*1024){msg("smsNumbersInfo","Arquivo grande demais (máximo 5 MB).",true);input.value="";return}
    const text=await file.text();
    const r=T.extractPhones(text);
    const area=$("smsNumbers");
    // Na caixa entram só os celulares do arquivo, um por linha (o resto do CSV não interessa).
    const current=T.extractPhones(area.value).phones;
    const all=current.concat(r.phones.filter(p=>!current.includes(p)));
    area.value=all.map(T.formatPhone).join("\n");
    input.value="";
    renderNumbersInfo();clearPreview();
    msg("smsNumbersInfo",plural(r.phones.length,"celular lido","celulares lidos")+" de "+file.name+(r.invalid?" · "+plural(r.invalid,"número não é celular válido","números não são celular válido"):"")+" · "+plural(all.length,"número na lista","números na lista"));
  }

  function bind(){
    if(bound)return;bound=true;
    const text=$("smsText");
    if(text&&!text.value)text.value=DEFAULT_TEXT;
    try{const saved=localStorage.getItem("monte_sms_test_phone");if(saved&&$("smsTestPhone"))$("smsTestPhone").value=saved}catch{}
    $("smsForm").addEventListener("submit",showPreview);
    text.addEventListener("input",()=>{renderCounter();clearPreview()});
    $("smsNumbers").addEventListener("input",()=>{renderNumbersInfo();clearPreview()});
    ["smsAudienceBuyers","smsAudienceUnpaid"].forEach(id=>$(id).addEventListener("change",clearPreview));
    $("smsStripAccents").addEventListener("click",()=>{text.value=T.toGsmText(text.value);renderCounter();clearPreview();text.focus()});
    $("smsTestButton").addEventListener("click",sendTest);
    $("smsFile").addEventListener("change",readFile);
    $("smsOptoutForm").addEventListener("submit",addOptout);
    $("refreshSms").addEventListener("click",()=>{if(!sending)loadSms()});
    window.addEventListener("beforeunload",e=>{if(sending){e.preventDefault();e.returnValue=""}});
    renderCounter();renderNumbersInfo();
  }

  window.loadSms=loadSms;
  registerClickActions({
    smsStartCampaign:startCampaign,
    smsContinueCampaign:continueCampaign,
    smsRefreshCampaign:(id,event)=>refreshCampaign(id,event&&event.target),
    smsShowMessages:showMessages,
    smsHideMessages:hideMessages,
    smsRemoveOptout:removeOptout
  });
})();
