/* =====================================================
   SMS — campanhas pela Mobizon
   Quem recebe (compradoras, quem não pagou, números colados), o texto com a
   contagem de SMS, o teste para o próprio celular, a prévia da lista e o envio
   em lotes (o servidor manda 20 por vez; o painel pede o próximo até acabar).
   Depois, a entrega de cada número e a lista de quem não quer receber.
   O saldo fica no topo, com RECARREGAR (a recarga só existe no site da Mobizon)
   e o aviso por e-mail de saldo baixo. A entrega automática é o webhook da
   Mobizon; "contar quem clicou" faz a Mobizon encurtar o link de cada SMS.
   A conta de caracteres é a de sms-text.js, a mesma do servidor.
===================================================== */
(function(){
  const T=window.SmsText;
  const DEFAULT_TEXT="MONTE: Oi! Chegaram pecas novas na loja. Confira: oficialmontee.com.br - Para nao receber mais, fale no WhatsApp (85) 99216-3305";
  const SOURCE_LABELS={compradora:"Comprou no site",nao_pagou:"Não pagou",lista:"Lista colada"};
  const STATUS_LABELS={queued:["NA FILA","pending"],sending:["SEM CONFIRMAÇÃO","pending"],sent:["ENVIADO","processing"],delivered:["ENTREGUE","delivered"],failed:["FALHOU","cancelled"],skipped:["FORA (SAIU DA LISTA)","expired"]};
  const LINK_RE=/\b(?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s]*)?/gi;
  let data=null,preview=null,sending=false,bound=false,openCampaign=null;

  function fmt(n){return new Intl.NumberFormat("pt-BR").format(Number(n||0))}
  function plural(n,one,many){return fmt(n)+" "+(Number(n)===1?one:many)}
  function msg(id,text,isError){const el=$(id);if(!el)return;el.textContent=text||"";el.classList.toggle("error",!!isError)}
  function panelUrl(){return data?.mobizon_panel_url||"https://mobizon.com.br/panel"}
  function rechargeLink(label){return '<a class="sms-recharge" href="'+esc(panelUrl())+'" target="_blank" rel="noopener">'+esc(label||"RECARREGAR NA MOBIZON")+'</a>'}
  function balanceAmount(){return data?.balance?Number(data.balance.amount||0):null}

  async function loadSms(){
    bind();
    try{
      msg("smsFormError","");
      data=await api("/api/admin/sms");
      renderStatus();renderCounts();renderCampaigns();renderWebhook();renderOptouts();
      if(preview&&!sending)renderPreview("",true);
    }catch(e){setHTML($("smsStatus"),'<p class="error">'+esc(e.message)+'</p>')}
  }

  /* ---------- Saldo, recarga e aviso de saldo baixo ---------- */
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
    const price=Number(data.price_per_sms||0),threshold=Number(data.low_balance_threshold||0);
    const actions='<div class="sms-status-actions">'+rechargeLink()+'<button type="button" class="secondary" data-click="smsRefreshBalance" data-event>ATUALIZAR SALDO</button></div>';
    let head;
    if(data.balance_error){
      head='<div class="sms-status-row"><div><span class="sms-status-label">Saldo na Mobizon</span><strong class="error">'+esc(data.balance_error)+'</strong></div>'+actions+'</div>';
    }else{
      const amount=balanceAmount()||0,fits=price>0?Math.floor(amount/price):0;
      const low=amount<price||(threshold>0&&amount<threshold);
      head='<div class="sms-status-row"><div><span class="sms-status-label">Saldo na Mobizon</span><strong class="sms-balance'+(low?' is-low':'')+'">'+money(amount)+'</strong></div>'+
        '<p class="field-help">Cerca de '+money(price)+' por SMS: dá para uns '+plural(fits,"SMS","SMS")+'.'+(amount<price?' <strong>Sem saldo para enviar: recarregue antes.</strong>':low?' <strong>Saldo baixo.</strong>':'')+'</p>'+actions+'</div>';
    }
    setHTML(box,head+
      '<details class="help-more sms-recharge-help"><summary>Como recarregar</summary><p>Toque em <strong>RECARREGAR NA MOBIZON</strong> e entre na sua conta. No topo, toque no saldo (<strong>BRL</strong>, com o <strong>+</strong>), ou abra o menu <strong>Pagamentos → Conta de recarga</strong>, e escolha Pix, cartão de crédito, boleto ou Mercado Pago. Pix e cartão entram em segundos; boleto, em 1 a 2 dias úteis. Depois volte aqui e toque em <strong>ATUALIZAR SALDO</strong>.</p></details>'+
      '<div class="sms-alert-row"><label>Avisar por e-mail quando o saldo ficar abaixo de (R$)<input id="smsAlertThreshold" type="number" min="0" step="0.01" inputmode="decimal" value="'+esc(threshold?String(threshold):"0")+'"></label><button type="button" class="secondary" data-click="smsSaveAlert" data-event>SALVAR AVISO</button>'+
      '<span id="smsAlertMessage" class="field-help">'+(threshold>0?'Ligado: avisa uma vez quando o saldo passar para baixo de '+esc(money(threshold))+' (e de novo depois de uma recarga). O e-mail vai para os mesmos endereços dos avisos de venda.':'Desligado. Coloque um valor, por exemplo 10, para receber o aviso.')+(data.low_balance_email?'':' Atenção: o envio de e-mails da loja não está configurado, então o aviso não sai.')+'</span></div>');
  }

  async function refreshBalance(event){
    const button=event&&event.target;if(button)button.disabled=true;
    try{await loadSms()}finally{if(button)button.disabled=false}
  }

  async function saveAlert(event){
    const button=event&&event.target;if(button)button.disabled=true;
    const value=String($("smsAlertThreshold")?.value||"0").replace(",",".");
    try{
      const r=await api("/api/admin/sms/settings",{method:"POST",body:JSON.stringify({low_balance_threshold:Number(value)})});
      if(data)data.low_balance_threshold=r.low_balance_threshold;
      renderStatus();
      msg("smsAlertMessage",r.low_balance_threshold>0?"Aviso salvo: e-mail quando o saldo ficar abaixo de "+money(r.low_balance_threshold)+".":"Aviso desligado.");
    }catch(err){msg("smsAlertMessage",err.message,true)}
    finally{if(button)button.disabled=false}
  }

  /* ---------- Entrega automática (webhook da Mobizon) ---------- */
  function renderWebhook(){
    const box=$("smsWebhook");if(!box||!data)return;
    const w=data.webhook||{};
    const copy=(value,label)=>'<span class="sms-copy"><code>'+esc(value)+'</code><button type="button" class="secondary" data-click="smsCopy" data-args="'+esc(JSON.stringify([value,label]))+'" data-event>COPIAR</button></span>';
    const steps='<ol class="sms-steps"><li>Na Mobizon, abra <strong>API → Webhooks</strong> e toque em <strong>Criar webhook</strong>.</li>'+
      '<li>Tipo do evento: <strong>Status de SMS</strong>. Formato dos dados: <strong>JSON</strong>.</li>'+
      '<li>Endereço (URL): '+copy(w.url||"","endereço")+'</li>'+
      '<li>Chave secreta: '+copy(w.secret||"","chave")+'</li>'+
      '<li>Deixe <strong>Ativo</strong> marcado e salve.</li></ol>';
    const on=!!w.last_at;
    setHTML(box,'<div class="sms-webhook-state'+(on?' is-on':'')+'"><strong>'+(on?'Ligada':'Ainda não ligada')+'</strong><span class="field-help">'+
      (on?'A Mobizon avisa o site quando cada SMS é entregue ou falha. Último aviso: '+esc(date(w.last_at))+'.':'Depois de ligar, a entrega de cada SMS aparece sozinha em Campanhas enviadas. Até lá, use ATUALIZAR ENTREGA.')+'</span></div>'+
      (on?'<details class="help-more"><summary>Ver a configuração</summary>'+steps+'</details>':steps)+
      '<span id="smsCopyMessage" class="field-help"></span>');
  }

  async function copyText(value,label,event){
    let ok=false;
    try{await navigator.clipboard.writeText(value);ok=true}catch{}
    if(!ok){
      // Sem acesso à área de transferência: seleciona o texto para copiar à mão.
      const code=event&&event.target&&event.target.parentNode&&event.target.parentNode.querySelector("code");
      if(code){const range=document.createRange();range.selectNodeContents(code);const sel=window.getSelection();sel.removeAllRanges();sel.addRange(range)}
    }
    msg("smsCopyMessage",ok?(label==="chave"?"Chave copiada.":"Endereço copiado."):"Selecionei o texto: copie e cole na Mobizon.");
  }

  /* ---------- Quem recebe e mensagem ---------- */
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

  function textLinks(text){return String(text||"").match(LINK_RE)||[]}
  function trackingOn(){const box=$("smsTrackRow"),input=$("smsTrackLinks");return !!(box&&!box.hidden&&input&&input.checked)}

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
    const links=textLinks(text);
    $("smsTrackRow").hidden=!links.length;
    const track=trackingOn();
    const foreign=links.filter(u=>!/(^|\/\/|\.)oficialmontee\.com\.br/i.test(u));
    const checks=[
      [/^\s*MONT[EÊ]\b/i.test(text),"Começa com o nome da loja (MONTE)","Comece com MONTE: a cliente sabe na hora de quem é."],
      [/\b(sair|parar de receber|n[aã]o receber|descadastr)/i.test(text),"Diz como parar de receber","Diga como parar de receber (por exemplo: Para nao receber mais, fale no WhatsApp)."],
      [!accents.length,"Sem acento nem emoji: 160 caracteres por SMS","Com "+accents.map(c=>c==="\n"?"quebra de linha":c).slice(0,6).join(" ")+" cada SMS cabe só 70 caracteres. Use TIRAR ACENTOS."],
      [!foreign.length,track?"Link do site da loja (vai encurtado pela Mobizon, um por pessoa)":"Links só do site da loja","Links de outros sites ou de encurtadores (bit.ly) costumam ser bloqueados pelas operadoras."]
    ];
    if(track)checks.push([links.every(u=>/^https?:\/\//i.test(u)),"O link começa com https:// (a Mobizon consegue contar os cliques)","Para contar os cliques, o link precisa começar com https:// (por exemplo https://oficialmontee.com.br)."]);
    if(info.segments>T.MAX_SEGMENTS)checks.unshift([false,"","Mensagem longa demais: no máximo "+T.MAX_SEGMENTS+" SMS por pessoa."]);
    setHTML($("smsChecklist"),checks.map(([ok,good,bad])=>'<li class="'+(ok?"is-ok":"is-warn")+'">'+esc(ok?good:bad)+'</li>').join(""));
  }

  // Ao ligar "contar quem clicou", o link sem https:// ganha o https:// (a Mobizon só encurta links completos).
  function onTrackChange(){
    if($("smsTrackLinks").checked){
      const area=$("smsText");
      area.value=area.value.replace(LINK_RE,(u,at,all)=>/^https?:\/\//i.test(u)||all[at-1]==="@"?u:"https://"+u);
    }
    renderCounter();clearPreview();
  }

  function clearPreview(){preview=null;const box=$("smsPreview");if(box&&!sending){box.hidden=true;setHTML(box,"")}}

  function requestBody(){return {audience:chosenAudience(),numbers:$("smsNumbers").value,text:$("smsText").value,track_links:trackingOn()}}

  async function showPreview(e){
    if(e)e.preventDefault();
    if(sending)return;
    msg("smsFormError","");
    const body=requestBody();
    if(!body.audience.length&&!T.extractPhones(body.numbers).phones.length){msg("smsFormError","Escolha quem recebe (em 1. Quem recebe): marque um público ou cole os números.",true);return}
    if(!body.text.trim()){msg("smsFormError","Escreva a mensagem.",true);return}
    if(body.track_links&&!textLinks(body.text).every(u=>/^https?:\/\//i.test(u))){msg("smsFormError","Para contar os cliques, o link precisa começar com https://.",true);return}
    const button=$("smsPreviewButton");button.disabled=true;
    try{preview=await api("/api/admin/sms/preview",{method:"POST",body:JSON.stringify(body)});preview.body=body;renderPreview()}
    catch(err){msg("smsFormError",err.message,true)}
    finally{button.disabled=false}
  }

  function renderPreview(note,quiet){
    const box=$("smsPreview");if(!box||!preview)return;
    const p=preview,by=p.by_source||{};
    const parts=[["compradora","comprou no site","compraram no site"],["nao_pagou","não pagou","não pagaram"],["lista","da lista colada","da lista colada"]].filter(([k])=>by[k]).map(([k,one,many])=>plural(by[k],one,many));
    const extra=[];
    if(p.skipped_optout)extra.push(plural(p.skipped_optout,"pessoa ficou de fora porque pediu para não receber","pessoas ficaram de fora porque pediram para não receber"));
    if(p.invalid_numbers)extra.push(plural(p.invalid_numbers,"número colado não é celular válido","números colados não são celular válido"));
    const balance=balanceAmount();
    const short=balance!==null&&balance<p.estimated_cost;
    const rows=(p.people||[]).map(x=>'<tr><td data-label="Nome">'+esc(x.name||"—")+'</td><td data-label="Celular">'+esc(T.formatPhone(x.phone))+'</td><td data-label="Origem">'+esc(SOURCE_LABELS[x.source]||x.source)+'</td></tr>').join("");
    const canSend=p.recipients>0&&data?.configured&&!short&&!data?.balance_error;
    setHTML(box,(note?'<p class="error">'+esc(note)+'</p>':'')+
      '<div class="sms-preview-head"><strong class="sms-preview-total">'+plural(p.recipients,"pessoa vai receber","pessoas vão receber")+'</strong>'+
      (parts.length?'<span class="field-help">'+esc(parts.join(" · "))+'</span>':'')+'</div>'+
      (extra.length?'<p class="field-help">'+esc(extra.join(" · "))+'.</p>':'')+
      '<div class="mini-stats sms-preview-stats"><div><span>SMS por pessoa</span><strong>'+fmt(p.segments)+'</strong></div><div><span>Total de SMS</span><strong>'+fmt(p.recipients*p.segments)+'</strong></div><div><span>Custo estimado</span><strong>'+money(p.estimated_cost)+'</strong></div></div>'+
      (p.body.track_links?'<p class="field-help">Cliques: a Mobizon troca o link por um link curto dela, um por pessoa, e conta quem clicou.</p>':'')+
      (short?'<div class="sms-short"><p class="error">Faltam '+esc(money(p.estimated_cost-balance))+' no saldo da Mobizon: há '+esc(money(balance))+' e a campanha custa cerca de '+esc(money(p.estimated_cost))+'.</p><div class="sms-status-actions">'+rechargeLink()+'<button type="button" class="secondary" data-click="smsRefreshBalance" data-event>JÁ RECARREGUEI: ATUALIZAR SALDO</button></div></div>':'')+
      (data?.balance_error?'<p class="error">'+esc(data.balance_error)+'</p>':'')+
      (!data?.configured?'<p class="error">Para enviar, ligue a Mobizon (passo a passo no topo da página).</p>':'')+
      (rows?'<details class="help-more"><summary>Ver a lista'+(p.recipients>(p.people||[]).length?' (primeiros '+fmt((p.people||[]).length)+')':'')+'</summary><div class="table-wrap"><table class="table sms-cards"><thead><tr><th>NOME</th><th>CELULAR</th><th>ORIGEM</th></tr></thead><tbody>'+rows+'</tbody></table></div></details>':'')+
      '<div id="smsSendProgress" class="sms-progress" hidden><div class="sms-progress-bar"><span id="smsSendBar"></span></div><span id="smsSendText" class="field-help"></span><div id="smsSendActions" class="sms-status-actions" hidden>'+rechargeLink()+'<button type="button" class="secondary" data-click="smsRefreshBalance" data-event>ATUALIZAR SALDO</button></div></div>'+
      '<div class="modal-actions"><button type="button" id="smsSendButton" class="sms-send-main" data-click="smsStartCampaign"'+(canSend?'':' disabled')+'>CONFIRMAR E ENVIAR PARA '+esc(plural(p.recipients,"PESSOA","PESSOAS"))+'</button></div>');
    box.hidden=false;
    if(!note&&!quiet)box.scrollIntoView({behavior:"smooth",block:"nearest"});
  }

  /* ---------- Envio ---------- */
  async function startCampaign(){
    if(!preview||sending)return;
    const p=preview;
    if(!window.confirm("Enviar o SMS para "+plural(p.recipients,"pessoa","pessoas")+"?\n\n"+p.body.text.trim()+"\n\n"+plural(p.recipients*p.segments,"SMS","SMS")+" · custo estimado "+money(p.estimated_cost)+(p.body.track_links?"\nCom contagem de cliques no link.":"")+".\nDepois de enviado, não dá para cancelar."))return;
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
    const bar=$("smsSendBar"),text=$("smsSendText"),box=$("smsSendProgress"),actions=$("smsSendActions");
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
    const auto=!!data?.webhook?.last_at;
    if(error)show(done+sent+failed,"Envio parado: "+error+" ("+summary+"). Se for saldo, recarregue na Mobizon; depois use CONTINUAR ENVIO em Campanhas enviadas.");
    else show(total,"Pronto: "+summary+". "+(auto?"A entrega aparece sozinha em Campanhas enviadas, em alguns minutos.":"A confirmação de entrega chega em alguns minutos (ATUALIZAR ENTREGA)."));
    if(text)text.classList.toggle("error",!!error);
    if(actions)actions.hidden=!error;
    const previewButton=$("smsPreviewButton");if(previewButton)previewButton.disabled=false;
    preview=null;
    await loadSms();
  }

  async function continueCampaign(id){
    if(sending)return;
    const c=(data?.campaigns||[]).find(x=>String(x.id)===String(id));if(!c)return;
    if(!window.confirm("Continuar o envio? Faltam "+plural(c.queued,"número","números")+"."))return;
    // A barra de progresso fica no lugar da prévia.
    const box=$("smsPreview");
    setHTML(box,'<div class="sms-preview-head"><strong class="sms-preview-total">Continuando a campanha de '+esc(date(c.created_at))+'</strong></div><div id="smsSendProgress" class="sms-progress"><div class="sms-progress-bar"><span id="smsSendBar"></span></div><span id="smsSendText" class="field-help"></span><div id="smsSendActions" class="sms-status-actions" hidden>'+rechargeLink()+'<button type="button" class="secondary" data-click="smsRefreshBalance" data-event>ATUALIZAR SALDO</button></div></div>');
    box.hidden=false;box.scrollIntoView({behavior:"smooth",block:"center"});
    const total=Number(c.recipients||0),done=total-Number(c.queued||0);
    await runCampaign(c.id,total,done);
  }

  /* ---------- Campanhas enviadas: entrega e cliques ---------- */
  async function refreshCampaign(id,button){
    if(button)button.disabled=true;
    try{const r=await api("/api/admin/sms/campaigns/"+encodeURIComponent(id)+"/refresh",{method:"POST",body:"{}"});await loadSms();if(openCampaign===id)await showMessages(id);msg("smsCampaignsInfo",r.updated?plural(r.updated,"número atualizado","números atualizados")+".":"Nenhuma novidade ainda: a operadora pode levar alguns minutos.")}
    catch(err){msg("smsCampaignsInfo",err.message,true)}
    finally{if(button)button.disabled=false}
  }

  // Uma consulta à Mobizon por SMS, em lotes: o painel pede o próximo até acabar.
  async function refreshClicks(id,button){
    if(button)button.disabled=true;
    let since=null,checked=0;
    try{
      for(;;){
        const r=await api("/api/admin/sms/campaigns/"+encodeURIComponent(id)+"/clicks",{method:"POST",body:JSON.stringify(since?{since}:{})});
        since=r.since;checked+=r.checked||0;
        msg("smsCampaignsInfo","Conferindo os cliques… "+plural(checked,"número","números"));
        if(!r.more)break;
        await sleep(400);
      }
      await loadSms();if(openCampaign===id)await showMessages(id);
      const c=(data?.campaigns||[]).find(x=>String(x.id)===String(id));
      msg("smsCampaignsInfo","Cliques conferidos: "+plural(c?.clicked||0,"pessoa clicou","pessoas clicaram")+" ("+plural(c?.clicks||0,"clique","cliques")+").");
    }catch(err){msg("smsCampaignsInfo",err.message,true)}
    finally{if(button)button.disabled=false}
  }

  function campaignAudience(c){const labels={compradora:"Compraram",nao_pagou:"Não pagaram",lista:"Lista colada"};return (c.audience||[]).map(a=>labels[a]||a).join(", ")||"—"}

  function renderCampaigns(){
    const box=$("smsCampaigns");if(!box||!data)return;
    const list=data.campaigns||[];
    const auto=!!data.webhook?.last_at;
    if(!list.length){setHTML(box,'<p class="field-help">Nenhuma campanha enviada ainda.</p>');return}
    setHTML(box,'<table class="table sms-campaigns-table sms-cards"><thead><tr><th>DATA</th><th>MENSAGEM</th><th>PÚBLICO</th><th>ENTREGA</th><th>CLIQUES</th><th></th></tr></thead><tbody>'+list.map(c=>{
      const accepted=Number(c.sent||0)+Number(c.delivered||0);
      const notes=[];
      if(c.queued)notes.push(fmt(c.queued)+" na fila");
      if(c.sending)notes.push(fmt(c.sending)+" sem confirmação");
      if(c.skipped)notes.push(fmt(c.skipped)+" saíram da lista");
      const clicks=c.track_links?(c.clicks_checked_at?plural(c.clicked,"pessoa","pessoas")+'<span class="field-help">'+esc(plural(c.clicks,"clique","cliques")+" · conferido em "+date(c.clicks_checked_at))+'</span>':'<span class="field-help">ainda não conferido</span>'):'<span class="field-help">não contado</span>';
      const actions=[];
      if(c.queued)actions.push('<button type="button" data-click="smsContinueCampaign" data-args="'+esc(JSON.stringify([c.id]))+'">CONTINUAR ENVIO</button>');
      if(Number(c.sent||0)&&data.configured)actions.push('<button type="button" class="secondary" data-click="smsRefreshCampaign" data-args="'+esc(JSON.stringify([c.id]))+'" data-event>'+(auto?'CONFERIR ENTREGA':'ATUALIZAR ENTREGA')+'</button>');
      if(c.track_links&&accepted+Number(c.failed||0)&&data.configured)actions.push('<button type="button" class="secondary" data-click="smsRefreshClicks" data-args="'+esc(JSON.stringify([c.id]))+'" data-event>ATUALIZAR CLIQUES</button>');
      actions.push('<button type="button" class="link-button sms-link" data-click="smsShowMessages" data-args="'+esc(JSON.stringify([c.id]))+'">Ver números</button>');
      return '<tr><td data-label="Data">'+esc(date(c.created_at))+'</td><td class="sms-campaign-text" data-label="Mensagem" title="'+esc(c.text)+'">'+esc(c.text)+'<span class="field-help">'+esc(c.segments+" SMS por pessoa · "+plural(c.recipients,"número","números"))+'</span></td><td data-label="Público">'+esc(campaignAudience(c))+'</td><td data-label="Entrega"><span class="sms-delivery"><span>'+esc(plural(accepted,"enviado","enviados"))+'</span><span>'+esc(plural(c.delivered,"entregue","entregues"))+'</span><span'+(c.failed?' class="is-failed"':'')+'>'+esc(c.failed?plural(c.failed,"falhou","falharam"):"nenhuma falha")+'</span></span>'+(notes.length?'<span class="field-help">'+esc(notes.join(" · "))+'</span>':'')+'</td><td data-label="Cliques">'+clicks+'</td><td class="sms-actions">'+actions.join("")+'</td></tr>';
    }).join("")+'</tbody></table>');
  }

  function messageDetail(m){
    if(m.error)return m.error;
    if(m.status==="sent"&&m.provider_status==="1")return "Em moderação na Mobizon (ela revisa o texto antes de enviar)";
    return "";
  }

  async function showMessages(id){
    openCampaign=id;
    const box=$("smsMessages");if(!box)return;
    setHTML(box,'<p class="field-help">Carregando os números…</p>');
    try{
      const r=await api("/api/admin/sms/campaigns/"+encodeURIComponent(id)+"/messages");
      const c=(data?.campaigns||[]).find(x=>String(x.id)===String(id));
      const track=!!c?.track_links;
      const rows=(r.messages||[]).map(m=>{const [label,cls]=STATUS_LABELS[m.status]||[m.status,"pending"];return '<tr><td data-label="Nome">'+esc(m.name||"—")+'</td><td data-label="Celular">'+esc(T.formatPhone(m.phone))+'</td><td data-label="Origem">'+esc(SOURCE_LABELS[m.source]||m.source)+'</td><td data-label="Situação"><span class="badge '+cls+'">'+esc(label)+'</span></td>'+(track?'<td data-label="Cliques">'+(m.clicks==null?'—':fmt(m.clicks))+'</td>':'')+'<td data-label="Detalhe">'+esc(messageDetail(m))+'</td></tr>'}).join("");
      setHTML(box,'<div class="sms-messages-head"><h3>Números da campanha'+(c?' de '+esc(date(c.created_at)):'')+'</h3><button type="button" class="link-button sms-link" data-click="smsHideMessages">Fechar</button></div><div class="table-wrap"><table class="table sms-cards"><thead><tr><th>NOME</th><th>CELULAR</th><th>ORIGEM</th><th>SITUAÇÃO</th>'+(track?'<th>CLIQUES</th>':'')+'<th>DETALHE</th></tr></thead><tbody>'+(rows||'<tr><td colspan="6">Nenhum número.</td></tr>')+'</tbody></table></div>');
      box.scrollIntoView({behavior:"smooth",block:"nearest"});
    }catch(err){setHTML(box,'<p class="error">'+esc(err.message)+'</p>')}
  }
  function hideMessages(){openCampaign=null;setHTML($("smsMessages"),"")}

  /* ---------- Não querem receber ---------- */
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

  /* ---------- Teste e arquivo de contatos ---------- */
  async function sendTest(){
    msg("smsTestMessage","");
    const button=$("smsTestButton");button.disabled=true;
    try{
      const r=await api("/api/admin/sms/test",{method:"POST",body:JSON.stringify({phone:$("smsTestPhone").value,text:$("smsText").value})});
      msg("smsTestMessage","Teste enviado para "+T.formatPhone(r.phone)+"."+(r.moderation?" A Mobizon vai revisar o texto antes de enviar (moderação), o que pode levar de minutos a algumas horas.":" Deve chegar em até alguns minutos."));
      try{localStorage.setItem("monte_sms_test_phone",$("smsTestPhone").value)}catch{}
      loadSms();
    }catch(err){msg("smsTestMessage",err.message,true)}
    finally{button.disabled=false}
  }

  async function readFile(){
    const input=$("smsFile"),file=input.files&&input.files[0];if(!file)return;
    // O vCard do iPhone vem com as fotos dos contatos: 100 contatos passam fácil de 5 MB.
    if(file.size>30*1024*1024){msg("smsNumbersInfo","Arquivo grande demais (máximo 30 MB). Exporte só a lista dos clientes.",true);input.value="";return}
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
    $("smsTrackLinks").addEventListener("change",onTrackChange);
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
    smsRefreshClicks:(id,event)=>refreshClicks(id,event&&event.target),
    smsRefreshBalance:refreshBalance,
    smsSaveAlert:saveAlert,
    smsCopy:copyText,
    smsShowMessages:showMessages,
    smsHideMessages:hideMessages,
    smsRemoveOptout:removeOptout
  });
})();
