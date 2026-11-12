/* =====================================================
   GRÁFICOS DO PAINEL — Analytics e o "Ritmo das vendas" da Visão geral
   Mesmo estilo do "Faturamento por dia": colunas finas (até 24px, ponta
   arredondada), linhas de 2px, grade clara, um eixo só, dica ao passar o
   mouse, tocar ou usar as setas, e "Ver em tabela" com os mesmos números.
   Preto = o que importa; cinza (#8f8f8a) = comparação ou contexto.
   As contas ficam em chart-data.js. Larguras e posições vão por JS
   (a CSP do painel não aceita style="" no HTML).
   Usa as funções de admin.js (money, fmtInt, esc, niceStep...).
===================================================== */
const CHART_MUTED = "#8f8f8a";
function chartTouch(){return !!(window.matchMedia&&window.matchMedia("(hover: none)").matches)}
function chartHow(){return chartTouch()?"Toque no gráfico":"Passe o mouse ou use as setas do teclado"}
function chartWidths(box){box.querySelectorAll("[data-w]").forEach(el=>{el.style.width=Math.max(0,Math.min(100,Number(el.dataset.w)))+"%"})}

/* ---------- Colunas (visitas por dia e por dia da semana) ----------
   items: [{value, label, tip:[título, valor, linha, linha], muted}] */
function drawColumns(box,items,{allLabels=false}={}){
  box._items=items;
  const W=Math.round(box.clientWidth);
  if(!W){box._pending=true;box._geo=null;return false}
  box._pending=false;box._width=W;
  const H=W<520?220:260,padL=W<520?36:46,padR=10,padT=26,padB=28,plotW=W-padL-padR,plotH=H-padT-padB,base=padT+plotH;
  const max=Math.max(0,...items.map(it=>it.value)),step=Math.max(1,Math.ceil(niceStep(max||10,4))),top=Math.max(step,Math.ceil((max||1)/step)*step);
  const y=v=>base-(v/top)*plotH,slot=plotW/Math.max(1,items.length),barW=Math.max(2,Math.min(24,slot*0.62));
  let grid="";for(let v=0;v<=top+0.001;v+=step){const gy=y(v).toFixed(1);grid+=`<line x1="${padL}" x2="${W-padR}" y1="${gy}" y2="${gy}" class="dc-grid${v===0?" dc-base":""}"/><text x="${padL-8}" y="${(+gy+4).toFixed(1)}" text-anchor="end" class="dc-tick">${axisInt(v)}</text>`}
  const every=allLabels?1:Math.max(1,Math.ceil(items.length/(W<520?4:8)));
  let bars="",labels="",maxIdx=-1;
  items.forEach((it,i)=>{
    const cx=padL+slot*i+slot/2,x=cx-barW/2;
    if(it.value>0){const yy=y(it.value),h=base-yy,rr=Math.min(4,barW/2,h);bars+=`<path class="dc-bar${it.muted?" is-muted":""}" data-i="${i}" d="M${x.toFixed(1)} ${base} V${(yy+rr).toFixed(1)} Q${x.toFixed(1)} ${yy.toFixed(1)} ${(x+rr).toFixed(1)} ${yy.toFixed(1)} H${(x+barW-rr).toFixed(1)} Q${(x+barW).toFixed(1)} ${yy.toFixed(1)} ${(x+barW).toFixed(1)} ${(yy+rr).toFixed(1)} V${base} Z"/>`;if(maxIdx<0||it.value>items[maxIdx].value)maxIdx=i}
    if((items.length-1-i)%every===0)labels+=`<text x="${cx.toFixed(1)}" y="${H-8}" text-anchor="middle" class="dc-tick">${esc(it.label)}</text>`;
  });
  let peak="";
  if(maxIdx>=0){const cx=padL+slot*maxIdx+slot/2,tx=Math.min(W-padR-4,Math.max(padL+4,cx)),anchor=tx===cx?"middle":(tx<cx?"end":"start");peak=`<text x="${tx.toFixed(1)}" y="${(y(items[maxIdx].value)-8).toFixed(1)}" text-anchor="${anchor}" class="dc-peak">${esc(fmtInt(Math.round(items[maxIdx].value)))}</text>`}
  setHTML(box,`<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" aria-hidden="true"><g>${grid}</g><line class="dc-cross" x1="0" x2="0" y1="${padT}" y2="${base}" visibility="hidden"/><g>${bars}</g>${peak}<g>${labels}</g></svg><div class="dc-tip" hidden><span class="dc-tip-date"></span><strong class="dc-tip-value"></strong><span class="dc-tip-count"></span><span class="dc-tip-split"></span></div>`);
  box._geo={padL,slot,padT,base,W};
  if(box._active!=null)showColumnTip(box,Math.min(box._active,items.length-1));
  return true;
}
function showColumnTip(box,i){
  const items=box._items,g=box._geo;if(!items||!g||i<0||i>=items.length)return;
  box._active=i;const it=items[i],tip=box.querySelector(".dc-tip"),cross=box.querySelector(".dc-cross");if(!tip)return;
  box.querySelectorAll(".dc-bar").forEach(el=>el.classList.toggle("is-active",Number(el.dataset.i)===i));
  const cx=g.padL+g.slot*i+g.slot/2;
  if(cross){cross.setAttribute("x1",cx);cross.setAttribute("x2",cx);cross.setAttribute("visibility","visible")}
  [".dc-tip-date",".dc-tip-value",".dc-tip-count",".dc-tip-split"].forEach((sel,k)=>{const el=tip.querySelector(sel),text=(it.tip&&it.tip[k])||"";el.textContent=text;el.hidden=!text});
  tip.hidden=false;
  const w=tip.offsetWidth,left=cx+14+w<=g.W?cx+14:Math.max(0,cx-14-w);
  tip.style.left=left+"px";tip.style.top=Math.max(0,g.padT-6)+"px";
}
// Mouse, toque e teclado; o gráfico acompanha a largura da tela (e aparece certo quando a aba é aberta).
function bindChart(box,{show,count,start,rerender,indexAt}){
  if(!box)return;
  const at=indexAt||(e=>{const g=box._geo,n=count();if(!g||!n)return -1;const x=e.clientX-box.getBoundingClientRect().left;return Math.max(0,Math.min(n-1,Math.floor((x-g.padL)/g.slot)))});
  box.addEventListener("pointermove",e=>{const i=at(e);if(i>=0)show(i)});
  box.addEventListener("pointerdown",e=>{const i=at(e);if(i>=0)show(i)});
  box.addEventListener("pointerleave",e=>{if(e.pointerType!=="touch"&&document.activeElement!==box)hideChartTip(box)});
  document.addEventListener("pointerdown",e=>{if(box._active!=null&&!box.contains(e.target))hideChartTip(box)});
  box.addEventListener("focus",()=>{const n=count();if(box._geo&&n)show(start?start():n-1)});
  box.addEventListener("blur",()=>hideChartTip(box));
  box.addEventListener("keydown",e=>{const n=count();if(!n||!box._geo)return;let i=box._active??n-1;if(e.key==="ArrowLeft")i--;else if(e.key==="ArrowRight")i++;else if(e.key==="Home")i=0;else if(e.key==="End")i=n-1;else if(e.key==="Escape"){hideChartTip(box);return}else return;e.preventDefault();show(Math.max(0,Math.min(n-1,i)))});
  if(window.ResizeObserver){let frame=0;new ResizeObserver(()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(()=>{const w=Math.round(box.clientWidth);if(w&&(box._pending||w!==box._width))rerender()})}).observe(box)}
}
function axisInt(v){return v>=10000?(v/1000).toLocaleString("pt-BR",{maximumFractionDigits:1})+" mil":fmtInt(v)}
function chartDay(d){return new Date(d.date+"T12:00:00")}
function chartDayLabel(d){return chartDay(d).toLocaleDateString("pt-BR",{weekday:"short",day:"2-digit",month:"2-digit"})}

/* ---------- Analytics: visitas por dia ----------
   Uma coluna por dia; período longo em tela estreita (e 90 dias no computador):
   cada coluna é uma semana, com a média por dia (a escala continua a mesma). */
function renderVisitsChart(series){
  const box=$("analyticsChart");if(!box)return;
  box._series=series;
  const days=window.ChartData.days(series),total=days.reduce((n,d)=>n+d.visitors,0),avg=days.length?total/days.length:0;
  const hint=$("analyticsChartHint"),table=$("analyticsVisitsTable");
  box.setAttribute("aria-label",`Gráfico de colunas das visitas por dia: média de ${fmtInt(Math.round(avg))} visitantes por dia em ${days.length} ${plural(days.length,"dia","dias")}.`);
  if(!total){box._geo=null;box._items=null;setHTML(box,'<p class="rank-empty">Sem visitas registradas no período.</p>');if(hint)hint.textContent="Nenhuma visita registrada no período.";if(table)setHTML(table,'<p class="field-help">Sem visitas registradas no período.</p>');return}
  const W=Math.round(box.clientWidth),plotW=W-(W<520?36:46)-10,weekly=W>0&&plotW/days.length<7;
  const bins=weekly?window.ChartData.weeks(days):days.map(d=>({...d,first:d,last:d,daily:d.visitors,week:false}));
  const items=bins.map(b=>({value:b.daily,label:shortDate(chartDay(b.first)),tip:b.week
    ?[`${shortDate(chartDay(b.first))} – ${shortDate(chartDay(b.last))}`,`média de ${fmtInt(Math.round(b.daily))} por dia`,`${fmtInt(b.visitors)} visitas na semana · ${fmtInt(b.pageViews)} ${plural(b.pageViews,"página vista","páginas vistas")}`,b.purchases?`${fmtInt(b.purchases)} ${plural(b.purchases,"pedido pago","pedidos pagos")} · ${money(b.revenue)}`:"nenhum pedido pago"]
    :[chartDayLabel(b),`${fmtInt(b.visitors)} ${plural(b.visitors,"visitante","visitantes")}`,`${fmtInt(b.pageViews)} ${plural(b.pageViews,"página vista","páginas vistas")}`,b.purchases?`${fmtInt(b.purchases)} ${plural(b.purchases,"pedido pago","pedidos pagos")} · ${money(b.revenue)}`:"nenhum pedido pago"]}));
  if(hint)hint.textContent=`Visitantes únicos em cada dia · média de ${fmtInt(Math.round(avg))} por dia. ${chartHow()} para ver o dia, com os pedidos e o faturamento.${weekly?" Aqui cada coluna é uma semana (média de visitantes por dia).":""}`;
  drawColumns(box,items);
  // Tabela: o mesmo conteúdo, sem precisar passar o mouse (do dia mais recente ao mais antigo).
  if(table)setHTML(table,`<table class="table"><thead><tr><th>DIA</th><th>VISITANTES</th><th>PÁGINAS VISTAS</th><th>PEDIDOS PAGOS</th><th>CONVERSÃO</th><th>FATURAMENTO</th></tr></thead><tbody>${days.slice().reverse().map(d=>`<tr><td>${esc(chartDayLabel(d))}</td><td>${fmtInt(d.visitors)}</td><td>${fmtInt(d.pageViews)}</td><td>${fmtInt(d.purchases)}</td><td>${pct(d.conversion)}</td><td>${money(d.revenue)}</td></tr>`).join("")}</tbody></table>`);
}

/* ---------- Analytics: visitas por dia da semana ----------
   Média de visitantes de cada dia da semana; o dia com mais movimento em preto, o resto em cinza. */
const WEEKDAY_NAMES={0:["Dom","domingo"],1:["Seg","segunda-feira"],2:["Ter","terça-feira"],3:["Qua","quarta-feira"],4:["Qui","quinta-feira"],5:["Sex","sexta-feira"],6:["Sáb","sábado"]};
function renderWeekdayChart(series){
  const box=$("analyticsWeekChart");if(!box)return;
  box._series=series;
  const days=window.ChartData.days(series),w=window.ChartData.weekdays(days),hint=$("analyticsWeekHint"),table=$("analyticsWeekTable");
  let best=-1;w.forEach((x,i)=>{if(x.n&&x.avg>0&&(best<0||x.avg>w[best].avg))best=i});
  if(best<0){box._geo=null;box._items=null;setHTML(box,'<p class="rank-empty">Sem visitas registradas no período.</p>');if(hint)hint.textContent="Nenhuma visita registrada no período.";if(table)setHTML(table,"");return}
  const name=x=>WEEKDAY_NAMES[x.weekday][1];
  box.setAttribute("aria-label",`Gráfico de colunas da média de visitantes por dia da semana. Mais movimento: ${name(w[best])}, média de ${fmtInt(Math.round(w[best].avg))}.`);
  if(hint)hint.textContent=(days.length<7?"Escolha 30 dias ou mais para comparar melhor os dias da semana. ":"")+`Média de visitantes em cada dia da semana. Mais movimento: ${name(w[best])} (média de ${fmtInt(Math.round(w[best].avg))} por dia), um bom dia para postar novidades e mandar SMS.`;
  drawColumns(box,w.map((x,i)=>({value:x.avg,label:WEEKDAY_NAMES[x.weekday][0],muted:i!==best,tip:x.n
    ?[name(x),`média de ${fmtInt(Math.round(x.avg))} ${plural(Math.round(x.avg),"visitante","visitantes")}`,`${x.n} ${plural(x.n,"dia","dias")} no período · ${fmtInt(x.visitors)} no total`,`conversão de ${pct(x.conversion)}`]
    :[name(x),"sem dias no período","",""]})),{allLabels:true});
  if(table)setHTML(table,`<table class="table"><thead><tr><th>DIA DA SEMANA</th><th>DIAS NO PERÍODO</th><th>MÉDIA DE VISITANTES</th><th>CONVERSÃO</th></tr></thead><tbody>${w.map(x=>`<tr><td>${esc(name(x))}</td><td>${fmtInt(x.n)}</td><td>${fmtInt(Math.round(x.avg))}</td><td>${pct(x.conversion)}</td></tr>`).join("")}</tbody></table>`);
}

/* ---------- Analytics: funil de compra ----------
   Barras do tamanho de cada etapa (a primeira é 100%), com o número e quanto passou da etapa anterior. */
function renderFunnel(d){
  const box=$("analyticsFunnel");if(!box)return;
  const steps=window.ChartData.funnel([{label:"Visitaram o site",value:d.visitors},{label:"Puseram no carrinho",value:d.addToCart},{label:"Começaram o checkout",value:d.checkoutStarted},{label:"Pagaram",value:d.paidOrders}]);
  if(!steps[0].value){setHTML(box,'<p class="rank-empty">Sem visitas registradas no período.</p>');return}
  setHTML(box,steps.map((s,i)=>`<div class="rank-row funnel-step"><div class="rank-body"><div class="rank-top"><span class="rank-name">${esc(s.label)}</span><strong class="rank-value">${fmtInt(s.value)}</strong></div><div class="rank-track"><i data-w="${s.value?Math.max(0.6,s.ofFirst).toFixed(2):0}"></i></div><small class="rank-sub">${i===0?"visitantes únicos no período":i===1?`${esc(pct(s.ofFirst))} das visitas`:`${esc(pct(s.ofPrev))} da etapa anterior · ${esc(pct(s.ofFirst))} das visitas`}</small></div></div>`).join(""));
  chartWidths(box);
}

/* ---------- Analytics: abandono de carrinho ----------
   Uma barra só: a parte preta são os carrinhos que não viraram compra. */
function renderCartMeter(d){
  const box=$("analyticsCarts");if(!box)return;
  const active=Number(d.activeCarts||0),converted=Number(d.convertedCarts||0),all=active+converted;
  if(!all){setHTML(box,'<p class="rank-empty">Nenhum carrinho no período.</p>');return}
  const rate=active/all*100;
  setHTML(box,`<div class="meter-figure"><strong>${esc(pct(rate))}</strong><span>dos carrinhos não viraram compra</span></div><div class="meter" role="img" aria-label="${esc(`${pct(rate)} dos carrinhos abandonados: ${active} de ${all}`)}"><i data-w="${rate.toFixed(2)}"></i></div><ul class="meter-legend"><li><i class="meter-key is-fill" aria-hidden="true"></i><span><strong>${fmtInt(active)}</strong> ${plural(active,"carrinho parado","carrinhos parados")}, com <strong>${esc(money(d.abandonedValue))}</strong> em peças</span></li><li><i class="meter-key" aria-hidden="true"></i><span><strong>${fmtInt(converted)}</strong> ${plural(converted,"virou compra","viraram compra")}</span></li></ul>`);
  chartWidths(box);
}

/* ---------- Números do Analytics com a tendência do período ----------
   Linha cinza do período inteiro; o ponto preto é o dia mais recente. */
function sparkHtml(values){
  if(!values||values.length<2)return "";
  const W=120,H=32,max=Math.max(...values),min=Math.min(0,...values),y=v=>H-2-((v-min)/((max-min)||1))*(H-4);
  const d=values.map((v,i)=>(i?"L":"M")+(i*W/(values.length-1)).toFixed(2)+" "+y(v).toFixed(2)).join(" ");
  return `<div class="spark" aria-hidden="true"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><path d="${d}" vector-effect="non-scaling-stroke"/></svg><i data-top="${(y(values[values.length-1])/H*100).toFixed(2)}"></i></div>`;
}
function renderAnalyticsKpis(d,series){
  const box=$("analyticsKpis");if(!box)return;
  const days=window.ChartData.days(series),col=k=>days.map(x=>x[k]);
  const perVisitor=d.visitors?(Number(d.pageViews||0)/d.visitors).toLocaleString("pt-BR",{maximumFractionDigits:1}):"0";
  const tile=(label,value,sub,values)=>`<div class="kpi kpi-spark"><span class="kpi-label">${esc(label)}</span><strong class="kpi-value">${esc(value)}</strong><small class="kpi-sub">${esc(sub)}</small>${sparkHtml(values)}</div>`;
  setHTML(box,
    tile("Visitantes únicos",fmtInt(d.visitors),`${fmtInt(d.pageViews)} páginas vistas · ${perVisitor} por visitante`,col("visitors"))+
    tile("Pedidos pagos",fmtInt(d.paidOrders),Number(d.orders)>=Number(d.paidOrders)&&Number(d.orders)>0?`de ${fmtInt(d.orders)} ${plural(Number(d.orders),"pedido criado","pedidos criados")} no site`:"no período",col("purchases"))+
    tile("Faturamento bruto",money(d.grossRevenue),`ticket médio ${money(d.ticketAverage)}`,col("revenue"))+
    tile("Conversão",pct(d.conversionRate),"das visitas viraram pedido pago",col("conversion")));
  box.querySelectorAll(".spark i[data-top]").forEach(el=>{el.style.top=el.dataset.top+"%"});
}

/* ---------- Visão geral: ritmo das vendas ----------
   Faturamento somado dia a dia no período (preto) e no mesmo período do mês anterior (cinza),
   no mesmo eixo: dá para ver se a loja está à frente ou atrás do mês passado. */
function renderPaceChart(cur,prev,r){
  const box=$("dashPaceChart");if(!box)return;
  box._args=[cur,prev,r];
  const n=Math.max(1,r.days),pn=Math.max(1,Math.ceil((r.prevEnd-r.prevStart)/DAY_MS));
  const a=window.ChartData.cumulative(cur,r.start,n),b=window.ChartData.cumulative(prev,r.prevStart,pn),N=Math.max(n,pn);
  const dayAt=(start,i)=>new Date(new Date(start).getFullYear(),new Date(start).getMonth(),new Date(start).getDate()+i);
  // Líquido acumulado: o mesmo cálculo do "líquido" dos cartões (periodNet, em admin.js): relatório da
  // InfinitePay nos dias que ele cobre, senão as taxas; menos o que foi pago com o saldo. O do último dia
  // é igual ao do cartão de Faturamento.
  if(!box._net||box._net.cur!==cur||box._net.prev!==prev||box._net.r!==r){
    const netOf=(start,count,limit)=>typeof periodNet==="function"?Array.from({length:count},(_,i)=>periodNet(start,Math.min(dayAt(start,i+1).getTime()-1,limit))):null;
    box._net={cur,prev,r,a:netOf(r.start,n,r.end),b:netOf(r.prevStart,pn,r.prevEnd-1)};
  }
  const an=box._net.a,bn=box._net.b;
  box._pace={a,b,n,pn,N,r,dayAt,an,bn};
  const nowV=a[n-1],k=Math.min(n,pn)-1,thenV=b[k];
  const netText=x=>x?`líquido ${x.approx?"≈ ":""}${money(x.net)}`:"";
  const legend=$("dashPaceLegend");
  if(legend)setHTML(legend,`<span class="lg"><i class="lg-line"></i>${esc(r.days===1?"Hoje":"Este período")}</span><span class="lg"><i class="lg-line is-prev"></i>${esc(r.prevLabel)}</span>`);
  const hint=$("dashPaceHint");
  if(hint){const diff=thenV?(nowV-thenV)/thenV*100:0,dir=!thenV?(nowV?"up":"flat"):window.DashCompare.trend(nowV,thenV);
    const pctText=Math.abs(diff).toLocaleString("pt-BR",{maximumFractionDigits:Math.abs(diff)<10?1:0})+"%";
    const nowNet=an&&an[n-1]?` (${netText(an[n-1])})`:"",thenNet=bn&&bn[k]?`; ${netText(bn[k])}`:"";
    const vs=!thenV?"; no mesmo ponto do mês anterior não houve vendas":dir==="flat"?`, igual ao mesmo ponto do mês anterior (${money(thenV)}${thenNet})`:`, ${pctText} ${dir==="up"?"à frente do":"atrás do"} mesmo ponto do mês anterior (${money(thenV)}${thenNet})`;
    hint.textContent=!nowV&&!thenV?"Faturamento somado dia a dia. Nenhuma venda nos dois períodos.":`Faturamento somado dia a dia: ${money(nowV)} até ${shortDate(r.end)}${nowNet}${vs}. ${chartHow()} para ver cada dia.`}
  box.setAttribute("aria-label",`Gráfico de linhas do faturamento acumulado: ${money(nowV)} neste período e ${money(thenV)} no mesmo ponto do mês anterior.`);
  const W=Math.round(box.clientWidth);
  if(!W){box._pending=true;box._geo=null;return}
  box._pending=false;box._width=W;
  const wide=W>=520,H=wide?250:220,padL=wide?52:40,padR=wide?92:14,padT=24,padB=28,plotW=W-padL-padR,plotH=H-padT-padB,base=padT+plotH;
  const max=Math.max(0,...a,...b),step=niceStep(max||1000,4),top=Math.max(step,Math.ceil((max||1)/step)*step);
  const x=i=>padL+(N===1?plotW/2:i*plotW/(N-1)),y=v=>base-(v/top)*plotH;
  let grid="";for(let v=0;v<=top+0.001;v+=step){const gy=y(v).toFixed(1);grid+=`<line x1="${padL}" x2="${W-padR}" y1="${gy}" y2="${gy}" class="dc-grid${v===0?" dc-base":""}"/><text x="${padL-8}" y="${(+gy+4).toFixed(1)}" text-anchor="end" class="dc-tick">${axisMoney(v)}</text>`}
  const path=list=>list.map((v,i)=>(i?"L":"M")+x(i).toFixed(1)+" "+y(v).toFixed(1)).join(" ");
  const area=`${path(a)} L${x(n-1).toFixed(1)} ${base} L${x(0).toFixed(1)} ${base} Z`;
  const every=Math.max(1,Math.ceil(N/(W<520?4:7)));
  let labels="";for(let i=0;i<N;i++)if((N-1-i)%every===0)labels+=`<text x="${x(i).toFixed(1)}" y="${H-8}" text-anchor="middle" class="dc-tick">${esc(shortDate(dayAt(i<n?r.start:r.prevStart,i)))}</text>`;
  // Rótulo no fim de cada linha, à direita do ponto. Colados (ou tela estreita): só o do período atual,
  // e o outro valor fica na legenda do texto acima, na dica e na tabela.
  const ya=y(nowV),yb=y(b[pn-1]),close=Math.abs(ya-yb)<15&&Math.abs(x(n-1)-x(pn-1))<60;
  const ends=wide
    ?`<text x="${(x(n-1)+10).toFixed(1)}" y="${(ya+4).toFixed(1)}" class="pc-label is-cur">${esc(money(nowV))}</text>`+(close?"":`<text x="${(x(pn-1)+10).toFixed(1)}" y="${(yb+4).toFixed(1)}" class="pc-label is-prev">${esc(money(b[pn-1]))}</text>`)
    :`<text x="${(x(n-1)-6).toFixed(1)}" y="${(ya-10).toFixed(1)}" text-anchor="end" class="pc-label is-cur">${esc(money(nowV))}</text>`;
  setHTML(box,`<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" aria-hidden="true"><g>${grid}</g><line class="dc-cross" x1="0" x2="0" y1="${padT}" y2="${base}" visibility="hidden"/><path class="pc-area" d="${area}"/><path class="pc-line is-prev" d="${path(b)}"/><path class="pc-line is-cur" d="${path(a)}"/><circle class="pc-dot is-prev" cx="${x(pn-1).toFixed(1)}" cy="${yb.toFixed(1)}" r="4"/><circle class="pc-dot is-cur" cx="${x(n-1).toFixed(1)}" cy="${ya.toFixed(1)}" r="4"/><circle class="pc-hover is-prev" r="4" visibility="hidden"/><circle class="pc-hover is-cur" r="4" visibility="hidden"/>${ends}<g>${labels}</g></svg><div class="dc-tip pace-tip" hidden><span class="dc-tip-date"></span><span class="pace-row is-cur"><i></i><strong></strong><small></small><small class="pace-net"></small></span><span class="pace-row is-prev"><i></i><strong></strong><small></small><small class="pace-net"></small></span></div>`);
  box._geo={padL,padT,base,W,x,y,plotW};
  // Tabela: o acumulado de cada dia nos dois períodos.
  const table=$("dashPaceTable");
  if(table){const net=(list,i)=>list&&list[i]?esc((list[i].approx?"≈ ":"")+money(list[i].net)):"—";let rows="";
    for(let i=N-1;i>=0;i--)rows+=`<tr><td data-label="Este período">${i<n?esc(shortDate(dayAt(r.start,i))):"—"}</td><td data-label="Bruto">${i<n?money(a[i]):"—"}</td><td data-label="Líquido">${i<n?net(an,i):"—"}</td><td data-label="Mês anterior">${i<pn?esc(shortDate(dayAt(r.prevStart,i))):"—"}</td><td data-label="Bruto">${i<pn?money(b[i]):"—"}</td><td data-label="Líquido">${i<pn?net(bn,i):"—"}</td></tr>`;
    setHTML(table,`<table class="table pace-table"><thead><tr><th colspan="3">ESTE PERÍODO (ACUMULADO)</th><th colspan="3" class="pace-prev-head">MÊS ANTERIOR (ACUMULADO)</th></tr><tr><th>DATA</th><th>BRUTO</th><th>LÍQUIDO</th><th class="pace-prev-head">DATA</th><th>BRUTO</th><th>LÍQUIDO</th></tr></thead><tbody>${rows}</tbody></table>`)}
  if(box._active!=null)showPaceTip(box,Math.min(box._active,N-1));
}
function showPaceTip(box,i){
  const p=box._pace,g=box._geo;if(!p||!g||i<0||i>=p.N)return;
  box._active=i;const tip=box.querySelector(".dc-tip"),cross=box.querySelector(".dc-cross");if(!tip)return;
  const cx=g.x(i);
  if(cross){cross.setAttribute("x1",cx);cross.setAttribute("x2",cx);cross.setAttribute("visibility","visible")}
  [["is-cur",p.a,p.n,p.r.start,p.an],["is-prev",p.b,p.pn,p.r.prevStart,p.bn]].forEach(([cls,list,len,start,nets])=>{
    const dot=box.querySelector(".pc-hover."+cls),row=tip.querySelector(".pace-row."+cls),has=i<len;
    if(dot){dot.setAttribute("cx",cx);dot.setAttribute("cy",has?g.y(list[i]):0);dot.setAttribute("visibility",has?"visible":"hidden")}
    row.hidden=!has;
    if(has){row.querySelector("strong").textContent=money(list[i]);row.querySelector("small").textContent=cls==="is-cur"?"acumulado neste período":"mês anterior, até "+shortDate(p.dayAt(start,i));
      const netEl=row.querySelector(".pace-net"),x=nets&&nets[i];netEl.hidden=!x;if(x)netEl.textContent=`líquido ${x.approx?"≈ ":""}${money(x.net)}`}
  });
  tip.querySelector(".dc-tip-date").textContent=i<p.n?p.dayAt(p.r.start,i).toLocaleDateString("pt-BR",{weekday:"short",day:"2-digit",month:"2-digit"}):`${shortDate(p.dayAt(p.r.prevStart,i))} do mês anterior`;
  tip.hidden=false;
  const w=tip.offsetWidth,left=cx+14+w<=g.W?cx+14:Math.max(0,cx-14-w);
  tip.style.left=left+"px";tip.style.top=Math.max(0,g.padT-6)+"px";
}

(function(){
  const visits=$("analyticsChart"),week=$("analyticsWeekChart"),pace=$("dashPaceChart");
  bindChart(visits,{show:i=>showColumnTip(visits,i),count:()=>(visits._items||[]).length,rerender:()=>{if(visits._series)renderVisitsChart(visits._series)}});
  bindChart(week,{show:i=>showColumnTip(week,i),count:()=>(week._items||[]).length,start:()=>Math.max(0,(week._items||[]).findIndex(it=>!it.muted)),rerender:()=>{if(week._series)renderWeekdayChart(week._series)}});
  bindChart(pace,{show:i=>showPaceTip(pace,i),count:()=>pace._pace?pace._pace.N:0,start:()=>pace._pace?pace._pace.n-1:0,rerender:()=>{if(pace._args)renderPaceChart(...pace._args)},
    indexAt:e=>{const g=pace._geo,p=pace._pace;if(!g||!p)return -1;const xx=e.clientX-pace.getBoundingClientRect().left;return p.N===1?0:Math.max(0,Math.min(p.N-1,Math.round((xx-g.padL)/(g.plotW/(p.N-1)))))}});
})();
